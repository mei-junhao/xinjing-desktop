#!/usr/bin/env node
'use strict';

/* Real Electron/CDP regression for the four v4.3.0 P0 repairs.
 * It uses the acceptance wrapper's temporary userData and synthetic records.
 */
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const wrapper = path.join(root, 'scripts', 'agent-electron-acceptance.ps1');
const businessPages = [
  'index.html', 'chat-home.html', 'session-calendar.html', 'doc-center.html',
  'doc-growth.html', 'consult-notes.html', 'transcript.html', 'transcript-guide.html',
  'report-writing.html', 'supervision.html', 'supervision-mindmap.html',
  'real-supervision.html', 'real-supervision-ai.html', 'masters.html', 'knowledge.html',
  'billing-shell.html', 'billing-calendar.html', 'settings.html', 'feedback.html'
];

function ensure(value, message) {
  if (!value) throw new Error(message);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function port() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close((error) => error ? reject(error) : resolve(value));
    });
  });
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
  ensure(response.ok, 'HTTP ' + response.status + ' from ' + url);
  return response.json();
}

async function waitForTarget(debugPort) {
  const deadline = Date.now() + 30000;
  const currentBilling = fs.readFileSync(path.join(root, 'app', 'billing-shell.html'));
  const observed = [];
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson('http://127.0.0.1:' + debugPort + '/json/list');
      const pages = targets.filter((entry) => entry.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(entry.url || ''));
      for (const target of pages) {
        try {
          const response = await fetch(new URL('/billing-shell.html?candidate=' + Date.now(), target.url), { cache: 'no-store', signal: AbortSignal.timeout(1500) });
          if (!response.ok) continue;
          const served = Buffer.from(await response.arrayBuffer());
          observed.push({ url: target.url, served: crypto.createHash('sha256').update(served).digest('hex') });
          if (served.equals(currentBilling)) return target;
        } catch (_) {}
      }
    } catch (_) {}
    await delay(150);
  }
  throw new Error('Timed out waiting for the isolated Electron CDP target; expected=' + crypto.createHash('sha256').update(currentBilling).digest('hex') + '; observed=' + JSON.stringify(observed.slice(-4)));
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        return new Promise((resolveCommand, rejectCommand) => {
          const id = nextId++;
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (_) {} }
    }));
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
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
  const debugPort = await port();
  const powerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const launcher = childProcess.spawn(powerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper, '-RemoteDebuggingPort', String(debugPort)], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let launcherOutput = '';
  launcher.stdout.on('data', (chunk) => { launcherOutput += String(chunk); });
  launcher.stderr.on('data', (chunk) => { launcherOutput += String(chunk); });
  let cdp;
  try {
    const target = await waitForTarget(debugPort);
    const origin = new URL(target.url).origin;
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "window.__xjP0LayoutShift = 0; if ('PerformanceObserver' in window) { try { new PerformanceObserver(function(list) { list.getEntries().forEach(function(entry) { if (!entry.hadRecentInput) window.__xjP0LayoutShift += entry.value || 0; }); }).observe({ type: 'layout-shift', buffered: true }); } catch (_) {} }"
    });

    async function evaluate(expression) {
      const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) {
        const detail = response.exceptionDetails.exception || {};
        throw new Error('Renderer evaluation failed: ' + (detail.description || detail.value || response.exceptionDetails.text));
      }
      return response.result ? response.result.value : undefined;
    }

    async function waitUntil(expression, label) {
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await evaluate(expression)) return;
        await delay(75);
      }
      let diagnostic = '';
      if (label.indexOf('sidebar toggle') >= 0) {
        try {
          const state = await evaluate("(() => { var button = document.getElementById('sidebar-toggle'); var sidebar = document.querySelector('.sidebar'); var rect = button && button.getBoundingClientRect(); var point = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null; return { pathname: location.pathname, readyState: document.readyState, button: !!button, bound: button && button.dataset.bound || null, ariaExpanded: button && button.getAttribute('aria-expanded') || null, sidebar: !!sidebar, collapsed: sidebar && sidebar.classList.contains('collapsed'), stored: localStorage.getItem('xj_sidebar_collapsed'), rect: rect && { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }, hit: !!(point && point.closest && point.closest('#sidebar-toggle')), hitTag: point && point.tagName || null, active: document.activeElement && document.activeElement.id || null }; })()");
          diagnostic = ' state=' + JSON.stringify(state);
        } catch (error) {
          diagnostic = ' diagnostic_error=' + String(error && error.message || error);
        }
      }
      throw new Error('Timed out: ' + label + diagnostic);
    }

    async function navigate(page) {
      await cdp.send('Page.navigate', { url: origin + '/' + page + '?p0=' + Date.now() });
      await waitUntil("document.readyState === 'complete' && location.pathname.endsWith(" + JSON.stringify('/' + page) + ')', 'navigate ' + page);
      await delay(120);
    }

    async function clickAt(selector) {
      const rect = await evaluate("(() => { var el = document.querySelector(" + JSON.stringify(selector) + "); if (!el) return null; var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom, hit: !!(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).closest(" + JSON.stringify(selector) + ")) }; })()");
      ensure(rect && rect.hit, 'Pointer target is not hit-testable: ' + selector + ' ' + JSON.stringify(rect));
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none', buttons: 0 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 });
      return rect;
    }

    for (const page of businessPages) {
      const html = await (await fetch(origin + '/' + page, { cache: 'no-store', signal: AbortSignal.timeout(3000) })).text();
      const head = html.slice(0, html.toLowerCase().indexOf('</head>'));
      ensure(/<link[^>]+href=["']css\/workbench\.css["'][^>]*>/i.test(head), page + ' must preload workbench.css in its document head: ' + head.slice(-300));
      ensure(/<link[^>]+href=["']css\/xj-ui-system\.css["'][^>]*>/i.test(head), page + ' must preload xj-ui-system.css in its document head: ' + head.slice(-300));
    }

    await navigate('index.html');
    await delay(350);
    const motionStart = await evaluate("window.__xjP0LayoutShift || 0");
    await delay(450);
    const motion = await evaluate("(() => ({ shift: window.__xjP0LayoutShift || 0, animated: Array.from(document.querySelectorAll('.stat-card,.list-card,.client-card,.section-title')).filter(function(el) { return getComputedStyle(el).animationName !== 'none'; }).length }))()");
    ensure(motion.animated === 0, 'Initial route contains entrance transform animations: ' + JSON.stringify(motion));
    ensure(motion.shift - motionStart < 0.01, 'Route continues to shift after its initial frame: ' + JSON.stringify({ before: motionStart, after: motion.shift }));

    await navigate('billing-shell.html');
    await waitUntil("typeof Store !== 'undefined' && Store.isHydrated && Store.isHydrated()", 'billing store hydration');
    const client = await evaluate("(() => { var found = Store.getClients().find(function(c) { return c.name === '__XJ_P0_SYNTHETIC__'; }); if (!found) found = Store.createClient({ name: '__XJ_P0_SYNTHETIC__', status: 'active', billing: { feePerSession: 300, billingMode: 'per-session' } }); App.setActiveClientId(found.id); if (window.refreshBillingAll) window.refreshBillingAll(); return { id: found.id, beforeSessions: Store.getSessionsByClient(found.id).length, beforeExpenses: Store.getExpenses().length }; })()");

    await clickAt('#bf-add-record');
    await waitUntil("!!document.getElementById('bf-modal-overlay')", 'record dialog');
    const addDialog = await evaluate("(() => { var node = document.getElementById('bf-modal-overlay'); return { role: node && node.getAttribute('role'), modal: node && node.getAttribute('aria-modal'), display: node && getComputedStyle(node).display, focused: document.activeElement && document.activeElement.id }; })()");
    ensure(addDialog.role === 'dialog' && addDialog.modal === 'true' && addDialog.display !== 'none', 'Record dialog did not open accessibly: ' + JSON.stringify(addDialog));
    await evaluate("(() => { document.getElementById('am-client').value = " + JSON.stringify(client.id) + "; document.getElementById('am-snum').value = '1'; document.getElementById('am-fee').value = '300'; document.getElementById('am-date').value = '2026-07-24'; document.getElementById('am-paid').value = '0'; })()");
    await clickAt('#am-save');
    await waitUntil("!document.getElementById('bf-modal-overlay') && Store.getSessionsByClient(" + JSON.stringify(client.id) + ').length > ' + Number(client.beforeSessions), 'record durable save');

    await clickAt('#bf-add-record');
    await waitUntil("!!document.getElementById('bf-modal-overlay')", 'expense dialog');
    await evaluate("document.querySelector('.am-tab[data-tab=\"expense\"]').click()");
    await evaluate("(() => { document.getElementById('am-exp-date').value = '2026-07-24'; document.getElementById('am-exp-amount').value = '120'; document.getElementById('am-exp-desc').value = 'synthetic expense'; })()");
    await clickAt('#am-exp-save');
    await waitUntil("!document.getElementById('bf-modal-overlay') && Store.getExpenses().length > " + Number(client.beforeExpenses), 'expense durable save');

    await clickAt('#bf-monthly-settle');
    await waitUntil("!!document.getElementById('monthly-invoice-picker')", 'monthly invoice picker');
    const picker = await evaluate("(() => ({ selected: document.getElementById('monthly-invoice-client').value, month: document.getElementById('monthly-invoice-month').value }))()");
    ensure(picker.selected === client.id, 'Monthly invoice picker did not default to the active client: ' + JSON.stringify(picker));
    await evaluate("document.getElementById('monthly-invoice-month').value = '2026-07'");
    await clickAt('#monthly-invoice-open');
    await waitUntil("!!document.getElementById('monthly-invoice-overlay')", 'monthly invoice preview');
    const invoice = await evaluate("(() => { var root = document.getElementById('monthly-invoice-overlay'); return { visible: !!root, sheet: !!document.querySelector('.monthly-invoice-sheet'), redRows: document.querySelectorAll('.monthly-invoice-sheet .is-unpaid').length, text: root ? root.innerText : '' }; })()");
    ensure(invoice.visible && invoice.sheet, 'Monthly invoice preview did not open: ' + JSON.stringify(invoice));
    ensure(invoice.redRows === 0 && !/待收/.test(invoice.text) && /待确认/.test(invoice.text), 'Client-facing invoice still presents a red delinquency label: ' + JSON.stringify(invoice));

    for (const viewport of [[1024, 700], [1366, 768], [1920, 1080]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport[0], height: viewport[1], deviceScaleFactor: 1, mobile: false });
      await navigate('real-supervision.html');
      const before = await evaluate("document.querySelector('.sidebar').classList.contains('collapsed')");
      const rect = await clickAt('#sidebar-toggle');
      await waitUntil("document.querySelector('.sidebar').classList.contains('collapsed') !== " + before, 'sidebar toggle ' + viewport.join('x'));
      ensure(rect.left >= 0 && rect.right <= viewport[0] && rect.top >= 0 && rect.bottom <= viewport[1], 'Sidebar toggle escapes viewport at ' + viewport.join('x') + ': ' + JSON.stringify(rect));
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    console.log('XJ-4.3.0 UI P0 runtime: PASS (record, expense, invoice, static shell styles, transition stability, sidebar hit testing)');
  } finally {
    if (cdp) {
      try { await cdp.send('Browser.close'); } catch (_) {}
      cdp.close();
    }
    if (launcher.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => launcher.once('exit', resolve)),
        delay(5000)
      ]);
    }
    if (launcher.exitCode === null) {
      childProcess.spawnSync('taskkill.exe', ['/PID', String(launcher.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await Promise.race([
        new Promise((resolve) => launcher.once('exit', resolve)),
        delay(2000)
      ]);
    }
  }
  ensure(launcher.exitCode === 0, 'Acceptance Electron wrapper failed: ' + launcherOutput.slice(-1000));
}

main().catch((error) => {
  console.error('XJ-4.3.0 UI P0 runtime: FAIL');
  console.error(error && error.stack || error);
  process.exit(1);
});
