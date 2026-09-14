'use strict';

/* XJ-5.0.0-ui-language-migration-22routes-current-baseline-rebind-002
 * Real Electron acceptance harness.
 *
 * Launches the real project main process (main.js) with:
 *   - temporary userData under the system temp directory
 *   - loopback-only Chrome DevTools Protocol
 *   - XJ_AGENT_ACCEPTANCE=1 (main.js default-deny network wrapper)
 *
 * Phases:
 *   A. 22-route smoke: readyState=complete, zero page/console errors, no horizontal overflow
 *   B. 18-cell visual matrix: 3 viewports x 3 skins x 2 themes on representative routes,
 *      token fingerprint assertions + screenshots for every cell
 *   C. Behavioral checks: keyboard focus, long Chinese wrap, prefers-reduced-motion,
 *      empty states on fresh userData, resize/stretch across route navigation,
 *      and the reported primary action 记一笔 exercised at runtime
 *
 * Evidence is written to qa/task-scratch/<task>/evidence/.
 * No real clinical data; no non-loopback network; temp userData removed at the end.
 */

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { PNG } = require(path.join('D:/xinjing-electron', 'node_modules', 'pngjs'));

const ROOT = 'D:/xinjing-electron';
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const TASK_ID = 'XJ-5.0.0-ui-language-migration-22routes-current-baseline-rebind-002';
const EVIDENCE_DIR = path.join(ROOT, 'qa', 'task-scratch', TASK_ID, 'evidence');
const SCREENSHOT_DIR = path.join(EVIDENCE_DIR, 'screenshots');

const ALL_ROUTES = [
  'activation.html', 'billing-calendar.html', 'billing-shell.html', 'chat-home.html',
  'confirm-close.html', 'consult-notes.html', 'doc-center.html', 'doc-growth.html',
  'feedback.html', 'index.html', 'knowledge.html', 'masters.html',
  'migrate-helper.html', 'real-supervision-ai.html', 'real-supervision.html',
  'report-writing.html', 'session-calendar.html', 'settings.html',
  'supervision-mindmap.html', 'supervision.html', 'transcript-guide.html', 'transcript.html',
];

const ROUTE_PATTERNS = {
  'index.html': 'dashboard', 'chat-home.html': 'conversation', 'consult-notes.html': 'form-workspace',
  'session-calendar.html': 'browser-list', 'transcript.html': 'split-editor', 'transcript-guide.html': 'split-editor',
  'report-writing.html': 'split-editor', 'supervision.html': 'conversation', 'supervision-mindmap.html': 'canvas',
  'real-supervision.html': 'form-workspace', 'real-supervision-ai.html': 'browser-list', 'masters.html': 'conversation',
  'doc-center.html': 'browser-list', 'doc-growth.html': 'browser-list', 'knowledge.html': 'browser-list',
  'billing-shell.html': 'browser-list', 'billing-calendar.html': 'browser-list', 'settings.html': 'settings-list',
  'feedback.html': 'form-workspace', 'activation.html': 'utility-window', 'confirm-close.html': 'utility-window',
  'migrate-helper.html': 'utility-window',
};

