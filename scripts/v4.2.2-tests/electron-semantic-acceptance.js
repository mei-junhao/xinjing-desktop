#!/usr/bin/env node
'use strict';

/* XJ-4.2.2 Marvis Runtime Acceptance — real Electron semantic acceptance.
 * Isolated wrapper + loopback CDP, synthetic data only, deny-by-default network.
 * Covers 22-route smoke, 18-cell visual matrix, quick record flow, billing/calendar
 * keyboard/focus lifecycle, self-test and git diff --check. */

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..', '..');
const wrapper = path.join(root, 'scripts', 'agent-electron-acceptance.ps1');
const evidenceDir = path.join(root, 'qa', 'acceptance', 'XJ-4.2.2-marvis');
const screenshotDir = path.join(evidenceDir, 'screenshots');

const candidateFiles = [
  'app/billing-shell.html',
  'app/css/workbench.css',
  'app/css/xj-ui-system.css',
  'app/index.html',
  'app/settings.html',
  'app/js/ai.js',
  'app/js/app.js',
  'app/js/clinical-context.js',
  'app/js/consult-notes.js',
  'app/js/dashboard.js',
  'app/js/entitlements.js',
  'app/js/quick-record.js',
  'app/js/session-calendar.js',
  'app/js/settings.js',
  'app/js/store.js',
  'main.js',
  'package-lock.json',
  'package.json',
  'preload.js',
  'scripts/v4.2.2-tests/billing-shell-ui.contract.js',
  'scripts/v4.2.2-tests/quick-record-ui.contract.js',
  'scripts/v4.2.2-tests/quick-record.contract.js',
  'scripts/v4.2.2-tests/ui-shared.contract.js',
  'scripts/v4.2.2-tests/workbench-readonly.contract.js',
  'scripts/v4.2.1-tests/license-v2.contract.js',
  'version.generated.js',
].sort();

function fail(message) { throw new Error(message); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function ensure(condition, message) { if (!condition) fail(message); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function candidateHash() {
  const hash = crypto.createHash('sha256');
  for (const file of candidateFiles) {
    hash.update(Buffer.from(file, 'utf8'));
    hash.update(Buffer.from([0]));
    hash.update(fs.readFileSync(path.join(root, file)));
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

function assertAcceptancePathCanonicalization() {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  ensure(main.includes('fs.realpathSync.native(path.resolve(os.tmpdir()))'), 'Acceptance mode must canonicalize the system temp root');
  ensure(main.includes('fs.realpathSync.native(path.resolve(requested))'), 'Acceptance mode must canonicalize the requested userData path');
}

function findUnusedPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
  if (!response.ok) fail('HTTP ' + response.status + ' from ' + url);
  return response.json();
}

async function waitForTarget(port, timeoutMs) {
  const expectedBillingBytes = fs.readFileSync(path.join(root, 'app', 'billing-shell.html'));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await json('http://127.0.0.1:' + port + '/json/list');
      const pages = targets.filter((target) => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(target.url || ''));
      for (const page of pages) {
        try {
          const response = await fetch(new URL('/billing-shell.html?target-check=' + Date.now(), page.url), { cache: 'no-store', signal: AbortSignal.timeout(1000) });
          if (!response.ok) continue;
          const servedBytes = Buffer.from(await response.arrayBuffer());
          if (servedBytes.equals(expectedBillingBytes)) return page;
        } catch (_) {}
      }
    } catch (_) {}
    await delay(250);
  }
  fail('Timed out waiting for a loopback-only CDP target serving the current workspace source');
}

function connectCdp(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 1;
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        return new Promise((resolveCommand, rejectCommand) => {
          const id = nextId++;
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      on(method, handler) {
        if (!listeners.has(method)) listeners.set(method, []);
        listeners.get(method).push(handler);
      },
      close() { try { ws.close(); } catch (_) {} },
    }));
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        for (const handler of listeners.get(message.method) || []) {
          try { handler(message.params || {}); } catch (_) {}
        }
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result || {});
    });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket connection failed')));
    ws.addEventListener('close', () => {
      for (const entry of pending.values()) entry.reject(new Error('CDP WebSocket closed'));
      pending.clear();
    });
  });
}

const ALL_ROUTES = [
  'activation.html', 'billing-calendar.html', 'billing-shell.html', 'chat-home.html',
  'confirm-close.html', 'consult-notes.html', 'doc-center.html', 'doc-growth.html',
  'feedback.html', 'index.html', 'knowledge.html', 'masters.html',
  'migrate-helper.html', 'real-supervision-ai.html', 'real-supervision.html',
  'report-writing.html', 'session-calendar.html', 'settings.html',
  'supervision-mindmap.html', 'supervision.html', 'transcript-guide.html', 'transcript.html',
];

