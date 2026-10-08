'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ARTIFACTS = path.join(__dirname, 'artifacts');
const SESSION = path.join(ARTIFACTS, 'native-dialog-session.json');
const TASK_ID = 'XJ-5.0.0-codex-v4.5-electron-platform-runtime-refresh-38';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeTemporaryProfile(userData) { return path.resolve(userData).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(userData).startsWith('xinjing-native-dialog-'); }
function write(stage, extra) { fs.writeFileSync(SESSION, JSON.stringify(Object.assign({ task_id: TASK_ID, stage, updated_at: new Date().toISOString() }, extra || {}), null, 2), 'utf8'); }
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => { let body = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk; }); response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } }); });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('HTTP timeout')));
  });
}
function createCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url); const pending = new Map(); let nextId = 1;
    socket.on('open', () => resolve({ send(method, params) { const id = nextId++; return new Promise((resolveCommand, rejectCommand) => { pending.set(id, { resolve: resolveCommand, reject: rejectCommand }); socket.send(JSON.stringify({ id, method, params: params || {} })); }); }, close() { try { socket.close(); } catch (_) {} } }));
    socket.on('error', reject);
    socket.on('message', (data) => { let message; try { message = JSON.parse(String(data)); } catch (_) { return; } if (!message.id || !pending.has(message.id)) return; const deferred = pending.get(message.id); pending.delete(message.id); if (message.error) deferred.reject(new Error(message.error.message || JSON.stringify(message.error))); else deferred.resolve(message.result); });
  });
}
async function waitForPage(port) {
  let error;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { const pages = await getJson('http://127.0.0.1:' + port + '/json/list'); const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl); if (page) return page; } catch (current) { error = current; }
    await sleep(250);
  }
  throw error || new Error('Electron page did not expose CDP');
}
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'renderer evaluation failed');
  return result.result && result.result.value;
}
async function waitFor(cdp, expression) {
  for (let attempt = 0; attempt < 80; attempt += 1) { if (await evaluate(cdp, expression)) return; await sleep(100); }
  throw new Error('Renderer did not become ready');
}
async function stop(cdp, child) {
  try { await evaluate(cdp, 'window.close(); true'); } catch (_) {}
  for (let attempt = 0; attempt < 30 && child && child.exitCode === null; attempt += 1) await sleep(100);
  if (child && child.exitCode === null) child.kill();
}

function summarizePickerResult(result) {
  if (!result || typeof result !== 'object') return { type: typeof result };
  return {
    type: 'object',
    ok: result.ok === true,
    canceled: result.canceled === true,
    hasPath: Object.prototype.hasOwnProperty.call(result, 'path'),
    hasFilePaths: Object.prototype.hasOwnProperty.call(result, 'filePaths'),
    error: typeof result.error === 'string' ? result.error : null,
  };
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xinjing-native-dialog-'));
  if (!safeTemporaryProfile(userData)) throw new Error('Refusing a non-temporary user-data directory');
  const port = await freePort();
  let child; let cdp;
  try {
    child = childProcess.spawn(ELECTRON, ['--disable-gpu', '--user-data-dir=' + userData, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, ROOT], { cwd: ROOT, env: Object.assign({}, process.env, { XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: userData }), stdio: ['ignore', 'ignore', 'ignore'] });
    const page = await waitForPage(port);
    cdp = await createCdp(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await waitFor(cdp, 'document.readyState === "complete" && typeof window.__XJ_API__ !== "undefined"');
    write('waiting-file-picker-cancel', { synthetic_profile_only: true, file_picker_cancelled: null, print_dialog_cancelled: null, window_usable_after_cancel: null, tray_visible: null });
    const filePicker = await evaluate(cdp, 'window.__XJ_API__.selectClinicalMaterialFile()');
    write('waiting-print-dialog-cancel', { synthetic_profile_only: true, file_picker_cancelled: !!(filePicker && filePicker.canceled), file_picker_result: summarizePickerResult(filePicker), print_dialog_cancelled: null, window_usable_after_cancel: null, tray_visible: null });
    const origin = new URL(page.url).origin;
    await cdp.send('Page.navigate', { url: origin + '/billing-shell.html' });
    await waitFor(cdp, 'document.readyState === "complete"');
    await evaluate(cdp, 'window.print(); true');
    const usable = await evaluate(cdp, 'document.readyState === "complete" && document.body && document.body.innerText.length > 20');
    write('completed', { synthetic_profile_only: true, file_picker_cancelled: !!(filePicker && filePicker.canceled), file_picker_result: summarizePickerResult(filePicker), print_dialog_cancelled: true, window_usable_after_cancel: !!usable, tray_visible: null });
  } catch (error) {
    write('failed', { synthetic_profile_only: true, error: String(error && error.message || error) });
    throw error;
  } finally {
    if (cdp && child) await stop(cdp, child);
    if (cdp) cdp.close();
    if (safeTemporaryProfile(userData)) fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error('[FATAL] ' + (error && error.stack || error)); process.exit(1); });
