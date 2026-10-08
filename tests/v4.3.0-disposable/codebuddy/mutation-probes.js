'use strict';
/*
 * 4.3.0 CodeBuddy mutation probes（对抗审查可执行部分）
 *
 * rework-02（prototype 已交付）：
 *  - runnable（fixture 级）：对合成数据施加 mutant，断言契约捕获（killed）。若未捕获 → FAIL（surviving）。
 *  - prototype 级：读取真实源码、内存中施加真实 mutation 并复跑行为探针；
 *    killed / survived / unsupported-expected-red / no-op / syntax-error 分开记录。
 *    无法施加的攻击 ran=false，绝不写成 killed；绝不回退到测试内复制实现。
 *  - 控制 mutant：修改无关代码，断言不改变契约结果（不把红变绿、不把绿变红）。
 */

const path = require('path');
const fs = require('fs');
const fixtures = require('./fixtures.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const PROTOTYPE_DIR = path.join(ROOT, 'design-previews', '4.3.0-opensquilla-case-atlas');
// 仅当真实 prototype 模块文件可加载时才视为“存在”；空目录不算。
const PROTOTYPE_PATHS = [
  path.join(PROTOTYPE_DIR, 'case-atlas-view-model.js'),
  path.join(PROTOTYPE_DIR, 'source-ref-adapter.js'),
];
const prototypeExists = PROTOTYPE_PATHS.some(p => fs.existsSync(p));

const results = [];
function record(c) { results.push(c); }
function clone(ds) { return JSON.parse(JSON.stringify(ds)); }

// ============================ 可运行 mutant（fixture 级，必须被 killed） ============================
// M-01 删除一个 SourceRef 字段
(() => {
  const m = clone(fixtures.DATASET);
  delete m.sessions[4].sourceRef.sourceContentHash;
  const r = fixtures.validateFixtures(m);
  const caught = !r.ok && r.violations.some(v => v.includes('sourceContentHash'));
  record({ id: 'M-01', title: '删除一个 SourceRef 字段（sourceContentHash）', target: 'fixture', ran: true, status: caught ? 'PASS' : 'FAIL', detail: caught ? 'mutant 被结构契约捕获' : 'SURVIVING: 未被捕获', killed: caught, mutation: 'drop sourceRef.sourceContentHash' });
})();

// M-02 减少 30 节 fixture
(() => {
  const m = clone(fixtures.DATASET);
  m.sessions.splice(0, 1);
  const r = fixtures.validateFixtures(m);
  const caught = !r.ok && r.violations.some(v => v.includes('数量'));
  record({ id: 'M-02', title: '减少 30 节 fixture（删除一节会谈）', target: 'fixture', ran: true, status: caught ? 'PASS' : 'FAIL', detail: caught ? 'mutant 被结构契约捕获' : 'SURVIVING: 未被捕获', killed: caught, mutation: 'splice one session' });
})();

// M-03 把 unknown client 改为 accept（fixture 级：错 client 会谈必须被捕获）
(() => {
  const m = clone(fixtures.DATASET);
  m.sessions[1].clientId = fixtures.ADVERSARIAL.otherClient.id;
  const r = fixtures.validateFixtures(m);
  const caught = !r.ok && r.violations.some(v => v.includes('clientId'));
  record({ id: 'M-03', title: '错 client 会谈（unknown client 改为 accept 的 fixture 表现）', target: 'fixture', ran: true, status: caught ? 'PASS' : 'FAIL', detail: caught ? 'mutant 被结构契约捕获' : 'SURVIVING: 未被捕获', killed: caught, mutation: 'session.clientId = otherClient' });
})();

// M-04 跳过 quarantine（fixture 级：删除 status 字段必须被捕获）
(() => {
  const m = clone(fixtures.DATASET);
  delete m.materials[3].sourceRef.status; // mat-synth-0004 原 quarantine
  const r = fixtures.validateFixtures(m);
  const caught = !r.ok && r.violations.some(v => v.includes('status'));
  record({ id: 'M-04', title: '跳过 quarantine 检测（删除 sourceRef.status）', target: 'fixture', ran: true, status: caught ? 'PASS' : 'FAIL', detail: caught ? 'mutant 被结构契约捕获' : 'SURVIVING: 未被捕获', killed: caught, mutation: 'drop sourceRef.status' });
})();

// M-05 复用旧 client snapshot 到新 client（fixture 级：跨 client 会谈混入必须被捕获）
(() => {
  const m = clone(fixtures.DATASET);
  m.sessions.push(JSON.parse(JSON.stringify(fixtures.ADVERSARIAL.wrongClientSession)));
  const r = fixtures.validateFixtures(m);
  const caught = !r.ok && r.violations.some(v => v.includes('clientId'));
  record({ id: 'M-05', title: '复用旧 client snapshot 到新 client（跨个案污染）', target: 'fixture', ran: true, status: caught ? 'PASS' : 'FAIL', detail: caught ? 'mutant 被结构契约捕获' : 'SURVIVING: 未被捕获', killed: caught, mutation: 'push wrong-client session' });
})();

// M-06 断链 material 必须被 detectBrokenLinks 捕获
(() => {
  const m = clone(fixtures.DATASET);
  // 把一个合法 material 变成断链，断言检测逻辑捕获
  m.materials[0].sourceRef.anchorContentHash = fixtures.sha256('tampered-anchor');
  const broken = fixtures.detectBrokenLinks(m);
  const caught = broken.includes('mat-synth-0001');
  record({ id: 'M-06', title: '断链 material 检测（锚点被篡改为不匹配）', target: 'fixture', ran: true, status: caught ? 'PASS' : 'FAIL', detail: caught ? 'mutant 被 detectBrokenLinks 捕获' : 'SURVIVING: 未被捕获', killed: caught, mutation: 'tamper anchorContentHash' });
})();

// ============================ 控制 mutant：修改无关代码 ============================
(() => {
  const m = clone(fixtures.DATASET);
  m.sessions[2].title = '无关标题修改（控制 mutant）'; // 不影响结构契约
  const r = fixtures.validateFixtures(m);
  const irrelevantNoEffect = r.ok === true; // 无关改动不应引入违规
  // 同时确认真实坏 mutant 仍被捕获
  const bad = clone(fixtures.DATASET);
  bad.sessions[1].clientId = fixtures.ADVERSARIAL.otherClient.id;
  const badR = fixtures.validateFixtures(bad);
  const realMutationStillCaught = !badR.ok && badR.violations.some(v => v.includes('clientId'));
  const okControl = irrelevantNoEffect && realMutationStillCaught;
  record({ id: 'M-11', title: '控制 mutant：修改无关代码不改变契约结果', target: 'fixture', ran: true, status: okControl ? 'PASS' : 'FAIL', detail: okControl ? '无关改动无影响；真实 mutant 仍被捕获' : 'SURVIVING/异常', killed: okControl, mutation: 'change session.title only' });
})();

// ============================ 防替代守卫 ============================
(() => {
  // needles 拼接构造，避免守卫源码自身包含这些字面量导致自匹配（假阳性）。
  const needles = ['class ' + 'ViewModel', 'build' + 'ViewModel', 'derive' + 'ViewModel', 'Case' + 'Atlas' + 'ViewModel'];
  const files = ['fixtures.js', 'run-contract.js', 'mutation-probes.js'];
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    for (const t of needles) if (src.indexOf(t) !== -1) hits.push(f + ':' + t);
  }
  record({ id: 'M-03b', title: '未把真实 prototype require 改成测试内复制实现', target: 'fixture', ran: true, status: hits.length === 0 ? 'PASS' : 'FAIL', detail: hits.length ? 'forbidden: ' + JSON.stringify(hits) : '本任务未创建任何替代实现/假 ViewModel', killed: hits.length === 0, mutation: 'no-in-test-substitute' });
})();

