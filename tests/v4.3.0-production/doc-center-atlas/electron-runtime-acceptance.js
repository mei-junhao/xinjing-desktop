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
const ARTIFACTS = path.join(ROOT, 'qa', 'visual', 'v4.3.0-doc-center-atlas');
const VIEWPORTS = [
  { name: '1024x700', width: 1024, height: 700 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 }
];
const SKINS = ['clinical', 'theatre', 'observatory'];
const checks = [];

function check(id, label, condition, detail) {
  const pass = !!condition;
  checks.push({ id, label, pass, detail: detail || '' });
  console.log('[' + (pass ? 'PASS' : 'FAIL') + '] ' + id + ': ' + label + (detail ? ' - ' + detail : ''));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.setTimeout(timeoutMs || 2000, () => request.destroy(new Error('HTTP timeout')));
  });
}

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

function createCdp(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    let nextId = 1;
    socket.addEventListener('open', () => resolve({
      send(method, params) {
        const id = nextId++;
        return new Promise((resolveCommand, rejectCommand) => {
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
          socket.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      close() { try { socket.close(); } catch (_) {} }
    }));
    socket.addEventListener('error', (event) => reject(event.error || event.message || event));
    socket.addEventListener('close', () => {
      const error = new Error('CDP connection closed before acceptance completed');
      pending.forEach((entry) => entry.reject(error));
      pending.clear();
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch (_) { return; }
      if (!message.id || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
  });
}

async function waitForPage(port) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const pages = await getJson('http://127.0.0.1:' + port + '/json/list');
      const page = pages.find((item) => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (error) { lastError = error; }
    await sleep(250);
  }
  throw new Error('Timed out waiting for the controlled Electron main window: ' + (lastError && lastError.message || 'unknown error'));
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('Renderer evaluation failed: ' + (result.exceptionDetails.text || 'unknown error'));
  return result.result && result.result.value;
}

async function waitFor(cdp, expression, label) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await evaluate(cdp, expression)) return;
    await sleep(150);
  }
  throw new Error('Timed out waiting for ' + label);
}

async function navigate(cdp, origin, page) {
  await cdp.send('Page.navigate', { url: origin + '/' + page });
  await waitFor(cdp, 'document.readyState === "complete"', page + ' ready state');
  await sleep(650);
}

async function setViewport(cdp, viewport) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false
  });
  await sleep(180);
}

async function capture(cdp, name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const buffer = Buffer.from(result.data || '', 'base64');
  if (buffer.length < 1024) throw new Error('Screenshot is unexpectedly small: ' + name);
  const target = path.join(ARTIFACTS, name + '.png');
  fs.writeFileSync(target, buffer);
  return { name: path.basename(target), sha256: crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase(), bytes: buffer.length };
}

async function stopElectron(cdp, child) {
  try { await evaluate(cdp, 'window.close(); true'); } catch (_) {}
  for (let attempt = 0; attempt < 20 && child && child.exitCode === null; attempt += 1) await sleep(100);
  if (child && child.exitCode === null) child.kill();
}

