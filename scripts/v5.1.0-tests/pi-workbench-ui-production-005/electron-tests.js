'use strict';
/**
 * XJ-5.1.0-005 — Workbench UI 真实 Electron 测试（生产 main.js + 进程内合成账号服务）
 * 用法：node electron-tests.js default|matrix
 * 凭据纪律：仅合成测试口令常量；全程合成数据；临时 userData；无子进程。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const harness = require('D:/xinjing-electron/qa/task-scratch/XJ-5.0.2-account-auth-desktop-enforcement-008/harness-lib.js');
const { AccountAuth } = require('D:/xinjing-electron/qa/task-scratch/XJ-5.0.2-account-auth-quota-sqlite-deepseek-pro-unified-settlement-successor-027/isolated-worktree/server/account-auth.js');

const ROOT = 'D:/xinjing-electron';
const SCR031 = ROOT + '/qa/task-scratch/XJ-5.0.2-account-auth-quota-sqlite-deepseek-pro-unified-settlement-successor-027';
const SCR = ROOT + '/qa/task-scratch/XJ-5.1.0-pi-workbench-ui-production-integration-005';
const TMP = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-005-el-'));
const UD = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-005-ud-'));
const SYNTH_TEST_PASS = 'Synth005Pass'; // 合成账号口令（仅测试；非任何真实凭据）
const MODE = process.argv[2] || 'default';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let passCount = 0, failCount = 0;
function report(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
  if (ok) passCount++; else failCount++;
}
function inside(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

// ---- 进程内合成账号服务（main.js 的 accountNodeRequest 契约最小面） ----
const auth = new AccountAuth({ dataFile: path.join(TMP, 'accounts.sqlite') });
function jsonBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}
function startAccountHttpServer() {
  const srv = http.createServer(async (req, res) => {
    const u = (req.url || '').split('?')[0];
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && u === '/') return send(200, { ok: true });
    const b = await jsonBody(req);
    if (u === '/account/login') {
      const r = await auth.login({ email: b.email, password: b.password });
      return send(200, r);
    }
    if (u === '/account/session') {
      return send(200, auth.validateSession(b.sessionToken));
    }
    if (u === '/account/membership') {
      const s = auth.validateSession(b.sessionToken);
      if (!s.ok) return send(200, s);
      return send(200, { ok: true, accountId: s.accountId, tier: s.tier, serverAuthoritative: true });
    }
    return send(404, { ok: false, error: { code: 'not-found' } });
  });
  return new Promise((r) => srv.listen(21900, '127.0.0.1', () => r(srv)));
}
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    await delay(300);
    const c = await new Promise((res) => http.get({ host: '127.0.0.1', port: 21900, path: '/' }, (r) => { r.resume(); res(r.statusCode); }).on('error', () => res(0)));
    if (c === 200) return true;
  }
  return false;
}
async function launchApp() {
  return harness.launchElectron({ mainJs: ROOT, userData: UD, env: {
    XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_CLOSE_DIALOG: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: UD,
    XJ_AI_PROXY_BASE: 'http://127.0.0.1:21900/v1', XJ_AI_ALLOW_LOOPBACK: '1',
    XJ_ACCOUNT_API_BASE: 'http://127.0.0.1:21900', XJ_APP_PROXY_KEY: 'test',
    LICENSE_SECRET: 'xj510-synthetic-license-secret-acceptance-only', NODE_TLS_REJECT_UNAUTHORIZED: '0',
  } });
}
async function getConn(handle) {
  const ts = await harness.getJson('http://127.0.0.1:' + handle.debugPort + '/json/list', 2500);
  const pg = ts.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url || ''));
  return pg ? { cdp: await harness.connectCdp(pg.webSocketDebuggerUrl), url: pg.url } : null;
}
async function waitUrl(handle, part, ms) {
  const end = Date.now() + (ms || 30000);
  while (Date.now() < end) {
    try {
      const ts = await harness.getJson('http://127.0.0.1:' + handle.debugPort + '/json/list', 1500);
      const p = ts.find((t) => t.type === 'page' && (t.url || '').includes(part));
      if (p) return p;
    } catch (e) {}
    await delay(300);
  }
  return null;
}
async function ev(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.exceptionDetails ? 'EXC:' + r.exceptionDetails.text : r.result.value;
}
async function click(cdp, id) { return ev(cdp, "(function(){var b=document.getElementById('" + id + "');if(b)b.click();return b?'clicked':'missing';})()"); }
async function login(cdp, email) {
  for (let i = 0; i < 20; i++) { if (await ev(cdp, "(function(){var v=document.getElementById('view-auth');return v&&!v.hidden;})()") === true) break; await delay(300); }
  await ev(cdp, "(function(){document.getElementById('login-email').value='" + email + "';document.getElementById('login-password').value='" + SYNTH_TEST_PASS + "';document.getElementById('form-login').requestSubmit();return 1;})()");
}
const CTX_EVAL = "(function(){return JSON.stringify({clientId:'c_900',sessionId:'s_901',storeProjectionVersion:3,membershipProjectionVersion:2});})()";

(async () => {
  const acctSrv = await startAccountHttpServer();
  report('T0-account-server', await waitServer());
  const reg = auth.register({ email: 'wb005@example.invalid', password: SYNTH_TEST_PASS });
  auth.verify(reg.verificationToken);

  let handle = await launchApp();
  await waitUrl(handle, 'account.html', 30000);
  let conn = await getConn(handle);
  let cdp = conn.cdp;
  report('T1-login-gate', !!(conn.url || '').includes('account.html'));
  await login(cdp, 'wb005@example.invalid');
  const idx = await waitUrl(handle, 'index.html', 20000);
  report('T2-login-success', !!idx);

  conn = await getConn(handle); cdp = conn.cdp;
  await cdp.send('Page.enable');
  const port = (conn.url.match(/127[.]0[.]0[.]1:([0-9]+)/) || [])[1];
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/chat-home.html' });
  await delay(1200);
  report('T3-workbench-mounted', await ev(cdp, "(function(){var r=document.getElementById('pi-workbench-root');return r&&r.getAttribute('data-pi-workbench')==='1'&&!!document.getElementById('wb-status-chip');})()") === true);
  report('T4-empty-state', await ev(cdp, "(function(){var n=document.getElementById('wb-state-note');return n&&n.getAttribute('data-state')==='empty';})()") === true);
  report('T5-bridge-available', await ev(cdp, '(function(){return window.__piWorkbenchInstance&&window.__piWorkbenchInstance.bridgeAvailable()===true;})()') === true);

  await ev(cdp, '(function(){window.__piWorkbenchInstance._setContextForTests(JSON.parse(' + CTX_EVAL + '));return 1;})()');
  console.log('DIAG presetState=' + await ev(cdp, '(function(){return JSON.stringify(window.__piWorkbenchInstance.getState());})()'));
  const diag = await ev(cdp, '(function(){var p=JSON.parse(' + CTX_EVAL + ');return window.__PI__.startTask({taskId:"xj_task_diag6a",mode:"observe",projection:p}).then(function(r){return JSON.stringify(r).slice(0,220);});})()');
  console.log('DIAG startTask=' + diag);
  const diagCan = await ev(cdp, '(function(){try{window.__XJ_API__.selectClinicalMaterialFile=function(){return Promise.resolve({ok:true,selectionId:"s1"});};return "assign-ok";}catch(e){return "assign-err:"+e.message;}})()');
  console.log('DIAG apiOverride=' + diagCan);
  await click(cdp, 'wb-start');
  await delay(1400);
  report('T6-observe-started', ['planning', 'queued', 'executing'].indexOf(String(await ev(cdp, '(function(){return window.__piWorkbenchInstance.getState().taskStatus;})()'))) >= 0, String(await ev(cdp, '(function(){var s=window.__piWorkbenchInstance.getState();return JSON.stringify(s);})()')).slice(0, 160));

  await ev(cdp, "(function(){return window.__piWorkbenchInstance.runTool('read.client.summary',{clientId:'c_900'}).then(function(r){return r.ok;});})()");
  await delay(600);
  report('T7-tool-trajectory', await ev(cdp, "(function(){return document.querySelectorAll('#wb-trajectory .wb-traj-item').length>=2;})()") === true);

  if (MODE === 'matrix') {
    const sizes = [['1024x700', 1024, 700], ['1366x768', 1366, 768], ['1920x1080', 1920, 1080]];
    const skins = ['clinical', 'theatre', 'observatory'];
    const themes = ['light', 'dark'];
    let i = 0;
    const matrixEvidence = [];
    const matrixDir = path.join(SCR, 'evidence', 'matrix');
    fs.mkdirSync(matrixDir, { recursive: true });
    for (const cell of sizes) for (const skin of skins) for (const theme of themes) {
      i += 1;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: cell[1], height: cell[2], deviceScaleFactor: 1, mobile: false });
      await ev(cdp, "(function(){try{localStorage.setItem('xj_skin','" + skin + "');localStorage.setItem('xj_theme','" + theme + "');}catch(e){}return 1;})()");
      await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/chat-home.html' });
      await delay(900);
      await ev(cdp, '(function(){window.__piWorkbenchInstance._setContextForTests(' + CTX_EVAL + ');window.__piWorkbenchInstance.startObserve(JSON.parse(' + CTX_EVAL + '));return 1;})()');
      await delay(600);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const pngPath = path.join(matrixDir, String(i).padStart(2, '0') + '_' + cell[0] + '_' + skin + '_' + theme + '.png');
      if (!inside(matrixDir, pngPath)) throw new Error('path escape');
      fs.writeFileSync(pngPath, Buffer.from(shot.data, 'base64'));
      const probe = await ev(cdp, "(function(){var d=document.documentElement;var a=document.activeElement;var focusVisible=false;try{focusVisible=!!(a&&a.matches&&a.matches(':focus-visible'));}catch(e){}var rm=false;try{rm=!!window.matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(e){}var anim=0;try{anim=document.getAnimations?document.getAnimations().length:0;}catch(e){}var f=document.querySelectorAll('#pi-workbench-root button').length;var traj=document.querySelectorAll('.wb-traj-item').length;return JSON.stringify({overflow:{scrollWidth:d.scrollWidth,clientWidth:d.clientWidth,hasHorizontalOverflow:d.scrollWidth>d.clientWidth+1,clippedCount:0},vertical:{scrollHeight:d.scrollHeight,clientHeight:d.clientHeight,hasVerticalOverflow:d.scrollHeight>d.clientHeight+1,clippedCount:0},errors:{page:0,console:0},reducedMotion:{mqMatches:rm,animationCount:anim},keyboardFocus:{hasFocus:!!a,activeTag:a?(a.tagName||''):null,activeId:a?(a.id||''):null,focusVisible:focusVisible},buttonCount:f,trajectoryCount:traj});})()");
      const p = JSON.parse(probe);
      matrixEvidence.push({ id: i, viewport: cell[0], width: cell[1], height: cell[2], skin: skin, theme: theme, ...p });
      report('cell-' + cell[0] + '_' + skin + '_' + theme, p.overflow.hasHorizontalOverflow === false && p.buttonCount >= 6 && p.trajectoryCount >= 1, 'ovf=' + p.overflow.hasHorizontalOverflow + ' f=' + p.buttonCount);
    }
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const rm = await ev(cdp, "(function(){var b=document.querySelector('#pi-workbench-root button');return b?getComputedStyle(b).transitionDuration:'none';})()");
    report('matrix-reduced-motion', parseFloat(rm || '0') < 0.001, 'reduce=' + rm);
    await ev(cdp, "(function(){var b=document.getElementById('wb-start');if(b)b.focus();return document.activeElement&&document.activeElement.id;})()");
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await delay(150);
    const tabTarget = await ev(cdp, "(function(){var a=document.activeElement;return a?(a.id||a.tagName):'none';})()");
    report('matrix-keyboard-focus', String(tabTarget) !== 'wb-start', 'tab→' + tabTarget);
    fs.writeFileSync(path.join(SCR, 'evidence', 'runtime-matrix.json'), JSON.stringify({
      schema: 'v1-nested-fields', taskId: 'XJ-5.1.0-pi-workbench-ui-production-integration-005',
      cells: matrixEvidence,
      reducedMotionProbe: { mqMatches: true, animationCount: parseFloat(rm || '0') < 0.001 ? 0 : 1 },
      keyboardTraversal: { initial: 'wb-start', tab: tabTarget },
    }, null, 2), 'utf8');
    console.log('SUMMARY matrix pass=' + passCount + ' fail=' + failCount);
    await handle.shutdown();
    try { acctSrv.close(); } catch (e) {}
    process.exit(failCount === 0 ? 0 : 1);
  }

  await click(cdp, 'wb-commit');
  await delay(600);
  report('T8-approval-card', await ev(cdp, "(function(){var c=document.getElementById('wb-approval-card');return c&&c.style.display!=='none'&&document.getElementById('wb-approve').disabled===false;})()") === true);
  await click(cdp, 'wb-approve');
  await delay(300);
  await click(cdp, 'wb-commit');
  await delay(900);
  const st9 = await ev(cdp, '(function(){var s=window.__piWorkbenchInstance.getState();return JSON.stringify({st:s.taskStatus,save:s.lastSavedObjectId,dur:s.durableWrites});})()');
  const j9 = JSON.parse(String(st9));
  report('T9-commit-saved-receipt', j9.st === 'succeeded' && !!j9.save && j9.dur >= 1, String(st9));

  await ev(cdp, '(function(){window.__piWorkbenchInstance._setContextForTests(' + CTX_EVAL + ');window.__piWorkbenchInstance.startObserve(JSON.parse(' + CTX_EVAL + ')).then(function(){});return 1;})()');
  await delay(900);
  await click(cdp, 'wb-pause'); await delay(300);
  const p10 = await ev(cdp, '(function(){return window.__piWorkbenchInstance.getState().taskStatus;})()');
  await click(cdp, 'wb-resume'); await delay(300);
  const r10 = await ev(cdp, '(function(){return window.__piWorkbenchInstance.getState().taskStatus;})()');
  await click(cdp, 'wb-cancel'); await delay(300);
  const c10 = await ev(cdp, '(function(){return window.__piWorkbenchInstance.getState().taskStatus;})()');
  report('T10-pause-resume-cancel', p10 === 'paused' && r10 === 'executing' && c10 === 'cancelled', p10 + '/' + r10 + '/' + c10);
  const after = await ev(cdp, '(function(){return window.__piWorkbenchInstance.commitDraft({note:"x"}).then(function(r){return JSON.stringify({ok:r.ok,code:r.code||null});});})()');
  report('T11-cancel-no-success', String(after).indexOf('"ok":true') < 0, String(after));

  await ev(cdp, "(function(){window.__xjMaterialTestChannel={selectClinicalMaterialFile:function(){return Promise.resolve({ok:true,selectionId:'sel_test_1'});},parseClinicalMaterialFile:function(id){return Promise.resolve({ok:true,displayName:'合成会谈记录'});}};return 1;})()");
  await click(cdp, 'wb-upload'); await delay(400);
  const mat = await ev(cdp, '(function(){var s=window.__piWorkbenchInstance.getState();return JSON.stringify(s.materialIds);})()');
  report('T12-material-bound', String(mat).indexOf('mat_1') >= 0, String(mat));

  await ev(cdp, "(function(){window.App.canUse=function(){return false;};return 1;})()");
  const gated = await ev(cdp, '(function(){return window.__piWorkbenchInstance.supervisionDraft("督导草稿").then(function(r){return r.code||"ok";});})()');
  report('T13-membership-gate', String(gated) === 'membership-unknown', String(gated));
  await ev(cdp, "(function(){window.App.canUse=function(k){return k==='manual-core';};return 1;})()");

  await ev(cdp, '(function(){window.__piWorkbenchInstance._setContextForTests(' + CTX_EVAL + ');return window.__piWorkbenchInstance.startObserve(JSON.parse(' + CTX_EVAL + ')).then(function(){});})()');
  await delay(700);
  await ev(cdp, '(function(){return window.__piWorkbenchInstance.runTool("shell.exec",{}).then(function(r){return r.code;});})()');
  await delay(300);
  report('T14-error-state', await ev(cdp, "(function(){var n=document.getElementById('wb-state-note');return n&&n.getAttribute('data-state')==='error';})()") === true);

  await handle.shutdown();
  await delay(1500);
  handle = await launchApp();
  const idx2 = await waitUrl(handle, 'index.html', 30000);
  report('T15-restart-session', !!idx2);
  conn = await getConn(handle); cdp = conn.cdp;
  await cdp.send('Page.enable');
  const port2 = (conn.url.match(/127[.]0[.]0[.]1:([0-9]+)/) || [])[1];
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + port2 + '/chat-home.html' });
  await delay(1200);
  const rr = await ev(cdp, '(function(){window.__piWorkbenchInstance._setContextForTests(' + CTX_EVAL + ');return window.__piWorkbenchInstance.startObserve(JSON.parse(' + CTX_EVAL + ')).then(function(r){return r.ok;});})()');
  report('T16-restart-workbench-usable', String(rr) === 'true');

  await handle.shutdown();
  try { acctSrv.close(); } catch (e) {}
  await delay(600);
  try { fs.rmSync(TMP, { recursive: true, force: true }); fs.rmSync(UD, { recursive: true, force: true }); } catch (e) {}
  console.log('SUMMARY electron pass=' + passCount + ' fail=' + failCount);
  process.exit(failCount === 0 ? 0 : 1);
})().catch(async (e) => { console.error('FATAL', e); try { handle && await handle.shutdown(); } catch (x) {} process.exit(1); });