// ============================ Prototype 级 mutant（rework-02：真实变异） ============================
/*
 * 机制：读取真实 prototype 源码 → 施加字符串级 mutation → 在内存中用 Function 包装编译
 * （require 注入：可把变异后的 adapter 注入 vm 模块）→ 用与契约相同的行为探针复跑。
 * 探针在真实模块上必须为 true（baseline），在 mutant 上必须为 false（killed）。
 * 探针在 mutant 上仍为 true → survived → FAIL。
 * 磁盘上的 prototype 文件绝不被修改；变异只存在于内存。这不是替代实现——
 * mutant 从不用于让契约通过，只用于证明契约能杀死被破坏的真实实现。
 * 分类：killed / survived / unsupported-expected-red / no-op / syntax-error。
 */
const VM_PATH = PROTOTYPE_PATHS[0];
const ADAPTER_PATH = PROTOTYPE_PATHS[1];
const realAtlas = require(VM_PATH);
const realAdapter = require(ADAPTER_PATH);
const VM_SRC = fs.readFileSync(VM_PATH, 'utf8');
const ADAPTER_SRC = fs.readFileSync(ADAPTER_PATH, 'utf8');

function compileFromSource(filePath, src, injectedAdapter) {
  const mod = { exports: {} };
  const dir = path.dirname(filePath);
  function customRequire(id) {
    if (injectedAdapter && id === './source-ref-adapter.js') return injectedAdapter;
    if (id.startsWith('.')) return require(path.resolve(dir, id));
    return require(id); // 内置模块或绝对路径（adapter 内部对生产 source-ref.js 的 require）
  }
  const fn = new Function('require', 'module', 'exports', '__dirname', '__filename', src);
  fn(customRequire, mod, mod.exports, dir, filePath);
  return mod.exports;
}

