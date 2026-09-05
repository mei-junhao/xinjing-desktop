'use strict';
/**
 * pi-bridge-durable-adapter-v1.js — durable 绑定适配器（XJ-5.1.0-...-003）
 * 包装注入的 Store durable API；{ok:false}/超时/异常原样透传并经审计回调；
 * 不新建平行 writer：durableChannel 之外的任何写路径一律 XJ_PI_DIRECT_WRITE_DENIED。
 */
const P = require('../pi-protocol-v1.js');

/**
 * createDurableAdapter({ saveRecord, readRecord, audit, mutations })
 *   saveRecord: async (record) => {ok:true, savedObjectId, version}|{ok:false, code, ...}
 *   readRecord: (savedObjectId) => {ok:true, object}|{ok:false,...}
 *   audit: (entry) => void（可审计错误传播钩子；不得记敏感字段——record 由调用方保证脱敏）
 */
function createDurableAdapter(options) {
  const opts = options || {};
  const saveRecord = typeof opts.saveRecord === 'function' ? opts.saveRecord : null;
  const readRecord = typeof opts.readRecord === 'function' ? opts.readRecord : null;
  const audit = typeof opts.audit === 'function' ? opts.audit : () => {};
  const mutations = opts.mutations || {};
  const parallelStore = new Map(); // 变异开关 bypassDurableChannel 的旁路存储（仅测试可观察）

  if (!saveRecord) throw new Error('durable saveRecord channel required (no parallel writer allowed)');
  if (!readRecord) throw new Error('durable readRecord channel required');

  /** supervisor 的 durableWrite 注入点：异常归一为 {ok:false, XJ_PI_DIRECT_WRITE_DENIED/持久化失败码}，绝不吞掉 */
  async function durableWrite(record) {
    if (mutations.bypassDurableChannel) {
      // 变异开关：绕过注入的 durable API 走平行写入口（仅测试可观察）
      const id = 'bypassed_' + String(record.runId).slice(4, 12);
      parallelStore.set(id, { snapshotHash: record.snapshotHash, version: 1 });
      return { ok: true, savedObjectId: id, version: 1 };
    }
    let receipt = null;
    try {
      receipt = await saveRecord(record);
    } catch (e) {
      audit({ phase: 'durable-write', ok: false, code: 'XJ_PI_DIRECT_WRITE_DENIED', errorName: e && e.name });
      return P.fail('XJ_PI_DIRECT_WRITE_DENIED', 'durable channel threw');
    }
    if (!receipt || receipt.ok !== true) {
      if (!mutations.swallowOkFalse) {
        audit({ phase: 'durable-write', ok: false, code: (receipt && receipt.code) || 'XJ_PI_DIRECT_WRITE_DENIED' });
        return receipt || P.fail('XJ_PI_DIRECT_WRITE_DENIED', 'durable channel returned nothing');
      }
      audit({ phase: 'durable-write', ok: true, swallowed: true, via: 'mutation' });
      return { ok: true, savedObjectId: 'swallowed@' + String(record.runId).slice(4, 12), version: 0, swallowed: true }; // 变异开关：吞 {ok:false} 伪回执（仅测试）
    }
    if (typeof receipt.savedObjectId !== 'string' || !Number.isSafeInteger(receipt.version)) {
      return P.fail('XJ_PI_VERIFY_FAILED', 'durable receipt missing fields');
    }
    audit({ phase: 'durable-write', ok: true, savedObjectId: receipt.savedObjectId, version: receipt.version });
    return receipt;
  }

  function durableRead(savedObjectId) {
    if (mutations.bypassDurableChannel && parallelStore.has(savedObjectId)) {
      return { ok: true, object: parallelStore.get(savedObjectId) }; // 变异开关：旁路读（仅测试）
    }
    let back = null;
    try { back = readRecord(savedObjectId); } catch (e) {
      audit({ phase: 'durable-read', ok: false, code: 'XJ_PI_VERIFY_FAILED', errorName: e && e.name });
      return P.fail('XJ_PI_VERIFY_FAILED', 'durable read threw');
    }
    if (!back || back.ok !== true) {
      audit({ phase: 'durable-read', ok: false, code: (back && back.code) || 'XJ_PI_VERIFY_FAILED' });
      return back || P.fail('XJ_PI_VERIFY_FAILED');
    }
    return back;
  }

  /** 直写/旁路守卫：任何未走 durableChannel 的写（含旧 AgentCore writer 回退）一律拒绝 */
  function directWriteGuard() {
    if (mutations.legacyWriterFallback) return { ok: true, via: 'legacy-writer', warning: 'MUTATION' };
    return P.fail('XJ_PI_DIRECT_WRITE_DENIED');
  }

  return Object.freeze({ durableWrite, durableRead, directWriteGuard });
}

module.exports = { createDurableAdapter };
