'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');
const harness = require('./runtime-003.js');

const ROOT = harness.ROOT;
const APP_ROOT = harness.APP_ROOT;
const ELECTRON = harness.ELECTRON;
const TASK_ID = process.env.XJ_TASK_ID || 'XJ-5.1.2-masters-fold-fix-003';
const SCRATCH = path.resolve(process.env.XJ_EXPECTED_RED_ROOT || process.env.XJ_EVIDENCE_ROOT && path.join(process.env.XJ_EVIDENCE_ROOT, 'expected-red') || path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.2-masters-fold-fix-003', 'expected-red-003'));
const CHILD_TIMEOUT_MS = 20000;
const RUN_DEADLINE_MS = 170000;
const CASES = [
  { id: 'ER1-remove-click-listener', description: '删除折叠按钮 click listener 后，trusted click 必须失败', probe: 'click' },
  { id: 'ER2-fixed-grid-track', description: '保留固定左侧 grid 轨道后，折叠不得被视为中央增宽', probe: 'grid' },
  { id: 'ER3-aria-only', description: '仅更新 aria 不得冒充真实面板折叠', probe: 'aria' },
  { id: 'ER4-no-restore', description: '删除恢复状态切换后，第二次点击必须失败', probe: 'restore' },
  { id: 'ER5-horizontal-overflow', description: '移除长文本换行后，横向溢出门禁必须失败', probe: 'overflow' },
  { id: 'ER6-keyboard-handler', description: '删除显式键盘处理后，Enter 折叠必须失败', probe: 'keyboard' },
];

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function writeText(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, String(value), 'utf8'); }
function writeJson(file, value) { writeText(file, JSON.stringify(value, null, 2) + '\n'); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex').toUpperCase(); }
function read(file) { return fs.readFileSync(file, 'utf8'); }
function replaceOnce(source, from, to, label) {
  if (!source.includes(from)) throw new Error('mutation anchor missing: ' + label);
  return source.replace(from, to);
}

function processSnapshot() {
  const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const result = cp.spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  const text = String(result.stdout || '').trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [value];
  } catch (_) {
    return null;
  }
}

function processTree(snapshot, rootPid) {
  if (!Array.isArray(snapshot)) return null;
  const children = new Map();
  for (const item of snapshot) {
    const parent = Number(item.ParentProcessId);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(item);
  }
  const result = [];
  const queue = [Number(rootPid)];
  const seen = new Set();
  while (queue.length) {
    const pid = Number(queue.shift());
    if (!Number.isInteger(pid) || seen.has(pid)) continue;
    seen.add(pid);
    const item = snapshot.find((candidate) => Number(candidate.ProcessId) === pid);
    if (item) result.push(item);
    for (const child of children.get(pid) || []) queue.push(Number(child.ProcessId));
  }
  return result;
}

function childMatches(info, id, mode) {
  if (!info) return false;
  const name = String(info.Name || '').toLowerCase();
  const commandLine = String(info.CommandLine || '').toLowerCase();
  return (name === 'node.exe' || name.endsWith('\\node.exe'))
    && commandLine.includes(String(__filename).toLowerCase())
    && commandLine.includes('--child')
    && commandLine.includes(String(id).toLowerCase())
    && commandLine.includes(String(mode).toLowerCase());
}

function terminateConfirmedChildTree(pid, id, mode) {
  const before = processSnapshot();
  const root = Array.isArray(before) ? before.find((item) => Number(item.ProcessId) === Number(pid)) : null;
  const confirmed = childMatches(root, id, mode);
  const beforeTree = processTree(before, pid);
  const action = { confirmed, before:Array.isArray(beforeTree) ? beforeTree.map((item) => ({ pid:Number(item.ProcessId), parentPid:Number(item.ParentProcessId), name:String(item.Name || ''), commandLine:String(item.CommandLine || '') })) : [], inspectionAvailable:Array.isArray(beforeTree) };
  if (!confirmed) return action;
  const kill = cp.spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  });
  action.kill = {
    command:['taskkill.exe','/PID',String(pid),'/T','/F'],
    exitCode:kill.status == null ? null : kill.status,
    stdout:String(kill.stdout || ''), stderr:String(kill.stderr || ''),
    error:kill.error ? String(kill.error.message || kill.error) : null,
  };
  const after = processSnapshot();
  const afterTree = processTree(after, pid);
  action.after = Array.isArray(afterTree) ? afterTree.map((item) => ({ pid:Number(item.ProcessId), parentPid:Number(item.ParentProcessId), name:String(item.Name || ''), commandLine:String(item.CommandLine || '') })) : [];
  action.treeExited = Array.isArray(afterTree) && afterTree.length === 0;
  return action;
}

