'use strict';
/**
 * Clinical Broker 事务桥适配器（XJ-5.1.0-pi-clinical-transaction-bridge-contract-integrity-rework-008）
 * 修复 007 intake：preview/audit 真正不可变（深拷贝+递归冻结+边界 detached copy）；verify 完整 expected 回读；
 * 回读 sourceRefs 逐项四字段/哈希/归属/与原快照逐字段一致；核对 snapshotHash/version/client/session/savedAt。
 * 自包含，适配 base_commit 9971787 干净 worktree。
 */
const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled'];
const APPROVAL_TIMEOUT_MS = 300000;
const CLINICAL_SCOPE = 'clinical.write';
const ENTITLEMENTS = Object.freeze(['manual', 'ai-trial', 'paid']);
const ERR = {
  CLIENT_SESSION_MISMATCH: 'XJ_PI_CLIENT_SESSION_MISMATCH', SNAPSHOT_MISMATCH: 'XJ_PI_SNAPSHOT_MISMATCH',
  APPROVAL_REQUIRED: 'XJ_PI_APPROVAL_REQUIRED', APPROVAL_REJECTED: 'XJ_PI_APPROVAL_REJECTED',
  DUPLICATE_COMMIT: 'XJ_PI_DUPLICATE_COMMIT', WRITE_AFTER_CANCEL: 'XJ_PI_WRITE_AFTER_CANCEL',
  DURABLE_FAILED: 'XJ_PI_DURABLE_FAILED', VERIFY_MISMATCH: 'XJ_PI_VERIFY_MISMATCH',
  INVALID_CONTEXT: 'XJ_PI_INVALID_CONTEXT', UNKNOWN_RUN: 'XJ_PI_UNKNOWN_RUN',
};
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const SRC_KEYS = ['sourceId', 'sourceVersion', 'sourceContentHash', 'anchorContentHash'];
function isHash(v) { return typeof v === 'string' && (SHA256_RE.test(v) || HEX64_RE.test(v)); }
function isStrictTrue(v) { return v === true; }
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; }
function detachedCopy(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
function nsec(p) { return (p || 'clinicalActionRun') + '_' + require('crypto').randomBytes(13).toString('hex'); }
function ok(v) { return Object.assign({ ok: true }, v || {}); }
function bad(c, m) { return { ok: false, code: c || ERR.INVALID_CONTEXT, message: m || c }; }
function isFail(v) { return v && typeof v === 'object' && v.ok === false; }
function sameSourceRef(a, b) {
  return a && b && Object.keys(a).length === SRC_KEYS.length &&
    a.sourceId === b.sourceId && a.sourceVersion === b.sourceVersion &&
    a.sourceContentHash === b.sourceContentHash && a.anchorContentHash === b.anchorContentHash;
}

function createDefaultApprovalBroker({ clock }) {
  const approvals = new Map();
  return {
    create({ runId, scope, taskId, timeoutMs }) {
      const id = 'approval_' + runId + '_' + require('crypto').randomBytes(6).toString('hex');
      approvals.set(id, { id, runId, scope, taskId, status: 'pending', createdAt: clock(), expiresAt: clock() + (timeoutMs || APPROVAL_TIMEOUT_MS) });
      return { ok: true, approvalId: id };
    },
    get(id) { return approvals.get(id) || null; },
    approve(id) { const a = approvals.get(id); if (!a) return { ok: false, code: 'XJ_PI_APPROVAL_UNKNOWN' }; if (a.status === 'rejected') return { ok: false, code: ERR.APPROVAL_REJECTED }; if (a.expiresAt <= clock()) { a.status = 'expired'; return { ok: false, code: ERR.APPROVAL_REQUIRED, message: 'approval-expired' }; } a.status = 'approved'; a.approvedAt = clock(); return { ok: true, approval: a }; },
    reject(id) { const a = approvals.get(id); if (!a) return { ok: false, code: 'XJ_PI_APPROVAL_UNKNOWN' }; a.status = 'rejected'; a.rejectedAt = clock(); return { ok: true }; },
  };
}

function createClinicalTransactionBridge(options) {
  const o = options || {};
  const clock = o.clock || Date.now;
  const durableWrite = o.durableWrite || (() => bad(ERR.DURABLE_FAILED, 'no durableWrite injected'));
  const durableRead = o.durableRead || (() => bad(ERR.DURABLE_FAILED, 'no durableRead injected'));
  const sessionVerifier = o.sessionBelongsToClient;
  const sourceVerifier = o.sourceBelongsToClient;
  const approvalBroker = o.approvalBroker || createDefaultApprovalBroker({ clock });
  const runIdFactory = o.runIdFactory || nsec;
  const taskRegistry = o.taskRegistry || null;
  const runs = new Map();

  function verifySession(clientId, sessionId) {
    if (typeof sessionVerifier !== 'function') return false;
    let r; try { r = sessionVerifier(clientId, sessionId); } catch (e) { return false; }
    return isStrictTrue(r);
  }
  function verifySource(ref, clientId, sessionId) {
    if (typeof sourceVerifier !== 'function') return false;
    let r; try { r = sourceVerifier(ref, clientId, sessionId); } catch (e) { return false; }
    return isStrictTrue(r);
  }

  function validateContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return bad(ERR.INVALID_CONTEXT, 'context required');
    const clientId = String(ctx.clientId || '');
    const sessionId = String(ctx.sessionId || '');
    const taskId = String(ctx.taskId || '');
    const snapshotHash = String(ctx.snapshotHash || '');
    if (!clientId || !sessionId || !taskId || !snapshotHash) return bad(ERR.INVALID_CONTEXT, 'clientId/sessionId/taskId/snapshotHash required');
    if (!isHash(snapshotHash)) return bad(ERR.INVALID_CONTEXT, 'snapshotHash must be sha256:<64hex>');
    if (!verifySession(clientId, sessionId)) return bad(ERR.CLIENT_SESSION_MISMATCH, 'session verifier absent/non-function/threw/not strictly true');
    const gen = String(ctx.generationEntitlement || '');
    if (gen && !ENTITLEMENTS.includes(gen)) return bad(ERR.INVALID_CONTEXT, 'generationEntitlement must be manual|ai-trial|paid');
    const srcs = Array.isArray(ctx.sourceRefs) ? ctx.sourceRefs : [];
    if (!srcs.length) return bad(ERR.SNAPSHOT_MISMATCH, 'sourceRefs must be non-empty array');
    const norm = [];
    for (const s of srcs) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) return bad(ERR.SNAPSHOT_MISMATCH, 'sourceRef item must be object');
      const keys = Object.keys(s);
      if (keys.length !== SRC_KEYS.length || keys.some(k => !SRC_KEYS.includes(k))) return bad(ERR.SNAPSHOT_MISMATCH, 'sourceRef must have exactly 4 keys');
      for (const k of SRC_KEYS) if (!(k in s)) return bad(ERR.SNAPSHOT_MISMATCH, 'sourceRef missing field: ' + k);
      const sourceId = String(s.sourceId || '');
      const sourceVersion = String(s.sourceVersion || '');
      if (!sourceId || !sourceVersion) return bad(ERR.SNAPSHOT_MISMATCH, 'sourceId/sourceVersion must be non-empty');
      if (!isHash(s.sourceContentHash) || !isHash(s.anchorContentHash)) return bad(ERR.SNAPSHOT_MISMATCH, 'content/anchor hash must be sha256');
      if (!verifySource(s, clientId, sessionId)) return bad(ERR.SNAPSHOT_MISMATCH, 'source not owned by client/session');
      norm.push({ sourceId, sourceVersion, sourceContentHash: String(s.sourceContentHash), anchorContentHash: String(s.anchorContentHash) });
    }
    return ok(deepFreeze({ clientId, sessionId, taskId, snapshotHash, sourceRefs: norm, generationEntitlement: gen || 'manual' }));
  }

  function begin(ctx) {
    const v = validateContext(ctx);
    if (isFail(v)) return v;
    const runId = runIdFactory('clinicalActionRun');
    const audit = deepFreeze({ clinicalActionRunId: runId, taskId: v.taskId, clientId: v.clientId, sessionId: v.sessionId, snapshotHash: v.snapshotHash, sourceRefsSummary: detachedCopy(v.sourceRefs), generationEntitlement: v.generationEntitlement, createdAt: clock() });
    runs.set(runId, { ctx: v, taskId: v.taskId, status: 'drafting', audit, draftEntries: [], preview: null, approvalId: null, settled: false, durable: null, cancelled: false });
    return ok({ clinicalActionRunId: runId, audit: deepFreeze(detachedCopy(audit)) });
  }

  function assertTaskActive(taskId) {
    if (!taskRegistry || typeof taskRegistry.status !== 'function') return ok();
    const s = taskRegistry.status(taskId);
    if (TERMINAL_STATUSES.includes(s)) return bad(ERR.WRITE_AFTER_CANCEL, 'task terminal: ' + s);
    return ok();
  }

  function draftAppend(runId, entry) {
    const run = runs.get(runId);
    if (!run) return bad(ERR.UNKNOWN_RUN, 'unknown run');
    if (run.cancelled) return bad(ERR.WRITE_AFTER_CANCEL, 'run cancelled');
    if (run.status === 'paused') return bad(ERR.APPROVAL_REQUIRED, 'run paused');
    if (run.settled) return bad(ERR.DUPLICATE_COMMIT, 'run already settled');
    if (run.status !== 'drafting') return bad(ERR.APPROVAL_REQUIRED, 'draft closed after preview');
    const t = assertTaskActive(run.taskId);
    if (isFail(t)) return t;
    if (!entry || typeof entry !== 'object') return bad(ERR.INVALID_CONTEXT, 'entry required');
    const text = String(entry.text || entry.content || '').slice(0, 8000);
    if (!text) return bad(ERR.INVALID_CONTEXT, 'entry text required');
    run.draftEntries.push(deepFreeze({ text, entryType: String(entry.entryType || 'note'), at: clock(), ordinal: run.draftEntries.length + 1 }));
    return ok({ clinicalActionRunId: runId, draftOrdinal: run.draftEntries.length, draftOnly: true });
  }

  function buildPreview(run) {
    const fields = run.draftEntries.reduce((acc, e) => { acc[e.entryType] = (acc[e.entryType] || 0) + 1; return acc; }, {});
    return deepFreeze({
      target: run.taskId, date: new Date(clock()).toISOString().slice(0, 10), recordType: 'clinical-note',
      fieldSummary: detachedCopy(fields), sourceRefs: detachedCopy(run.ctx.sourceRefs), snapshotHash: run.ctx.snapshotHash,
      generationEntitlement: run.ctx.generationEntitlement, immutable: true,
    });
  }

  function commitRecord(runId) {
    const run = runs.get(runId);
    if (!run) return bad(ERR.UNKNOWN_RUN, 'unknown run');
    if (run.cancelled) return bad(ERR.WRITE_AFTER_CANCEL, 'write after cancel');
    if (run.status === 'paused') return bad(ERR.APPROVAL_REQUIRED, 'run paused');
    if (run.settled) return bad(ERR.DUPLICATE_COMMIT, 'duplicate commit');
    if (run.durable || run.status === 'durable') return bad(ERR.DUPLICATE_COMMIT, 'durable commit already settled');
    if (run.status !== 'drafting') return bad(ERR.APPROVAL_REQUIRED, 'already in approval/committed');
    const t = assertTaskActive(run.taskId);
    if (isFail(t)) return t;
    if (!run.draftEntries.length) return bad(ERR.INVALID_CONTEXT, 'no draft entries to commit');
    run.preview = buildPreview(run); // 内部冻结副本
    run.status = 'awaiting_approval';
    const ap = approvalBroker.create({ runId, scope: CLINICAL_SCOPE, taskId: run.taskId });
    if (isFail(ap)) return ap;
    run.approvalId = ap.approvalId;
    return ok({ clinicalActionRunId: runId, preview: deepFreeze(detachedCopy(run.preview)), approvalId: ap.approvalId, scope: CLINICAL_SCOPE, status: 'awaiting_approval' });
  }

  function approve(runId) {
    const run = runs.get(runId);
    if (!run) return bad(ERR.UNKNOWN_RUN, 'unknown run');
    if (!run.approvalId) return bad(ERR.APPROVAL_REQUIRED, 'no approval created');
    return approvalBroker.approve(run.approvalId);
  }

  function commitDurable(runId) {
    const run = runs.get(runId);
    if (!run) return bad(ERR.UNKNOWN_RUN, 'unknown run');
    if (run.cancelled) return bad(ERR.WRITE_AFTER_CANCEL, 'write after cancel');
    if (run.status === 'paused') return bad(ERR.APPROVAL_REQUIRED, 'run paused');
    if (run.settled) return bad(ERR.DUPLICATE_COMMIT, 'duplicate commit');
    const t = assertTaskActive(run.taskId);
    if (isFail(t)) return t;
    const ap = run.approvalId ? approvalBroker.get(run.approvalId) : null;
    if (!ap) return bad(ERR.APPROVAL_REQUIRED, 'approval required before durable write');
    if (ap.status === 'rejected') return bad(ERR.APPROVAL_REJECTED, 'approval rejected');
    if (ap.status === 'expired' || ap.expiresAt <= clock()) return bad(ERR.APPROVAL_REQUIRED, 'approval expired');
    if (ap.scope !== CLINICAL_SCOPE) return bad(ERR.APPROVAL_REQUIRED, 'scope mismatch');
    if (ap.taskId !== run.taskId) return bad(ERR.APPROVAL_REQUIRED, 'cross-task approval');
    if (ap.status !== 'approved') return bad(ERR.APPROVAL_REQUIRED, 'approval not approved');
    const record = detachedCopy({
      recordType: run.preview.recordType, clientId: run.ctx.clientId, sessionId: run.ctx.sessionId,
      snapshotHash: run.ctx.snapshotHash, sourceRefs: run.ctx.sourceRefs, fields: run.draftEntries.map(detachedCopy),
      preview: run.preview, clinicalActionRunId: runId, generationEntitlement: run.ctx.generationEntitlement,
    });
    let dw;
    try {
      dw = durableWrite(record);
      if (dw && typeof dw.then === 'function') return bad(ERR.DURABLE_FAILED, 'async durableWrite not supported in sync bridge');
    } catch (e) {
      runs.set(runId, Object.assign(run, { status: 'failed', failure: { code: ERR.DURABLE_FAILED, message: String(e && e.message || e) } }));
      return bad(ERR.DURABLE_FAILED, 'durable write threw');
    }
    if (isFail(dw)) { runs.set(runId, Object.assign(run, { status: 'failed', failure: { code: dw.code || ERR.DURABLE_FAILED, message: dw.message } })); return dw; }
    if (!dw || !String(dw.savedObjectId || '')) return bad(ERR.DURABLE_FAILED, 'durable write must return non-empty savedObjectId');
    const savedObjectId = String(dw.savedObjectId);
    const version = Number(dw.version);
    if (!Number.isInteger(version) || version < 1) return bad(ERR.DURABLE_FAILED, 'durable write must return positive integer version');
    const savedAt = Number(dw.savedAt);
    if (!Number.isFinite(savedAt) || savedAt <= 0) return bad(ERR.DURABLE_FAILED, 'durable write must return valid savedAt');
    run.durable = { savedObjectId, version, savedAt, record: detachedCopy(record) };
    run.status = 'durable';
    run.settled = true;
    return ok({ clinicalActionRunId: runId, savedObjectId, version, savedAt });
  }

  // 生产 Electron 的 Store 访问经过 renderer request/reply，必须显式 await。
  // 保留上面的同步方法给 008 固定契约；生产 runtime 使用此异步等价入口。
  async function commitDurableAsync(runId) {
    const run = runs.get(runId);
    if (!run) return bad(ERR.UNKNOWN_RUN, 'unknown run');
    if (run.cancelled) return bad(ERR.WRITE_AFTER_CANCEL, 'write after cancel');
    if (run.status === 'paused') return bad(ERR.APPROVAL_REQUIRED, 'run paused');
    if (run.settled) return bad(ERR.DUPLICATE_COMMIT, 'duplicate commit');
    if (run.durable || run.status === 'durable') return bad(ERR.DUPLICATE_COMMIT, 'durable commit already settled');
    const t = assertTaskActive(run.taskId);
    if (isFail(t)) return t;
    const ap = run.approvalId ? approvalBroker.get(run.approvalId) : null;
    if (!ap) return bad(ERR.APPROVAL_REQUIRED, 'approval required before durable write');
    if (ap.status === 'rejected') return bad(ERR.APPROVAL_REJECTED, 'approval rejected');
    if (ap.status === 'expired' || ap.expiresAt <= clock()) return bad(ERR.APPROVAL_REQUIRED, 'approval expired');
    if (ap.scope !== CLINICAL_SCOPE) return bad(ERR.APPROVAL_REQUIRED, 'scope mismatch');
    if (ap.taskId !== run.taskId) return bad(ERR.APPROVAL_REQUIRED, 'cross-task approval');
    if (ap.status !== 'approved') return bad(ERR.APPROVAL_REQUIRED, 'approval not approved');
    const record = detachedCopy({
      recordType: run.preview.recordType, clientId: run.ctx.clientId, sessionId: run.ctx.sessionId,
      snapshotHash: run.ctx.snapshotHash, sourceRefs: run.ctx.sourceRefs, fields: run.draftEntries,
      preview: run.preview, clinicalActionRunId: runId, taskId: run.taskId,
      generationEntitlement: run.ctx.generationEntitlement,
    });
    let dw;
    try { dw = await durableWrite(record); }
    catch (e) {
      run.status = 'failed';
      run.failure = { code: ERR.DURABLE_FAILED, message: String(e && e.message || e) };
      return bad(ERR.DURABLE_FAILED, 'durable write threw');
    }
    if (isFail(dw)) {
      run.status = 'failed';
      run.failure = { code: dw.code || ERR.DURABLE_FAILED, message: dw.message };
      return dw;
    }
    if (!dw || !String(dw.savedObjectId || '')) return bad(ERR.DURABLE_FAILED, 'durable write must return non-empty savedObjectId');
    const savedObjectId = String(dw.savedObjectId);
    const version = Number(dw.version);
    if (!Number.isInteger(version) || version < 1) return bad(ERR.DURABLE_FAILED, 'durable write must return positive integer version');
    const savedAt = Number(dw.savedAt);
    if (!Number.isFinite(savedAt) || savedAt <= 0) return bad(ERR.DURABLE_FAILED, 'durable write must return valid savedAt');
    run.durable = { savedObjectId, version, savedAt, record: detachedCopy(record) };
    run.status = 'durable';
    return ok({ clinicalActionRunId: runId, savedObjectId, version, savedAt });
  }

  function verifySourceRefs(readBack, expectedRefs, clientId, sessionId) {
    if (!Array.isArray(readBack) || !readBack.length) return false;
    if (readBack.length !== expectedRefs.length) return false;
    for (let i = 0; i < readBack.length; i++) {
      const rb = readBack[i], ex = expectedRefs[i];
      if (!rb || typeof rb !== 'object' || Array.isArray(rb)) return false;
      const keys = Object.keys(rb);
      if (keys.length !== SRC_KEYS.length || keys.some(k => !SRC_KEYS.includes(k))) return false;
      for (const k of SRC_KEYS) if (typeof rb[k] !== 'string' || !rb[k]) return false;
      if (!isHash(rb.sourceContentHash) || !isHash(rb.anchorContentHash)) return false;
      if (!verifySource(rb, clientId, sessionId)) return false;
      if (!sameSourceRef(rb, ex)) return false;
    }
    return true;
  }

  function verify(savedObjectId, expected) {
    const id = String(savedObjectId || '');
    if (!id) return bad(ERR.VERIFY_MISMATCH, 'savedObjectId required');
    let dr;
    try {
      dr = durableRead(id);
      if (dr && typeof dr.then === 'function') return bad(ERR.DURABLE_FAILED, 'async durableRead not supported in sync bridge');
    } catch (e) { return bad(ERR.DURABLE_FAILED, 'durable read threw'); }
    if (isFail(dr)) return bad(ERR.VERIFY_MISMATCH, 'durable read failed');
    if (!dr || typeof dr !== 'object') return bad(ERR.VERIFY_MISMATCH, 'durable read returned no record');
    if (!dr.snapshotHash || !isHash(dr.snapshotHash)) return bad(ERR.VERIFY_MISMATCH, 'snapshotHash missing/malformed');
    const version = Number(dr.version);
    if (!Number.isInteger(version) || version < 1) return bad(ERR.VERIFY_MISMATCH, 'version missing/malformed');
    const savedAt = Number(dr.savedAt);
    if (!Number.isFinite(savedAt) || savedAt <= 0) return bad(ERR.VERIFY_MISMATCH, 'savedAt missing/malformed');
    if (!dr.clientId || !dr.sessionId) return bad(ERR.VERIFY_MISMATCH, 'ownership fields missing');
    let expClientId, expSessionId, expSnapshot, expVersion, expRefs, foundRun = null;
    if (expected && typeof expected === 'object') {
      expClientId = String(expected.clientId || '');
      expSessionId = String(expected.sessionId || '');
      expSnapshot = String(expected.snapshotHash || '');
      expVersion = expected.version != null ? Number(expected.version) : NaN;
      expRefs = expected.sourceRefs;
      if (!expClientId || !expSessionId || !expSnapshot || !Number.isInteger(expVersion) || expVersion < 1) return bad(ERR.VERIFY_MISMATCH, 'expected must include clientId/sessionId/snapshotHash/version');
      if (!Array.isArray(expRefs) || !expRefs.length) return bad(ERR.VERIFY_MISMATCH, 'expected must include non-empty sourceRefs');
    } else {
      foundRun = [...runs.values()].find(r => r.durable && r.durable.savedObjectId === id);
      if (!foundRun) return bad(ERR.VERIFY_MISMATCH, 'no expected and no matching run for savedObjectId');
      expClientId = foundRun.ctx.clientId; expSessionId = foundRun.ctx.sessionId;
      expSnapshot = foundRun.ctx.snapshotHash; expVersion = foundRun.durable.version; expRefs = foundRun.ctx.sourceRefs;
    }
    if (dr.clientId !== expClientId || dr.sessionId !== expSessionId) return bad(ERR.VERIFY_MISMATCH, 'ownership mismatch');
    if (dr.snapshotHash !== expSnapshot) return bad(ERR.VERIFY_MISMATCH, 'snapshot hash drift');
    if (version !== expVersion) return bad(ERR.VERIFY_MISMATCH, 'version mismatch');
    if (!verifySourceRefs(dr.sourceRefs, expRefs, expClientId, expSessionId)) return bad(ERR.VERIFY_MISMATCH, 'sourceRefs mismatch');
    if (foundRun) { foundRun.status = 'succeeded'; foundRun.settled = true; foundRun.settledAt = clock(); }
    return ok({ savedObjectId: id, version, verified: true, status: 'succeeded' });
  }

  async function verifyAsync(savedObjectId, expected) {
    const id = String(savedObjectId || '');
    if (!id) return bad(ERR.VERIFY_MISMATCH, 'savedObjectId required');
    let dr;
    try { dr = await durableRead(id, expected); }
    catch (e) { return bad(ERR.DURABLE_FAILED, 'durable read threw'); }
    if (isFail(dr)) return dr;
    if (!dr || typeof dr !== 'object') return bad(ERR.VERIFY_MISMATCH, 'durable read returned no record');
    if (!dr.snapshotHash || !isHash(dr.snapshotHash)) return bad(ERR.VERIFY_MISMATCH, 'snapshotHash missing/malformed');
    const version = Number(dr.version);
    if (!Number.isInteger(version) || version < 1) return bad(ERR.VERIFY_MISMATCH, 'version missing/malformed');
    const savedAt = Number(dr.savedAt);
    if (!Number.isFinite(savedAt) || savedAt <= 0) return bad(ERR.VERIFY_MISMATCH, 'savedAt missing/malformed');
    if (!dr.clientId || !dr.sessionId) return bad(ERR.VERIFY_MISMATCH, 'ownership fields missing');
    let expClientId = '', expSessionId = '', expSnapshot = '', expVersion = NaN, expRefs = null;
    if (expected && typeof expected === 'object') {
      expClientId = String(expected.clientId || '');
      expSessionId = String(expected.sessionId || '');
      expSnapshot = String(expected.snapshotHash || '');
      expVersion = Number(expected.version);
      expRefs = expected.sourceRefs;
      if (!expClientId || !expSessionId || !expSnapshot || !Number.isInteger(expVersion) || expVersion < 1 || !Array.isArray(expRefs) || !expRefs.length) return bad(ERR.VERIFY_MISMATCH, 'expected fields incomplete');
    } else {
      const foundRun = [...runs.values()].find((r) => r.durable && r.durable.savedObjectId === id);
      if (!foundRun) return bad(ERR.VERIFY_MISMATCH, 'no expected and no matching run');
      expClientId = foundRun.ctx.clientId; expSessionId = foundRun.ctx.sessionId; expSnapshot = foundRun.ctx.snapshotHash; expVersion = foundRun.durable.version; expRefs = foundRun.ctx.sourceRefs;
    }
    if (dr.clientId !== expClientId || dr.sessionId !== expSessionId) return bad(ERR.VERIFY_MISMATCH, 'ownership mismatch');
    if (dr.snapshotHash !== expSnapshot || version !== expVersion) return bad(ERR.VERIFY_MISMATCH, 'snapshot/version mismatch');
    if (!verifySourceRefs(dr.sourceRefs, expRefs, expClientId, expSessionId)) return bad(ERR.VERIFY_MISMATCH, 'sourceRefs mismatch');
    const foundRun = [...runs.values()].find((r) => r.durable && r.durable.savedObjectId === id);
    if (foundRun) { foundRun.status = 'succeeded'; foundRun.settled = true; foundRun.settledAt = clock(); }
    return ok({ savedObjectId: id, version, verified: true, status: 'succeeded' });
  }

  function pause(runId, reason) {
    const run = runs.get(runId);
    if (!run) return bad(ERR.UNKNOWN_RUN, 'unknown run');
    if (run.cancelled || run.settled) return bad(ERR.WRITE_AFTER_CANCEL, 'run already terminal');
    if (run.status === 'paused') return ok({ clinicalActionRunId: runId, status: 'paused' });
    run.pausedFrom = run.status;
    run.pauseReason = String(reason || 'user');
    run.status = 'paused';
    return ok({ clinicalActionRunId: runId, status: 'paused', reason: run.pauseReason });
  }

  function resume(runId) {
    const run = runs.get(runId);
    if (!run) return bad(ERR.UNKNOWN_RUN, 'unknown run');
    if (run.status !== 'paused') return bad(ERR.APPROVAL_REQUIRED, 'run is not paused');
    run.status = run.pausedFrom || (run.approvalId ? 'awaiting_approval' : 'drafting');
    delete run.pausedFrom; delete run.pauseReason;
    return ok({ clinicalActionRunId: runId, status: run.status });
  }

  function settle(runId, okFlag) {
    const run = runs.get(runId);
    if (!run) return bad(ERR.UNKNOWN_RUN, 'unknown run');
    if (run.settled) return bad(ERR.DUPLICATE_COMMIT, 'run already settled');
    run.cancelled = true; run.status = okFlag ? 'succeeded' : 'cancelled'; run.settled = true; run.settledAt = clock();
    return ok({ clinicalActionRunId: runId, status: run.status });
  }
  function cancel(runId) { return settle(runId, false); }
  function status(runId) {
    const run = runs.get(runId);
    if (!run) return bad(ERR.UNKNOWN_RUN, 'unknown run');
    return ok({ clinicalActionRunId: runId, status: run.status, settled: run.settled, cancelled: run.cancelled, approvalId: run.approvalId || null, durable: run.durable ? { savedObjectId: run.durable.savedObjectId, version: run.durable.version } : null });
  }

  return {
    begin, draft: { append: draftAppend },
    commit: { record: commitRecord, durable: commitDurable, durableAsync: commitDurableAsync },
    approval: { approve, reject: (runId) => { const run = runs.get(runId); if (!run || !run.approvalId) return bad(ERR.APPROVAL_REQUIRED, 'no approval'); return approvalBroker.reject(run.approvalId); } },
    verify, verifyAsync, pause, resume, cancel, status,
    _internal: { runs, ERR, validateContext, buildPreview, verifySession, verifySource, verifySourceRefs },
  };
}

module.exports = { createClinicalTransactionBridge, ERR, ENTITLEMENTS, CLINICAL_SCOPE };
