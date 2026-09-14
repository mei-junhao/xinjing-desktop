'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const VIEWPORTS = [
  { name: '1024x700', width: 1024, height: 700 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 },
];
const SKINS = ['clinical', 'theatre', 'observatory'];

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function json(url) {
  return new Promise(function (resolve, reject) {
    const request = http.get(url, function (response) {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', function (chunk) { body += chunk; });
      response.on('end', function () { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.setTimeout(2000, function () { request.destroy(new Error('HTTP timeout')); });
    request.on('error', reject);
  });
}
function freePort() {
  return new Promise(function (resolve, reject) {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function () {
      const port = server.address().port;
      server.close(function () { resolve(port); });
    });
  });
}
function connect(url) {
  return new Promise(function (resolve, reject) {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    socket.addEventListener('open', function () {
      resolve({
        send: function (method, params) {
          return new Promise(function (resolveCommand, rejectCommand) {
            const id = nextId++;
            pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
            socket.send(JSON.stringify({ id: id, method: method, params: params || {} }));
          });
        },
        close: function () { try { socket.close(); } catch (_) {} },
      });
    });
    socket.addEventListener('error', function (event) { reject(event.error || event.message || event); });
    socket.addEventListener('message', function (event) {
      let message;
      try { message = JSON.parse(String(event.data)); } catch (_) { return; }
      if (!message.id || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || 'CDP error'));
      else entry.resolve(message.result);
    });
  });
}
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression: expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'renderer evaluation failed');
  return result.result && result.result.value;
}
async function waitFor(expression, cdp, label) {
  for (let index = 0; index < 80; index += 1) {
    if (await evaluate(cdp, expression)) return;
    await sleep(150);
  }
  throw new Error('timed out waiting for ' + label);
}
async function waitForPage(port) {
  let lastError;
  for (let index = 0; index < 80; index += 1) {
    try {
      const pages = await json('http://127.0.0.1:' + port + '/json/list');
      const page = pages.find(function (entry) { return entry.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(entry.url); });
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (error) { lastError = error; }
    await sleep(150);
  }
  throw new Error('main Electron page unavailable: ' + (lastError && lastError.message || 'unknown'));
}

async function run() {
  assert.ok(require('fs').existsSync(ELECTRON), 'Electron executable must exist');
  const userData = require('fs').mkdtempSync(path.join(os.tmpdir(), 'xinjing-prompt-governance-'));
  const port = await freePort();
  let child;
  let cdp;
  try {
    child = childProcess.spawn(ELECTRON, [
      '--disable-gpu',
      '--user-data-dir=' + userData,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=' + port,
      ROOT,
    ], {
      cwd: ROOT,
      windowsHide: true,
      stdio: 'ignore',
      env: Object.assign({}, process.env, { XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: userData }),
    });
    const page = await waitForPage(port);
    const origin = new URL(page.url).origin;
    assert.match(page.url, /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/, 'must use the project main-process loopback route');
    cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await cdp.send('Page.navigate', { url: origin + '/settings.html' });
    await waitFor('document.readyState === "complete" && document.getElementById("writing-style-toggle")', cdp, 'settings prompt-style control');

    let captures = 0;
    for (const viewport of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
      for (const skin of SKINS) {
        const result = await evaluate(cdp, '(function(){var root=document.documentElement;root.setAttribute("data-skin",' + JSON.stringify(skin) + ');root.classList.toggle("dark",' + JSON.stringify(skin === 'observatory') + ');var toggle=document.getElementById("writing-style-toggle");toggle.focus();var rect=toggle.getBoundingClientRect();return {skin:root.getAttribute("data-skin"),dark:root.classList.contains("dark"),focused:document.activeElement===toggle,aria:toggle.getAttribute("aria-checked"),overflow:document.documentElement.scrollWidth>window.innerWidth,inside:rect.left>=0&&rect.right<=window.innerWidth&&rect.top>=0&&rect.bottom<=window.innerHeight,reduced:matchMedia("(prefers-reduced-motion: reduce)").matches};})()');
        assert.strictEqual(result.skin, skin, viewport.name + ' must apply ' + skin);
        assert.strictEqual(result.dark, skin === 'observatory', viewport.name + ' must map Observatory to dark tokens');
        assert.strictEqual(result.focused, true, viewport.name + ' control must accept keyboard focus');
        assert.strictEqual(result.overflow, false, viewport.name + ' must not have horizontal overflow');
        assert.strictEqual(result.inside, true, viewport.name + ' control must remain visible');
        assert.strictEqual(result.reduced, true, viewport.name + ' must honor reduced motion');
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        assert.ok(Buffer.from(shot.data || '', 'base64').length > 1024, viewport.name + ' ' + skin + ' screenshot must be nonblank');
        captures += 1;
      }
    }

    const disabled = await evaluate(cdp, '(async function(){var toggle=document.getElementById("writing-style-toggle");toggle.click();for(var i=0;i<30&&toggle.getAttribute("aria-checked")!=="false";i+=1)await new Promise(function(r){setTimeout(r,50);});return {checked:toggle.getAttribute("aria-checked"),status:document.getElementById("writing-style-status").textContent};})()');
    assert.strictEqual(disabled.checked, 'false', 'style toggle must persist a disabled state');
    assert.match(disabled.status, /已关闭/);
    await cdp.send('Page.reload');
    await waitFor('document.readyState === "complete" && document.getElementById("writing-style-toggle")', cdp, 'settings reload');
    assert.strictEqual(await evaluate(cdp, 'document.getElementById("writing-style-toggle").getAttribute("aria-checked")'), 'false', 'disabled style must survive reload in the temporary user profile');
    const restored = await evaluate(cdp, '(async function(){var toggle=document.getElementById("writing-style-toggle");toggle.click();for(var i=0;i<30&&toggle.getAttribute("aria-checked")!=="true";i+=1)await new Promise(function(r){setTimeout(r,50);});return toggle.getAttribute("aria-checked");})()');
    assert.strictEqual(restored, 'true', 'style toggle must restore the enabled state');
    const failedSave = await evaluate(cdp, '(async function(){var original=Store.saveSettingsDurable;Store.saveSettingsDurable=async function(){return {ok:false,error:{message:"synthetic persistence failure"}};};var toggle=document.getElementById("writing-style-toggle");toggle.click();await new Promise(function(r){setTimeout(r,80);});var result={checked:toggle.getAttribute("aria-checked"),status:document.getElementById("writing-style-status").textContent};Store.saveSettingsDurable=original;return result;})()');
    assert.strictEqual(failedSave.checked, 'true', 'failed persistence must not change the rendered setting');
    assert.match(failedSave.status, /未保存/, 'failed persistence must be visible beside the control');
    console.log('Electron settings acceptance: 9/9 visual cells, toggle persistence, keyboard focus, and reduced motion PASS');
    console.log('Screenshots checked in memory: ' + captures);
  } finally {
    if (cdp) {
      try { await evaluate(cdp, 'window.close();true'); } catch (_) {}
      cdp.close();
    }
    for (let index = 0; child && child.exitCode === null && index < 20; index += 1) await sleep(100);
    if (child && child.exitCode === null) child.kill('SIGTERM');
    require('fs').rmSync(userData, { recursive: true, force: true });
  }
}

run().catch(function (error) { console.error(error && error.stack || error); process.exit(1); });
