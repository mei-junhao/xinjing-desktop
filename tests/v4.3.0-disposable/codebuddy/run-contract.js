'use strict';
/*
 * 4.3.0 CodeBuddy 真实行为契约运行器（rework-02：prototype 已交付）
 *
 * 设计原则（任务卡 XJ-4.3.0-codebuddy-contract-rework-02 + AGENTS.md）：
 *  - 所有 PI 用例真实调用 OpenSquilla disposable prototype 的导出入口，并记录
 *    ran / call（真实调用表达式）/ observed（返回值摘要）。
 *  - prototype 不支持的 API（loadClient、异步 refresh、persistAIEdge、draft-save）
 *    标记 UNSUPPORTED_EXPECTED_RED，附真实缺失证据（typeof === 'undefined' / 实调观察），
 *    绝不创造包装假接口、绝不把 unsupported 当 PASS。
 *  - 状态分类 PASS / EXPECTED_RED / UNSUPPORTED_EXPECTED_RED / DEGRADED / BLOCKED / FAIL
 *    分开计数，绝不合并成一个全绿数字。
 */

const path = require('path');
const fs = require('fs');
const fixtures = require('./fixtures.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const PROTOTYPE_DIR = path.join(ROOT, 'design-previews', '4.3.0-opensquilla-case-atlas');
const ATLAS_PATH = path.join(PROTOTYPE_DIR, 'case-atlas-view-model.js');
const ADAPTER_PATH = path.join(PROTOTYPE_DIR, 'source-ref-adapter.js');

// ---- 真实加载入口：require 真实 prototype 模块；失败则相关用例 BLOCKED（不伪造） ----
let atlas = null;
let adapter = null;
const prototypeLoadErrors = [];
try { atlas = require(ATLAS_PATH); } catch (e) { prototypeLoadErrors.push('case-atlas-view-model.js :: ' + e.message); }
try { adapter = require(ADAPTER_PATH); } catch (e) { prototypeLoadErrors.push('source-ref-adapter.js :: ' + e.message); }
const prototypeLoaded = !!(atlas && adapter);

const results = [];
function record(c) { results.push(c); }
function cond(b) { return b ? true : false; }

// ---- 防替代守卫：本任务目录不得包含 prototype 的复制实现 / 假 ViewModel ----
// 注意：needles 用拼接构造，避免守卫源码自身包含这些字面量导致自匹配（假阳性）。
function scanNoSubstitute() {
  const needles = ['class ' + 'ViewModel', 'build' + 'ViewModel', 'derive' + 'ViewModel', 'Case' + 'Atlas' + 'ViewModel'];
  const files = ['fixtures.js', 'run-contract.js', 'mutation-probes.js'];
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    for (const t of needles) {
      if (src.indexOf(t) !== -1) hits.push(f + ':' + t);
    }
  }
  return hits;
}

// ============================ 夹具级契约（可运行，PASS） ============================
const ds = fixtures.DATASET;
const structural = fixtures.validateFixtures(ds);

