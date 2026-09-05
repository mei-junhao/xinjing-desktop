'use strict';
/**
 * pi-bridge-event-store-v1.js — 事件日志持久化 + 单写者队列 + 重启 replay（XJ-5.1.0-...-003）
 * JSONL 追加落盘（userData 内）；启动时逐条 replay 校验（版本/type/seq/字段 fail-closed，坏行即停）；
 * append 串行化：并发提交按完成序入队，seq 由队内严格递增分配——并发冲突不可能静默发生。
 * 自包含实现（不修改已钉住 SHA 的 002 文件；校验规则与 pi-event-log-v1 等价）。
 */
const fs = require('fs');
const path = require('path');
const P = require('../pi-protocol-v1.js');

const ENVELOPE_KEYS = ['v', 'taskId', 'seq', 'at', 'actor', 'type', 'payload'];

/**
 * createEventStore({ file, mutations }) — file: 绝对路径 JSONL
 */
function createEventStore(options) {
  const opts = options || {};
  const file = String(opts.file || '');
  const mutations = opts.mutations || {};
  if (!path.isAbsolute(file)) throw new Error('event store file must be absolute');
  const byTask = new Map(); // taskId -> events[]
  let chain = Promise.resolve(); // 单写者队列

  function nextSeq(taskId) { return (byTask.get(taskId) || []).length + 1; }
  function pushMem(taskId, ev) {
    const list = byTask.get(taskId) || [];
    list.push(ev);
    byTask.set(taskId, list);
  }

  /** 串行 append：所有调用逐个排队；队内 seq 严格递增（并发调用不可能拿到相同 seq） */
  function append(taskId, type, payload, actor) {
    if (mutations.concurrentSeq) {
      // 变异开关：绕过单写者队列——异步交错中先取 seq 后入账（并发冲突可观察 = 仅测试）
      return (async () => {
        const seqTaken = nextSeq(taskId);
        await Promise.resolve(); // 交错点：并发调用都在此读到同一 nextSeq
        const ev = { v: P.PROTOCOL_VERSION, taskId, seq: seqTaken, at: new Date().toISOString(), actor: actor || 'pi', type, payload: payload || {} };
        try { if (!mutations.skipPersist) fs.appendFileSync(file, JSON.stringify(ev) + '\n', 'utf8'); } catch (e) { return P.fail('XJ_PI_EVENT_VERSION', 'persist failed'); }
        pushMem(taskId, ev);
        return { ok: true, event: ev };
      })();
    }
    const run = chain.then(() => {
      if (typeof taskId !== 'string' || !taskId) return P.fail('XJ_PI_TASK_NOT_FOUND');
      if (!P.EVENT_TYPES.includes(type)) return P.fail('XJ_PI_UNKNOWN_EVENT');
      if (!mutations.allowUnknownField && payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) return P.fail('XJ_PI_UNKNOWN_FIELD');
      const ev = { v: P.PROTOCOL_VERSION, taskId, seq: nextSeq(taskId), at: new Date().toISOString(), actor: actor || 'pi', type, payload: payload || {} };
      if (!mutations.skipPersist) {
        try { fs.appendFileSync(file, JSON.stringify(ev) + '\n', 'utf8'); }
        catch (e) { return P.fail('XJ_PI_EVENT_VERSION', 'persist failed: ' + String(e && e.message).slice(0, 80)); }
      }
      pushMem(taskId, ev);
      return { ok: true, event: ev };
    });
    chain = run.catch(() => undefined);
    return run;
  }

  /** 启动/重启恢复：逐行 replay（v1 严格校验；坏行 fail-closed 停止载入） */
  function replayAll() {
    if (!fs.existsSync(file)) return { ok: true, count: 0 };
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let ev = null;
      try { ev = JSON.parse(line); } catch (e) {
        if (!mutations.skipReplayValidation) return P.fail('XJ_PI_EVENT_VERSION', 'corrupt line ' + (i + 1));
        continue; // 变异开关：坏行静默跳过照常 ok（重启读坏日志不 fail-closed = 仅测试可观察）
      }
      if (!mutations.skipReplayValidation) {
        if (!ev || typeof ev !== 'object' || !P.hasOnlyKeys(ev, ENVELOPE_KEYS)) return P.fail('XJ_PI_UNKNOWN_FIELD', 'replay line ' + (i + 1));
        if (ev.v !== P.PROTOCOL_VERSION) return P.fail('XJ_PI_EVENT_VERSION', 'replay line ' + (i + 1));
        if (typeof ev.taskId !== 'string' || !ev.taskId) return P.fail('XJ_PI_TASK_NOT_FOUND', 'replay line ' + (i + 1));
        if (!P.EVENT_TYPES.includes(ev.type)) return P.fail('XJ_PI_UNKNOWN_EVENT', 'replay line ' + (i + 1));
        if (!Number.isSafeInteger(ev.seq) || ev.seq !== nextSeq(ev.taskId)) return P.fail('XJ_PI_EVENT_SEQ', 'replay line ' + (i + 1));
      }
      pushMem(ev.taskId, ev);
      count += 1;
    }
    return { ok: true, count };
  }

  function of(taskId) { return (byTask.get(taskId) || []).slice(); }
  function count(taskId) { return (byTask.get(taskId) || []).length; }

  return Object.freeze({ append, replayAll, of, count });
}

module.exports = { createEventStore };
