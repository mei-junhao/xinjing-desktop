'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const harness = require('D:/xinjing-electron/qa/task-scratch/XJ-5.0.2-account-auth-desktop-enforcement-008/harness-lib.js');

const ROOT = 'D:/xinjing-electron';
const TEST_DIR = __dirname;
const EVIDENCE = path.join(ROOT, 'qa/task-scratch/XJ-5.1.0-pi-supervision-broker-production-wiring-041/evidence');
const SCREENSHOTS = path.join(EVIDENCE, 'screenshots');
fs.mkdirSync(SCREENSHOTS, { recursive: true });
let pass = 0;
let fail = 0;
const records = [];
function report(id, ok, detail) {
  records.push({ id, ok, detail: detail === undefined ? null : detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (detail ? ' :: ' + detail : ''));
  ok ? pass += 1 : fail += 1;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function pageFor(handle, timeoutMs) {
  const end = Date.now() + (timeoutMs || 30000);
  while (Date.now() < end) {
    try {
      const list = await harness.getJson('http://127.0.0.1:' + handle.debugPort + '/json/list', 2000);
      const page = list.find((x) => x.type === 'page' && /harness\.html/.test(x.url || ''));
      if (page) return page;
    } catch (_) {}
    await wait(150);
  }
  return null;
}
async function ev(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'CDP evaluate failed');
  return result.result.value;
}
async function connect(handle) {
  const page = await pageFor(handle);
  if (!page) return null;
  const cdp = await harness.connectCdp(page.webSocketDebuggerUrl);
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    try { if (await ev(cdp, 'typeof window.__PITEST__ === "object"')) return { page, cdp }; } catch (_) {}
    await wait(150);
  }
  cdp.close();
  return null;
}
async function launch(userData, env) {
  return harness.launchElectron({
    mainJs: path.join(TEST_DIR, 'test-electron-main.js'),
    userData,
    env: Object.assign({ ELECTRON_ENABLE_LOGGING: '0', XJ_AGENT_ACCEPTANCE_USER_DATA: userData || '' }, env || {}),
  });
}
function shaFile(file) { const bytes = fs.readFileSync(file); return { sha256: crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase(), bytes: bytes.length }; }

