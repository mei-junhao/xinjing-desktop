'use strict';
// 006 fixture 测试：合成 Store durable stub（正向/失败/重启回放）；不访问真实 IndexedDB/文件/网络
const assert = require('assert');
const { createClinicalTransactionBridge, ERR } = require('D:/xinjing-electron/app/js/pi/clinical/clinical-transaction-bridge.js');

function makeStore() {
  const recs = new Map(); let n = 0;
  return {
    recs, n: () => n,
    write(record) {
      if (record.failNext === true) { record.failNext = false; return { ok: false, code: ERR.DURABLE_FAILED, message: 'stub-fail' }; }
      const id = 'sobj_' + (++n);
      const saved = { savedObjectId: id, version: 1, savedAt: 1000 + n, clientId: record.clientId, sessionId: record.sessionId, snapshotHash: record.snapshotHash, sourceRefs: record.sourceRefs, fields: record.fields, generationEntitlement: record.generationEntitlement, recordType: record.recordType };
      recs.set(id, saved);
      return { ok: true, savedObjectId: id, version: 1, savedAt: saved.savedAt };
    },
    read(id) { const r = recs.get(id); return r ? r : { ok: false, code: 'XJ_PI_NOT_FOUND' }; },
    snapshot() { return JSON.parse(JSON.stringify([...recs.entries()])); },
  };
}
function restore(snap) { const recs = new Map(snap); const n = recs.size; return { recs, n: () => n, write: ()=>({ok:false,code:'readonly'}), read(id){ const r=recs.get(id); return r?r:{ok:false,code:'XJ_PI_NOT_FOUND'}; }, snapshot(){ return JSON.parse(JSON.stringify([...recs.entries()])); } }; }
function ctx() { return { clientId:'c1', sessionId:'s1', taskId:'task1', snapshotHash:'sha256:'+'a'.repeat(64), sourceRefs:[{sourceId:'src1', sourceContentHash:'sha256:'+'b'.repeat(64)}], generationEntitlement:'paid' }; }
const R = []; function t(name, fn){ try{ fn(); R.push(true); console.log('PASS',name); }catch(e){ R.push(false); console.log('FAIL',name,'::',e.message); } }

t('F1 正向 durable stub 写入+回读', () => {
  const st = makeStore();
  const b = createClinicalTransactionBridge({ durableWrite: st.write, durableRead: st.read, sessionBelongsToClient: ()=>true });
  const beg = b.begin(ctx()); const runId = beg.clinicalActionRunId;
  b.draft.append(runId, { text: 'note', entryType: 'subjective' }); b.commit.record(runId); b.approval.approve(runId);
  const dw = b.commit.durable(runId); assert.ok(dw.ok);
  const v = b.verify(dw.savedObjectId); assert.ok(v.ok && v.verified);
  assert.strictEqual(st.n(), 1);
});
t('F2 失败 stub {ok:false} 原样传播', () => {
  const b = createClinicalTransactionBridge({ durableWrite: ()=>({ok:false, code: ERR.DURABLE_FAILED, message:'stub-fail'}), durableRead: ()=>({ok:false}) });
  const beg = b.begin(ctx()); const runId = beg.clinicalActionRunId;
  b.draft.append(runId, { text: 'note', entryType: 'subjective' }); b.commit.record(runId); b.approval.approve(runId);
  const dw = b.commit.durable(runId); assert.strictEqual(dw.ok, false); assert.strictEqual(dw.code, ERR.DURABLE_FAILED);
});
t('F3 重启回放：store 快照重建 bridge 后回读核对', () => {
  const st = makeStore();
  const b1 = createClinicalTransactionBridge({ durableWrite: st.write, durableRead: st.read, sessionBelongsToClient: ()=>true });
  const beg = b1.begin(ctx()); const runId = beg.clinicalActionRunId;
  b1.draft.append(runId, { text: 'note', entryType: 'subjective' }); b1.commit.record(runId); b1.approval.approve(runId);
  const dw = b1.commit.durable(runId); assert.ok(dw.ok);
  // "重启"：用 store 快照重建
  const st2 = restore(st.snapshot());
  const b2 = createClinicalTransactionBridge({ durableWrite: st2.write, durableRead: st2.read, sessionBelongsToClient: ()=>true });
  const v = b2.verify(dw.savedObjectId, { clientId:'c1', sessionId:'s1', snapshotHash:'sha256:'+'a'.repeat(64), version:1 });
  assert.ok(v.ok && v.verified);
});
t('F4 重启后回读漂移 fail-closed', () => {
  const st = makeStore();
  const b1 = createClinicalTransactionBridge({ durableWrite: st.write, durableRead: st.read, sessionBelongsToClient: ()=>true });
  const beg = b1.begin(ctx()); const runId = beg.clinicalActionRunId;
  b1.draft.append(runId, { text: 'note', entryType: 'subjective' }); b1.commit.record(runId); b1.approval.approve(runId);
  const dw = b1.commit.durable(runId); assert.ok(dw.ok);
  const snap = st.snapshot();
  snap[0][1].snapshotHash = 'sha256:' + 'c'.repeat(64); // 漂移
  const st2 = restore(snap);
  const b2 = createClinicalTransactionBridge({ durableWrite: st2.write, durableRead: st2.read, sessionBelongsToClient: ()=>true });
  const v = b2.verify(dw.savedObjectId, { clientId:'c1', sessionId:'s1', snapshotHash:'sha256:'+'a'.repeat(64), version:1 });
  assert.strictEqual(v.code, ERR.VERIFY_MISMATCH);
});
t('F5 不访问真实存储：durable stub 仅内存', () => {
  const st = makeStore();
  const b = createClinicalTransactionBridge({ durableWrite: st.write, durableRead: st.read });
  assert.strictEqual(typeof b.verify, 'function');
  assert.strictEqual(st.recs.size, 0); // 未写任何东西
});

const fail = R.filter(x=>!x).length;
console.log('FIXTURE ' + (R.length-fail) + '/' + R.length + ' PASS');
process.exit(fail === 0 ? 0 : 1);
