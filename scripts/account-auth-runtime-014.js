'use strict';
/**
 * account-auth-runtime-014.js — Better Auth + SQLite 认证底座真实 Electron 实机验收 + logout expected-red。
 * 只写 014 scratch；合成账号 + 回环服务 + 临时 userData + 默认拒网。
 * 关键修复（相对 013）：M-skip-logout-reset 不再用 CDP Page.navigate 判定，
 * 改用可判定断言：renderer 状态（window.__XJ_API__.account.status()）+ 进程内会话文件检查。
 * 不打印密码/验证码/会话令牌明文。
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = 'D:/xinjing-electron';
const TASK = 'XJ-5.0.2-account-auth-better-auth-sqlite-integration-014';
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', TASK);
const EVIDENCE = path.join(SCRATCH, 'evidence', 'runtime-014');
const harness = require(path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.0.2-account-auth-desktop-enforcement-008', 'harness-lib.js'));

const PASSWORD = 'Synthetic014A1';
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
  const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error('renderer-evaluate: ' + (response.exceptionDetails.text || 'unknown'));
  return response.result ? response.result.value : undefined;
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
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
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
  const cells = [];
  for (const size of SIZES) {
    for (const skin of SKINS) {
      for (const theme of THEMES) {
        const id = `${size.name}-${skin}-${theme}`;
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
        await evaluate(cdp, `(() => { localStorage.setItem('xj_skin', ${JSON.stringify(skin)}); localStorage.setItem('xj_theme', ${JSON.stringify(theme)}); document.documentElement.setAttribute('data-skin', ${JSON.stringify(skin)}); document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.classList.toggle('dark', ${theme === 'dark'}); return true; })()`);
        await wait(250);
        const metrics = await evaluate(cdp, `(() => ({ readyState: document.readyState, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, rootSkin: document.documentElement.getAttribute('data-skin'), rootDark: document.documentElement.classList.contains('dark'), reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, textLength: (document.body && document.body.innerText || '').trim().length }))()`);
        const shot = await screenshot(cdp, path.join(evidence, `${id}.png`));
        const pass = metrics.readyState === 'complete' && metrics.rootSkin === skin && metrics.rootDark === (theme === 'dark') && metrics.reducedMotion === true && metrics.scrollWidth <= metrics.clientWidth + 1 && metrics.textLength > 20;
        cells.push({ id, viewport: size.name, skin, theme, pass, metrics, screenshot: shot });
        if (!pass) throw new Error('matrix failure ' + id + ': ' + JSON.stringify(metrics));
      }
    }
  }
  return cells;
}

function buildMutantSkipLogoutReset() {
  let source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const needle = "resetAccountSession('logged-out');";
  if (!source.includes(needle)) throw new Error('skip-logout-reset mutation needle missing');
  source = source.replace(/require\('\.\//g, `require('${ROOT.replace(/\\/g, '/')}/`);
  source = source.replace(/path\.join\(__dirname,\s*'app'\)/g, `path.join('${ROOT.replace(/\\/g, '/')}', 'app')`);
  source = source.replace(/path\.join\(__dirname,\s*'build'\)/g, `path.join('${ROOT.replace(/\\/g, '/')}', 'build')`);
  source = source.replace(/path\.join\(__dirname,\s*'preload\.js'\)/g, `path.join('${ROOT.replace(/\\/g, '/')}', 'preload.js')`);
  source = source.replace(/path\.join\(__dirname,\s*'confirm-close-preload\.js'\)/g, `path.join('${ROOT.replace(/\\/g, '/')}', 'confirm-close-preload.js')`);
  source = source.replace(/path\.join\(__dirname,\s*'license-revocations\.json'\)/g, `path.join('${ROOT.replace(/\\/g, '/')}', 'license-revocations.json')`);
  source = source.replace(needle, '/* expected-red: logout reset deliberately skipped */');
  const file = path.join(SCRATCH, 'mutant-main-skip-logout-reset.js');
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