async function mainFlow() {
  const userData = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-041-ui-'));
  const handle = await launch(userData, { XJ_PI_TEST_MEMBERSHIP: 'pro' });
  const conn = await connect(handle);
  report('E01-electron-boot', !!conn);
  if (!conn) { await handle.shutdown(); return; }
  const cdp = conn.cdp;
  let pageErrors = 0; let consoleErrors = 0;
  await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
  cdp.on('Runtime.exceptionThrown', () => { pageErrors += 1; });
  cdp.on('Log.entryAdded', (event) => { if (event && event.entry && event.entry.level === 'error') consoleErrors += 1; });
  report('E02-preload-whitelist', await ev(cdp, 'typeof window.__PI__ === "object" && window.__PI__.__raw === undefined && typeof window.__XJ_API__.piTransport === "object"'));
  const keys = await ev(cdp, 'JSON.stringify(window.__PITEST__.keys())');
  report('E03-no-raw-ipc', JSON.parse(keys).raw === undefined, keys);
  const start = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.start("supervision","xj_task_041_runtime")))()'));
  report('E04-published-startTask', start.ok === true, JSON.stringify(start));
  const context = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.context("xj_task_041_runtime")))()'));
  report('E05-contextCheck', context.ok === true, JSON.stringify(context));
  const plan = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.plan("xj_task_041_runtime")))()'));
  report('E06-plan', plan.ok === true, JSON.stringify(plan));
  const read = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.read("xj_task_041_runtime")))()'));
  report('E07-read-broker', read.ok === true && read.result && read.result.data && read.result.data.summary, JSON.stringify(read));
  const supervision = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.supervision("xj_task_041_runtime")))()'));
  report('E08-supervision-draft', supervision.ok === true && supervision.result && supervision.result.draft, JSON.stringify(supervision));
  const command = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.command("xj_task_041_runtime")))()'));
  report('E09-command-broker', command.ok === true, JSON.stringify(command));
  const tamper = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.tamper()))()'));
  report('E10-request-tamper-blocked', tamper.code === 'XJ_PI_SNAPSHOT_MISMATCH', JSON.stringify(tamper));
  const malformed = JSON.parse(await ev(cdp, '(async()=>{window.__PITEST__.malformed();return JSON.stringify(await window.__PI__.startTask({taskId:"xj_task_041_after_bad",mode:"observe",projection:window.__PITEST__.projection()}));})()'));
  report('E11-malformed-publication-clears', malformed.code === 'XJ_PI_SNAPSHOT_MISMATCH', JSON.stringify(malformed));
  await ev(cdp, 'window.__PITEST__.restore()');
  const commitStart = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.start("commit","xj_task_041_commit")))()'));
  const commit = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.commit("xj_task_041_commit")))()'));
  report('E12-approval-durable-verify', commitStart.ok === true && commit.ok === true && !!commit.savedObjectId, JSON.stringify(commit));
  const failWrite = JSON.parse(await ev(cdp, '(async()=>{await window.__PITEST__.start("commit","xj_task_041_fail");window.__PITEST__.failWrite();return JSON.stringify(await window.__PITEST__.commit("xj_task_041_fail"));})()'));
  report('E13-durable-failure-propagates', failWrite.ok === false && failWrite.code === 'XJ_PI_DIRECT_WRITE_DENIED', JSON.stringify(failWrite));
  const life = JSON.parse(await ev(cdp, '(async()=>{await window.__PITEST__.start("observe","xj_task_041_life");return JSON.stringify(await window.__PITEST__.pauseResumeCancel("xj_task_041_life"));})()'));
  report('E14-pause-resume-cancel', life.paused.ok === true && life.resumed.ok === true && life.cancelled.ok === true && life.after.code === 'XJ_PI_WRITE_AFTER_CANCEL', JSON.stringify(life));
  const network = await ev(cdp, 'window.__PITEST__.network()');
  report('E15-default-network-deny', network === 'network-denied', String(network));

  pageErrors = 0; consoleErrors = 0;
  const matrix = []; let cell = 0;
  for (const [label, width, height] of [['1024x700', 1024, 700], ['1366x768', 1366, 768], ['1920x1080', 1920, 1080]]) {
    for (const skin of ['clinical', 'theatre', 'observatory']) {
      for (const theme of ['light', 'dark']) {
        cell += 1;
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        await ev(cdp, "document.getElementById('start').focus();");
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        const probe = await ev(cdp, `(function(){document.documentElement.dataset.skin='${skin}';document.documentElement.classList.toggle('dark','${theme}'==='dark');var d=document.documentElement,a=document.activeElement;return {viewport:{width:${width},height:${height}},skin:'${skin}',theme:'${theme}',overflow:{horizontal:{scrollWidth:d.scrollWidth,clientWidth:d.clientWidth,hasHorizontalOverflow:d.scrollWidth>d.clientWidth+1},vertical:{scrollHeight:d.scrollHeight,clientHeight:d.clientHeight,hasVerticalOverflow:d.scrollHeight>d.clientHeight+1}},errors:{page:${pageErrors},console:${consoleErrors}},reducedMotion:{mqMatches:matchMedia('(prefers-reduced-motion: reduce)').matches,animationCount:document.getAnimations?document.getAnimations().length:0},keyboardFocus:{hasFocus:!!a,activeTag:a&&a.tagName||'',activeId:a&&a.id||'',focusVisible:!!(a&&a.matches&&a.matches(':focus-visible'))},longChinese:(document.getElementById('long-cn')||{}).textContent||'',pageLabel:document.title};})()`);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        const file = path.join(SCREENSHOTS, String(cell).padStart(2, '0') + '-' + label + '-' + skin + '-' + theme + '.png');
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        const digest = shaFile(file);
        probe.screenshot = { path: file, sha256: digest.sha256, bytes: digest.bytes };
        matrix.push(probe);
        report('E16-cell-' + String(cell).padStart(2, '0'), probe.overflow.horizontal.hasHorizontalOverflow === false && probe.overflow.vertical.hasVerticalOverflow === false && probe.errors.page === 0 && probe.errors.console === 0 && probe.reducedMotion.mqMatches === true && probe.reducedMotion.animationCount === 0 && probe.keyboardFocus.hasFocus === true, JSON.stringify(probe));
      }
    }
  }
  fs.writeFileSync(path.join(EVIDENCE, 'electron-matrix.json'), JSON.stringify({ schema: 'v1-nested-fields', taskId: 'XJ-5.1.0-pi-supervision-broker-production-wiring-041', cells: matrix }, null, 2), 'utf8');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  cdp.close();
  const shutdown = await handle.shutdown();
  report('E17-first-shutdown', shutdown.exited === true, JSON.stringify(shutdown));
  const second = await launch(userData, { XJ_PI_TEST_MEMBERSHIP: 'pro' });
  const conn2 = await connect(second);
  const restart = conn2 ? JSON.parse(await ev(conn2.cdp, '(async()=>JSON.stringify(await window.__PITEST__.start("observe","xj_task_041_restart")))()')) : { ok: false };
  report('E18-restart-replay-start', restart.ok === true, JSON.stringify(restart));
  if (conn2) conn2.cdp.close();
  await second.shutdown();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
}

async function membershipUnknownFlow() {
  const h = await launch(undefined, { XJ_PI_TEST_MEMBERSHIP: 'unknown' });
  const conn = await connect(h);
  if (!conn) { report('E19-membership-unknown-boot', false); await h.shutdown(); return; }
  const result = JSON.parse(await ev(conn.cdp, '(async()=>{await window.__PITEST__.start("observe","xj_task_041_unknown");return JSON.stringify(await window.__PITEST__.read("xj_task_041_unknown"));})()'));
  report('E19-membership-unknown-fail-closed', result.code === 'XJ_PI_MEMBERSHIP_UNKNOWN', JSON.stringify(result));
  conn.cdp.close(); await h.shutdown();
}

async function badReplayFlow() {
  const userData = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-041-bad-replay-'));
  fs.writeFileSync(path.join(userData, 'pi-events-v1.jsonl'), '{broken-json\n', 'utf8');
  const h = await launch(userData, { XJ_PI_TEST_MEMBERSHIP: 'pro' });
  const conn = await connect(h);
  if (!conn) { report('E20-bad-replay-boot', false); await h.shutdown(); return; }
  const result = JSON.parse(await ev(conn.cdp, '(async()=>JSON.stringify(await window.__PITEST__.start("observe","xj_task_041_bad_replay")))()'));
  report('E20-bad-replay-runtime-disabled', result.code === 'XJ_PI_EVENT_VERSION', JSON.stringify(result));
  conn.cdp.close(); await h.shutdown();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  await mainFlow();
  await membershipUnknownFlow();
  await badReplayFlow();
  fs.writeFileSync(path.join(EVIDENCE, 'electron-results.json'), JSON.stringify({ schema: 'pi-production-041-electron-v1', taskId: 'XJ-5.1.0-pi-supervision-broker-production-wiring-041', pass, fail, records }, null, 2), 'utf8');
  console.log('ELECTRON ' + pass + ' PASS / ' + fail + ' FAIL');
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => { console.error('FATAL', error.stack || error); process.exit(1); });