record({ id: 'FI-01', title: '合成会谈数量 = 30', target: 'fixture', status: cond(fixtures.SESSIONS.length === 30) ? 'PASS' : 'FAIL', detail: 'sessions=' + fixtures.SESSIONS.length });
record({ id: 'FI-02', title: '单一合成 client', target: 'fixture', status: cond(ds.client && ds.client.id && !fixtures.ADVERSARIAL.otherClient.id.includes(ds.client.id)) ? 'PASS' : 'FAIL', detail: 'clientId=' + (ds.client && ds.client.id) });
record({ id: 'FI-03', title: '主数据集结构契约通过（每条 SourceRef 含 6 字段 + 合法 status）', target: 'fixture', status: cond(structural.ok) ? 'PASS' : 'FAIL', detail: structural.ok ? 'ok' : JSON.stringify(structural.violations) });
record({ id: 'FI-04', title: '每条 material 具备完整 SourceRef', target: 'fixture', status: cond(fixtures.MATERIALS.every(m => fixtures.validateFixtures({ materials: [m] }).violations.filter(v => v.startsWith('material')).length === 0)) ? 'PASS' : 'FAIL', detail: 'materials=' + fixtures.MATERIALS.length });
record({ id: 'FI-05', title: '督导记录具备完整 SourceRef', target: 'fixture', status: cond(fixtures.SUPERVISION.length > 0 && fixtures.SUPERVISION.every(s => s.sourceRef && s.sourceRef.id && s.sourceRef.sourceContentHash && s.sourceRef.anchorContentHash)) ? 'PASS' : 'FAIL', detail: 'supervision=' + fixtures.SUPERVISION.length });
record({ id: 'FI-06', title: 'ClinicalActionRun 草稿：status=draft 且具 clinicalActionRunId', target: 'fixture', status: cond(fixtures.CLINICAL_ACTION_DRAFTS.length > 0 && fixtures.CLINICAL_ACTION_DRAFTS.every(c => c.status === 'draft' && !!c.clinicalActionRunId)) ? 'PASS' : 'FAIL', detail: 'drafts=' + fixtures.CLINICAL_ACTION_DRAFTS.length });
record({ id: 'FI-07', title: '覆盖失效态：invalid/quarantine/expired 各一', target: 'fixture', status: cond(['invalid', 'quarantine', 'expired'].every(s => fixtures.MATERIALS.some(m => m.sourceRef.status === s))) ? 'PASS' : 'FAIL', detail: 'statuses=' + JSON.stringify([...new Set(fixtures.MATERIALS.map(m => m.sourceRef.status))]) });
record({ id: 'FI-08', title: '覆盖来源版本变化（sourceHistory 输入存在）', target: 'fixture', status: cond(fixtures.SESSIONS.some(s => Array.isArray(s.sourceRef.sourceHistory) && s.sourceRef.sourceHistory.length > 1)) ? 'PASS' : 'FAIL', detail: 'session 12 含 sourceHistory' });
record({ id: 'FI-09', title: '断链材料场景存在（供 verify 级检测）', target: 'fixture', status: cond(fixtures.detectBrokenLinks(ds).length === 1) ? 'PASS' : 'FAIL', detail: 'broken=' + JSON.stringify(fixtures.detectBrokenLinks(ds)) });

// ---- 防替代守卫（可运行，PASS） ----
const subHits = scanNoSubstitute();
record({ id: 'GUARD-01', title: '未创建 prototype 复制实现 / 假 ViewModel', target: 'fixture', status: cond(subHits.length === 0) ? 'PASS' : 'FAIL', detail: subHits.length ? 'forbidden tokens: ' + JSON.stringify(subHits) : 'clean' });

// ============================ 夹具级负向契约（构造坏输入，断言被捕获） ============================
// NF-01 缺 hash
(() => {
  const bad = JSON.parse(JSON.stringify(ds));
  delete bad.sessions[0].sourceRef.sourceContentHash;
  const r = fixtures.validateFixtures(bad);
  record({ id: 'NF-01', title: '缺 sourceContentHash 的会谈被结构契约捕获', target: 'fixture', status: cond(!r.ok && r.violations.some(v => v.includes('sourceContentHash'))) ? 'PASS' : 'FAIL', detail: r.ok ? '未被捕获' : '捕获: ' + r.violations.find(v => v.includes('sourceContentHash')) });
})();
// NF-02 错 client
(() => {
  const bad = JSON.parse(JSON.stringify(ds));
  bad.sessions[1].clientId = fixtures.ADVERSARIAL.otherClient.id;
  const r = fixtures.validateFixtures(bad);
  record({ id: 'NF-02', title: '错 client 的会谈被结构契约捕获', target: 'fixture', status: cond(!r.ok && r.violations.some(v => v.includes('clientId'))) ? 'PASS' : 'FAIL', detail: r.ok ? '未被捕获' : '捕获: ' + r.violations.find(v => v.includes('clientId')) });
})();
// NF-03 减少会谈数量
(() => {
  const bad = JSON.parse(JSON.stringify(ds));
  bad.sessions.splice(0, 1);
  const r = fixtures.validateFixtures(bad);
  record({ id: 'NF-03', title: '会谈数量 < 30 被结构契约捕获', target: 'fixture', status: cond(!r.ok && r.violations.some(v => v.includes('数量'))) ? 'PASS' : 'FAIL', detail: r.ok ? '未被捕获' : '捕获: ' + r.violations.find(v => v.includes('数量')) });
})();
// NF-04 跨个案污染：第二 client 的快照被识别
(() => {
  const bad = JSON.parse(JSON.stringify(ds));
  bad.sessions.push(JSON.parse(JSON.stringify(fixtures.ADVERSARIAL.wrongClientSession)));
  const r = fixtures.validateFixtures(bad);
  record({ id: 'NF-04', title: '跨个案污染（错 client 会谈混入）被捕获', target: 'fixture', status: cond(!r.ok && r.violations.some(v => v.includes('clientId'))) ? 'PASS' : 'FAIL', detail: r.ok ? '未被捕获' : '捕获: 跨 client 会谈被拒绝' });
})();

