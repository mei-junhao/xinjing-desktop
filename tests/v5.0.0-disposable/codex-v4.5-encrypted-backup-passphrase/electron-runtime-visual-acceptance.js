'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../../');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ARTIFACTS = path.join(__dirname, 'artifacts');
const VIEWPORTS = [
  { name: '1024x700', width: 1024, height: 700 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 },
];
const SKINS = ['clinical', 'theatre', 'observatory'];
const THEMES = ['light', 'dark'];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.setTimeout(2000, () => request.destroy(new Error('HTTP timeout')));
    request.on('error', reject);
  });
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
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
      close() { try { socket.close(); } catch (_) {} },
    }));
    socket.addEventListener('error', (event) => reject(event.error || event.message || event));
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch (_) { return; }
      if (!message.id || !pending.has(message.id)) return;
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message || 'CDP error'));
      else item.resolve(message.result);
    });
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'renderer evaluation failed');
  }
  return result.result && result.result.value;
}

async function waitFor(cdp, expression, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(cdp, expression)) return;
    await sleep(150);
  }
  throw new Error('timed out waiting for ' + label);
}

async function waitForPage(port) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pages = await getJson('http://127.0.0.1:' + port + '/json/list');
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error('Electron page unavailable: ' + (lastError && lastError.message || 'unknown'));
}

function rectsFor(selector) {
  return `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(function(node){var r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,visible:r.width>0&&r.height>0};})`;
}

async function capture(cdp, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const bytes = Buffer.from(shot.data || '', 'base64');
  assert.ok(bytes.length > 1024, name + ' screenshot must be nonblank');
  const file = path.join(ARTIFACTS, name + '.png');
  fs.writeFileSync(file, bytes);
  return { file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase() };
}

