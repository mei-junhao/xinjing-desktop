#!/usr/bin/env node
'use strict';

// Local-only semantic Electron acceptance. This runner starts the existing
// isolated wrapper and uses its opt-in loopback CDP port; it never uses real userData.

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..', '..');
const wrapper = path.join(root, 'scripts', 'agent-electron-acceptance.ps1');
const evidenceDir = path.join(root, 'qa', 'acceptance', 'XJ-4.2.1-codex');
const screenshotDir = path.join(evidenceDir, 'screenshots');
const candidateFiles = [
  'app/billing-shell.html',
  'app/css/workbench.css',
  'app/css/xj-ui-system.css',
  'app/js/agent-tools.js',
  'app/js/app.js',
  'app/js/billing-calendar.js',
  'app/js/client-modal.js',
  'app/js/consult-notes.js',
  'app/js/entitlements.js',
  'app/js/report-writing.js',
  'app/js/session-calendar.js',
  'app/js/settings.js',
  'app/js/store.js',
  'app/js/masters.js',
  'app/js/masters-core.js',
  'app/js/supervision.js',
  'app/js/supervision-core.js',
  'app/js/real-supervision.js',
  'app/js/transcript.js',
  'app/settings.html',
  'main.js',
  'package-lock.json',
  'package.json',
  'preload.js',
  'scripts/agent-electron-acceptance.ps1',
  'scripts/v4.2.1-tests/agent-acceptance-wrapper.contract.js',
  'scripts/v4.2.1-tests/api-config-durable.contract.js',
  'scripts/v4.2.1-tests/durable-save.contract.js',
  'scripts/v4.2.1-tests/electron-semantic-acceptance.js',
  'scripts/v4.2.1-tests/import-integrity.contract.js',
  'scripts/v4.2.1-tests/legacy-write-integrity.contract.js',
  'scripts/v4.2.1-tests/ui-critical.contract.js',
  'scripts/self-test.js',
  'tests/fixtures/v4.2.1-import-integrity/fixtures.js',
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

// Keep the expected candidate hash outside the hashed candidate scope. Putting
// it in this runner makes every test change self-invalidating by construction.
function expectedCandidateHash() {
  const manifestPath = path.join(root, 'docs', 'agent-coordination', 'v4.2.1', 'candidate-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || !/^[a-f0-9]{64}$/.test(manifest.candidate_sha256 || '')) {
    fail('Candidate manifest must contain a 64-character SHA-256');
  }
  return manifest.candidate_sha256;
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await json('http://127.0.0.1:' + port + '/json/list');
      const page = targets.find((target) => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(target.url || ''));
      if (page) return page;
    } catch (_) {}
    await delay(250);
  }
  fail('Timed out waiting for the loopback-only CDP target');
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

