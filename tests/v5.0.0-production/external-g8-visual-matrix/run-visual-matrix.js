'use strict';
// run-visual-matrix.js — 18-unit visual matrix for the G7-rework candidate.
// Real Electron + CDP, temporary userData, default-deny network (acceptance
// mode). Covers §13 of the goal contract:
//   3 resolutions (1024x700, 1366x768, 1920x1080)
//   x 3 skins (clinical, theatre, observatory)
//   x 2 modes (light, dark)
//   = 18 units on index.html (workbench), plus light/dark evidence for the
//     G7-modified settings.html at 1024x700/clinical.
// Per unit: screenshot, horizontal-overflow probe, empty/console-error probe.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const childProcess = require('child_process');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ARTIFACTS = path.join(__dirname, 'artifacts');
const ACCEPTANCE_MODE = '1';

const RESOLUTIONS = [
  { name: '1024x700', width: 1024, height: 700 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 }
];
const SKINS = ['clinical', 'theatre', 'observatory'];
const MODES = ['light', 'dark'];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase(); }
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('HTTP timeout')));
  });
}
function createCdp(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    let nextId = 1;
    socket.on('open', () => resolve({
      send(method, params) {
        const id = nextId++;
        return new Promise((resolveCommand, rejectCommand) => {
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
          socket.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      onEvent(event, cb) { socket._eventsHandlers = socket._eventsHandlers || {}; socket._eventsHandlers[event] = cb; },
      close() { try { socket.close(); } catch (_) {} }
    }));
    socket.on('error', reject);
    socket.on('message', (data) => {
      let message;
      try { message = JSON.parse(String(data)); } catch (_) { return; }
      if (message.method && socket._eventsHandlers && socket._eventsHandlers[message.method]) {
        try { socket._eventsHandlers[message.method](message.params || {}); } catch (_) {}
        return;
      }
      if (!message.id || !pending.has(message.id)) return;
      const deferred = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) deferred.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else deferred.resolve(message.result);
    });
  });
}
async function waitForPage(port, urlFragment) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const pages = await getJson('http://127.0.0.1:' + port + '/json/list');
      const page = pages.find((item) => item.type === 'page' && item.url.includes(urlFragment));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (error) { lastError = error; }
    await sleep(250);
  }
  throw new Error('Timed out waiting for page ' + urlFragment + ': ' + (lastError && lastError.message || 'unknown'));
}
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('Renderer evaluation failed: ' + (result.exceptionDetails.text || 'unknown'));
  return result.result && result.result.value;
}
async function waitFor(cdp, expression, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await evaluate(cdp, expression)) return;
    await sleep(100);
  }
  throw new Error('Timed out waiting for ' + label);
}
function capture(cdp, name) {
  return cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }).then((result) => {
    const buffer = Buffer.from(result.data || '', 'base64');
    if (buffer.length < 1024) throw new Error('Screenshot unexpectedly small: ' + name);
    const target = path.join(ARTIFACTS, name + '.png');
    fs.writeFileSync(target, buffer);
    return { file: path.basename(target), bytes: buffer.length, sha256: sha256(buffer) };
  });
}

