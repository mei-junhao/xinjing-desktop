'use strict';
const fs = require('fs');
const ADAPTER = 'D:/xinjing-electron/app/js/pi/clinical/clinical-transaction-bridge.js';
const MUTANT = 'D:/xinjing-electron/app/js/pi/clinical/__mutant_tmp.js';
const base = fs.readFileSync(ADAPTER, 'utf8');
function load(mutated) { fs.writeFileSync(MUTANT, mutated); delete require.cache[require.resolve(MUTANT)]; return require(MUTANT); }
function cleanup() { try { fs.unlinkSync(MUTANT); } catch (e) {} }
function rep(s, old, neu) { return s.split(old).join(neu); }
function ctx(over) { return Object.assign({ clientId:'c1', sessionId:'s1', taskId:'t1', snapshotHash:'sha256:'+'a'.repeat(64), sourceRefs:[{sourceId:'src1', sourceContentHash:'sha256:'+'b'.repeat(64)}], generationEntitlement:'manual' }, over||{}); }
function happy(createBridge) {
  const store = new Map(); let n=0;
  const b = createBridge({ durableWrite(r){ const id='o'+(++n); store.set(id,{savedObjectId:id,version:1,savedAt:1,clientId:r.clientId,sessionId:r.sessionId,snapshotHash:r.snapshotHash,sourceRefs:r.sourceRefs,fields:r.fields,generationEntitlement:r.generationEntitlement}); return {ok:true,savedObjectId:id,version:1,savedAt:1}; }, durableRead(id){ return store.get(id)||{ok:false}; }, sessionBelongsToClient:(c,s)=>c==='c1'&&s==='s1' });
  return { b, store };
}
const R = []; function rec(id, killed, det){ R.push(killed); console.log((killed?'KILLED ':'SURVIVOR ')+id+' :: '+det); }

(function(){
  const m = rep(base, "if (ap.status !== 'approved') return bad(ERR.APPROVAL_REQUIRED, 'approval not approved');", "/* mutated M1 */");
  const mod = load(m); const h = happy(mod.createClinicalTransactionBridge);
  const beg = h.b.begin(ctx()); const runId = beg.clinicalActionRunId;
  h.b.draft.append(runId,{text:'x'}); h.b.commit.record(runId);
  const dw = h.b.commit.durable(runId);
  rec('M1-delete-approval-gate', dw.ok === true, '未 approve 却 durable 成功');
})();

(function(){
  const m = rep(base, "dw = durableWrite(record);", "globalThis.__store_direct = record; dw = { ok:true, savedObjectId:'direct', version:1, savedAt:1 };");
  const mod = load(m); const h = happy(mod.createClinicalTransactionBridge);
  const beg = h.b.begin(ctx()); const runId = beg.clinicalActionRunId;
  h.b.draft.append(runId,{text:'x'}); h.b.commit.record(runId); h.b.approval.approve(runId);
  const dw = h.b.commit.durable(runId);
  rec('M2-direct-store-writer', dw.ok === true && globalThis.__store_direct, '绕过注入 durableWrite 直接写');
  delete globalThis.__store_direct;
})();

(function(){
  const m = rep(base, "return dw; // {ok:false} 原样传播", "dw = { ok:true, savedObjectId:'fake', version:1, savedAt:1 };");
  const mod = load(m);
  const b = mod.createClinicalTransactionBridge({ durableWrite:()=>({ok:false,code:'XJ_PI_DURABLE_FAILED',message:'boom'}), durableRead:()=>({ok:false}) });
  const beg = b.begin(ctx()); const runId = beg.clinicalActionRunId;
  b.draft.append(runId,{text:'x'}); b.commit.record(runId); b.approval.approve(runId);
  const dw = b.commit.durable(runId);
  rec('M3-swallow-ok-false', dw && dw.ok === true, 'durableWrite {ok:false} 被吞仍成功');
})();

(function(){
  const m = rep(base, "if (sessionBelongs && sessionBelongs(clientId, sessionId) === false) return bad(ERR.CLIENT_SESSION_MISMATCH, 'session does not belong to client');", "/* mutated M4 */");
  const mod = load(m); const h = happy(mod.createClinicalTransactionBridge);
  const r = h.b.begin(ctx({ sessionId: 's-other' }));
  rec('M4-forge-client-session', r.ok === true, '伪造 session 却通过');
})();

(function(){
  const m = rep(base, "for (const s of srcs) {", "if (false) for (const s of srcs) {");
  const mod = load(m); const h = happy(mod.createClinicalTransactionBridge);
  const r = h.b.begin(ctx({ sourceRefs: [{ sourceId:'x', evil:'y' }] }));
  rec('M5-cross-source-ref', r.ok === true, '非法 sourceRef 却通过');
})();

