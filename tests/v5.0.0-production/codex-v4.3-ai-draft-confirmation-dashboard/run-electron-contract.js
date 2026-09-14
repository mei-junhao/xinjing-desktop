'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ARTIFACT_DIR = path.join(__dirname, 'artifacts');
const TASK_ID = 'XJ-5.0.0-codex-v4.3-ai-draft-confirmation-dashboard-30';
const VIEWPORTS = [
  { width: 1024, height: 700 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
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
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('CDP discovery timeout')));
  });
}

async function waitForPage(port) {
  let lastError = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const pages = await getJson('http://127.0.0.1:' + port + '/json/list');
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error('Electron page unavailable: ' + (lastError && lastError.message || 'timeout'));
}

function createCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    socket.once('open', () => resolve({
      send(method, params) {
        const id = nextId++;
        return new Promise((resolveCommand, rejectCommand) => {
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
          socket.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      close() { try { socket.close(); } catch (_) {} },
    }));
    socket.once('error', reject);
    socket.on('close', () => {
      pending.forEach((item) => item.reject(new Error('CDP closed')));
      pending.clear();
    });
    socket.on('message', (data) => {
      let message;
      try { message = JSON.parse(String(data)); } catch (_) { return; }
      if (!message.id || !pending.has(message.id)) return;
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else item.resolve(message.result);
    });
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('Renderer evaluation failed: ' + (result.exceptionDetails.text || 'unknown'));
  return result.result && result.result.value;
}

async function waitFor(cdp, expression, label) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await evaluate(cdp, expression)) return;
    await sleep(100);
  }
  throw new Error('Timed out waiting for ' + label);
}

