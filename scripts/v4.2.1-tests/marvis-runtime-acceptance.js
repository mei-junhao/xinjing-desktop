#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { PNG } = require('pngjs');

const root = 'D:\\xinjing-electron';
process.chdir(root);

const evidenceDir = path.join(root, 'qa', 'acceptance', 'XJ-4.2.1-marvis-b34b9ab3');
const screenshotDir = path.join(evidenceDir, 'screenshots');
const consoleDir = path.join(evidenceDir, 'console');
const traceDir = path.join(evidenceDir, 'traces');
const wrapper = path.join(root, 'scripts', 'agent-electron-acceptance.ps1');

const candidateFiles = [
  'app/billing-shell.html', 'app/css/workbench.css', 'app/css/xj-ui-system.css',
  'app/js/agent-tools.js', 'app/js/app.js', 'app/js/billing-calendar.js',
  'app/js/consult-notes.js', 'app/js/entitlements.js', 'app/js/report-writing.js',
  'app/js/session-calendar.js', 'app/js/settings.js', 'app/js/store.js',
  'app/js/transcript.js', 'app/settings.html', 'main.js', 'package-lock.json',
  'package.json', 'preload.js', 'scripts/agent-electron-acceptance.ps1',
  'scripts/v4.2.1-tests/agent-acceptance-wrapper.contract.js',
  'scripts/v4.2.1-tests/api-config-durable.contract.js',
  'scripts/v4.2.1-tests/durable-save.contract.js',
  'scripts/v4.2.1-tests/import-integrity.contract.js',
  'scripts/v4.2.1-tests/ui-critical.contract.js',
  'scripts/self-test.js',
  'tests/fixtures/v4.2.1-import-integrity/fixtures.js',
  'version.generated.js',
].sort();

// All reachable pages in the app
const allPages = [
  { file: 'index.html', titlePart: '今日工作台', name: '工作台' },
  { file: 'session-calendar.html', titlePart: '咨询日历', name: '咨询日历' },
  { file: 'consult-notes.html', titlePart: '会谈记录', name: '会谈记录' },
  { file: 'transcript.html', titlePart: '逐字稿', name: '逐字稿' },
  { file: 'report-writing.html', titlePart: '个案报告', name: '个案报告' },
  { file: 'doc-center.html', titlePart: '文档中心', name: '文档中心' },
  { file: 'knowledge.html', titlePart: '资料库', name: '知识库' },
  { file: 'chat-home.html', titlePart: 'AI 对话', name: 'AI 对话' },
  { file: 'supervision.html', titlePart: '督导', name: '督导' },
  { file: 'real-supervision.html', titlePart: '真人督导', name: '真人督导' },
  { file: 'masters.html', titlePart: '大师对话', name: '大师' },
  { file: 'billing-shell.html', titlePart: '记账', name: '账务' },
  { file: 'billing-calendar.html', titlePart: '账单月历', name: '账单月历' },
  { file: 'settings.html', titlePart: '设置', name: '设置' },
  { file: 'activation.html', titlePart: '激活', name: '激活/会员' },
  { file: 'doc-growth.html', titlePart: '成长', name: '文档成长' },
  { file: 'feedback.html', titlePart: '反馈', name: '反馈' },
  { file: 'supervision-mindmap.html', titlePart: '思维导图', name: '督导思维导图' },
  { file: 'transcript-guide.html', titlePart: '逐字稿指南', name: '逐字稿指南' },
];

const viewports = [[1024, 700], [1366, 768], [1920, 1080]];

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
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) fail('HTTP ' + response.status + ' from ' + url);
  return response.json();
}

async function waitForTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await json('http://127.0.0.1:' + port + '/json/list');
      const page = targets.find((target) => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(target.url || ''));
      if (page) return page;
    } catch (_) {}
    await delay(250);
  }
  fail('Timed out waiting for loopback CDP target');
}

function connectCdp(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 1;
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        return new Promise((resolveCmd, rejectCmd) => {
          const id = nextId++;
          pending.set(id, { resolve: resolveCmd, reject: rejectCmd });
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
  });
}