// ============================ Prototype 集成契约（真实入口调用；rework-02） ============================
// 每个用例包含 ran / call（真实调用表达式）/ observed（返回值摘要）。
// 异常路径用 try/catch 显式断言，不吞异常、不把异常转为 success。

function piRecord(id, title, call, fn) {
  if (!prototypeLoaded) {
    record({ id, title, target: 'prototype', ran: false, call, status: 'BLOCKED', detail: 'prototype 加载失败: ' + JSON.stringify(prototypeLoadErrors) });
    return;
  }
  try {
    const r = fn(); // { status, observed, detail? }
    record({ id, title, target: 'prototype', ran: true, call, status: r.status, observed: r.observed, detail: r.detail || '' });
  } catch (e) {
    record({ id, title, target: 'prototype', ran: true, call, status: 'FAIL', observed: 'unexpected throw', detail: '非预期异常: ' + e.message });
  }
}
function short(v) {
  const s = JSON.stringify(v);
  return s && s.length > 160 ? s.slice(0, 160) + '…' : s;
}

// PI-00 模块加载与导出面
piRecord('PI-00', '真实加载 prototype 模块并记录导出 keys', "require(case-atlas-view-model.js) / require(source-ref-adapter.js)", () => {
  const ak = Object.keys(adapter);
  const vk = Object.keys(atlas);
  const ok = typeof atlas.createViewModel === 'function' && typeof atlas.validateViewModel === 'function' && typeof atlas.filterNodes === 'function'
    && typeof adapter.createAtlasSourceRef === 'function' && typeof adapter.verifyAtlasSourceRef === 'function' && typeof adapter.isStale === 'function'
    && typeof adapter.quarantineSourceRef === 'function' && typeof adapter.needsCacheInvalidation === 'function' && typeof adapter.rejectAiEdgePersistence === 'function';
  return { status: ok ? 'PASS' : 'FAIL', observed: 'atlas=' + vk.join(',') + ' | adapter=' + ak.join(',') };
});

// PI-01 createViewModel 正常输入：只读派生 + validate ok + 旧快照失效规则
piRecord('PI-01', 'createViewModel 正常输入：只读派生、validate ok、snapshot 变化即失效', 'atlas.createViewModel(toPrototypeInput()); atlas.validateViewModel(vm); adapter.needsCacheInvalidation(snap, cur)', () => {
  const input = fixtures.toPrototypeInput();
  const before = JSON.stringify(input);
  const vm = atlas.createViewModel(input);
  const inputUntouched = JSON.stringify(input) === before;
  const v = atlas.validateViewModel(vm);
  const snap = { normalizationVersion: vm.normalizationVersion, sourceVersion: vm.sourceVersion, clientId: vm.client.id };
  const invalidatedOnVersionChange = adapter.needsCacheInvalidation(snap, { sourceVersion: 'synthetic-002', clientId: vm.client.id }) === true;
  const keptWhenSame = adapter.needsCacheInvalidation(snap, { sourceVersion: vm.sourceVersion, clientId: vm.client.id }) === false;
  const ok = vm.stats.totalSessions === 30 && vm.timeline.length === 30 && v.ok === true && inputUntouched && invalidatedOnVersionChange && keptWhenSame;
  return { status: ok ? 'PASS' : 'FAIL', observed: 'totalSessions=' + vm.stats.totalSessions + ' nodes=' + vm.stats.totalNodes + ' edges=' + vm.stats.totalEdges + ' validate.ok=' + v.ok + ' inputUntouched=' + inputUntouched + ' invalidateOnVersionChange=' + invalidatedOnVersionChange + ' keptWhenSame=' + keptWhenSame, detail: v.ok ? '' : short(v.issues) };
});

// PI-02 空/unknown client
piRecord('PI-02', '空 client 失败关闭：createViewModel({client:null}) 必须抛错', 'atlas.createViewModel({...input, client:null})', () => {
  let threw = false, msg = '';
  try { atlas.createViewModel(Object.assign(fixtures.toPrototypeInput(), { client: null })); } catch (e) { threw = true; msg = e.message; }
  return { status: threw && /client/.test(msg) ? 'PASS' : 'FAIL', observed: 'threw=' + threw + ' msg=' + msg };
});
piRecord('PI-02b', 'unknown client 查找拒绝：无 loadClient/registry API', "atlas.createViewModel({...input, client:{id:'cli-unknown-9999'}}); typeof atlas.loadClient", () => {
  const input = fixtures.toPrototypeInput();
  input.client = { id: 'cli-unknown-9999', name: '未知合成client', status: 'active' };
  const vm = atlas.createViewModel(input); // 观察：接受了与 sessions.clientId 不一致的 client
  const accepted = vm.client.id === 'cli-unknown-9999';
  const apiMissing = typeof atlas.loadClient === 'undefined' && typeof adapter.loadClient === 'undefined';
  return {
    status: accepted && apiMissing ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    observed: 'createViewModel 接受了 unknown client（vm.client.id=' + vm.client.id + '，sessions 仍属 ' + fixtures.CLIENT.id + '）; typeof loadClient=undefined',
    detail: '进入生产前需要契约：loadClient(clientId) 必须查 client 注册表，未知 client 返回失败关闭；当前 prototype 无该 API，属实测观察到的缺口，不伪造拒绝行为',
  };
});

