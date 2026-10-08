'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TASK = 'XJ-5.1.1-masters-narrow-viewport-fold-runtime-stability-rework-013';
const CARD_SHA = 'EAFE5138BF34A3C57ED9B0664E1A96B4D6AE16A6A812EACE6C3E0792635154E6';
const OUT = path.join(ROOT, 'qa', 'task-scratch', TASK);
const RAW = path.join(OUT, 'adversarial-raw');
const SOURCES = path.join(OUT, 'adversarial-sources');
const PROBE = path.join(ROOT, 'scripts', 'v5.1.1-tests', TASK, 'probe-013.js');
const RUNTIME_EVIDENCE = path.join(OUT, 'evidence', 'runtime-stability-013.json');
fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(SOURCES, { recursive: true });
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex').toUpperCase();
function hash(file) { const data = fs.readFileSync(file); return { path: file.replace(/\\/g, '/'), bytes: data.length, sha256: sha256(data) }; }
function manifest(root) { return ['app/masters.html', 'app/js/masters.js', 'app/css/masters-clinical.css'].map(rel => hash(path.join(root, rel))); }
function append(file, text) { fs.appendFileSync(file, '\n' + text + '\n', 'utf8'); }
function makeSource(attack) {
  const dir = fs.mkdtempSync(path.join(SOURCES, attack + '-'));
  fs.cpSync(path.join(ROOT, 'app'), path.join(dir, 'app'), { recursive: true });
  const css = path.join(dir, 'app', 'css', 'masters-clinical.css');
  const js = path.join(dir, 'app', 'js', 'masters.js');
  if (attack === 'button-pointer-events-none') {
    append(css, '/* XJ013 attack: pointer-events:none on the real control. */\n.masters-collapse-btn { pointer-events:none !important; }');
  } else if (attack === 'aria-only-no-track') {
    const original = fs.readFileSync(js, 'utf8');
    const mutated = original.replace("document.body.classList.toggle('masters-' + side + '-collapsed', collapsed);", "/* XJ013 attack: aria-only state, no body track class. */");
    if (mutated === original) throw new Error('aria-only anchor missing');
    fs.writeFileSync(js, mutated, 'utf8');
  } else if (attack === 'double-toggle') {
    const original = fs.readFileSync(js, 'utf8');
    const anchor = "button.addEventListener('click', function () { window.toggleMasterPanel(side); });";
    const mutated = original.replace(anchor, anchor + " button.addEventListener('click', function () { window.toggleMasterPanel(side); });");
    if (mutated === original) throw new Error('double-toggle anchor missing');
    fs.writeFileSync(js, mutated, 'utf8');
  } else if (attack === 'unknown-entrypoint') {
    const original = fs.readFileSync(js, 'utf8');
    const anchor = "button.addEventListener('click', function () { window.toggleMasterPanel(side); });";
    const mutated = original.replace(anchor, "button.addEventListener('click', function () { window.toggleMasterPanel('unknown'); });");
    if (mutated === original) throw new Error('unknown-entrypoint anchor missing');
    fs.writeFileSync(js, mutated, 'utf8');
  }
  return dir;
}
function runProbe(attack, extraEnv = {}) {
  const source = makeSource(attack);
  const dir = path.join(RAW, attack);
  fs.mkdirSync(dir, { recursive: true });
  const url = 'file:///' + path.join(source, 'app', 'masters.html').replace(/\\/g, '/');
  const stdoutPath = path.join(dir, 'probe.stdout.log');
  const stderrPath = path.join(dir, 'probe.stderr.log');
  const command = [process.execPath, PROBE].map(v => JSON.stringify(v)).join(' ') + ' [XJ013_URL=' + url + ']';
  const child = spawnSync(process.execPath, [PROBE], { cwd: ROOT, env: { ...process.env, XJ013_URL: url, XJ013_MODE: 'cover', XJ013_RAW_DIR: path.join(dir, 'electron'), ...extraEnv }, encoding: 'buffer', timeout: 60000, windowsHide: true });
  fs.writeFileSync(stdoutPath, child.stdout || Buffer.alloc(0));
  fs.writeFileSync(stderrPath, child.stderr || Buffer.alloc(0));
  const exit = typeof child.status === 'number' ? child.status : 124;
  let parsed = null;
  try { parsed = JSON.parse((child.stdout || Buffer.alloc(0)).toString('utf8').trim()); } catch (_) {}
  const electron = [];
  const electronDir = path.join(dir, 'electron');
  if (fs.existsSync(electronDir)) for (const file of fs.readdirSync(electronDir)) electron.push(hash(path.join(electronDir, file)));
  const result = { attack, expected: 'FAIL', actual: exit === 0 ? 'PASS' : 'FAIL', exit, command, cwd: ROOT.replace(/\\/g, '/'), source_root: source.replace(/\\/g, '/'), source_manifest: manifest(source), wrapper_stdout: hash(stdoutPath), wrapper_stderr: hash(stderrPath), electron_files: electron, probe: parsed || { stdout: (child.stdout || Buffer.alloc(0)).toString('utf8'), stderr: (child.stderr || Buffer.alloc(0)).toString('utf8') } };
  fs.rmSync(source, { recursive: true, force: true });
  return result;
}
function evidenceMissing1024() {
  const data = JSON.parse(fs.readFileSync(RUNTIME_EVIDENCE, 'utf8'));
  const mutated = { ...data, runs: data.runs.filter(item => item.runName !== '1024x700-run-3') };
  const file = path.join(RAW, 'remove-1024-mutated.json');
  fs.writeFileSync(file, JSON.stringify(mutated, null, 2));
  const count = mutated.runs.filter(item => /^1024x700-run-/.test(item.runName)).length;
  return { attack: 'remove-1024-from-runner', expected: 'FAIL', actual: count === 3 ? 'PASS' : 'FAIL', mutated_file: hash(file), observed_1024_count: count, guard: 'requires exactly three independent 1024x700 runs' };
}
function main() {
  const attacks = [];
  for (const attack of ['button-pointer-events-none', 'aria-only-no-track', 'double-toggle', 'unknown-entrypoint']) attacks.push(runProbe(attack));
  const noWait = runProbe('no-wait-loading', { XJ013_NO_WAIT: '1' });
  attacks.push(noWait);
  attacks.push(evidenceMissing1024());
  const ok = attacks.every(item => item.actual === 'FAIL');
  const output = { task: TASK, card_sha256: CARD_SHA, attacks, self_audit: ok ? 'all attacks caught' : 'attack survived: BLOCKED' };
  const file = path.join(OUT, 'evidence', 'adversarial-013.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ output: file.replace(/\\/g, '/'), ok, attacks: attacks.map(item => ({ attack: item.attack, actual: item.actual })) }, null, 2));
  process.exitCode = ok ? 0 : 1;
}
try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }

