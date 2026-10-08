'use strict';
/**
 * XJ-5.1.0-...-002 — 反向变异测试（14 项，全部必须 KILLED）
 * 判定语义：KILLED = 基线（防线在位必须阻断）+ 变异（防线拆除后契约违反可被探针观察）双断言成立。
 * 开关经 createSupervisor({mutations}) 注入，生产永不传入。
 * 1 disableApprovalGate / 2 swallowOkFalse / 3 replayTaskAllowed / 4 ignoreContextBinding /
 * 5 forgeMembershipFallback / 6 bypassApprovalTimeout / 7 writeAfterCancelAllowed /
 * 8 legacyWriterFallback / 9 allowUnknownTool / 10 allowUnknownField / 11 allowUnknownEvent /
 * 12 seqRegressionAllowed / 13 settleWithoutReceipt / 14 skipAwaitSettle（删除 await）
 */
const { createSupervisor } = require('../../../app/js/pi/pi-supervisor-v1.js');
const { createEventLog } = require('../../../app/js/pi/pi-event-log-v1.js');

const PROJ = {
  clientId: 'c_100', sessionId: 's_200', storeProjectionVersion: 7, membershipProjectionVersion: 3,
  sourceRefs: [{ sourceId: 'src_1', sourceVersion: 2, sourceContentHash: 'sha256:' + 'b'.repeat(64), anchorContentHash: 'sha256:' + 'c'.repeat(64) }],
};
const TGT = { kind: 'session', clientId: 'c_100', sessionId: 's_200' };

function makeSupervisor(extra, mut) {
  const over = extra || {};
  const mutations = mut || {};
  const store = new Map();
  let seq = 0;
  return createSupervisor({
    serverMembershipProjection: over.serverMembershipProjection || (() => ({ tier: 'pro' })),
    readProjector: (tool, args) => ({ ok: true, data: { tool, args } }),
    liveProjection: over.liveProjection || (() => PROJ),
    durableWrite: over.durableWrite || ((rec) => { const id = 'obj_' + String(++seq); store.set(id, { snapshotHash: rec.snapshotHash, version: 1 }); return { ok: true, savedObjectId: id, version: 1 }; }),
    durableRead: over.durableRead || ((id) => store.has(id) ? { ok: true, object: store.get(id) } : { ok: false, code: 'XJ_PI_VERIFY_FAILED' }),
    clock: over.clock,
    mutations,
  });
}
const isFail = (r) => r && r.ok === false;

let killed = 0, survived = 0;
function verdict(name, ok, detail) {
  console.log((ok ? 'KILLED ' : 'SURVIVED ') + name + (detail ? ' :: ' + detail : ''));
  if (ok) killed++; else survived++;
}

