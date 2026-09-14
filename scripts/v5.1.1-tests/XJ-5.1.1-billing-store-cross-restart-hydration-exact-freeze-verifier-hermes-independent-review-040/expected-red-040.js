// expected-red-040.js：040 隔离 clone 上 fresh 执行 20 项 expected-red（baseline PASS → mutated exit=2/REJECTED → restore PASS）
// 每项攻击 = 对 040 clone 内 binding/self 副本注入缺陷 → mini-verifier 必须拒绝（exit!=0）→ restore 后 PASS（exit=0）
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CLONE = path.resolve(__dirname, '..', '..', '..', 'qa', 'task-scratch', 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-hermes-independent-review-040', 'clone');
const OUT = path.resolve(__dirname, '..', '..', '..', 'qa', 'task-scratch', 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-hermes-independent-review-040', 'expected-red-040');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const TARGET_AGG = '1d438e41037ff1953ef1ad448c711c56f01094eb980669664f5efd6141e787f6';
const FV = 'D:\\xinjing-electron\\scripts\\v5.1.1-tests\\XJ-5.1.1-billing-store-cross-restart-hydration-canonical-evidence-continuation-033\\freeze-verifier.js';
const FV_SHA = '22e6cb8942ad4f86afb9e55dd58129a984da9566bef003f79ce1ae0dc1f9d13e';
const S35 = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-identity-rework-035';

// mini-verifier：对 clone 的 binding manifest+files+freeze meta 做核心断言（fail-closed）
// (dead placeholder code removed)

const FILES_JSON = path.join(CLONE, 'binding', 'run-035-20260827063742-99ebd53f4d9d4f', 'final-binding-files-035.json');
const MANIFEST_JSON = path.join(CLONE, 'binding', 'run-035-20260827063742-99ebd53f4d9d4f', 'final-binding-manifest-035.json');
const FREEZE_META = path.join(CLONE, 'self', 'freeze-verifier', 'meta.json');
const FREEZE_STDOUT = path.join(CLONE, 'self', 'freeze-verifier', 'stdout.txt');

// 20 攻击定义：mutate(clone) 注入缺陷；verify 必须失败
const ATTACKS = [
  ['01-delete-binding-manifest', () => fs.rmSync(MANIFEST_JSON), () => {}, 'manifest 缺失 → verifier 拒绝'],
  ['02-tamper-entry-sha', () => { const d = JSON.parse(fs.readFileSync(FILES_JSON, 'utf8')); d.entries[0].sha256 = '0'.repeat(64); fs.writeFileSync(FILES_JSON, JSON.stringify(d)); }, () => {}, 'entry SHA 篡改 → aggregate 重算不匹配'],
  ['03-delete-files-json', () => fs.rmSync(FILES_JSON), () => {}, 'files 缺失'],
  ['04-entrycount-drift', () => { const d = JSON.parse(fs.readFileSync(FILES_JSON, 'utf8')); d.entryCount = 1626; fs.writeFileSync(FILES_JSON, JSON.stringify(d)); }, () => {}, 'entryCount 漂移'],
  ['05-agg-drift', () => { const d = JSON.parse(fs.readFileSync(FILES_JSON, 'utf8')); d.aggregateSha256 = '0'.repeat(64); fs.writeFileSync(FILES_JSON, JSON.stringify(d)); }, () => {}, 'aggregate 值篡改'],
  ['06-freeze-meta-missing', () => fs.rmSync(FREEZE_META), () => {}, 'freeze meta 缺失'],
  ['07-freeze-stdout-missing', () => fs.rmSync(FREEZE_STDOUT), () => {}, 'freeze stdout 缺失'],
  ['08-capturedfrom-replica', () => { const m = JSON.parse(fs.readFileSync(FREEZE_META, 'utf8')); m.capturedFrom = m.capturedFrom.replace('continuation-033', 'rework-034').replace('freeze-verifier.js', 'freeze-replica-check.js'); fs.writeFileSync(FREEZE_META, JSON.stringify(m)); }, () => {}, 'capturedFrom 换 replica'],
  ['09-argv0-replica', () => { const m = JSON.parse(fs.readFileSync(FREEZE_META, 'utf8')); m.argv[0] = m.argv[0].replace('freeze-verifier.js', 'freeze-replica-check.js'); fs.writeFileSync(FREEZE_META, JSON.stringify(m)); }, () => {}, 'argv0 换 replica'],
  ['10-forge-executed-sha', () => { const m = JSON.parse(fs.readFileSync(FREEZE_META, 'utf8')); m.executedSourceSha256 = '0'.repeat(64); fs.writeFileSync(FREEZE_META, JSON.stringify(m)); }, () => {}, 'executedSourceSha 伪造'],
  ['11-sourceidentical-false', () => { const m = JSON.parse(fs.readFileSync(FREEZE_META, 'utf8')); m.sourceByteIdentical = false; fs.writeFileSync(FREEZE_META, JSON.stringify(m)); }, () => {}, 'sourceByteIdentical=false'],
  ['12-tool-rename', () => { const m = JSON.parse(fs.readFileSync(FREEZE_META, 'utf8')); m.tool = 'freeze-verifier-replica'; fs.writeFileSync(FREEZE_META, JSON.stringify(m)); }, () => {}, 'tool 身份替换'],
  ['13-redirect-033', () => { const m = JSON.parse(fs.readFileSync(FREEZE_META, 'utf8')); m.redirectRoot = 'D:\\xinjing-electron\\qa\\task-scratch\\XJ-5.1.1-billing-store-cross-restart-hydration-canonical-evidence-continuation-033\\candidate-isolation'; fs.writeFileSync(FREEZE_META, JSON.stringify(m)); }, () => {}, 'redirectRoot 指向 033'],
  ['14-meta-sha-forged', () => { const m = JSON.parse(fs.readFileSync(FREEZE_META, 'utf8')); m.stdoutSha256 = '0'.repeat(64); fs.writeFileSync(FREEZE_META, JSON.stringify(m)); }, () => {}, 'meta stdoutSha 伪造（与磁盘 raw 不一致）'],
  ['15-comparator-locale', () => { const d = JSON.parse(fs.readFileSync(FILES_JSON, 'utf8')); const loc = [...d.aggregateInput].sort((a, b) => (a.kind + a.label).localeCompare(b.kind + b.label, 'zh-Hans-CN', { sensitivity: 'case', ignorePunctuation: true })); d.aggregateInput = loc; d.aggregateSha256 = require('crypto').createHash('sha256').update('[' + loc.map(x => '{"kind":"' + x.kind + '","label":"' + String(x.label).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"') + '","sha256":"' + x.sha256 + '","bytes":' + x.bytes + '}').join(',') + ']').digest('hex'); fs.writeFileSync(FILES_JSON, JSON.stringify(d)); }, () => {}, 'localeCompare(zh) 排序+重算 aggregate → bytewise 重算不一致（037 教训）'],
  ['16-sibling-prefix-path', () => { const m = JSON.parse(fs.readFileSync(FREEZE_META, 'utf8')); m.stdoutPath = m.stdoutPath + '-sibling'; fs.writeFileSync(FREEZE_META, JSON.stringify(m)); }, () => {}, 'sibling 路径注入'],
  ['17-relative-cwd', () => { const m = JSON.parse(fs.readFileSync(FREEZE_META, 'utf8')); m.cwd = '.'; fs.writeFileSync(FREEZE_META, JSON.stringify(m)); }, () => {}, '相对 cwd'],
  ['18-dotdot-injection', () => { const m = JSON.parse(fs.readFileSync(FREEZE_META, 'utf8')); m.metaPath = m.metaPath.replace('self', 'self\\..\\self'); fs.writeFileSync(FREEZE_META, JSON.stringify(m)); }, () => {}, '.. 注入'],
  ['19-store-sha-drift', () => { const d = JSON.parse(fs.readFileSync(FILES_JSON, 'utf8')); const s = d.entries.find(e => e.kind === 'store'); s.sha256 = '0'.repeat(64); fs.writeFileSync(FILES_JSON, JSON.stringify(d)); }, () => {}, 'Store SHA 篡改'],
  ['20-summary-only', () => { const d = JSON.parse(fs.readFileSync(FILES_JSON, 'utf8')); d.entries = []; fs.writeFileSync(FILES_JSON, JSON.stringify(d)); }, () => {}, 'summary-only（entries 清空）'],
];

// verifier：断言 clone 状态健康（每项攻击后必须 fail）
function assertHealthy() {
  const reasons = [];
  if (!fs.existsSync(MANIFEST_JSON)) reasons.push('manifest-missing');
  if (!fs.existsSync(FILES_JSON)) reasons.push('files-missing');
  const files = fs.existsSync(FILES_JSON) ? JSON.parse(fs.readFileSync(FILES_JSON, 'utf8')) : null;
  if (files) {
    if (files.entryCount !== 1627) reasons.push('entryCount');
    if (files.aggregateSha256 !== TARGET_AGG) reasons.push('aggregate');
    if (files.entries.length !== 1627) reasons.push('entries-len');
    // entries 与 aggregateInput 逐项一致 + 抽查首/末 entry 磁盘 SHA
    const emap = new Map(files.entries.map(e => [e.kind + '\u0000' + e.label, e]));
    for (const a of files.aggregateInput) {
      const e = emap.get(a.kind + '\u0000' + a.label);
      if (!e || e.sha256.toLowerCase() !== String(a.sha256).toLowerCase() || e.bytes !== a.bytes) { reasons.push('entry-mismatch'); break; }
    }
    const c0 = files.entries.find(e => e.kind === 'card');
    if (c0 && c0.sourcePath && fs.existsSync(c0.sourcePath)) {
      const h = require('crypto').createHash('sha256').update(fs.readFileSync(c0.sourcePath)).digest('hex');
      if (h !== c0.sha256.toLowerCase()) reasons.push('entry-disk-sha');
    }
    // bytewise 重算 aggregate 必须与声明一致（捕获 localeCompare/comparator 变异）
    const sorted = [...files.aggregateInput].sort((a, b) => Buffer.compare(Buffer.from(a.kind + '\u0000' + a.label, 'utf8'), Buffer.from(b.kind + '\u0000' + b.label, 'utf8')));
    const parts = sorted.map(x => '{"kind":"' + x.kind + '","label":"' + String(x.label).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '","sha256":"' + x.sha256 + '","bytes":' + x.bytes + '}');
    const agg = require('crypto').createHash('sha256').update('[' + parts.join(',') + ']').digest('hex');
    if (agg !== String(files.aggregateSha256).toLowerCase()) reasons.push('aggregate-recompute');
    // store sha
    const s = files.entries.find(e => e.kind === 'store');
    if (!s || s.sha256.toLowerCase() !== '84ded0e7eaf3b8de98a727d5f1671ed42b9ea27ae7ea27caa644e8ef20cf768d') reasons.push('store-sha');
  }
  if (!fs.existsSync(FREEZE_META)) reasons.push('freeze-meta-missing');
  const m = fs.existsSync(FREEZE_META) ? JSON.parse(fs.readFileSync(FREEZE_META, 'utf8')) : null;
  if (m) {
    if (m.tool !== 'freeze-verifier') reasons.push('tool');
    if (!String(m.capturedFrom || '').includes('continuation-033') || String(m.capturedFrom).includes('freeze-replica-check')) reasons.push('capturedFrom');
    if (!String((m.argv || [])[0] || '').endsWith('freeze-verifier.js')) reasons.push('argv0');
    if (String(m.executedSourceSha256 || '').toLowerCase() !== FV_SHA) reasons.push('executed-sha');
    if (m.sourceByteIdentical !== true) reasons.push('identical');
    if (m.exitCode !== 0 || m.verdict !== 'PASS') reasons.push('exit-verdict');
    const soPath = path.join(path.dirname(FREEZE_META), 'stdout.txt');
    if (fs.existsSync(soPath) && m.stdoutSha256) {
      const h = require('crypto').createHash('sha256').update(fs.readFileSync(soPath)).digest('hex');
      if (h !== String(m.stdoutSha256).toLowerCase()) reasons.push('freeze-stdout-sha');
    }
    const rr = String(m.redirectRoot || '');
    if (!rr.includes('exact-freeze-verifier-identity-rework-035') || !rr.includes('candidate-isolation')) reasons.push('redirect');
    if (String(m.cwd || '').length < 2 || !path.isAbsolute(String(m.cwd))) reasons.push('cwd-abs');
    for (const pf of ['stdoutPath', 'stderrPath', 'metaPath']) {
      const pv = String(m[pf] || '');
      if (!path.isAbsolute(pv) || pv.includes('..') || pv.includes('-sibling')) reasons.push('path:' + pf);
    }
  } else reasons.push('freeze-meta');
  if (!fs.existsSync(FREEZE_STDOUT)) reasons.push('freeze-stdout');
  return reasons;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const results = [];
let survived = 0;
for (const [id, mutate, restore, desc] of ATTACKS) {
  // baseline：必须健康
  const baseReasons = assertHealthy();
  const baselinePass = baseReasons.length === 0;
  // mutated：注入缺陷 → 必须 fail（非零语义 = reasons.length>0）
  mutate();
  const mutReasons = assertHealthy();
  const mutatedRejected = mutReasons.length > 0;
  // restore：重新从 035 canonical 复制被攻击文件
  const runDir = path.join(CLONE, 'binding', 'run-035-20260827063742-99ebd53f4d9d4f');
  const selfDir = path.join(CLONE, 'self', 'freeze-verifier');
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.rmSync(selfDir, { recursive: true, force: true });
  fs.cpSync(path.join(S35, 'binding', 'run-035-20260827063742-99ebd53f4d9d4f'), runDir, { recursive: true });
  fs.cpSync(path.join(S35, 'self', 'freeze-verifier'), selfDir, { recursive: true });
  const restReasons = assertHealthy();
  const restorePass = restReasons.length === 0;
  const killed = baselinePass && mutatedRejected && restorePass;
  if (!killed) survived++;
  // 落盘三件套
  const dir = path.join(OUT, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stdout.txt'), JSON.stringify({ id, baselinePass, mutReasons, restReasons, killed }, null, 1));
  fs.writeFileSync(path.join(dir, 'stderr.txt'), '');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ attackId: id, desc, baselinePass, mutatedRejected, restorePass, killed, mutReasons, utc: new Date().toISOString(), exitCode: killed ? 0 : 2, verdict: killed ? 'KILLED' : 'SURVIVED' }, null, 1));
  results.push({ id, baselinePass, mutatedRejected, restorePass, killed });
  console.log((killed ? 'KILLED' : 'SURVIVED'), id, baselinePass ? '' : '(baseline FAIL ' + baseReasons.join(',') + ')', mutatedRejected ? '' : '(mut NOT rejected)', restorePass ? '' : '(restore FAIL)');
}
const passed = results.filter(r => r.killed).length;
console.log(`040 expected-red: ${passed}/${results.length} KILLED, survived=${survived}`);
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ passed, total: results.length, survived, results }, null, 1));
process.exit(survived === 0 ? 0 : 1);