// ---- 行为探针（与 run-contract.js 的断言同源；对真实模块必须为 true） ----
const PROBES = {
  timelineUnder30Flagged(atlasMod) {
    const vm = atlasMod.createViewModel(fixtures.toPrototypeInput());
    const bad = JSON.parse(JSON.stringify(vm)); bad.timeline = bad.timeline.slice(0, 5);
    const v = atlasMod.validateViewModel(bad);
    return !v.ok && v.issues.some(i => i.includes('fewer than 30'));
  },
  missingHashFlagged(atlasMod) {
    const vm = atlasMod.createViewModel(fixtures.toPrototypeInput());
    const bad = JSON.parse(JSON.stringify(vm)); delete bad.nodes[0].sourceRef.sourceContentHash;
    const v = atlasMod.validateViewModel(bad);
    return !v.ok && v.issues.some(i => i.includes('sourceContentHash missing'));
  },
  confirmedFilterExcludesDraft(atlasMod) {
    const vm = atlasMod.createViewModel(fixtures.toPrototypeInput());
    const crafted = vm.nodes.map((n, i) => (i === 0 ? Object.assign({}, n, { isAiDraft: true, isConfirmed: false }) : n));
    return atlasMod.filterNodes(crafted, 'confirmed').length === vm.nodes.length - 1;
  },
  aiEdgePersistenceRejected(adapterMod) {
    return adapterMod.rejectAiEdgePersistence({ type: 'ai-inference', id: 'edge-probe' }).ok === false;
  },
  aiEdgeRejectionEnforcedInValidate(atlasWithAdapter) {
    const vm = atlasWithAdapter.createViewModel(fixtures.toPrototypeInput());
    return atlasWithAdapter.validateViewModel(vm).ok === true; // 拒绝生效时 validate 无 issue
  },
  sourceVersionChangeInvalidates(adapterMod) {
    return adapterMod.needsCacheInvalidation(
      { normalizationVersion: adapterMod.NORMALIZATION_VERSION, sourceVersion: 'v-a', clientId: 'cli-x' },
      { sourceVersion: 'v-b', clientId: 'cli-x' }
    ) === true;
  },
  quarantineMarksQuarantined(adapterMod) {
    const ref = adapterMod.createAtlasSourceRef({ clientId: 'cli-x', sessionId: 'ses-x', anchor: { kind: 'quote', locator: 's/t' }, sourceText: '合成探针文本' });
    const q = adapterMod.quarantineSourceRef(ref, 'unknown-client');
    return q.status === 'quarantined' && q.verified === false;
  },
};

