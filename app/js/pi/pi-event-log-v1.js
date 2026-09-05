'use strict';
/**
 * pi-event-log-v1.js — 事件信封 v1（taskId 内 seq 严格递增；未知事件/版本/字段 fail-closed；支持重放校验）
 */
const P = require('./pi-protocol-v1.js');

function createEventLog(options) {
  const mutations = (options && options.mutations) || {}; // 仅测试：命名变异开关
  const logs = new Map(); // taskId -> events[]

  /** 追加事件（严格校验；失败原样返回 {ok:false}，不落账） */
  function append(taskId, type, payload, actor) {
    if (typeof taskId !== 'string' || !taskId) return P.fail('XJ_PI_TASK_NOT_FOUND');
    if (!P.EVENT_TYPES.includes(type)) {
      if (mutations.allowUnknownEvent) {
        // 变异开关：未知事件放行（仅测试可观测）
      } else return P.fail('XJ_PI_UNKNOWN_EVENT');
    }
    if (!mutations.allowUnknownField && payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) return P.fail('XJ_PI_UNKNOWN_FIELD');
    const list = logs.get(taskId) || [];
    const ev = {
      v: P.PROTOCOL_VERSION,
      taskId,
      seq: list.length + 1,
      at: new Date().toISOString(),
      actor: actor || 'pi',
      type,
      payload: payload || {},
    };
    list.push(ev);
    logs.set(taskId, list);
    return { ok: true, event: ev };
  }

  /** 重放一条外部事件（恢复/审计路径）：版本、type、seq 连续性全部校验，任何不一致 fail-closed */
  function replay(taskId, ev) {
    if (!ev || typeof ev !== 'object') return P.fail('XJ_PI_UNKNOWN_FIELD');
    if (!P.hasOnlyKeys(ev, ['v', 'taskId', 'seq', 'at', 'actor', 'type', 'payload'])) {
      if (!mutations.allowUnknownField) return P.fail('XJ_PI_UNKNOWN_FIELD');
    }
    if (ev.v !== P.PROTOCOL_VERSION) return P.fail('XJ_PI_EVENT_VERSION');
    if (ev.taskId !== taskId) return P.fail('XJ_PI_TASK_NOT_FOUND');
    if (!P.EVENT_TYPES.includes(ev.type)) {
      if (!mutations.allowUnknownEvent) return P.fail('XJ_PI_UNKNOWN_EVENT');
    }
    const list = logs.get(taskId) || [];
    const expectSeq = list.length + 1;
    if (!Number.isSafeInteger(ev.seq) || ev.seq < 1 || ev.seq !== expectSeq) {
      if (!mutations.seqRegressionAllowed) return P.fail('XJ_PI_EVENT_SEQ'); // seq 倒退/跳跃 = 拒绝
    }
    list.push(Object.assign({}, ev));
    logs.set(taskId, list);
    return { ok: true, event: ev };
  }

  function of(taskId) { return (logs.get(taskId) || []).slice(); }
  function count(taskId) { return (logs.get(taskId) || []).length; }

  return Object.freeze({ append, replay, of, count });
}

module.exports = { createEventLog };
