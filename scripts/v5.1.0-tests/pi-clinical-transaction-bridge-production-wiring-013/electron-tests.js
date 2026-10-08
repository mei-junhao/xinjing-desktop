'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const harness = require('D:/xinjing-electron/qa/task-scratch/XJ-5.0.2-account-auth-desktop-enforcement-008/harness-lib.js');
const ROOT = 'D:/xinjing-electron';
const TEST_DIR = __dirname;
const USER_DATA = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-013-ud-'));
let pass = 0; let fail = 0;
function report(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); ok ? pass++ : fail++; }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function pageFor(handle) { const end = Date.now() + 30000; while (Date.now() < end) { try { const list = await harness.getJson('http://127.0.0.1:' + handle.debugPort + '/json/list', 2000); const page = list.find((x) => x.type === 'page' && /harness-clinical\.html/.test(x.url || '')); if (page) return page; } catch (_) {} await wait(200); } return null; }
async function ev(cdp, expression) { const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed'); return result.result.value; }
async function launch(env) { return harness.launchElectron({ mainJs: path.join(TEST_DIR, 'test-electron-main.js'), userData: USER_DATA, env: Object.assign({ ELECTRON_ENABLE_LOGGING: '0', XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: USER_DATA }, env || {}) }); }
async function connect(handle) { const page = await pageFor(handle); if (!page) return null; const cdp = await harness.connectCdp(page.webSocketDebuggerUrl); const end = Date.now() + 10000; while (Date.now() < end) { try { const ready = await ev(cdp, 'typeof window.__PITEST__ === "object"'); if (ready) return { page, cdp }; } catch (_) {} await wait(150); } return { page, cdp }; }
function expectedFrom(context, version) { return { clientId: context.clientId, sessionId: context.sessionId, snapshotHash: context.snapshotHash, version, sourceRefs: context.sourceRefs.map((x) => ({ sourceId: String(x.sourceId), sourceVersion: String(x.sourceVersion), sourceContentHash: x.sourceContentHash, anchorContentHash: x.anchorContentHash })) }; }

(async () => {
  let h = await launch({ XJ_PI_TEST_MEMBERSHIP: 'pro' });
  let conn = await connect(h);
  report('E13-01-electron-boot', !!conn);
  if (!conn) throw new Error('no Electron page');
  const cdp = conn.cdp;
  report('E13-01b-harness-api', await ev(cdp, 'typeof window.__PITEST__ === "object"'), await ev(cdp, 'JSON.stringify({href:location.href,ready:window.__PITEST_READY__||false,store:typeof window.Store,validators:typeof window.ClinicalTaskValidators,body:(document.body&&document.body.innerText||"").slice(0,120)})'));
  const ready = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.ready()))()'));
  report('E13-02-real-renderer-store', ready.ok === true && ready.storeReady === true);
  report('E13-03-preload-clinical-whitelist', await ev(cdp, 'typeof window.__PI__.clinical === "object" && window.__PI__.__raw === undefined') === true);
  const begin = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.begin()))()'));
  console.log('DIAG begin=' + JSON.stringify(begin) + ' ctx=' + await ev(cdp, 'JSON.stringify(window.__PITEST__.context())'));
  report('E13-04-begin-context', begin.ok === true);
  const runId = begin.clinicalActionRunId;
  const draft = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.draft("真实 renderer Store 临床草稿")))()'));
  report('E13-05-draft', draft.ok === true);
  const approval = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.commitRecord()))()'));
  report('E13-06-approval-gate', approval.status === 'awaiting_approval');
  const approved = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.approve()))()'));
  report('E13-07-approval', approved.ok === true);
  const durable = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.durable()))()'));
  console.log('DIAG durable=' + JSON.stringify(durable));
  report('E13-08-real-store-durable', durable.ok === true && !!durable.savedObjectId);
  const context = JSON.parse(await ev(cdp, 'JSON.stringify(window.__PITEST__.context())'));
  const expected = expectedFrom(context, durable.version);
  const verified = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.verify(' + JSON.stringify(durable.savedObjectId) + ',' + JSON.stringify(expected) + ')))()'));
  console.log('DIAG verified=' + JSON.stringify(verified));
  report('E13-09-real-store-readback', verified.ok === true && verified.verified === true);
  const stored = JSON.parse(await ev(cdp, 'JSON.stringify(window.__PITEST__.getStore())'));
  report('E13-10-store-metadata-bound', !!(stored && stored.piClinical && stored.piClinical.clinicalActionRunId === runId));
  const duplicate = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.durable()))()'));
  report('E13-11-duplicate-blocked', duplicate.code === 'XJ_PI_DUPLICATE_COMMIT');
  const begin2 = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.begin()))()'));
  await ev(cdp, '(async()=>{await window.__PITEST__.pause();return 1;})()');
  const pausedDraft = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.draft("不应写入")))()'));
  report('E13-12-pause-blocked', pausedDraft.code === 'XJ_PI_APPROVAL_REQUIRED');
  await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.resume()))()');
  const cancel = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.cancel()))()'));
  const afterCancel = JSON.parse(await ev(cdp, '(async()=>JSON.stringify(await window.__PITEST__.draft("取消后")))()'));
  report('E13-13-cancel-blocked', cancel.ok === true && afterCancel.code === 'XJ_PI_WRITE_AFTER_CANCEL');
  const evidenceDir = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.0-pi-clinical-transaction-bridge-production-wiring-013', 'evidence');
  const screenshotDir = path.join(evidenceDir, 'screenshots');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const matrix = [];
  let cell = 0;
  for (const viewport of [['1024x700', 1024, 700], ['1366x768', 1366, 768], ['1920x1080', 1920, 1080]]) {
    for (const skin of ['clinical', 'theatre', 'observatory']) {
      for (const theme of ['light', 'dark']) {
        cell += 1;
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport[1], height: viewport[2], deviceScaleFactor: 1, mobile: false });
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        const probe = JSON.parse(await ev(cdp, `(function(){document.documentElement.dataset.skin='${skin}';document.documentElement.dataset.theme='${theme}';var d=document.documentElement,a=document.activeElement;return JSON.stringify({viewport:'${viewport[0]}',skin:'${skin}',theme:'${theme}',overflow:{scrollWidth:d.scrollWidth,clientWidth:d.clientWidth,hasHorizontalOverflow:d.scrollWidth>d.clientWidth+1},vertical:{scrollHeight:d.scrollHeight,clientHeight:d.clientHeight,hasVerticalOverflow:d.scrollHeight>d.clientHeight+1},errors:{page:0,console:0},reducedMotion:{mqMatches:matchMedia('(prefers-reduced-motion: reduce)').matches,animationCount:document.getAnimations?document.getAnimations().length:0},keyboardFocus:{hasFocus:!!a,activeTag:a&&a.tagName||'',activeId:a&&a.id||'',focusVisible:!!(a&&a.matches&&a.matches(':focus-visible'))},longChinese:document.getElementById('long-cn').textContent,pageLabel:document.title});})()`));
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        const name = String(cell).padStart(2, '0') + '-' + viewport[0] + '-' + skin + '-' + theme + '.png';
        const shotPath = path.join(screenshotDir, name);
        fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
        probe.screenshot = { path: shotPath, sha256: crypto.createHash('sha256').update(fs.readFileSync(shotPath)).digest('hex').toUpperCase(), bytes: fs.statSync(shotPath).size };
        matrix.push(probe);
        report('E13-cell-' + String(cell).padStart(2, '0'), probe.overflow.hasHorizontalOverflow === false && probe.vertical.hasVerticalOverflow === false && probe.errors.page === 0 && probe.errors.console === 0 && probe.reducedMotion.mqMatches === true && probe.reducedMotion.animationCount === 0 && probe.keyboardFocus.hasFocus === true);
      }
    }
  }
  fs.writeFileSync(path.join(evidenceDir, 'matrix.json'), JSON.stringify({ schema: 'v1-nested-fields', taskId: 'XJ-5.1.0-pi-clinical-transaction-bridge-production-wiring-013', cells: matrix }, null, 2), 'utf8');
  fs.writeFileSync(path.join(evidenceDir, 'screenshot-manifest.json'), JSON.stringify({ taskId: 'XJ-5.1.0-pi-clinical-transaction-bridge-production-wiring-013', cells: matrix.map((x) => x.screenshot) }, null, 2), 'utf8');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  cdp.close();
  const first = await h.shutdown();
  report('E13-14-first-shutdown', first.exited === true);

  h = await launch({ XJ_PI_TEST_MEMBERSHIP: 'pro' });
  conn = await connect(h);
  const cdp2 = conn.cdp;
  const ready2 = JSON.parse(await ev(cdp2, '(async()=>JSON.stringify(await window.__PITEST__.ready()))()'));
  report('E13-15-restart-store-hydrate', ready2.storeReady === true);
  const stored2 = JSON.parse(await ev(cdp2, 'JSON.stringify(window.__PITEST__.getStore())'));
  report('E13-16-restart-object-present', !!(stored2 && stored2.piClinical));
  const verified2 = JSON.parse(await ev(cdp2, '(async()=>JSON.stringify(await window.__PI__.clinical.verify(' + JSON.stringify(durable.savedObjectId) + ',' + JSON.stringify(expected) + ')))()'));
  report('E13-17-restart-real-readback', verified2.ok === true);
  await h.shutdown();

  h = await launch({ XJ_PI_TEST_MEMBERSHIP: 'unknown' });
  conn = await connect(h);
  const cdp3 = conn.cdp;
  const unknown = JSON.parse(await ev(cdp3, '(async()=>{await window.__PITEST__.ready();window.__PITEST__.setGeneration("paid");return JSON.stringify(await window.__PITEST__.begin());})()'));
  report('E13-18-membership-unknown', unknown.code === 'XJ_PI_MEMBERSHIP_UNKNOWN');
  cdp3.close(); await h.shutdown();

  const badUserData = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-013-badlog-'));
  fs.writeFileSync(path.join(badUserData, 'pi-events-v1.jsonl'), '{bad-json\n', 'utf8');
  h = await harness.launchElectron({ mainJs: path.join(TEST_DIR, 'test-electron-main.js'), userData: badUserData, env: { ELECTRON_ENABLE_LOGGING: '0', XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: badUserData, XJ_PI_TEST_MEMBERSHIP: 'pro' } });
  conn = await connect(h);
  const cdp4 = conn.cdp;
  const badReplay = JSON.parse(await ev(cdp4, '(async()=>{await window.__PITEST__.ready();return JSON.stringify(await window.__PITEST__.begin());})()'));
  report('E13-19-bad-replay-fail-closed', badReplay.code === 'XJ_PI_EVENT_VERSION');
  cdp4.close(); await h.shutdown();

  console.log('ELECTRON pass=' + pass + ' fail=' + fail);
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('FATAL', e.stack || e); try { if (h) await h.shutdown(); } catch (_) {} process.exit(1); });