async function main() {
  assert.ok(fs.existsSync(ELECTRON), 'Electron executable must exist');
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-v45-backup-ui-'));
  const debugPort = await freePort();
  let child;
  let cdp;
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
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: Object.assign({}, process.env, {
        XJ_AGENT_ACCEPTANCE: '1',
        XJ_AGENT_ACCEPTANCE_USER_DATA: userData,
      }),
    });
    const page = await waitForPage(debugPort);
    cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await cdp.send('Page.navigate', { url: new URL(page.url).origin + '/settings.html' });
    await waitFor(cdp, 'document.readyState === "complete" && document.querySelector("button[onclick=\\"backupData()\\"]")', 'settings backup controls');

    const baseline = await evaluate(cdp, `({
      route: location.pathname,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      backupButton: !!document.querySelector('button[onclick="backupData()"]'),
      restoreButton: !!document.querySelector('button[onclick="document.getElementById(\\'restore-file\\').click()"]'),
      modalHidden: document.getElementById('backup-passphrase-modal').getAttribute('aria-hidden') === 'true'
    })`);
    assert.strictEqual(baseline.route, '/settings.html', 'settings route must load in Electron');
    assert.strictEqual(baseline.reducedMotion, true, 'reduced motion preference must reach the renderer');
    assert.strictEqual(baseline.backupButton, true, 'manual backup control must be present');
    assert.strictEqual(baseline.restoreButton, true, 'manual restore control must be present');
    assert.strictEqual(baseline.modalHidden, true, 'passphrase dialog starts closed');

    for (const viewport of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
      for (const skin of SKINS) {
        for (const theme of THEMES) {
          const state = await evaluate(cdp, `(function(){var root=document.documentElement;root.setAttribute('data-skin',${JSON.stringify(skin)});root.classList.toggle('dark',${JSON.stringify(theme === 'dark')});var group=Array.from(document.querySelectorAll('.group')).find(function(n){return n.textContent.indexOf('数据管理')!==-1;});var controls=group?${rectsFor('.btn')}:[];return {skin:root.getAttribute('data-skin'),theme:${JSON.stringify(theme)},width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,group:group?{left:group.getBoundingClientRect().left,right:group.getBoundingClientRect().right,top:group.getBoundingClientRect().top,bottom:group.getBoundingClientRect().bottom}:null,controls:controls,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches};})()`);
          assert.strictEqual(state.skin, skin, viewport.name + ' must apply ' + skin);
          assert.strictEqual(state.theme, theme, viewport.name + ' must apply ' + theme);
          assert.strictEqual(state.reduced, true, viewport.name + ' ' + skin + ' must honor reduced motion');
          assert.ok(state.scrollWidth <= viewport.width + 1, viewport.name + ' ' + skin + ' ' + theme + ' must not overflow horizontally');
          assert.ok(state.group && state.group.left >= 0 && state.group.right <= viewport.width + 1, viewport.name + ' data group must remain inside viewport');
          assert.ok(state.controls.every((rect) => rect.left >= 0 && rect.right <= viewport.width + 1), viewport.name + ' data controls must remain inside viewport');
          screenshots.push(await capture(cdp, 'settings-' + viewport.name + '-' + skin + '-' + theme));
        }
      }
    }

    await evaluate(cdp, 'document.documentElement.classList.remove("dark"); document.documentElement.setAttribute("data-skin", "clinical"); document.querySelector("button[onclick=\\"backupData()\\"]").click(); true');
    await waitFor(cdp, 'document.getElementById("backup-passphrase-modal").getAttribute("aria-hidden") === "false"', 'export passphrase dialog');
    await waitFor(cdp, 'document.activeElement && document.activeElement.id === "backup-passphrase"', 'export passphrase focus');
    const exportDialog = await evaluate(cdp, `({
      focused: document.activeElement && document.activeElement.id === 'backup-passphrase',
      title: document.getElementById('backup-passphrase-title').textContent,
      description: document.getElementById('backup-passphrase-description').textContent,
      confirmVisible: getComputedStyle(document.getElementById('backup-passphrase-confirm-row')).display !== 'none'
    })`);
    assert.strictEqual(exportDialog.focused, true, 'export dialog must focus the passphrase field');
    assert.strictEqual(exportDialog.confirmVisible, true, 'export dialog must require confirmation');
    assert.match(exportDialog.description, /不会保存|无法找回/, 'export dialog must explain recovery-passphrase loss');
    await evaluate(cdp, `document.getElementById('backup-passphrase').value='短';document.getElementById('backup-passphrase-submit').click();true`);
    await waitFor(cdp, 'document.getElementById("backup-passphrase-error").textContent.length > 0', 'short passphrase validation');
    const shortError = await evaluate(cdp, `({error:document.getElementById('backup-passphrase-error').textContent,focused:document.activeElement.id})`);
    assert.match(shortError.error, /至少需要 12/);
    assert.strictEqual(shortError.focused, 'backup-passphrase');
    await evaluate(cdp, `document.getElementById('backup-passphrase').value='恢复口令跨设备安全快照二零二六';document.getElementById('backup-passphrase-confirm').value='另一组恢复口令';document.getElementById('backup-passphrase-submit').click();true`);
    await waitFor(cdp, 'document.getElementById("backup-passphrase-error").textContent.length > 0', 'mismatched passphrase validation');
    const mismatch = await evaluate(cdp, `({error:document.getElementById('backup-passphrase-error').textContent,focused:document.activeElement.id})`);
    assert.match(mismatch.error, /不一致/);
    assert.strictEqual(mismatch.focused, 'backup-passphrase-confirm');
    await evaluate(cdp, 'document.querySelector("#backup-passphrase-modal [data-modal-cancel]").click(); true');
    await waitFor(cdp, 'document.getElementById("backup-passphrase-modal").getAttribute("aria-hidden") === "true"', 'export dialog close');

    await evaluate(cdp, `document.querySelector("button[onclick=\\"backupData()\\"]").click();true`);
    await waitFor(cdp, 'document.getElementById("backup-passphrase-modal").getAttribute("aria-hidden") === "false"', 'second export dialog');
    await evaluate(cdp, `document.getElementById('backup-passphrase').value='恢复口令跨设备安全快照二零二六';document.getElementById('backup-passphrase-confirm').value='恢复口令跨设备安全快照二零二六';document.getElementById('backup-passphrase-submit').click();true`);
    await waitFor(cdp, 'document.getElementById("backup-passphrase-modal").getAttribute("aria-hidden") === "true"', 'successful export dialog close');

    await evaluate(cdp, `window.__xjSyntheticRestoreFile = new File(['not-a-valid-backup'], 'synthetic.xjbackup', {type:'application/json'});restoreData({target:{files:[window.__xjSyntheticRestoreFile],value:'synthetic.xjbackup'}});true`);
    await waitFor(cdp, 'document.getElementById("backup-passphrase-modal").getAttribute("aria-hidden") === "false"', 'restore passphrase dialog');
    await waitFor(cdp, 'document.activeElement && document.activeElement.id === "backup-passphrase"', 'restore passphrase focus');
    const restoreDialog = await evaluate(cdp, `({
      focused: document.activeElement && document.activeElement.id === 'backup-passphrase',
      title: document.getElementById('backup-passphrase-title').textContent,
      confirmVisible: getComputedStyle(document.getElementById('backup-restore-confirm-row')).display !== 'none',
      confirmChecked: document.getElementById('backup-restore-confirm').checked
    })`);
    assert.strictEqual(restoreDialog.focused, true, 'restore dialog must focus the passphrase field');
    assert.strictEqual(restoreDialog.confirmVisible, true, 'restore dialog must require explicit overwrite confirmation');
    assert.strictEqual(restoreDialog.confirmChecked, false, 'restore overwrite confirmation must default to unchecked');
    await evaluate(cdp, `document.getElementById('backup-passphrase').value='恢复口令跨设备安全快照二零二六';document.getElementById('backup-passphrase-submit').click();true`);
    await waitFor(cdp, 'document.getElementById("backup-passphrase-error").textContent.length > 0', 'restore overwrite validation');
    const restoreError = await evaluate(cdp, `document.getElementById('backup-passphrase-error').textContent`);
    assert.match(restoreError, /确认会替换/);
    await evaluate(cdp, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
    await waitFor(cdp, 'document.getElementById("backup-passphrase-modal").getAttribute("aria-hidden") === "true"', 'restore dialog Escape close');

    const summary = { route: baseline.route, reduced_motion: baseline.reducedMotion, visual_cells: screenshots.length, screenshots };
    fs.writeFileSync(path.join(ARTIFACTS, 'runtime-visual-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log('ELECTRON_BACKUP_UI=PASS');
    console.log('VISUAL_CELLS=' + screenshots.length);
    console.log('DIALOG_FOCUS_ESCAPE_VALIDATION=PASS');
  } finally {
    if (cdp) {
      try { await evaluate(cdp, 'window.close(); true'); } catch (_) {}
      cdp.close();
    }
    if (child && child.exitCode === null) child.kill();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((error) => {
  console.error('ELECTRON_BACKUP_UI=FAIL', error && error.stack || error);
  process.exitCode = 1;
});