// PI-03 少于 30 节
piRecord('PI-03', '少于 30 节失败关闭：createViewModel 抛错 + validateViewModel 检出 timeline<30', 'atlas.createViewModel({sessions:29}); atlas.validateViewModel(vm{timeline:5})', () => {
  const input = fixtures.toPrototypeInput();
  input.sessions = input.sessions.slice(0, 29);
  let threw = false, msg = '';
  try { atlas.createViewModel(input); } catch (e) { threw = true; msg = e.message; }
  const vm = atlas.createViewModel(fixtures.toPrototypeInput());
  const bad = JSON.parse(JSON.stringify(vm));
  bad.timeline = bad.timeline.slice(0, 5);
  const v = atlas.validateViewModel(bad);
  const flagged = !v.ok && v.issues.some(i => i.includes('fewer than 30'));
  return { status: threw && /minimum 30/.test(msg) && flagged ? 'PASS' : 'FAIL', observed: 'threw=' + threw + ' msg=' + msg + ' | validate flagged=' + flagged };
});

// PI-04 坏 node
piRecord('PI-04', '坏 node 失败关闭：非法 type / 缺 hash 被 validateViewModel 检出', "vmBad.nodes[0].type='hacked'; delete vmBad.nodes[1].sourceRef.sourceContentHash; atlas.validateViewModel(vmBad)", () => {
  const vm = atlas.createViewModel(fixtures.toPrototypeInput());
  const bad = JSON.parse(JSON.stringify(vm));
  bad.nodes[0].type = 'hacked';
  delete bad.nodes[1].sourceRef.sourceContentHash;
  const v = atlas.validateViewModel(bad);
  const typeFlag = v.issues.some(i => i.includes('type invalid'));
  const hashFlag = v.issues.some(i => i.includes('sourceContentHash missing'));
  return { status: !v.ok && typeFlag && hashFlag ? 'PASS' : 'FAIL', observed: 'ok=' + v.ok + ' typeFlag=' + typeFlag + ' hashFlag=' + hashFlag, detail: short(v.issues.slice(0, 3)) };
});

// PI-05 AI edge 仅预览 + 持久化拒绝
piRecord('PI-05', 'AI 生成边仅预览；rejectAiEdgePersistence 拒绝一切持久化', "adapter.rejectAiEdgePersistence(aiEdge); adapter.rejectAiEdgePersistence({id:'plain'}); adapter.isAiEdge(...)", () => {
  const vm = atlas.createViewModel(fixtures.toPrototypeInput());
  const aiEdges = vm.edges.filter(e => e.previewOnly === true);
  const rejAi = adapter.rejectAiEdgePersistence(aiEdges[0] || { type: 'ai-inference' });
  const rejPlain = adapter.rejectAiEdgePersistence({ id: 'edge_plain' });
  const isAi = adapter.isAiEdge({ type: 'ai-inference' }) === true && adapter.isAiEdge({ previewOnly: true }) === true && adapter.isAiEdge({ id: 'x' }) === false;
  const v = atlas.validateViewModel(vm);
  const ok = aiEdges.length === 1 && rejAi.ok === false && rejAi.reason === 'ai-edge-persistence-denied' && rejPlain.ok === false && isAi && v.ok === true;
  return { status: ok ? 'PASS' : 'FAIL', observed: 'aiEdges=' + aiEdges.length + ' rejAi=' + short(rejAi) + ' rejPlain.reason=' + rejPlain.reason + ' validate.ok=' + v.ok };
});