async function collectUnit(cdp, unit, consoleErrors) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: unit.width, height: unit.height, deviceScaleFactor: 1, mobile: false });
  await sleep(150);
  // Apply skin + mode directly (Theme persistence path is covered by settings tests;
  // the visual matrix verifies the actual rendered tokens).
  await evaluate(cdp, '(function(){var d=document.documentElement; d.setAttribute("data-skin",' + JSON.stringify(unit.skin) + '); d.classList.toggle("dark",' + JSON.stringify(unit.mode === 'dark') + '); return d.getAttribute("data-skin") + (d.classList.contains("dark") ? "/dark" : "/light");})()');
  await sleep(250); // let CSS variables resolve & layout settle
  const probe = await evaluate(cdp, '(function(){var de=document.documentElement; var body=document.body||{scrollWidth:0}; var overflow=false; var widest=null; try{ var nodes=document.querySelectorAll("body, main, header, aside, .app-main, [class*=container], [class*=page]"); for (var i=0;i<nodes.length;i++){ var el=nodes[i]; if (el.scrollWidth>de.clientWidth+1){ overflow=true; widest={tag:el.tagName.toLowerCase(),cls:String(el.className||"").slice(0,40),scrollWidth:el.scrollWidth,clientWidth:de.clientWidth}; break; } } }catch(e){} var text=(document.body&&(document.body.innerText||""))||""; return {skin:de.getAttribute("data-skin"),dark:de.classList.contains("dark"),scrollWidth:Math.max(de.scrollWidth,body.scrollWidth||0),clientWidth:de.clientWidth,overflow:overflow,widest:widest,longChinese:/[\u4e00-\u9fa5]/.test(text),bodyChars:text.length};})()');
  const screenshot = await capture(cdp, unit.name + '-' + unit.skin + '-' + unit.mode);
  return Object.assign({ unit: unit.name, skin: unit.skin, mode: unit.mode }, probe, { screenshot, consoleErrors: consoleErrors.slice() });
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const port = await findFreePort();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xinjing-visual-matrix-'));
  const runtimeLogs = [];
  const consoleErrors = [];
  let child = null;
  let cdp = null;
  const units = [];
  try {
    child = childProcess.spawn(ELECTRON, [
      '--disable-gpu',
      '--user-data-dir=' + userData,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=' + port,
      ROOT
    ], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { XJ_AGENT_ACCEPTANCE: ACCEPTANCE_MODE, XJ_AGENT_ACCEPTANCE_USER_DATA: userData }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', (chunk) => runtimeLogs.push(String(chunk).trim()));
    child.stdout.on('data', (chunk) => runtimeLogs.push(String(chunk).trim()));

    const page = await waitForPage(port, '/index.html');
    cdp = await createCdp(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    cdp.onEvent('Runtime.exceptionThrown', (params) => {
      consoleErrors.push((params.exceptionDetails && params.exceptionDetails.text) || 'exception');
    });
    cdp.onEvent('Log.entryAdded', (params) => {
      if (params.entry && params.entry.level === 'error') consoleErrors.push(String(params.entry.text || '').slice(0, 200));
    });
    await waitFor(cdp, 'document.readyState === "complete" && typeof window.Store !== "undefined" && typeof window.__XJ_API__ !== "undefined"', 'Store and bridge initialization');

    // index.html workbench across all 18 units
    for (const res of RESOLUTIONS) {
      for (const skin of SKINS) {
        for (const mode of MODES) {
          units.push(await collectUnit(cdp, { name: res.name, width: res.width, height: res.height, skin, mode }, consoleErrors));
        }
      }
    }

    // settings.html evidence for the G7-modified page (light/dark at 1024x700)
    const settingsPage = await evaluate(cdp, '(function(){var href=location.origin+"/settings.html"; return href;})()');
    await cdp.send('Page.navigate', { url: settingsPage });
    await waitFor(cdp, 'document.readyState === "complete" && document.getElementById("update-info") !== null', 'settings.html load');
    for (const mode of MODES) {
      units.push(await collectUnit(cdp, { name: 'settings-1024x700', width: 1024, height: 700, skin: 'clinical', mode }, consoleErrors));
    }

    // navigate back to index to leave a clean state
    await cdp.send('Page.navigate', { url: page.url });
  } finally {
    if (cdp && child) {
      try { await evaluate(cdp, 'window.close(); true'); } catch (_) {}
      for (let attempt = 0; attempt < 30 && child.exitCode === null; attempt += 1) await sleep(100);
      if (child.exitCode === null) child.kill();
      cdp.close();
    }
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = units.filter((u) => u.overflow);
  const summary = {
    task_id: 'XJ-5.0.0-external-g8-visual-matrix',
    electron: '43.2.0',
    acceptance_mode: ACCEPTANCE_MODE,
    units_total: units.length,
    units_overflow: failed.length,
    console_errors: consoleErrors,
    units
  };
  fs.writeFileSync(path.join(ARTIFACTS, 'visual-matrix-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('units=' + units.length + ' overflow=' + failed.length + ' consoleErrors=' + consoleErrors.length);
  if (failed.length) {
    failed.forEach((u) => console.log('[OVERFLOW]', u.unit, u.skin, u.mode, JSON.stringify(u.widest)));
    process.exit(1);
  }
  console.log('VISUAL_MATRIX_STATUS=PASS');
  process.exit(0);
}

main().catch((error) => { console.error(error && error.stack || error); process.exit(1); });
