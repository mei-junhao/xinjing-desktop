'use strict';
// 022 symlink/junction capability probe（独立 stdout/stderr/meta 落盘，禁复用 021 raw）
const fs = require('fs'); const path = require('path'); const crypto = require('crypto'); const os = require('os');
const OUT = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-audit-rework-022';
fs.mkdirSync(OUT, { recursive: true });
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const startUtc = new Date().toISOString();
const out = []; const err = [];
const DIR = path.join(os.tmpdir(), 'xj022-probe-' + Date.now()); fs.mkdirSync(DIR, { recursive: true });
// 1) file symlink
const ft = path.join(DIR, 'ft.txt'); const fl = path.join(DIR, 'fl.txt'); fs.writeFileSync(ft, 'x');
try { fs.symlinkSync(ft, fl); out.push('FILE_SYMLINK_OK isSymbolicLink=' + fs.lstatSync(fl).isSymbolicLink()); fs.unlinkSync(fl); }
catch (e) { out.push('FILE_SYMLINK_EPERM code=' + e.code + ' msg=' + e.message); err.push('FILE_SYMLINK_EPERM ' + e.code); }
// 2) junction (directory link)
const dt = path.join(DIR, 'dt'); fs.mkdirSync(dt, { recursive: true }); const dl = path.join(DIR, 'dl');
try { fs.symlinkSync(dt, dl, 'junction'); const st = fs.lstatSync(dl); out.push('JUNCTION_OK isSymbolicLink=' + st.isSymbolicLink()); fs.rmdirSync(dl); }
catch (e) { out.push('JUNCTION_EPERM code=' + e.code + ' msg=' + e.message); err.push('JUNCTION_EPERM ' + e.code); }
const stdout = out.join('\n') + '\n'; const stderr = err.join('\n') + '\n';
const endUtc = new Date().toISOString();
const stdoutP = path.join(OUT, 'probe.stdout.txt'); const stderrP = path.join(OUT, 'probe.stderr.txt');
fs.writeFileSync(stdoutP, stdout); fs.writeFileSync(stderrP, stderr);
const meta = { command: process.execPath + ' ' + process.argv[1], argv: process.argv.slice(1), cwd: process.cwd(), startUtc: startUtc, endUtc: endUtc, exitCode: 0, stdoutPath: stdoutP, stderrPath: stderrP, stdoutSha256: sha(stdout), stdoutBytes: Buffer.byteLength(stdout), stderrSha256: sha(stderr), stderrBytes: Buffer.byteLength(stderr) };
fs.writeFileSync(path.join(OUT, 'probe.meta.json'), JSON.stringify(meta, null, 2) + '\n');
console.log(stdout.trim());
// 硬门禁：junction 必须 isSymbolicLink=true 才算真实现象（EPERM 已如实记录）
const junctionOk = out.some(l => l.indexOf('JUNCTION_OK isSymbolicLink=true') >= 0);
const fileEperm = out.some(l => l.indexOf('FILE_SYMLINK_EPERM') >= 0);
process.exit(junctionOk && fileEperm ? 0 : 2);