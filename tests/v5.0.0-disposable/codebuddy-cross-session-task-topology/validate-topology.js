'use strict';
// 拓扑盘点校验器：拒绝缺失保护哈希、重复行、非法状态、伪造的 CONFIRMED、缺失源锚、
// 以及把 EXPECTED_RED 当实现的清单。纯 Node，不依赖浏览器/window。
//
// rework-02 增强（关闭此前两处假绿）：
//  (a) 用 crypto 重算每个保护文件的真实 SHA-256 并与 manifest 记录比对，非空错误哈希一律拒绝；
//  (b) 对 CONFIRMED 行强制其 anchor 指向的符号在对应保护源码中真实存在，纯文本伪造行一律拒绝。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const HERE = __dirname;
const PROJECT_ROOT = path.resolve(HERE, '..', '..', '..');
const invPath = getArg('--inventory') || path.join(PROJECT_ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'codebuddy-cross-session-task-topology', 'topology-inventory.json');
const manifestPath = getArg('--manifest') || path.join(PROJECT_ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'codebuddy-cross-session-task-topology', 'protected-files-manifest.json');

const VALID = new Set(['CONFIRMED', 'EXPECTED_RED', 'BLOCKED', 'UNVERIFIED']);
const FORWARD = /(计划|planned|将实现|规划中|longitudinal summary|旧报告)/i;
const NEGATIVE = /(不存在|缺失|无独立|not exist|missing|未实现|没有独立)/i;
// 标识符 token：用于从 anchor 提取符号名做真实存在性校验
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g;

// This inventory is a fixed, candidate-bound topology contract. Generic
// "symbol exists somewhere" checks are insufficient because a fabricated
// claim can borrow a real symbol. Each row is therefore bound to its exact
// status, anchor, evidence vocabulary and, for CONFIRMED rows, source probes.
const ROW_SPECS = {
  'A1-task-state-session-status': spec('CONFIRMED', 'app/js/session-calendar.js:113 statusOf', ['会谈级状态机', 'pending', 'confirmed', 'completed', 'cancelled', 'no_show'], ['statusOf', 'pending', 'confirmed', 'completed', 'cancelled', 'no_show']),
  'A2-no-cross-session-task-entity': spec('EXPECTED_RED', 'app/js/store.js (cache 无 tasks 数组)', ['不存在独立的', '跨会话持久化', '临床任务对象']),
  'A3-recurrence-series': spec('CONFIRMED', 'app/js/session-calendar.js:710 payload.seriesId/recurrence', ['重复预约系列', 'seriesId', 'recurrence'], ['seriesId', 'recurrence', 'weekly', 'biweekly', 'monthly']),
  'A4-derived-todo-not-persistent': spec('EXPECTED_RED', 'app/js/dashboard.js:110 renderTodo', ['运行时计算', '不持久化', '无独立状态机']),
  'B1-session-client-linkage': spec('CONFIRMED', 'app/js/store.js:499 getSessionsByClient', ['session.clientId', 'getSessionsByClient', 'clientId'], ['getSessionsByClient', 'clientId', 'sessionNumber']),
  'B2-no-origin-session-traceability': spec('EXPECTED_RED', 'app/js/store.js:703 createSessionDurable', ['不写入', '来源会话字段', '无显式溯源链']),
  'C1-client-linkage-cascade': spec('CONFIRMED', 'app/js/store.js:462 deleteClient', ['deleteClient', '级联删除', 'sessions', 'supervisions', 'materialWorkspaces'], ['deleteClient', 'sessions', 'supervisions', 'materialWorkspaces']),
  'D1-dashboard-render': spec('CONFIRMED', 'app/js/dashboard.js:renderStats/renderTodo/renderRecent', ['仪表盘渲染', '待补记录', '待办列表'], ['renderStats', 'renderTodo', 'renderRecent']),
  'D2-no-cross-session-task-view': spec('EXPECTED_RED', 'app/js/dashboard.js:110 renderTodo', ['无独立跨会话任务列表', '无终态可见性']),
  'E1-calendar-views': spec('CONFIRMED', 'app/js/session-calendar.js:242 renderMonth', ['月/周/日三视图', '重复系列'], ['renderMonth', 'renderWeek', 'renderDay']),
  'E2-followup-is-type-label-only': spec('EXPECTED_RED', 'app/js/session-calendar.js:32 TYPE_CFG', ['仅是会谈类型标签', '无独立的后续']),
  'F1-indexeddb-persistence': spec('CONFIRMED', 'app/js/store.js:602 saveSessionDurable', ['IndexedDB', 'saveSessionDurable', '持久化会话'], ['saveSessionDurable', 'saveSessionsDurable', 'idb']),
  'F2-derived-todo-not-persisted': spec('EXPECTED_RED', 'app/js/dashboard.js:110 renderTodo', ['派生待办不持久化', '无持久存储']),
  'G1-session-completion-cancellation': spec('CONFIRMED', 'app/js/session-calendar.js:456 setStatus / :472 removeSession', ['setStatus', 'completed', 'cancelled', 'no_show', '三选项'], ['setStatus', 'removeSession', 'completed', 'cancelled', 'no_show']),
  'G2-no-task-completion-semantics': spec('EXPECTED_RED', 'app/js/store.js (无 task 实体)', ['任务的完成/取消语义不存在', '无 task 实体']),
  'H1-source-session-deletion': spec('CONFIRMED', 'app/js/store.js:762 deleteSessionDurable', ['deleteSessionDurable', '级联删除', 'deletedSessionIds'], ['deleteSessionDurable', 'buildSessionDeleteState', 'deletedSessionIds']),
  'I1-migration-version-handling': spec('CONFIRMED', 'app/js/store.js:167 migrateFromLocalStorage / :261 mergeLegacyBlobs / :1782 maybeDedupe', ['migrateFromLocalStorage', 'mergeLegacyBlobs', 'maybeDedupe'], ['migrateFromLocalStorage', 'mergeLegacyBlobs', 'maybeDedupe'])
};