function mutateFixture(fixtureRoot, id) {
  const jsFile = path.join(fixtureRoot, 'app', 'js', 'masters.js');
  const cssFile = path.join(fixtureRoot, 'app', 'css', 'masters-clinical.css');
  let js = read(jsFile);
  let css = read(cssFile);
  switch (id) {
    case 'ER1-remove-click-listener':
      js = replaceOnce(js, "button.addEventListener('click', function () { window.toggleMasterPanel(side); });", "button.addEventListener('click', function () {});", id);
      break;
    case 'ER2-fixed-grid-track':
      css = replaceOnce(css, 'body.masters-left-collapsed .masters-workspace { grid-template-columns: 0 minmax(0, 1fr) 300px; }', 'body.masters-left-collapsed .masters-workspace { grid-template-columns: 244px minmax(0, 1fr) 300px; }', id);
      break;
    case 'ER3-aria-only':
      js = replaceOnce(js, "    panel.classList.toggle('collapsed', collapsed);\n    document.body.classList.toggle('masters-' + side + '-collapsed', collapsed);", "    // mutation: aria-only; visual state intentionally omitted\n", id);
      break;
    case 'ER4-no-restore':
      js = replaceOnce(js, '    panelState[side] = !panelState[side];', '    panelState[side] = true;', id);
      break;
    case 'ER5-horizontal-overflow':
      css = replaceOnce(css, 'white-space: pre-wrap; }', 'white-space: nowrap; }', id);
      break;
    case 'ER6-keyboard-handler':
      js = replaceOnce(js, "      button.addEventListener('keydown', function (event) {", "      button.addEventListener('keydown', function (event) { if (false) {", id);
      js = replaceOnce(js, "      });\n      button.addEventListener('keyup', function (event) {", "      } });\n      button.addEventListener('keyup', function (event) {", id + '-keydown-close');
      js = replaceOnce(js, "      button.addEventListener('keyup', function (event) {", "      button.addEventListener('keyup', function (event) { if (false) {", id + '-keyup');
      js = replaceOnce(js, "      });\n      button.addEventListener('blur', function () { delete button.dataset.panelSpacePending; });", "      } });\n      button.addEventListener('blur', function () { delete button.dataset.panelSpacePending; });", id + '-keyup-close');
      break;
    default:
      throw new Error('unknown mutation ' + id);
  }
  writeText(jsFile, js);
  writeText(cssFile, css);
}

function createFixture(id, mode) {
  const fixtureRoot = path.join(SCRATCH, 'fixtures', id, mode);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  ensureDir(fixtureRoot);
  fs.cpSync(APP_ROOT, path.join(fixtureRoot, 'app'), { recursive: true });
  writeJson(path.join(fixtureRoot, 'package.json'), {
    name: 'xj-512-masters-fold-' + id.toLowerCase(), version: '1.0.0', main: 'main.cjs', private: true,
  });
  writeText(path.join(fixtureRoot, 'main.cjs'), [
    "'use strict';",
    "const path = require('path');",
    "const { app, BrowserWindow } = require('electron');",
    "app.whenReady().then(() => { const win = new BrowserWindow({ show: true, webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false } }); win.loadFile(path.join(__dirname, 'app', 'masters.html')); });",
    "app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });",
  ].join('\n') + '\n');
  if (mode === 'mutated') mutateFixture(fixtureRoot, id);
  return fixtureRoot;
}

function tracks(value) {
  return String(value || '').split(/\s+/).map((item) => Number.parseFloat(item)).filter(Number.isFinite);
}