async function capture(cdp, name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const data = Buffer.from(result.data || '', 'base64');
  if (data.length < 1024) throw new Error('Blank screenshot: ' + name);
  const file = path.join(ARTIFACT_DIR, name + '.png');
  fs.writeFileSync(file, data);
  return { file, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex').toUpperCase() };
}

async function main() {
  if (!fs.existsSync(ELECTRON)) throw new Error('Electron executable missing: ' + ELECTRON);
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-ai-draft-electron-'));
  const port = await findFreePort();
  let child = null;
  let cdp = null;
  const screenshots = [];
  try {
    child = childProcess.spawn(ELECTRON, [
      '--disable-gpu',
      '--disable-background-networking',
      '--user-data-dir=' + userData,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=' + port,
      ROOT,
    ], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: userData }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs = [];
    child.stdout.on('data', (chunk) => logs.push(String(chunk).trim()));
    child.stderr.on('data', (chunk) => logs.push(String(chunk).trim()));
    const page = await waitForPage(port);
    cdp = await createCdp(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await waitFor(cdp, 'document.readyState === "complete" && window.Store && Store.isHydrated && Store.isHydrated()', 'Store hydration');

    const seeded = await evaluate(cdp, `(async function () {
      const client = await Store.createClientDurable({ id: 'SYN-DASH-C', name: '合成来访者' });
      const session = await Store.createSessionDurable({ id: 'SYN-DASH-S', clientId: 'SYN-DASH-C', sessionNumber: 1, date: '2026-07-28', notes: 'synthetic' });
      const draftA = await Store.createAiDraftClinicalTaskDurable({ id: 'SYN-DASH-T-A', clientId: 'SYN-DASH-C', originSessionId: 'SYN-DASH-S', title: '待确认合成任务 A', sourceRefs: ['session:SYN-DASH-S'], target: 'consult-notes.html', actionRunId: 'SYN-DASH-RUN-A' });
      const draftB = await Store.createAiDraftClinicalTaskDurable({ id: 'SYN-DASH-T-B', clientId: 'SYN-DASH-C', originSessionId: 'SYN-DASH-S', title: '待确认合成任务 B', sourceRefs: ['session:SYN-DASH-S'], target: 'consult-notes.html', actionRunId: 'SYN-DASH-RUN-B' });
      return { ok: !!(client.ok && session.ok && draftA.ok && draftB.ok) };
    })()`, true);
    if (!seeded || !seeded.ok) throw new Error('Synthetic seed failed: ' + JSON.stringify(seeded));
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(cdp, 'document.querySelector("[data-task-confirm=\\"SYN-DASH-T-A\\"]") !== null', 'AI draft confirmation button');

    for (const viewport of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
      const visual = await evaluate(cdp, `(function () {
        const row = Array.from(document.querySelectorAll('.task-item')).find((item) => item.querySelector('[data-task-confirm="SYN-DASH-T-A"]'));
        const button = document.querySelector('[data-task-confirm="SYN-DASH-T-A"]');
        if (!row || !button) return { ok: false, reason: 'draft controls missing' };
        row.scrollIntoView({ block: 'center', inline: 'nearest' });
        button.focus();
        const rowRect = row.getBoundingClientRect();
        const info = row.querySelector('.info');
        const infoRect = info && info.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        const intersects = infoRect && !(buttonRect.left >= infoRect.right || buttonRect.right <= infoRect.left || buttonRect.top >= infoRect.bottom || buttonRect.bottom <= infoRect.top);
        return {
          ok: true,
          status: row.textContent,
          metadata: row.querySelector('.mt') && row.querySelector('.mt').textContent,
          focused: document.activeElement === button,
          visible: buttonRect.width > 0 && buttonRect.height > 0 && rowRect.bottom >= 0 && rowRect.top <= innerHeight,
          noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          noInfoButtonOverlap: !intersects,
          rowWidth: rowRect.width,
        };
      })()`);
      if (!visual.ok || !visual.focused || !visual.visible || !visual.noHorizontalOverflow || !visual.noInfoButtonOverlap || !/待人工确认/.test(visual.metadata || '') || !/SYN-DASH-RUN-A/.test(visual.metadata || '')) {
        throw new Error('Visual check failed at ' + viewport.width + 'x' + viewport.height + ': ' + JSON.stringify(visual));
      }
      screenshots.push(Object.assign({ viewport: viewport.width + 'x' + viewport.height }, await capture(cdp, 'dashboard-' + viewport.width + 'x' + viewport.height)));
    }

    const success = await evaluate(cdp, `(async function () {
      const button = document.querySelector('[data-task-confirm="SYN-DASH-T-A"]');
      button.click();
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && Store.getClinicalTask('SYN-DASH-T-A').status !== 'open') await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        status: Store.getClinicalTask('SYN-DASH-T-A').status,
        hasCompletion: !!document.querySelector('[data-task-complete="SYN-DASH-T-A"]'),
        hasConfirm: !!document.querySelector('[data-task-confirm="SYN-DASH-T-A"]'),
      };
    })()`);
    if (success.status !== 'open' || !success.hasCompletion || success.hasConfirm) throw new Error('Durable success UI failed: ' + JSON.stringify(success));

    const failure = await evaluate(cdp, `(async function () {
      const original = Store.confirmClinicalTaskDurable;
      Store.confirmClinicalTaskDurable = async function () { return { ok: false, error: { code: 'SYNTHETIC_CONFIRM_FAILURE' } }; };
      const button = document.querySelector('[data-task-confirm="SYN-DASH-T-B"]');
      button.click();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && button.disabled) await new Promise((resolve) => setTimeout(resolve, 25));
      const result = { status: Store.getClinicalTask('SYN-DASH-T-B').status, enabled: !button.disabled, stillDraft: !!document.querySelector('[data-task-confirm="SYN-DASH-T-B"]') };
      Store.confirmClinicalTaskDurable = original;
      return result;
    })()`);
    if (failure.status !== 'ai-draft' || !failure.enabled || !failure.stillDraft) throw new Error('Durable failure UI failed: ' + JSON.stringify(failure));

    const result = { schema_version: 1, task_id: TASK_ID, pass: true, viewports: VIEWPORTS.map((item) => item.width + 'x' + item.height), screenshots, success, failure, synthetic_data_only: true };
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'electron-result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
    process.stdout.write('ELECTRON_RESULT=' + JSON.stringify(result) + '\n');
  } finally {
    try { if (cdp) await evaluate(cdp, 'window.close(); true'); } catch (_) {}
    if (cdp) cdp.close();
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    const safe = path.resolve(userData).startsWith(path.resolve(os.tmpdir()) + path.sep);
    if (safe && fs.existsSync(userData)) fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.exit(1);
});
