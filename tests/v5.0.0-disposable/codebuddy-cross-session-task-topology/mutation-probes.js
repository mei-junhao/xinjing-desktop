'use strict';
// 变异探针：对 inventory/manifest 注入变异，断言 validator 拒绝（exit!=0）。
// 任何探针若让 validator 误通过（exit=0），本脚本以 exit=1 报告 FAIL（真实红）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const validator = path.join(HERE, 'validate-topology.js');
const baseInv = path.join(HERE, '..', '..', '..', 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'codebuddy-cross-session-task-topology', 'topology-inventory.json');
const baseManifest = path.join(HERE, '..', '..', '..', 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'codebuddy-cross-session-task-topology', 'protected-files-manifest.json');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function tmp(p, obj) { const t = path.join(os.tmpdir(), 'xj-topo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.json'); fs.writeFileSync(t, JSON.stringify(obj, null, 2)); return t; }

let pass = 0;
let failCount = 0;

// 期望 validator 失败；若通过则探针 FAIL（真实红）
function expectReject(label, inventoryMut, manifestMut) {
  const invFile = inventoryMut ? tmp('inv', inventoryMut(readJson(baseInv))) : null;
  const manFile = manifestMut ? tmp('man', manifestMut(readJson(baseManifest))) : null;
  const argv = [validator, '--inventory', invFile || baseInv];
  if (manFile) argv.push('--manifest', manFile);
  try {
    execFileSync(process.execPath, argv, { stdio: 'pipe' });
    console.error('PROBE FAIL: ' + label + ' —— validator 误通过（应为拒绝）');
    failCount++;
  } catch (e) {
    if (e.status === 0) { console.error('PROBE FAIL: ' + label + ' —— exit 0'); failCount++; }
    else { console.log('PROBE PASS: ' + label); pass++; }
  }
}

// N1：manifest 缺失 sha256
expectReject('N1-missing-protected-hash', null, (m) => { m.protected_files[0].sha256 = ''; return m; });

// N2：inventory 重复 id
expectReject('N2-duplicate-row', (inv) => { inv.rows.push(Object.assign({}, inv.rows[0])); return inv; }, null);

// N3：非法状态值
expectReject('N3-unsupported-status', (inv) => { inv.rows[0].status = 'IMPLEMENTED'; inv.summary.confirmed -= 1; return inv; }, null);

// N4：缺失源锚
expectReject('N4-missing-source-anchor', (inv) => { inv.rows[1].anchor = ''; return inv; }, null);

// N5：把 EXPECTED_RED 行（evidence 含「不存在」）标为 CONFIRMED —— 触发自相矛盾拒绝
expectReject('N5-expected-red-as-implemented', (inv) => {
  const r = inv.rows.find((x) => x.status === 'EXPECTED_RED' && /不存在|缺失/.test(x.evidence || ''));
  if (r) { r.status = 'CONFIRMED'; }
  // 重新对齐 summary 计数（让结构校验本身通过，仅触发矛盾规则）
  inv.summary.confirmed += 1; inv.summary.expected_red -= 1;
  return inv;
}, null);

// N6：伪造 CONFIRMED（evidence 含「计划」）
expectReject('N6-fabricated-confirmed', (inv) => {
  inv.rows[0].evidence = '计划在未来实现跨会话任务跟踪'; inv.rows[0].status = 'CONFIRMED';
  return inv;
}, null);

// N7：rework-02 (a) —— 非空错误哈希混入 manifest（此前假绿 3b/5）
expectReject('N7-wrong-nonempty-hash', null, (m) => {
  m.protected_files[0].sha256 = 'DEADBEEF' + '00'.repeat(28) + '99'; // 64 位非空错误值
  return m;
});

// N8：rework-02 (b) —— 伪造 CONFIRMED 行 + 看似合理但虚假证据 + anchor 符号在源码中不存在
expectReject('N8-fabricated-confirmed-realistic-anchor', (inv) => {
  inv.rows.push({
    id: 'Z9-fake-cross-session-task-entity',
    dimension: 'task-like state',
    anchor: 'app/js/store.js:1 storeCacheTasksEntityXYZ', // store.js 中不存在该符号
    status: 'CONFIRMED',
    evidence: '跨会话临床任务实体在 Store.cache.tasks 稳定持久化，并保留 derivedFrom 溯源字段。', // 无前瞻/缺失关键词
    note: '伪造'
  });
  inv.summary.confirmed += 1;
  return inv;
}, null);

// N9：rework-03 —— 借用真实存在的 getSessionsByClient 符号讲述虚假持久化语义
expectReject('N9-fabricated-confirmed-borrowed-real-symbol', (inv) => {
  inv.rows.push({
    id: 'Z9-fabricated-real-symbol',
    dimension: 'persistence',
    anchor: 'app/js/store.js:499 getSessionsByClient',
    status: 'CONFIRMED',
    evidence: 'getSessionsByClient 会把跨会谈临床任务实体持久化，并保留来源会谈引用。',
    note: 'synthetic reverse mutation'
  });
  inv.summary.confirmed += 1;
  return inv;
}, null);

// N10：保留合法 id/anchor/status，但把真实 evidence 替换成借用符号的虚假语义
expectReject('N10-replace-known-row-with-fabricated-semantics', (inv) => {
  const row = inv.rows.find((x) => x.id === 'B1-session-client-linkage');
  row.evidence = 'getSessionsByClient 会持久化跨会谈临床任务、退款和设备迁移状态。';
  return inv;
}, null);

console.log('');
console.log('mutation probes: ' + pass + ' passed, ' + failCount + ' failed');
process.exit(failCount === 0 ? 0 : 1);
