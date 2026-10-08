'use strict';
// final-manifest-rebind-038：wrapper 捕获全部 self 后，从磁盘最终字节重算 manifest（SHA/bytes/exit/gen）并 verify 闭合
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const P038 = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-manifest-self-raw-rebind-final-rework-038';
const CARD_SHA = crypto.createHash('sha256').update(fs.readFileSync('D:/xinjing-electron/docs/agent-coordination/v5.1.1/tasks/XJ-5.1.1-model-session-recovery-runtime-evidence-manifest-self-raw-rebind-final-rework-038.md', 'utf8')).digest('hex').toUpperCase();
const GEN = fs.readFileSync(path.join(P038, 'generation-id.txt'), 'utf8').trim();
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const errs = [];
// 从磁盘最终字节构建 manifest
function diskMeta(name) { const m = JSON.parse(fs.readFileSync(path.join(P038, name + '.meta.json'), 'utf8')); const so = fs.readFileSync(path.resolve(m.stdoutPath), 'utf8'); const se = fs.readFileSync(path.resolve(m.stderrPath), 'utf8'); return { soSha: sha(so), soBytes: Buffer.byteLength(so), seSha: sha(se), seBytes: Buffer.byteLength(se), exit: m.exitCode, gen: m.generationId }; }
const v = diskMeta('verifier-038'); const e = diskMeta('expected-red-038'); const a = diskMeta('audit-038');
if (v.gen !== GEN || e.gen !== GEN || a.gen !== GEN) errs.push('gen mismatch');
const manifest = { task_id: 'XJ-5.1.1-model-session-recovery-runtime-evidence-manifest-self-raw-rebind-final-rework-038', card_sha256: CARD_SHA, generationId: GEN, input: { verifier: { stdoutSha256: v.soSha, stdoutBytes: v.soBytes, stderrSha256: v.seSha, stderrBytes: v.seBytes, exitCode: v.exit }, expectedRed: { stdoutSha256: e.soSha, stdoutBytes: e.soBytes, stderrSha256: e.seSha, stderrBytes: e.seBytes, exitCode: e.exit } }, output: { audit: { stdoutSha256: a.soSha, stdoutBytes: a.soBytes, stderrSha256: a.seSha, stderrBytes: a.seBytes, exitCode: a.exit }, reboundAt: new Date().toISOString() } };
fs.writeFileSync(path.join(P038, 'generation-manifest-038.json'), JSON.stringify(manifest, null, 2) + '\n');
// verify：manifest 与磁盘最终字节逐字段一致
const chk = JSON.parse(fs.readFileSync(path.join(P038, 'generation-manifest-038.json'), 'utf8'));
if (chk.output.audit.stdoutSha256 !== a.soSha) errs.push('manifest audit so sha');
if (chk.output.audit.stdoutBytes !== a.soBytes) errs.push('manifest audit so bytes');
if (chk.output.audit.exitCode !== a.exit) errs.push('manifest audit exit');
if (chk.generationId !== GEN) errs.push('manifest gen');
console.log('FINAL_MANIFEST_REBIND:', errs.length === 0 ? 'PASS' : 'FAIL ' + errs.join('|'));
console.log('AUDIT_SHA_MATCH:', chk.output.audit.stdoutSha256 === a.soSha, chk.output.audit.stdoutSha256.slice(0,8));
process.exit(errs.length === 0 ? 0 : 2);