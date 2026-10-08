'use strict';
/**
 * XJ-5.1.0-...-003 — 真实 Electron 桥接集成测试
 * 复用 008 harness-lib.launchElectron（CDP 驱动）+ 本目录测试 main/harness 页。
 * 模式：default（功能闭环）| matrix（18-cell 截图）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const harness = require('D:/xinjing-electron/qa/task-scratch/XJ-5.0.2-account-auth-desktop-enforcement-008/harness-lib.js');

const TEST_DIR = __dirname;
const MODE = process.argv[2] || 'default';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let passCount = 0, failCount = 0;
function report(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
  if (ok) passCount++; else failCount++;
}
const OUT = path.join('D:/xinjing-electron/qa/task-scratch/XJ-5.1.0-pi-electron-bridge-runtime-integration-003', 'evidence');
if (MODE === 'matrix') fs.mkdirSync(path.join(OUT, 'matrix'), { recursive: true });

async function launch() {
  const userData = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-003-el-'));
  return harness.launchElectron({ mainJs: path.join(TEST_DIR, 'test-electron-main.js'), userData, env: { ELECTRON_ENABLE_LOGGING: '0' } });
}
/** harness 页为 file://（harness-lib 的 waitForPage 只认 http loopback）——自轮询 CDP 目标 */
async function waitHarnessPage(handle, timeoutMs) {
  const end = Date.now() + (timeoutMs || 30000);
  while (Date.now() < end) {
    try {
      const ts = await harness.getJson('http://127.0.0.1:' + handle.debugPort + '/json/list', 2000);
      const pg = ts.find((t) => t.type === 'page' && /harness\.html/.test(t.url || ''));
      if (pg) return pg;
    } catch (e) { /* retry */ }
    await delay(300);
  }
  return null;
}
async function ev(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.exceptionDetails ? 'EXC:' + r.exceptionDetails.text : r.result.value;
}
async function click(cdp, id) { return ev(cdp, `(function(){var b=document.getElementById('${id}');if(b)b.click();return b?'clicked':'missing';})()`); }

