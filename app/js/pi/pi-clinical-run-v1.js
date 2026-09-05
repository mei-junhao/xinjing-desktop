'use strict';
/**
 * pi-clinical-run-v1.js — ClinicalActionRun 流水线：propose → approval(high) → durable → settle 回执
 * durable 写入是唯一写通道（注入模拟）；{ok:false} 原样传播，绝不吞掉；settled 必须带回执。
 */
const P = require('./pi-protocol-v1.js');

/**
 * createClinicalRunBroker({ approvalBroker, durableWrite, durableRead, eventLog, mutations })
 *   durableWrite: (record) => {ok:true, savedObjectId, version}|{ok:false,code,...}
 *   durableRead: (savedObjectId) => {ok:true, object}|{ok:false,...}（VERIFY 阶段回读）
 */
function createClinicalRunBroker(options) {
  const opts = options || {};
  const approvalBroker = opts.approvalBroker;
  const durableWrite = typeof opts.durableWrite === 'function' ? opts.durableWrite : () => P.fail('XJ_PI_DIRECT_WRITE_DENIED', 'durable channel not wired');
  const durableRead = typeof opts.durableRead === 'function' ? opts.durableRead : () => P.fail('XJ_PI_VERIFY_FAILED', 'durable read not wired');
  const eventLog = opts.eventLog || null;
  const mutations = opts.mutations || {};
  const runs = new Map();

  /** propose（生成 run 记忆，未写入） */
  function propose(task, action, targetRecord, fields) {
    if (action !== 'clinical.commit.record') return P.fail('XJ_PI_UNKNOWN_TOOL', 'run pipeline only for commit');
    if (!targetRecord || typeof targetRecord !== 'object') return P.fail('XJ_PI_UNKNOWN_FIELD');
    if (!P.hasOnlyKeys(targetRecord, ['kind', 'clientId', 'sessionId'])) return P.fail('XJ_PI_UNKNOWN_FIELD');
    if (!mutations.ignoreContextBinding
      && (targetRecord.clientId !== task.clinicalContext.clientId || targetRecord.sessionId !== task.clinicalContext.sessionId)) {
      return P.fail('XJ_PI_CLIENT_SESSION_MISMATCH', 'run target mismatch');
    }
    const run = {
      runId: P.nsec('car'), taskId: task.taskId, action,
      targetRecord: { kind: targetRecord.kind === 'supervision' ? 'supervision' : 'session', clientId: targetRecord.clientId, sessionId: targetRecord.sessionId },
      inputSnapshotHash: task.clinicalContext.snapshotHash,
      approvalId: null, toolCalls: [], status: 'proposed', settleReceipt: null,
    };
    runs.set(run.runId, run);
    if (eventLog) eventLog.append(task.taskId, 'clinical.action.run', { runId: run.runId, action, snapshotHash: run.inputSnapshotHash, status: 'proposed' });
    return { ok: true, run };
  }

  /**
   * settle（执行 durable 写入并回执）。前置：high-risk 已 consumeApproved。
   * {ok:false} 原样传播（变异开关 swallowOkFalse 仅测试可观测）。
   */
  async function settle(task, run, fields) {
    if (!run || run.taskId !== task.taskId) return P.fail('XJ_PI_TASK_NOT_FOUND');
    const spec = P.TOOL_REGISTRY[run.action];
    if (spec && spec.approval) {
      if (!mutations.disableApprovalGate) {
        const consumed = approvalBroker ? approvalBroker.consumeApproved(task.taskId, spec.approvalScope) : P.fail('XJ_PI_APPROVAL_REQUIRED');
        if (P.isFail(consumed)) return consumed;
        run.approvalId = consumed.approval.approvalId;
      }
    }
    run.status = 'executing';
    if (eventLog) eventLog.append(task.taskId, 'clinical.action.run', { runId: run.runId, action: run.action, status: 'executing' });
    const receipt = await durableWrite({
      taskId: task.taskId, runId: run.runId, kind: run.targetRecord.kind,
      clientId: run.targetRecord.clientId, sessionId: run.targetRecord.sessionId,
      fields: fields || {}, snapshotHash: run.inputSnapshotHash,
    });
    if (!mutations.swallowOkFalse && P.isFail(receipt)) {
      run.status = 'failed';
      if (eventLog) eventLog.append(task.taskId, 'tool.call.result', { callId: run.runId, ok: false, errorCode: receipt.code });
      return receipt; // 原样传播
    }
    if (P.isFail(receipt)) { run.status = 'failed'; return { ok: true, swallowed: true, via: 'mutation' }; } // 变异开关：吞失败
    if (!receipt || typeof receipt.savedObjectId !== 'string' || !Number.isSafeInteger(receipt.version)) {
      if (!mutations.settleWithoutReceipt) return P.fail('XJ_PI_VERIFY_FAILED', 'settle receipt missing fields');
      run.status = 'settled'; run.settleReceipt = null; // 变异开关：无回执 settle
      if (eventLog) eventLog.append(task.taskId, 'clinical.action.run', { runId: run.runId, status: 'settled', receiptless: true });
      return { ok: true, run };
    }
    run.status = 'settled';
    run.settleReceipt = { savedObjectId: receipt.savedObjectId, version: receipt.version, savedAt: new Date().toISOString() };
    if (eventLog) eventLog.append(task.taskId, 'tool.call.result', { callId: run.runId, ok: true, resultDigest: 'sha256:' + require('crypto').createHash('sha256').update(receipt.savedObjectId).digest('hex') });
    return { ok: true, run };
  }

  /** VERIFY 阶段回读：settle 回执必须可回读且 snapshotHash 一致 */
  function verify(task, run) {
    if (mutations.settleWithoutReceipt) return { ok: true, receiptless: true }; // 变异开关 M13：verify 跳过（仅测试）
    if (!run || run.status !== 'settled') return P.fail('XJ_PI_VERIFY_FAILED', 'run not settled');
    if (!run.settleReceipt) return P.fail('XJ_PI_VERIFY_FAILED', 'no receipt');
    const back = durableRead(run.settleReceipt.savedObjectId);
    if (P.isFail(back)) return back;
    const obj = back.object || back;
    if (obj.snapshotHash !== run.inputSnapshotHash) return P.fail('XJ_PI_SNAPSHOT_MISMATCH', 'verify hash mismatch');
    if (obj.version !== run.settleReceipt.version) return P.fail('XJ_PI_VERIFY_FAILED', 'version mismatch');
    return { ok: true, savedObjectId: run.settleReceipt.savedObjectId };
  }

  /** 直写守卫：绕过流水线一律拒绝（旧 writer 回退也走这里） */
  function directWriteGuard() {
    if (mutations.legacyWriterFallback) return { ok: true, via: 'legacy-writer', warning: 'MUTATION' };
    return P.fail('XJ_PI_DIRECT_WRITE_DENIED');
  }

  function of(runId) { return runs.get(runId); }

  return Object.freeze({ propose, settle, verify, directWriteGuard, of });
}

module.exports = { createClinicalRunBroker };