// PI-06 filterNodes 矩阵
piRecord('PI-06', 'filterNodes：类型/confirmed/ai-draft/query 过滤且不变异输入', "atlas.filterNodes(nodes,'quote'|'confirmed'|'ai-draft'|'all','督导')", () => {
  const vm = atlas.createViewModel(fixtures.toPrototypeInput());
  const nodes = vm.nodes;
  const lenBefore = nodes.length;
  const quotes = atlas.filterNodes(nodes, 'quote');
  const allNodes = atlas.filterNodes(nodes, 'all');
  const confirmed = atlas.filterNodes(nodes, 'confirmed');
  const drafts = atlas.filterNodes(nodes, 'ai-draft');
  const queried = atlas.filterNodes(nodes, 'all', '督导');
  // 纯函数输入构造：标记一个节点为 ai-draft，验证 confirmed/ai-draft 区分行为
  const crafted = nodes.map((n, i) => (i === 0 ? Object.assign({}, n, { isAiDraft: true, isConfirmed: false }) : n));
  const confirmed2 = atlas.filterNodes(crafted, 'confirmed');
  const drafts2 = atlas.filterNodes(crafted, 'ai-draft');
  const ok = quotes.length === 30 && quotes.every(n => n.type === 'quote')
    && allNodes.length === lenBefore && confirmed.length === lenBefore && drafts.length === 0
    && queried.length >= 2 && queried.every(n => (n.label + n.summary).includes('督导'))
    && confirmed2.length === lenBefore - 1 && drafts2.length === 1
    && nodes.length === lenBefore;
  return { status: ok ? 'PASS' : 'FAIL', observed: 'quote=' + quotes.length + ' all=' + allNodes.length + ' confirmed=' + confirmed.length + ' ai-draft=' + drafts.length + ' query督导=' + queried.length + ' crafted(confirmed=' + confirmed2.length + ',draft=' + drafts2.length + ') inputLenUnchanged=' + (nodes.length === lenBefore) };
});

// PI-07 createAtlasSourceRef 正常 + 负向
piRecord('PI-07', 'createAtlasSourceRef：正常输入含全部字段；缺 clientId / 绝对路径 locator 抛错', "adapter.createAtlasSourceRef({...}); ({sessionId 无 clientId}); ({locator:'C:\\\\evil'})", () => {
  const ref = adapter.createAtlasSourceRef({ clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id, anchor: { kind: 'quote', locator: 'section-1/transcript' }, sourceText: '合成来源文本-PI07' });
  const fields = ['id', 'schemaVersion', 'clientId', 'sessionId', 'anchor', 'normalizationVersion', 'sourceVersion', 'sourceContentHash', 'anchorContentHash', 'capturedAt'];
  const full = fields.every(f => ref[f] !== undefined && ref[f] !== null && ref[f] !== '');
  let threwNoClient = false;
  try { adapter.createAtlasSourceRef({ sessionId: 's', anchor: { kind: 'quote', locator: 'a/b' }, sourceText: 'x' }); } catch (e) { threwNoClient = true; }
  let threwAbs = false;
  try { adapter.createAtlasSourceRef({ clientId: 'c', sessionId: 's', anchor: { kind: 'quote', locator: 'C:\\evil\\path' }, sourceText: 'x' }); } catch (e) { threwAbs = true; }
  const ok = full && ref.id.startsWith('sr:') && threwNoClient && threwAbs;
  return { status: ok ? 'PASS' : 'FAIL', observed: 'fields=' + full + ' id=' + ref.id.slice(0, 18) + '… threwNoClient=' + threwNoClient + ' threwAbsolutePath=' + threwAbs };
});

// PI-08 verifyAtlasSourceRef / isStale：unchanged / warning / changed
piRecord('PI-08', 'verifyAtlasSourceRef + isStale：内容不变/变化/锚点断链 三态', "adapter.verifyAtlasSourceRef(ref, sameText|changedText); adapter.isStale(...)", () => {
  const ref = adapter.createAtlasSourceRef({ clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id, anchor: { kind: 'quote', locator: 'section-1/transcript' }, sourceText: '合成来源文本-PI08' });
  const same = adapter.verifyAtlasSourceRef(ref, '合成来源文本-PI08');
  const changed = adapter.verifyAtlasSourceRef(ref, '合成来源文本-PI08【已被篡改】');
  // 带 fragment 的锚点：来源改变且锚点丢失 → changed（断链语义）
  const refFrag = adapter.createAtlasSourceRef({ clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id, anchor: { kind: 'quote', locator: 'section-1/transcript', fragment: '关键片段甲' }, sourceText: '前文 关键片段甲 后文' });
  const broken = adapter.verifyAtlasSourceRef(refFrag, '完全无关的新文本');
  const staleTrue = adapter.isStale(ref, '合成来源文本-PI08【已被篡改】') === true;
  const staleFalse = adapter.isStale(ref, '合成来源文本-PI08') === false;
  const ok = same.status === 'unchanged' && same.verified === true
    && changed.status === 'warning' && changed.verified === false
    && broken.status === 'changed' && broken.verified === false
    && staleTrue && staleFalse;
  return { status: ok ? 'PASS' : 'FAIL', observed: 'same=' + same.status + '/' + same.verified + ' changed=' + changed.status + '/' + changed.verified + ' brokenAnchor=' + broken.status + '/' + broken.verified + ' isStale(changed)=' + staleTrue + ' isStale(same)=' + !staleFalse };
});

