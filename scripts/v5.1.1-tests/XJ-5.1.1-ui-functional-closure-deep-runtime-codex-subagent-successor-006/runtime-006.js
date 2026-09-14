'use strict';

/* 006 fresh runtime runner. Historical harnesses are loaded in memory only;
 * all output is redirected into this task's own scratch root. No historical
 * raw/evidence is read or written. */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '../../..');
const TASK = 'XJ-5.1.1-ui-functional-closure-deep-runtime-codex-subagent-successor-006';
const OUT = path.join(ROOT, 'qa', 'task-scratch', TASK);
const SCRIPT_DIR = path.join(ROOT, 'scripts', 'v5.1.1-tests', TASK);
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SCRIPT_DIR, { recursive: true });

function compileInMemory(source, filename) {
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(source, filename);
  return mod.exports;
}

function loadUploadRun(scenarioOverride) {
  const oldPath = path.join(ROOT, 'scripts/v5.1.1-tests/XJ-5.1.1-supervision-material-upload-runtime-closure-012/electron-upload-harness-012.js');
  let source = fs.readFileSync(oldPath, 'utf8');
  source = source.replace(/const OUT_ROOT = .*?;\r?\n/, "const OUT_ROOT = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-ui-functional-closure-deep-runtime-codex-subagent-successor-006');\n");
  if (scenarioOverride) {
    source = source.replace(/const scenario = arg\('scenario', 'success'\);/, "const scenario = " + JSON.stringify(scenarioOverride) + ";");
    source = source.replace(/const mutation = arg\('mutation', 'none'\);/, "const mutation = 'none';");
  }
  source = source.replace(/\nrun\(\)\.then\([\s\S]*$/, '\nmodule.exports = { run };\n');
  return compileInMemory(source, path.join(SCRIPT_DIR, 'loaded-upload-harness.js')).run;
}

function loadBillingExports() {
  const oldPath = path.join(ROOT, 'scripts/v5.1.1-tests/XJ-5.1.1-billing-monthly-override-feedback-runtime-closure-018/runtime-electron-cdp.js');
  let source = fs.readFileSync(oldPath, 'utf8');
  source = source.replace(/const TASK = .*?;\r?\n/, `const TASK = '${TASK}';\n`);
  source = source.replace(/if \(require\.main === module\)[\s\S]*$/, `module.exports = { ROOT, TASK, CARD_SHA, OUT, RAW, EVIDENCE, URL, VIEWPORT, sha256, fileRecord, sleep, nowYm, launch, navigate, clickSelector, pressKey, snapshot, seedData, overrideUi, selectClientMonth, expandOverride, cdpSetAmount, cdpInstallSlowWrapper, cdpInstallNormalWrapper, saveScreenshot, requirePass, waitForState, scenarioKeyboardSuccessAddPersistenceRestart, scenarioFailureRetry, scenarioStaleAsyncClientSwitch };\n`);
  return compileInMemory(source, path.join(SCRIPT_DIR, 'loaded-billing-runtime.js'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function runUpload() {
  const results = [];
  for (const scenario of ['success', 'retry', 'cancel']) {
    const run = loadUploadRun(scenario);
    results.push(await run());
  }
  const result = { task: TASK, ok: results.every((item) => item && item.ok === true), scenarios: results };
  writeJson(path.join(OUT, 'upload-runtime-result.json'), result);
  return result;
}

async function runBilling() {
  const runtime = loadBillingExports();
  const result = await runtime.scenarioKeyboardSuccessAddPersistenceRestart();
  writeJson(path.join(OUT, 'billing-runtime-result.json'), result);
  return result;
}

async function runCalendar() {
  const runtime = loadBillingExports();
  const app = await runtime.launch();
  const ym = runtime.nowYm();
  const result = { task: TASK, ym, steps: [] };
  try {
    await runtime.navigate(app, runtime.VIEWPORT);
    const ids = await runtime.seedData(app.cdp, ym);
    await runtime.overrideUi(app.cdp);
    const initial = await app.cdp.evaluate("({label:(document.getElementById('month-label')||{}).textContent||'', days:document.querySelectorAll('.bc-day[data-date]').length, errors:document.querySelectorAll('[role=alert]').length})");
    if (!initial.label || initial.days < 28) throw new Error('calendar initial month/day grid unavailable');
    result.steps.push({ name: 'initial-month', ok: true, state: initial });
    await app.cdp.evaluate('window.nextMonth()');
    await runtime.sleep(180);
    const next = await app.cdp.evaluate("(document.getElementById('month-label')||{}).textContent||''");
    if (next === initial.label) throw new Error('calendar month switch did not change label');
    result.steps.push({ name: 'next-month', ok: true, label: next });
    await app.cdp.evaluate('window.prevMonth()');
    await runtime.sleep(180);
    const targetDate = ym + '-10';
    const day = await app.cdp.evaluate(`(function(){var el=document.querySelector('.bc-day[data-date=${JSON.stringify(targetDate)}]'); if(!el)return null; var r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,date:el.dataset.date};})()`);
    if (!day) throw new Error('seeded calendar day not found: ' + targetDate);
    await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: day.x, y: day.y });
    await app.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: day.x, y: day.y, button: 'left', clickCount: 1 });
    await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: day.x, y: day.y, button: 'left', clickCount: 1 });
    await runtime.sleep(220);
    const detail = await app.cdp.evaluate("(function(){var m=document.querySelector('.modal-overlay'); return m?{text:m.textContent||'',date:(m.querySelector('h3')||{}).textContent||''}:null;})()");
    if (!detail || detail.date.indexOf(targetDate) < 0 || detail.text.indexOf('QA合成Pro来访者A-018') < 0) throw new Error('calendar date detail not reachable or missing seeded session');
    result.steps.push({ name: 'date-detail', ok: true, detail });
    result.ids = ids;
    result.ok = true;
  } finally {
    await app.close(false);
  }
  writeJson(path.join(OUT, 'calendar-runtime-result.json'), result);
  return result;
}

async function main() {
  const mode = (process.argv.find((arg) => arg.startsWith('--mode=')) || '--mode=all').slice('--mode='.length);
  let payload;
  if (mode === 'upload') payload = await runUpload();
  else if (mode === 'billing') payload = await runBilling();
  else if (mode === 'calendar') payload = await runCalendar();
  else if (mode === 'all') payload = { upload: await runUpload(), billing: await runBilling(), calendar: await runCalendar() };
  else throw new Error('unknown mode: ' + mode);
  process.stdout.write(JSON.stringify({ ok: true, mode, payload }) + '\n');
}

main().catch((error) => { process.stderr.write((error && error.stack) || String(error)); process.stderr.write('\n'); process.exitCode = 1; });