// ---------- 探针（返回 true = 契约被违反被观察） ----------
async function probeApprovalRemoved(mut) {
  const sup = makeSupervisor(null, mut);
  sup.startTask({ taskId: 'xj_task_m1', mode: 'commit', projection: PROJ });
  const r = await sup.commitStep('xj_task_m1', TGT, {});
  return r.ok === true && r.savedObjectId !== undefined; // 无确认直接写成功 = 违反
}
async function probeSwallowOkFalse(mut) {
  const sup = makeSupervisor({ durableWrite: () => ({ ok: false, code: 'XJ_PI_SNAPSHOT_MISMATCH' }) }, mut);
  sup.startTask({ taskId: 'xj_task_m2', mode: 'commit', projection: PROJ });
  const c1 = await sup.commitStep('xj_task_m2', TGT, {});
  if (isFail(c1) && c1.awaiting) {
    sup.resolveApproval(c1.pendingApprovalId, 'approved', 'local-user');
    const c2 = await sup.commitStep('xj_task_m2', TGT, {});
    return c2.ok === true; // durable 失败被吞成成功
  }
  return c1.ok === true; // 基线 disableApprovalGate 未开时直接 settled = 也算违反（approval 仍被跳过？）
}
async function probeReplayTask(mut) {
  const sup = makeSupervisor(null, mut);
  const a = sup.startTask({ taskId: 'xj_task_m5', mode: 'observe', projection: PROJ });
  const b = sup.startTask({ taskId: 'xj_task_m5', mode: 'commit', projection: PROJ });
  return a.ok === true && b.ok === true; // 重放被接受
}
async function probeCrossContext(mut) {
  const sup = makeSupervisor(null, mut);
  sup.startTask({ taskId: 'xj_task_m6', mode: 'observe', projection: PROJ });
  const r = sup.runToolStep('xj_task_m6', { tool: 'read.client.summary', args: { clientId: 'c_INTRUDER' } });
  return r.ok === true;
}
async function probeForgedMembership(mut) {
  const sup = makeSupervisor({ serverMembershipProjection: () => null }, mut);
  sup.startTask({ taskId: 'xj_task_m4', mode: 'observe', projection: PROJ });
  return sup.runToolStep('xj_task_m4', { tool: 'read.task.cards', args: {} }).ok === true;
}
async function probeBypassTimeout(mut) {
  let now = 1_000_000;
  const clock = () => now;
  const sup = makeSupervisor({ clock }, mut);
  sup.startTask({ taskId: 'xj_task_m6t', mode: 'commit', projection: PROJ });
  const c1 = await sup.commitStep('xj_task_m6t', TGT, {});
  now += 5 * 60 * 1000 + 1; // 过期
  const r = sup.resolveApproval(c1.pendingApprovalId, 'approved', 'local-user');
  return r.ok === true; // 过期批准被接受 = 违反 D3
}
async function probeWriteAfterCancel(mut) {
  const sup = makeSupervisor(null, mut);
  sup.startTask({ taskId: 'xj_task_m7', mode: 'commit', projection: PROJ });
  sup.cancel('xj_task_m7');
  const r = sup.runToolStep('xj_task_m7', { tool: 'read.task.cards', args: {} });
  return r.ok === true; // 取消后工具步仍放行 = 违反
}
async function probeLegacyWriterFallback(mut) {
  const sup = makeSupervisor(null, mut);
  sup.startTask({ taskId: 'xj_task_m8', mode: 'observe', projection: PROJ });
  const r = sup.runToolStep('xj_task_m8', { legacyTool: 'client.update', args: { clientId: 'c_100', patch: { evil: 1 } } });
  return r.ok === true; // 未映射旧写工具被放行
}
async function probeUnknownTool(mut) {
  const sup = makeSupervisor(null, mut);
  sup.startTask({ taskId: 'xj_task_m9', mode: 'observe', projection: PROJ });
  return sup.runToolStep('xj_task_m9', { tool: 'shell.exec', args: {} }).ok === true;
}
async function probeUnknownField(mut) {
  const sup = makeSupervisor(null, mut);
  const r = sup.startTask({ taskId: 'xj_task_m10', mode: 'observe', projection: PROJ, evilKey: 1 });
  return r.ok === true;
}
async function probeUnknownEvent(mut) {
  const el = createEventLog({ mutations: mut });
  const r = el.append('xj_task_m11', 'task.exploded', {});
  return r.ok === true; // 未知事件被放行入账 = 违反（开关打开时 append 真实放行）
}
async function probeSeqRegression(mut) {
  const el = createEventLog({ mutations: mut });
  el.append('xj_task_m12', 'task.created', {});
  const r = el.replay('xj_task_m12', { v: 1, taskId: 'xj_task_m12', seq: 1, at: '', actor: 'pi', type: 'task.paused', payload: {} });
  return r.ok === true; // seq=1 重放（倒退）被接受
}
async function probeSettleWithoutReceipt(mut) {
  const sup = makeSupervisor({ durableWrite: () => ({ ok: true, savedObjectId: undefined, version: undefined }) }, mut);
  sup.startTask({ taskId: 'xj_task_m13', mode: 'commit', projection: PROJ });
  const c1 = await sup.commitStep('xj_task_m13', TGT, {});
  sup.resolveApproval(c1.pendingApprovalId, 'approved', 'local-user');
  const c2 = await sup.commitStep('xj_task_m13', TGT, {});
  return c2.ok === true; // 无有效回执仍 settled/succeeded
}
async function probeSkipAwait(mut) {
  const sup = makeSupervisor({ durableWrite: () => new Promise((res) => { setTimeout(() => res({ ok: true, savedObjectId: 'obj_late', version: 1 }), 120); }) }, mut);
  sup.startTask({ taskId: 'xj_task_m14', mode: 'commit', projection: PROJ });
  const c1 = await sup.commitStep('xj_task_m14', TGT, {});
  sup.resolveApproval(c1.pendingApprovalId, 'approved', 'local-user');
  const c2 = await sup.commitStep('xj_task_m14', TGT, {});
  return c2.ok === true && c2.premature === true; // 未等 settle 即成功（基线：120ms 后才 settle，不可能 premature）
}

const cases = [
  ['M1-remove-approval-gate', { disableApprovalGate: true }, probeApprovalRemoved],
  ['M2-swallow-ok-false', { swallowOkFalse: true }, probeSwallowOkFalse],
  ['M3-replay-task-id', { replayTaskAllowed: true }, probeReplayTask],
  ['M4-cross-context', { ignoreContextBinding: true }, probeCrossContext],
  ['M5-forged-membership', { forgeMembershipFallback: true }, probeForgedMembership],
  ['M6-bypass-approval-timeout', { bypassApprovalTimeout: true }, probeBypassTimeout],
  ['M7-write-after-cancel', { writeAfterCancelAllowed: true }, probeWriteAfterCancel],
  ['M8-legacy-writer-fallback', { legacyWriterFallback: true }, probeLegacyWriterFallback],
  ['M9-unknown-tool-allowed', { allowUnknownTool: true }, probeUnknownTool],
  ['M10-unknown-field-allowed', { allowUnknownField: true }, probeUnknownField],
  ['M11-unknown-event-allowed', { allowUnknownEvent: true }, probeUnknownEvent],
  ['M12-seq-regression-allowed', { seqRegressionAllowed: true }, probeSeqRegression],
  ['M13-settle-without-receipt', { settleWithoutReceipt: true }, probeSettleWithoutReceipt],
  ['M14-del-await-skip-settle', { skipAwaitSettle: true }, probeSkipAwait],
];

(async () => {
  for (const [name, mut, probe] of cases) {
    let baseViolated = false;
    let mutViolated = false;
    try { baseViolated = await probe({}); } catch (e) { baseViolated = 'ERR:' + e.message; }
    try { mutViolated = await probe(mut); } catch (e) { mutViolated = 'ERR:' + e.message; }
    verdict(name, baseViolated === false && mutViolated === true, 'baseline=' + baseViolated + ' mutated=' + mutViolated);
  }
  console.log('SUMMARY mutation-tests killed=' + killed + ' survived=' + survived);
  process.exit(survived === 0 ? 0 : 1);
})();
