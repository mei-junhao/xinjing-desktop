'use strict';
/**
 * pi-supervisor-v1.js — Pi Supervisor 本地运行时核心（WP1 002）
 * 状态机：INTAKE → CONTEXT_CHECK → PLAN → TOOL_LOOP → APPROVAL → COMMIT → VERIFY → RESPOND
 * 支持 PAUSED / CANCELLED / FAILED；时钟注入；纯本地隔离实现，未接入 Electron/AgentCore。
 */
const P = require('./pi-protocol-v1.js');
const { createEventLog } = require('./pi-event-log-v1.js');
const { createApprovalBroker } = require('./pi-approval-v1.js');
const { createBrokers } = require('./pi-brokers-v1.js');
const { createClinicalRunBroker } = require('./pi-clinical-run-v1.js');
const { mapLegacyTool } = require('./pi-legacy-map-v1.js');

/**
 * createSupervisor(options)
 *   serverMembershipProjection / readProjector / commandHash / durableWrite / durableRead / liveProjection
 *     —— liveProjection: () => D1 投影对象（CONTEXT_CHECK 阶段重算比对；未注入则跳过在线比对）
 *   clock: () => ms
 *   mutations: 命名变异开关（仅测试；生产永不传入）
 */
function createSupervisor(options) {
  const opts = options || {};
  const mutations = opts.mutations || {};
  const clock = typeof opts.clock === 'function' ? opts.clock : () => Date.now();
  const computeSnapshot = typeof opts.computeSnapshotHash === 'function' ? opts.computeSnapshotHash : P.computeSnapshotHash;
  const liveProjection = typeof opts.liveProjection === 'function' ? opts.liveProjection : null;

  const eventLog = createEventLog({ mutations });
  const tasks = new Map(); // taskId -> {task, phase, resumePhase, savedObjectIds}
  const mutationWarn = [];

  const approvalBroker = createApprovalBroker({
    clock, eventLog, mutations,
    isTaskCancelled: (taskId) => {
      const rec = tasks.get(taskId);
      return !!rec && rec.task.status === 'cancelled';
    },
  });
  const brokers = createBrokers(Object.assign({}, opts, { approvalBroker, eventLog, mutations }));
  const clinicalRun = createClinicalRunBroker({ approvalBroker, durableWrite: opts.durableWrite, durableRead: opts.durableRead, eventLog, mutations });

  function isTerminal(status) { return P.TERMINAL_STATUSES.includes(status); }
  function writable(rec) {
    const st = rec.task.status;
    if (st === 'cancelled') return mutations.writeAfterCancelAllowed ? true : P.fail('XJ_PI_WRITE_AFTER_CANCEL');
    if (isTerminal(st)) return P.fail('XJ_PI_DUPLICATE_COMMIT');
    return true;
  }
  function enterPhase(taskId, phase) {
    const rec = tasks.get(taskId);
    rec.phase = phase;
    eventLog.append(taskId, 'phase.entered', { phase });
  }

  /** INTAKE：创建任务（幂等；D1 快照冻结；未知 mode/字段 fail-closed） */
  function startTask(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return P.fail('XJ_PI_UNKNOWN_FIELD');
    if (!mutations.allowUnknownField && !P.hasOnlyKeys(input, ['taskId', 'conversationId', 'mode', 'requestedBy', 'createdAt', 'projection'])) return P.fail('XJ_PI_UNKNOWN_FIELD');
    if (!P.taskIdOk(input.taskId)) return P.fail('XJ_PI_TASK_NOT_FOUND', 'invalid taskId');
    if (!P.MODES.includes(input.mode)) return P.fail('XJ_PI_UNKNOWN_MODE');
    if (input.projection && !P.hasOnlyKeys(input.projection, ['clientId', 'sessionId', 'sourceRefs', 'storeProjectionVersion', 'membershipProjectionVersion'])) return P.fail('XJ_PI_UNKNOWN_FIELD', 'projection');
    if (tasks.has(input.taskId)) {
      if (!mutations.replayTaskAllowed) return P.fail('XJ_PI_TASK_ID_REPLAY');
      mutationWarn.push('replay:' + input.taskId);
    }
    const snapshotHash = computeSnapshot(input.projection);
    if (!snapshotHash) return P.fail('XJ_PI_SNAPSHOT_MISMATCH', 'projection invalid (D1)');
    const task = {
      taskId: input.taskId, conversationId: input.conversationId || '', mode: input.mode,
      status: 'queued',
      clinicalContext: { clientId: input.projection.clientId, sessionId: input.projection.sessionId, snapshotHash },
      requestedBy: input.requestedBy || 'local-user', createdAt: input.createdAt || new Date().toISOString(),
    };
    tasks.set(task.taskId, { task, phase: 'INTAKE', resumePhase: null, savedObjectIds: [] });
    eventLog.append(task.taskId, 'task.created', { task, snapshotInput: input.projection, frozenSnapshotHash: snapshotHash });
    enterPhase(task.taskId, 'INTAKE');
    return { ok: true, task };
  }

  /** CONTEXT_CHECK：运行中重算 D1 投影；变化 → SNAPSHOT_MISMATCH（不静默刷新） */
  function contextCheck(taskId) {
    const rec = tasks.get(taskId);
    if (!rec) return P.fail('XJ_PI_TASK_NOT_FOUND');
    const w = writable(rec);
    if (P.isFail(w)) return w;
    enterPhase(taskId, 'CONTEXT_CHECK');
    if (liveProjection) {
      const current = computeSnapshot(liveProjection());
      if (!current || current !== rec.task.clinicalContext.snapshotHash) {
        rec.task.status = 'failed';
        eventLog.append(taskId, 'task.failed', { errorCode: 'XJ_PI_SNAPSHOT_MISMATCH' });
        return P.fail('XJ_PI_SNAPSHOT_MISMATCH', 'projection drifted since intake');
      }
    }
    return { ok: true };
  }

  /** PLAN：登记计划步骤 */
  function plan(taskId, steps) {
    const rec = tasks.get(taskId);
    if (!rec) return P.fail('XJ_PI_TASK_NOT_FOUND');
    const w = writable(rec);
    if (P.isFail(w)) return w;
    enterPhase(taskId, 'PLAN');
    rec.task.status = 'planning';
    rec.plan = steps;
    eventLog.append(taskId, 'plan.updated', { steps });
    return { ok: true };
  }

  /** TOOL_LOOP 单步：Read/Supervision/Command 经 brokers 分派；{ok:false} 原样返回 */
  function runToolStep(taskId, step) {
    const rec = tasks.get(taskId);
    if (!rec) return P.fail('XJ_PI_TASK_NOT_FOUND');
    const w = writable(rec);
    if (P.isFail(w)) return w;
    if (rec.task.status === 'paused') return P.fail('XJ_PI_WRITE_AFTER_CANCEL', 'task paused');
    enterPhase(taskId, 'TOOL_LOOP');
    rec.task.status = 'executing';
    const callId = P.nsec('call');
    let call = step;
    if (step && typeof step === 'object' && typeof step.legacyTool === 'string') {
      const mapped = mapLegacyTool(step.legacyTool, mutations);
      if (P.isFail(mapped)) return mapped;
      call = { callId, tool: mapped.tool, args: step.args || {} };
      if (mapped.warning) mutationWarn.push('legacy-writer:' + step.legacyTool);
    } else {
      call = { callId, tool: step.tool, args: step.args || {} };
    }
    eventLog.append(taskId, 'tool.call.requested', { callId, tool: call.tool });
    const result = brokers.dispatch(rec.task, call);
    eventLog.append(taskId, 'tool.call.result', { callId, ok: !P.isFail(result), errorCode: P.isFail(result) ? result.code : undefined });
    if (P.isFail(result)) return result;
    return { ok: true, callId, result };
  }

  /**
   * COMMIT：ClinicalActionRun propose→approval→durable→settle（全 await，不跳步）
   * high-risk：先请求 Approval；未决 → awaiting_confirmation 并返回 pending 标记；
   * 用户 resolve('approved') 后再次调用本函数完成 settle。
   */
  async function commitStep(taskId, targetRecord, fields) {
    const rec = tasks.get(taskId);
    if (!rec) return P.fail('XJ_PI_TASK_NOT_FOUND');
    const w = writable(rec);
    if (P.isFail(w)) return w;
    if (rec.task.status === 'paused') return P.fail('XJ_PI_WRITE_AFTER_CANCEL', 'task paused');
    if (mutations.disableApprovalGate) rec.pendingApprovalId = null; // 变异开关 M1：跳过 APPROVAL 分支（仅测试）
    if (rec.pendingApprovalId && !mutations.disableApprovalGate) {
      const apr = approvalBroker.of(rec.pendingApprovalId);
      if (!apr || apr.resolution === 'pending') {
        rec.task.status = 'awaiting_confirmation';
        return { ok: false, code: 'XJ_PI_APPROVAL_REQUIRED', pendingApprovalId: rec.pendingApprovalId, awaiting: true };
      }
      if (apr.resolution !== 'approved') {
        rec.task.status = 'paused'; // D3：rejected/timeout → 不写入，任务暂停可重试新确认卡
        eventLog.append(taskId, 'task.paused', { reason: 'approval-' + apr.resolution });
        return P.fail('XJ_PI_APPROVAL_REJECTED', 'approval ' + apr.resolution);
      }
      rec.pendingApprovalId = null; // 已批准 → 进入 COMMIT（settle 内 consumeApproved 消费）
    } else if (!mutations.disableApprovalGate) {
      enterPhase(taskId, 'APPROVAL');
      const apr = approvalBroker.request(taskId, 'clinical.write', 'high', '保存临床记录');
      if (P.isFail(apr)) return apr;
      rec.pendingApprovalId = apr.approval.approvalId;
      rec.task.status = 'awaiting_confirmation';
      return { ok: false, code: 'XJ_PI_APPROVAL_REQUIRED', pendingApprovalId: apr.approval.approvalId, awaiting: true };
    }
    enterPhase(taskId, 'COMMIT');
    rec.task.status = 'executing';
    const proposed = clinicalRun.propose(rec.task, 'clinical.commit.record', targetRecord, fields);
    if (P.isFail(proposed)) return proposed;
    const run = proposed.run;
    let settled;
    if (mutations.skipAwaitSettle) {
      // 变异开关：删除 await（不等待 settle 结果即继续；仅测试可观测的过早成功）
      mutationWarn.push('skip-await:' + taskId);
      clinicalRun.settle(rec.task, run, fields);
      enterPhase(taskId, 'VERIFY');
      enterPhase(taskId, 'RESPOND');
      rec.task.status = 'succeeded';
      rec.savedObjectIds.push('unsettled@' + run.runId);
      return { ok: true, run, premature: true };
    }
    settled = await clinicalRun.settle(rec.task, run, fields);
    if (P.isFail(settled) && settled.code === 'XJ_PI_APPROVAL_REQUIRED') {
      // 已批准但在消费时已过期（D3）：等同 timeout → 任务暂停，用户可重新确认
      rec.task.status = 'paused';
      eventLog.append(taskId, 'task.paused', { reason: 'approval-expired-at-consume' });
      return settled;
    }
    if (P.isFail(settled)) {
      rec.task.status = 'failed';
      eventLog.append(taskId, 'task.failed', { errorCode: settled.code });
      return settled;
    }
    enterPhase(taskId, 'VERIFY');
    if (mutations.swallowOkFalse) {
      // 变异开关 M2：durable 失败被吞后无回执可验 → 跳过 VERIFY 直接触发成功（仅测试可观察）
      mutationWarn.push('verify-skipped:' + taskId);
      eventLog.append(taskId, 'task.committed', { savedObjectIds: ['swallowed@' + run.runId] });
      enterPhase(taskId, 'RESPOND');
      rec.task.status = 'succeeded';
      return { ok: true, run, swallowed: true };
    }
    const verified = clinicalRun.verify(rec.task, run);
    if (P.isFail(verified)) {
      rec.task.status = 'failed';
      eventLog.append(taskId, 'task.failed', { errorCode: verified.code });
      return verified;
    }
    eventLog.append(taskId, 'task.committed', { savedObjectIds: [run.settleReceipt ? run.settleReceipt.savedObjectId : 'receiptless@' + run.runId] });
    rec.savedObjectIds.push(run.settleReceipt ? run.settleReceipt.savedObjectId : 'receiptless@' + run.runId);
    enterPhase(taskId, 'RESPOND');
    eventLog.append(taskId, 'task.responded', { savedObjectIds: rec.savedObjectIds.slice() });
    rec.task.status = 'succeeded';
    return { ok: true, run, savedObjectId: run.settleReceipt ? run.settleReceipt.savedObjectId : undefined };
  }

  /** 用户解决确认卡 */
  function resolveApproval(approvalId, resolution, by) {
    const r = approvalBroker.resolve(approvalId, resolution, by);
    const apr = approvalBroker.of(approvalId);
    if (apr) {
      const rec = tasks.get(apr.taskId);
      if (rec) {
        if (apr.resolution === 'approved' && rec.task.status === 'awaiting_confirmation') rec.task.status = 'executing';
        if (apr.resolution === 'timeout' && rec.task.status !== 'cancelled') {
          rec.task.status = 'paused'; // D3：超时 → paused（含过期后尝试批准的路径）
          eventLog.append(apr.taskId, 'task.paused', { reason: 'approval-timeout' });
        }
      }
    }
    return r;
  }

  function pause(taskId, reason) {
    const rec = tasks.get(taskId);
    if (!rec) return P.fail('XJ_PI_TASK_NOT_FOUND');
    if (isTerminal(rec.task.status)) return P.fail('XJ_PI_DUPLICATE_COMMIT', 'terminal');
    rec.resumePhase = rec.phase;
    rec.task.status = 'paused';
    eventLog.append(taskId, 'task.paused', { reason: reason || 'user' }, 'user');
    return { ok: true };
  }
  function resume(taskId) {
    const rec = tasks.get(taskId);
    if (!rec) return P.fail('XJ_PI_TASK_NOT_FOUND');
    if (rec.task.status === 'cancelled') return P.fail('XJ_PI_WRITE_AFTER_CANCEL', 'cancelled cannot resume'); // D3
    if (rec.task.status !== 'paused') return P.fail('XJ_PI_DUPLICATE_COMMIT', 'not paused');
    rec.task.status = 'executing';
    if (rec.resumePhase) enterPhase(taskId, rec.resumePhase);
    eventLog.append(taskId, 'task.resumed', {}, 'user');
    return { ok: true };
  }
  function cancel(taskId, reason) {
    const rec = tasks.get(taskId);
    if (!rec) return P.fail('XJ_PI_TASK_NOT_FOUND');
    if (isTerminal(rec.task.status)) return P.fail('XJ_PI_DUPLICATE_COMMIT', 'terminal');
    rec.task.status = 'cancelled';
    approvalBroker.invalidateAll(taskId); // D3：pending 全部失效
    eventLog.append(taskId, 'task.cancelled', { reason: reason || 'user' }, 'user');
    return { ok: true };
  }

  /** 错误恢复：failed 任务可重启为同 taskId 的新尝试？——契约：终态后只能新建 taskId；此处仅暴露诊断 */
  function diagnose(taskId) {
    const rec = tasks.get(taskId);
    if (!rec) return P.fail('XJ_PI_TASK_NOT_FOUND');
    return { ok: true, task: rec.task, phase: rec.phase, events: eventLog.of(taskId), savedObjectIds: rec.savedObjectIds, mutationWarn };
  }

  return Object.freeze({
    startTask, contextCheck, plan, runToolStep, commitStep,
    resolveApproval, pause, resume, cancel, diagnose,
    approvalBroker, brokers, clinicalRun, eventLog,
  });
}

module.exports = { createSupervisor };
