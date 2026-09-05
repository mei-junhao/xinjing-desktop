'use strict';
/**
 * pi-approval-v1.js — Approval Broker（裁决 D3）
 * 5 分钟有效期（时钟注入）；timeout→rejected 且永久失效并使任务进入 paused；
 * 单次有效 + scope 绑定；task.cancelled 使全部 pending 立即失效；恢复界面不能把 rejected/timeout 变 approved。
 */
const P = require('./pi-protocol-v1.js');

/**
 * createApprovalBroker({ clock, eventLog, isTaskCancelled })
 *   clock: () => ms（默认 Date.now；测试注入）
 *   eventLog: pi-event-log-v1 实例
 *   isTaskCancelled: (taskId) => boolean（Supervisor 提供取消态）
 */
function createApprovalBroker(options) {
  const opts = options || {};
  const clock = typeof opts.clock === 'function' ? opts.clock : () => Date.now();
  const eventLog = opts.eventLog;
  const isTaskCancelled = typeof opts.isTaskCancelled === 'function' ? opts.isTaskCancelled : () => false;
  const approvals = new Map(); // approvalId -> {…, expiresAt, used}
  const mutations = opts.mutations || {}; // 仅测试：命名变异开关

  function request(taskId, scope, risk, reason) {
    if (typeof taskId !== 'string' || !taskId) return P.fail('XJ_PI_TASK_NOT_FOUND');
    if (isTaskCancelled(taskId)) return P.fail('XJ_PI_WRITE_AFTER_CANCEL');
    const now = clock();
    const apr = {
      approvalId: P.nsec('apr'), taskId, scope, risk,
      requestedBy: 'pi', resolution: 'pending', resolvedBy: null, resolvedAt: null,
      requestedAtMs: now, expiresAtMs: now + P.APPROVAL_TIMEOUT_MS, // D3：过期时间入账
      used: false,
    };
    approvals.set(apr.approvalId, apr);
    if (eventLog) eventLog.append(taskId, 'approval.requested', { approvalId: apr.approvalId, scope, risk, reason: reason || '', expiresAtMs: apr.expiresAtMs });
    return { ok: true, approval: apr };
  }

  function resolve(approvalId, resolution, by) {
    const apr = approvals.get(approvalId);
    if (!apr || apr.resolution !== 'pending') return P.fail('XJ_PI_APPROVAL_REQUIRED', 'approval not pending');
    if (by === 'pi') return P.fail('XJ_PI_APPROVAL_REQUIRED', 'pi cannot self-approve');
    if (isTaskCancelled(apr.taskId)) return P.fail('XJ_PI_WRITE_AFTER_CANCEL');
    // D3：过期后不可被 approved（界面恢复也不行）；timeout 由 checkTimeouts 显式触发
    if (!mutations.bypassApprovalTimeout && clock() > apr.expiresAtMs) {
      apr.resolution = 'timeout'; apr.resolvedAt = new Date().toISOString();
      if (eventLog) eventLog.append(apr.taskId, 'approval.timeout', { approvalId, resolution: 'timeout' });
      return P.fail('XJ_PI_APPROVAL_REJECTED', 'approval expired');
    }
    apr.resolution = resolution === 'approved' ? 'approved' : 'rejected';
    apr.resolvedBy = by || 'local-user';
    apr.resolvedAt = new Date().toISOString();
    if (eventLog) eventLog.append(apr.taskId, 'approval.resolved', { approvalId, resolution: apr.resolution, by: apr.resolvedBy });
    return { ok: true, approval: apr };
  }

  /** 推进时钟扫描：把已过期 pending 置 timeout（等同 rejected，永久失效）并逐条入账 */
  function checkTimeouts() {
    const timedOut = [];
    const now = clock();
    for (const apr of approvals.values()) {
      if (apr.resolution === 'pending' && now > apr.expiresAtMs) {
        apr.resolution = 'timeout';
        apr.resolvedAt = new Date().toISOString();
        if (eventLog) eventLog.append(apr.taskId, 'approval.timeout', { approvalId: apr.approvalId, resolution: 'timeout' });
        timedOut.push(apr);
      }
    }
    return timedOut;
  }

  /** 取一个可用于 (taskId, scope) 的已批准 approval：单次有效，用后即焚 */
  function consumeApproved(taskId, scope) {
    for (const apr of approvals.values()) {
      if (apr.taskId === taskId && apr.scope === scope && apr.resolution === 'approved' && !apr.used) {
        if (!mutations.bypassApprovalTimeout && clock() > apr.expiresAtMs) continue; // 批准后仍可能过期
        apr.used = true;
        return { ok: true, approval: apr };
      }
    }
    return P.fail('XJ_PI_APPROVAL_REQUIRED');
  }

  /** task.cancelled：该任务全部 pending 立即失效（D3） */
  function invalidateAll(taskId) {
    for (const apr of approvals.values()) {
      if (apr.taskId === taskId && apr.resolution === 'pending') {
        apr.resolution = 'rejected';
        apr.resolvedBy = 'system:cancelled';
        apr.resolvedAt = new Date().toISOString();
      }
    }
  }

  function pendingOf(taskId) { return [...approvals.values()].filter((a) => a.taskId === taskId && a.resolution === 'pending'); }
  function of(approvalId) { return approvals.get(approvalId); }

  return Object.freeze({ request, resolve, checkTimeouts, consumeApproved, invalidateAll, pendingOf, of });
}

module.exports = { createApprovalBroker };