/* Expected computed token fingerprints per skin/mode (xj-ui-system.css). */
const EXPECTED_TOKENS = {
  'clinical-light': ['#eef3f1', '#147d70'],
  'clinical-dark': ['#151c1a', '#50b5a5'],
  'theatre-light': ['#eceae6', '#7a3945'],
  'theatre-dark': ['#1a1614', '#c96b78'],
  'observatory-light': ['#f1f5f7', '#1f6166'],
  'observatory-dark': ['#111719', '#68bac1'],
};

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function ensure(condition, message) { if (!condition) throw new Error(message); }
function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex.trim();
  const n = parseInt(m[1], 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
function rgbToHex(value) {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(String(value).trim());
  if (!m) return String(value).trim().toLowerCase();
  return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('');
}
function sameColor(a, b) { return rgbToHex(a) === rgbToHex(b); }
function findUnusedPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs || 2000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}
async function waitForPageTarget(debugPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${debugPort}/json/list`, 1000);
      const page = targets.find((target) => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(target.url || ''));
      if (page) return page;
    } catch (_) { /* retry */ }
    await delay(200);
  }
  throw new Error('Timed out waiting for a loopback Electron page target');
}
function connectCdp(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
    const ws = new WebSocket(webSocketDebuggerUrl);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 1;
    ws.on('open', () => resolve({
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
      close() { try { ws.close(); } catch (_) { /* ignore */ } },
    }));
    ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch (_) { return; }
      if (!message.id) {
        for (const handler of listeners.get(message.method) || []) {
          try { handler(message.params || {}); } catch (_) { /* ignore */ }
        }
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result || {});
    });
    ws.on('close', () => {
      for (const entry of pending.values()) entry.reject(new Error('CDP WebSocket closed'));
      pending.clear();
    });
    ws.on('error', (error) => reject(error));
  });
}

async function main() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const debugPort = await findUnusedPort();
  const tempRoot = fs.realpathSync.native(path.resolve(os.tmpdir()));
  const userData = fs.mkdtempSync(path.join(tempRoot, 'xj-ui22-acceptance-'));

  const electronArgs = [
    '--disable-gpu',
    `--user-data-dir=${userData}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debugPort}`,
    ROOT,
  ];
  const launcher = childProcess.spawn(ELECTRON, electronArgs, {
    cwd: ROOT,
    env: { ...process.env, XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: userData },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let launcherOutput = '';
  launcher.stdout.on('data', (chunk) => { launcherOutput += chunk; });
  launcher.stderr.on('data', (chunk) => { launcherOutput += chunk; });

  const result = {
    task_id: TASK_ID,
    timestamp: new Date().toISOString(),
    cdp_port: debugPort,
    user_data: userData,
    routes: [],
    matrix: [],
    interactions: [],
    console_errors: [],
    page_exceptions: [],
    network_denials: [],
    served_source: null,
    cleanup: null,
    pass: false,
  };

  let cdp = null;
  let exitCode = 1;
  try {
    const target = await waitForPageTarget(debugPort, 30000);
    result.target_url = target.url;
    const origin = new URL(target.url).origin;

    /* The acceptance-mode static server must serve current workspace bytes. */
    const servedCheck = await new Promise((resolve, reject) => {
      const request = http.get(`${origin}/billing-shell.html?task=${encodeURIComponent(TASK_ID)}`, { timeout: 5000 }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          if (response.statusCode !== 200) { reject(new Error('static server HTTP ' + response.statusCode)); return; }
          resolve(Buffer.concat(chunks));
        });
      });
      request.on('timeout', () => request.destroy(new Error('static server timeout')));
      request.on('error', reject);
    });
    const localBilling = fs.readFileSync(path.join(ROOT, 'app', 'billing-shell.html'));
    result.served_source = { served_sha256: sha256(servedCheck), local_sha256: sha256(localBilling), pass: servedCheck.equals(localBilling) };
    ensure(result.served_source.pass, 'Electron static server did not serve current workspace bytes');

    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');

    cdp.on('Runtime.exceptionThrown', (event) => {
      const details = event.exceptionDetails || {};
      result.page_exceptions.push({ text: details.text || 'Renderer exception', url: details.url || '', line: details.lineNumber });
    });
    cdp.on('Runtime.consoleAPICalled', (event) => {
      if (event.type !== 'error' && event.type !== 'assert') return;
      result.console_errors.push({ type: event.type, text: (event.args || []).map((arg) => arg.value || arg.description || '').join(' ').slice(0, 400) });
    });
    cdp.on('Log.entryAdded', (event) => {
      const entry = event.entry || {};
      if (entry.level !== 'error') return;
      if (/ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_RESPONSE/.test(entry.text || '')) {
        result.network_denials.push({ text: entry.text || '', url: entry.url || '' });
        return;
      }
      result.console_errors.push({ type: 'log-error', text: (entry.text || '').slice(0, 400), url: entry.url || '' });
    });

    async function evaluate(expression) {
      const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) {
        const details = response.exceptionDetails;
        const exception = details.exception || {};
        throw new Error('Renderer evaluation failed: ' + (exception.description || exception.value || details.text || 'unknown'));
      }
      return response.result ? response.result.value : undefined;
    }
    async function waitForReady() {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate('document.readyState === "complete"')) return;
        await delay(100);
      }
      throw new Error('Renderer page did not reach readyState=complete');
    }
    async function navigate(page) {
      await cdp.send('Page.navigate', { url: `${origin}/${page}` });
      for (let attempt = 0; attempt < 100; attempt++) {
        const reached = await evaluate(`document.readyState === 'complete' && location.pathname.endsWith(${JSON.stringify('/' + page)})`);
        if (reached) { await delay(150); return; }
        await delay(100);
      }
      throw new Error('Navigation did not reach ' + page);
    }
    async function screenshot(name) {
      const capture = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      const bytes = Buffer.from(capture.data, 'base64');
      const png = PNG.sync.read(bytes);
      let varied = false;
      const stride = Math.max(4, Math.floor(png.data.length / 5000) * 4);
      for (let offset = 4; offset < png.data.length; offset += stride) {
        if (png.data[offset] !== png.data[4] || png.data[offset + 1] !== png.data[5] || png.data[offset + 2] !== png.data[6]) { varied = true; break; }
      }
      ensure(varied, 'Captured screenshot is visually blank: ' + name);
      fs.writeFileSync(path.join(SCREENSHOT_DIR, name), bytes);
      return name;
    }
    async function setSkinTheme(skin, mode) {
      await evaluate(`(() => {
        try { localStorage.setItem('xj_skin', ${JSON.stringify(skin)}); localStorage.setItem('xj_theme', ${JSON.stringify(mode)}); } catch (e) {}
        const root = document.documentElement;
        root.setAttribute('data-skin', ${JSON.stringify(skin)});
        root.classList.toggle('dark', ${JSON.stringify(mode)} === 'dark');
        return true;
      })()`);
    }
    async function tokenFingerprint() {
      return evaluate(`(() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          skin: document.documentElement.getAttribute('data-skin'),
          dark: document.documentElement.classList.contains('dark'),
          canvas: cs.getPropertyValue('--xj-canvas').trim(),
          accent: cs.getPropertyValue('--xj-accent').trim(),
          surface: cs.getPropertyValue('--xj-surface').trim(),
        };
      })()`);
    }

    /* ===== A. 22-route smoke ===== */
    await navigate('index.html');
    await waitForReady();
    await evaluate("try { localStorage.setItem('xj_onboarding_done', '1'); } catch (e) {} true");

    for (const page of ALL_ROUTES) {
      try {
        await navigate(page);
        await waitForReady();
        const state = await evaluate(`(() => {
          const root = document.documentElement;
          const pattern = document.body ? (document.body.getAttribute('data-xj-pattern') || '') : '';
          const primaries = Array.prototype.slice.call(document.querySelectorAll('button.primary, button.btn-primary, .xj-new-client, button.wb-primary, #bf-add-record, #start-next-session'))
            .filter((el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; })
            .map((el) => ({
              text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
              disabled: el.disabled,
              inlineOnclick: !!el.getAttribute('onclick'),
              dataAction: el.getAttribute('data-billing-action') || el.getAttribute('data-action') || '',
              id: el.id || '',
            }));
          return {
            pathname: location.pathname,
            readyState: document.readyState,
            title: document.title,
            pattern,
            textLength: (document.body.innerText || '').trim().length,
            skin: root.getAttribute('data-skin'),
            dark: root.classList.contains('dark'),
            clientWidth: root.clientWidth,
            scrollWidth: root.scrollWidth,
            horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
            visiblePrimaryButtons: primaries,
          };
        })()`);
        state.ok = state.pathname.endsWith('/' + page) && state.readyState === 'complete' && state.textLength > 20
          && !state.horizontalOverflow && state.pattern === ROUTE_PATTERNS[page];
        result.routes.push({ page, ...state });
      } catch (error) {
        result.routes.push({ page, ok: false, error: String((error && error.message) || error) });
      }
    }

    /* ===== B. 18-cell visual matrix (index + billing-shell evidence per cell) ===== */
    const viewports = [[1024, 700], [1366, 768], [1920, 1080]];
    const skins = ['clinical', 'theatre', 'observatory'];
    const modes = ['light', 'dark'];
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    for (const [width, height] of viewports) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      for (const skin of skins) {
        for (const mode of modes) {
          const cellId = `${width}x${height}-${skin}-${mode}`;
          const cell = { cell: cellId, width, height, skin, mode, shots: [], fingerprint: null, expected: null, pass: false };
          await navigate('index.html');
          await waitForReady();
          await setSkinTheme(skin, mode);
          await navigate('index.html');
          await waitForReady();
          await setSkinTheme(skin, mode); /* re-assert after entitlement bootstrap reset */
          await delay(120);
          cell.fingerprint = await tokenFingerprint();
          const expected = EXPECTED_TOKENS[`${skin}-${mode}`];
          cell.expected = { canvas: expected[0], accent: expected[1] };
          cell.shots.push(await screenshot(`matrix-${cellId}-index.png`));
          await navigate('billing-shell.html');
          await waitForReady();
          await setSkinTheme(skin, mode);
          await delay(120);
          const billingFp = await tokenFingerprint();
          cell.billing_fingerprint = billingFp;
          cell.shots.push(await screenshot(`matrix-${cellId}-billing.png`));
          cell.pass = sameColor(cell.fingerprint.canvas, cell.expected.canvas)
            && sameColor(cell.fingerprint.accent, cell.expected.accent)
            && cell.fingerprint.skin === skin
            && cell.fingerprint.dark === (mode === 'dark')
            && sameColor(billingFp.canvas, cell.expected.canvas)
            && sameColor(billingFp.accent, cell.expected.accent);
          result.matrix.push(cell);
        }
      }
    }
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: '' }] });

    /* Unique fingerprints across the 6 skin/mode pairs prove skins did not collapse. */
    const pairFingerprints = new Set();
    for (const skin of skins) {
      for (const mode of modes) {
        const cell = result.matrix.find((c) => c.skin === skin && c.mode === mode && c.width === 1366);
        if (cell && cell.fingerprint) pairFingerprints.add(`${cell.fingerprint.canvas}|${cell.fingerprint.accent}`);
      }
    }
    result.skin_fingerprint_uniqueness = { distinct: pairFingerprints.size, expected: 6, pass: pairFingerprints.size === 6 };

    /* ===== C. Interactions ===== */

    /* C1. Keyboard focus: a real Tab key press moves focus to a visible control. */
    await navigate('index.html');
    await waitForReady();
    await setSkinTheme('clinical', 'light');
    await evaluate('document.body.focus(); if (document.activeElement) document.activeElement.blur(); true');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await delay(120);
    const focusState = await evaluate(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { focused: false };
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        focused: true,
        tag: el.tagName,
        visible: rect.width > 0 && rect.height > 0 && cs.display !== 'none',
        outline: cs.outStyle || cs.outlineStyle,
        focusVisibleRulePresent: !!Array.prototype.slice.call(document.styleSheets).some((sheet) => {
          try { return Array.prototype.slice.call(sheet.cssRules).some((rule) => rule.selectorText && rule.selectorText.indexOf(':focus-visible') !== -1); }
          catch (e) { return false; }
        }),
      };
    })()`);
    result.interactions.push({ id: 'keyboard-focus', pass: !!(focusState && focusState.focused && focusState.visible && focusState.focusVisibleRulePresent), detail: focusState });

    /* C2. Long Chinese text wraps inside its region and never forces page width. */
    const longChinese = await evaluate(`(() => {
      const host = document.querySelector('.main') || document.body;
      const probe = document.createElement('div');
      probe.id = 'xj-long-probe';
      probe.style.cssText = 'max-width:100%;padding:8px;';
      probe.textContent = '这是一段用于验证长中文文本换行行为的探针文本。'.repeat(12) + '来访者张三丰的第十三节咨询会谈记录草稿，包含大量连续的中文内容，用来确认不会被强制撑破页面宽度，也不会产生横向滚动条。';
      host.appendChild(probe);
      const rect = probe.getBoundingClientRect();
      const root = document.documentElement;
      const out = {
        probeWidth: Math.round(rect.width),
        viewportWidth: root.clientWidth,
        wrapped: rect.height > 60,
        pageOverflow: root.scrollWidth > root.clientWidth + 1,
      };
      probe.remove();
      return out;
    })()`);
    result.interactions.push({ id: 'long-chinese-wrap', pass: !!(longChinese && longChinese.wrapped && !longChinese.pageOverflow && longChinese.probeWidth <= longChinese.viewportWidth), detail: longChinese });

    /* C3. prefers-reduced-motion collapses nonessential motion. */
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await navigate('index.html');
    await waitForReady();
    const reducedMotion = await evaluate(`(() => {
      const el = document.querySelector('.mod') || document.querySelector('button');
      if (!el) return { found: false };
      const cs = getComputedStyle(el);
      const duration = parseFloat(cs.transitionDuration) || 0;
      const mediaMatch = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const rulePresent = !!Array.prototype.slice.call(document.styleSheets).some((sheet) => {
        try { return Array.prototype.slice.call(sheet.cssRules).some((rule) => rule.media && rule.conditionText === '(prefers-reduced-motion: reduce)'); }
        catch (e) { return false; }
      });
      return { found: true, duration, mediaMatch, rulePresent };
    })()`);
    result.interactions.push({ id: 'reduced-motion', pass: !!(reducedMotion && reducedMotion.mediaMatch && reducedMotion.rulePresent && reducedMotion.duration <= 0.01), detail: reducedMotion });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: '' }] });

    /* C4. Fresh userData empty states are visible and useful. */
    await navigate('index.html');
    await waitForReady();
    const emptyStates = await evaluate(`(() => {
      const text = (document.body.innerText || '');
      return {
        indexShowsEmptyRecentOrTodo: /暂无|还没有|空|开始|待办/.test(text),
        textSample: text.slice(0, 200),
      };
    })()`);
    await navigate('knowledge.html');
    await waitForReady();
    const knowledgeEmpty = await evaluate(`(() => {
      const text = (document.body.innerText || '');
      return { showsEmptyOrLoading: /暂无|还没有|空|导入|加载/.test(text) };
    })()`);
    result.interactions.push({ id: 'empty-states-fresh-userdata', pass: !!(emptyStates.indexShowsEmptyRecentOrTodo && knowledgeEmpty.showsEmptyOrLoading), detail: { emptyStates, knowledgeEmpty } });

    /* C5. Resize / route-switch stretch: no horizontal overflow at any of the three
       viewports while navigating between routes; rails keep stable widths. */
    const stretchRoutes = ['index.html', 'billing-shell.html', 'settings.html', 'knowledge.html', 'consult-notes.html', 'supervision.html'];
    const stretch = [];
    for (const [width, height] of viewports) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      for (const page of stretchRoutes) {
        await navigate(page);
        await waitForReady();
        const metrics = await evaluate(`(() => {
          const root = document.documentElement;
          const sidebar = document.querySelector('#sidebar-mount .sidebar') || document.querySelector('.sidebar');
          return {
            clientWidth: root.clientWidth,
            scrollWidth: root.scrollWidth,
            overflow: root.scrollWidth > root.clientWidth + 1,
            sidebarWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : null,
          };
        })()`);
        stretch.push({ width, height, page, ...metrics });
      }
      /* Same-page width transitions must not overflow either. */
      await navigate('index.html');
      await waitForReady();
      for (const [w2, h2] of [[1920, 1080], [1024, 700], [1366, 768]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: w2, height: h2, deviceScaleFactor: 1, mobile: false });
        await delay(160);
        const metrics = await evaluate(`(() => {
          const root = document.documentElement;
          return { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, overflow: root.scrollWidth > root.clientWidth + 1 };
        })()`);
        stretch.push({ width: w2, height: h2, page: 'index.html-resize', ...metrics });
      }
    }
    const stretchPass = stretch.every((entry) => !entry.overflow);
    result.interactions.push({ id: 'resize-route-switch-stretch', pass: stretchPass, detail: { samples: stretch.length, failures: stretch.filter((entry) => entry.overflow) } });
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'stretch-samples.json'), JSON.stringify(stretch, null, 1));

    /* C6. The reported primary action 记一笔 must open its real handler at runtime. */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await navigate('billing-shell.html');
    await waitForReady();
    await setSkinTheme('clinical', 'light');
    const addRecordBefore = await evaluate(`(() => {
      const btn = document.getElementById('bf-add-record');
      if (!btn) return { found: false };
      const rect = btn.getBoundingClientRect();
      const cs = getComputedStyle(btn);
      return {
        found: true,
        visible: rect.width > 0 && rect.height > 0 && cs.display !== 'none',
        disabled: btn.disabled,
        bound: btn.dataset.bound === '1',
        hasDataAction: btn.getAttribute('data-billing-action') === 'add-record',
      };
    })()`);
    await evaluate(`(() => { const btn = document.getElementById('bf-add-record'); if (btn) btn.click(); return true; })()`);
    await delay(300);
    const addRecordAfter = await evaluate(`(() => {
      const overlay = document.getElementById('bf-modal-overlay');
      if (!overlay) return { modalOpen: false };
      const title = document.getElementById('bf-add-modal-title');
      return { modalOpen: true, titleText: title ? title.textContent.trim() : '', role: overlay.getAttribute('role') };
    })()`);
    /* Close the modal again without saving. */
    await evaluate(`(() => { const overlay = document.getElementById('bf-modal-overlay'); if (overlay) overlay.remove(); return true; })()`);
    await delay(120);
    const addRecordClosed = await evaluate('!document.getElementById("bf-modal-overlay")');
    const addRecordPass = !!(addRecordBefore.found && addRecordBefore.visible && !addRecordBefore.disabled
      && addRecordBefore.bound && addRecordBefore.hasDataAction
      && addRecordAfter.modalOpen && /记一笔/.test(addRecordAfter.titleText) && addRecordClosed);
    result.interactions.push({ id: 'billing-primary-add-record', pass: addRecordPass, detail: { addRecordBefore, addRecordAfter, addRecordClosed } });

    /* ===== Verdict ===== */
    const routesPass = result.routes.length === 22 && result.routes.every((r) => r.ok);
    const matrixPass = result.matrix.length === 18 && result.matrix.every((c) => c.pass) && result.skin_fingerprint_uniqueness.pass;
    const interactionsPass = result.interactions.every((i) => i.pass);
    const zeroErrors = result.page_exceptions.length === 0 && result.console_errors.length === 0;
    result.verdict = { routesPass, matrixPass, interactionsPass, zeroErrors };
    result.pass = routesPass && matrixPass && interactionsPass && zeroErrors;
    exitCode = result.pass ? 0 : 1;
  } catch (error) {
    result.error = String((error && error.stack) || error);
    exitCode = 1;
  } finally {
    result.launcher_output_tail = launcherOutput.slice(-2000);
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'electron-acceptance.json'), JSON.stringify(result, null, 1));
    /* Clean shutdown: close the acceptance window; main.js permits quit in acceptance mode. */
    try { if (cdp) { await cdp.send('Browser.close').catch(() => {}); cdp.close(); } } catch (_) { /* ignore */ }
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      launcher.once('exit', () => { clearTimeout(timer); resolve(true); });
      try { launcher.kill(); } catch (_) { /* ignore */ }
    });
    let cleanedUserData = false;
    try { fs.rmSync(userData, { recursive: true, force: true }); cleanedUserData = !fs.existsSync(userData); } catch (_) { cleanedUserData = false; }
    result.cleanup = { launcher_exited: exited, exit_code: launcher.exitCode, user_data_removed: cleanedUserData };
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'electron-acceptance.json'), JSON.stringify(result, null, 1));
    console.log(JSON.stringify({ pass: result.pass, verdict: result.verdict, exitCode }, null, 1));
  }
  process.exit(exitCode);
}

main().catch((error) => { console.error(error); process.exit(1); });
