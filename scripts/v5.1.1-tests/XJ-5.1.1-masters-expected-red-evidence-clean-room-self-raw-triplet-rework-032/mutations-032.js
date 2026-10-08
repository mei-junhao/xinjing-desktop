'use strict';
const cp = require('child_process'); const fs = require('fs'); const path = require('path');
const ROOT = 'D:/xinjing-electron';
const P = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-masters-expected-red-evidence-clean-room-self-raw-triplet-rework-032';
const S = path.join(ROOT, 'scripts/v5.1.1-tests/XJ-5.1.1-masters-expected-red-evidence-clean-room-self-raw-triplet-rework-032');
const VER = path.join(S, 'verifier-032.js');
function snapshot() { const s = {}; s.files = {}; for (const f of ['runner-self.json']) { const p = path.join(P, f); if (fs.existsSync(p)) s.files[f] = fs.readFileSync(p, 'utf8'); } const phases = fs.readdirSync(path.join(P, 'phases')); for (const d of phases) { const dp = path.join(P, 'phases', d); for (const f of ['phase.json','stdout.txt','stderr.txt','raw.json']) { const p = path.join(dp, f); if (fs.existsSync(p)) s.files['phases/' + d + '/' + f] = fs.readFileSync(p, 'utf8'); } } return s; }
function restore(s) { for (const k of Object.keys(s.files)) { const p = path.join(P, k); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s.files[k]); } }
function runVer() { const r = cp.spawnSync(process.execPath, [VER], { cwd: ROOT, encoding: 'utf8' }); return r.status === 0; }
const ADV = [
  ['M1-delete-raw-stdout', function () { const fp = path.join(P, 'phases', fs.readdirSync(path.join(P, 'phases'))[0], 'stdout.txt'); fs.unlinkSync(fp); }],
  ['M2-forge-sha', function () { const fp = path.join(P, 'phases', fs.readdirSync(path.join(P, 'phases'))[0], 'phase.json'); const j = JSON.parse(fs.readFileSync(fp, 'utf8')); j.stdoutSha256 = 'a'.repeat(64); fs.writeFileSync(fp, JSON.stringify(j)); }],
  ['M3-forge-bytes', function () { const fp = path.join(P, 'phases', fs.readdirSync(path.join(P, 'phases'))[0], 'phase.json'); const j = JSON.parse(fs.readFileSync(fp, 'utf8')); j.stdoutBytes = 1; fs.writeFileSync(fp, JSON.stringify(j)); }],
  ['M4-cross-case', function () { const fp = path.join(P, 'phases', fs.readdirSync(path.join(P, 'phases'))[0], 'phase.json'); const j = JSON.parse(fs.readFileSync(fp, 'utf8')); j.er = 'ER9-fake'; fs.writeFileSync(fp, JSON.stringify(j)); }],
  ['M5-sibling-path', function () { const fp = path.join(P, 'phases', fs.readdirSync(path.join(P, 'phases'))[0], 'phase.json'); const j = JSON.parse(fs.readFileSync(fp, 'utf8')); j.stdoutPath = '../evil/stdout.txt'; fs.writeFileSync(fp, JSON.stringify(j)); }],
  ['M6-real-junction', function () { const os = require('os'); const ext = path.join(os.tmpdir(), 'xj032m-' + Date.now()); fs.mkdirSync(ext, { recursive: true }); const jl = path.join(P, 'phases', 'jn'); try { fs.symlinkSync(ext, jl, 'junction'); } catch (e) { fs.mkdirSync(jl); } const fp = path.join(P, 'phases', fs.readdirSync(path.join(P, 'phases'))[0], 'phase.json'); const j = JSON.parse(fs.readFileSync(fp, 'utf8')); j.stdoutPath = path.join(jl, 'x'); fs.writeFileSync(fp, JSON.stringify(j)); }],
  ['M7-flatten-summary', function () { const fp = path.join(P, 'runner-self.json'); const j = JSON.parse(fs.readFileSync(fp, 'utf8')); j.phaseCount = 24; j.phases = []; fs.writeFileSync(fp, JSON.stringify(j)); }],
  ['M8-old-nonce', function () { const fp = path.join(P, 'phases', fs.readdirSync(path.join(P, 'phases'))[0], 'phase.json'); const j = JSON.parse(fs.readFileSync(fp, 'utf8')); j.runId = 'run-032-OLD'; fs.writeFileSync(fp, JSON.stringify(j)); }],
  ['M9-delete-runner-self-triplet', function () { for (const f of ['runner-self.stdout','runner-self.stderr','runner-self.meta.json']) { try { fs.unlinkSync(path.join(P, f)); } catch (e) {} } }]
];
let k = 0;
for (const a of ADV) {
  const snap = snapshot();
  a[1]();
  const failed = !runVer();
  // fresh restore：重跑 runner 重新生成（+ wrapper runner-self）
  cp.spawnSync(process.execPath, [path.join(S, 'runner-032.js')], { cwd: ROOT, encoding: 'utf8' });
  cp.spawnSync(process.execPath, [path.join(S, 'wrapper-032.js'), 'runner-self', path.join(S, 'runner-032.js')], { cwd: ROOT, encoding: 'utf8' });
  const rec = runVer();
  const ok = failed && rec; if (ok) k++;
  console.log((ok ? 'KILLED' : 'SURVIVED') + ' ' + a[0] + ' failed=' + failed + ' recovered=' + rec);
}
console.log('MUTATIONS_032: ' + k + '/9 KILLED');
process.exit(k === 9 ? 0 : 2);