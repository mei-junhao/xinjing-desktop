'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const cp = require('child_process');
const vm = require('vm');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '../../..');
const OUT_ROOT = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-supervision-material-upload-runtime-closure-012');
const ELECTRON = path.join(ROOT, 'node_modules/electron/dist/electron.exe');
const SCENARIOS = new Set(['success', 'retry', 'cancel']);
const MUTATIONS = new Set([
  'none',
  'delete-failure',
  'delete-retry',
  'delete-cancel',
  'cancel-writes',
  'swallow-reader-error',
  'drop-promise-await',
  'retry-loses-file',
  'fake-success-state',
  'fake-screenshot-sha',
  'skip-real-click'
]);

function arg(name, fallback) {
  const prefix = '--' + name + '=';
  const hit = process.argv.find((value) => value.indexOf(prefix) === 0);
  return hit ? hit.slice(prefix.length) : fallback;
}

const scenario = arg('scenario', 'success');
const mutation = arg('mutation', 'none');
if (!SCENARIOS.has(scenario)) throw new Error('invalid scenario: ' + scenario);
if (!MUTATIONS.has(mutation)) throw new Error('invalid mutation: ' + mutation);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex').toUpperCase();
}

function ensurePathWithin(base, candidate) {
  const b = path.resolve(base) + path.sep;
  const c = path.resolve(candidate);
  if (!c.startsWith(b)) throw new Error('path escapes scratch root: ' + c);
  return c;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function makeAuthServer() {
  const accountId = 'acct_XJ0123456789';
  const email = 'qa012@example.test';
  const token = 'synthetic_token_xj0123456789';
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, bytes: Buffer.byteLength(body, 'utf8') });
      let payload;
      if (req.url === '/account/session') payload = { ok: true, accountId, email, tier: 'pro' };
      else if (req.url === '/account/membership') payload = { ok: true, accountId, tier: 'pro', serverAuthoritative: true };
      else payload = { ok: false, error: { code: 'not-found' } };
      const text = JSON.stringify(payload);
      res.writeHead(payload.ok ? 200 : 404, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, accountId, email, token, requests }));
  });
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }
  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch (_) { return; }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || 'CDP error'));
        else pending.resolve(message.result || {});
        return;
      }
      if (message.method) {
        const list = this.listeners.get(message.method) || [];
        list.forEach((fn) => fn(message.params || {}));
      }
    });
    return this;
  }
  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }
  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function findPageTarget(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await httpJson('http://127.0.0.1:' + port + '/json/list');
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) {}
    await wait(100);
  }
  throw new Error('CDP page target did not appear');
}

async function evaluate(cdp, expression, awaitPromise) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: awaitPromise !== false, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
  return result.result ? result.result.value : undefined;
}

async function waitFor(cdp, expression, timeoutMs, label, intervalMs) {
  const deadline = Date.now() + (timeoutMs || 10000);
  while (Date.now() < deadline) {
    const value = await evaluate(cdp, expression, true);
    if (value) return value;
    await wait(intervalMs || 50);
  }
  throw new Error('timeout waiting for ' + (label || expression));
}

async function clickSelector(cdp, selector, clickLog) {
  const rect = await evaluate(cdp, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.textContent.trim(), disabled: !!el.disabled, hidden: !!el.hidden }; })()`);
  if (!rect) throw new Error('missing clickable selector: ' + selector);
  if (rect.hidden || rect.disabled) throw new Error('not clickable: ' + selector);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  clickLog.push({ selector, text: rect.text, x: rect.x, y: rect.y, at: new Date().toISOString() });
}

async function setFileInput(cdp, selector, filePath, clickLog) {
  const doc = await cdp.send('DOM.getDocument', { depth: 0 });
  const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  if (!node.nodeId) throw new Error('file input not found: ' + selector);
  await cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [filePath] });
  clickLog.push({ selector, action: 'setFileInputFiles', file: filePath, at: new Date().toISOString() });
}

async function chooseReportFile(cdp, filePath, clickLog) {
  if (mutation !== 'skip-real-click') await clickSelector(cdp, '#sup-report-upload-trigger', clickLog);
  await setFileInput(cdp, '#sup-report-file', filePath, clickLog);
}

async function typeInto(cdp, selector, text, clickLog) {
  await clickSelector(cdp, selector, clickLog);
  await cdp.send('Input.insertText', { text });
}

function mutationSource(source, kind) {
  if (kind === 'none' || kind === 'fake-screenshot-sha' || kind === 'skip-real-click') return source;
  if (kind === 'delete-failure') {
    const needle = 'else failReportUpload(operation, error);';
    if (!source.includes(needle)) throw new Error('failure mutation needle missing');
    return source.replace(needle, 'else { /* expected-red mutation: failure handler deleted */ }');
  }
  if (kind === 'delete-retry') {
    const needle = 'if (uploadOperation || !uploadPendingFile) return;\n      startReportUpload(uploadPendingFile, true);';
    if (!source.includes(needle)) throw new Error('retry mutation needle missing');
    return source.replace(needle, 'if (uploadOperation || !uploadPendingFile) return;\n      return;');
  }
  if (kind === 'delete-cancel') {
    const pattern = /window\.cancelReportFileUpload = function \(\) \{[\s\S]*?\n    \};/;
    if (!pattern.test(source)) throw new Error('cancel mutation needle missing');
    return source.replace(pattern, 'window.cancelReportFileUpload = function () { return; };');
  }
  if (kind === 'cancel-writes') {
    const needle = 'function finishUploadCancel(operation) {\n      if (operation && operation.cancelSettled) return;';
    if (!source.includes(needle)) throw new Error('cancel-write mutation needle missing');
    return source.replace(needle, needle + "\n      materialTA.value += '【变异：取消后错误写入】';");
  }
  if (kind === 'swallow-reader-error') {
    const needle = "reader.onerror = function () { rejectOnce(reader.error || new Error('文件读取失败')); };";
    if (!source.includes(needle)) throw new Error('reader error mutation needle missing');
    return source.replace(needle, "reader.onerror = function () { resolve('错误被吞掉'); };");
  }
  if (kind === 'drop-promise-await') {
    const needle = 'return Promise.resolve(extracted).then(function (result) {';
    if (!source.includes(needle)) throw new Error('promise await mutation needle missing');
    return source.replace(needle, 'return extracted; /* expected-red mutation: Promise result not awaited */\\n        Promise.resolve(extracted).then(function (result) {');
  }
  if (kind === 'retry-loses-file') {
    const needle = 'startReportUpload(uploadPendingFile, true);';
    if (!source.includes(needle)) throw new Error('retry file mutation needle missing');
    return source.replace(needle, 'startReportUpload(null, true);');
  }
  if (kind === 'fake-success-state') {
    const needle = "setUploadState('failure', reason + '；材料与草稿均未改变。');";
    if (!source.includes(needle)) throw new Error('fake state mutation needle missing');
    return source.replace(needle, "setUploadState('success', reason + '；变异：伪造成功状态。');");
  }
  throw new Error('unknown mutation: ' + kind);
}

async function captureScreenshot(cdp, outputPath) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const bytes = Buffer.from(shot.data, 'base64');
  fs.writeFileSync(outputPath, bytes);
  return { path: outputPath, bytes: bytes.length, sha256: mutation === 'fake-screenshot-sha' ? '0'.repeat(64) : sha256(bytes) };
}

async function run() {
  if (!fs.existsSync(ELECTRON)) throw new Error('Electron launcher missing: ' + ELECTRON);
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
  const runDir = ensurePathWithin(OUT_ROOT, path.join(OUT_ROOT, 'runtime', scenario + '-' + mutation + '-' + runId));
  fs.mkdirSync(runDir, { recursive: true });
  const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-upload-012-'));
  const auth = await makeAuthServer();
  const token = auth.token;
  fs.writeFileSync(path.join(tempUserData, 'account-session-v1.json'), JSON.stringify({ version: 1, tokenEnc: token, accountId: auth.accountId, email: auth.email }), 'utf8');
  const cdpPort = 9300 + Math.floor(Math.random() * 300);
  const sourcePath = path.join(ROOT, 'app/js/supervision.js');
  const originalSource = fs.readFileSync(sourcePath, 'utf8');
  const mutatedSource = mutationSource(originalSource, mutation);
  if (mutation !== 'none') new vm.Script(mutatedSource, { filename: 'supervision-mutated-' + mutation + '.js' });
  const requestLog = [];
  const consoleErrors = [];
  const pageErrors = [];
  const clickLog = [];
  let proc;
  let cdp;
  let target;
  let result;
  try {
    proc = cp.spawn(ELECTRON, ['--disable-gpu', '--user-data-dir=' + tempUserData, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + cdpPort, ROOT], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: tempUserData, XJ_ACCOUNT_API_BASE: 'http://127.0.0.1:' + auth.port }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    target = await findPageTarget(cdpPort);
    cdp = await new Cdp(target.webSocketDebuggerUrl).connect();
    cdp.on('Runtime.consoleAPICalled', (event) => {
      const values = (event.args || []).map((arg) => arg.value !== undefined ? arg.value : arg.description);
      const level = event.type || 'log';
      if (level === 'error' || level === 'assert') consoleErrors.push({ level, values });
    });
    cdp.on('Runtime.exceptionThrown', (event) => pageErrors.push(event.exceptionDetails || {}));
    cdp.on('Log.entryAdded', (event) => { if (event.entry && event.entry.level === 'error') consoleErrors.push({ level: 'log', values: [event.entry.text] }); });
    cdp.on('Network.requestWillBeSent', (event) => requestLog.push({ url: event.request.url, type: event.type, documentURL: event.documentURL }));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
    await cdp.send('DOM.enable');
    await cdp.send('Network.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    if (mutation !== 'none') {
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*supervision.js*', requestStage: 'Request' }] });
      cdp.on('Fetch.requestPaused', async (event) => {
        try {
          if (event.request && /\/js\/supervision\.js(?:\?|$)/.test(event.request.url)) {
            await cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript; charset=utf-8' }], body: Buffer.from(mutatedSource, 'utf8').toString('base64') });
          } else await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
        } catch (_) {}
      });
    }
    const origin = new URL(target.url).origin;
    let supervisionReady = false;
    for (let attempt = 0; attempt < 4 && !supervisionReady; attempt++) {
      await cdp.send('Page.navigate', { url: origin + '/supervision.html' });
      try {
        await waitFor(cdp, "location.pathname.endsWith('/supervision.html') && document.readyState === 'complete' && !!document.querySelector('#sup-upload-status') && typeof window.switchTab === 'function' && typeof window.onReportFileUpload === 'function'", 10000, 'supervision upload UI');
        supervisionReady = true;
      } catch (error) {
        if (attempt === 3) throw error;
        await wait(1200);
      }
    }
    await clickSelector(cdp, '[data-tab="material"]', clickLog);
    await waitFor(cdp, "document.querySelector('#material-block') && getComputedStyle(document.querySelector('#material-block')).display !== 'none'", 5000, 'material tab');
    await evaluate(cdp, "window.__xjUploadInitialSupervisions = Store.getSupervisions ? Store.getSupervisions().length : null", true);
    await evaluate(cdp, "window.__xjUploadTrace = [{ state: document.querySelector('#sup-upload-status').dataset.uploadState, text: document.querySelector('#sup-upload-status-detail').textContent }]; new MutationObserver(() => { const s=document.querySelector('#sup-upload-status'); window.__xjUploadTrace.push({ state:s.dataset.uploadState, file:document.querySelector('#sup-upload-status-file').textContent, detail:document.querySelector('#sup-upload-status-detail').textContent, material:document.querySelector('#sup-material').value, draft:localStorage.getItem('xj_sup_v31_draft') }); }).observe(document.querySelector('#sup-upload-status'), { attributes:true, childList:true, subtree:true, characterData:true });", true);
    await evaluate(cdp, "window.__xjReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches", true);
    await typeInto(cdp, '#sup-material', '用户已输入的合成督导材料，长中文段落用于检查窄窗换行与状态区域可读性。'.repeat(12), clickLog);
    const before = await evaluate(cdp, "({ material: document.querySelector('#sup-material').value, draft: localStorage.getItem('xj_sup_v31_draft'), supervisions: Store.getSupervisions ? Store.getSupervisions().length : null })", true);
    const txtPath = path.join(runDir, 'synthetic-report.txt');
    const docxPath = path.join(runDir, 'synthetic-report.docx');
    const cancelPath = path.join(runDir, 'synthetic-cancel.txt');
    fs.writeFileSync(txtPath, '合成报告文本：用于验证本地读取与材料草稿闭环。', 'utf8');
    fs.writeFileSync(docxPath, Buffer.from('synthetic controlled docx bytes', 'utf8'));
    fs.writeFileSync(cancelPath, Buffer.alloc(32 * 1024 * 1024, 0x41));
    if (scenario === 'success') {
      if (mutation === 'swallow-reader-error') {
        await evaluate(cdp, "(() => { const NativeFileReader = window.FileReader; window.FileReader = function () { const reader = new NativeFileReader(); reader.readAsText = function () { window.setTimeout(() => { if (typeof reader.onerror === 'function') reader.onerror({ target: reader }); }, 40); }; return reader; }; window.FileReader.prototype = NativeFileReader.prototype; })()", true);
      }
      await chooseReportFile(cdp, txtPath, clickLog);
      await waitFor(cdp, "document.querySelector('#sup-upload-status').dataset.uploadState === 'success'", 10000, 'txt success');
      const after = await evaluate(cdp, "({ state: document.querySelector('#sup-upload-status').dataset.uploadState, trace: window.__xjUploadTrace, material: document.querySelector('#sup-material').value, draft: localStorage.getItem('xj_sup_v31_draft'), file: document.querySelector('#sup-upload-status-file').textContent, supervisions: Store.getSupervisions ? Store.getSupervisions().length : null })", true);
      if (!after.material.includes('用户已输入的合成督导材料') || !after.material.includes('合成报告文本')) throw new Error('success did not preserve and append material');
      if (after.draft !== after.material) throw new Error('success draft mismatch');
      if (before.supervisions !== null && after.supervisions !== before.supervisions) throw new Error('upload wrote formal supervision record');
      result = { ok: true, scenario, mutation, before, after, expected: 'idle→uploading→progress→success' };
    } else if (scenario === 'retry') {
      await evaluate(cdp, "window.__xjMammothCalls = 0; window.__xjMammothSizes = []; window.mammoth = { extractRawText: function (input) { window.__xjMammothCalls++; window.__xjMammothSizes.push(input && input.arrayBuffer ? input.arrayBuffer.byteLength : 0); return window.__xjMammothCalls === 1 ? Promise.reject(new Error('受控 docx 解析失败')) : Promise.resolve({ value: '受控 docx 重试成功文本' }); } }", true);
      await chooseReportFile(cdp, docxPath, clickLog);
      await waitFor(cdp, "document.querySelector('#sup-upload-status').dataset.uploadState === 'failure'", 10000, 'docx failure');
      const failed = await evaluate(cdp, "({ state: document.querySelector('#sup-upload-status').dataset.uploadState, material: document.querySelector('#sup-material').value, draft: localStorage.getItem('xj_sup_v31_draft'), file: document.querySelector('#sup-upload-status-file').textContent, calls: window.__xjMammothCalls, sizes: window.__xjMammothSizes.slice(), trace: window.__xjUploadTrace })", true);
      if (failed.material !== before.material || failed.draft !== before.draft) throw new Error('failure changed material or draft');
      await clickSelector(cdp, '#sup-upload-retry', clickLog);
      await waitFor(cdp, "document.querySelector('#sup-upload-status').dataset.uploadState === 'success'", 10000, 'docx retry success');
      const after = await evaluate(cdp, "({ state: document.querySelector('#sup-upload-status').dataset.uploadState, material: document.querySelector('#sup-material').value, draft: localStorage.getItem('xj_sup_v31_draft'), file: document.querySelector('#sup-upload-status-file').textContent, calls: window.__xjMammothCalls, sizes: window.__xjMammothSizes.slice(), trace: window.__xjUploadTrace, supervisions: Store.getSupervisions ? Store.getSupervisions().length : null })", true);
      if (!after.material.includes('受控 docx 重试成功文本') || after.calls !== 2 || after.sizes.some((size) => !size) || after.sizes[0] !== after.sizes[1]) throw new Error('retry did not reuse same non-empty file');
      if (before.supervisions !== null && after.supervisions !== before.supervisions) throw new Error('retry wrote formal supervision record');
      result = { ok: true, scenario, mutation, before, failed, after, expected: 'failure→retry→success' };
    } else if (scenario === 'cancel') {
      await evaluate(cdp, "(() => { const NativeFileReader = window.FileReader; window.FileReader = function () { const reader = new NativeFileReader(); let started = false; let aborted = false; const nativeRead = reader.readAsText.bind(reader); const nativeAbort = reader.abort.bind(reader); Object.defineProperty(reader, 'readyState', { configurable: true, get: () => aborted ? 2 : 1 }); reader.readAsText = function (file, encoding) { window.setTimeout(() => { if (!aborted) { started = true; nativeRead(file, encoding); } }, 250); }; reader.abort = function () { if (aborted) return; aborted = true; try { if (started) nativeAbort(); } catch (_) {} if (typeof reader.onabort === 'function') reader.onabort({ type: 'abort', target: reader }); }; return reader; }; window.FileReader.prototype = NativeFileReader.prototype; })()", true);
      await chooseReportFile(cdp, cancelPath, clickLog);
      await waitFor(cdp, "document.querySelector('#sup-upload-status').dataset.uploadState === 'progress'", 10000, 'cancel progress', 5);
      await clickSelector(cdp, '#sup-upload-cancel', clickLog);
      await waitFor(cdp, "document.querySelector('#sup-upload-status').dataset.uploadState === 'idle'", 10000, 'cancel idle');
      const after = await evaluate(cdp, "({ state: document.querySelector('#sup-upload-status').dataset.uploadState, material: document.querySelector('#sup-material').value, draft: localStorage.getItem('xj_sup_v31_draft'), file: document.querySelector('#sup-upload-status-file').textContent, trace: window.__xjUploadTrace, supervisions: Store.getSupervisions ? Store.getSupervisions().length : null })", true);
      if (after.material !== before.material || after.draft !== before.draft) throw new Error('cancel changed material or draft');
      if (after.trace.some((entry) => entry.state === 'success')) throw new Error('cancel reported success');
      if (before.supervisions !== null && after.supervisions !== before.supervisions) throw new Error('cancel wrote formal supervision record');
      result = { ok: true, scenario, mutation, before, after, expected: 'cancel→idle' };
    }
    if (!clickLog.some((entry) => entry.selector === '#sup-report-upload-trigger')) throw new Error('real upload trigger click missing');
    const viewportEvidence = [];
    for (const viewport of [{ width: 1024, height: 700 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
      await wait(120);
      const layout = await evaluate(cdp, "({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight, focused: document.activeElement ? document.activeElement.id || document.activeElement.tagName : '', status: document.querySelector('#sup-upload-status').textContent })", true);
      const shot = await captureScreenshot(cdp, path.join(runDir, 'viewport-' + viewport.width + 'x' + viewport.height + '.png'));
      viewportEvidence.push(Object.assign({ viewport }, layout, { screenshot: shot }));
    }
    const finalState = await evaluate(cdp, "({ url: location.href, trace: window.__xjUploadTrace, reducedMotion: window.__xjReducedMotion, consoleErrors: window.__xjConsoleErrors || [], statusText: document.querySelector('#sup-upload-status').textContent, client: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }, scroll: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }, activeElement: document.activeElement ? document.activeElement.id || document.activeElement.tagName : '' })", true);
    result.url = finalState.url;
    const unexpectedConsoleErrors = consoleErrors.filter((entry) => !entry.values || !entry.values.some((value) => String(value).indexOf('Electron sandboxed_renderer.bundle.js script failed to run') >= 0 || String(value).indexOf("Cannot destructure property 'preloadScripts'") >= 0));
    result.runtime = { clickLog, trace: finalState.trace, statusText: finalState.statusText, reducedMotion: finalState.reducedMotion, viewportEvidence, scroll: finalState.scroll, client: finalState.client, activeElement: finalState.activeElement, consoleErrors, unexpectedConsoleErrors, pageErrors, network: requestLog, authRequests: auth.requests };
    if (unexpectedConsoleErrors.length || pageErrors.length) throw new Error('unexpected console/page errors detected');
    if (viewportEvidence.some((item) => item.scrollWidth > item.clientWidth)) throw new Error('horizontal overflow detected');
    writeJson(path.join(runDir, 'run.json'), result);
    return result;
  } finally {
    if (cdp) cdp.close();
    if (proc && !proc.killed) {
      try { proc.kill(); } catch (_) {}
      await wait(500);
    }
    try { auth.server.close(); } catch (_) {}
    try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch (_) {}
  }
}

run().then((result) => {
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0);
}).catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write('\n');
  process.exit(1);
});
