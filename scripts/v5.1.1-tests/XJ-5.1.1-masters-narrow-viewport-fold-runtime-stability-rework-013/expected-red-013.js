'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TASK = 'XJ-5.1.1-masters-narrow-viewport-fold-runtime-stability-rework-013';
const CARD_SHA = 'EAFE5138BF34A3C57ED9B0664E1A96B4D6AE16A6A812EACE6C3E0792635154E6';
const OUT = path.join(ROOT, 'qa', 'task-scratch', TASK);
const RAW = path.join(OUT, 'expected-red-raw');
const SOURCES = path.join(OUT, 'expected-red-sources');
const PROBE = path.join(ROOT, 'scripts', 'v5.1.1-tests', TASK, 'probe-013.js');
fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(SOURCES, { recursive: true });

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex').toUpperCase();
function hashFile(file) {
  const data = fs.readFileSync(file);
  return { path: file.replace(/\\/g, '/'), bytes: data.length, sha256: sha256(data) };
}
function sourceManifest(root) {
  return ['app/masters.html', 'app/js/masters.js', 'app/css/masters-clinical.css'].map(rel => hashFile(path.join(root, rel)));
}
function append(file, text) { fs.appendFileSync(file, '\n' + text + '\n', 'utf8'); }
function makeSource(mutation, stage) {
  const dir = fs.mkdtempSync(path.join(SOURCES, mutation + '-' + stage + '-'));
  fs.cpSync(path.join(ROOT, 'app'), path.join(dir, 'app'), { recursive: true });
  const css = path.join(dir, 'app', 'css', 'masters-clinical.css');
  const js = path.join(dir, 'app', 'js', 'masters.js');
  if (mutation === 'button-covered-by-adjacent-panel') {
    append(css, '/* XJ013 mutation: adjacent dialogue layer covers fold control. */\n.masters-dialogue-panel { z-index: 30 !important; }\n.masters-source-panel, .masters-inspector-panel { z-index: 0 !important; }\n.masters-collapse-btn { z-index: 1 !important; pointer-events: none !important; }');
  } else if (mutation === 'hidden-content-without-zero-track') {
    append(css, '/* XJ013 mutation: hide content but retain the 244px track. */\nbody.masters-left-collapsed .masters-workspace { grid-template-columns: 244px minmax(0, 1fr) 300px !important; }');
  } else if (mutation === 'restore-stays-zero') {
    const original = fs.readFileSync(js, 'utf8');
    const mutated = original.replace('panelState[side] = !panelState[side];', 'panelState[side] = true;');
    if (mutated === original) throw new Error('restore mutation anchor missing');
    fs.writeFileSync(js, mutated, 'utf8');
  } else if (mutation === 'roundtable-horizontal') {
    append(css, '/* XJ013 mutation: force message flow horizontal. */\n.chat-body { flex-direction: row !important; }');
  } else if (mutation !== 'baseline') {
    throw new Error('unknown mutation ' + mutation);
  }
  return dir;
}
function fileRecord(file, command, cwd, exit) {
  const data = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  return { path: file.replace(/\\/g, '/'), command, cwd: cwd.replace(/\\/g, '/'), exit, bytes: data.length, sha256: sha256(data) };
}
function runStage(mutation, stage, mode) {
  const source = makeSource(mutation, stage);
  const rawDir = path.join(RAW, mutation, stage);
  fs.mkdirSync(rawDir, { recursive: true });
  const stdoutPath = path.join(rawDir, 'probe.stdout.log');
  const stderrPath = path.join(rawDir, 'probe.stderr.log');
  const url = 'file:///' + path.join(source, 'app', 'masters.html').replace(/\\/g, '/');
  const command = [process.execPath, PROBE].map(v => JSON.stringify(v)).join(' ') + ' [XJ013_URL=' + url + ' XJ013_MODE=' + mode + ']';
  const child = spawnSync(process.execPath, [PROBE], {
    cwd: ROOT,
    env: { ...process.env, XJ013_URL: url, XJ013_MODE: mode, XJ013_RAW_DIR: path.join(rawDir, 'electron') },
    encoding: 'buffer',
    timeout: 60000,
    windowsHide: true,
  });
  const stdout = child.stdout || Buffer.alloc(0);
  const stderr = child.stderr || Buffer.alloc(0);
  fs.writeFileSync(stdoutPath, stdout);
  fs.writeFileSync(stderrPath, stderr);
  const exit = typeof child.status === 'number' ? child.status : 124;
  let parsed = null;
  try { parsed = JSON.parse(stdout.toString('utf8').trim()); } catch (_) {}
  const electronFiles = [];
  const electronDir = path.join(rawDir, 'electron');
  if (fs.existsSync(electronDir)) {
    for (const name of fs.readdirSync(electronDir)) electronFiles.push(fileRecord(path.join(electronDir, name), command, ROOT, parsed && parsed.electron ? parsed.electron.exit : exit));
  }
  const result = {
    mutation,
    stage,
    mode,
    expected: stage === 'mutated' ? 'FAIL' : 'PASS',
    actual_exit: exit,
    actual: exit === 0 ? 'PASS' : 'FAIL',
    command,
    cwd: ROOT.replace(/\\/g, '/'),
    source_root: source.replace(/\\/g, '/'),
    source_manifest: sourceManifest(source),
    wrapper_stdout: fileRecord(stdoutPath, command, ROOT, exit),
    wrapper_stderr: fileRecord(stderrPath, command, ROOT, exit),
    electron_files: electronFiles,
    probe: parsed || { raw_stdout: stdout.toString('utf8'), raw_stderr: stderr.toString('utf8') },
  };
  fs.rmSync(source, { recursive: true, force: true });
  return result;
}

function main() {
  const cases = [
    { name: 'button-covered-by-adjacent-panel', mode: 'cover' },
    { name: 'hidden-content-without-zero-track', mode: 'hidden' },
    { name: 'restore-stays-zero', mode: 'restore' },
    { name: 'roundtable-horizontal', mode: 'round' },
  ];
  const output = { task: TASK, card_sha256: CARD_SHA, command_cwd: ROOT.replace(/\\/g, '/'), cases: [] };
  let exit = 0;
  for (const item of cases) {
    const baseline = runStage('baseline', 'baseline', item.mode);
    const mutated = runStage(item.name, 'mutated', item.mode);
    const restored = runStage('baseline', 'restored', item.mode);
    const ok = baseline.actual === 'PASS' && mutated.actual === 'FAIL' && restored.actual === 'PASS';
    if (!ok) exit = 1;
    output.cases.push({ name: item.name, mode: item.mode, ok, baseline, mutated, restored });
    console.log(item.name, ok ? 'PASS' : 'FAIL', 'baseline=' + baseline.actual, 'mutated=' + mutated.actual, 'restored=' + restored.actual);
  }
  const outPath = path.join(OUT, 'evidence', 'expected-red-013.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ output: outPath.replace(/\\/g, '/'), cases: output.cases.map(item => ({ name: item.name, ok: item.ok })) }, null, 2));
  process.exitCode = exit;
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