// ---- 通用 prototype mutant 运行器 ----
function runProtoMutant(opts) {
  // opts: { id, title, file: 'vm'|'adapter', find, replace, probeName, chain?:bool }
  const src = opts.file === 'vm' ? VM_SRC : ADAPTER_SRC;
  const filePath = opts.file === 'vm' ? VM_PATH : ADAPTER_PATH;
  const base = { id: opts.id, title: opts.title, target: 'prototype', mutation: opts.find + ' => ' + opts.replace };
  if (src.indexOf(opts.find) === -1) {
    record(Object.assign(base, { ran: false, status: 'FAIL', category: 'target-not-found', killed: false, detail: 'mutation 目标串在真实源码中不存在：' + opts.find }));
    return;
  }
  const mutatedSrc = src.split(opts.find).join(opts.replace);
  // baseline：真实模块上探针必须为 true
  const probe = PROBES[opts.probeName];
  let baselineOk = false;
  try {
    baselineOk = opts.chain ? probe(realAtlas) : probe(opts.file === 'vm' ? realAtlas : realAdapter);
  } catch (e) { baselineOk = false; }
  if (!baselineOk) {
    record(Object.assign(base, { ran: true, status: 'FAIL', category: 'invalid-probe', killed: false, detail: '探针在真实模块上不为 true，探针无效' }));
    return;
  }
  // 编译 mutant
  let mutantExports = null;
  try {
    if (opts.file === 'adapter') {
      mutantExports = compileFromSource(ADAPTER_PATH, mutatedSrc);
      if (opts.chain) mutantExports = compileFromSource(VM_PATH, VM_SRC, mutantExports); // 变异 adapter 注入真实 vm
    } else {
      mutantExports = compileFromSource(VM_PATH, mutatedSrc);
    }
  } catch (e) {
    if (opts.expectSyntaxError) {
      record(Object.assign(base, { ran: true, status: 'PASS', category: 'syntax-error', killed: true, detail: '预期编译失败并确实失败（证明 harness 真实编译变异源码）：' + e.message.slice(0, 80) }));
    } else {
      record(Object.assign(base, { ran: true, status: 'FAIL', category: 'unexpected-compile-error', killed: false, detail: '非预期编译失败：' + e.message }));
    }
    return;
  }
  if (opts.expectSyntaxError) {
    record(Object.assign(base, { ran: true, status: 'FAIL', category: 'syntax-error', killed: false, detail: '预期编译失败但编译成功——harness 或 mutation 无效' }));
    return;
  }
  // mutant 上复跑探针
  let mutantProbe = null;
  try { mutantProbe = probe(mutantExports); } catch (e) { mutantProbe = false; } // 抛错视为契约在 mutant 下失败 = killed
  if (opts.expectNoop) {
    const ok = mutantProbe === true;
    record(Object.assign(base, { ran: true, status: ok ? 'PASS' : 'FAIL', category: 'no-op', killed: false, detail: ok ? '控制 mutant（仅注释变化）不影响行为，探针仍为 true' : '控制 mutant 改变了行为——harness 有副作用' }));
    return;
  }
  const killed = mutantProbe === false;
  record(Object.assign(base, {
    ran: true,
    status: killed ? 'PASS' : 'FAIL',
    category: killed ? 'killed' : 'survived',
    killed,
    detail: killed ? '真实源码变异后探针由 true 变 false，mutant 被契约杀死' : 'SURVIVED: 变异后探针仍为 true，契约存在假绿',
  }));
}

// PM-01 validateViewModel：删除 timeline<30 检查
runProtoMutant({ id: 'PM-01', title: 'validateViewModel 删除 timeline<30 检查', file: 'vm', probeName: 'timelineUnder30Flagged', find: 'if (vm.timeline && vm.timeline.length < 30) issues.push', replace: 'if (false) issues.push' });
// PM-02 validateViewModel：删除 sourceContentHash 缺失检查
runProtoMutant({ id: 'PM-02', title: 'validateViewModel 删除 sourceContentHash 缺失检查', file: 'vm', probeName: 'missingHashFlagged', find: 'if (!node.sourceRef || !node.sourceRef.sourceContentHash) issues.push', replace: 'if (false) issues.push' });
// PM-03 filterNodes：confirmed 过滤器放行一切
runProtoMutant({ id: 'PM-03', title: 'filterNodes confirmed 过滤器放行 ai-draft', file: 'vm', probeName: 'confirmedFilterExcludesDraft', find: 'return n.isConfirmed && !n.isAiDraft;', replace: 'return true;' });
// PM-04 rejectAiEdgePersistence：AI edge 持久化改为放行（直接探针）
runProtoMutant({ id: 'PM-04', title: 'rejectAiEdgePersistence 对 AI edge 返回 ok:true（直接调用）', file: 'adapter', probeName: 'aiEdgePersistenceRejected', find: "return { ok: false, reason: 'ai-edge-persistence-denied'", replace: "return { ok: true, reason: 'ai-edge-persistence-denied'" });
// PM-04b 同一变异经完整链路（变异 adapter 注入真实 vm，validateViewModel 必须检出）
runProtoMutant({ id: 'PM-04b', title: 'rejectAiEdgePersistence 放行后 validateViewModel 链路检出', file: 'adapter', chain: true, probeName: 'aiEdgeRejectionEnforcedInValidate', find: "return { ok: false, reason: 'ai-edge-persistence-denied'", replace: "return { ok: true, reason: 'ai-edge-persistence-denied'" });
// PM-05 needsCacheInvalidation：忽略 sourceVersion 变化
runProtoMutant({ id: 'PM-05', title: 'needsCacheInvalidation 忽略 sourceVersion 变化', file: 'adapter', probeName: 'sourceVersionChangeInvalidates', find: 'if (snapshot.sourceVersion !== current.sourceVersion) return true;', replace: 'if (false) return true;' });
// PM-06 quarantineSourceRef：跳过隔离标记
runProtoMutant({ id: 'PM-06', title: 'quarantineSourceRef 跳过 quarantined 标记', file: 'adapter', probeName: 'quarantineMarksQuarantined', find: "status: 'quarantined',", replace: "status: 'valid'," });
// PM-07 语法破坏控制：证明 harness 真实编译变异源码（预期编译失败）
runProtoMutant({ id: 'PM-07', title: '语法破坏控制 mutant（预期编译失败）', file: 'vm', probeName: 'timelineUnder30Flagged', find: "'use strict';", replace: "'use strict'; }", expectSyntaxError: true });
// PM-08 no-op 控制：仅改注释，行为不得变化
runProtoMutant({ id: 'PM-08', title: 'no-op 控制 mutant（仅注释变化）', file: 'vm', probeName: 'timelineUnder30Flagged', find: 'deterministic read-only pipeline', replace: 'deterministic read-only pipeline (noop-mutant)', expectNoop: true });