async function childRun(id, mode) {
  const fixtureRoot = createFixture(id, mode);
  const appRoot = path.join(fixtureRoot, 'app');
  const session = await harness.createSession({ name: '1024x700', width: 1024, height: 700 }, { root: fixtureRoot, appRoot, electron: ELECTRON });
  const checks = [];
  const check = (label, pass, details) => checks.push({ label, pass: !!pass, details: details || null });
  let result;
  try {
    const initial = await harness.probe(session.cdp, 'initial');
    check('baseline page ready', initial.readyState === 'complete' && initial.dialogue && initial.dialogue.width > 0, initial);
    if (id === 'ER1-remove-click-listener' || id === 'ER2-fixed-grid-track' || id === 'ER3-aria-only' || id === 'ER4-no-restore') {
      await harness.trustedClick(session.cdp, '#masters-collapse-left', []);
      const folded = await harness.probe(session.cdp, 'folded');
      if (id === 'ER1-remove-click-listener') check('trusted click folds left panel', folded.leftButton && folded.leftButton.expanded === 'false' && folded.dialogue.width > initial.dialogue.width + 10, folded);
      if (id === 'ER2-fixed-grid-track') check('folding expands central track', folded.dialogue.width > initial.dialogue.width + 10 && tracks(folded.grid)[0] === 0, folded);
      if (id === 'ER3-aria-only') check('visual fold follows aria', folded.leftClass.includes('collapsed') && folded.dialogue.width > initial.dialogue.width + 10, folded);
      if (id === 'ER4-no-restore') {
        await harness.trustedClick(session.cdp, '#masters-collapse-left', []);
        const restored = await harness.probe(session.cdp, 'restored');
        check('second click restores panel', restored.leftButton && restored.leftButton.expanded === 'true' && !restored.leftClass.includes('collapsed') && Math.abs(restored.dialogue.width - initial.dialogue.width) < 2, restored);
      }
    } else if (id === 'ER5-horizontal-overflow') {
      await harness.injectLongChinese(session.cdp);
      const long = await harness.probe(session.cdp, 'long-cn');
      check('long Chinese remains within dialogue', long.longText && long.longText.overflow === false, long.longText);
    } else if (id === 'ER6-keyboard-handler') {
      await harness.keyActivate(session.cdp, '#masters-collapse-left', 'Enter', []);
      const keyboard = await harness.probe(session.cdp, 'enter-folded');
      check('Enter folds left panel', keyboard.leftButton && keyboard.leftButton.expanded === 'false' && keyboard.dialogue.width > initial.dialogue.width + 10, keyboard);
    }
    const actionable = session.consoleErrors.filter((item) => !harness.isHarnessConsoleNoise(item));
    check('no page or actionable console errors', session.pageErrors.length === 0 && actionable.length === 0, { page:session.pageErrors.length, console:actionable.length });
    const passed = checks.every((item) => item.pass);
    result = { taskId:TASK_ID, caseId:id, mode, status:passed ? 'PASS' : 'FAIL', checks, fixtureRoot, productionHashes: { 'app/js/masters.js': { sha256:harness.sha256(read(path.join(appRoot, 'js', 'masters.js'))), bytes:fs.statSync(path.join(appRoot, 'js', 'masters.js')).size }, 'app/css/masters-clinical.css': { sha256:harness.sha256(read(path.join(appRoot, 'css', 'masters-clinical.css'))), bytes:fs.statSync(path.join(appRoot, 'css', 'masters-clinical.css')).size } } };
  } finally {
    try {
      const cleanup = await session.close();
      if (!cleanup || cleanup.ok !== true) {
        result = result || { taskId:TASK_ID, caseId:id, mode, status:'FAIL', checks, fixtureRoot };
        result.status = 'FAIL';
        result.cleanup = cleanup || { ok:false, error:'cleanup returned no result' };
      } else if (result) {
        result.cleanup = cleanup;
      }
    } catch (error) {
      result = result || { taskId:TASK_ID, caseId:id, mode, status:'FAIL', checks, fixtureRoot };
      result.status = 'FAIL';
      result.cleanup = { ok:false, error:{ message:error.message, stack:error.stack } };
    }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.status === 'PASS' ? 0 : 2;
}

function runChild() {
  const [, , flag, id, mode] = process.argv;
  if (flag !== '--child' || !id || !mode) return false;
  childRun(id, mode).catch((error) => { process.stderr.write((error.stack || error.message) + '\n'); process.exitCode = 2; });
  return true;
}

function spawnCase(id, mode) {
  const dir = ensureDir(path.join(SCRATCH, 'runs', id, mode));
  const nonce = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
  const stdoutFile = path.join(dir, nonce + '.stdout.txt');
  const stderrFile = path.join(dir, nonce + '.stderr.txt');
  const startedAt = new Date().toISOString();
  const command = [process.execPath, __filename, '--child', id, mode];
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let termination = null;
    const child = cp.spawn(process.execPath, [__filename, '--child', id, mode], {
      cwd: ROOT, windowsHide: true, stdio:['ignore','pipe','pipe'],
      env:Object.assign({}, process.env, {
        XJ_TASK_ID: TASK_ID,
        XJ_EXPECTED_RED_ROOT: SCRATCH,
        XJ_EVIDENCE_ROOT: path.join(SCRATCH, 'child-runtime', id, mode, nonce),
      }),
    });
    if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const startedMs = Date.now();
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      termination = terminateConfirmedChildTree(child.pid, id, mode);
      if (!termination.confirmed) termination.reason = 'unconfirmed child process; no forced termination attempted';
    }, CHILD_TIMEOUT_MS);
    const finalize = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const after = processSnapshot();
      const tree = processTree(after, child.pid);
      const childTreeExited = Array.isArray(tree) && tree.length === 0;
      let parsed = { taskId:TASK_ID, caseId:id, mode, status:'FAIL', error:'empty child stdout' };
      if (stdout) {
        try { parsed = JSON.parse(stdout); } catch (error) { parsed.parseError = error.message; }
      }
      const meta = {
        taskId:TASK_ID, caseId:id, mode, command, cwd:ROOT,
        startedAt, finishedAt:new Date().toISOString(), exitCode:status == null ? null : status,
        signal:signal || null, stdoutPath:stdoutFile, stderrPath:stderrFile,
        stdoutSha256:sha256(Buffer.from(stdout, 'utf8')), stdoutBytes:Buffer.byteLength(stdout, 'utf8'),
        stderrSha256:sha256(Buffer.from(stderr, 'utf8')), stderrBytes:Buffer.byteLength(stderr, 'utf8'),
        pid:child.pid, timedOut, elapsedMs:Date.now() - startedMs, childTreeExited,
        termination,
      };
      writeText(stdoutFile, stdout);
      writeText(stderrFile, stderr);
      writeJson(path.join(dir, nonce + '.meta.json'), meta);
      resolve({ meta, stdoutFile, stderrFile, result:parsed });
    };
    child.once('error', () => finalize(null, null));
    child.once('close', (code, signal) => finalize(code, signal));
  });
}