(function(){
  const m = rep(rep(base, "if (!clientId || !sessionId || !snapshotHash) return bad(ERR.INVALID_CONTEXT, 'clientId/sessionId/snapshotHash required');", "/* mutated M6a */"), "if (!isSha256Like(snapshotHash)) return bad(ERR.INVALID_CONTEXT, 'snapshotHash must be sha256');", "/* mutated M6b */");
  const mod = load(m); const h = happy(mod.createClinicalTransactionBridge);
  const r = h.b.begin(ctx({ snapshotHash: '' }));
  rec('M6-skip-snapshotHash', r.ok === true, '无 snapshotHash 却通过');
})();

(function(){
  const m = rep(base, "if (expected.snapshotHash && dr.snapshotHash !== expected.snapshotHash) return bad(ERR.VERIFY_MISMATCH, 'snapshot hash drift');", "/* mutated M7 */");
  const mod = load(m);
  const store = new Map(); store.set('o1', { savedObjectId:'o1', version:1, savedAt:1, clientId:'c1', sessionId:'s1', snapshotHash:'sha256:'+'c'.repeat(64), fields:[] });
  const b = mod.createClinicalTransactionBridge({ durableWrite:()=>({ok:true,savedObjectId:'o1',version:1}), durableRead(id){ return store.get(id)||{ok:false}; } });
  const v = b.verify('o1', { snapshotHash:'sha256:'+'a'.repeat(64), clientId:'c1', sessionId:'s1' });
  rec('M7-skip-readback-verify', v.ok === true, 'snapshotHash 漂移却 verify ok');
})();

(function(){
  const m = rep(base, "if (!dw || !dw.savedObjectId) return bad(ERR.DURABLE_FAILED, 'durable write must return savedObjectId');", "if (!dw) return bad(ERR.DURABLE_FAILED,'dw required');");
  const mod = load(m);
  const b = mod.createClinicalTransactionBridge({ durableWrite:()=>({ok:true,version:1,savedAt:1}), durableRead:()=>({ok:false}) });
  const beg = b.begin(ctx()); const runId = beg.clinicalActionRunId;
  b.draft.append(runId,{text:'x'}); b.commit.record(runId); b.approval.approve(runId);
  const dw = b.commit.durable(runId);
  rec('M8-forge-savedObjectId', dw.ok === true, '无 savedObjectId 却 durable 成功');
})();

(function(){
  const m = rep(base, "if (run.settled) return bad(ERR.DUPLICATE_COMMIT, 'duplicate commit');", "/* mutated M9 */");
  const mod = load(m); const h = happy(mod.createClinicalTransactionBridge);
  const beg = h.b.begin(ctx()); const runId = beg.clinicalActionRunId;
  h.b.draft.append(runId,{text:'x'}); h.b.commit.record(runId); h.b.approval.approve(runId);
  const dw1 = h.b.commit.durable(runId);
  const dw2 = h.b.commit.durable(runId);
  rec('M9-duplicate-settle', dw1.ok === true && dw2.ok === true, '重复 commit 却成功');
})();

(function(){
  const m = rep(rep(base, "if (run.cancelled) return bad(ERR.WRITE_AFTER_CANCEL, 'write after cancel');", "/* mutated M10a */"), "if (run.settled) return bad(ERR.DUPLICATE_COMMIT, 'duplicate commit');", "/* mutated M10b */");
  const mod = load(m); const h = happy(mod.createClinicalTransactionBridge);
  const beg = h.b.begin(ctx()); const runId = beg.clinicalActionRunId;
  h.b.draft.append(runId,{text:'x'}); h.b.commit.record(runId); h.b.approval.approve(runId); h.b.cancel(runId);
  const dw = h.b.commit.durable(runId);
  rec('M10-write-after-cancel', dw.ok === true, 'cancel 后写入却成功');
})();

(function(){
  const m = rep(base, "generationEntitlement: run.ctx.generationEntitlement,", "generationEntitlement: 'ai-trial',");
  const mod = load(m); const h = happy(mod.createClinicalTransactionBridge);
  const beg = h.b.begin(ctx({ generationEntitlement: 'manual' })); const runId = beg.clinicalActionRunId;
  h.b.draft.append(runId,{text:'x'}); h.b.commit.record(runId); h.b.approval.approve(runId);
  const dw = h.b.commit.durable(runId);
  const saved = h.store.get(dw.savedObjectId);
  rec('M11-manual-as-paid', saved.generationEntitlement === 'ai-trial', 'manual 被写成 ai-trial');
})();

(function(){
  const m = rep(base, "fields: run.draftEntries,", "fields: { count: run.draftEntries.length },");
  const mod = load(m); const h = happy(mod.createClinicalTransactionBridge);
  const beg = h.b.begin(ctx()); const runId = beg.clinicalActionRunId;
  h.b.draft.append(runId,{text:'x', entryType:'subjective'}); h.b.commit.record(runId); h.b.approval.approve(runId);
  const dw = h.b.commit.durable(runId);
  const saved = h.store.get(dw.savedObjectId);
  rec('M12-count-only-fields', !Array.isArray(saved.fields), '只写字段总数不写逐项');
})();

cleanup();
const fail = R.filter(x=>!x).length;
console.log('MUTATION ' + (R.length-fail) + '/' + R.length + ' KILLED');
process.exit(fail === 0 ? 0 : 2);