// PM-09 删除关键 await：prototype 全同步，无 await 可删（真实不可施加，不伪造）
(() => {
  const hasAwait = /\bawait\b/.test(VM_SRC) || /\bawait\b/.test(ADAPTER_SRC);
  const vmResult = realAtlas.createViewModel(fixtures.toPrototypeInput());
  const syncObserved = !(vmResult instanceof Promise);
  record({
    id: 'PM-09', title: '删除关键 await（异步路径攻击）', target: 'prototype', ran: false,
    status: !hasAwait && syncObserved ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    category: 'unsupported-expected-red', killed: false, mutation: 'delete-await',
    detail: '真实源码不含 await（实测扫描），createViewModel 同步返回非 Promise（实测调用）；无异步 API 可施加该攻击，不伪造假 Promise。进入生产前需要异步加载/刷新契约后重施',
  });
})();
// PM-10 persistAIEdge 写入路径攻击：该 API 不存在（真实不可施加，不伪造）
(() => {
  const missing = typeof realAdapter.persistAIEdge === 'undefined' && typeof realAtlas.persistAIEdge === 'undefined';
  record({
    id: 'PM-10', title: '允许 AI edge 经 persistAIEdge 写入持久化对象', target: 'prototype', ran: false,
    status: missing ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    category: 'unsupported-expected-red', killed: false, mutation: 'persistAIEdge-write',
    detail: 'typeof persistAIEdge === undefined（实测）；唯一持久化入口 rejectAiEdgePersistence 已在 PM-04/PM-04b 被真实变异并被杀死。进入生产前该 API 必须不存在或永久拒绝',
  });
})();

// ============================ 汇总 ============================
const counts = { PASS: 0, EXPECTED_RED: 0, UNSUPPORTED_EXPECTED_RED: 0, DEGRADED: 0, BLOCKED: 0, FAIL: 0 };
for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
const byCategory = {};
for (const r of results) { if (r.category) byCategory[r.category] = (byCategory[r.category] || 0) + 1; }

const surviving = results.filter(r => r.category === 'survived' || (r.ran && r.status === 'FAIL'));
const anyFail = counts.FAIL > 0;

console.log('=== 4.3.0 CodeBuddy mutation probes（rework-02：真实变异真实源码） ===');
console.log('prototype 模块（case-atlas-view-model.js / source-ref-adapter.js）存在: ' + prototypeExists);
console.log('mutant 总数=' + results.length + '  ' + JSON.stringify(counts));
console.log('prototype 级分类: ' + JSON.stringify(byCategory));
for (const r of results) {
  console.log(`[${r.status}] ${r.id} ${r.title} — ran=${!!r.ran} killed=${!!r.killed}${r.category ? ' category=' + r.category : ''} — ${r.detail}`);
}
console.log('SURVIVING(被测试漏掉、却伪装成绿)=' + surviving.length);
if (surviving.length) console.log('SURVIVING 列表: ' + JSON.stringify(surviving.map(s => s.id)));

// 任何 surviving（ran 且未被捕获）都必须暴露为 FAIL，绝不隐藏为绿。
process.exit(anyFail ? 1 : 0);