// PI-09 错 client/session：production verify 入口（adapter 导出的 SourceRef.verify）
piRecord('PI-09', '错 client/session 失败关闭：SourceRef.verify 返回 ambiguous', "adapter.SourceRef.verify(ref, {clientId:'cli-synth-9999',...}); (sessionId mismatch)", () => {
  const ref = adapter.createAtlasSourceRef({ clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id, anchor: { kind: 'quote', locator: 'section-1/transcript' }, sourceText: '合成来源文本-PI09' });
  const wrongClient = adapter.SourceRef.verify(ref, { clientId: fixtures.ADVERSARIAL.otherClient.id, sessionId: ref.sessionId, anchor: ref.anchor, sourceText: '合成来源文本-PI09' });
  const wrongSession = adapter.SourceRef.verify(ref, { clientId: ref.clientId, sessionId: 'ses-unknown-9999', anchor: ref.anchor, sourceText: '合成来源文本-PI09' });
  const ok = wrongClient.status === 'ambiguous' && wrongClient.reason === 'client-mismatch' && wrongClient.verified === false
    && wrongSession.status === 'ambiguous' && wrongSession.reason === 'session-mismatch' && wrongSession.verified === false;
  return { status: ok ? 'PASS' : 'FAIL', observed: 'wrongClient=' + short(wrongClient) + ' wrongSession=' + wrongSession.status + '/' + wrongSession.reason };
});
piRecord('PI-09b', 'verifyAtlasSourceRef 包装无法表达 client 变化（已实测的局限）', "adapter.verifyAtlasSourceRef({...ref, clientId:'cli-synth-9999'}, sameText)", () => {
  const ref = adapter.createAtlasSourceRef({ clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id, anchor: { kind: 'quote', locator: 'section-1/transcript' }, sourceText: '合成来源文本-PI09b' });
  const swapped = Object.assign({}, ref, { clientId: fixtures.ADVERSARIAL.otherClient.id });
  const r = adapter.verifyAtlasSourceRef(swapped, '合成来源文本-PI09b');
  // 观察：包装把 ref.clientId 复制进 current，client 篡改后仍 verified=true —— 真实局限，如实记录为 DEGRADED
  const degradedConfirmed = r.verified === true && r.status === 'unchanged';
  return { status: degradedConfirmed ? 'DEGRADED' : 'FAIL', observed: 'swappedClient verify=' + short(r), detail: '包装函数从 ref 自身复制 clientId/sessionId，无法检测 client/session 篡改；client/session 失配校验必须走 SourceRef.verify（PI-09 已真实覆盖）。进入生产前 verifyAtlasSourceRef 需改为接受独立的 current 上下文' };
});

// PI-10 quarantineSourceRef
piRecord('PI-10', 'quarantineSourceRef：隔离态完整且不变异原 ref', "adapter.quarantineSourceRef(ref, 'unknown-client')", () => {
  const ref = adapter.createAtlasSourceRef({ clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id, anchor: { kind: 'quote', locator: 'section-1/transcript' }, sourceText: '合成来源文本-PI10' });
  const q = adapter.quarantineSourceRef(ref, 'unknown-client');
  const qDefault = adapter.quarantineSourceRef(ref);
  const ok = q.status === 'quarantined' && q.verified === false && q.quarantineReason === 'unknown-client' && !!q.quarantinedAt
    && qDefault.quarantineReason === 'source-deleted-or-invalid'
    && ref.status === undefined && ref.verified === undefined; // 原 ref 未被变异
  return { status: ok ? 'PASS' : 'FAIL', observed: 'q=' + q.status + '/' + q.quarantineReason + '/verified=' + q.verified + ' originalUntouched=' + (ref.status === undefined) };
});

