'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const c = require('./common-037');

function arg(n) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : ''; }
const clone = path.resolve(arg('--clone'));
const out = path.resolve(arg('--out'));
const verifier = path.join(__dirname, 'verifier-037.js');
function verifyRaw(dir) {
  const child = spawnSync(process.execPath, [verifier, '--clone', clone, '--out', dir], { cwd: c.PROJECT, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const code = Number.isInteger(child.status) ? child.status : -1;
  c.checkCaptured(dir, code);
  return code;
}
function mutateFile(p, f) { const before = fs.readFileSync(p); f(before); return { changed: fileChanged(p, before), restore: () => fs.writeFileSync(p, before) }; }
function mutateJson(p, f) { return mutateFile(p, (before) => { const value = JSON.parse(before.toString('utf8')); f(value); fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', 'utf8'); }); }
function entry(label) { return c.clonePath(clone, label); }
function fileChanged(p, before) { return !fs.existsSync(p) || !fs.readFileSync(p).equals(before); }
function runCase(def) {
  const caseRoot = path.join(out, 'cases', def.id); c.ensure(caseRoot);
  const baseline = path.join(caseRoot, 'baseline'); const mutated = path.join(caseRoot, 'mutated'); const restored = path.join(caseRoot, 'restore');
  const startedUtc = c.utc(); const baselineExit = verifyRaw(baseline);
  if (baselineExit !== 0) throw new Error('baseline failed before ' + def.id);
  const effect = def.mutate();
  if (!effect || effect.changed !== true || typeof effect.restore !== 'function') throw new Error('mutation was not demonstrably nonzero: ' + def.id);
  const mutatedExit = verifyRaw(mutated);
  effect.restore();
  const restoreExit = verifyRaw(restored);
  const overall = mutatedExit !== 0 && restoreExit === 0 ? 'KILLED' : 'SURVIVED';
  const meta = { taskId: c.TASK, attackId: def.id, name: def.name, description: def.description, startedUtc, endedUtc: c.utc(), freshRaw: true, mutationNonzero: true, baselineExit, mutatedExit, restoreExit, overall, raw: { baseline: c.checkCaptured(baseline, baselineExit), mutated: c.checkCaptured(mutated, mutatedExit), restore: c.checkCaptured(restored, restoreExit) } };
  c.writeJson(path.join(caseRoot, 'case-meta.json'), meta);
  if (overall !== 'KILLED') throw new Error('expected-red survived: ' + def.id);
  return meta;
}
function changeBytes(p, suffix) { const before = fs.readFileSync(p); fs.appendFileSync(p, suffix); return { changed: fileChanged(p, before), restore: () => fs.writeFileSync(p, before) }; }
function deleteFile(p) { const before = fs.readFileSync(p); fs.rmSync(p); return { changed: !fs.existsSync(p), restore: () => fs.writeFileSync(p, before) }; }
function main() {
  const filesDoc = path.join(clone, 'binding', 'final-binding-files-035.json'); const manifestDoc = path.join(clone, 'binding', 'final-binding-manifest-035.json'); const freezeMeta = path.join(clone, 'support', '035-self', 'freeze-verifier', 'meta.json');
  const cases = [
    { id: '01-delete-stage-raw', name: '删除 033 stage raw', description: '删除克隆的 evidence 原始 stdout；验证器必须拒绝缺失条目。', mutate: () => deleteFile(entry('evidence/cases/wrong-db-name/mutated/stdout.txt')) },
    { id: '02-tamper-033-raw', name: '篡改 033 raw', description: '追加字节到克隆 evidence 原始 stdout。', mutate: () => changeBytes(entry('evidence/cases/wrong-key/baseline/stdout.txt'), Buffer.from('XJ037-TAMPER')) },
    { id: '03-replace-harness', name: '替换 harness', description: '替换 cloned common.js 字节。', mutate: () => mutateFile(entry('harness/common.js'), () => fs.writeFileSync(entry('harness/common.js'), '// XJ037 replaced\n', 'utf8')) },
    { id: '04-delete-freeze-stdout', name: '删除 freeze stdout', description: '删除原 freeze-verifier parent raw stdout。', mutate: () => deleteFile(path.join(clone, 'support/035-self/freeze-verifier/stdout.txt')) },
    { id: '05-tamper-freeze-stderr', name: '篡改 freeze stderr', description: '追加 parent stderr 字节。', mutate: () => changeBytes(path.join(clone, 'support/035-self/freeze-verifier/stderr.txt'), Buffer.from('XJ037-TAMPER')) },
    { id: '06-remove-source-binding', name: '删除 source binding', description: '删除最终 binding 中一个 harness 条目。', mutate: () => { const before = fs.readFileSync(filesDoc); const doc = JSON.parse(before); doc.entries = doc.entries.filter((x) => x.label !== 'harness/audit.js'); doc.entryCount = doc.entries.length; fs.writeFileSync(filesDoc, JSON.stringify(doc, null, 2) + '\n'); return { changed: !fs.readFileSync(filesDoc).equals(before), restore: () => fs.writeFileSync(filesDoc, before) }; } },
    { id: '07-replica-argv', name: '034 replica source substitution', description: '把 capturedFrom 与 argv[0] 改成 034 replica。', mutate: () => mutateJson(freezeMeta, (m) => { m.capturedFrom = 'D:/xinjing-electron/scripts/v5.1.1-tests/XJ-5.1.1-billing-store-cross-restart-hydration-final-binding-evidence-closure-rework-034/freeze-replica-check.js'; m.argv[0] = m.capturedFrom; }) },
    { id: '08-forge-source-digest', name: '伪造 source SHA/bytes', description: '篡改 executedSourceSha256、bytes 与 byte-identical 标记。', mutate: () => mutateJson(freezeMeta, (m) => { m.executedSourceSha256 = '00'.repeat(32); m.executedSourceBytes = 1; m.sourceByteIdentical = false; }) },
    { id: '09-redirect-old-root', name: 'redirectRoot 指回 033', description: '禁用等效隔离，redirectRoot 指向旧 033 candidate。', mutate: () => mutateJson(freezeMeta, (m) => { m.redirectRoot = c.C33; m.mapping.prefixAfter = c.C33; m.mapping.scope = 'writes outside 035 allowed'; delete m.hookSha256; }) },
    { id: '10-tamper-store', name: '篡改 Store', description: '篡改 staged store.js。', mutate: () => changeBytes(entry('store/store.js'), Buffer.from('XJ037-TAMPER')) },
    { id: '11-tamper-card', name: '篡改 035 卡', description: '篡改 staged 035 card。', mutate: () => changeBytes(entry('card/035'), Buffer.from('XJ037-TAMPER')) },
    { id: '12-forge-flags', name: '伪造发布 flags', description: '把 releaseReady 改为 true。', mutate: () => mutateJson(manifestDoc, (m) => { m.flags.releaseReady = true; }) },
    { id: '13-relative-cwd-path-escape', name: '相对 cwd/路径逃逸', description: '把 parent meta cwd 改相对路径，stdoutPath 改为 .. 逃逸。', mutate: () => mutateJson(freezeMeta, (m) => { m.cwd = '.'; m.stdoutPath = '..\\outside\\stdout.txt'; }) },
    { id: '14-summary-only', name: 'summary-only 伪造', description: '只改 final manifest aggregate summary，不改任何原始条目。', mutate: () => mutateJson(manifestDoc, (m) => { m.aggregateSha256 = 'ff'.repeat(32); }) },
    { id: '15-old-cross-case-raw', name: '旧 raw/跨 case raw', description: '用 runner stdout 替换 freeze stdout。', mutate: () => { const p = path.join(clone, 'support/035-self/freeze-verifier/stdout.txt'); const before = fs.readFileSync(p); fs.copyFileSync(path.join(clone, 'support/035-self/exact-freeze-runner/stdout.txt'), p); return { changed: !fs.readFileSync(p).equals(before), restore: () => fs.writeFileSync(p, before) }; } },
    { id: '16-exitcode-only', name: '只改 exitCode', description: '不改摘要，只把 parent meta exitCode 改为 1。', mutate: () => mutateJson(freezeMeta, (m) => { m.exitCode = 1; }) },
    { id: '17-reparse-escape', name: 'reparse/junction 路径逃逸', description: '将 cloned harness 文件替换为指向 sibling 的真实 symlink。', mutate: () => { const p = entry('harness/common.js'); const before = fs.readFileSync(p); fs.rmSync(p); fs.symlinkSync(entry('harness/runner.js'), p, 'file'); const linked = fs.lstatSync(p).isSymbolicLink(); return { changed: linked, restore: () => { fs.rmSync(p); fs.writeFileSync(p, before); } }; } }
  ];
  const results = cases.map(runCase); return { type: 'expected-red-037-summary', taskId: c.TASK, clone, total: results.length, killed: results.filter((x) => x.overall === 'KILLED').length, restoresPass: results.filter((x) => x.restoreExit === 0).length, mutatedNonZero: results.filter((x) => x.mutatedExit !== 0).length, verdict: 'PASS' };
}
const result = c.capture(out, 'expected-red-037', main);
process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.exitCode;
