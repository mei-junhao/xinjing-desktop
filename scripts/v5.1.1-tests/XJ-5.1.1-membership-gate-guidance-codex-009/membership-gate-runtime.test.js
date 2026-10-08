'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require(path.join('D:/xinjing-electron', 'node_modules', 'ws'));

const ROOT = 'D:/xinjing-electron';
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 1500 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('CDP timeout')));
    request.on('error', reject);
  });
}

async function waitForTarget(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((target) => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(target.url || ''));
      if (page) return page;
    } catch (_) { /* still starting */ }
    await wait(200);
  }
  throw new Error('Electron acceptance page did not start');
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    ws.on('open', () => resolve({
      send(method, params) {
        return new Promise((resolveCommand, rejectCommand) => {
          const id = nextId++;
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (_) {} },
    }));
    ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch (_) { return; }
      if (!message.id) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || 'CDP command failed'));
      else entry.resolve(message.result || {});
    });
    ws.on('error', reject);
  });
}

async function main() {
  const port = await unusedPort();
  const tempRoot = fs.realpathSync.native(path.resolve(os.tmpdir()));
  const userData = fs.mkdtempSync(path.join(tempRoot, 'xj511-009-gate-'));
  const mockDataDir = fs.mkdtempSync(path.join(tempRoot, 'xj511-009-account-'));
  const { createServer } = require(path.join(ROOT, 'server', 'account-auth-routes.js'));
  const mock = createServer({ dataFile: path.join(mockDataDir, 'accounts.sqlite'), host: '127.0.0.1', port: 0 });
  const accountPort = await mock.listen();
  const launcher = childProcess.spawn(ELECTRON, [
    '--disable-gpu',
    `--user-data-dir=${userData}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    ROOT,
  ], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      XJ_AGENT_ACCEPTANCE: '1',
      XJ_AGENT_ACCEPTANCE_USER_DATA: userData,
      XJ_ACCOUNT_API_BASE: `http://127.0.0.1:${accountPort}`,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let cdp;
  try {
    const target = await waitForTarget(port);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const evaluate = async (expression) => {
      const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Renderer evaluation failed');
      return response.result && response.result.value;
    };
    const origin = new URL(target.url).origin;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await evaluate("typeof window.__XJ_API__ === 'object' && !!window.__XJ_API__.account")) break;
      await wait(200);
    }
    assert(await evaluate("typeof window.__XJ_API__ === 'object' && !!window.__XJ_API__.account"), 'account bridge did not become ready');
    const email = 'membership-gate-009@example.invalid';
    const password = 'TempPass009!';
    const registered = await evaluate(`window.__XJ_API__.account.register(${JSON.stringify(email)}, ${JSON.stringify(password)})`);
    assert(registered && registered.ok === true, 'synthetic account registration failed');
    const verificationQueue = mock.mailer.peek();
    const verificationToken = verificationQueue.length ? verificationQueue[verificationQueue.length - 1].verificationToken : '';
    assert(/^[0-9]{6}$/.test(verificationToken), 'synthetic six-digit verification token missing');
    const verified = await evaluate(`window.__XJ_API__.account.verify(${JSON.stringify(verificationToken)})`);
    assert(verified && verified.ok === true, 'synthetic account verification failed');
    const loggedIn = await evaluate(`window.__XJ_API__.account.login(${JSON.stringify(email)}, ${JSON.stringify(password)})`);
    assert(loggedIn && loggedIn.authenticated === true, 'synthetic account login failed');
    await cdp.send('Page.navigate', { url: `${origin}/masters.html?xj-test=membership-gate-009` });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ready = await evaluate("document.readyState === 'complete' && window.App && document.querySelectorAll('.nav-unlock').length > 0");
      if (ready) break;
      await wait(200);
    }
    const readiness = await evaluate("({ url: location.href, readyState: document.readyState, hasApp: !!window.App, bodyText: (document.body && document.body.innerText || '').slice(0, 320) })");
    assert(readiness.readyState === 'complete' && readiness.hasApp, 'masters route or App did not become ready: ' + JSON.stringify(readiness));
    const staleLocks = await evaluate("Array.from(document.querySelectorAll('.nav-unlock')).filter((button) => App.canUse(button.dataset.unlockFeature)).map((button) => button.dataset.unlockFeature)");
    assert(staleLocks.length === 0, 'sidebar retained a lock for an available feature: ' + JSON.stringify(staleLocks));

    const opened = await evaluate("(() => { const trigger = document.createElement('button'); trigger.type = 'button'; trigger.addEventListener('click', () => App.openMembershipGate('custom-supervisors')); document.body.appendChild(trigger); trigger.click(); const modal = document.getElementById('membership-gate-modal'); return { found: !!modal, feature: 'custom-supervisors', title: modal && modal.querySelector('#membership-gate-title') && modal.querySelector('#membership-gate-title').textContent, summary: modal && modal.querySelector('#membership-gate-summary') && modal.querySelector('#membership-gate-summary').textContent, current: modal && modal.querySelector('[data-gate-current-tier]') && modal.querySelector('[data-gate-current-tier]').textContent, required: modal && modal.querySelector('[data-gate-required-tier]') && modal.querySelector('[data-gate-required-tier]').textContent, plan: !!(modal && modal.querySelector('[data-gate-view-plans]')), focus: document.activeElement && document.activeElement.getAttribute('data-modal-cancel') === '' }; })()");
    assert(opened && opened.found, 'membership guidance did not open for a denied feature: ' + JSON.stringify(opened));
    assert(opened.summary && opened.summary.includes('自定义督导师'), 'guidance omitted the feature label');
    assert(opened.current && opened.required, 'guidance omitted current or required tier');
    assert(opened.plan, 'guidance omitted the view-plans action');
    await wait(80);
    assert(await evaluate("document.activeElement && document.activeElement.getAttribute('data-modal-cancel') === ''"), 'guidance did not set safe initial focus');

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await wait(100);
    assert(await evaluate("!document.getElementById('membership-gate-modal')"), 'Escape did not close and remove membership guidance');

    const unknown = await evaluate("(() => { const before = location.href; const result = App.openMembershipGate('__unknown_xj_feature__'); return { result, modal: !!document.getElementById('membership-gate-modal'), sameLocation: before === location.href }; })()");
    assert(unknown && unknown.result === false && !unknown.modal && unknown.sameLocation, 'unknown feature did not fail closed');

    await evaluate("(() => { App.openMembershipGate('custom-supervisors'); document.querySelector('[data-gate-view-plans]').click(); return !document.getElementById('membership-gate-modal'); })()").then((closed) => assert(closed, 'view-plans action did not close membership guidance'));
    let activationOpened = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      activationOpened = targets.some((item) => /\/activation\.html(?:[?#]|$)/.test(String(item.url || '')));
      if (activationOpened) break;
      await wait(120);
    }
    assert(activationOpened, 'view-plans action did not open the existing activation entry');

    const source = fs.readFileSync(path.join(ROOT, 'app', 'js', 'app.js'), 'utf8');
    const expectedRed = [
      ['remove-nav-handler', source.replace("openMembershipGate(button.dataset.unlockFeature);", 'openPlans();'), /openMembershipGate\(button\.dataset\.unlockFeature\);/],
      ['remove-unknown-deny', source.replace("if (!key || !entitlementsReady || !['pro', 'full', 'custom'].includes(minimumTier))", 'if (false)'), /!key \|\| !entitlementsReady/],
      ['remove-plan-action', source.replace("overlay.querySelector('[data-gate-view-plans]').addEventListener", "overlay.querySelector('[data-gate-view-plans]').removed"), /data-gate-view-plans\]'\)\.addEventListener/],
      ['remove-focus', source.replace("bindModalClose('membership-gate-modal');\n    openModalElement(overlay, { removeOnClose: true, initialFocus: '[data-modal-cancel]' });", "bindModalClose('membership-gate-modal');\n    openModalElement(overlay, { removeOnClose: true, initialFocus: '' });"), /membership-gate-modal'\);\n    openModalElement\(overlay, \{ removeOnClose: true, initialFocus: '\[data-modal-cancel\]' \}\);/],
      ['remove-tier-text', source.replace("overlay.querySelector('[data-gate-required-tier]').textContent = membershipTierLabel(minimumTier);", "overlay.querySelector('[data-gate-required-tier-removed]').textContent = membershipTierLabel(minimumTier);"), /overlay\.querySelector\('\[data-gate-required-tier\]'\)\.textContent = membershipTierLabel\(minimumTier\);/],
    ];
    expectedRed.forEach(([id, mutant, guard]) => assert(!guard.test(mutant), `expected-red survived: ${id}`));
    console.log('MEMBERSHIP_GATE_009: PASS runtime=5 expectedRed=5');
  } finally {
    if (cdp) cdp.close();
    try { launcher.kill('SIGTERM'); } catch (_) {}
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    try { fs.rmSync(mockDataDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((error) => {
  console.error('MEMBERSHIP_GATE_009: FAIL ' + (error && error.stack || error));
  process.exitCode = 1;
});