function spec(status, anchor, evidenceAll, sourceAll) {
  return { status, anchor, evidenceAll, sourceAll: sourceAll || [] };
}

const errors = [];
function fail(msg) { errors.push(msg); }

// --- 读 inventory ---
let inv;
try {
  inv = JSON.parse(fs.readFileSync(invPath, 'utf8'));
} catch (e) {
  fail('无法读取 inventory: ' + e.message);
  report();
}

// --- 保护哈希：rework-02 (a) 重算真实哈希并比对 manifest（须在行循环前完成，供 verifyAnchor 使用）---
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  fail('无法读取 manifest: ' + e.message);
}
const protectedSet = new Set();
if (manifest && Array.isArray(manifest.protected_files)) {
  for (const pf of manifest.protected_files) {
    if (!pf.path) { fail('manifest 某 protected_file 缺少 path'); continue; }
    if (!pf.sha256 || typeof pf.sha256 !== 'string' || !pf.sha256.trim()) { fail('manifest 缺少 sha256: ' + pf.path); continue; }
    protectedSet.add(pf.path);
    const abs = path.resolve(PROJECT_ROOT, pf.path);
    let buf;
    try { buf = fs.readFileSync(abs); }
    catch (e) { fail('保护文件无法读取（重算哈希失败）: ' + pf.path + ' — ' + e.message); continue; }
    const actual = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
    const expected = String(pf.sha256).trim().toUpperCase();
    if (actual !== expected) fail('保护文件哈希不匹配: ' + pf.path + ' 实算=' + actual + ' manifest=' + expected);
  }
}

// --- 结构 ---
if (inv.schema_version !== 1) fail('schema_version 必须为 1');
if (!inv.task_id) fail('缺少 task_id');
if (!Array.isArray(inv.rows)) fail('rows 必须是数组');

const ids = new Set();
const counts = { CONFIRMED: 0, EXPECTED_RED: 0, BLOCKED: 0, UNVERIFIED: 0 };