async function main() {
  ensureDir(SCRATCH);
  const startedMs = Date.now();
  const cases = [];
  for (const item of CASES) {
    if (Date.now() - startedMs > RUN_DEADLINE_MS) {
      cases.push({ id:item.id, description:item.description, probe:item.probe, baseline:null, mutated:null, killed:false, error:'run deadline exceeded' });
      continue;
    }
    const baseline = await spawnCase(item.id, 'baseline');
    const mutated = await spawnCase(item.id, 'mutated');
    const killed = baseline.meta.exitCode === 0 && mutated.meta.exitCode !== 0;
    cases.push({ id:item.id, description:item.description, probe:item.probe, baseline, mutated, killed });
  }
  const summary = {
    taskId:TASK_ID, version:'expected-red-004-v1', startedAt:new Date(startedMs).toISOString(), finishedAt:new Date().toISOString(), elapsedMs:Date.now() - startedMs,
    caseCount:cases.length, cases, killedCount:cases.filter((item) => item.killed).length,
    status:cases.length === CASES.length && cases.every((item) => item.killed && item.baseline.meta.childTreeExited === true && item.mutated.meta.childTreeExited === true && item.baseline.meta.timedOut === false && item.mutated.meta.timedOut === false) ? 'PASS' : 'FAIL',
  };
  writeJson(path.join(SCRATCH, 'expected-red-summary.json'), summary);
  process.stdout.write(JSON.stringify({ status:summary.status, caseCount:summary.caseCount, killedCount:summary.killedCount, cases:cases.map((item) => ({ id:item.id, baselineExit:item.baseline && item.baseline.meta.exitCode, mutatedExit:item.mutated && item.mutated.meta.exitCode, killed:item.killed, baselineTreeExited:item.baseline && item.baseline.meta.childTreeExited, mutatedTreeExited:item.mutated && item.mutated.meta.childTreeExited })) }, null, 2) + '\n');
  process.exitCode = summary.status === 'PASS' ? 0 : 2;
}

if (require.main === module) {
  if (!runChild()) main().catch((error) => { process.stderr.write((error.stack || error.message) + '\n'); process.exitCode = 2; });
}