// === Hardened QuickRecord assertions (v2) ===
// These run against data captured from the REAL production QuickRecord.createQuickRecord /
// Store.createSessionDurable flow. They are deliberately mutation-sensitive: a mutant that
// returns ok:true without persisting, or swallows a durable failure, must make them throw.
function assertTruthy(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertSuccessHardened(d) {
  assertTruthy(d.returnedOk === true, 'QR success: production createQuickRecord returned ok:true (ok-only check is insufficient)');
  assertTruthy(d.returnedSessionId, 'QR success: returned a session id');
  assertTruthy(d.persistedClientId !== null && d.persistedClientId !== undefined, 'QR success: a newly persisted synthetic session exists in Store (durable wrote it)');
  assertTruthy(d.after === d.before + 1, 'QR success: exactly one new session persisted (' + d.before + '->' + d.after + ')');
  assertTruthy(!d.cid || d.persistedClientId === d.cid, 'QR success: persisted session clientId matches the active client');
  assertTruthy(d.resultVisible, 'QR success: saved state is visible (qr-result shown)');
  assertTruthy(d.successVisible && /已保存/.test(d.successText), 'QR success: visible saved indicator (.qr-success containing 已保存) present');
  const savedToast = (d.toasts || []).some((t) => /已保存/.test(t.msg));
  assertTruthy(savedToast || d.domToast, 'QR success: production success toast / visible saved indicator “已保存” fired');
  assertTruthy(d.followups && d.followups.length === 4, 'QR success: all four follow-up actions present (' + (d.followups ? d.followups.length : 0) + ')');
  assertTruthy(d.followups.every((b) => b.client), 'QR success: every follow-up carries a valid client context');
  const detailFw = (d.followups || []).filter((b) => ['billing', 'supervision', 'notes'].indexOf(b.action) >= 0);
  assertTruthy(detailFw.every((b) => b.session), 'QR success: detail follow-ups (billing/supervision/notes) carry a valid session context');
  assertTruthy(d.followups.every((b) => b.disabled === false), 'QR success: follow-up actions are enabled');
}

function assertFailureHardened(d) {
  assertTruthy(d.returnedOk === false, 'QR failure: createQuickRecord returned ok:false (durable failure was not swallowed)');
  assertTruthy(d.code === 'XJ_QR_DURABLE_THROW', 'QR failure: real durable error code present (' + d.code + ')');
  assertTruthy(d.errorVisible && /保存失败/.test(d.errorText), 'QR failure: visible error shown (.qr-error containing 保存失败)');
  assertTruthy(d.draftHint, 'QR failure: draft recovery hint shown');
  assertTruthy(d.overlayVisible, 'QR failure: modal remains open (overlay visible)');
  assertTruthy(d.notesRetained, 'QR failure: typed input retained in textarea (recoverable)');
  assertTruthy(d.recoveredDraft, 'QR failure: QuickRecord.recoverDraft() returns the draft (recoverable)');
  assertTruthy(d.submitDisabled === false, 'QR failure: submit control restored/enabled');
  assertTruthy(d.successToast === false, 'QR failure: NO false success toast emitted');
}

async function main() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  assertAcceptancePathCanonicalization();
  const actualCandidate = candidateHash();
  console.log('Candidate SHA: ' + actualCandidate);
  const acceptanceScriptSha = sha256(fs.readFileSync(__filename));
  const baseAcceptanceScriptSha = 'baeaf23c5c3f405d82cc8cdc43bfb86895c83984579b0b756c66dd395ed73efc';
  console.log('Acceptance script SHA: ' + acceptanceScriptSha);

  const port = await findUnusedPort();
  const beforeTemp = new Set(fs.readdirSync(require('os').tmpdir()).filter((name) => name.startsWith('xinjing-agent-acceptance-')));
  const powerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const launcher = childProcess.spawn(powerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper, '-RemoteDebuggingPort', String(port)], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let launcherOutput = '';
  launcher.stdout.on('data', (chunk) => { launcherOutput += chunk; });
  launcher.stderr.on('data', (chunk) => { launcherOutput += chunk; });

  const result = {
    task_id: 'XJ-4.2.2-marvis-runtime-acceptance',
    candidate_sha256: actualCandidate,
    acceptance_script_sha256: acceptanceScriptSha,
    base_acceptance_script_sha256: baseAcceptanceScriptSha,
    base_commit: '6910e90bcc2206658a3c66f6c203216b70089001',
    cdp_port: port,
    timestamp: new Date().toISOString(),
    matrix: [],
    routes: [],
    flows: [],
    console_errors: [],
    network_denials: [],
    self_test: null,
    git_diff_check: null,
    cleanup: null,
    score: 0,
  };
  let cdp = null;
  let routesOk = 0, routesFail = 0;
  try {
    try {
      const target = await waitForTarget(port, 30000);
    result.target_url = target.url;

    // Verify served source matches workspace
    const servedBillingUrl = new URL('/billing-shell.html?candidate=' + actualCandidate, target.url);
    const servedBillingResponse = await fetch(servedBillingUrl, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    ensure(servedBillingResponse.ok, 'Electron static server did not return billing-shell.html');
    const servedBillingBytes = Buffer.from(await servedBillingResponse.arrayBuffer());
    const localBillingBytes = fs.readFileSync(path.join(root, 'app', 'billing-shell.html'));
    result.served_source = {
      url: servedBillingUrl.toString(),
      served_sha256: sha256(servedBillingBytes),
      local_sha256: sha256(localBillingBytes),
      pass: servedBillingBytes.equals(localBillingBytes),
    };
    ensure(result.served_source.pass, 'Electron served source does not match current workspace: ' + JSON.stringify(result.served_source));

    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    // Collect console-errors and network-denials
    cdp.on('Runtime.exceptionThrown', (event) => {
      const details = event.exceptionDetails || {};
      result.console_errors.push({ source: 'Runtime.exceptionThrown', text: details.text || 'Renderer exception', url: details.url || '', line: details.lineNumber });
    });
    cdp.on('Runtime.consoleAPICalled', (event) => {
      if (event.type !== 'error' && event.type !== 'assert') return;
      result.console_errors.push({ source: 'Runtime.consoleAPICalled', type: event.type, text: (event.args || []).map((arg) => arg.value || arg.description || '').join(' ') });
    });
    cdp.on('Log.entryAdded', (event) => {
      const entry = event.entry || {};
      if (entry.level !== 'error') return;
      if (/ERR_BLOCKED_BY_CLIENT/.test(entry.text || '')) {
        result.network_denials.push({ source: 'Log.entryAdded', text: entry.text || '', url: entry.url || '' });
        return;
      }
      result.console_errors.push({ source: 'Log.entryAdded', text: entry.text || '', url: entry.url || '' });
    });

    async function evaluate(expression) {
      const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) {
        const details = response.exceptionDetails;
        const exception = details.exception || {};
        const location = [details.url || '', Number.isInteger(details.lineNumber) ? details.lineNumber + 1 : '', Number.isInteger(details.columnNumber) ? details.columnNumber + 1 : ''].filter((part) => part !== '').join(':');
        fail('Renderer evaluation failed: ' + (exception.description || exception.value || details.text || 'unknown exception') + (location ? ' @ ' + location : ''));
      }
      return response.result ? response.result.value : undefined;
    }
    async function waitForReady() {
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await evaluate('document.readyState === "complete"')) return;
        await delay(100);
      }
      fail('Renderer page did not reach readyState=complete');
    }
    async function navigate(page) {
      const origin = new URL(target.url).origin;
      await cdp.send('Page.navigate', { url: origin + '/' + page });
      for (let attempt = 0; attempt < 80; attempt++) {
        const ready = await evaluate(`document.readyState === 'complete' && location.pathname.endsWith(${JSON.stringify('/' + page)})`);
        if (ready) {
          await delay(150);
          return;
        }
        await delay(100);
      }
      fail('Navigation did not reach ' + page);
    }
    async function screenshot(file) {
      const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const bytes = Buffer.from(capture.data, 'base64');
      const png = PNG.sync.read(bytes);
      let varied = false;
      for (let offset = 4; offset < png.data.length; offset += Math.max(4, Math.floor(png.data.length / 5000) * 4)) {
        if (png.data[offset] !== png.data[4] || png.data[offset + 1] !== png.data[5] || png.data[offset + 2] !== png.data[6]) { varied = true; break; }
      }
      ensure(varied, 'Captured screenshot is visually blank: ' + file);
      fs.writeFileSync(path.join(screenshotDir, file), bytes);
    }
    async function click(selector) {
      return evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { ok:false, reason:'missing' }; el.click(); return { ok:true }; })()`);
    }
    async function keydown(key, shiftKey) {
      return evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, shiftKey: ${!!shiftKey}, bubbles: true, cancelable: true }))`);
    }

    await evaluate("localStorage.setItem('xj_onboarding_done', '1'); true");

    // === A: 22-route smoke ===
    for (const page of ALL_ROUTES) {
      try {
        await navigate(page);
        await waitForReady();
        const title = await evaluate('document.title');
        const textLen = await evaluate('document.body.innerText.length');
        const errors = await evaluate(`(() => {
          try { const root = document.documentElement; return { skin: root.getAttribute('data-skin'), dark: root.classList.contains('dark'), textLen: document.body.innerText.length }; }
          catch(e) { return { error: String(e) }; }
        })()`);
        result.routes.push({ page, title, text_length: textLen, loaded: true, ...errors });
      } catch (err) {
        result.routes.push({ page, loaded: false, error: String(err) });
      }
    }
    routesOk = result.routes.filter(r => r.loaded).length;
    routesFail = result.routes.filter(r => !r.loaded).length;
    console.log(`Route smoke: ${routesOk}/${ALL_ROUTES.length} ok, ${routesFail} failures`);

    // === B: New-client modal ===
    await navigate('index.html');
    await waitForReady();
    ensure((await click('.xj-new-client')).ok, 'New client control missing');
    let modal = { modal: false, focused: '' };
    for (let attempt = 0; attempt < 15; attempt++) {
      modal = await evaluate('({ modal: !!document.querySelector(".xj-overlay #cm-name"), focused: document.activeElement && document.activeElement.id })');
      if (modal.modal && modal.focused === 'cm-name') break;
      await delay(100);
    }
    result.flows.push({ flow: 'new-client-modal', ...modal, pass: modal.modal && modal.focused === 'cm-name' });
    ensure(modal.modal && modal.focused === 'cm-name', 'New client dialog did not open with focused name input');
    await click('#cm-cancel');

    // === C: Billing clear modal lifecycle (Tab/Escape/focus-return/failure) ===
    await navigate('billing-shell.html');
    await waitForReady();

    const billingOpened = await evaluate(`(async () => {
      const trigger = document.querySelector('button.danger-btn[onclick*="confirmClearData"]');
      if (!trigger) return { ok: false, reason: 'trigger-missing' };
      trigger.focus();
      trigger.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const overlay = document.getElementById('confirm-modal');
      return {
        ok: true,
        shown: !!(overlay && overlay.classList.contains('show')),
        focused: document.activeElement && document.activeElement.id,
        scrollLocked: document.body.classList.contains('xj-modal-open')
      };
    })()`);
    await screenshot('billing-clear-confirm.png');
    await keydown('Tab', true);
    const billingTrap = await evaluate(`document.activeElement && document.activeElement.id`);
    const billingCancelClick = await evaluate(`(() => {
      const cancel = document.getElementById('clear-cancel-btn');
      if (!cancel) return { ok: false };
      cancel.click();
      return { ok: true };
    })()`);
    ensure(billingCancelClick.ok, 'Billing clear cancel control missing');
    await delay(80);
    const billingCancelled = await evaluate(`(() => {
      const overlay = document.getElementById('confirm-modal');
      const trigger = document.querySelector('button.danger-btn[onclick*="confirmClearData"]');
      return { hidden: !!(overlay && !overlay.classList.contains('show')), focusReturned: document.activeElement === trigger, scrollUnlocked: !document.body.classList.contains('xj-modal-open') };
    })()`);
    await evaluate(`document.querySelector('button.danger-btn[onclick*="confirmClearData"]').click()`);
    await delay(80);
    await keydown('Escape', false);
    await delay(80);
    const billingEscaped = await evaluate(`(() => {
      const overlay = document.getElementById('confirm-modal');
      return { hidden: !!(overlay && !overlay.classList.contains('show')), scrollUnlocked: !document.body.classList.contains('xj-modal-open') };
    })()`);
    await evaluate(`(async () => {
      document.querySelector('button.danger-btn[onclick*="confirmClearData"]').click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const input = document.getElementById('clear-confirm-input');
      input.value = '确认清除';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      Store.clearBillingDataDurable = async function () { throw new Error('synthetic persistence failure'); };
      document.getElementById('clear-do-btn').click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return true;
    })()`);
    const billingFailure = await evaluate(`(() => {
      const overlay = document.getElementById('confirm-modal');
      const input = document.getElementById('clear-confirm-input');
      const error = document.getElementById('clear-error');
      return {
        shown: !!(overlay && overlay.classList.contains('show')),
        inputRetained: !!(input && input.value === '确认清除'),
        errorVisible: !!(error && error.style.display !== 'none' && error.textContent.trim()),
        controlsRestored: !document.getElementById('clear-do-btn').disabled && !document.getElementById('clear-cancel-btn').disabled,
        inputFocused: document.activeElement === input
      };
    })()`);
    const billingModalPass = billingOpened.shown && billingOpened.focused === 'clear-cancel-btn' && billingOpened.scrollLocked && billingTrap === 'clear-cancel-btn' && billingCancelled.hidden && billingCancelled.focusReturned && billingCancelled.scrollUnlocked && billingEscaped.hidden && billingEscaped.scrollUnlocked && billingFailure.shown && billingFailure.inputRetained && billingFailure.errorVisible && billingFailure.controlsRestored && billingFailure.inputFocused;
    result.flows.push({ flow: 'billing-clear-modal', opened: billingOpened, tab_trap_focus: billingTrap, cancelled: billingCancelled, escaped: billingEscaped, failure: billingFailure, pass: billingModalPass });
    ensure(billingModalPass, 'Billing clear modal lifecycle failed: ' + JSON.stringify(result.flows[result.flows.length - 1]));

    // === D: Quick record flow — hardened success/failure + mutation-sensitive checks ===
    // 每次子流程独立 navigate 到 index.html，避免覆盖式注入污染后续真实生产调用。
    const QR_TEXT = '验收合成会谈：来访者报告睡眠改善，情绪平稳，能正常履职。';

    async function qrPrepareClient() {
      return evaluate(`(() => {
        try {
          if (typeof Store === 'undefined' || typeof Store.getClients !== 'function') return { ok:false, reason:'store-unavailable' };
          let clients = Store.getClients() || [];
          if (clients.length === 0) {
            try { clients = [Store.createClient({ name:'验收合成来访者', code:'ACC-QR-001', status:'active' })]; }
            catch (e) { return { ok:false, reason:'create-client-failed:' + (e && e.message || e) }; }
          }
          const target = clients[0];
          if (typeof App !== 'undefined' && App.setActiveClientId) App.setActiveClientId(target.id);
          if (window.QuickRecord && typeof window.QuickRecord.reset === 'function') window.QuickRecord.reset();
          return { ok:true, clientId: target.id, clientCount: clients.length };
        } catch (e) { return { ok:false, reason:'prep-exception:' + (e && e.message || e) }; }
      })()`);
    }

    async function qrOpenOverlay() {
      return evaluate(`(async () => {
        const qrBtn = document.getElementById('qr-entry') || document.getElementById('quick-record-trigger') || document.querySelector('[data-action="quick-record"]') || document.querySelector('.qr-trigger');
        if (!qrBtn) return { ok:false, reason:'trigger-missing' };
        qrBtn.click();
        await new Promise(r => setTimeout(r, 200));
        const overlay = document.getElementById('qr-overlay') || document.querySelector('.qr-overlay, .qr-modal, #quick-record-modal');
        if (!overlay) return { ok:false, reason:'overlay-missing' };
        return { ok:true, overlayVisible: overlay.offsetParent !== null || getComputedStyle(overlay).display !== 'none' };
      })()`);
    }

    // --- D1: overlay opens with controls live ---
    await navigate('index.html');
    await waitForReady();
    const qrPrep = await qrPrepareClient();
    ensure(qrPrep.ok, 'Quick record prep failed: ' + (qrPrep.reason || 'unknown'));
    const qrOpen = await qrOpenOverlay();
    ensure(qrOpen.ok && qrOpen.overlayVisible, 'Quick record overlay did not open: ' + (qrOpen.reason || 'not visible'));
    result.flows.push({ flow: 'quick-record-open', ...qrOpen, pass: !!(qrOpen.ok && qrOpen.overlayVisible) });

    // --- D2: success flow (hardened) ---
    await navigate('index.html');
    await waitForReady();
    await qrPrepareClient();
    await qrOpenOverlay();
    const qrSuccess = await evaluate(`(async () => {
      try {
        // 安装生产真实调用钩子：捕获 createQuickRecord 返回值与成功 toast（包装，不替换实现）。
        window.__qr_last = null; window.__qr_toasts = [];
        const origCreate = window.QuickRecord.createQuickRecord.bind(window.QuickRecord);
        window.QuickRecord.createQuickRecord = async (input) => { const r = await origCreate(input); window.__qr_last = r; return r; };
        try {
          if (typeof App !== 'undefined' && App.showToast) {
            const origToast = App.showToast.bind(App);
            App.showToast = (msg, kind) => { window.__qr_toasts.push({ msg: String(msg || ''), kind: String(kind || '') }); return origToast(msg, kind); };
          } else if (typeof Store !== 'undefined' && Store.toast) {
            const origToast = Store.toast.bind(Store);
            Store.toast = (msg, kind) => { window.__qr_toasts.push({ msg: String(msg || ''), kind: String(kind || '') }); return origToast(msg, kind); };
          }
        } catch (e) { /* hooking unavailable; rely on DOM/.qr-success */ }
        const ta = document.getElementById('qr-notes');
        if (ta) ta.value = ${JSON.stringify(QR_TEXT)};
        const before = (Store.getSessions ? Store.getSessions() : []).length;
        const cid = (typeof App !== 'undefined' && App.getActiveClientId) ? App.getActiveClientId() : '';
        const submit = document.getElementById('qr-submit') || document.querySelector('.qr-save, button[data-action="save"], button.save-btn');
        if (!submit) return { ok:false, reason:'submit-missing' };
        submit.click();
        await new Promise(r => setTimeout(r, 400));
        const last = window.__qr_last;
        const resultEl = document.getElementById('qr-result');
        const successEl = resultEl ? resultEl.querySelector('.qr-success') : null;
        const followups = Array.prototype.slice.call(document.querySelectorAll('.qr-followup'));
        const persisted = (last && last.value) ? (Store.getSession ? Store.getSession(last.value.id) : null) : null;
        const sessions = Store.getSessions ? Store.getSessions() : [];
        return {
          ok:true,
          returnedOk: !!(last && last.ok),
          code: last && last.error ? last.error.code : '',
          returnedSessionId: last && last.value ? last.value.id : null,
          before: before,
          after: sessions.length,
          persistedClientId: persisted ? persisted.clientId : null,
          resultVisible: !!(resultEl && !resultEl.hidden),
          successVisible: !!(successEl && successEl.offsetParent !== null),
          successText: successEl ? successEl.textContent : '',
          followups: followups.map(b => ({ action:b.getAttribute('data-action'), client:b.getAttribute('data-client'), session:b.getAttribute('data-session'), disabled:b.disabled })),
          toasts: window.__qr_toasts,
          domToast: (() => { const t = document.querySelector('.toast-container, .toast, #toast, [data-toast]'); return !!(t && /已保存/.test(t.textContent || '')); })(),
          cid: cid,
        };
      } catch (e) { return { ok:false, reason:'exception:' + (e && e.message || e) }; }
    })()`);
    let qrSuccessPass = false, qrSuccessMsg = '';
    if (qrSuccess.ok) {
      try { assertSuccessHardened(qrSuccess); qrSuccessPass = true; }
      catch (e) { qrSuccessPass = false; qrSuccessMsg = e.message; }
    } else {
      qrSuccessMsg = qrSuccess.reason || 'harness-failed';
    }
    result.flows.push({ flow: 'quick-record-success', ...qrSuccess, pass: qrSuccessPass, detail: qrSuccessMsg });

    // --- D3: failure flow (hardened, injected durable failure) ---
    await navigate('index.html');
    await waitForReady();
    await qrPrepareClient();
    await qrOpenOverlay();
    const qrFailure = await evaluate(`(async () => {
      try {
        window.__qr_last = null; window.__qr_toasts = [];
        try {
          if (typeof App !== 'undefined' && App.showToast) {
            const origToast = App.showToast.bind(App);
            App.showToast = (msg, kind) => { window.__qr_toasts.push({ msg: String(msg || ''), kind: String(kind || '') }); return origToast(msg, kind); };
          } else if (typeof Store !== 'undefined' && Store.toast) {
            const origToast = Store.toast.bind(Store);
            Store.toast = (msg, kind) => { window.__qr_toasts.push({ msg: String(msg || ''), kind: String(kind || '') }); return origToast(msg, kind); };
          }
        } catch (e) { /* hooking unavailable */ }
        // 捕获真实 createQuickRecord 返回值（包装，不替换实现）。
        const origCreate = window.QuickRecord.createQuickRecord.bind(window.QuickRecord);
        window.QuickRecord.createQuickRecord = async (input) => { const r = await origCreate(input); window.__qr_last = r; return r; };
        // 注入真实 durable 失败：令 Store.createSessionDurable 抛出。
        const origDurable = Store.createSessionDurable.bind(Store);
        Store.createSessionDurable = async () => { throw new Error('injected durable failure (XJ_AGENT_ACCEPTANCE)'); };
        const ta = document.getElementById('qr-notes');
        if (ta) ta.value = '验收合成会谈：将触发 durable 失败。';
        const submit = document.getElementById('qr-submit') || document.querySelector('.qr-save, button[data-action="save"], button.save-btn');
        if (!submit) return { ok:false, reason:'submit-missing' };
        submit.click();
        await new Promise(r => setTimeout(r, 400));
        const last = window.__qr_last;
        const overlay = document.getElementById('qr-overlay');
        const resultEl = document.getElementById('qr-result');
        const errEl = resultEl ? resultEl.querySelector('.qr-error') : null;
        const draftHint = resultEl ? !!resultEl.querySelector('.qr-draft-hint') : false;
        const textarea = document.getElementById('qr-notes');
        const submitBtn = document.getElementById('qr-submit');
        const recovered = (window.QuickRecord && typeof window.QuickRecord.recoverDraft === 'function') ? window.QuickRecord.recoverDraft() : null;
        const d = {
          ok:true,
          returnedOk: !!(last && last.ok),
          code: last && last.error ? last.error.code : '',
          overlayVisible: !!(overlay && (overlay.offsetParent !== null || getComputedStyle(overlay).display !== 'none')),
          errorVisible: !!(errEl && errEl.offsetParent !== null),
          errorText: errEl ? errEl.textContent : '',
          draftHint: draftHint,
          notesRetained: textarea ? textarea.value.indexOf('durable 失败') >= 0 : false,
          recoveredDraft: recovered,
          submitDisabled: submitBtn ? submitBtn.disabled : true,
          successToast: (window.__qr_toasts || []).some(t => /已保存/.test(t.msg)),
        };
        Store.createSessionDurable = origDurable; // 还原
        return d;
      } catch (e) { return { ok:false, reason:'exception:' + (e && e.message || e) }; }
    })()`);
    let qrFailurePass = false, qrFailureMsg = '';
    if (qrFailure.ok) {
      try { assertFailureHardened(qrFailure); qrFailurePass = true; }
      catch (e) { qrFailurePass = false; qrFailureMsg = e.message; }
    } else {
      qrFailureMsg = qrFailure.reason || 'harness-failed';
    }
    result.flows.push({ flow: 'quick-record-failure', ...qrFailure, pass: qrFailurePass, detail: qrFailureMsg });
    await keydown('Escape', false);
    await delay(100);

    // --- D4: reverse mutation — success without durable persistence must be caught (RED) ---
    await navigate('index.html');
    await waitForReady();
    await qrPrepareClient();
    await qrOpenOverlay();
    const qrMutNoPersist = await evaluate(`(async () => {
      try {
        window.__qr_last = null;
        // 突变：返回 ok:true 但不调用 durable（不持久化；模拟移除 await / 替换 durable / 提前成功反馈）。
        const origCreate = window.QuickRecord.createQuickRecord.bind(window.QuickRecord);
        window.QuickRecord.createQuickRecord = async (input) => {
          const fake = { id: 'MUT-NOPERSIST-' + Date.now().toString(36), clientId: input.clientId, date: input.date, sessionNumber: 1, notes:'', status:'closed' };
          window.__qr_last = { ok:true, value: fake };
          return window.__qr_last;
        };
        const ta = document.getElementById('qr-notes');
        if (ta) ta.value = '突变：假成功不持久化';
        const submit = document.getElementById('qr-submit') || document.querySelector('.qr-save, button[data-action="save"], button.save-btn');
        if (!submit) return { ok:false, reason:'submit-missing' };
        submit.click();
        await new Promise(r => setTimeout(r, 400));
        const last = window.__qr_last;
        const resultEl = document.getElementById('qr-result');
        const successEl = resultEl ? resultEl.querySelector('.qr-success') : null;
        const followups = Array.prototype.slice.call(document.querySelectorAll('.qr-followup'));
        const persisted = (last && last.value) ? (Store.getSession ? Store.getSession(last.value.id) : null) : null;
        const sessions = Store.getSessions ? Store.getSessions() : [];
        return {
          ok:true,
          returnedOk: !!(last && last.ok),
          returnedSessionId: last && last.value ? last.value.id : null,
          before: 0,
          after: sessions.length,
          persistedClientId: persisted ? persisted.clientId : null,
          resultVisible: !!(resultEl && !resultEl.hidden),
          successVisible: !!(successEl && successEl.offsetParent !== null),
          successText: successEl ? successEl.textContent : '',
          followups: followups.map(b => ({ action:b.getAttribute('data-action'), client:b.getAttribute('data-client'), session:b.getAttribute('data-session'), disabled:b.disabled })),
          cid: (typeof App !== 'undefined' && App.getActiveClientId) ? App.getActiveClientId() : '',
        };
      } catch (e) { return { ok:false, reason:'exception:' + (e && e.message || e) }; }
    })()`);
    // 期望：断言应当 RED（捕获未持久化的假成功）。若 GREEN，说明断言不够敏感 -> 本流程 FAIL。
    let qrMutNoPersistPass = false, qrMutNoPersistMsg = '';
    if (qrMutNoPersist.ok) {
      try { assertSuccessHardened(qrMutNoPersist); qrMutNoPersistPass = false; qrMutNoPersistMsg = 'MUTANT NOT CAUGHT: assertion green on no-persist success (insensitive)'; }
      catch (e) { qrMutNoPersistPass = true; qrMutNoPersistMsg = 'mutant caught: ' + e.message; }
    } else {
      qrMutNoPersistPass = false; qrMutNoPersistMsg = 'harness-failed:' + (qrMutNoPersist.reason || '');
    }
    result.flows.push({ flow: 'quick-record-mutation-success-nopersist', ...qrMutNoPersist, pass: qrMutNoPersistPass, detail: qrMutNoPersistMsg, mutation: true });

    // --- D5: reverse mutation — swallowed failure (ok:false hidden) must be caught (RED) ---
    await navigate('index.html');
    await waitForReady();
    await qrPrepareClient();
    await qrOpenOverlay();
    const qrMutSwallow = await evaluate(`(async () => {
      try {
        window.__qr_last = null; window.__qr_toasts = [];
        try {
          if (typeof App !== 'undefined' && App.showToast) {
            const origToast = App.showToast.bind(App);
            App.showToast = (msg, kind) => { window.__qr_toasts.push({ msg: String(msg || ''), kind: String(kind || '') }); return origToast(msg, kind); };
          } else if (typeof Store !== 'undefined' && Store.toast) {
            const origToast = Store.toast.bind(Store);
            Store.toast = (msg, kind) => { window.__qr_toasts.push({ msg: String(msg || ''), kind: String(kind || '') }); return origToast(msg, kind); };
          }
        } catch (e) { /* hooking unavailable */ }
        // 突变：强制 durable 失败，但 createQuickRecord 吞掉错误并仍返回 ok:true（模拟吞掉 {ok:false} / 静默成功）。
        Store.createSessionDurable = async () => { throw new Error('injected durable failure (XJ_AGENT_ACCEPTANCE)'); };
        const origCreate = window.QuickRecord.createQuickRecord.bind(window.QuickRecord);
        window.QuickRecord.createQuickRecord = async (input) => {
          try { await Store.createSessionDurable(input); } catch (e) {}
          window.__qr_last = { ok:true, value: { id:'MUT-SWALLOW', clientId: input.clientId, date: input.date, sessionNumber: 1, status: 'closed' } };
          return window.__qr_last;
        };
        const ta = document.getElementById('qr-notes');
        if (ta) ta.value = '突变：吞掉 durable 失败';
        const submit = document.getElementById('qr-submit') || document.querySelector('.qr-save, button[data-action="save"], button.save-btn');
        if (!submit) return { ok:false, reason:'submit-missing' };
        submit.click();
        await new Promise(r => setTimeout(r, 400));
        const last = window.__qr_last;
        const overlay = document.getElementById('qr-overlay');
        const resultEl = document.getElementById('qr-result');
        const errEl = resultEl ? resultEl.querySelector('.qr-error') : null;
        const textarea = document.getElementById('qr-notes');
        const submitBtn = document.getElementById('qr-submit');
        const d = {
          ok:true,
          returnedOk: !!(last && last.ok),
          code: last && last.error ? last.error.code : '',
          overlayVisible: !!(overlay && (overlay.offsetParent !== null || getComputedStyle(overlay).display !== 'none')),
          errorVisible: !!(errEl && errEl.offsetParent !== null),
          errorText: errEl ? errEl.textContent : '',
          draftHint: resultEl ? !!resultEl.querySelector('.qr-draft-hint') : false,
          notesRetained: textarea ? textarea.value.indexOf('durable 失败') >= 0 : false,
          recoveredDraft: (window.QuickRecord && typeof window.QuickRecord.recoverDraft === 'function') ? window.QuickRecord.recoverDraft() : null,
          submitDisabled: submitBtn ? submitBtn.disabled : true,
          successToast: (window.__qr_toasts || []).some(t => /已保存/.test(t.msg)),
        };
        return d;
      } catch (e) { return { ok:false, reason:'exception:' + (e && e.message || e) }; }
    })()`);
    let qrMutSwallowPass = false, qrMutSwallowMsg = '';
    if (qrMutSwallow.ok) {
      try { assertFailureHardened(qrMutSwallow); qrMutSwallowPass = false; qrMutSwallowMsg = 'MUTANT NOT CAUGHT: assertion green on swallowed failure (insensitive)'; }
      catch (e) { qrMutSwallowPass = true; qrMutSwallowMsg = 'mutant caught: ' + e.message; }
    } else {
      qrMutSwallowPass = false; qrMutSwallowMsg = 'harness-failed:' + (qrMutSwallow.reason || '');
    }
    result.flows.push({ flow: 'quick-record-mutation-failure-swallowed', ...qrMutSwallow, pass: qrMutSwallowPass, detail: qrMutSwallowMsg, mutation: true });
    await keydown('Escape', false);
    await delay(100);

    // === E: Calendar delete modal lifecycle ===
    await navigate('session-calendar.html');
    await waitForReady();

    const deleteFixtures = await evaluate(`(() => {
      const client = Store.createClient({ name: '删除验收来访者', status: 'active' });
      const date = new Date().toISOString().slice(0, 10);
      const single = Store.createSession({ clientId: client.id, date, sessionNumber: 1, startTime: '09:00', endTime: '09:50', status: 'confirmed', billing: null });
      const series = Store.createSession({ clientId: client.id, date, sessionNumber: 2, startTime: '10:00', endTime: '10:50', status: 'confirmed', seriesId: 'series_acceptance', recurrence: 'weekly', billing: null });
      if (typeof SessionCal !== 'undefined' && SessionCal.render) SessionCal.render();
      return { singleId: single.id, seriesId: series.id };
    })()`);

    const singleOpened = await evaluate(`(async () => {
      if (typeof SessionCal === 'undefined' || !SessionCal.openDetail) return { ok: false, reason: 'no SessionCal' };
      SessionCal.openDetail(${JSON.stringify(deleteFixtures.singleId)});
      await new Promise((resolve) => setTimeout(resolve, 60));
      const trigger = document.querySelector('.sc-modal-overlay .danger');
      if (!trigger) return { ok: false, reason: 'no danger btn' };
      trigger.focus();
      trigger.click();
      for (let attempt = 0; attempt < 12; attempt += 1) {
        if (document.activeElement && document.activeElement.getAttribute('data-modal-cancel') !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return { ok: true, confirmShown: document.getElementById('confirm-modal').classList.contains('show'), focused: document.activeElement && document.activeElement.getAttribute('data-modal-cancel') !== null };
    })()`);
    await screenshot('calendar-single-delete-confirm.png');
    await keydown('Escape', false);
    await delay(80);
    const singleClosed = await evaluate(`(() => ({
      confirmHidden: !document.getElementById('confirm-modal').classList.contains('show'),
      focusReturned: !!(document.activeElement && document.activeElement.classList.contains('danger')),
      sessionPreserved: !!Store.getSession(${JSON.stringify(deleteFixtures.singleId)})
    }))()`);
    const singleDeletePass = singleOpened.ok && singleOpened.confirmShown && singleOpened.focused && singleClosed.confirmHidden && singleClosed.focusReturned && singleClosed.sessionPreserved;
    result.flows.push({ flow: 'calendar-single-delete-cancel', opened: singleOpened, closed: singleClosed, pass: singleDeletePass });
    ensure(singleDeletePass, 'Calendar single-delete modal lifecycle failed: ' + JSON.stringify(result.flows[result.flows.length - 1]));

    await evaluate(`document.querySelectorAll('.sc-modal-overlay').forEach((node) => node.remove())`);
    const seriesOpened = await evaluate(`(async () => {
      if (typeof SessionCal === 'undefined' || !SessionCal.openDetail) return { ok: false, reason: 'no SessionCal' };
      SessionCal.openDetail(${JSON.stringify(deleteFixtures.seriesId)});
      await new Promise((resolve) => setTimeout(resolve, 60));
      const trigger = document.querySelector('.sc-modal-overlay .danger');
      if (!trigger) return { ok: false, reason: 'no danger btn' };
      trigger.focus();
      trigger.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { ok: true, dialogPresent: !!document.getElementById('series-delete-cancel'), focused: document.activeElement && document.activeElement.id };
    })()`);
    await screenshot('calendar-series-delete-scope.png');
    await keydown('Escape', false);
    await delay(80);
    const seriesClosed = await evaluate(`(() => ({
      transientRemoved: !document.getElementById('series-delete-cancel'),
      detailRemains: document.querySelectorAll('.sc-modal-overlay').length === 1,
      focusReturned: !!(document.activeElement && document.activeElement.classList.contains('danger')),
      sessionPreserved: !!Store.getSession(${JSON.stringify(deleteFixtures.seriesId)})
    }))()`);
    const seriesDeletePass = seriesOpened.ok && seriesOpened.dialogPresent && seriesOpened.focused === 'series-delete-cancel' && seriesClosed.transientRemoved && seriesClosed.detailRemains && seriesClosed.focusReturned && seriesClosed.sessionPreserved;
    result.flows.push({ flow: 'calendar-series-delete-escape', opened: seriesOpened, closed: seriesClosed, pass: seriesDeletePass });
    ensure(seriesDeletePass, 'Calendar series-delete modal lifecycle failed: ' + JSON.stringify(result.flows[result.flows.length - 1]));

    // === F: 18-cell visual matrix (3 viewports × 3 skins × 2 modes, reduced motion) ===
    const viewports = [[1024, 700], [1366, 768], [1920, 1080]];
    const skins = ['clinical', 'theatre', 'observatory'];
    const modes = ['light', 'dark'];
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    for (const [width, height] of viewports) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      for (const skin of skins) {
        for (const mode of modes) {
          await navigate('index.html');
          await waitForReady();
          const state = await evaluate(`(() => {
            localStorage.setItem('xj_skin', '${skin}');
            localStorage.setItem('xj_theme', '${mode}');
            document.documentElement.setAttribute('data-skin', '${skin}');
            document.documentElement.classList.toggle('dark', '${mode}' === 'dark');
            const root = document.documentElement;
            const overflow = root.scrollWidth > window.innerWidth + 1 || root.scrollHeight < window.innerHeight;
            const banner = document.getElementById('xj-banner');
            const firstContent = document.querySelector('.topbar, .main-header, .page > :first-child');
            const bannerHeight = banner ? Math.ceil(banner.getBoundingClientRect().height) : 0;
            const contentTop = firstContent ? Math.floor(firstContent.getBoundingClientRect().top) : 0;
            const coveredByBanner = !!(banner && firstContent && contentTop < bannerHeight);
            const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
            const computed = getComputedStyle(root);
            return { width: window.innerWidth, height: window.innerHeight, skin: root.getAttribute('data-skin'), dark: root.classList.contains('dark'), overflow, bannerHeight, contentTop, coveredByBanner, reduced, text: document.body.innerText.length, canvas: computed.getPropertyValue('--xj-canvas').trim().toLowerCase(), accent: computed.getPropertyValue('--xj-accent').trim().toLowerCase() };
          })()`);
          const name = `${width}x${height}-${skin}-${mode}.png`;
          await screenshot(name);
          const expectedTokens = {
            'clinical-light': ['#eef3f1', '#147d70'], 'clinical-dark': ['#151c1a', '#50b5a5'],
            'theatre-light': ['#eceae6', '#7a3945'], 'theatre-dark': ['#1a1614', '#c96b78'],
            'observatory-light': ['#f1f5f7', '#1f6166'], 'observatory-dark': ['#111719', '#68bac1']
          }[skin + '-' + mode];
          const pass = state.width === width && state.height === height && state.skin === skin && state.dark === (mode === 'dark') && !state.overflow && !state.coveredByBanner && state.reduced && state.text > 100 && state.canvas === expectedTokens[0] && state.accent === expectedTokens[1];
          result.matrix.push({ viewport: `${width}x${height}`, skin, mode, screenshot: name, ...state, pass });
          ensure(pass, 'Visual matrix failure: ' + name + ' ' + JSON.stringify(state));
        }
      }
      const fingerprints = result.matrix.filter((cell) => cell.viewport === `${width}x${height}`).map((cell) => cell.canvas + '|' + cell.accent);
      ensure(new Set(fingerprints).size === 6, 'Token maps are not unique at ' + width + 'x' + height + ': ' + JSON.stringify(fingerprints));
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    result.secure_runtime = { status: 'PASS', detail: 'real Electron flow executed 22 routes, modals, hardened quick-record success/failure + mutation-sensitive checks, and 18-cell visual matrix' };
  } finally {
    if (cdp) {
      try { await cdp.send('Browser.close'); } catch (_) {}
      cdp.close();
    }
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 30000);
      launcher.once('close', (code) => { clearTimeout(timer); resolve(code); });
    });
    await delay(300);
    const afterTemp = new Set(fs.readdirSync(require('os').tmpdir()).filter((name) => name.startsWith('xinjing-agent-acceptance-')));
    const createdTemp = [...afterTemp].filter((name) => !beforeTemp.has(name));
    result.cleanup = { launcher_exit_code: exitCode, leftover_temp_directories: createdTemp, pass: exitCode === 0 && createdTemp.length === 0, launcher_output: launcherOutput.trim() };
  }

  } catch (secureErr) {
    result.secure_runtime = { status: 'BLOCKED', reason: String((secureErr && secureErr.message) || secureErr), note: 'secure Electron runtime failed; --no-sandbox fallback was NOT used; evidence downgraded to BLOCKED' };
  }

  // === G: Self-test ===
  try {
    const selfTest = childProcess.spawnSync('node', [path.join(root, 'scripts', 'self-test.js')], { cwd: root, timeout: 30000, encoding: 'utf8' });
    result.self_test = { exit_code: selfTest.status, signal: selfTest.signal, stdout: selfTest.stdout.slice(-2000), stderr: selfTest.stderr.slice(-500), pass: selfTest.status === 0 };
  } catch (err) {
    result.self_test = { error: String(err), pass: false };
  }

  // === H: Git diff --check ===
  try {
    const gitDiff = childProcess.spawnSync('git', ['diff', '--check'], { cwd: root, timeout: 15000, encoding: 'utf8' });
    result.git_diff_check = { exit_code: gitDiff.status, stdout: gitDiff.stdout.trim(), stderr: gitDiff.stderr.trim(), pass: gitDiff.status === 0 };
  } catch (err) {
    result.git_diff_check = { error: String(err), pass: false };
  }

  // === Scoring ===
  const matrixScore = (result.matrix.filter(cell => cell.pass).length / Math.max(1, result.matrix.length)) * 30;
  const routesScore = (result.routes.filter(r => r.loaded).length / Math.max(1, result.routes.length)) * 20;
  const flowsScore = (result.flows.filter(f => f.pass).length / Math.max(1, result.flows.length)) * 20;
  const consoleScore = result.console_errors.length === 0 ? 10 : (result.console_errors.length <= 3 ? 5 : 0);
  const sourceScore = result.served_source && result.served_source.pass ? 5 : 0;
  const selfTestScore = result.self_test && result.self_test.pass ? 5 : 0;
  const gitDiffScore = result.git_diff_check && result.git_diff_check.pass ? 5 : 0;
  const cleanupScore = result.cleanup && result.cleanup.pass ? 5 : 0;
  result.score = Math.round(matrixScore + routesScore + flowsScore + consoleScore + sourceScore + selfTestScore + gitDiffScore + cleanupScore);
  result.scoring = { matrix: matrixScore, routes: routesScore, flows: flowsScore, console: consoleScore, source: sourceScore, selfTest: selfTestScore, gitDiff: gitDiffScore, cleanup: cleanupScore, total: result.score };

  // Determine issues
  result.issues = [];
  for (const cell of result.matrix) { if (!cell.pass) result.issues.push({ severity: 'P2', source: 'visual-matrix', detail: cell.viewport + '-' + cell.skin + '-' + cell.mode + ' ' + cell.screenshot }); }
  for (const route of result.routes) { if (!route.loaded) result.issues.push({ severity: 'P1', source: 'route-smoke', detail: route.page + ' ' + (route.error || '') }); }
  for (const flow of result.flows) { if (!flow.pass) result.issues.push({ severity: 'P2', source: 'flow', detail: flow.flow }); }
  for (const err of result.console_errors) result.issues.push({ severity: 'P2', source: 'console-error', detail: err.text }); 
  if (result.cleanup && !result.cleanup.pass) result.issues.push({ severity: 'P0', source: 'cleanup', detail: 'leftover temp dirs: ' + JSON.stringify(result.cleanup.leftover_temp_directories) + ' exit: ' + result.cleanup.launcher_exit_code });
  if (result.self_test && !result.self_test.pass) result.issues.push({ severity: 'P1', source: 'self-test', detail: 'exit: ' + result.self_test.exit_code });
  if (result.git_diff_check && !result.git_diff_check.pass) result.issues.push({ severity: 'P1', source: 'git-diff-check', detail: result.git_diff_check.stdout });

  // Write evidence
  fs.writeFileSync(path.join(evidenceDir, 'semantic-acceptance.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(evidenceDir, 'console-log.json'), JSON.stringify({ console_errors: result.console_errors, network_denials: result.network_denials }, null, 2));
  fs.writeFileSync(path.join(evidenceDir, 'evidence-manifest.json'), JSON.stringify({
    task_id: result.task_id,
    candidate_sha256: result.candidate_sha256,
    timestamp: result.timestamp,
    matrix_cells: result.matrix.length,
    matrix_pass: result.matrix.filter(c => c.pass).length,
    routes: result.routes.length,
    routes_pass: result.routes.filter(r => r.loaded).length,
    flows: result.flows.length,
    flows_pass: result.flows.filter(f => f.pass).length,
    console_errors: result.console_errors.length,
    score: result.score,
    issues: result.issues.filter(i => i.severity === 'P0' || i.severity === 'P1').length,
  }, null, 2));

  // Summary
  const failedRoutes = result.routes.filter(r => !r.loaded).length;
  const failedMatrix = result.matrix.filter(c => !c.pass).length;
  const failedFlows = result.flows.filter(f => !f.pass).length;
  console.log(`XJ-4.2.2 Semantic acceptance: ${result.matrix.length}/18 matrix, ${routesOk}/${ALL_ROUTES.length} routes, ${result.flows.length} flows, score=${result.score}/100, issues=${result.issues.length}`);

  // Write delivery report
  const report = [
    '# XJ-4.2.2 Marvis Runtime Acceptance Report',
    '',
    '| Field | Value |',
    '|-------|-------|',
    '| Task ID | XJ-4.2.2-marvis-runtime-acceptance |',
    '| Base Commit | 6910e90bcc2206658a3c66f6c203216b70089001 |',
    '| Candidate SHA | ' + result.candidate_sha256 + ' |',
    '| Timestamp | ' + result.timestamp + ' |',
    '| Score | **' + result.score + '/100** |',
    '| Matrix | ' + result.matrix.filter(c => c.pass).length + '/' + result.matrix.length + ' cells pass |',
    '| Routes | ' + routesOk + '/' + ALL_ROUTES.length + ' routes pass |',
    '| Flows | ' + result.flows.filter(f => f.pass).length + '/' + result.flows.length + ' flows pass |',
    '| Console Errors | ' + result.console_errors.length + ' |',
    '| Network Denials | ' + result.network_denials.length + ' |',
    '| Served Source | ' + (result.served_source && result.served_source.pass ? 'PASS' : 'FAIL') + ' |',
    '| Self Test | ' + (result.self_test && result.self_test.pass ? 'PASS' : 'FAIL') + ' (exit ' + (result.self_test ? result.self_test.exit_code : 'N/A') + ') |',
    '| Git Diff Check | ' + (result.git_diff_check && result.git_diff_check.pass ? 'PASS' : 'FAIL') + ' |',
    '| Cleanup | ' + (result.cleanup && result.cleanup.pass ? 'PASS' : 'FAIL') + ' |',
    '',
    '## Scoring Breakdown',
    '',
    '| Category | Score | Max |',
    '|----------|-------|-----|',
  ];
  report.push('| Visual Matrix | ' + matrixScore.toFixed(1) + ' | 30 |');
  report.push('| Route Smoke | ' + routesScore.toFixed(1) + ' | 20 |');
  report.push('| Flows | ' + flowsScore.toFixed(1) + ' | 20 |');
  report.push('| Console | ' + consoleScore + ' | 10 |');
  report.push('| Source Match | ' + sourceScore + ' | 5 |');
  report.push('| Self Test | ' + selfTestScore + ' | 5 |');
  report.push('| Git Diff | ' + gitDiffScore + ' | 5 |');
  report.push('| Cleanup | ' + cleanupScore + ' | 5 |');

  if (result.issues.length > 0) {
    report.push('');
    report.push('## Issues (' + result.issues.length + ')');
    report.push('');
    report.push('| Severity | Source | Detail |');
    report.push('|----------|--------|--------|');
    for (const issue of result.issues) {
      report.push('| ' + issue.severity + ' | ' + issue.source + ' | ' + issue.detail.replace(/\|/g, '\\|') + ' |');
    }
  }

  // === QA hardening evidence (separate acceptance-script SHA from candidate SHA) ===
  const qrFlows = (result.flows || []).filter((f) => /^quick-record/.test(f.flow));
  report.push('');
  report.push('## QA Hardening: QuickRecord Assertion Hardening (v2)');
  report.push('');
  report.push('- Acceptance script SHA: `' + acceptanceScriptSha + '`');
  report.push('- Base acceptance script SHA (frozen): `' + baseAcceptanceScriptSha + '`');
  report.push('- Candidate (25-file) SHA: `' + actualCandidate + '`');
  report.push('- Secure runtime evidence: **' + (result.secure_runtime ? result.secure_runtime.status : 'UNKNOWN') + '**' + (result.secure_runtime && result.secure_runtime.reason ? (' — ' + result.secure_runtime.reason) : '') + (result.secure_runtime && result.secure_runtime.detail ? (' — ' + result.secure_runtime.detail) : ''));
  report.push('');
  report.push('### QuickRecord flows');
  report.push('');
  for (const f of qrFlows) {
    report.push('- `' + f.flow + '`: **' + (f.pass ? 'PASS' : 'FAIL') + '**' + (f.mutation ? ' [reverse-mutation]' : '') + (f.detail ? ' — ' + f.detail : ''));
  }
  report.push('');
  report.push('Hardened success assertions (all required): `ok:true`; a newly persisted synthetic session in Store; `clientId` match; visible saved state (`qr-result`/`.qr-success` + 已保存 toast); all four follow-ups with `client`/`session` context; enabled.');
  report.push('Hardened failure assertions (all required): real durable error code; visible error (`.qr-error` 保存失败); draft recovery hint; modal remains open; input retained; `recoverDraft`; submit re-enabled; NO false success toast.');
  report.push('Mutation sensitivity: nopersist-success and swallowed-failure mutants MUST turn the assertions RED; if GREEN, the flow FAILs (insensitive).');
  report.push('');
  report.push('## Evidence');
  report.push('');
  report.push('- Evidence dir: `qa/acceptance/XJ-4.2.2-marvis/`');
  report.push('- Screenshots: `qa/acceptance/XJ-4.2.2-marvis/screenshots/`');
  report.push('- Full results: `qa/acceptance/XJ-4.2.2-marvis/semantic-acceptance.json`');

  const reportPath = path.join(root, 'qa', 'agent-reviews', 'XJ-4.2.2-marvis-runtime-acceptance.md');
  fs.writeFileSync(reportPath, report.join('\n'));

  process.exitCode = result.score >= 95 ? 0 : 1;
}

main().catch((error) => {
  console.error('SEMANTIC_ACCEPTANCE_FAIL:', error && error.stack || error);
  process.exitCode = 1;
});
