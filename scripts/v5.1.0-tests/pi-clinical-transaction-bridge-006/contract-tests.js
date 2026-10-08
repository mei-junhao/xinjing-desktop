'use strict';
// 006 契约测试（正向）：draft/preview/approval/durable/verify/幂等/取消/错误传播/entitlement
const assert = require('assert');
const { createClinicalTransactionBridge, ERR } = require('D:/xinjing-electron/app/js/pi/clinical/clinical-transaction-bridge.js');

let seq = 0;
function memDurable() {
  const store = new Map(); let saved = 0;
  return {
    store,
    write(record) {
      if (record && record.forceFail) return { ok: false, code: ERR.DURABLE_FAILED, message: 'forced' };
      const id = 'obj_' + (++saved);
      const rec = { savedObjectId: id, version: 1, savedAt: Date.now(), clientId: record.clientId, sessionId: record.sessionId, snapshotHash: record.snapshotHash, sourceRefs: record.sourceRefs, recordType: record.recordType, fields: record.fields, generationEntitlement: record.generationEntitlement };
      store.set(id, rec);
      return { ok: true, savedObjectId: id, version: 1, savedAt: rec.savedAt };
    },
    read(id) { return store.get(id) || { ok: false, code: 'XJ_PI_NOT_FOUND' }; },
  };
}
const R = []; function t(name, fn) { try { fn(); R.push(true); console.log('PASS', name); } catch (e) { R.push(false); console.log('FAIL', name, '::', e.message); } }
function ctxOf(over) { return Object.assign({ clientId: 'c1', sessionId: 's1', taskId: 'task1', snapshotHash: 'sha256:' + 'a'.repeat(64), sourceRefs: [{ sourceId: 'src1', sourceVersion: 'v1', sourceContentHash: 'sha256:' + 'b'.repeat(64) }], generationEntitlement: 'paid' }, over || {}); }

// 1. context 绑定校验
t('C1 client-session mismatch', () => {
  const b = createClinicalTransactionBridge({ durableWrite: ()=>({ok:true,savedObjectId:'x',version:1,savedAt:1}), durableRead: ()=>({ok:false}), sessionBelongsToClient: (c,s) => c==='c1' && s==='s1' });
  const r = b.begin(ctxOf({ sessionId: 's-other' }));
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, ERR.CLIENT_SESSION_MISMATCH);
});
t('C2 snapshotHash required sha256', () => {
  const b = createClinicalTransactionBridge({});
  const r = b.begin(ctxOf({ snapshotHash: 'not-a-hash' }));
  assert.strictEqual(r.code, ERR.INVALID_CONTEXT);
});
t('C3 sourceRefs disallowed key -> snapshot mismatch', () => {
  const b = createClinicalTransactionBridge({});
  const r = b.begin(ctxOf({ sourceRefs: [{ sourceId: 'src1', evilKey: 'x' }] }));
  assert.strictEqual(r.code, ERR.SNAPSHOT_MISMATCH);
});
t('C4 sourceRefs missing sourceId -> snapshot mismatch', () => {
  const b = createClinicalTransactionBridge({});
  const r = b.begin(ctxOf({ sourceRefs: [{ sourceVersion: 'v1' }] }));
  assert.strictEqual(r.code, ERR.SNAPSHOT_MISMATCH);
});
t('C5 entitlement enum', () => {
  const b = createClinicalTransactionBridge({});
  const r = b.begin(ctxOf({ generationEntitlement: 'gold' }));
  assert.strictEqual(r.code, ERR.INVALID_CONTEXT);
});

// 2. draft -> preview -> approval -> durable -> verify 全链路
t('C6 full happy path', () => {
  const d = memDurable();
  const b = createClinicalTransactionBridge({ durableWrite: d.write, durableRead: d.read, sessionBelongsToClient: (c,s)=>c==='c1'&&s==='s1' });
  const beg = b.begin(ctxOf());
  assert.ok(beg.ok); const runId = beg.clinicalActionRunId;
  assert.ok(beg.audit.clinicalActionRunId === runId);
  assert.ok(beg.audit.generationEntitlement === 'paid');
  const ap1 = b.draft.append(runId, { text: 'hello', entryType: 'subjective' });
  assert.ok(ap1.ok && ap1.draftOnly === true);
  const cm = b.commit.record(runId);
  assert.ok(cm.ok); assert.ok(cm.preview.immutable); assert.ok(cm.scope === 'clinical.write');
  assert.ok(cm.preview.snapshotHash === 'sha256:' + 'a'.repeat(64));
  const apr = b.approval.approve(runId); assert.ok(apr.ok);
  const dw = b.commit.durable(runId); assert.ok(dw.ok); assert.ok(dw.savedObjectId); assert.strictEqual(dw.version, 1);
  const v = b.verify(dw.savedObjectId); assert.ok(v.ok && v.verified);
  const st = b.status(runId); assert.strictEqual(st.status, 'succeeded'); assert.strictEqual(st.settled, true);
});