for (const row of (inv.rows || [])) {
  if (!row.id || typeof row.id !== 'string') fail('某行缺少 id');
  else {
    if (ids.has(row.id)) fail('重复行 id: ' + row.id);
    ids.add(row.id);
  }
  if (!row.dimension || typeof row.dimension !== 'string') fail('行 ' + row.id + ' 缺少 dimension');
  if (!row.anchor || typeof row.anchor !== 'string' || !row.anchor.trim()) fail('行 ' + row.id + ' 缺少源锚 (source anchor)');
  if (!VALID.has(row.status)) fail('行 ' + row.id + ' 非法状态: ' + row.status);
  else counts[row.status]++;
  if (!row.evidence || typeof row.evidence !== 'string' || !row.evidence.trim()) fail('行 ' + row.id + ' 缺少 evidence');

  const rowSpec = ROW_SPECS[row.id];
  if (!rowSpec) {
    fail('发现规范外拓扑行: ' + row.id);
  } else {
    if (row.status !== rowSpec.status) fail('行 ' + row.id + ' 状态偏离固定规范: ' + row.status + ' != ' + rowSpec.status);
    if (row.anchor !== rowSpec.anchor) fail('行 ' + row.id + ' anchor 偏离固定规范: ' + row.anchor);
    for (const token of rowSpec.evidenceAll) {
      if (!(row.evidence || '').includes(token)) fail('行 ' + row.id + ' evidence 缺少必需语义: ' + token);
    }
  }

  if (row.status === 'CONFIRMED') {
    if (FORWARD.test(row.evidence || '')) fail('行 ' + row.id + ' CONFIRMED 但 evidence 含前瞻/计划性措辞（疑似伪造已实现）');
    if (NEGATIVE.test(row.evidence || '')) fail('行 ' + row.id + ' CONFIRMED 但 evidence 自相矛盾（声称缺失/不存在，却标已实现）');
    // rework-02 (b)：CONFIRMED 的 anchor 必须指向真实存在的保护源码符号
    verifyAnchor(row.id, row.anchor, rowSpec);
  }
}

for (const id of Object.keys(ROW_SPECS)) {
  if (!ids.has(id)) fail('缺少固定拓扑行: ' + id);
}

// --- summary 一致性 ---
if (!inv.summary) fail('缺少 summary');
else {
  const map = { confirmed: 'CONFIRMED', expected_red: 'EXPECTED_RED', blocked: 'BLOCKED', unverified: 'UNVERIFIED' };
  for (const k of Object.keys(map)) {
    if (inv.summary[k] !== counts[map[k]]) fail('summary.' + k + '=' + inv.summary[k] + ' 但实际计数 ' + counts[map[k]]);
  }
}

// 校验 CONFIRMED 行 anchor 指向真实源码符号
function verifyAnchor(rowId, anchor, rowSpec) {
  if (!anchor) { fail('行 ' + rowId + ' CONFIRMED 缺少 anchor'); return; }
  // 解析文件路径：取第一个 ':' 之前的部分（':digits' 为行号，':symbol' 为直接符号），
  // 若无 ':' 则取 ' (' 之前的部分。
  let rel = anchor;
  let cut = rel.indexOf(':');
  let tailStart;
  if (cut >= 0) { rel = rel.slice(0, cut); tailStart = cut + 1; }
  else {
    const p = rel.indexOf(' (');
    if (p >= 0) { rel = rel.slice(0, p); tailStart = p; }
    else tailStart = anchor.length;
  }
  rel = rel.trim();
  if (!protectedSet.has(rel)) { fail('行 ' + rowId + ' CONFIRMED anchor 指向非保护文件或无法识别: ' + anchor); return; }
  const abs = path.resolve(PROJECT_ROOT, rel);
  let src;
  try { src = fs.readFileSync(abs, 'utf8'); }
  catch (e) { fail('行 ' + rowId + ' CONFIRMED anchor 源文件无法读取: ' + rel); return; }
  // 取冒号/括号之后的符号部分，剥离前导行号与空白
  let tail = anchor.slice(tailStart).replace(/^[\s:\d/]+/, '');
  const symbols = (tail.match(IDENT) || []).filter((t) => t.length >= 4);
  if (!symbols.length) { fail('行 ' + rowId + ' CONFIRMED anchor 未含可校验的符号: ' + anchor); return; }
  for (const sym of symbols) {
    if (src.indexOf(sym) < 0) fail('行 ' + rowId + ' CONFIRMED anchor 符号在源码中不存在: "' + sym + '" @ ' + rel);
  }
  if (rowSpec) {
    for (const token of rowSpec.sourceAll) {
      if (!src.includes(token)) fail('行 ' + rowId + ' CONFIRMED 源码缺少声明语义: "' + token + '" @ ' + rel);
    }
  }
}

report();

function report() {
  if (errors.length) {
    console.error('VALIDATION FAILED (' + errors.length + '):');
    errors.forEach((e) => console.error('  - ' + e));
    process.exit(1);
  }
  console.log('VALIDATION PASSED: ' + (inv.rows ? inv.rows.length : 0) + ' 行; CONFIRMED=' + counts.CONFIRMED + ' EXPECTED_RED=' + counts.EXPECTED_RED + ' BLOCKED=' + counts.BLOCKED + ' UNVERIFIED=' + counts.UNVERIFIED);
  process.exit(0);
}