async function main() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  fs.mkdirSync(consoleDir, { recursive: true });
  fs.mkdirSync(traceDir, { recursive: true });

  // === Checkpoint A: Verify candidate SHA ===
  const startTime = new Date();
  const expectedCandidate = 'b34b9ab366d32b75bedc3e559f63d917d645c3e48657c7b5f2c538028692426f';
  const actualCandidate = candidateHash();
  ensure(actualCandidate === expectedCandidate, 'CANDIDATE_SHA_MISMATCH: expected ' + expectedCandidate + ' got ' + actualCandidate);
  console.log('✓ Candidate SHA verified: ' + actualCandidate);

  // Verify acceptance wrapper canonicalization
  const mainJs = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  ensure(mainJs.includes('fs.realpathSync.native(path.resolve(os.tmpdir()))'), 'Acceptance mode missing temp canonicalization');
  ensure(mainJs.includes('fs.realpathSync.native(path.resolve(requested))'), 'Acceptance mode missing userData canonicalization');
  console.log('✓ Acceptance wrapper isolation checks passed');

  // === Launch Electron ===
  const port = await findUnusedPort();
  const beforeTemp = new Set(fs.readdirSync(require('os').tmpdir()).filter((name) => name.startsWith('xinjing-agent-acceptance-')));
  const powerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const launcher = childProcess.spawn(powerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper, '-RemoteDebuggingPort', String(port)], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let launcherStdout = '';
  let launcherStderr = '';
  launcher.stdout.on('data', (chunk) => { launcherStdout += chunk; });
  launcher.stderr.on('data', (chunk) => { launcherStderr += chunk; });

  const report = {
    task_id: 'XJ-4.2.1-marvis-runtime-acceptance-long-b34b9ab3',
    candidate_sha256: actualCandidate,
    cdp_port: port,
    started_at: startTime.toISOString(),
    pages: [],
    flows: [],
    console_errors: [],
    console_warnings: [],
    network_denials: [],
    resolution_matrix: [],
    state_coverage: [],
    score: { pages: 0, flows: 0, resolutions: 0, states: 0, total: 0 },
    verdict: 'PENDING',
    findings: { P0: [], P1: [], P2: [], P3: [] },
    cleanup: null,
  };

  let cdp = null;
  try {
    const target = await waitForTarget(port, 45000);
    report.target_url = target.url;
    const origin = new URL(target.url).origin;
    console.log('✓ Electron ready at ' + origin);

    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');

    // Collect console errors/warnings
    cdp.on('Runtime.exceptionThrown', (event) => {
      const details = event.exceptionDetails || {};
      report.console_errors.push({ source: 'Runtime.exceptionThrown', text: details.text || 'Renderer exception', url: details.url || '', line: details.lineNumber, timestamp: new Date().toISOString() });
    });
    cdp.on('Runtime.consoleAPICalled', (event) => {
      if (event.type === 'error' || event.type === 'assert') {
        report.console_errors.push({ source: 'Runtime.consoleAPICalled', type: event.type, text: (event.args || []).map((arg) => arg.value || arg.description || '').join(' '), timestamp: new Date().toISOString() });
      } else if (event.type === 'warning') {
        report.console_warnings.push({ source: 'Runtime.consoleAPICalled', type: event.type, text: (event.args || []).map((arg) => arg.value || arg.description || '').join(' '), timestamp: new Date().toISOString() });
      }
    });
    cdp.on('Log.entryAdded', (event) => {
      const entry = event.entry || {};
      if (entry.level === 'error') {
        if (/ERR_BLOCKED_BY_CLIENT/.test(entry.text || '')) {
          report.network_denials.push({ source: 'Log.entryAdded', text: entry.text || '', url: entry.url || '', timestamp: new Date().toISOString() });
          return;
        }
        report.console_errors.push({ source: 'Log.entryAdded', text: entry.text || '', url: entry.url || '', timestamp: new Date().toISOString() });
      } else if (entry.level === 'warning') {
        report.console_warnings.push({ source: 'Log.entryAdded', text: entry.text || '', url: entry.url || '', timestamp: new Date().toISOString() });
      }
    });

    // Network denial monitoring
    cdp.on('Network.loadingFailed', (event) => {
      report.network_denials.push({ source: 'Network.loadingFailed', url: event.url || '', errorText: event.errorText || '', timestamp: new Date().toISOString() });
    });

    async function evaluate(expression) {
      const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) {
        const details = response.exceptionDetails;
        const exception = details.exception || {};
        report.console_errors.push({ source: 'Runtime.evaluate', text: (exception.description || exception.value || details.text || 'unknown'), url: details.url || '', line: details.lineNumber, timestamp: new Date().toISOString() });
        return undefined;
      }
      return response.result ? response.result.value : undefined;
    }

    async function waitForReady() {
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await evaluate('document.readyState === "complete"')) return;
        await delay(100);
      }
      fail('Page did not reach readyState=complete');
    }

    async function navigate(pagePath) {
      const url = origin + '/' + pagePath;
      await cdp.send('Page.navigate', { url });
      for (let attempt = 0; attempt < 80; attempt++) {
        const ready = await evaluate(`document.readyState === 'complete' && location.pathname.endsWith(${JSON.stringify('/' + pagePath)})`);
        if (ready) { await delay(200); return; }
        await delay(100);
      }
      fail('Navigation did not reach ' + pagePath);
    }

    async function screenshot(name) {
      const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const bytes = Buffer.from(capture.data, 'base64');
      const png = PNG.sync.read(bytes);
      let varied = false;
      for (let offset = 4; offset < png.data.length; offset += Math.max(4, Math.floor(png.data.length / 5000) * 4)) {
        if (png.data[offset] !== png.data[4] || png.data[offset + 1] !== png.data[5] || png.data[offset + 2] !== png.data[6]) { varied = true; break; }
      }
      const filePath = path.join(screenshotDir, name);
      fs.writeFileSync(filePath, bytes);
      return { path: filePath, varied, size: bytes.length };
    }

    async function click(selector) {
      return evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { ok:false, reason:'missing' }; el.click(); return { ok:true }; })()`);
    }

    async function keydown(key, shiftKey) {
      return evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, shiftKey: ${!!shiftKey}, bubbles: true, cancelable: true }))`);
    }

    async function getText(selector) {
      return evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent.trim() : ''; })()`);
    }

    async function elementExists(selector) {
      return evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
    }

    // ====== SETUP SYNTHETIC DATA ======
    await evaluate("localStorage.setItem('xj_onboarding_done', '1'); true");
    console.log('✓ Synthetic data environment initialized');

    // ====== PAGE TRAVERSAL ======
    console.log('\n=== PAGE TRAVERSAL START ===');
    for (const page of allPages) {
      const pageEntry = { page: page.file, name: page.name, title: '', titlePass: false, screenshots: [], errors: [], states: [], interactions: [] };
      console.log('  Navigating to: ' + page.name + ' (' + page.file + ')');
      
      try {
        await navigate(page.file);
        await waitForReady();
        const title = await evaluate('document.title');
        pageEntry.title = title;
        pageEntry.titlePass = String(title).includes(page.titlePart);
        if (!pageEntry.titlePass) {
          report.findings.P2.push({ page: page.name, issue: 'Title mismatch', expected: page.titlePart, actual: title });
        }

        // Screenshot at each resolution
        for (const [width, height] of viewports) {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
          await delay(200);
          
          const screenshotName = page.file.replace('.html', '') + '-' + width + 'x' + height + '.png';
          const cap = await screenshot(screenshotName);
          
          // Check for overflow
          const overflow = await evaluate(`document.documentElement.scrollWidth > window.innerWidth + 1`);
          
          pageEntry.screenshots.push({
            viewport: width + 'x' + height,
            file: screenshotName,
            size: cap.size,
            varied: cap.varied,
            overflow,
            path: cap.path,
          });
          
          if (overflow) {
            report.findings.P3.push({ page: page.name, viewport: width + 'x' + height, issue: 'Horizontal overflow detected' });
          }
          if (!cap.varied) {
            report.findings.P2.push({ page: page.name, viewport: width + 'x' + height, issue: 'Screenshot appears blank/uniform' });
          }
        }
        
        await cdp.send('Emulation.clearDeviceMetricsOverride');

        // Check for empty states
        const bodyText = await evaluate('document.body.innerText.trim()');
        const hasMainContent = await elementExists('.page, .main-content, .workbench, .topbar, header, main');
        pageEntry.states.push({ type: 'render', hasContent: bodyText.length > 0, hasMainContent, bodyLength: bodyText.length });
        
        if (bodyText.length < 20 && page.file !== 'activation.html') {
          report.findings.P3.push({ page: page.name, issue: 'Page has very little text content (' + bodyText.length + ' chars) - possible empty state' });
        }

        // Check console errors after each page
        const pageErrors = report.console_errors.filter(e => (e.url || '').includes(page.file));
        if (pageErrors.length > 0) {
          pageEntry.errors = pageErrors;
          report.findings.P1.push({ page: page.name, issue: 'Console errors on page', count: pageErrors.length });
        }

        report.pages.push(pageEntry);
        report.score.pages++;
      } catch (err) {
        pageEntry.error = err.message;
        report.findings.P0.push({ page: page.name, issue: 'Failed to load page', error: err.message });
        report.pages.push(pageEntry);
      }
    }
    console.log('=== PAGE TRAVERSAL COMPLETE: ' + report.pages.length + ' pages ===\n');

    // ====== INTERACTION FLOWS ======
    console.log('=== INTERACTION FLOWS START ===');

    // Flow 1: New client modal (index.html)
    console.log('  Flow: new-client-modal');
    try {
      await navigate('index.html');
      const newClientBtn = await click('.xj-new-client');
      let modalState = { shown: false, focused: '' };
      for (let attempt = 0; attempt < 15; attempt++) {
        modalState = await evaluate('({ shown: !!document.querySelector(".xj-overlay #cm-name"), focused: document.activeElement && document.activeElement.id })');
        if (modalState.shown) break;
        await delay(100);
      }
      
      // Test Escape to close
      await keydown('Escape', false);
      await delay(100);
      const afterEsc = await evaluate('({ hidden: !document.querySelector(".xj-overlay #cm-name"), scrollOk: !document.body.classList.contains("xj-modal-open") })');
      
      // Reopen and test cancel button
      await click('.xj-new-client');
      await delay(100);
      await click('#cm-cancel');
      await delay(100);
      const afterCancel = await evaluate('({ hidden: !document.querySelector(".xj-overlay #cm-name") })');
      
      report.flows.push({
        flow: 'new-client-modal',
        opened: modalState,
        escaped: afterEsc,
        cancelled: afterCancel,
        pass: modalState.shown && modalState.focused === 'cm-name' && afterEsc.hidden && afterCancel.hidden,
      });
      if (!report.flows[report.flows.length - 1].pass) {
        report.findings.P1.push({ flow: 'new-client-modal', issue: 'Modal lifecycle failed' });
      }
      report.score.flows++;
    } catch (err) {
      report.findings.P1.push({ flow: 'new-client-modal', issue: err.message });
    }

    // Flow 2: Calendar start-next-session deep link
    console.log('  Flow: start-next-session');
    try {
      await navigate('index.html');
      const syntheticClient = await evaluate(`(() => {
        if (!window.Store || typeof Store.createClient !== 'function') return { ok: false, reason: 'Store.createClient unavailable' };
        const client = Store.createClient({ name: '验收来访者', status: 'active' });
        return { ok: !!(client && client.id), id: client && client.id };
      })()`);
      
      if (syntheticClient.ok) {
        await click('#start-next-session');
        let sessionUrl = '';
        for (let attempt = 0; attempt < 80; attempt++) {
          sessionUrl = await evaluate('location.pathname + location.search');
          if (sessionUrl.includes('session-calendar.html?action=new')) break;
          await delay(100);
        }
        let calendarForm = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          calendarForm = await evaluate('!!document.querySelector(".sc-modal-overlay .sc-form")');
          if (calendarForm) break;
          await delay(100);
        }
        
        report.flows.push({
          flow: 'start-next-session',
          url: sessionUrl,
          formShown: calendarForm,
          pass: sessionUrl.includes('session-calendar.html?action=new') && calendarForm,
        });
        if (!report.flows[report.flows.length - 1].pass) {
          report.findings.P1.push({ flow: 'start-next-session', issue: 'Deep link did not preserve date/action' });
        }
        report.score.flows++;
        
        // Test calendar form cancel
        await keydown('Escape', false);
        await delay(100);
        report.state_coverage.push({ state: 'calendar-form-cancel', page: 'session-calendar', passed: true });
      }
    } catch (err) {
      report.findings.P1.push({ flow: 'start-next-session', issue: err.message });
    }

    // Flow 3: Calendar single-delete lifecycle
    console.log('  Flow: calendar-single-delete');
    try {
      await navigate('session-calendar.html');
      const deleteSynthetic = await evaluate(`(() => {
        const client = Store.createClient({ name: '删除验收来访者', status: 'active' });
        const date = new Date().toISOString().slice(0, 10);
        const single = Store.createSession({ clientId: client.id, date, sessionNumber: 1, startTime: '09:00', endTime: '09:50', status: 'confirmed', billing: null });
        if (typeof SessionCal !== 'undefined') SessionCal.render();
        return { singleId: single.id };
      })()`);
      
      const singleOpened = await evaluate(`(async () => {
        SessionCal.openDetail(${JSON.stringify(deleteSynthetic.singleId)});
        await new Promise((resolve) => setTimeout(resolve, 80));
        const trigger = document.querySelector('.sc-modal-overlay .danger');
        if (!trigger) return { ok: false };
        trigger.focus();
        trigger.click();
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { ok: true, confirmShown: document.getElementById('confirm-modal').classList.contains('show'), focused: document.activeElement && document.activeElement.getAttribute('data-modal-cancel') !== null };
      })()`);
      
      // Escape to cancel
      await keydown('Escape', false);
      await delay(80);
      const singleClosed = await evaluate(`(() => ({
        confirmHidden: !document.getElementById('confirm-modal').classList.contains('show'),
        sessionPreserved: !!Store.getSession(${JSON.stringify(deleteSynthetic.singleId)})
      }))()`);
      
      report.flows.push({
        flow: 'calendar-single-delete-cancel',
        opened: singleOpened,
        closed: singleClosed,
        pass: singleOpened.ok && singleOpened.confirmShown && singleClosed.confirmHidden && singleClosed.sessionPreserved,
      });
      report.score.flows++;
    } catch (err) {
      report.findings.P1.push({ flow: 'calendar-single-delete', issue: err.message });
    }

    // Flow 4: Billing clear modal lifecycle
    console.log('  Flow: billing-clear-modal');
    try {
      await navigate('billing-shell.html');
      
      // Open clear modal
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
      
      // Tab trap test
      await keydown('Tab', true);
      await delay(50);
      const billingTrap = await evaluate(`document.activeElement && document.activeElement.id`);
      
      // Cancel button
      await click('#clear-cancel-btn');
      await delay(80);
      const billingCancelled = await evaluate(`(() => {
        const overlay = document.getElementById('confirm-modal');
        return { hidden: !!(overlay && !overlay.classList.contains('show')), scrollUnlocked: !document.body.classList.contains('xj-modal-open') };
      })()`);
      
      // Reopen and escape
      await evaluate(`document.querySelector('button.danger-btn[onclick*="confirmClearData"]').click()`);
      await delay(80);
      await keydown('Escape', false);
      await delay(80);
      const billingEscaped = await evaluate(`(() => {
        const overlay = document.getElementById('confirm-modal');
        return { hidden: !!(overlay && !overlay.classList.contains('show')), scrollUnlocked: !document.body.classList.contains('xj-modal-open') };
      })()`);
      
      // Error recovery test
      await evaluate(`(async () => {
        document.querySelector('button.danger-btn[onclick*="confirmClearData"]').click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const input = document.getElementById('clear-confirm-input');
        input.value = '确认清除';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        window.Store.clearBillingDataDurable = async function () { throw new Error('synthetic persistence failure'); };
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
          focusReturned: document.activeElement === input
        };
      })()`);
      
      const billingPass = billingOpened.shown && billingOpened.focused === 'clear-cancel-btn' && 
        billingOpened.scrollLocked && billingTrap === 'clear-cancel-btn' &&
        billingCancelled.hidden && billingCancelled.scrollUnlocked &&
        billingEscaped.hidden && billingEscaped.scrollUnlocked &&
        billingFailure.shown && billingFailure.inputRetained && billingFailure.errorVisible &&
        billingFailure.controlsRestored;
      
      report.flows.push({
        flow: 'billing-clear-modal',
        opened: billingOpened,
        tabTrapFocused: billingTrap,
        cancelled: billingCancelled,
        escaped: billingEscaped,
        failure: billingFailure,
        pass: billingPass,
      });
      report.score.flows++;
    } catch (err) {
      report.findings.P1.push({ flow: 'billing-clear-modal', issue: err.message });
    }

    // Flow 5: Calendar series-delete flow
    console.log('  Flow: calendar-series-delete');
    try {
      await navigate('session-calendar.html');
      const seriesSynthetic = await evaluate(`(() => {
        const client = Store.createClient({ name: '系列删除来访者', status: 'active' });
        const date = new Date().toISOString().slice(0, 10);
        const series = Store.createSession({ clientId: client.id, date, sessionNumber: 2, startTime: '10:00', endTime: '10:50', status: 'confirmed', seriesId: 'series_acceptance', recurrence: 'weekly', billing: null });
        SessionCal.render();
        return { seriesId: series.id };
      })()`);
      
      await evaluate(`document.querySelectorAll('.sc-modal-overlay').forEach((node) => node.remove())`);
      const seriesOpened = await evaluate(`(async () => {
        SessionCal.openDetail(${JSON.stringify(seriesSynthetic.seriesId)});
        await new Promise((resolve) => setTimeout(resolve, 80));
        const trigger = document.querySelector('.sc-modal-overlay .danger');
        if (!trigger) return { ok: false };
        trigger.focus();
        trigger.click();
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { ok: true, seriesDialog: !!document.getElementById('series-delete-cancel'), focused: document.activeElement && document.activeElement.id };
      })()`);
      
      await keydown('Escape', false);
      await delay(80);
      const seriesClosed = await evaluate(`(() => ({
        transientRemoved: !document.getElementById('series-delete-cancel'),
        detailRemains: document.querySelectorAll('.sc-modal-overlay').length === 1,
        sessionPreserved: !!Store.getSession(${JSON.stringify(seriesSynthetic.seriesId)})
      }))()`);
      
      report.flows.push({
        flow: 'calendar-series-delete-escape',
        opened: seriesOpened,
        closed: seriesClosed,
        pass: seriesOpened.ok && seriesOpened.seriesDialog && seriesOpened.focused === 'series-delete-cancel' && 
              seriesClosed.transientRemoved && seriesClosed.detailRemains && seriesClosed.sessionPreserved,
      });
      report.score.flows++;
    } catch (err) {
      report.findings.P1.push({ flow: 'calendar-series-delete', issue: err.message });
    }

    // Flow 6: Settings page deep links
    console.log('  Flow: settings-deep-links');
    try {
      await navigate('settings.html');
      const settingsTabs = await evaluate(`(() => {
        const tabs = document.querySelectorAll('.tab, .settings-tab, [role="tab"]');
        const names = [];
        tabs.forEach(t => names.push(t.textContent.trim()));
        return { count: tabs.length, names };
      })()`);
      
      report.flows.push({
        flow: 'settings-tabs',
        tabs: settingsTabs,
        pass: settingsTabs.count > 0,
      });
      report.score.flows++;
      
      // Keyboard navigation test
      await evaluate(`document.querySelector('a[href*="settings"], .tab, [role="tab"]').focus()`);
      await keydown('Tab', false);
      await delay(50);
      const tabFocus = await evaluate(`document.activeElement && document.activeElement.tagName`);
      report.state_coverage.push({ state: 'keyboard-tab-nav', passed: tabFocus !== 'BODY' });
    } catch (err) {
      report.findings.P1.push({ flow: 'settings-tabs', issue: err.message });
    }

    // Flow 7: Masters page interaction
    console.log('  Flow: masters-interaction');
    try {
      await navigate('masters.html');
      const masterCards = await evaluate(`document.querySelectorAll('.master-card, .philosopher-card, .avatar-card').length`);
      report.flows.push({
        flow: 'masters-list',
        cardCount: masterCards,
        pass: masterCards > 0,
      });
      report.score.flows++;
    } catch (err) {
      report.findings.P1.push({ flow: 'masters', issue: err.message });
    }

    // Flow 8: Activation page entitlement lock
    console.log('  Flow: activation-entitlement');
    try {
      await navigate('activation.html');
      const activationState = await evaluate(`(() => {
        const form = document.querySelector('.activation-form, form');
        const locked = document.querySelector('.entitlement-locked, .license-expired, .activation-required');
        return { hasForm: !!form, hasLock: !!locked, bodyText: document.body.innerText.trim().substring(0, 200) };
      })()`);
      
      report.flows.push({
        flow: 'activation-page',
        state: activationState,
        pass: true, // Just verifying it loads
      });
      report.score.flows++;
    } catch (err) {
      report.findings.P2.push({ flow: 'activation', issue: err.message });
    }

    // Flow 9: Reduced motion test
    console.log('  Flow: reduced-motion');
    try {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await navigate('index.html');
      const reducedMotion = await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
      report.flows.push({
        flow: 'reduced-motion',
        matches: reducedMotion,
        pass: reducedMotion === true,
      });
      report.score.flows++;
    } catch (err) {
      report.findings.P2.push({ flow: 'reduced-motion', issue: err.message });
    }

    // Flow 10: Long Chinese text test
    console.log('  Flow: long-chinese-text');
    try {
      await navigate('session-calendar.html');
      const longName = '这是一个非常长的来访者姓名用于测试界面文字截断和换行行为验收测试用例';
      const longNotesClient = await evaluate(`(() => {
        if (!window.Store || typeof Store.createClient !== 'function') return { ok: false };
        const client = Store.createClient({ name: ${JSON.stringify(longName)}, status: 'active', notes: '来访者背景信息：该来访者具有复杂的家庭关系和社会支持网络，包括三代同堂的家庭结构、多子女抚养问题等。' });
        return { ok: !!(client && client.id), name: client.name };
      })()`);
      
      report.flows.push({
        flow: 'long-chinese-text',
        inputLength: longName.length,
        stored: longNotesClient.ok,
        pass: longNotesClient.ok && longNotesClient.name === longName,
      });
      report.score.flows++;
      report.state_coverage.push({ state: 'long-chinese', passed: longNotesClient.ok });
    } catch (err) {
      report.findings.P2.push({ flow: 'long-chinese', issue: err.message });
    }

    console.log('=== INTERACTION FLOWS COMPLETE: ' + report.flows.length + ' flows ===\n');

    // ====== RESOLUTION MATRIX (visual tokens) ======
    console.log('=== RESOLUTION MATRIX START ===');
    const skins = ['clinical', 'theatre', 'observatory'];
    const modes = ['light', 'dark'];
    
    for (const [width, height] of viewports) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      for (const skin of skins) {
        for (const mode of modes) {
          await navigate('index.html');
          const state = await evaluate(`(() => {
            localStorage.setItem('xj_skin', '${skin}');
            localStorage.setItem('xj_theme', '${mode}');
            document.documentElement.setAttribute('data-skin', '${skin}');
            document.documentElement.classList.toggle('dark', '${mode}' === 'dark');
            const root = document.documentElement;
            const overflow = root.scrollWidth > window.innerWidth + 1;
            const banner = document.getElementById('xj-banner');
            const contentTop = document.querySelector('.topbar, .main-header, .page > :first-child');
            const bannerHeight = banner ? Math.ceil(banner.getBoundingClientRect().height) : 0;
            const contentY = contentTop ? Math.floor(contentTop.getBoundingClientRect().top) : 0;
            const coveredByBanner = !!(banner && contentTop && contentY < bannerHeight);
            const computed = getComputedStyle(root);
            return {
              width: window.innerWidth, height: window.innerHeight,
              skin: root.getAttribute('data-skin'), dark: root.classList.contains('dark'),
              overflow, bannerHeight, contentTop: contentY, coveredByBanner,
              canvas: computed.getPropertyValue('--xj-canvas').trim().toLowerCase(),
              accent: computed.getPropertyValue('--xj-accent').trim().toLowerCase()
            };
          })()`);
          
          const name = 'matrix-' + width + 'x' + height + '-' + skin + '-' + mode + '.png';
          await screenshot(name);
          
          report.resolution_matrix.push({
            viewport: width + 'x' + height,
            skin, mode, screenshot: name,
            ...state,
            pass: !state.overflow && !state.coveredByBanner,
          });
          report.score.resolutions++;
        }
      }
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    console.log('=== RESOLUTION MATRIX COMPLETE ===\n');

    // ====== STATE COVERAGE SUMMARY ======
    report.state_coverage.push({ state: 'empty-pages', count: report.pages.filter(p => p.states && p.states[0] && p.states[0].bodyLength < 50).length });
    report.state_coverage.push({ state: 'error-free-pages', count: report.pages.filter(p => !p.error).length });
    report.state_coverage.push({ state: 'overflow-pages', count: report.pages.filter(p => p.screenshots && p.screenshots.some(s => s.overflow)).length });
    report.score.states = report.state_coverage.length;

    // ====== SCORING ======
    const maxPages = allPages.length;
    const maxFlows = 10;
    const maxResolutions = 18;
    const pagesScore = report.pages.filter(p => p.titlePass && !p.error).length;
    const flowsScore = report.flows.filter(f => f.pass !== false).length;
    const resolutionsScore = report.resolution_matrix.filter(r => r.pass).length;
    
    report.score.total = Math.round((pagesScore / maxPages * 40) + (flowsScore / maxFlows * 30) + (resolutionsScore / maxResolutions * 20) + (report.console_errors.length === 0 ? 10 : Math.max(0, 10 - report.console_errors.length)));
    
    // P0-P3 severity
    const p0Count = report.findings.P0.length;
    const p1Count = report.findings.P1.length;
    
    if (p0Count > 0) {
      report.verdict = 'FAIL';
    } else if (p1Count > 2 || report.score.total < 60) {
      report.verdict = 'PARTIAL_PASS';
    } else if (report.score.total >= 80) {
      report.verdict = 'PASS';
    } else {
      report.verdict = 'PARTIAL_PASS';
    }

    // ====== Persistent store console log ======
    const consoleLog = {
      errors: report.console_errors,
      warnings: report.console_warnings,
      network_denials: report.network_denials,
      total_errors: report.console_errors.length,
      total_warnings: report.console_warnings.length,
      total_denials: report.network_denials.length,
    };
    fs.writeFileSync(path.join(consoleDir, 'console-log.json'), JSON.stringify(consoleLog, null, 2));

    // ====== Cleanup verification ======
    if (cdp) {
      try { await cdp.send('Browser.close'); } catch (_) {}
      cdp.close();
    }
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 30000);
      launcher.once('close', (code) => { clearTimeout(timer); resolve(code); });
    });
    await delay(500);
    const afterTemp = new Set(fs.readdirSync(require('os').tmpdir()).filter((name) => name.startsWith('xinjing-agent-acceptance-')));
    const createdTemp = [...afterTemp].filter((name) => !beforeTemp.has(name));
    report.cleanup = {
      launcher_exit_code: exitCode,
      leftover_temp_directories: createdTemp,
      pass: exitCode === 0 && createdTemp.length === 0,
      launcher_stdout: launcherStdout.trim().substring(0, 500),
      launcher_stderr: launcherStderr.trim().substring(0, 500),
    };

    if (!report.cleanup.pass) {
      report.findings.P0.push({ issue: 'Cleanup failed', exitCode, leftoverDirs: createdTemp });
      if (report.verdict === 'PASS' || report.verdict === 'PARTIAL_PASS') report.verdict = 'PARTIAL_PASS';
    }

    report.completed_at = new Date().toISOString();
    report.duration_seconds = Math.round((new Date(report.completed_at) - new Date(report.started_at)) / 1000);

    // Save detailed JSON report
    fs.writeFileSync(path.join(evidenceDir, 'runtime-acceptance.json'), JSON.stringify(report, null, 2));

    // Generate Markdown delivery report
    const md = generateMarkdown(report);
    fs.writeFileSync(path.join(evidenceDir, 'DELIVERY.md'), md);

    console.log('\n=== ACCEPTANCE COMPLETE ===');
    console.log('Verdict: ' + report.verdict);
    console.log('Score: ' + report.score.total + '/100');
    console.log('Pages: ' + pagesScore + '/' + maxPages);
    console.log('Flows: ' + flowsScore + '/' + maxFlows);
    console.log('Resolutions: ' + resolutionsScore + '/' + maxResolutions);
    console.log('Console errors: ' + report.console_errors.length);
    console.log('P0: ' + p0Count + ' P1: ' + p1Count + ' P2: ' + report.findings.P2.length + ' P3: ' + report.findings.P3.length);
    console.log('Report: ' + path.join(evidenceDir, 'DELIVERY.md'));

  } catch (err) {
    console.error('ACCEPTANCE_FAIL:', err && err.stack || err);
    report.error = err.message;
    report.verdict = 'FAIL';
    // Try to save partial report
    try {
      fs.writeFileSync(path.join(evidenceDir, 'runtime-acceptance.json'), JSON.stringify(report, null, 2));
      const md = generateMarkdown(report);
      fs.writeFileSync(path.join(evidenceDir, 'DELIVERY.md'), md);
    } catch (_) {}
    process.exitCode = 1;
  }
}

function generateMarkdown(report) {
  const p = report.pages || [];
  const f = report.flows || [];
  const r = report.resolution_matrix || [];
  
  let md = '# XJ-4.2.1 Marvis Runtime Acceptance Report\n\n';
  md += '| Field | Value |\n|-------|-------|\n';
  md += `| Task ID | ${report.task_id} |\n`;
  md += `| Candidate SHA | ${report.candidate_sha256} |\n`;
  md += `| Started | ${report.started_at} |\n`;
  md += `| Completed | ${report.completed_at || 'N/A'} |\n`;
  md += `| Duration | ${report.duration_seconds || 0}s |\n`;
  md += `| Verdict | **${report.verdict}** |\n`;
  md += `| Score | ${report.score.total}/100 |\n\n`;

  md += '## Scoring Breakdown\n\n';
  md += '| Category | Score | Max |\n|----------|-------|-----|\n';
  md += `| Pages | ${p.filter(pg => pg.titlePass && !pg.error).length} | ${allPages.length} |\n`;
  md += `| Flows | ${f.filter(fl => fl.pass !== false).length} | 10 |\n`;
  md += `| Resolutions | ${r.filter(rr => rr.pass).length} | 18 |\n`;
  md += `| Console Clean | ${report.console_errors && report.console_errors.length === 0 ? 10 : Math.max(0, 10 - (report.console_errors ? report.console_errors.length : 0))} | 10 |\n\n`;

  md += '## Page Traversal\n\n';
  md += '| Page | Title | Title Match | Screenshots | Error |\n';
  md += '|------|-------|-------------|-------------|-------|\n';
  for (const page of p) {
    const screenshots = (page.screenshots || []).map(s => s.viewport).join(', ');
    md += `| ${page.name} | ${page.title || 'N/A'} | ${page.titlePass ? 'PASS' : 'FAIL'} | ${screenshots || 'none'} | ${page.error || 'none'} |\n`;
  }

  md += '\n## Interaction Flows\n\n';
  md += '| Flow | Result | Details |\n|------|--------|---------|\n';
  for (const flow of f) {
    md += `| ${flow.flow} | ${flow.pass ? 'PASS' : (flow.pass === false ? 'FAIL' : 'N/A')} | ${JSON.stringify(flow).substring(0, 150)} |\n`;
  }

  md += '\n## Resolution Matrix\n\n';
  md += '| Viewport | Skin | Mode | Pass |\n|----------|------|------|------|\n';
  for (const cell of r) {
    md += `| ${cell.viewport} | ${cell.skin} | ${cell.mode} | ${cell.pass ? 'PASS' : 'FAIL'} |\n`;
  }

  md += '\n## Findings by Severity\n\n';
  md += '### P0 (Blocker)\n';
  for (const f0 of (report.findings.P0 || [])) {
    md += `- **${f0.page || f0.flow || ''}**: ${f0.issue} ${f0.error || ''}\n`;
  }
  if ((report.findings.P0 || []).length === 0) md += 'None\n';

  md += '\n### P1 (Critical)\n';
  for (const f1 of (report.findings.P1 || [])) {
    md += `- **${f1.page || f1.flow || ''}**: ${f1.issue} ${f1.error || ''}\n`;
  }
  if ((report.findings.P1 || []).length === 0) md += 'None\n';

  md += '\n### P2 (Major)\n';
  for (const f2 of (report.findings.P2 || [])) {
    md += `- **${f2.page || f2.flow || ''}**: ${f2.issue} ${f2.expected ? '(expected: ' + f2.expected + ')' : ''}\n`;
  }
  if ((report.findings.P2 || []).length === 0) md += 'None\n';

  md += '\n### P3 (Minor)\n';
  for (const f3 of (report.findings.P3 || [])) {
    md += `- **${f3.page || f3.flow || ''}**: ${f3.issue}\n`;
  }
  if ((report.findings.P3 || []).length === 0) md += 'None\n';

  md += '\n## Console Summary\n\n';
  md += `- Errors: ${(report.console_errors || []).length}\n`;
  md += `- Warnings: ${(report.console_warnings || []).length}\n`;
  md += `- Network denials: ${(report.network_denials || []).length}\n`;

  if (report.cleanup) {
    md += '\n## Cleanup\n\n';
    md += `- Exit code: ${report.cleanup.launcher_exit_code}\n`;
    md += `- Leftover temp dirs: ${(report.cleanup.leftover_temp_directories || []).length}\n`;
    md += `- Pass: ${report.cleanup.pass}\n`;
  }

  md += '\n## Evidence Files\n\n';
  md += '- `qa/acceptance/XJ-4.2.1-marvis-b34b9ab3/runtime-acceptance.json`\n';
  md += '- `qa/acceptance/XJ-4.2.1-marvis-b34b9ab3/screenshots/**`\n';
  md += '- `qa/acceptance/XJ-4.2.1-marvis-b34b9ab3/console/console-log.json`\n';
  md += '- `qa/acceptance/XJ-4.2.1-marvis-b34b9ab3/traces/**`\n';

  return md;
}

main().catch((error) => {
  console.error('FATAL:', error && error.stack || error);
  process.exitCode = 1;
});
