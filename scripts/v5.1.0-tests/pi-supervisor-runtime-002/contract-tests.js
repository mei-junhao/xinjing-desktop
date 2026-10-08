'use strict';
/**
 * XJ-5.1.0-pi-workbench-supervisor-runtime-contract-implementation-002 — 契约测试
 * 覆盖：状态机、事件 seq、context/snapshot(D1)、五 Broker、Approval timeout(D3)、
 * pause/resume/cancel、legacy 映射(D4)、durable settle、{ok:false} 传播、VERIFY 回读。
 */
const assert = require('assert');
const { createSupervisor } = require('../../../app/js/pi/pi-supervisor-v1.js');
const { createEventLog } = require('../../../app/js/pi/pi-event-log-v1.js');
const { mapLegacyTool } = require('../../../app/js/pi/pi-legacy-map-v1.js');

let pass = 0, fail = 0;
const pending = [];
function t(name, fn) {
  const done = (ok, msg) => { if (ok) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + ' :: ' + msg); } };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => done(true), (e) => done(false, e.message)));
    } else done(true);
  } catch (e) { done(false, e.message); }
}
const code = (r) => (r && r.ok === false ? r.code : 'OK');

// 可控时钟
function makeClock(start) { let now = start; return { clock: () => now, advance: (ms) => { now += ms; } }; }

const PROJ = {
  clientId: 'c_100', sessionId: 's_200', storeProjectionVersion: 7, membershipProjectionVersion: 3,
  sourceRefs: [{ sourceId: 'src_1', sourceVersion: 2, sourceContentHash: 'sha256:' + 'b'.repeat(64), anchorContentHash: 'sha256:' + 'c'.repeat(64) }],
};
function makeSupervisor(over) {
  return createSupervisor(Object.assign({
    serverMembershipProjection: () => ({ tier: 'pro' }),
    readProjector: (tool, args) => ({ ok: true, data: { tool, args } }),
    liveProjection: () => PROJ,
    durableWrite: () => ({ ok: true, savedObjectId: 'obj_' + Math.random().toString(36).slice(2, 8), version: 1 }),
    durableRead: () => P_fail_placeholder(),
  }, over));
}
// durableRead 需要与 write 一致：默认实现放工厂内
function P_fail_placeholder() { return { ok: false, code: 'XJ_PI_VERIFY_FAILED' }; }

// 重新封装默认工厂（write/read 联动；确定性 id，不用随机）
let objSeq = 0;
function defaultSupervisor(over) {
  const store = new Map();
  return createSupervisor(Object.assign({
    serverMembershipProjection: () => ({ tier: 'pro' }),
    readProjector: (tool, args) => ({ ok: true, data: { tool, args } }),
    liveProjection: () => PROJ,
    durableWrite: (rec) => { const id = 'obj_' + String(++objSeq); store.set(id, { snapshotHash: rec.snapshotHash, version: 1 }); return { ok: true, savedObjectId: id, version: 1 }; },
    durableRead: (id) => store.has(id) ? { ok: true, object: store.get(id) } : { ok: false, code: 'XJ_PI_VERIFY_FAILED' },
  }, over));
}

// ---------- 状态机与正向全流程 ----------
t('P1-full-commit-lifecycle', async () => {
  const sup = defaultSupervisor();
  const cr = sup.startTask({ taskId: 'xj_task_p1', mode: 'commit', projection: PROJ });
  assert.strictEqual(cr.ok, true);
  assert.strictEqual(sup.contextCheck('xj_task_p1').ok, true);
  assert.strictEqual(sup.plan('xj_task_p1', [{ tool: 'read.client.summary', args: { clientId: 'c_100' } }]).ok, true);
  const tool = sup.runToolStep('xj_task_p1', { tool: 'read.client.summary', args: { clientId: 'c_100' } });
  assert.strictEqual(tool.ok, true);
  // COMMIT：首次 → awaiting approval
  const c1 = await sup.commitStep('xj_task_p1', { kind: 'session', clientId: 'c_100', sessionId: 's_200' }, { note: 'n' });
  assert.strictEqual(code(c1), 'XJ_PI_APPROVAL_REQUIRED');
  assert.strictEqual(c1.awaiting, true);
  const ap = sup.resolveApproval(c1.pendingApprovalId, 'approved', 'local-user');
  assert.strictEqual(ap.ok, true);
  const c2 = await sup.commitStep('xj_task_p1', { kind: 'session', clientId: 'c_100', sessionId: 's_200' }, { note: 'n' });
  assert.strictEqual(c2.ok, true);
  assert.ok(c2.savedObjectId);
  const d = sup.diagnose('xj_task_p1');
  assert.strictEqual(d.task.status, 'succeeded');
  const phases = d.events.filter((e) => e.type === 'phase.entered').map((e) => e.payload.phase);
  assert.deepStrictEqual(phases, ['INTAKE', 'CONTEXT_CHECK', 'PLAN', 'TOOL_LOOP', 'APPROVAL', 'COMMIT', 'VERIFY', 'RESPOND']);
});