async function main() {
  if (!fs.existsSync(ELECTRON)) throw new Error('Electron executable is absent');
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xinjing-atlas-acceptance-'));
  const port = await findFreePort();
  const logs = [];
  const screenshots = [];
  let child;
  let cdp;

  try {
    child = childProcess.spawn(ELECTRON, [
      '--disable-gpu', '--user-data-dir=' + userData,
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, ROOT
    ], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: userData }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', (chunk) => logs.push(String(chunk).trim()));

    const page = await waitForPage(port);
    const origin = new URL(page.url).origin;
    cdp = await createCdp(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

    check('E1', 'project main process serves the controlled window', /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/.test(page.url), page.url);
    check('E2', 'reduced motion media query is active', await evaluate(cdp, 'matchMedia("(prefers-reduced-motion: reduce)").matches === true'));
    await waitFor(cdp, 'typeof Store !== "undefined" && Store.isHydrated && Store.isHydrated()', 'Store hydration');

    const seed = await evaluate(cdp, '(async function(){var client=Store.createClient({name:"合成图谱个案",status:"active"});var session=Store.createSession({clientId:client.id,date:"2026-07-27",summary:"合成会谈"});var material=Store.createMaterialWorkspace({title:"合成材料：图谱验收",source:{name:"synthetic-atlas.txt",ext:"txt"},extractedText:"SYNTHETIC_SOURCE_BODY_MUST_NOT_RENDER",parseStatus:"ready",clientId:client.id,sessionId:session.id});await new Promise(function(resolve){setTimeout(resolve,400);});return {clientId:client.id,sessionId:session.id,materialId:material&&material.id||""};})()');
    check('E3', 'synthetic linked material is created in the controlled temporary profile', !!(seed && seed.clientId && seed.sessionId && seed.materialId));

    await navigate(cdp, origin, 'doc-center.html?clientId=' + encodeURIComponent(seed.clientId) + '&view=atlas');
    await waitFor(cdp, 'document.querySelector(".atlas-board") && document.querySelectorAll(".atlas-node").length === 1', 'Atlas verified material');
    const atlasInitial = await evaluate(cdp, '(function(){var body=document.body.innerText;var node=document.querySelector(".atlas-node");return {body:body,nodeText:node&&node.innerText||"",sourceTextVisible:body.includes("SYNTHETIC_SOURCE_BODY_MUST_NOT_RENDER"),selected:node&&node.classList.contains("selected"),sourceButton:document.querySelector(".atlas-primary")&&document.querySelector(".atlas-primary").innerText};})()');
    check('E4', 'Atlas renders the admitted source as a selected read-only material', atlasInitial.nodeText.includes('合成材料：图谱验收') && atlasInitial.selected);
    check('E5', 'Atlas does not render synthetic source body text', !atlasInitial.sourceTextVisible);
    check('E6', 'Atlas exposes the single source-opening primary action', atlasInitial.sourceButton === '打开当前来源');

    await evaluate(cdp, 'window.openAtlasSource(); true');
    await waitFor(cdp, 'location.pathname.endsWith("/transcript.html")', 'Atlas source route');
    const sourceRoute = await evaluate(cdp, 'location.href');
    check('E7', 'source command uses the existing validated transcript material route', sourceRoute.indexOf('/transcript.html?clientId=') !== -1 && sourceRoute.indexOf('materialId=') !== -1, sourceRoute);
    await navigate(cdp, origin, 'doc-center.html?clientId=' + encodeURIComponent(seed.clientId) + '&view=atlas');
    await waitFor(cdp, 'document.querySelector(".atlas-node")', 'Atlas after source-route return');

    await setViewport(cdp, VIEWPORTS[0]);
    const drawerResult = await evaluate(cdp, '(async function(){var node=document.querySelector(".atlas-node");node.focus();node.click();await new Promise(function(resolve){setTimeout(resolve,40);});var open=document.querySelector(".atlas-source").classList.contains("drawer-open");document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));await new Promise(function(resolve){setTimeout(resolve,40);});return {open:open,closed:!document.querySelector(".atlas-source").classList.contains("drawer-open"),focus:document.activeElement&&document.activeElement.id||""};})()');
    check('E8', 'narrow Atlas opens its source drawer and Escape returns focus to the source node', drawerResult.open && drawerResult.closed && drawerResult.focus.indexOf('atlas-node-') === 0, JSON.stringify(drawerResult));

    for (const skin of SKINS) {
      for (const viewport of VIEWPORTS) {
        await setViewport(cdp, viewport);
        const metrics = await evaluate(cdp, '(function(){document.documentElement.setAttribute("data-skin",' + JSON.stringify(skin) + ');document.documentElement.classList.toggle("dark",' + JSON.stringify(skin === 'observatory') + ');var board=document.querySelector(".atlas-board");var content=document.getElementById("doc-content");return {skin:document.documentElement.getAttribute("data-skin"),board:!!board,overflow:document.documentElement.scrollWidth<=window.innerWidth+1&&content.scrollWidth<=content.clientWidth+1,nodeWidth:board&&board.querySelector(".atlas-node")&&board.querySelector(".atlas-node").getBoundingClientRect().width||0,reduced:matchMedia("(prefers-reduced-motion: reduce)").matches};})()');
        check('V-' + skin + '-' + viewport.name, 'Atlas renders without horizontal overflow in ' + skin + ' at ' + viewport.name, metrics.board && metrics.overflow && metrics.nodeWidth > 0 && metrics.reduced, JSON.stringify(metrics));
        screenshots.push(await capture(cdp, 'atlas-' + skin + '-' + viewport.name));
      }
    }
  } finally {
    if (cdp) {
      try { await stopElectron(cdp, child); } catch (_) {}
      cdp.close();
    } else if (child && child.exitCode === null) {
      child.kill();
    }
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = checks.filter((item) => !item.pass);
  fs.writeFileSync(path.join(ARTIFACTS, 'runtime-summary.json'), JSON.stringify({
    task_id: 'XJ-5.0.0-codex-v4.3-doc-center-atlas-production-03', checks, failed: failed.length, screenshots, runtime_logs: logs.filter(Boolean)
  }, null, 2), 'utf8');
  console.log('Passed: ' + (checks.length - failed.length) + ' | Failed: ' + failed.length);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('[FATAL] ' + (error && error.stack || error));
  process.exit(1);
});
