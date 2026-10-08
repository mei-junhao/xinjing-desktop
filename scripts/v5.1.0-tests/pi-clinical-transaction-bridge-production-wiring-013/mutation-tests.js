'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../../../app/js/pi/pi-protocol-v1.js');

const ROOT = path.resolve(__dirname, '../../../');
const REF = { sourceId: 'session:s_mut', sourceVersion: 1, sourceContentHash: 'sha256:' + 'c'.repeat(64), anchorContentHash: 'sha256:' + 'd'.repeat(64) };
const PROJECTION = { clientId: 'c_mut', sessionId: 's_mut', sourceRefs: [REF], storeProjectionVersion: 3, membershipProjectionVersion: 2 };
const CONTEXT = { ...PROJECTION, snapshotHash: P.computeSnapshotHash(PROJECTION), taskId: 'transcript-ai-detect', generationEntitlement: 'paid' };

function copyTree() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-013-mut-'));
  fs.mkdirSync(path.join(dir, 'app', 'js'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'app', 'js', 'pi'), path.join(dir, 'app', 'js', 'pi'), { recursive: true });
  return dir;
}
function replaceOnce(file, from, to, occurrence = 1) {
  const before = fs.readFileSync(file, 'utf8');
  let index = -1;
  let cursor = 0;
  for (let i = 0; i < occurrence; i++) { index = before.indexOf(from, cursor); if (index < 0) throw new Error('mutation source not found'); cursor = index + from.length; }
  const after = before.slice(0, index) + to + before.slice(index + from.length);
  fs.writeFileSync(file, after, 'utf8');
}
function makeRuntime(base, options = {}) {
  const runtimePath = path.join(base, 'app', 'js', 'pi', 'bridge', 'pi-production-runtime-v1.js');
  const { createPiProductionRuntime } = require(runtimePath);
  const listeners = new Map();
  const handlers = new Map();
  const event = { sender: { id: 5 } };
  const store = { s_mut: { id: 's_mut', clientId: 'c_mut', piClinical: null } };
  const ipc = {
    handlers,
    handle(ch, fn) { handlers.set(ch, fn); },
    removeHandler(ch) { handlers.delete(ch); },
    on(ch, fn) { const list = listeners.get(ch) || []; list.push(fn); listeners.set(ch, list); },
    removeListener(ch, fn) { listeners.set(ch, (listeners.get(ch) || []).filter((x) => x !== fn)); },
  };
  function emit(ch, payload, sender = event) { (listeners.get(ch) || []).slice().forEach((fn) => fn(sender, payload)); }
  const win = { webContents: { id: 5, isDestroyed: () => false, send: (_ch, req) => {
    if (options.failWrite && req.kind === 'durable-write') return emit('xj:pi:renderer-reply', { requestId: req.requestId, response: { ok: false, code: 'XJ_MUTATION_STORE_FAILURE' } });
    if (req.kind === 'durable-write') {
      const version = Date.now();
      const record = req.payload;
      store.s_mut.piClinical = { schemaVersion: 1, clinicalActionRunId: record.clinicalActionRunId, taskId: record.taskId, clientId: record.clientId, sessionId: record.sessionId, snapshotHash: record.snapshotHash, sourceRefs: record.sourceRefs, generationEntitlement: record.generationEntitlement, version, savedAt: version };
      return emit('xj:pi:renderer-reply', { requestId: req.requestId, response: { ok: true, savedObjectId: 's_mut', version, savedAt: version, object: store.s_mut } });
    }
    if (req.kind === 'durable-read') {
      const m = store.s_mut.piClinical;
      if (options.noStoreRead) return emit('xj:pi:renderer-reply', { requestId: req.requestId, response: { ok: false, code: 'XJ_PI_VERIFY_FAILED' } });
      return emit('xj:pi:renderer-reply', { requestId: req.requestId, response: m ? { ok: true, savedObjectId: 's_mut', version: m.version, savedAt: m.savedAt, clientId: m.clientId, sessionId: m.sessionId, snapshotHash: m.snapshotHash, sourceRefs: m.sourceRefs, object: store.s_mut } : { ok: false, code: 'XJ_PI_VERIFY_FAILED' } });
    }
  } } };
  const runtime = createPiProductionRuntime({ ipcMain: ipc, getMainWindow: () => win, isTrustedRendererEvent: (e) => !!(e && e.sender && e.sender.id === 5), userDataDir: fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-013-mut-ud-')), serverMembershipProjection: () => options.membership === undefined ? { tier: 'pro' } : options.membership });
  runtime.publishState(event, { projection: PROJECTION, reads: {} });
  return { runtime, ipc, store, event, runtimePath };
}
async function fullRun(h, options = {}) {
  const ctx = { ...CONTEXT, ...(options.context || {}) };
  const begin = h.runtime.clinical.api.begin(ctx);
  if (!begin || begin.ok !== true) return { begin };
  const id = begin.clinicalActionRunId;
  h.runtime.clinical.api.draftAppend(id, { text: 'synthetic mutation note', entryType: 'notes' });
  h.runtime.clinical.api.commitRecord(id);
  h.runtime.clinical.api.approve(id);
  const durable = await h.runtime.clinical.api.commitDurable(id);
  const expected = { clientId: ctx.clientId, sessionId: ctx.sessionId, snapshotHash: ctx.snapshotHash, version: durable.version, sourceRefs: ctx.sourceRefs.map((x) => ({ sourceId: String(x.sourceId), sourceVersion: String(x.sourceVersion), sourceContentHash: x.sourceContentHash, anchorContentHash: x.anchorContentHash })) };
  return { begin, id, durable, expected, verify: () => h.runtime.clinical.api.verify('s_mut', expected) };
}

const cases = [
  {
    id: 'M1-snapshot-bypass', file: 'runtime', from: "if (!expectedSnapshot || String(input.snapshotHash || '') !== expectedSnapshot)", to: 'if (false)',
    probe: async (h) => { const r = h.runtime.clinical.api.begin({ ...CONTEXT, snapshotHash: 'sha256:' + 'f'.repeat(64) }); return r.code !== 'XJ_PI_SNAPSHOT_MISMATCH'; },
  },
  {
    id: 'M2-source-verifier-bypass', file: 'clinical', from: 'if (!verifySource(s, clientId, sessionId)) return bad(ERR.SNAPSHOT_MISMATCH, \'source not owned by client/session\');', to: 'if (false) return bad(ERR.SNAPSHOT_MISMATCH, \'source not owned by client/session\');',
    probe: async (h) => { const r = h.runtime.clinical.bridge.begin({ ...CONTEXT, sourceRefs: [{ ...REF, sourceId: 'forged' }] }); return r.ok === true; },
  },
  {
    id: 'M3-membership-bypass', file: 'runtime', from: "if (generation !== 'manual') {", to: 'if (false) {',
    probe: async (h) => { const r = h.runtime.clinical.api.begin(CONTEXT); return r.code !== 'XJ_PI_MEMBERSHIP_UNKNOWN'; }, options: { membership: null },
  },
  {
    id: 'M4-untrusted-ipc-bypass', file: 'runtime', from: "if (!trustedMainWindowEvent(event)) return fail('XJ_PI_UNKNOWN_EVENT', 'untrusted sender');", to: 'if (false) return fail(\'XJ_PI_UNKNOWN_EVENT\', \'untrusted sender\');', occurrence: 2,
    probe: async (h) => { const fn = h.ipc.handlers.get('xj-pi-clinical-v1:invoke'); const r = await fn({ sender: { id: 999 } }, { method: 'begin', args: [CONTEXT] }); return r.code !== 'XJ_PI_UNKNOWN_EVENT'; },
  },
  {
    id: 'M5-swallow-ok-false', file: 'clinical', from: 'if (isFail(dw)) {', to: 'if (false) {', occurrence: 2, options: { failWrite: true },
    probe: async (h) => { const r = await fullRun(h); return r.durable && r.durable.code !== 'XJ_MUTATION_STORE_FAILURE'; },
  },
  {
    id: 'M6-skip-source-readback', file: 'clinical', from: 'if (!verifySourceRefs(dr.sourceRefs, expRefs, expClientId, expSessionId)) return bad(ERR.VERIFY_MISMATCH, \'sourceRefs mismatch\');', to: 'if (false) return bad(ERR.VERIFY_MISMATCH, \'sourceRefs mismatch\');', occurrence: 2,
    probe: async (h) => { const r = await fullRun(h); h.store.s_mut.piClinical.sourceRefs[0].sourceVersion = '999'; const v = await r.verify(); return v.code !== 'XJ_PI_VERIFY_MISMATCH'; },
  },
  {
    id: 'M7-pause-draft-bypass', file: 'clinical', from: "if (run.status === 'paused') return bad(ERR.APPROVAL_REQUIRED, 'run paused');\n    if (run.settled) return bad(ERR.DUPLICATE_COMMIT, 'run already settled');\n    if (run.status !== 'drafting') return bad(ERR.APPROVAL_REQUIRED, 'draft closed after preview');", to: "if (run.settled) return bad(ERR.DUPLICATE_COMMIT, 'run already settled');", occurrence: 1,
    probe: async (h) => { const b = h.runtime.clinical.api.begin(CONTEXT); h.runtime.clinical.api.pause(b.clinicalActionRunId, 'mutation'); return h.runtime.clinical.api.draftAppend(b.clinicalActionRunId, { text: 'x' }).code !== 'XJ_PI_APPROVAL_REQUIRED'; },
  },
  {
    id: 'M8-duplicate-durable-bypass', file: 'clinical', from: "if (run.durable || run.status === 'durable') return bad(ERR.DUPLICATE_COMMIT, 'durable commit already settled');", to: "if (false) return bad(ERR.DUPLICATE_COMMIT, 'durable commit already settled');", occurrence: 2,
    probe: async (h) => { const r = await fullRun(h); const second = await h.runtime.clinical.api.commitDurable(r.id); return second.code !== 'XJ_PI_DUPLICATE_COMMIT'; },
  },
  {
    id: 'M9-receipt-readback-substitute', file: 'runtime', from: 'durableRead: async (savedObjectId, expected) => requestRenderer(\'durable-read\', { savedObjectId: String(savedObjectId || \'\'), expected: cloneJson(expected, 512 * 1024) || null }),', to: "durableRead: async () => ({ ok: true, savedObjectId: 's_mut', version: 1, savedAt: 1, clientId: 'c_mut', sessionId: 's_mut', snapshotHash: CONTEXT.snapshotHash, sourceRefs: [REF] }),",
    probe: async (h) => { const r = await fullRun(h); h.store.s_mut.piClinical = null; const v = await r.verify(); return v.code !== 'XJ_PI_VERIFY_FAILED'; },
  },
  {
    id: 'M10-entitlement-normalization-bypass', file: 'runtime', from: "const generation = String(input.generationEntitlement || 'manual');", to: "const generation = 'manual';", options: { membership: null },
    probe: async (h) => { const r = h.runtime.clinical.api.begin(CONTEXT); return r.code !== 'XJ_PI_MEMBERSHIP_UNKNOWN'; },
  },
  {
    id: 'M11-invalid-savedAt-bypass', file: 'clinical', from: "if (!Number.isFinite(savedAt) || savedAt <= 0) return bad(ERR.DURABLE_FAILED, 'durable write must return valid savedAt');", to: "if (false) return bad(ERR.DURABLE_FAILED, 'durable write must return valid savedAt');", occurrence: 2,
    probe: async (h) => { const r = await fullRun(h); return r.durable && r.durable.ok === true; }, options: { badSavedAt: true },
  },
];

(async () => {
  let killed = 0;
  for (const item of cases) {
    const base = copyTree();
    const file = item.file === 'runtime' ? path.join(base, 'app', 'js', 'pi', 'bridge', 'pi-production-runtime-v1.js') : path.join(base, 'app', 'js', 'pi', 'clinical', 'clinical-transaction-bridge.js');
    try { replaceOnce(file, item.from, item.to, item.occurrence || 1); } catch (e) { console.log('INVALID_MUTATION ' + item.id + ' :: ' + e.message); process.exitCode = 1; continue; }
    const opts = Object.assign({}, item.options || {});
    if (opts.badSavedAt) opts.reply = (_req, _store) => ({ ok: true, savedObjectId: 's_mut', version: 1, savedAt: 0, object: _store });
    const h = makeRuntime(base, opts);
    let ok = false;
    try { ok = await item.probe(h); } catch (e) { ok = false; }
    h.runtime.stop();
    if (ok) { console.log('KILLED ' + item.id); killed += 1; } else { console.log('SURVIVED ' + item.id + ' :: probe did not observe the mutation'); process.exitCode = 1; }
  }
  console.log('MUTATION ' + killed + '/' + cases.length + ' KILLED');
  if (killed !== cases.length) process.exitCode = 1;
})().catch((e) => { console.error('FATAL', e.stack || e); process.exitCode = 1; });