(async () => {
  let handle = await launch();
  let page = await waitHarnessPage(handle, 30000);
  report('E1-harness-boot', !!page, page ? page.url.slice(-40) : 'no page');
  if (!page) { await handle.shutdown(); process.exit(1); }
  const cdp = await harness.connectCdp(page.webSocketDebuggerUrl);
  await delay(500);

  if (MODE === 'matrix') {
    const sizes = [['1024x700', 1024, 700], ['1366x768', 1366, 768], ['1920x1080', 1920, 1080]];
    const skins = ['clinical', 'theatre', 'observatory'];
    const themes = ['light', 'dark'];
    let idx = 0;
    for (const cell of sizes) {
      for (const skin of skins) {
        for (const theme of themes) {
          idx += 1;
          await cdp.send('Emulation.setDeviceMetricsOverride', { width: cell[1], height: cell[2], deviceScaleFactor: 1, mobile: false });
          await ev(cdp, `(function(){document.documentElement.setAttribute('data-skin','${skin}');document.documentElement.classList.toggle('dark','${theme}'==='dark');return 1;})()`);
          await click(cdp, 'b-start');
          await delay(250);
          const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(path.join(OUT, 'matrix', String(idx).padStart(2, '0') + '_' + cell[0] + '_' + skin + '_' + theme + '.png'), Buffer.from(shot.data, 'base64'));
          const probe = await ev(cdp, `(function(){var d=document.documentElement;var btns=document.querySelectorAll('button');return JSON.stringify({overflowX:d.scrollWidth>d.clientWidth+1,btnCount:btns.length});})()`);
          const p = JSON.parse(probe);
          report('cell-' + cell[0] + '_' + skin + '_' + theme, p.overflowX === false && p.btnCount >= 8, 'ovf=' + p.overflowX + ' btns=' + p.btnCount);
        }
      }
    }
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const rm = await ev(cdp, "(function(){var b=document.querySelector('button');return b?getComputedStyle(b).transitionDuration:'none';})()");
    report('matrix-reduced-motion', parseFloat(rm || '0') < 0.001, 'reduce=' + rm);
    console.log('SUMMARY matrix pass=' + passCount + ' fail=' + failCount);
    cdp.close();
    await handle.shutdown();
    process.exit(failCount === 0 ? 0 : 1);
  }

  report('E2-preload-api', await ev(cdp, "(function(){return typeof window.__PI__==='object'&&typeof window.__PI__.startTask==='function'&&window.__PI__.__raw===undefined?'ok':'bad';})()") === 'ok');

  await click(cdp, 'b-start');
  await delay(300);
  report('E3-start-observe', (await ev(cdp, "(function(){return document.getElementById('task-title').textContent;})()")).indexOf('观察任务') >= 0);
  await click(cdp, 'b-read');
  await delay(250);
  report('E4-read-tool', await ev(cdp, "(function(){return document.getElementById('msg').textContent.indexOf('ok')>=0?'read-ok':'read-fail';})()") === 'read-ok');

  await click(cdp, 'b-commit');
  await delay(300);
  report('E5-awaiting-approval', await ev(cdp, "(function(){return document.getElementById('phase-chip').textContent;})()") === 'AWAITING_CONFIRMATION');
  await click(cdp, 'b-approve');
  await delay(200);
  await click(cdp, 'b-commit');
  await delay(400);
  report('E6-commit-saved', await ev(cdp, "(function(){var m=document.getElementById('msg').textContent;return m.indexOf('savedObjectId')>=0;})()"));

  const r7 = await ev(cdp, "(async function(){var p=await window.__PITEST__.projection();return JSON.stringify(await window.__PI__.startTask({taskId:'xj_task_harness_1',mode:'observe',projection:p}));})()");
  report('E7-replay-taskid-denied', String(r7).indexOf('XJ_PI_TASK_ID_REPLAY') >= 0, String(r7).slice(0, 80));

  const r8 = await ev(cdp, "(async function(){var p=await window.__PITEST__.projection();var c=await window.__PI__.startTask({taskId:'xj_task_harness_1b',mode:'observe',projection:p});var paused=await window.__PI__.pause('xj_task_harness_1b','user');var mid=await window.__PI__.runToolStep('xj_task_harness_1b',{tool:'read.task.cards',args:{}});var resumed=await window.__PI__.resume('xj_task_harness_1b');var after=await window.__PI__.runToolStep('xj_task_harness_1b',{tool:'read.task.cards',args:{}});return JSON.stringify({created:c.ok,pausedOk:paused.ok,blockedWhilePaused:mid.code,resumedOk:resumed.ok,afterOk:after.ok});})()");
  const j8 = JSON.parse(String(r8));
  report('E8-pause-resume', j8.created === true && j8.pausedOk === true && j8.blockedWhilePaused === 'XJ_PI_WRITE_AFTER_CANCEL' && j8.resumedOk === true && j8.afterOk === true, String(r8));

  const r9 = await ev(cdp, "(async function(){var r=await window.__PI__.runToolStep('xj_task_harness_1b',{tool:'shell.exec',args:{}});return r.code||'ok';})()");
  report('E9-unknown-tool-error', String(r9) === 'XJ_PI_UNKNOWN_TOOL', String(r9));

  const r10 = await ev(cdp, "(async function(){var p=await window.__PITEST__.projection();return JSON.stringify(await window.__PI__.startTask({taskId:'xj_task_harness_2',mode:'commit',projection:p}));})()");
  report('E10-start-task2', String(r10).indexOf('"ok"') >= 0);
  await ev(cdp, "(async function(){return JSON.stringify(await window.__PI__.cancel('xj_task_harness_2','user'));})()");
  await delay(200);
  const r11 = await ev(cdp, "(async function(){return JSON.stringify(await window.__PI__.runToolStep('xj_task_harness_2',{tool:'read.task.cards',args:{}}));})()");
  report('E11-write-after-cancel-denied', String(r11).indexOf('XJ_PI_WRITE_AFTER_CANCEL') >= 0);

  // 重启：新实例（新 userData）→ 旧任务不可见（fail-closed）+ 新任务可用
  cdp.close();
  await handle.shutdown();
  handle = await launch();
  page = await waitHarnessPage(handle, 30000);
  report('E12-restart-boot', !!page);
  const cdp2 = await harness.connectCdp(page.webSocketDebuggerUrl);
  await delay(500);
  const r13 = await ev(cdp2, "(async function(){return JSON.stringify(await window.__PI__.diagnose('xj_task_harness_1'));})()");
  report('E13-restart-fresh-instance-failclosed', String(r13).indexOf('XJ_PI_TASK_NOT_FOUND') >= 0, String(r13).slice(0, 80));
  const r14 = await ev(cdp2, "(async function(){var p=await window.__PITEST__.projection();var c=await window.__PI__.startTask({taskId:'xj_task_harness_3',mode:'observe',projection:p});return JSON.stringify(c.ok);})()");
  report('E14-restart-new-task-works', String(r14).indexOf('true') >= 0);

  cdp2.close();
  await handle.shutdown();
  console.log('SUMMARY electron pass=' + passCount + ' fail=' + failCount);
  process.exit(failCount === 0 ? 0 : 1);
})().catch(async (e) => { console.error('FATAL', e); try { handle && handle.shutdown(); } catch (x) {} process.exit(1); });
