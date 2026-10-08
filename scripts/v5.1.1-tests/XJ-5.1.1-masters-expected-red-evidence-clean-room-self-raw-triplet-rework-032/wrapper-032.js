'use strict';
// wrapper：spawnSync 捕获命令 stdout/stderr/exit → 写 {name}.stdout/.stderr/.meta.json 三件套
const cp = require('child_process'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const OUT = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-masters-expected-red-evidence-clean-room-self-raw-triplet-rework-032';
const name = process.argv[2]; const script = process.argv[3];
const runId = 'run-032-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const startUtc = new Date().toISOString();
const r = cp.spawnSync(process.execPath, [script], { cwd: 'D:/xinjing-electron', encoding: 'utf8' });
const endUtc = new Date().toISOString();
const so = r.stdout || ''; const se = r.stderr || '';
const soP = path.join(OUT, name + '.stdout'); const seP = path.join(OUT, name + '.stderr');
fs.writeFileSync(soP, so); fs.writeFileSync(seP, se);
const meta = { name: name, runId: runId, command: 'node ' + script, argv: [script], cwd: 'D:/xinjing-electron', startUtc: startUtc, endUtc: endUtc, exitCode: r.status === null ? -1 : r.status, stdoutPath: soP, stderrPath: seP, stdoutSha256: sha(so), stdoutBytes: Buffer.byteLength(so), stderrSha256: sha(se), stderrBytes: Buffer.byteLength(se) };
fs.writeFileSync(path.join(OUT, name + '.meta.json'), JSON.stringify(meta, null, 2) + '\n');
console.log('WRAPPED ' + name + ' exit=' + meta.exitCode);
process.exit(meta.exitCode === 0 ? 0 : 2);