t('P2-observe-read-only', () => {
  const sup = defaultSupervisor();
  sup.startTask({ taskId: 'xj_task_p2', mode: 'observe', projection: PROJ });
  sup.contextCheck('xj_task_p2');
  const r = sup.runToolStep('xj_task_p2', { tool: 'read.session.notes', args: { sessionId: 's_200' } });
  assert.strictEqual(r.ok, true);
});

t('P3-command-hash-and-navigate-argless', () => {
  const sup = defaultSupervisor();
  sup.startTask({ taskId: 'xj_task_p3', mode: 'observe', projection: PROJ });
  const h = sup.runToolStep('xj_task_p3', { tool: 'command.hash', args: { value: 'abc' } });
  assert.strictEqual(h.ok, true);
  assert.ok(h.result.hash.startsWith('sha256:'));
  const nav = sup.runToolStep('xj_task_p3', { tool: 'command.navigate', args: {} });
  assert.strictEqual(nav.ok, true);
  const navBad = sup.runToolStep('xj_task_p3', { tool: 'command.navigate', args: { url: 'https://evil' } });
  assert.strictEqual(code(navBad), 'XJ_PI_UNKNOWN_FIELD'); // D2
});

t('P4-supervision-draft', () => {
  const sup = defaultSupervisor();
  sup.startTask({ taskId: 'xj_task_p4', mode: 'supervision', projection: PROJ });
  const r = sup.runToolStep('xj_task_p4', { tool: 'supervision.note.append', args: { noteText: '督导草稿' } });
  assert.strictEqual(r.ok, true);
});

// ---------- 事件协议 ----------
t('E1-event-seq-strict-and-replay', () => {
  const el = createEventLog();
  assert.strictEqual(el.append('xj_task_e1', 'task.created', {}).ok, true);
  assert.strictEqual(el.append('xj_task_e1', 'task.created', {}).ok, true); // seq=2 同型允许
  assert.strictEqual(code(el.replay('xj_task_e1', { v: 1, taskId: 'xj_task_e1', seq: 2, at: '', actor: 'pi', type: 'task.paused', payload: {} })), 'XJ_PI_EVENT_SEQ'); // 倒退
  assert.strictEqual(code(el.replay('xj_task_e1', { v: 1, taskId: 'xj_task_e1', seq: 4, at: '', actor: 'pi', type: 'task.paused', payload: {} })), 'XJ_PI_EVENT_SEQ'); // 跳跃
  assert.strictEqual(code(el.replay('xj_task_e1', { v: 2, taskId: 'xj_task_e1', seq: 3, at: '', actor: 'pi', type: 'task.paused', payload: {} })), 'XJ_PI_EVENT_VERSION');
  assert.strictEqual(el.replay('xj_task_e1', { v: 1, taskId: 'xj_task_e1', seq: 3, at: '', actor: 'pi', type: 'task.paused', payload: {} }).ok, true);
  assert.strictEqual(code(el.append('xj_task_e1', 'task.exploded', {})), 'XJ_PI_UNKNOWN_EVENT');
});

// ---------- snapshot / context ----------
t('S1-snapshot-drift-fails-context-check', () => {
  let proj = PROJ;
  const sup = defaultSupervisor({ liveProjection: () => proj });
  sup.startTask({ taskId: 'xj_task_s1', mode: 'observe', projection: PROJ });
  proj = Object.assign({}, PROJ, { storeProjectionVersion: 8 }); // Store 投影漂移
  const r = sup.contextCheck('xj_task_s1');
  assert.strictEqual(code(r), 'XJ_PI_SNAPSHOT_MISMATCH');
  assert.strictEqual(sup.diagnose('xj_task_s1').task.status, 'failed');
});
t('S2-cross-context-tool-denied', () => {
  const sup = defaultSupervisor();
  sup.startTask({ taskId: 'xj_task_s2', mode: 'observe', projection: PROJ });
  assert.strictEqual(code(sup.runToolStep('xj_task_s2', { tool: 'read.client.summary', args: { clientId: 'c_OTHER' } })), 'XJ_PI_CLIENT_SESSION_MISMATCH');
});
t('S3-bad-projection-intake-denied', () => {
  const sup = defaultSupervisor();
  assert.strictEqual(code(sup.startTask({ taskId: 'xj_task_s3', mode: 'observe', projection: { clientId: 'c', sessionId: 's', storeProjectionVersion: 1, membershipProjectionVersion: 1, sourceRefs: [], extra: 1 } })), 'XJ_PI_UNKNOWN_FIELD');
});