async function main() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  assertAcceptancePathCanonicalization();
  const expectedCandidate = expectedCandidateHash();
  const actualCandidate = candidateHash();
  ensure(actualCandidate === expectedCandidate, 'Candidate SHA mismatch: ' + actualCandidate);

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
    task_id: 'XJ-4.2.1-codex-electron-semantic-acceptance',
    candidate_sha256: actualCandidate,
    cdp_port: port,
    matrix: [],
    flows: [],
    console_errors: [],
    network_denials: [],
    cleanup: null,
  };
  let cdp = null;
  try {
    const target = await waitForTarget(port, 30000);
    result.target_url = target.url;
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

    // The matrix targets the daily-work surface. This exists only in the
    // disposable acceptance profile and never writes a real user's setting.
    await evaluate("localStorage.setItem('xj_onboarding_done', '1'); true");

    const routeChecks = [
      ['index.html', '今日工作台'],
      ['session-calendar.html', '咨询日历'],
      ['settings.html', '设置'],
      ['masters.html', '大师对话'],
      ['billing-shell.html', '记账'],
      ['knowledge.html', '资料库'],
    ];
    for (const [page, titlePart] of routeChecks) {
      await navigate(page);
      const title = await evaluate('document.title');
      result.flows.push({ page, expected_title_part: titlePart, title, pass: String(title).includes(titlePart) });
      ensure(String(title).includes(titlePart), page + ' title did not contain ' + titlePart);
    }

    await navigate('index.html');
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

    await navigate('billing-shell.html');
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
      if (!cancel) return { ok: false, messageHtml: document.getElementById('confirm-message') && document.getElementById('confirm-message').innerHTML };
      cancel.click();
      return { ok: true };
    })()`);
    ensure(billingCancelClick.ok, 'Billing clear cancel control missing: ' + JSON.stringify(billingCancelClick));
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

    await navigate('index.html');
    const syntheticClient = await evaluate(`(() => {
      if (!window.Store || typeof Store.createClient !== 'function') return { ok: false, reason: 'Store.createClient unavailable' };
      const client = Store.createClient({ name: '验收来访者', status: 'active' });
      return { ok: !!(client && client.id), id: client && client.id };
    })()`);
    ensure(syntheticClient.ok, 'Could not create synthetic client for calendar acceptance');
    ensure((await click('#start-next-session')).ok, 'Start-next-session control missing');
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
    const expectedSessionDate = new URL('http://127.0.0.1' + sessionUrl).searchParams.get('date');
    const calendarDate = calendarForm ? await evaluate('document.getElementById("sf-date").value') : '';
    result.flows.push({ flow: 'start-next-session', url: sessionUrl, calendar_form: calendarForm, calendar_date: calendarDate, expected_date: expectedSessionDate, pass: sessionUrl.includes('session-calendar.html?action=new') && calendarForm && calendarDate === expectedSessionDate });
    ensure(sessionUrl.includes('session-calendar.html?action=new') && calendarForm && calendarDate === expectedSessionDate, 'Start-next-session did not preserve the requested session date');

    await navigate('session-calendar.html');
    const deleteFixtures = await evaluate(`(() => {
      const client = Store.createClient({ name: '删除验收来访者', status: 'active' });
      const date = new Date().toISOString().slice(0, 10);
      const single = Store.createSession({ clientId: client.id, date, sessionNumber: 1, startTime: '09:00', endTime: '09:50', status: 'confirmed', billing: null });
      const series = Store.createSession({ clientId: client.id, date, sessionNumber: 2, startTime: '10:00', endTime: '10:50', status: 'confirmed', seriesId: 'series_acceptance', recurrence: 'weekly', billing: null });
      SessionCal.render();
      return { singleId: single.id, seriesId: series.id };
    })()`);
    const singleOpened = await evaluate(`(async () => {
      SessionCal.openDetail(${JSON.stringify(deleteFixtures.singleId)});
      await new Promise((resolve) => setTimeout(resolve, 60));
      const trigger = document.querySelector('.sc-modal-overlay .danger');
      if (!trigger) return { ok: false };
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
      SessionCal.openDetail(${JSON.stringify(deleteFixtures.seriesId)});
      await new Promise((resolve) => setTimeout(resolve, 60));
      const trigger = document.querySelector('.sc-modal-overlay .danger');
      if (!trigger) return { ok: false };
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

    const viewports = [[1024, 700], [1366, 768], [1920, 1080]];
    const skins = ['clinical', 'theatre', 'observatory'];
    const modes = ['light', 'dark'];
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
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
            'observatory-light': ['#f1f5f7', '#2a8b93'], 'observatory-dark': ['#111719', '#68bac1']
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
    fs.writeFileSync(path.join(evidenceDir, 'semantic-acceptance.json'), JSON.stringify(result, null, 2));
  }

  const failed = result.matrix.filter((cell) => !cell.pass).length + result.flows.filter((flow) => !flow.pass).length + result.console_errors.length + (result.cleanup && !result.cleanup.pass ? 1 : 0);
  console.log('Semantic acceptance: ' + result.matrix.length + '/18 matrix cells, ' + result.flows.length + ' flows, ' + failed + ' failures');
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error('SEMANTIC_ACCEPTANCE_FAIL:', error && error.stack || error);
  process.exitCode = 1;
});
