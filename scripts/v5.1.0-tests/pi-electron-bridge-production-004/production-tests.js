'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const harness = require('D:/xinjing-electron/qa/task-scratch/XJ-5.0.2-account-auth-desktop-enforcement-008/harness-lib.js');

const TEST_DIR = __dirname;
const SCRATCH = path.join('D:/xinjing-electron/qa/task-scratch/XJ-5.1.0-pi-electron-bridge-production-installation-004');
const EVIDENCE = path.join(SCRATCH, 'evidence');
const SCREENSHOTS = path.join(EVIDENCE, 'screenshots');
fs.mkdirSync(EVIDENCE, { recursive: true });
fs.mkdirSync(SCREENSHOTS, { recursive: true });
let pass = 0;
let fail = 0;
function report(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
  if (ok) pass += 1; else fail += 1;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitHarness(handle, timeoutMs) {
  const end = Date.now() + (timeoutMs || 30000);
  while (Date.now() < end) {
    try {
      const list = await harness.getJson('http://127.0.0.1:' + handle.debugPort + '/json/list', 2000);
      const page = list.find((item) => item.type === 'page' && /harness.*\.html/.test(item.url || ''));
      if (page) return page;
    } catch (_) {}
    await delay(200);
  }
  return null;
}
async function ev(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'CDP evaluation failed');
  return result.result.value;
}
async function connectReady(page) {
  const cdp = await harness.connectCdp(page.webSocketDebuggerUrl);
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try {
      if (await ev(cdp, "typeof window.__PITEST__ === 'object' && typeof window.__PI__ === 'object'")) return cdp;
    } catch (_) {}
    await delay(150);
  }
  cdp.close();
  throw new Error('production harness did not initialize');
}
async function launch(userData, env) {
  return harness.launchElectron({
    mainJs: path.join(TEST_DIR, 'test-electron-main.js'),
    userData,
    env: Object.assign({ ELECTRON_ENABLE_LOGGING: '0' }, env || {}),
  });
}
async function productionAnonymousGate() {
  const h = await harness.launchElectron({ env: { ELECTRON_ENABLE_LOGGING: '0' } });
  const page = await h.waitForPage(30000);
  report('P1-production-root-boot', !!page, page ? page.url : 'no page');
  if (page) {
    const cdp = await harness.connectCdp(page.webSocketDebuggerUrl);
    const probe = JSON.parse(await ev(cdp, 'JSON.stringify({href:location.href,pi:typeof window.__PI__,raw:window.__PI__&&window.__PI__.__raw,xj:typeof window.__XJ_API__})'));
    report('P2-anonymous-account-gate', /account\.html/.test(probe.href), probe.href);
    report('P3-production-sandbox-preload', probe.pi === 'object' && probe.xj === 'object' && probe.raw === undefined, JSON.stringify(probe));
    const network = await ev(cdp, "(async function(){try{await fetch('https://example.com');return 'open';}catch(e){return 'denied';}})()");
    report('P4-default-network-deny', network === 'denied', String(network));
    cdp.close();
  }
  const result = await h.shutdown();
  report('P5-production-bridge-init', !/production bridge initialization failed/.test(result.outputTail), result.outputTail.slice(-240));
}
async function runtimeFlow() {
  const userData = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-004-runtime-'));
  const h = await launch(userData, { XJ_PI_TEST_MEMBERSHIP: 'pro' });
  const page = await waitHarness(h, 30000);
  report('R1-runtime-harness-boot', !!page, page ? page.url : 'no page');
  if (!page) { await h.shutdown(); return; }
  const cdp = await connectReady(page);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  let pageErrorCount = 0;
  let consoleErrorCount = 0;
  cdp.on('Runtime.exceptionThrown', () => { pageErrorCount += 1; });
  cdp.on('Log.entryAdded', (event) => {
    if (event && event.entry && event.entry.level === 'error') consoleErrorCount += 1;
  });
  const keys = JSON.parse(await ev(cdp, 'JSON.stringify(window.__PITEST__.keys())'));
  report('R2-versioned-preload-whitelist', keys.pi.indexOf('startTask') >= 0 && keys.raw === undefined, JSON.stringify(keys));
  const started = JSON.parse(await ev(cdp, "(async()=>JSON.stringify(await window.__PITEST__.start('commit')))()"));
  report('R3-observe-draft-intake', started.ok === true && started.task && started.task.clinicalContext, JSON.stringify(started).slice(0, 180));
  const read = JSON.parse(await ev(cdp, "(async()=>JSON.stringify(await window.__PITEST__.read()))()"));
  report('R4-read-broker', read.ok === true, JSON.stringify(read).slice(0, 180));
  const commit = JSON.parse(await ev(cdp, "(async()=>JSON.stringify(await window.__PITEST__.commit()))()"));
  report('R5-approval-durable-verify', commit.ok === true && commit.savedObjectId, JSON.stringify(commit).slice(0, 220));
  const driftStart = JSON.parse(await ev(cdp, "(async()=>JSON.stringify(await window.__PITEST__.start('observe','xj_task_004_drift')))()"));
  const drift = JSON.parse(await ev(cdp, "(async()=>JSON.stringify(await window.__PITEST__.drift('xj_task_004_drift')))()"));
  report('R6-context-drift-fail-closed', driftStart.ok === true && drift.ok === false && drift.code === 'XJ_PI_SNAPSHOT_MISMATCH', JSON.stringify(drift));
  // 新任务用于验证 durable {ok:false} 原样传播。
  const start2 = JSON.parse(await ev(cdp, "(async()=>JSON.stringify(await window.__PITEST__.start('commit','xj_task_004_fail')) )()"));
  const failWrite = JSON.parse(await ev(cdp, "(async()=>{window.__PITEST__.failWrite();var r=await window.__PI__.commitStep('xj_task_004_fail',{kind:'session',clientId:'c_004',sessionId:'s_004'},{note:'fail'});if(r&&r.awaiting){await window.__PI__.resolveApproval(r.pendingApprovalId,'approved','local-user');r=await window.__PI__.commitStep('xj_task_004_fail',{kind:'session',clientId:'c_004',sessionId:'s_004'},{note:'fail'});}return JSON.stringify(r);})()"));
  report('R7-durable-ok-false-propagation', start2.ok === true && failWrite.ok === false && failWrite.code === 'XJ_PI_DIRECT_WRITE_DENIED', JSON.stringify(failWrite));
  const lifecycle = JSON.parse(await ev(cdp, "(async()=>{var r=await window.__PITEST__.start('observe','xj_task_004_lifecycle');return JSON.stringify(await window.__PITEST__.pauseResumeCancel('xj_task_004_lifecycle'));})()"));
  report('R8-pause-resume-cancel', lifecycle.paused.ok === true && lifecycle.resumed.ok === true && lifecycle.cancelled.ok === true && lifecycle.after.code === 'XJ_PI_WRITE_AFTER_CANCEL', JSON.stringify(lifecycle));
  const network = await ev(cdp, "(async()=>window.__PITEST__.network())()");
  report('R9-runtime-network-deny', network === 'network-denied', String(network));
  // 网络拒绝探针会由 Chromium 以 CSP 违规日志回显；它属于本项已验证的
  // 预期拒网证据，不应污染随后 18-cell 页面错误计数。
  pageErrorCount = 0;
  consoleErrorCount = 0;
  const matrix = [];
  const screenshotManifest = [];
  async function keyPress(key, code, modifiers) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers: modifiers || 0, windowsVirtualKeyCode: code === 'Tab' ? 9 : (code === 'Escape' ? 27 : 13) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers: modifiers || 0, windowsVirtualKeyCode: code === 'Tab' ? 9 : (code === 'Escape' ? 27 : 13) });
  }
  async function keyboardEvidence() {
    await ev(cdp, "document.getElementById('start').focus();");
    const activeIds = [];
    activeIds.push(await ev(cdp, "document.activeElement && document.activeElement.id || ''"));
    await keyPress('Tab', 'Tab');
    activeIds.push(await ev(cdp, "document.activeElement && document.activeElement.id || ''"));
    await keyPress('Tab', 'Tab');
    activeIds.push(await ev(cdp, "document.activeElement && document.activeElement.id || ''"));
    await keyPress('Tab', 'Tab');
    activeIds.push(await ev(cdp, "document.activeElement && document.activeElement.id || ''"));
    await keyPress('Tab', 'Tab', 8);
    activeIds.push(await ev(cdp, "document.activeElement && document.activeElement.id || ''"));
    await keyPress('Escape', 'Escape');
    const final = await ev(cdp, "({tag:document.activeElement && document.activeElement.tagName || '',id:document.activeElement && document.activeElement.id || '',visible:!!(document.activeElement && document.activeElement.matches(':focus-visible'))})");
    return { sequence: ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Escape'], activeIds, final };
  }
  const sizes = [['1024x700', 1024, 700], ['1366x768', 1366, 768], ['1920x1080', 1920, 1080]];
  const skins = ['clinical', 'theatre', 'observatory'];
  const themes = ['light', 'dark'];
  let idx = 0;
  for (const [label, width, height] of sizes) {
    for (const skin of skins) {
      for (const theme of themes) {
        idx += 1;
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        const keyboard = await keyboardEvidence();
        const probe = JSON.parse(await ev(cdp, `(function(){document.documentElement.dataset.skin='${skin}';document.documentElement.classList.toggle('dark','${theme}'==='dark');var d=document.documentElement;var states=['empty-state','loading-state','error-state'].map(function(id){var e=document.getElementById(id);return {id:id,present:!!e,visible:!!(e&&e.getBoundingClientRect().width)};});return JSON.stringify({label:'${label}',skin:'${skin}',theme:'${theme}',viewport:{width:${width},height:${height}},overflow:{horizontal:{scrollWidth:d.scrollWidth,clientWidth:d.clientWidth,hasHorizontalOverflow:d.scrollWidth>d.clientWidth+1},vertical:{scrollHeight:d.scrollHeight,clientHeight:d.clientHeight,hasVerticalOverflow:d.scrollHeight>d.clientHeight+1}},errors:{page:0,console:0},reducedMotion:{mqMatches:window.matchMedia('(prefers-reduced-motion: reduce)').matches,animationCount:document.getAnimations?document.getAnimations().length:0},keyboardFocus:{hasFocus:!!document.activeElement,activeTag:document.activeElement&&document.activeElement.tagName||'',activeId:document.activeElement&&document.activeElement.id||'',focusVisible:!!(document.activeElement&&document.activeElement.matches(':focus-visible')),keyboardTraversal:${JSON.stringify(keyboard)}},states:states,buttons:document.querySelectorAll('button').length,longChinese:(document.getElementById('long-cn')||{}).textContent||'',pageLabel:document.title});})()`));
        probe.errors.page = pageErrorCount;
        probe.errors.console = consoleErrorCount;
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        const shotName = String(idx).padStart(2, '0') + '-' + label + '-' + skin + '-' + theme + '.png';
        const shotPath = path.join(SCREENSHOTS, shotName);
        const shotBytes = Buffer.from(shot.data, 'base64');
        fs.writeFileSync(shotPath, shotBytes);
        const shotSha = require('crypto').createHash('sha256').update(shotBytes).digest('hex');
        probe.screenshot = { path: shotPath, sha256: shotSha, bytes: shotBytes.length };
        screenshotManifest.push({ cell: idx, label, skin, theme, path: shotPath, sha256: shotSha, bytes: shotBytes.length });
        matrix.push(probe);
        report('R10-cell-' + String(idx).padStart(2, '0'), probe.overflow.horizontal.hasHorizontalOverflow === false && probe.overflow.vertical.hasVerticalOverflow === false && probe.buttons >= 10 && probe.errors.page === 0 && probe.errors.console === 0 && probe.reducedMotion.mqMatches === true && probe.reducedMotion.animationCount === 0 && probe.keyboardFocus.hasFocus === true && probe.states.every((s) => s.present), JSON.stringify({ label, skin, theme, overflow: probe.overflow, errors: probe.errors, reducedMotion: probe.reducedMotion, focus: probe.keyboardFocus, screenshot: probe.screenshot }));
      }
    }
  }
  fs.writeFileSync(path.join(EVIDENCE, 'matrix.json'), JSON.stringify(matrix, null, 2), 'utf8');
  fs.writeFileSync(path.join(EVIDENCE, 'screenshot-manifest.json'), JSON.stringify({ version: '004-visual-v2', cells: screenshotManifest }, null, 2), 'utf8');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const motionProbe = JSON.parse(await ev(cdp, "JSON.stringify({reduce:false,mqMatches:window.matchMedia('(prefers-reduced-motion: reduce)').matches,animationCount:document.getAnimations?document.getAnimations().length:0})"));
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reducedMotionProbe = JSON.parse(await ev(cdp, "JSON.stringify({reduce:true,mqMatches:window.matchMedia('(prefers-reduced-motion: reduce)').matches,animationCount:document.getAnimations?document.getAnimations().length:0})"));
  fs.writeFileSync(path.join(EVIDENCE, 'motion-probe.json'), JSON.stringify({ noPreference: motionProbe, reduced: reducedMotionProbe }, null, 2), 'utf8');
  cdp.close();
  const firstShutdown = await h.shutdown();
  report('R11-restart-first-shutdown', firstShutdown.exited === true, JSON.stringify(firstShutdown));

  const h2 = await launch(userData, { XJ_PI_TEST_MEMBERSHIP: 'pro' });
  const page2 = await waitHarness(h2, 30000);
  report('R12-restart-replay-boot', !!page2, page2 ? page2.url : 'no page');
  if (page2) {
    const cdp2 = await connectReady(page2);
    const afterRestart = JSON.parse(await ev(cdp2, "(async()=>JSON.stringify(await window.__PITEST__.start('observe','xj_task_004_after_restart')))()"));
    report('R13-restart-new-task', afterRestart.ok === true, JSON.stringify(afterRestart).slice(0, 180));
    cdp2.close();
  }
  await h2.shutdown();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
}
async function appTransportFlow() {
  const h = await launch(undefined, { XJ_PI_TEST_PAGE: 'harness-app-transport.html', XJ_PI_TEST_MEMBERSHIP: 'pro' });
  const page = await waitHarness(h, 30000);
  report('A1-appjs-transport-boot', !!page, page ? page.url : 'no page');
  if (!page) { await h.shutdown(); return; }
  const cdp = await harness.connectCdp(page.webSocketDebuggerUrl);
  await delay(700);
  const result = JSON.parse(await ev(cdp, "window.__APPTEST__.run().then(function(x){return JSON.stringify(x);})"));
  report('A2-appjs-store-durable-write', result.start.ok === true && result.done.ok === true && result.saveCalls === 1 && result.piRuntime === 'object', JSON.stringify(result).slice(0, 260));
  const failed = JSON.parse(await ev(cdp, "window.__APPTEST__.fail().then(function(x){return JSON.stringify(x);})"));
  report('A3-appjs-ok-false-propagation', failed.start.ok === true && failed.done.ok === false && failed.done.code === 'XJ_TEST_STORE_FAILURE' && failed.saveCalls === 2, JSON.stringify(failed));
  cdp.close();
  await h.shutdown();
}
async function membershipUnknown() {
  const h = await launch(undefined, { XJ_PI_TEST_MEMBERSHIP: 'unknown' });
  const page = await waitHarness(h, 30000);
  if (!page) { report('M1-membership-unknown', false, 'no page'); await h.shutdown(); return; }
  const cdp = await connectReady(page);
  const result = JSON.parse(await ev(cdp, "(async()=>{var r=await window.__PITEST__.start('observe','xj_task_004_unknown');var x=await window.__PI__.runToolStep('xj_task_004_unknown',{tool:'read.client.summary',args:{clientId:'c_004'}});return JSON.stringify({start:r,read:x});})()"));
  report('M1-membership-unknown-fail-closed', result.start.ok === true && result.read.code === 'XJ_PI_MEMBERSHIP_UNKNOWN', JSON.stringify(result));
  cdp.close(); await h.shutdown();
}
async function badLog() {
  const userData = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-004-badlog-'));
  fs.writeFileSync(path.join(userData, 'pi-events-v1.jsonl'), '{bad-json\n', 'utf8');
  const h = await launch(userData, { XJ_PI_TEST_MEMBERSHIP: 'pro' });
  const page = await waitHarness(h, 30000);
  if (!page) { report('B1-bad-log-boot', false, 'no page'); await h.shutdown(); return; }
  const cdp = await connectReady(page);
  const result = JSON.parse(await ev(cdp, "(async()=>JSON.stringify(await window.__PITEST__.start('observe','xj_task_004_badlog')))()"));
  report('B1-bad-log-replay-fail-closed', result.ok === false && result.code === 'XJ_PI_EVENT_VERSION', JSON.stringify(result));
  cdp.close(); await h.shutdown(); try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  await productionAnonymousGate();
  await membershipUnknown();
  await runtimeFlow();
  await appTransportFlow();
  await badLog();
  console.log('SUMMARY production-004 pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e.stack || e); process.exit(1); });