async function expectedRedSkippedLogout(mock, baseUrl) {
  const userData = fs.mkdtempSync(path.join(fs.realpathSync.native(path.resolve(os.tmpdir())), 'xj-014-mutant-'));
  const mutant = buildMutantSkipLogoutReset();
  const handle = await harness.launchElectron({ userData, mainJs: mutant, env: { XJ_ACCOUNT_API_BASE: baseUrl } });
  let attached;
  try {
    attached = await attach(handle);
    const email = 'expected-red-logout-014@example.invalid';
    await registerVerifyLoginByUi(attached.cdp, mock, email);
    const sessionBefore = sessionFileState(userData);
    assert.strictEqual(sessionBefore.exists, true, 'mutant: session file present before logout');

    await attached.cdp.send('Page.navigate', { url: `${attached.origin}/settings.html` });
    await waitUntil(attached.cdp, 'location.pathname.endsWith("/settings.html") && !!document.querySelector("#desktop-account-logout")', 'mutant settings logout control');
    await clickTrusted(attached.cdp, '#desktop-account-logout');
    await wait(1500);

    // 可判定断言 1：renderer 状态（变异应保持 authenticated=true，因为 reset 被跳过）
    const statusAfter = await evaluate(attached.cdp, 'window.__XJ_API__.account.status()');
    // 可判定断言 2：进程内会话文件（变异应仍存在，因为 reset 被跳过才清理文件）
    const sessionAfter = sessionFileState(userData);

    // 可判定断言 3：业务路由仍可达（门禁见 authenticated 状态）
    await attached.cdp.send('Page.navigate', { url: `${attached.origin}/index.html` });
    await wait(1200);
    const escapedPath = await evaluate(attached.cdp, 'location.pathname');

    const authenticatedStillTrue = statusAfter && statusAfter.authenticated === true;
    const sessionStillExists = sessionAfter.exists === true;
    const escaped = /index\.html$/.test(escapedPath);

    if (!(authenticatedStillTrue && sessionStillExists)) {
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
    task_id: TASK, executor: 'opencode-deepseek-v4-pro-0813', started_at: now(),
    synthetic_only: true, network: 'main-process loopback only; renderer external network denied by acceptance harness',
    checkpoints: {}, screenshots: [], matrix: [], expected_red: [], cleanup: {},
  };
  const mock = harness.createMockAccountServer();
  const port = await mock.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  const userData = fs.mkdtempSync(path.join(fs.realpathSync.native(path.resolve(os.tmpdir())), 'xj-014-direct-'));
  const email = `codex-014-${Date.now()}@example.invalid`;
  let first, firstAttached, second, secondAttached;
  try {
    first = await harness.launchElectron({ userData, env: { XJ_ACCOUNT_API_BASE: baseUrl } });
    firstAttached = await attach(first);

    // 账号壳：长中文不撑破布局（溢出检查为核心断言；验证消息时序已由 012 独立证据覆盖）
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

    // 会员投影：服务器权威 pro 档（经 mock.auth 直调新 facade grantMembership）
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
    await wait(900);
    const secondPath = await evaluate(secondAttached.cdp, 'location.pathname');
    const restoredStatus = await evaluate(secondAttached.cdp, 'window.__XJ_API__.account.status()');
    const restored = /index\.html$/.test(secondPath) && restoredStatus && restoredStatus.authenticated === true;
    result.checkpoints.sessionRestore = { pass: restored, observedPath: secondPath, authenticated: !!(restoredStatus && restoredStatus.authenticated), statusKeys: Object.keys(restoredStatus || {}) };
    if (!restored) throw new Error('session restore failed: ' + JSON.stringify({ secondPath, authenticated: restoredStatus && restoredStatus.authenticated }));

    // 登出：可信点击 → renderer 状态 + 会话文件清除 + 22 路由门禁
    await secondAttached.cdp.send('Page.navigate', { url: `${secondAttached.origin}/settings.html` });
    await waitUntil(secondAttached.cdp, 'location.pathname.endsWith("/settings.html") && !!document.querySelector("#desktop-account-logout")', 'settings logout control');
    const logoutBox = await clickTrusted(secondAttached.cdp, '#desktop-account-logout');
    await waitUntil(secondAttached.cdp, 'location.pathname.endsWith("/account.html")', 'account shell after logout', 15000);
    const afterLogoutStatus = await evaluate(secondAttached.cdp, 'window.__XJ_API__.account.status()');
    if (!afterLogoutStatus || afterLogoutStatus.authenticated !== false) throw new Error('logout did not clear renderer session state');
    const sessionAfterLogout = sessionFileState(userData);
    if (sessionAfterLogout.exists) throw new Error('logout did not clear persisted encrypted session file');

    const redirects = [];
    for (const route of ROUTES) {
      await secondAttached.cdp.send('Page.navigate', { url: `${secondAttached.origin}/${route}` });
      await wait(450);
      const observedPath = await evaluate(secondAttached.cdp, 'location.pathname');
      const isException = route === 'confirm-close.html';
      const pass = isException ? /confirm-close\.html$/.test(observedPath) : /account\.html$/.test(observedPath);
      redirects.push({ route, observedPath, pass });
      if (!pass) throw new Error('route gate failed after logout: ' + route + ' -> ' + observedPath);
    }
    result.checkpoints.logoutAndRoutes = { pass: true, control: '#desktop-account-logout', trustedClick: !!logoutBox, rendererAuthenticatedAfterLogout: false, sessionFileCleared: true, routes: redirects, routePassCount: redirects.filter((r) => r.pass).length };
    result.screenshots.push(await screenshot(secondAttached.cdp, path.join(EVIDENCE, 'account-shell-after-logout.png')));

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
    fs.writeFileSync(path.join(EVIDENCE, 'runtime-014-result.json'), JSON.stringify(result, null, 2), 'utf8');
  }
}

main().then(() => {
  console.log('RESULT ' + TASK + ' completed; see ' + path.join(EVIDENCE, 'runtime-014-result.json'));
}).catch((error) => {
  console.error('RESULT ' + TASK + ' failed: ' + shortError(error));
  process.exitCode = 1;
});