// ---------- Approval timeout（D3）----------
t('A1-approval-five-minute-timeout', async () => {
  const clk = makeClock(1_000_000);
  const sup = defaultSupervisor({ clock: clk.clock });
  sup.startTask({ taskId: 'xj_task_a1', mode: 'commit', projection: PROJ });
  const c1 = await sup.commitStep('xj_task_a1', { kind: 'session', clientId: 'c_100', sessionId: 's_200' }, {});
  assert.strictEqual(c1.awaiting, true);
  clk.advance(5 * 60 * 1000 + 1); // 超 5 分钟
  const r = sup.resolveApproval(c1.pendingApprovalId, 'approved', 'local-user');
  assert.strictEqual(code(r), 'XJ_PI_APPROVAL_REJECTED'); // 过期不可 approved
  const d = sup.diagnose('xj_task_a1');
  assert.strictEqual(d.task.status, 'paused'); // D3：timeout → paused
});
t('A2-expired-approved-cannot-consume', async () => {
  const clk = makeClock(1_000_000);
  const sup = defaultSupervisor({ clock: clk.clock });
  sup.startTask({ taskId: 'xj_task_a2', mode: 'commit', projection: PROJ });
  const c1 = await sup.commitStep('xj_task_a2', { kind: 'session', clientId: 'c_100', sessionId: 's_200' }, {});
  sup.resolveApproval(c1.pendingApprovalId, 'approved', 'local-user');
  clk.advance(5 * 60 * 1000 + 1);
  const c2 = await sup.commitStep('xj_task_a2', { kind: 'session', clientId: 'c_100', sessionId: 's_200' }, {});
  assert.strictEqual(code(c2), 'XJ_PI_APPROVAL_REQUIRED'); // 已过期 approved 不可消费（D3）
  assert.strictEqual(sup.diagnose('xj_task_a2').task.status, 'paused'); // 可恢复：暂停而非失败
});
t('A3-cancel-invalidates-pending', async () => {
  const sup = defaultSupervisor();
  sup.startTask({ taskId: 'xj_task_a3', mode: 'commit', projection: PROJ });
  const c1 = await sup.commitStep('xj_task_a3', { kind: 'session', clientId: 'c_100', sessionId: 's_200' }, {});
  sup.cancel('xj_task_a3');
  assert.strictEqual(sup.approvalBroker.of(c1.pendingApprovalId).resolution, 'rejected'); // 立即失效
  const c2 = await sup.commitStep('xj_task_a3', { kind: 'session', clientId: 'c_100', sessionId: 's_200' }, {});
  assert.strictEqual(code(c2), 'XJ_PI_WRITE_AFTER_CANCEL');
  assert.strictEqual(code(sup.resume('xj_task_a3')), 'XJ_PI_WRITE_AFTER_CANCEL'); // 取消不可恢复
});

// ---------- pause/resume ----------
t('Z1-pause-resume', () => {
  const sup = defaultSupervisor();
  sup.startTask({ taskId: 'xj_task_z1', mode: 'draft', projection: PROJ });
  sup.pause('xj_task_z1', 'user');
  assert.strictEqual(sup.diagnose('xj_task_z1').task.status, 'paused');
  assert.strictEqual(code(sup.runToolStep('xj_task_z1', { tool: 'read.task.cards', args: {} })), 'XJ_PI_WRITE_AFTER_CANCEL'); // paused 拒写
  assert.strictEqual(sup.resume('xj_task_z1').ok, true);
  assert.strictEqual(sup.runToolStep('xj_task_z1', { tool: 'read.task.cards', args: {} }).ok, true);
});