// 3. approval fail-closed
t('C7 durable before approval -> approval required', () => {
  const d = memDurable();
  const b = createClinicalTransactionBridge({ durableWrite: d.write, durableRead: d.read, sessionBelongsToClient: ()=>true });
  const beg = b.begin(ctxOf()); const runId = beg.clinicalActionRunId;
  b.draft.append(runId, { text: 'x' }); b.commit.record(runId);
  const dw = b.commit.durable(runId);
  assert.strictEqual(dw.ok, false); assert.strictEqual(dw.code, ERR.APPROVAL_REQUIRED);
});
t('C8 approval rejected -> rejected', () => {
  const d = memDurable();
  const b = createClinicalTransactionBridge({ durableWrite: d.write, durableRead: d.read });
  const beg = b.begin(ctxOf()); const runId = beg.clinicalActionRunId;
  b.draft.append(runId, { text: 'x' }); b.commit.record(runId);
  b.approval.reject(runId);
  const dw = b.commit.durable(runId);
  assert.strictEqual(dw.code, ERR.APPROVAL_REJECTED);
});

// 4. durable {ok:false} 原样传播
t('C9 durable write {ok:false} propagates', () => {
  const b = createClinicalTransactionBridge({ durableWrite: ()=>({ok:false, code: ERR.DURABLE_FAILED, message:'boom'}), durableRead: ()=>({ok:false}) });
  const beg = b.begin(ctxOf()); const runId = beg.clinicalActionRunId;
  b.draft.append(runId, { text: 'x' }); b.commit.record(runId); b.approval.approve(runId);
  const dw = b.commit.durable(runId);
  assert.strictEqual(dw.ok, false); assert.strictEqual(dw.code, ERR.DURABLE_FAILED); assert.strictEqual(dw.message, 'boom');
});

// 5. 幂等
t('C10 duplicate commit', () => {
  const d = memDurable();
  const b = createClinicalTransactionBridge({ durableWrite: d.write, durableRead: d.read });
  const beg = b.begin(ctxOf()); const runId = beg.clinicalActionRunId;
  b.draft.append(runId, { text: 'x' }); b.commit.record(runId); b.approval.approve(runId);
  const dw = b.commit.durable(runId); assert.ok(dw.ok);
  b.verify(dw.savedObjectId);
  const dup = b.commit.durable(runId);
  assert.strictEqual(dup.code, ERR.DUPLICATE_COMMIT);
});

// 6. 取消后写入
t('C11 write after cancel', () => {
  const d = memDurable();
  const b = createClinicalTransactionBridge({ durableWrite: d.write, durableRead: d.read });
  const beg = b.begin(ctxOf()); const runId = beg.clinicalActionRunId;
  b.draft.append(runId, { text: 'x' }); b.commit.record(runId); b.approval.approve(runId);
  b.cancel(runId);
  const dw = b.commit.durable(runId);
  assert.strictEqual(dw.code, ERR.WRITE_AFTER_CANCEL);
});

// 7. 回读漂移
t('C12 verify snapshot drift', () => {
  const d = memDurable();
  const b = createClinicalTransactionBridge({ durableWrite: d.write, durableRead: d.read });
  const beg = b.begin(ctxOf()); const runId = beg.clinicalActionRunId;
  b.draft.append(runId, { text: 'x' }); b.commit.record(runId); b.approval.approve(runId);
  const dw = b.commit.durable(runId); assert.ok(dw.ok);
  const rec = d.store.get(dw.savedObjectId); rec.snapshotHash = 'sha256:' + 'c'.repeat(64);
  const v = b.verify(dw.savedObjectId);
  assert.strictEqual(v.code, ERR.VERIFY_MISMATCH);
});

// 8. durable throw -> failed 状态（不自动重试）
t('C13 durable throw -> failed', () => {
  const b = createClinicalTransactionBridge({ durableWrite: ()=>{ throw new Error('db down'); }, durableRead: ()=>({ok:false}) });
  const beg = b.begin(ctxOf()); const runId = beg.clinicalActionRunId;
  b.draft.append(runId, { text: 'x' }); b.commit.record(runId); b.approval.approve(runId);
  const dw = b.commit.durable(runId);
  assert.strictEqual(dw.code, ERR.DURABLE_FAILED);
  const st = b.status(runId); assert.strictEqual(st.status, 'failed');
});

const fail = R.filter(x=>!x).length;
console.log('CONTRACT ' + (R.length - fail) + '/' + R.length + ' PASS');
process.exit(fail === 0 ? 0 : 1);