// PI-11 needsCacheInvalidation 矩阵
piRecord('PI-11', 'needsCacheInvalidation：null/规范版本/来源版本/client/session 变化全失效，相同不失效', 'adapter.needsCacheInvalidation(snapshot, current) ×6', () => {
  const base = { normalizationVersion: adapter.NORMALIZATION_VERSION, sourceVersion: 'synthetic-001', clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id };
  const cur = { sourceVersion: 'synthetic-001', clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id };
  const rNull = adapter.needsCacheInvalidation(null, cur) === true;
  const rNorm = adapter.needsCacheInvalidation(Object.assign({}, base, { normalizationVersion: '旧版本' }), cur) === true;
  const rSrc = adapter.needsCacheInvalidation(base, Object.assign({}, cur, { sourceVersion: 'synthetic-002' })) === true;
  const rCli = adapter.needsCacheInvalidation(base, Object.assign({}, cur, { clientId: fixtures.ADVERSARIAL.otherClient.id })) === true;
  const rSes = adapter.needsCacheInvalidation(base, Object.assign({}, cur, { sessionId: 'ses-synth-0001-02' })) === true;
  const rSame = adapter.needsCacheInvalidation(base, cur) === false;
  const ok = rNull && rNorm && rSrc && rCli && rSes && rSame;
  return { status: ok ? 'PASS' : 'FAIL', observed: 'null=' + rNull + ' normVer=' + rNorm + ' srcVer=' + rSrc + ' client=' + rCli + ' session=' + rSes + ' same->false=' + rSame };
});

// PI-12 unknown session（无 session 注册表）
piRecord('PI-12', 'unknown session 无注册表校验（实测观察）', "input.supervisions[0].sessionId='ses-unknown-9999'; atlas.createViewModel(input)", () => {
  const input = fixtures.toPrototypeInput();
  input.supervisions[0].sessionId = 'ses-unknown-9999';
  const vm = atlas.createViewModel(input);
  const svNode = vm.nodes.find(n => n.type === 'supervision' && n.sessionId === 'ses-unknown-9999');
  const accepted = !!svNode;
  return {
    status: accepted ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    observed: '未知 sessionId 的督导节点仍被构建（node=' + (svNode && svNode.id) + '），无 session 注册表校验',
    detail: '进入生产前需要契约：节点构建必须对照会谈注册表，未知 sessionId 失败关闭或进入 quarantine（quarantineSourceRef 已提供人工隔离入口，PI-10 已真实覆盖）',
  };
});

// PI-13 expired/invalid/quarantine material 未被过滤（实测观察）
piRecord('PI-13', '失效态 material（expired/invalid/quarantine）未被管线过滤（实测观察）', "input.materials 含 sourceStatus=expired/invalid/quarantine; atlas.createViewModel(input)", () => {
  const input = fixtures.toPrototypeInput();
  const vm = atlas.createViewModel(input);
  const badIds = input.materials.filter(m => m.sourceStatus !== 'valid').map(m => 'material/' + m.id);
  const builtBad = vm.nodes.filter(n => n.sourceRef && n.sourceRef.anchor && badIds.includes(n.sourceRef.anchor.locator));
  const accepted = builtBad.length === badIds.length;
  return {
    status: accepted ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    observed: '失效态材料 ' + badIds.length + ' 份全部被构建为节点（' + builtBad.map(n => n.id).join(',') + '），管线未读取失效状态',
    detail: '进入生产前需要契约：材料管线必须读取来源失效状态，expired/invalid 拒绝、quarantine 走隔离流；当前 prototype 输入形状无 status 通道，属实测缺口',
  };
});

// PI-14 断链 material 管线级自动拒绝缺失（verify 级检测已在 PI-08 真实覆盖）
piRecord('PI-14', '断链 material 管线级自动拒绝缺失（实测观察）', "atlas.createViewModel(input) 对 mat-synth-0006 重算哈希而非校验原 anchorContentHash", () => {
  const input = fixtures.toPrototypeInput();
  const vm = atlas.createViewModel(input);
  const node = vm.nodes.find(n => n.sourceRef && n.sourceRef.anchor && n.sourceRef.anchor.locator === 'material/mat-synth-0006');
  const brokenOriginal = fixtures.detectBrokenLinks(fixtures.DATASET).includes('mat-synth-0006');
  // 观察：管线从 extractedText 重算哈希，原 anchorContentHash 断链未被察觉
  const rebuiltNotRejected = !!node && node.sourceRef.sourceContentHash !== '' && brokenOriginal;
  return {
    status: rebuiltNotRejected ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    observed: '断链材料节点仍被构建（' + (node && node.id) + '），管线重算哈希、不校验携带的 originalAnchorContentHash',
    detail: '进入生产前需要契约：材料导入必须先以 SourceRef.verify 校验既有 anchorContentHash（verify 级检测能力已在 PI-08 以真实调用证明），断链即失败关闭',
  };
});

