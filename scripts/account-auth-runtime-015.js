'use strict';
/**
 * account-auth-runtime-015.js — XJ-5.0.2-015 真实 Electron 验收 + logout 控制流 + 18-cell + 路由门禁 + expected-red。
 * 只写 015 scratch；合成账号 + 回环服务 + 临时 userData + 默认拒网。
 * 覆盖：注册/验证/登录、同 userData 重启恢复、设置页可信点击登出、revoke 成功/失败/超时、
 * 账号页返回、加密会话文件清除、登出后 21 条业务路由与 confirm-close.html 例外、
 * 18-cell reduced-motion、焦点、长中文、以及 M-skip-logout-reset expected-red。
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = 'D:/xinjing-electron';
const TASK = 'XJ-5.0.2-account-auth-session-security-logout-closure-rework-015';
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', TASK);
const EVIDENCE = path.join(SCRATCH, 'evidence', 'runtime-015');
const harness = require(path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.0.2-account-auth-desktop-enforcement-008', 'harness-lib.js'));

const PASSWORD = 'Synthetic015A1';
const ROUTES = [
  'index.html', 'chat-home.html', 'consult-notes.html', 'session-calendar.html',
  'transcript.html', 'transcript-guide.html', 'report-writing.html', 'supervision.html',
  'supervision-mindmap.html', 'real-supervision.html', 'real-supervision-ai.html',
  'masters.html', 'doc-center.html', 'doc-growth.html', 'knowledge.html', 'billing-shell.html',
  'billing-calendar.html', 'settings.html', 'feedback.html', 'activation.html',
  'confirm-close.html', 'migrate-helper.html',
];
const SIZES = [
  { name: '1024x700', width: 1024, height: 700 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 },
];
const SKINS = ['clinical', 'theatre', 'observatory'];
const THEMES = ['light', 'dark'];

function sha256Buffer(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sha256File(file) { return sha256Buffer(fs.readFileSync(file)); }
function now() { return new Date().toISOString(); }
function shortError(error) { return String((error && (error.stack || error.message)) || error).slice(0, 1600); }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeRm(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

async function evaluate(cdp, expression) {
  // 导航中的目标会瞬时拒绝 Runtime.evaluate（Inspected target navigated or closed），重试几次再抛。
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error('renderer-evaluate: ' + (response.exceptionDetails.text || 'unknown'));
      return response.result ? response.result.value : undefined;
    } catch (error) {
      const msg = String((error && error.message) || error);
      if (attempt < 5 && /navigated or closed|WebSocket closed|Cannot navigate/i.test(msg)) {
        await wait(300);
        continue;
      }
      throw error;
    }
  }
  throw new Error('renderer-evaluate: retries exhausted');
}
async function waitUntil(cdp, expression, label, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  let last;
  while (Date.now() < deadline) {
    try { last = await evaluate(cdp, expression); } catch (_) { last = false; }
    if (last) return last;
    await wait(120);
  }
  throw new Error('timeout waiting for ' + label + '; last=' + JSON.stringify(last));
}
async function attach(handle) {
  const target = await handle.waitForPage(30000);
  const cdp = await harness.connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.bringToFront');
  const consoleErrors = [];
  cdp.on('Runtime.consoleAPICalled', (event) => {
    if (event.type === 'error') consoleErrors.push({ type: event.type, text: (event.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 500) });
  });
  cdp.on('Log.entryAdded', (event) => {
    const entry = event.entry || {};
    if (entry.level === 'error') consoleErrors.push({ type: 'log', text: String(entry.text || '').slice(0, 500) });
  });
  await waitUntil(cdp, 'typeof window.__XJ_API__ === "object" && !!window.__XJ_API__.account', 'preload account bridge', 20000);
  return { cdp, origin: new URL(target.url).origin, consoleErrors };
}
async function setInput(cdp, selector, value) {
  const result = await evaluate(cdp, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return {ok:false,reason:'missing'}; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return {ok:true}; })()`);
  if (!result || result.ok !== true) throw new Error('setInput ' + selector + ' failed');
}
async function click(cdp, selector) {
  const r = await evaluate(cdp, `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
  if (!r) throw new Error('click ' + selector + ' failed');
}
async function clickTrusted(cdp, selector) {
  const box = await evaluate(cdp, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, width: r.width, height: r.height, disabled: !!el.disabled, vw: window.innerWidth, vh: window.innerHeight }; })()`);
  if (!box || box.width < 1 || box.height < 1 || box.disabled) throw new Error('trusted click target unavailable: ' + selector);
  if (box.x < 0 || box.y < 0 || box.x > box.vw || box.y > box.vh) throw new Error('trusted click target off-viewport: ' + selector + ' ' + JSON.stringify(box));
  await wait(150);
  // 显式 mouseMoved → pressed(buttons=1) → released(buttons=0)：缺少移动/按键状态时
  // 浏览器只给按钮焦点而不产生 click 事件（XJ-4.3.0 侧栏超时同根因）。
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await wait(80);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
  await wait(80);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
  return box;
}
async function submit(cdp, selector) {
  const r = await evaluate(cdp, `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.requestSubmit(); return true; })()`);
  if (!r) throw new Error('submit ' + selector + ' failed');
}
async function screenshot(cdp, file) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const bytes = Buffer.from(shot.data, 'base64');
  fs.writeFileSync(file, bytes);
  if (bytes.length < 4000) throw new Error('blank-or-tiny screenshot: ' + file);
  return { file: path.relative(SCRATCH, file).replace(/\\/g, '/'), bytes: bytes.length, sha256: sha256Buffer(bytes) };
}

async function registerVerifyLoginByUi(cdp, mock, email) {
  await waitUntil(cdp, '!document.querySelector("#view-auth").hidden', 'account auth view ready', 20000);
  await click(cdp, '#tab-register');
  await waitUntil(cdp, 'document.querySelector("#tab-register").getAttribute("aria-selected") === "true"', 'register tab');
  await setInput(cdp, '#register-email', email);
  await setInput(cdp, '#register-password', PASSWORD);
  await setInput(cdp, '#register-password2', PASSWORD);
  await submit(cdp, '#form-register');
  await waitUntil(cdp, '!document.querySelector("#view-verify").hidden', 'verification pane');
  const token = mock.lastVerificationToken();
  assert.ok(token && token.length >= 8, 'synthetic verification token missing');
  await setInput(cdp, '#verify-token', token);
  await submit(cdp, '#form-verify');
  await waitUntil(cdp, 'document.querySelector("#tab-login").getAttribute("aria-selected") === "true" && !document.querySelector("#view-auth").hidden', 'verified login pane');
  await setInput(cdp, '#login-email', email);
  await setInput(cdp, '#login-password', PASSWORD);
  await submit(cdp, '#form-login');
  await waitUntil(cdp, 'location.pathname.endsWith("/index.html")', 'workbench after UI login', 20000);
}

function sessionFileState(userData) {
  const f = path.join(userData, 'account-session-v1.json');
  if (!fs.existsSync(f)) return { exists: false };
  const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { exists: true, bytes: fs.statSync(f).size, sha256: sha256File(f), keys: Object.keys(parsed).sort() };
}

async function runMatrix(cdp, evidence) {
  await cdp.send('Page.bringToFront');
  const cells = [];
  for (const size of SIZES) {
    for (const skin of SKINS) {
      for (const theme of THEMES) {
        const id = `${size.name}-${skin}-${theme}`;
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
        await evaluate(cdp, `(() => { localStorage.setItem('xj_skin', ${JSON.stringify(skin)}); localStorage.setItem('xj_theme', ${JSON.stringify(theme)}); document.documentElement.setAttribute('data-skin', ${JSON.stringify(skin)}); document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.classList.toggle('dark', ${theme === 'dark'}); return true; })()`);
        await wait(250);
        const metrics = await evaluate(cdp, `(() => ({ readyState: document.readyState, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, rootSkin: document.documentElement.getAttribute('data-skin'), rootDark: document.documentElement.classList.contains('dark'), reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, textLength: (document.body && document.body.innerText || '').trim().length, hasFocus: document.hasFocus(), activeTag: (document.activeElement && document.activeElement.tagName) || '' }))()`);
        const shot = await screenshot(cdp, path.join(evidence, `${id}.png`));
        const pass = metrics.readyState === 'complete' && metrics.rootSkin === skin && metrics.rootDark === (theme === 'dark') && metrics.reducedMotion === true && metrics.scrollWidth <= metrics.clientWidth + 1 && metrics.textLength > 20 && metrics.hasFocus === true && metrics.activeTag !== '';
        cells.push({ id, viewport: size.name, skin, theme, pass, metrics, screenshot: shot });
        if (!pass) throw new Error('matrix failure ' + id + ': ' + JSON.stringify(metrics));
      }
    }
  }
  return cells;
}

/* ---------- 回环 mock：默认转发生产 routes；可注入 revoke 成功/失败/超时 ---------- */
function createMockAccountServer() {
  const { createServer } = require(path.join(ROOT, 'server', 'account-auth-routes.js'));
  const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync.native(path.resolve(os.tmpdir())), 'xj-015-mock-'));
  const dataFile = path.join(tmpDir, 'accounts.sqlite');
  const inner = createServer({ dataFile, host: '127.0.0.1', port: 0 });
  const faults = { revokeMode: 'success' }; // success | failure | timeout
  const innerHandler = inner.server.listeners('request')[0];

  const outer = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/account/revoke' && faults.revokeMode === 'failure') {
      const payload = JSON.stringify({ ok: false, error: { code: 'server-unavailable' } });
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(payload);
      return;
    }
    if (url === '/account/revoke' && faults.revokeMode === 'timeout') {
      // 保持连接不响应；由主进程有界等待兜底（3000ms）。
      const kill = setTimeout(() => { try { res.destroy(); } catch (_) {} }, 15000);
      if (kill.unref) kill.unref();
      req.once('close', () => clearTimeout(kill));
      return;
    }
    innerHandler.call(inner.server, req, res);
  });

  return {
    dataFile,
    tmpDir,
    auth: inner.auth,
    mailer: inner.mailer,
    faults,
    listen: () => new Promise((resolve, reject) => {
      outer.once('error', reject);
      outer.listen(0, '127.0.0.1', () => resolve(outer.address().port));
    }),
    close: () => new Promise((resolve) => {
      try { inner.server.close(); } catch (e) { /* ignore */ }
      outer.close(() => resolve());
      setTimeout(resolve, 1500).unref();
    }),
    lastVerificationToken: () => {
      const queue = inner.mailer.peek();
      return queue.length ? queue[queue.length - 1].verificationToken : '';
    },
  };
}

