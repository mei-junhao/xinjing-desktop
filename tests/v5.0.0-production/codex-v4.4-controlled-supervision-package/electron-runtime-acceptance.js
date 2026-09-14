'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ARTIFACTS = path.join(__dirname, 'electron-runtime-artifacts');
const VIEWPORTS = [
  { name: '1024x700', width: 1024, height: 700 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 },
];
const checks = [];

function check(id, title, pass, detail) {
  checks.push({ id, title, pass: !!pass, detail: detail || '' });
  console.log('[' + (pass ? 'PASS' : 'FAIL') + '] ' + id + ' — ' + title + (detail ? ' · ' + detail : ''));
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('timeout')));
  });
}
function cdpConnect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 1;
    socket.addEventListener('open', () => resolve({
      send(method, params) {
        const id = nextId++;
        return new Promise((resolveCommand, rejectCommand) => {
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
          socket.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      on(method, listener) { const list = listeners.get(method) || []; list.push(listener); listeners.set(method, list); },
      close() { try { socket.close(); } catch (error) {} },
    }));
    socket.addEventListener('error', (event) => reject(event.error || event.message || event));
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch (error) { return; }
      if (message.id && pending.has(message.id)) {
        const item = pending.get(message.id); pending.delete(message.id);
        if (message.error) item.reject(new Error(message.error.message || JSON.stringify(message.error))); else item.resolve(message.result);
      } else (listeners.get(message.method) || []).forEach((listener) => listener(message.params || {}));
    });
  });
}
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails;
    const description = detail.exception && detail.exception.description;
    throw new Error([detail.text, description, detail.lineNumber !== undefined ? 'line ' + detail.lineNumber : ''].filter(Boolean).join(' | ') || 'renderer evaluation failed');
  }
  return result.result && result.result.value;
}
async function waitForPage(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const pages = await getJson('http://127.0.0.1:' + port + '/json/list');
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {}
    await sleep(250);
  }
  throw new Error('timed out waiting for Electron page');
}
async function waitReady(cdp) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await evaluate(cdp, 'document.readyState === "complete"')) return;
    await sleep(100);
  }
  throw new Error('page did not become ready');
}
async function capture(cdp, name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const bytes = Buffer.from(result.data || '', 'base64');
  const file = path.join(ARTIFACTS, name + '.png');
  fs.writeFileSync(file, bytes);
  return { file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase() };
}
async function main() {
  if (!fs.existsSync(ELECTRON)) throw new Error('Electron executable is absent');
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-supervision-package-acceptance-'));
  const debugPort = await freePort();
  let child;
  let cdp;
  const logs = [];
  const screenshots = [];
  try {
    child = childProcess.spawn(ELECTRON, [
      '--disable-gpu',
      '--user-data-dir=' + userData,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=' + debugPort,
      ROOT,
    ], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: userData }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk) => logs.push(String(chunk).trim()));
    const page = await waitForPage(debugPort);
    cdp = await cdpConnect(page.webSocketDebuggerUrl);
    cdp.on('Runtime.exceptionThrown', (event) => logs.push('renderer exception: ' + JSON.stringify(event.exceptionDetails || {})));
    cdp.on('Log.entryAdded', (event) => { if (event.entry && event.entry.level === 'error') logs.push('renderer log: ' + event.entry.text); });
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await cdp.send('Page.navigate', { url: new URL(page.url).origin + '/supervision.html' });
    await waitReady(cdp);
    check('E1', 'supervision route loads through the real Electron loopback server', /\/supervision\.html$/.test((await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result.value));
    check('E2', 'controlled package bridge is present without exposing package bytes', await evaluate(cdp, '!!window.SupervisionPackage && !Object.keys(window.SupervisionPackage).some(function(k){return /decrypt|contentKey|plaintext/i.test(k);})'));
    check('E3', 'empty package index reports a visible locked state', await evaluate(cdp, 'document.getElementById("sup-package-status").dataset.state === "locked" && document.getElementById("sup-package-status").innerText.includes("未安装")'));
    check('E4', 'renderer receives an empty sanitized installed-package list', await evaluate(cdp, '(async function(){var r=await window.SupervisionPackage.listInstalled(); return !!r && r.ok === true && Array.isArray(r.packages) && r.packages.length === 0;})()'));
    for (const viewport of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
      const metrics = await evaluate(cdp, '(function(){var rect=function(e){var r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,strip:rect(document.querySelector(".sup-package-strip")),body:rect(document.body),buttons:["sup-package-import","sup-package-install","sup-package-run","sup-package-remove"].map(function(id){var e=document.getElementById(id);return {id:id,disabled:e.disabled,rect:rect(e)};}),reduced:matchMedia("(prefers-reduced-motion: reduce)").matches};})()');
      const within = metrics.strip.left >= 0 && metrics.strip.right <= metrics.width && metrics.strip.bottom <= metrics.body.bottom + 1 && metrics.scrollWidth <= metrics.width + 1;
      check('V-' + viewport.name, 'package strip and controls stay within viewport', within, JSON.stringify({ scrollWidth: metrics.scrollWidth, width: metrics.width }));
      check('V-' + viewport.name + '-locked', 'install/run/remove remain disabled until valid package and entitlement', metrics.buttons.filter((button) => button.id !== 'sup-package-import').every((button) => button.disabled));
      check('V-' + viewport.name + '-motion', 'reduced motion preference is visible to the page', metrics.reduced === true);
      screenshots.push(await capture(cdp, 'supervision-package-' + viewport.name));
    }
    check('E5', 'no renderer errors were emitted during route and viewport checks', logs.filter((line) => /renderer (exception|log:)/i.test(line)).length === 0, logs.slice(-6).join(' | '));
  } finally {
    if (cdp) { try { await evaluate(cdp, 'window.close(); true'); } catch (error) {} cdp.close(); }
    if (child && child.exitCode === null) child.kill();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (error) {}
  }
  const failed = checks.filter((item) => !item.pass);
  fs.writeFileSync(path.join(ARTIFACTS, 'runtime-result.json'), JSON.stringify({ task_id: 'XJ-5.0.0-codex-v4.4-controlled-supervision-package-runtime-32', checks, screenshots, logs: logs.slice(-20) }, null, 2) + '\n', 'utf8');
  console.log('----------------------------------------');
  console.log('Electron checks: ' + (checks.length - failed.length) + ' PASS | ' + failed.length + ' FAIL');
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => { console.error('[ERROR] ' + error.message); process.exitCode = 1; });