// PI-15 缺 hash 会谈 → validate 失败关闭（真实链路：空 sourceText → invalid ref → validate 检出）
piRecord('PI-15', '缺 hash 节点失败关闭：空来源文本产生 invalid ref 并被 validate 检出', "input.sessions[3].transcript=''; notes=''; atlas.validateViewModel(atlas.createViewModel(input))", () => {
  const input = fixtures.toPrototypeInput();
  input.sessions[3].transcript = '';
  input.sessions[3].notes = '';
  const vm = atlas.createViewModel(input);
  const v = atlas.validateViewModel(vm);
  const flagged = !v.ok && v.issues.some(i => i.includes('sourceContentHash missing')) && v.issues.some(i => i.includes('anchorContentHash missing'));
  return { status: flagged ? 'PASS' : 'FAIL', observed: 'validate.ok=' + v.ok + ' issues=' + v.issues.length + ' 首条=' + (v.issues[0] || ''), detail: '空文本 → createAtlasSourceRef 抛错 → createInvalidSourceRef 空哈希 → validateViewModel 失败关闭（完整真实链路）' };
});

// PI-16 缺失 API：loadClient / refresh / persistAIEdge / saveDraft
piRecord('PI-16', '缺失 API 证据：loadClient/refresh/persistAIEdge/saveDraft 均不存在', 'typeof atlas.loadClient / atlas.refresh / adapter.persistAIEdge / atlas.saveDraft', () => {
  const missing = {
    'atlas.loadClient': typeof atlas.loadClient,
    'atlas.refresh': typeof atlas.refresh,
    'adapter.persistAIEdge': typeof adapter.persistAIEdge,
    'atlas.saveDraft': typeof atlas.saveDraft,
    'adapter.saveDraft': typeof adapter.saveDraft,
  };
  const allMissing = Object.values(missing).every(t => t === 'undefined');
  return {
    status: allMissing ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    observed: short(missing),
    detail: '不创造包装假接口。进入生产前需要接口契约：loadClient(clientId)->Promise<失败关闭>、refresh(snapshot)->Promise<新快照或失效>、persistAIEdge 必须不存在或永久拒绝、draft 保存必须显式人工确认动作',
  };
});

// PI-17 异步语义缺失（同步返回实测）
piRecord('PI-17', '异步加载/缓存刷新语义缺失：全部入口同步返回（实测观察）', 'atlas.createViewModel(...) instanceof Promise === false; adapter.verifyAtlasSourceRef(...) instanceof Promise === false', () => {
  const vm = atlas.createViewModel(fixtures.toPrototypeInput());
  const ref = adapter.createAtlasSourceRef({ clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id, anchor: { kind: 'quote', locator: 's/t' }, sourceText: 'x' });
  const allSync = !(vm instanceof Promise) && !(adapter.verifyAtlasSourceRef(ref, 'x') instanceof Promise) && !(adapter.needsCacheInvalidation(null, {}) instanceof Promise);
  return {
    status: allSync ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    observed: '全部返回值均非 Promise（createViewModel/verifyAtlasSourceRef/needsCacheInvalidation 实测）',
    detail: '异步加载、缓存刷新、失败恢复必须等待真实 Promise 的契约无法在本 prototype 施测；不伪造假 Promise 包装。进入生产前需要异步 API 契约与取消/恢复语义',
  };
});

// ============================ 汇总 ============================
const counts = { PASS: 0, EXPECTED_RED: 0, UNSUPPORTED_EXPECTED_RED: 0, DEGRADED: 0, BLOCKED: 0, FAIL: 0 };
for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

const anyFail = counts.FAIL > 0;
console.log('=== 4.3.0 CodeBuddy 契约运行结果（rework-02，真实入口调用） ===');
console.log('真实加载入口: ' + (prototypeLoaded ? ATLAS_PATH + ' , ' + ADAPTER_PATH : '加载失败'));
if (prototypeLoadErrors.length) console.log('prototype 加载错误: ' + JSON.stringify(prototypeLoadErrors));
console.log('用例总数=' + results.length + '  ' + JSON.stringify(counts));
for (const r of results) {
  const ranTag = r.target === 'prototype' ? ' ran=' + !!r.ran : '';
  console.log(`[${r.status}] ${r.id} ${r.title}${ranTag}`);
  if (r.call) console.log('    call: ' + r.call);
  if (r.observed) console.log('    observed: ' + r.observed);
  if (r.detail) console.log('    detail: ' + r.detail);
}
console.log('FAIL(非预期失败)=' + counts.FAIL + '  UNSUPPORTED_EXPECTED_RED(API 缺失，不计入 PASS)=' + counts.UNSUPPORTED_EXPECTED_RED);

process.exit(anyFail ? 1 : 0);