/* ---------- main.js 变异体：只写 015 scratch ---------- */
function absolutizeMainSource(source) {
  let out = source;
  out = out.replace(/require\('\.\//g, `require('${ROOT.replace(/\\/g, '/')}/`);
  out = out.replace(/path\.join\(__dirname,\s*'app'\)/g, `path.join('${ROOT.replace(/\\/g, '/')}', 'app')`);
  out = out.replace(/path\.join\(__dirname,\s*'build'\)/g, `path.join('${ROOT.replace(/\\/g, '/')}', 'build')`);
  out = out.replace(/path\.join\(__dirname,\s*'preload\.js'\)/g, `path.join('${ROOT.replace(/\\/g, '/')}', 'preload.js')`);
  out = out.replace(/path\.join\(__dirname,\s*'confirm-close-preload\.js'\)/g, `path.join('${ROOT.replace(/\\/g, '/')}', 'confirm-close-preload.js')`);
  out = out.replace(/path\.join\(__dirname,\s*'license-revocations\.json'\)/g, `path.join('${ROOT.replace(/\\/g, '/')}', 'license-revocations.json')`);
  return out;
}

function buildMutantMainSkipLogoutReset() {
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  let mutant = absolutizeMainSource(source);
  const needle = "resetAccountSession('logged-out');";
  if (!mutant.includes(needle)) throw new Error('skip-logout-reset mutation needle missing');
  mutant = mutant.replace(needle, '/* expected-red: logout reset deliberately skipped */');
  const file = path.join(SCRATCH, 'mutant-main-skip-logout-reset.js');
  fs.writeFileSync(file, mutant, 'utf8');
  return file;
}

async function loginViaBridge(cdp, email) {
  const r = await evaluate(cdp, `window.__XJ_API__.account.login(${JSON.stringify(email)}, ${JSON.stringify(PASSWORD)})`);
  if (!r || r.authenticated !== true) throw new Error('bridge login failed: ' + JSON.stringify(r));
  return r;
}


async function assertLogoutClosed(cdp, userData, label) {
  await waitUntil(cdp, 'location.pathname.endsWith("/account.html")', label + ' account shell after logout', 15000);
  const status = await evaluate(cdp, 'window.__XJ_API__.account.status()');
  if (!status || status.authenticated !== false) throw new Error(label + ' logout did not clear renderer session state');
  const session = sessionFileState(userData);
  if (session.exists) throw new Error(label + ' logout did not clear persisted encrypted session file');
  return { status, session };
}

async function runRouteGate(cdp, origin) {
  const redirects = [];
  for (const route of ROUTES) {
    await cdp.send('Page.navigate', { url: `${origin}/${route}` });
    await wait(450);
    const observedPath = await evaluate(cdp, 'location.pathname');
    const isException = route === 'confirm-close.html';
    const pass = isException ? /confirm-close\.html$/.test(observedPath) : /account\.html$/.test(observedPath);
    redirects.push({ route, observedPath, pass });
    if (!pass) throw new Error('route gate failed after logout: ' + route + ' -> ' + observedPath);
  }
  return redirects;
}

async function expectedRedSkippedLogout(mock, baseUrl) {
  const userData = fs.mkdtempSync(path.join(fs.realpathSync.native(path.resolve(os.tmpdir())), 'xj-015-mutant-'));
  const mutant = buildMutantMainSkipLogoutReset();
  const handle = await harness.launchElectron({ userData, mainJs: mutant, env: { XJ_ACCOUNT_API_BASE: baseUrl } });
  let attached;
  try {
    attached = await attach(handle);
    const email = 'expected-red-logout-015@example.invalid';
    await registerVerifyLoginByUi(attached.cdp, mock, email);
    const sessionBefore = sessionFileState(userData);
    assert.strictEqual(sessionBefore.exists, true, 'mutant: session file present before logout');

    await attached.cdp.send('Page.navigate', { url: `${attached.origin}/settings.html` });
    await waitUntil(attached.cdp, 'location.pathname.endsWith("/settings.html") && !!document.querySelector("#desktop-account-logout")', 'mutant settings logout control');
    await clickTrusted(attached.cdp, '#desktop-account-logout');
    await wait(1500);

    const statusAfter = await evaluate(attached.cdp, 'window.__XJ_API__.account.status()');
    const sessionAfter = sessionFileState(userData);
    const authenticatedStillTrue = statusAfter && statusAfter.authenticated === true;
    const sessionStillExists = sessionAfter.exists === true;

    await attached.cdp.send('Page.navigate', { url: `${attached.origin}/index.html` });
    await wait(1200);
    const escapedPath = await evaluate(attached.cdp, 'location.pathname');
    const escaped = /index\.html$/.test(escapedPath);

    if (!(authenticatedStillTrue && sessionStillExists && escaped)) {
      throw new Error(`skip-logout-reset mutant did not exhibit skipped reset: authenticated=${statusAfter && statusAfter.authenticated}, sessionExists=${sessionAfter.exists}, path=${escapedPath}`);
    }
    return { id: 'M-skip-logout-reset', verdict: 'KILLED', authenticatedStillTrue, sessionStillExists, escapedBusinessRoute: escaped, evidence: { statusKeys: Object.keys(statusAfter || {}), sessionAfterKeys: sessionAfter.exists ? sessionAfter.keys : [] } };
  } finally {
    if (attached) attached.cdp.close();
    await handle.shutdown();
    safeRm(userData);
  }
}

async function main() {
  ensureDir(EVIDENCE);
  const result = {
    task_id: TASK,
    executor: 'external-single-writer-015',
    started_at: now(),
    synthetic_only: true,
    network: 'main-process loopback only; renderer external network denied by acceptance harness',
    checkpoints: {}, screenshots: [], matrix: [], revoke_scenarios: [], expected_red: [], cleanup: {},
  };
  const mock = createMockAccountServer();
  const port = await mock.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  const userData = fs.mkdtempSync(path.join(fs.realpathSync.native(path.resolve(os.tmpdir())), 'xj-015-direct-'));
  const email = `codex-015-${Date.now()}@example.invalid`;
  let first, firstAttached, second, secondAttached;
  try {
    first = await harness.launchElectron({ userData, env: { XJ_ACCOUNT_API_BASE: baseUrl } });
    firstAttached = await attach(first);

    // 账号壳：长中文不撑破布局
    const longCn = '用于验证账号登录界面中文输入不会撑破布局的合成文本'.repeat(16);
    await setInput(firstAttached.cdp, '#login-email', longCn);
    await submit(firstAttached.cdp, '#form-login');
    await wait(800);
    const shell = await evaluate(firstAttached.cdp, `(() => ({ statusText: (document.querySelector('#account-status') || {}).textContent || '', scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, formAttached: !!document.querySelector('#form-login') }))()`);
    if (shell.scrollWidth > shell.clientWidth + 1) throw new Error('account shell horizontal overflow: ' + JSON.stringify(shell));
    result.checkpoints.accountShell = { pass: true, noOverflow: true, statusText: shell.statusText.slice(0, 80) };

    await registerVerifyLoginByUi(firstAttached.cdp, mock, email);
    const loginStatus = await evaluate(firstAttached.cdp, 'window.__XJ_API__.account.status()');
    const statusKeys = Object.keys(loginStatus || {});
    if (!loginStatus || loginStatus.authenticated !== true || statusKeys.includes('sessionToken')) throw new Error('sanitized status failure: ' + JSON.stringify({ authenticated: loginStatus && loginStatus.authenticated, keys: statusKeys }));
    result.checkpoints.uiLogin = { pass: true, statusKeys, membershipServerAuthoritative: !!(loginStatus.membership && loginStatus.membership.serverAuthoritative === true), tier: loginStatus.membership && loginStatus.membership.tier };
    result.screenshots.push(await screenshot(firstAttached.cdp, path.join(EVIDENCE, 'workbench-after-login.png')));

    // 会员投影：服务器权威 pro 档
    const accountId = loginStatus.account && loginStatus.account.accountId;
    if (accountId) mock.auth.grantMembership(accountId, 'pro');
    await evaluate(firstAttached.cdp, 'window.__XJ_API__.account.refreshMembership().then(()=>true).catch(()=>true)');
    await wait(800);
    const membership = await evaluate(firstAttached.cdp, 'window.__XJ_API__.account.status().then(s => s && s.membership)');
    result.checkpoints.membership = { serverAuthoritative: !!(membership && membership.serverAuthoritative === true), tier: membership && membership.tier };
    if (!(membership && membership.serverAuthoritative === true && membership.tier === 'pro')) throw new Error('server-authoritative pro membership projection failed: ' + JSON.stringify(membership));

    result.matrix = await runMatrix(firstAttached.cdp, EVIDENCE);
    result.screenshots.push(...result.matrix.map((c) => c.screenshot));
    result.checkpoints.matrix = { total: result.matrix.length, passed: result.matrix.filter((c) => c.pass).length };

    const sessionBefore = sessionFileState(userData);
    result.checkpoints.sessionFileEncrypted = { exists: sessionBefore.exists, keys: sessionBefore.keys, tokenPlaintextAbsent: !sessionBefore.keys.includes('sessionToken') && !sessionBefore.keys.includes('token') };
    firstAttached.cdp.close(); firstAttached = null;
    result.checkpoints.firstShutdown = await first.shutdown(); first = null;

    // 同 userData 重启恢复
    second = await harness.launchElectron({ userData, env: { XJ_ACCOUNT_API_BASE: baseUrl } });
    secondAttached = await attach(second);
    await waitUntil(secondAttached.cdp, 'location.pathname.endsWith("/index.html")', 'session restore navigates to workbench', 20000);
    const secondPath = await evaluate(secondAttached.cdp, 'location.pathname');
    const restoredStatus = await evaluate(secondAttached.cdp, 'window.__XJ_API__.account.status()');
    const restored = /index\.html$/.test(secondPath) && restoredStatus && restoredStatus.authenticated === true;
    result.checkpoints.sessionRestore = { pass: restored, observedPath: secondPath, authenticated: !!(restoredStatus && restoredStatus.authenticated), statusKeys: Object.keys(restoredStatus || {}) };
    if (!restored) throw new Error('session restore failed: ' + JSON.stringify({ secondPath, authenticated: restoredStatus && restoredStatus.authenticated }));

    // 设置页可信点击登出（revoke 成功）
    await secondAttached.cdp.send('Page.navigate', { url: `${secondAttached.origin}/settings.html` });
    // 等账号面板真正就绪（initDesktopAccountPanel 完成状态渲染）再点击，避免在 onReady 前点击而监听器未挂上。
    await waitUntil(secondAttached.cdp, 'location.pathname.endsWith("/settings.html") && !!document.querySelector("#desktop-account-logout") && !!document.querySelector("#desktop-account-status") && document.querySelector("#desktop-account-status").textContent !== "读取中…"', 'settings logout panel ready');
    const logoutBox = await clickTrusted(secondAttached.cdp, '#desktop-account-logout');
    const logoutClosed = await assertLogoutClosed(secondAttached.cdp, userData, 'trusted logout success');
    result.checkpoints.logoutAndRoutes = { pass: true, control: '#desktop-account-logout', trustedClick: !!logoutBox, rendererAuthenticatedAfterLogout: false, sessionFileCleared: true };
    result.screenshots.push(await screenshot(secondAttached.cdp, path.join(EVIDENCE, 'account-shell-after-logout.png')));

    const redirects = await runRouteGate(secondAttached.cdp, secondAttached.origin);
    result.checkpoints.logoutRouteGate = { pass: true, routes: redirects, routePassCount: redirects.filter((r) => r.pass).length };

    // revoke 失败：主进程必须本地清态 + 返回失败 + 有界导航到 account.html
    mock.faults.revokeMode = 'failure';
    await loginViaBridge(secondAttached.cdp, email);
    // 登出会触发主进程导航（销毁 renderer 上下文），无法 await invoke 返回值；
    // 改为 fire-and-forget，随后经 status().lastLogout 观测登出结果（不泄漏 token）。
    await evaluate(secondAttached.cdp, 'window.__XJ_API__.account.logout(); true');
    await waitUntil(secondAttached.cdp, 'window.__XJ_API__.account.status().then(s => !!(s && s.lastLogout && s.lastLogout.revoke))', 'revoke failure logout result', 15000);
    const revokeFailureStatus = await evaluate(secondAttached.cdp, 'window.__XJ_API__.account.status()');
    const revokeFailureResult = revokeFailureStatus && revokeFailureStatus.lastLogout;
    if (!revokeFailureResult || revokeFailureResult.revoke.ok !== false) throw new Error('revoke failure was swallowed: ' + JSON.stringify(revokeFailureResult));
    await assertLogoutClosed(secondAttached.cdp, userData, 'revoke failure');
    result.revoke_scenarios.push({ id: 'revoke-failure', pass: true, result: revokeFailureResult, sessionFileCleared: true });

    // revoke 超时：主进程必须有界等待后本地清态 + 返回 revoke-timeout + 有界导航
    mock.faults.revokeMode = 'timeout';
    await loginViaBridge(secondAttached.cdp, email);
    const timeoutStartedAt = Date.now();
    await evaluate(secondAttached.cdp, 'window.__XJ_API__.account.logout(); true');
    await waitUntil(secondAttached.cdp, 'window.__XJ_API__.account.status().then(s => !!(s && s.lastLogout && s.lastLogout.revoke))', 'revoke timeout logout result', 15000);
    const timeoutElapsed = Date.now() - timeoutStartedAt;
    const revokeTimeoutStatus = await evaluate(secondAttached.cdp, 'window.__XJ_API__.account.status()');
    const revokeTimeoutResult = revokeTimeoutStatus && revokeTimeoutStatus.lastLogout;
    if (!revokeTimeoutResult || revokeTimeoutResult.revoke.ok !== false || !(revokeTimeoutResult.revoke.error && revokeTimeoutResult.revoke.error.code === 'revoke-timeout')) {
      throw new Error('revoke timeout was swallowed or mislabeled: ' + JSON.stringify(revokeTimeoutResult));
    }
    if (timeoutElapsed > 8000) throw new Error('revoke timeout logout exceeded bounded wait: ' + timeoutElapsed + 'ms');
    await assertLogoutClosed(secondAttached.cdp, userData, 'revoke timeout');
    result.revoke_scenarios.push({ id: 'revoke-timeout', pass: true, result: revokeTimeoutResult, elapsedMs: timeoutElapsed, sessionFileCleared: true });

    mock.faults.revokeMode = 'success';
    result.expected_red.push(await expectedRedSkippedLogout(mock, baseUrl));
    if (result.expected_red.some((r) => r.verdict !== 'KILLED')) throw new Error('expected-red mutation survivor');

    result.checkpoints.console = { restart: secondAttached.consoleErrors };
    result.status = 'PASS';
  } catch (error) {
    result.status = 'BLOCKED';
    result.error = shortError(error);
    throw error;
  } finally {
    if (firstAttached) firstAttached.cdp.close();
    if (secondAttached) secondAttached.cdp.close();
    if (first) result.cleanup.first = await first.shutdown();
    if (second) result.cleanup.second = await second.shutdown();
    await mock.close();
    safeRm(mock.tmpDir);
    safeRm(userData);
    result.completed_at = now();
    fs.writeFileSync(path.join(EVIDENCE, 'runtime-015-result.json'), JSON.stringify(result, null, 2), 'utf8');
  }
}

main().then(() => {
  console.log('RESULT ' + TASK + ' completed; see ' + path.join(EVIDENCE, 'runtime-015-result.json'));
}).catch((error) => {
  console.error('RESULT ' + TASK + ' failed: ' + shortError(error));
  process.exitCode = 1;
});