// ---------- durable / verify / 失败传播 ----------
t('D1-durable-failure-propagates', async () => {
  const sup = defaultSupervisor({ durableWrite: () => ({ ok: false, code: 'XJ_PI_SNAPSHOT_MISMATCH' }) });
  sup.startTask({ taskId: 'xj_task_d1', mode: 'commit', projection: PROJ });
  const c1 = await sup.commitStep('xj_task_d1', { kind: 'session', clientId: 'c_100', sessionId: 's_200' }, {});
  sup.resolveApproval(c1.pendingApprovalId, 'approved', 'local-user');
  const c2 = await sup.commitStep('xj_task_d1', { kind: 'session', clientId: 'c_100', sessionId: 's_200' }, {});
  assert.strictEqual(code(c2), 'XJ_PI_SNAPSHOT_MISMATCH'); // {ok:false} 原样传播
  assert.strictEqual(sup.diagnose('xj_task_d1').task.status, 'failed');
});
t('D2-verify-readback', async () => {
  const store = new Map();
  const sup = defaultSupervisor({
    durableWrite: (rec) => { const id = 'obj_v'; store.set(id, { snapshotHash: rec.snapshotHash, version: 1 }); return { ok: true, savedObjectId: id, version: 1 }; },
    durableRead: (id) => store.has(id) ? { ok: true, object: store.get(id) } : { ok: false, code: 'XJ_PI_VERIFY_FAILED' },
  });
  sup.startTask({ taskId: 'xj_task_d2', mode: 'commit', projection: PROJ });
  const c1 = await sup.commitStep('xj_task_d2', { kind: 'session', clientId: 'c_100', sessionId: 's_200' }, {});
  sup.resolveApproval(c1.pendingApprovalId, 'approved', 'local-user');
  const c2 = await sup.commitStep('xj_task_d2', { kind: 'session', clientId: 'c_100', sessionId: 's_200' }, {});
  assert.strictEqual(c2.ok, true);
});

// ---------- legacy 映射（D4）----------
t('L1-legacy-mapping-and-unmapped', () => {
  const sup = defaultSupervisor();
  sup.startTask({ taskId: 'xj_task_l1', mode: 'observe', projection: PROJ });
  const ok1 = sup.runToolStep('xj_task_l1', { legacyTool: 'client.query', args: { clientId: 'c_100' } });
  assert.strictEqual(ok1.ok, true);
  assert.strictEqual(ok1.result.data.tool, 'read.client.summary');
  const bad = sup.runToolStep('xj_task_l1', { legacyTool: 'billing.query', args: {} });
  assert.strictEqual(code(bad), 'XJ_PI_LEGACY_TOOL_UNMAPPED');
  assert.strictEqual(code(mapLegacyTool('client.update')), 'XJ_PI_LEGACY_TOOL_UNMAPPED');
});

// ---------- 会员 ----------
t('M1-membership-unknown-failclosed', () => {
  const sup = defaultSupervisor({ serverMembershipProjection: () => null });
  sup.startTask({ taskId: 'xj_task_m1', mode: 'observe', projection: PROJ });
  assert.strictEqual(code(sup.runToolStep('xj_task_m1', { tool: 'read.task.cards', args: {} })), 'XJ_PI_MEMBERSHIP_UNKNOWN');
});

// ---------- 重放/幂等 ----------
t('R1-task-id-replay-denied', () => {
  const sup = defaultSupervisor();
  sup.startTask({ taskId: 'xj_task_r1', mode: 'observe', projection: PROJ });
  assert.strictEqual(code(sup.startTask({ taskId: 'xj_task_r1', mode: 'commit', projection: PROJ })), 'XJ_PI_TASK_ID_REPLAY');
});
t('R2-double-commit-denied', async () => {
  const sup = defaultSupervisor();
  sup.startTask({ taskId: 'xj_task_r2', mode: 'commit', projection: PROJ });
  const c1 = await sup.commitStep('xj_task_r2', { kind: 'session', clientId: 'c_100', sessionId: 's_200' }, {});
  sup.resolveApproval(c1.pendingApprovalId, 'approved', 'local-user');
  await sup.commitStep('xj_task_r2', { kind: 'session', clientId: 'c_100', sessionId: 's_200' }, {});
  const again = await sup.commitStep('xj_task_r2', { kind: 'session', clientId: 'c_100', sessionId: 's_200' }, {});
  assert.strictEqual(code(again), 'XJ_PI_DUPLICATE_COMMIT'); // succeeded 终态后再写
});

(async () => {
  await Promise.all(pending);
  console.log('SUMMARY contract-tests pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
