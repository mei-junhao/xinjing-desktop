'use strict';
/**
 * XJ-5.0.0 Pi 4.4 Controlled Supervision Package Expected-Red — Mutation Probes (task 28)
 *
 * Fourteen mutation-sensitive probes that prove the expected-red harness is
 * sensitive to every security-relevant mutant and is NOT fooled by fabricated
 * capabilities, doctored results, plaintext leakage, protected-input drift or a
 * forced-exit-zero mutant. Every probe is KILLED for a precise intended reason.
 *
 *   Family A — production logic (7): a temp mutated copy of a REAL production
 *     module (commercial-state-machine.js / entitlements.js) is written to an
 *     OS-temporary path, loaded via require() (NEVER a proxy; the real module
 *     file is executed), and the EXACT harness invariant from run-contract.js is
 *     re-run against the mutant. killed = the invariant breaks AND the specific
 *     intended security failure is observed (not merely "any false").
 *
 *   Family B — harness logic (5): doctored contract-result.json / contract-matrix.json
 *     are written to an OS-temporary verify dir and the INDEPENDENT verifier
 *     verify-artifacts.js is spawned with XJ_TASK28_VERIFY_OUT_DIR. killed = the
 *     verifier exits nonzero because it independently re-derives the defect
 *     (false-runtime regex, expected-red promotion, secret-marker scan,
 *     independent recount, matrix entry-point check). This is the non-circular
 *     backstop: a mutant that forces run-contract exit(0) is still caught.
 *
 *   Family C — drift before write (2): a tampered manifest / tampered protected
 *     file is supplied via XJ_TASK28_MANIFEST_PATH / XJ_TASK28_PROTECTED_ROOT and
 *     run-contract.js is spawned. killed = exit(1) at the module-top precondition
 *     gate (manifest byte hash or per-file hash) BEFORE any artifact write, with
 *     ZERO files written to the temp out dir.
 *
 * Contract-required mutation coverage (≥12):
 *   fabricated missing API(B8), parser bypass(B8), decrypt-before-signature(B9),
 *   dual-active grant(A2), old envelope reuse(A3), delayed revocation(B12),
 *   grace extension(A4), clock rollback acceptance(A5), revocation/grant
 *   rollback(A1 revocation-epoch + A6 grant-sequence/stale-revision),
 *   entitlement/handler bypass(A7), plaintext persistence/logging(B10),
 *   forced exit zero after semantic failure(B11).
 *
 * Determinism: mutation-result.json carries NO volatile fields (no timestamps,
 * random or hash-bound values); volatile diagnostics are stdout-only.
 *
 * Preconditions (run before any write): protected manifest byte hash + all ten
 * protected per-file hashes. BLOCKED on mismatch with zero writes.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve('D:\\xinjing-electron');
const HARNESS_DIR = path.join(ROOT, 'tests', 'v5.0.0-disposable', 'pi-v4.4-controlled-supervision-package-expected-red-28');
const MANIFEST_PATH = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'pi-v4.4-controlled-supervision-package-expected-red-28', 'protected-files-manifest.json');
const EXPECTED_MANIFEST_HASH = '5941356B7B24CB1D24A6B6A011C37E024F4763A13BBFB4E91263B28115A18033';
const EXPECTED_BASE_COMMIT = '9971787eb6e443ab5a5c80aee118b9b43285c093';
const TASK_ID = 'XJ-5.0.0-pi-v4.4-controlled-supervision-package-expected-red-28';
const CONTRACT_ID = 'v4.4-controlled-supervision-package-v1';
const WRITE_LOCK_ID = 'lock-XJ-5.0.0-pi-v4.4-controlled-supervision-package-expected-red-28';
const GRANT_ID = 'local-codex-20260727T192730Z-pi-v4.4-supervision-package-expected-red-28';

const CSM_PATH = path.join(ROOT, 'app', 'js', 'commercial-state-machine.js');
const ENT_PATH = path.join(ROOT, 'app', 'js', 'entitlements.js');
const MAIN_PATH = path.join(ROOT, 'main.js');
const RUN_CONTRACT_JS = path.join(HARNESS_DIR, 'run-contract.js');
const VERIFY_ARTIFACTS_JS = path.join(HARNESS_DIR, 'verify-artifacts.js');

const SECRET_MARKERS = ['PRIVATE KEY', 'BEGIN PRIVATE', 'BEGIN ENCRYPTED', 'authorPrivateKey', 'devicePrivateKey', '-----BEGIN'];

function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }
function sha256Str(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase(); }

// ── Precondition: manifest byte hash + all ten per-file hashes (BLOCKED, zero writes) ──
const manifestRaw = fs.readFileSync(MANIFEST_PATH);
const manifestByteHash = crypto.createHash('sha256').update(manifestRaw).digest('hex').toUpperCase();
if (manifestByteHash !== EXPECTED_MANIFEST_HASH) {
  console.error('[BLOCKED] protected manifest byte hash mismatch: ' + manifestByteHash + ' != ' + EXPECTED_MANIFEST_HASH);
  process.exit(1);
}
const manifest = JSON.parse(manifestRaw.toString('utf8'));
let hashFailures = 0;
manifest.files.forEach((f) => {
  const p = path.join(ROOT, f.path);
  const actual = fs.existsSync(p) ? sha256File(p) : 'MISSING';
  if (actual !== f.sha256.toUpperCase()) {
    hashFailures++;
    console.error('[BLOCKED] protected hash mismatch: ' + f.path + ' -> ' + actual + ' != ' + f.sha256.toUpperCase());
  }
});
if (hashFailures > 0) {
  console.error('[BLOCKED] ' + hashFailures + ' protected-file hash mismatch(es); aborting before any task write.');
  process.exit(1);
}

// ── OS-temporary workspace (cleaned at exit; production files never touched) ──
const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-task28-mut-'));
function registerCleanup() {
  try {
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  } catch (_) { /* best-effort; temp dir is OS-managed */ }
}
process.on('exit', registerCleanup);

function mutantPath(label) { return path.join(TMP_BASE, label.replace(/[^A-Za-z0-9_-]/g, '_') + '.js'); }

// Load a mutated copy of a real production module via require() (real file execution, never a proxy).
function loadMutantModule(originalPath, mutator, label) {
  const src = fs.readFileSync(originalPath, 'utf8');
  const mutated = mutator(src);
  if (mutated === src) throw new Error('mutation ' + label + ' produced no source change (mutator did not match)');
  const mp = mutantPath(label);
  fs.writeFileSync(mp, mutated, 'utf8');
  const abs = path.resolve(mp);
  delete require.cache[require.resolve(abs)];
  return require(abs);
}

// Spawn a node script with env overrides; returns {status, stdout, stderr}. Hard 90s cap.
function runNode(scriptPath, envOverrides, timeoutMs) {
  const env = Object.assign({}, process.env, envOverrides || {});
  const res = spawnSync(process.execPath, [scriptPath], { env, encoding: 'utf8', timeout: timeoutMs || 90000, windowsHide: true });
  return { status: res.status, signal: res.signal, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// ── Shared synthetic constants mirroring run-contract.js (deterministic) ──
const DEV_OLD = 'dev-old-hash', DEV_NEW = 'dev-new-hash', DEV_WRONG = 'dev-wrong-hash';
const DAY = 86400000;
const T0 = 1753000000000; // fixed synthetic epoch (no Date.now in artifacts)

function mkEvent(current, opId, targetState, revision, extra) {
  const ev = {
    operationId: opId,
    targetState: targetState,
    revision: revision,
    signatureValid: true,
    clockValid: true,
    revocationEpoch: current.revocationEpoch,
    deviceBindingHash: current.deviceBindingHash,
  };
  if (extra) Object.assign(ev, extra);
  return ev;
}
function advance(csm, sub0, chain) {
  let sub = sub0;
  chain.forEach((c) => {
    const ev = mkEvent(sub, c.op, c.target, c.rev, c.extra);
    const res = csm.applySubscriptionTransition(sub, ev);
    if (!res.ok) throw new Error('advance failed at ' + c.op + ': ' + res.errorCode);
    sub = res.value;
  });
  return sub;
}
function subAcc(csm, rec, dev, nowMs) {
  return csm.subscriptionAccess(rec, { signatureValid: true, clockValid: true, revocationEpoch: rec.revocationEpoch, deviceBindingHash: dev, nowMs: nowMs == null ? T0 : nowMs });
}

const probes = [];
function record(p) {
  probes.push(p);
  const tag = p.killed ? '[KILLED]  ' : '[SURVIVED]';
  console.log(tag + ' ' + p.id + ' (' + p.family + '): ' + p.mutation + ' -> ' + (p.killed ? p.detection : 'NOT KILLED'));
}

// ════════════════════════════════════════════════════════════════════════════
// FAMILY A — production-logic mutations (require temp mutant of real module,
// re-run the exact run-contract.js invariant, assert it breaks for the reason)
// ════════════════════════════════════════════════════════════════════════════

// A1 — contract #9 (revocation-epoch rollback): validateSecurity no longer
// rejects event.revocationEpoch < current.revocationEpoch. Re-run C-CSM-REVOKE-ROLLBACK.
(function A1() {
  const csm = loadMutantModule(CSM_PATH, (src) => src.replace('event.revocationEpoch < current.revocationEpoch', 'event.revocationEpoch < -1'), 'A1-revoke-rollback');
  const sub = csm.createSubscription({ subscriptionId: 'sub-rr', deviceBindingHash: DEV_OLD, tier: 'pro', revocationEpoch: 5 });
  const ev = mkEvent(sub, 'op1', 'pending', 1, { revocationEpoch: 3 }); // 3 < 5 -> rollback
  const res = csm.applySubscriptionTransition(sub, ev);
  const rolledBackAccepted = res.ok === true;
  const noRollbackCode = res.errorCode !== 'revocation-rollback';
  // invariant from run-contract.js C-CSM-REVOKE-ROLLBACK:
  const invariantHeld = (res.ok === false && res.errorCode === 'revocation-rollback');
  record({
    id: 'A1', family: 'family_a_production_logic',
    contract_refs: ['revocation/grant rollback (revocation-epoch)'],
    target: 'commercial-state-machine.js validateSecurity (event.revocationEpoch < current.revocationEpoch -> < -1)',
    mutation: 'revocation-epoch rollback guard bypassed (lower epoch accepted)',
    intended_reason: 'a known revocation-epoch rollback must be rejected; accepting it silently revives revoked authority',
    killed: rolledBackAccepted && noRollbackCode && !invariantHeld,
    detection: rolledBackAccepted ? 'C-CSM-REVOKE-ROLLBACK invariant broke: res.ok=true (rollback accepted) instead of res.ok=false/code=revocation-rollback' : 'rollback still rejected',
    evidence: 'res.ok=' + res.ok + ' code=' + res.errorCode + ' invariantHeld=' + invariantHeld,
  });
})();

// A2 — contract #4 (dual-active grant): transfer-completed does NOT swap the
// device binding (old device retains authority after migration). Re-run C-CSM-TRANSFER-ATOMIC.
(function A2() {
  const csm = loadMutantModule(CSM_PATH, (src) => src.replace('next.deviceBindingHash = current.pendingTargetDeviceBindingHash;', 'next.deviceBindingHash = current.deviceBindingHash;'), 'A2-no-swap');
  const sub0 = csm.createSubscription({ subscriptionId: 'sub-ta', deviceBindingHash: DEV_OLD, tier: 'pro' });
  const activeOld = advance(csm, sub0, [{ op: 'op1', target: 'pending', rev: 1 }, { op: 'op2', target: 'active', rev: 2 }]);
  const pending = csm.applySubscriptionTransition(activeOld, mkEvent(activeOld, 'op3', 'transfer-pending', 3, { targetDeviceBindingHash: DEV_NEW })).value;
  const completed = csm.applySubscriptionTransition(pending, mkEvent(pending, 'op4', 'transfer-completed', 4, { targetDeviceBindingHash: DEV_NEW })).value;
  const activeNew = csm.applySubscriptionTransition(completed, mkEvent(completed, 'op5', 'active', 5)).value;
  const deviceSwapped = completed.deviceBindingHash === DEV_NEW && activeOld.deviceBindingHash === DEV_OLD;
  const newActiveAfter = subAcc(csm, activeNew, DEV_NEW).paidAccessAllowed === true;
  const oldDeniedAfter = subAcc(csm, activeNew, DEV_OLD).paidAccessAllowed === false && subAcc(csm, activeNew, DEV_OLD).errorCode === 'device-mismatch';
  // invariant from run-contract.js C-CSM-TRANSFER-ATOMIC:
  const invariantHeld = deviceSwapped && newActiveAfter && oldDeniedAfter;
  record({
    id: 'A2', family: 'family_a_production_logic',
    contract_refs: ['dual-active grant', 'migration atomicity'],
    target: 'commercial-state-machine.js transfer-completed (next.deviceBindingHash = pendingTarget -> keep current)',
    mutation: 'migration does not swap device binding; old device retains authority, new device never enabled',
    intended_reason: 'a transfer must revoke the old device and enable only the new one; keeping the old binding is a dual-active authority leak',
    killed: !invariantHeld && !deviceSwapped,
    detection: !deviceSwapped ? 'C-CSM-TRANSFER-ATOMIC invariant broke: deviceSwapped=false (old device not revoked on migration)' : 'deviceSwapped still true',
    evidence: 'completedDevice=' + completed.deviceBindingHash + ' deviceSwapped=' + deviceSwapped + ' newActiveAfter=' + newActiveAfter + ' oldDeniedAfter=' + oldDeniedAfter + ' invariantHeld=' + invariantHeld,
  });
})();

// A3 — contract #5 (old envelope reuse): transfer-completed does NOT clear
// pendingTargetDeviceBindingHash. Re-run C-CSM-TRANSFER-FINALITY.
(function A3() {
  const csm = loadMutantModule(CSM_PATH, (src) => src.replace(
    'next.deviceBindingHash = current.pendingTargetDeviceBindingHash;\n      next.pendingTargetDeviceBindingHash = \'\';',
    'next.deviceBindingHash = current.pendingTargetDeviceBindingHash;\n      next.pendingTargetDeviceBindingHash = current.pendingTargetDeviceBindingHash;'
  ), 'A3-no-clear');
  const sub0 = csm.createSubscription({ subscriptionId: 'sub-tf', deviceBindingHash: DEV_OLD, tier: 'pro' });
  const activeOld = advance(csm, sub0, [{ op: 'op1', target: 'pending', rev: 1 }, { op: 'op2', target: 'active', rev: 2 }]);
  const pending = csm.applySubscriptionTransition(activeOld, mkEvent(activeOld, 'op3', 'transfer-pending', 3, { targetDeviceBindingHash: DEV_NEW })).value;
  const completed = csm.applySubscriptionTransition(pending, mkEvent(pending, 'op4', 'transfer-completed', 4, { targetDeviceBindingHash: DEV_NEW })).value;
  const deviceBound = completed.deviceBindingHash === DEV_NEW;
  const pendingCleared = completed.pendingTargetDeviceBindingHash === '';
  // invariant from run-contract.js C-CSM-TRANSFER-FINALITY:
  const invariantHeld = deviceBound && pendingCleared;
  record({
    id: 'A3', family: 'family_a_production_logic',
    contract_refs: ['old envelope reuse', 'stale pending target'],
    target: 'commercial-state-machine.js transfer-completed (pendingTargetDeviceBindingHash not cleared)',
    mutation: 'pending target device is not cleared after transfer-completed, allowing the old envelope/target to be reused',
    intended_reason: 'after a completed transfer the old pending target must be cleared so the old wrapped-key/envelope cannot be reused',
    killed: !invariantHeld && !pendingCleared,
    detection: !pendingCleared ? 'C-CSM-TRANSFER-FINALITY invariant broke: pendingCleared=false (stale pending target retained)' : 'pendingCleared still true',
    evidence: 'deviceBound=' + deviceBound + ' pendingCleared=' + pendingCleared + ' pendingTarget=' + JSON.stringify(completed.pendingTargetDeviceBindingHash) + ' invariantHeld=' + invariantHeld,
  });
})();

// A4 — contract #7 (grace extension): offline-grace ceiling no longer rejects
// offlineGraceEndsAtMs > lastVerified + 7d. Re-run C-CSM-GRACE-CEILING.
(function A4() {
  const csm = loadMutantModule(CSM_PATH, (src) => src.replace('event.offlineGraceEndsAtMs > maximum', 'false'), 'A4-grace-extend');
  const sub0 = csm.createSubscription({ subscriptionId: 'sub-gc', deviceBindingHash: DEV_OLD, tier: 'pro' });
  const active = advance(csm, sub0, [{ op: 'op1', target: 'pending', rev: 1 }, { op: 'op2', target: 'active', rev: 2 }]);
  const overEv = mkEvent(active, 'op3', 'offline-grace', 3, { lastVerifiedOnlineAtMs: T0, offlineGraceEndsAtMs: T0 + csm.MAX_OFFLINE_GRACE_MS + 1 });
  const withinEv = mkEvent(active, 'op4', 'offline-grace', 3, { lastVerifiedOnlineAtMs: T0, offlineGraceEndsAtMs: T0 + 6 * DAY });
  const over = csm.applySubscriptionTransition(active, overEv);
  const within = csm.applySubscriptionTransition(active, withinEv);
  // invariant from run-contract.js C-CSM-GRACE-CEILING:
  const invariantHeld = over.ok === false && over.errorCode === 'invalid-offline-grace' && within.ok === true;
  record({
    id: 'A4', family: 'family_a_production_logic',
    contract_refs: ['grace extension', '7-day ceiling'],
    target: 'commercial-state-machine.js offline-grace ceiling (offlineGraceEndsAtMs > maximum -> false)',
    mutation: 'offline-grace ceiling disabled; grace can be extended beyond 7*24h',
    intended_reason: 'package content/settings/clock changes cannot extend grace beyond 7*24h; an over-7d grace must be rejected',
    killed: !invariantHeld && over.ok === true,
    detection: over.ok === true ? 'C-CSM-GRACE-CEILING invariant broke: over.ok=true (over-7d grace accepted)' : 'over-7d still rejected',
    evidence: 'over.ok=' + over.ok + ' over.code=' + over.errorCode + ' within.ok=' + within.ok + ' maxMs=' + csm.MAX_OFFLINE_GRACE_MS + ' invariantHeld=' + invariantHeld,
  });
})();

// A5 — contract #8 (clock rollback acceptance): validateSecurity no longer
// rejects clockValid=false. Re-run C-CSM-CLOCK-ANOMALY (transition side).
(function A5() {
  const csm = loadMutantModule(CSM_PATH, (src) => src.replace('if (event.clockValid !== true) return \'clock-anomaly\';', 'if (event.clockValid !== true && false) return \'clock-anomaly\';'), 'A5-clock-accept');
  const sub0 = csm.createSubscription({ subscriptionId: 'sub-clk', deviceBindingHash: DEV_OLD, tier: 'pro' });
  const pending = advance(csm, sub0, [{ op: 'op1', target: 'pending', rev: 1 }]);
  const evBadClock = mkEvent(pending, 'op2', 'active', 2, { clockValid: false });
  const res = csm.applySubscriptionTransition(pending, evBadClock);
  // invariant from run-contract.js C-CSM-CLOCK-ANOMALY (transition conjunct):
  const invariantHeld = res.ok === false && res.errorCode === 'clock-anomaly';
  record({
    id: 'A5', family: 'family_a_production_logic',
    contract_refs: ['clock rollback acceptance', 'clock anomaly fail-closed'],
    target: 'commercial-state-machine.js validateSecurity (event.clockValid guard neutralized)',
    mutation: 'clock-anomaly guard bypassed in transition validation; bad-clock transition accepted',
    intended_reason: 'a clock anomaly must fail closed; accepting a bad-clock transition permits rollback/forward-dated authority',
    killed: !invariantHeld && res.ok === true,
    detection: res.ok === true ? 'C-CSM-CLOCK-ANOMALY invariant broke: res.ok=true (bad-clock transition accepted)' : 'bad-clock still rejected',
    evidence: 'res.ok=' + res.ok + ' res.code=' + res.errorCode + ' invariantHeld=' + invariantHeld,
  });
})();

// A6 — contract #9 (grant-sequence rollback / stale-revision): stale-revision
// guard bypassed (event.revision <= current.revision -> <= -1). Re-run C-CSM-STALE-REVISION.
(function A6() {
  const csm = loadMutantModule(CSM_PATH, (src) => src.split('event.revision <= current.revision').join('event.revision <= -1'), 'A6-stale-accept');
  const sub0 = csm.createSubscription({ subscriptionId: 'sub-st', deviceBindingHash: DEV_OLD, tier: 'pro' });
  const pending = advance(csm, sub0, [{ op: 'op1', target: 'pending', rev: 1 }]);
  const stale = csm.applySubscriptionTransition(pending, mkEvent(pending, 'op2', 'active', 1)); // rev 1 <= current 1
  const ev1 = mkEvent(sub0, 'op1', 'pending', 1);
  const idem = csm.applySubscriptionTransition(pending, ev1);
  const ev1Conflict = mkEvent(sub0, 'op1', 'pending', 1, { revocationEpoch: 9 });
  const conflict = csm.applySubscriptionTransition(pending, ev1Conflict);
  // invariant from run-contract.js C-CSM-STALE-REVISION:
  const invariantHeld = stale.ok === false && stale.errorCode === 'stale-revision' && idem.ok === true && idem.idempotent === true && conflict.ok === false && conflict.errorCode === 'operation-conflict';
  record({
    id: 'A6', family: 'family_a_production_logic',
    contract_refs: ['revocation/grant rollback (grant-sequence/stale-revision)'],
    target: 'commercial-state-machine.js applySubscriptionTransition stale-revision guard (event.revision <= current.revision -> <= -1)',
    mutation: 'grant-sequence stale-revision guard bypassed; a replayed/lower revision is accepted',
    intended_reason: 'grant-sequence rollback/replay must be rejected; accepting a stale revision lets an old grant replay over a newer one',
    killed: !invariantHeld && stale.ok === true,
    detection: stale.ok === true ? 'C-CSM-STALE-REVISION invariant broke: stale.ok=true (stale revision accepted)' : 'stale still rejected',
    evidence: 'stale.ok=' + stale.ok + ' stale.code=' + stale.errorCode + ' idem.ok=' + idem.ok + ' idem.idem=' + idem.idempotent + ' conflict.ok=' + conflict.ok + ' conflict.code=' + conflict.errorCode + ' invariantHeld=' + invariantHeld,
  });
})();

// A7 — contract #10 (entitlement/handler bypass): access() computeAvailable
// always true (AI compute gate removed). Re-run C-ENT-COMPUTE.
(function A7() {
  const ent = loadMutantModule(ENT_PATH, (src) => src.replace('!isAiFeature || current.aiUnlocked === true', 'true'), 'A7-compute-bypass');
  const accLocked = ent.access('ai-report', { activated: true, tier: 'pro', aiUnlocked: false });
  const accUnlocked = ent.access('ai-report', { activated: true, tier: 'pro', aiUnlocked: true });
  // invariant from run-contract.js C-ENT-COMPUTE:
  const invariantHeld = accLocked.eligible === true && accLocked.computeAvailable === false && accUnlocked.computeAvailable === true;
  record({
    id: 'A7', family: 'family_a_production_logic',
    contract_refs: ['entitlement/handler bypass', 'compute/provider gate'],
    target: 'entitlements.js access() (computeAvailable: !isAiFeature || aiUnlocked -> true)',
    mutation: 'compute/provider permission gate removed; AI compute available even when aiUnlocked=false',
    intended_reason: 'compute/provider permission is a separate gate from Flagship entitlement; bypassing it grants paid compute without provider authorization',
    killed: !invariantHeld && accLocked.computeAvailable === true,
    detection: accLocked.computeAvailable === true ? 'C-ENT-COMPUTE invariant broke: locked.computeAvailable=true (compute gate bypassed)' : 'compute gate still enforced',
    evidence: 'locked.eligible=' + accLocked.eligible + ' locked.computeAvailable=' + accLocked.computeAvailable + ' unlocked.computeAvailable=' + accUnlocked.computeAvailable + ' invariantHeld=' + invariantHeld,
  });
})();

// ════════════════════════════════════════════════════════════════════════════
// FAMILY B — harness-logic mutations (doctored artifacts in a temp verify dir;
// the INDEPENDENT verifier verify-artifacts.js must exit nonzero).
// ════════════════════════════════════════════════════════════════════════════

function makeTempVerifyDir(label) {
  const d = path.join(TMP_BASE, 'verify-' + label);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function copyJson(src) { return JSON.parse(fs.readFileSync(src, 'utf8')); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8'); }
function readRealArtifact(name) { return copyJson(path.join(HARNESS_DIR, name)); }

// B8 — contract #1/#2 (fabricated missing API / parser bypass): a CONFIRMED
// check label is doctored to claim "XJSUP parser present". Counts are kept
// consistent so the ONLY detector is the verifier's false-runtime regex.
(function B8() {
  const dir = makeTempVerifyDir('B8');
  const result = readRealArtifact('contract-result.json');
  const matrix = readRealArtifact('contract-matrix.json');
  // tamper a CONFIRMED row label to claim a fabricated parser capability
  const idx = result.checks.findIndex((c) => c.id === 'C-CSM-QUOTA-DEBIT');
  result.checks[idx].label = 'quota enforced; XJSUP parser confirmed present';
  const mrow = matrix.rows.find((r) => r.id === 'C-CSM-QUOTA-DEBIT');
  mrow.capability = result.checks[idx].label; // keep matrix consistent
  writeJson(path.join(dir, 'contract-result.json'), result);
  writeJson(path.join(dir, 'contract-matrix.json'), matrix);
  const res = runNode(VERIFY_ARTIFACTS_JS, { XJ_TASK28_VERIFY_OUT_DIR: dir });
  const killed = res.status !== 0;
  const matched = /noFalseConfirmedRuntime|false-runtime regex|CONFIRMED check\(s\) match false-runtime/i.test(res.stdout + res.stderr);
  record({
    id: 'B8', family: 'family_b_harness_logic',
    contract_refs: ['fabricated missing API', 'parser bypass'],
    target: 'contract-result.json doctored CONFIRMED label claiming XJSUP parser',
    mutation: 'fabricate a missing XJSUP parser API as a CONFIRMED capability (counts doctored to match)',
    intended_reason: 'a fabricated missing-API must NOT be counted as a confirmed capability; the verifier independently rejects it via the false-runtime regex',
    killed: killed && matched,
    detection: killed ? ('verify-artifacts.js exit=' + res.status + ' (false-runtime regex rejected fabricated parser)') : 'verify-artifacts.js exit=0 (would be a false confirm)',
    evidence: 'exit=' + res.status + ' matchedFalseRuntime=' + matched,
  });
})();

// B9 — contract #3 (decrypt-before-signature): E-SIGNATURE-BEFORE-DECRYPT is
// promoted from EXPECTED_RED to CONFIRMED (counts re-balanced). The verifier
// must catch it via noExpectedRedPromoted + noFalseConfirmedRuntime.
(function B9() {
  const dir = makeTempVerifyDir('B9');
  const result = readRealArtifact('contract-result.json');
  const idx = result.checks.findIndex((c) => c.id === 'E-SIGNATURE-BEFORE-DECRYPT');
  result.checks[idx].classification = 'CONFIRMED';
  result.expected_red = result.checks.filter((c) => c.classification === 'EXPECTED_RED').length;
  result.confirmed = result.checks.filter((c) => c.classification === 'CONFIRMED').length;
  writeJson(path.join(dir, 'contract-result.json'), result);
  writeJson(path.join(dir, 'contract-matrix.json'), readRealArtifact('contract-matrix.json'));
  const res = runNode(VERIFY_ARTIFACTS_JS, { XJ_TASK28_VERIFY_OUT_DIR: dir });
  const killed = res.status !== 0;
  const promoted = /noExpectedRedPromoted|promoted/i.test(res.stdout + res.stderr);
  const falseRuntime = /noFalseConfirmedRuntime|false-runtime regex|CONFIRMED check\(s\) match false-runtime/i.test(res.stdout + res.stderr);
  record({
    id: 'B9', family: 'family_b_harness_logic',
    contract_refs: ['decrypt-before-signature', 'signature-before-decrypt promotion'],
    target: 'contract-result.json E-SIGNATURE-BEFORE-DECRYPT promoted EXPECTED_RED -> CONFIRMED',
    mutation: 'promote the signature-before-decrypt gap to CONFIRMED (claiming a real decrypt/signature path exists)',
    intended_reason: 'no signature-before-decrypt path exists; promoting it to CONFIRMED must be independently rejected (no false confirmed runtime, no expected-red promotion)',
    killed: killed && (promoted || falseRuntime),
    detection: killed ? ('verify-artifacts.js exit=' + res.status + ' (promoted=' + promoted + ' falseRuntime=' + falseRuntime + ')') : 'verify-artifacts.js exit=0 (promotion would stand)',
    evidence: 'exit=' + res.status + ' promoted=' + promoted + ' falseRuntime=' + falseRuntime,
  });
})();

// B10 — contract #11 (plaintext persistence/logging): a secret-like marker is
// injected into contract-result.json. The verifier's deepSecretScan must catch it.
(function B10() {
  const dir = makeTempVerifyDir('B10');
  const result = readRealArtifact('contract-result.json');
  result.devicePrivateKeyLeak = '-----BEGIN PRIVATE KEY-----\nFAKE-MATERIAL-FOR-SECRET-SCAN-ONLY\n-----END PRIVATE KEY-----';
  writeJson(path.join(dir, 'contract-result.json'), result);
  writeJson(path.join(dir, 'contract-matrix.json'), readRealArtifact('contract-matrix.json'));
  const res = runNode(VERIFY_ARTIFACTS_JS, { XJ_TASK28_VERIFY_OUT_DIR: dir });
  const killed = res.status !== 0;
  const matched = /secret-like material|secret-like|PRIVATE KEY|deepSecretScan/i.test(res.stdout + res.stderr);
  record({
    id: 'B10', family: 'family_b_harness_logic',
    contract_refs: ['plaintext persistence/logging', 'key non-exposure'],
    target: 'contract-result.json injected with a secret-like key marker',
    mutation: 'inject plaintext/key-like material into an artifact (simulating plaintext persistence or logging)',
    intended_reason: 'no package plaintext or device-key material may appear in renderer, store, logs, backup, export or release evidence; the verifier must reject it',
    killed: killed && matched,
    detection: killed ? ('verify-artifacts.js exit=' + res.status + ' (secret-marker scan rejected injected key material)') : 'verify-artifacts.js exit=0 (secret material would leak)',
    evidence: 'exit=' + res.status + ' matchedSecret=' + matched,
  });
})();

// B11 — contract #12 (forced exit zero after semantic failure): contract-result.json
// has a check with pass=false but failed=0 (doctored), simulating a mutant
// run-contract.js that exits 0 despite a semantic failure. The verifier's
// INDEPENDENT recount must catch it. This is the non-circular backstop.
(function B11() {
  const dir = makeTempVerifyDir('B11');
  const result = readRealArtifact('contract-result.json');
  const idx = result.checks.findIndex((c) => c.id === 'C-CSM-QUOTA-DEBIT');
  result.checks[idx].pass = false; // semantic failure
  // DOCTOR the recorded counts to try to hide the failure (failed stays 0)
  result.failed = 0;
  result.overall = 'EXPECTED_RED';
  writeJson(path.join(dir, 'contract-result.json'), result);
  writeJson(path.join(dir, 'contract-matrix.json'), readRealArtifact('contract-matrix.json'));
  const res = runNode(VERIFY_ARTIFACTS_JS, { XJ_TASK28_VERIFY_OUT_DIR: dir });
  const killed = res.status !== 0;
  const recounted = /recounted failed|pass!==true|failed must be 0/i.test(res.stdout + res.stderr);
  record({
    id: 'B11', family: 'family_b_harness_logic',
    contract_refs: ['forced exit zero after semantic failure'],
    target: 'contract-result.json doctored: one check pass=false but failed=0 (forced-exit-zero mutant)',
    mutation: 'a mutant that forces exit(0) after writing a result with a semantic failure (pass=false, failed doctored to 0)',
    intended_reason: 'a forced exit(0) cannot hide a semantic failure; the verifier reads the result data and independently recounts pass!=true as failed',
    killed: killed && recounted,
    detection: killed ? ('verify-artifacts.js exit=' + res.status + ' (independent recount detected pass=false despite doctored failed=0)') : 'verify-artifacts.js exit=0 (semantic failure would be hidden by exit 0)',
    evidence: 'exit=' + res.status + ' recounted=' + recounted,
  });
})();

// B12 — contract #6 (delayed revocation): the matrix row E-ONLINE-REVOCATION-FETCH
// is doctored to claim a real production entry point (immediate revocation fetch
// exists). The verifier's matrix entry-point check must catch it.
(function B12() {
  const dir = makeTempVerifyDir('B12');
  const result = readRealArtifact('contract-result.json');
  const matrix = readRealArtifact('contract-matrix.json');
  const mrow = matrix.rows.find((r) => r.id === 'E-ONLINE-REVOCATION-FETCH');
  mrow.production_entry_point = 'app/js/cloud-verify.js fetchRevocation (fabricated immediate-revocation fetch)';
  writeJson(path.join(dir, 'contract-result.json'), result);
  writeJson(path.join(dir, 'contract-matrix.json'), matrix);
  const res = runNode(VERIFY_ARTIFACTS_JS, { XJ_TASK28_VERIFY_OUT_DIR: dir });
  const killed = res.status !== 0;
  const matched = /NO PRODUCTION ENTRY|noEntry|lacking NO PRODUCTION ENTRY|EXPECTED_RED matrix row/i.test(res.stdout + res.stderr);
  record({
    id: 'B12', family: 'family_b_harness_logic',
    contract_refs: ['delayed revocation', 'online revocation fetch'],
    target: 'contract-matrix.json E-ONLINE-REVOCATION-FETCH entry_point doctored to a real surface',
    mutation: 'fabricate an immediate online package-revocation fetch entry point (claiming no delayed-revocation gap)',
    intended_reason: 'no online package-revocation fetch exists; claiming one must be independently rejected so the delayed-revocation gap stays EXPECTED_RED',
    killed: killed && matched,
    detection: killed ? ('verify-artifacts.js exit=' + res.status + ' (matrix entry-point check rejected fabricated revocation surface)') : 'verify-artifacts.js exit=0 (gap would be hidden)',
    evidence: 'exit=' + res.status + ' matchedEntryCheck=' + matched,
  });
})();

// ════════════════════════════════════════════════════════════════════════════
// FAMILY C — drift before write (tampered protected inputs supplied via env;
// run-contract.js must exit(1) at the module-top gate with ZERO artifact writes)
// ════════════════════════════════════════════════════════════════════════════

// C13 — manifest byte-hash drift: a temp manifest with a tampered recorded hash.
// run-contract.js must exit(1) at the byte-hash gate and write ZERO artifacts.
(function C13() {
  const manifestCopy = JSON.parse(manifestRaw.toString('utf8'));
  manifestCopy.files[0].sha256 = '00'.repeat(32).toUpperCase(); // tamper main.js recorded hash
  const tmpManifestDir = path.join(TMP_BASE, 'manifest-C13');
  fs.mkdirSync(tmpManifestDir, { recursive: true });
  const tmpManifestPath = path.join(tmpManifestDir, 'protected-files-manifest.json');
  fs.writeFileSync(tmpManifestPath, JSON.stringify(manifestCopy, null, 2) + '\n', 'utf8');
  const tmpOutDir = path.join(TMP_BASE, 'out-C13');
  fs.mkdirSync(tmpOutDir, { recursive: true });
  const res = runNode(RUN_CONTRACT_JS, { XJ_TASK28_MANIFEST_PATH: tmpManifestPath, XJ_TASK28_OUT_DIR: tmpOutDir });
  const blocked = res.status !== 0 && /manifest byte hash mismatch|protected-files manifest byte hash mismatch/i.test(res.stdout + res.stderr);
  const wroteResult = fs.existsSync(path.join(tmpOutDir, 'contract-result.json'));
  const wroteMatrix = fs.existsSync(path.join(tmpOutDir, 'contract-matrix.json'));
  const zeroWrites = !wroteResult && !wroteMatrix;
  record({
    id: 'C13', family: 'family_c_drift_before_write',
    contract_refs: ['protected manifest byte-hash drift gate'],
    target: 'protected-files-manifest.json tampered recorded hash (byte content changed)',
    mutation: 'drift the protected-files manifest byte hash before any task write',
    intended_reason: 'any protected-manifest tampering must block before any artifact write; the harness must not silently write under a drifted manifest',
    killed: blocked && zeroWrites,
    detection: blocked && zeroWrites ? 'run-contract.js exit=' + res.status + ' at byte-hash gate, zero artifacts written' : 'no byte-hash block or artifacts were written',
    evidence: 'exit=' + res.status + ' blocked=' + blocked + ' wroteResult=' + wroteResult + ' wroteMatrix=' + wroteMatrix + ' zeroWrites=' + zeroWrites,
  });
})();

// C14 — per-file hash drift (isolated): real manifest (byte hash matches) but a
// temp PROTECTED_ROOT where one protected file is tampered. run-contract.js must
// exit(1) at the per-file gate (after the byte-hash gate passes) with ZERO writes.
(function C14() {
  const tmpRoot = path.join(TMP_BASE, 'root-C14');
  manifest.files.forEach((f) => {
    const src = path.join(ROOT, f.path);
    const dst = path.join(tmpRoot, f.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, fs.readFileSync(src));
  });
  // tamper the temp copy of main.js by appending one byte
  const mainTmp = path.join(tmpRoot, 'main.js');
  fs.writeFileSync(mainTmp, fs.readFileSync(mainTmp) + '\n');
  const tmpOutDir = path.join(TMP_BASE, 'out-C14');
  fs.mkdirSync(tmpOutDir, { recursive: true });
  const res = runNode(RUN_CONTRACT_JS, { XJ_TASK28_PROTECTED_ROOT: tmpRoot, XJ_TASK28_OUT_DIR: tmpOutDir });
  const blocked = res.status !== 0 && /protected hash mismatch|protected-file hash mismatch/i.test(res.stdout + res.stderr);
  const wroteResult = fs.existsSync(path.join(tmpOutDir, 'contract-result.json'));
  const wroteMatrix = fs.existsSync(path.join(tmpOutDir, 'contract-matrix.json'));
  const zeroWrites = !wroteResult && !wroteMatrix;
  record({
    id: 'C14', family: 'family_c_drift_before_write',
    contract_refs: ['protected per-file hash drift gate'],
    target: 'protected main.js tampered in a temp PROTECTED_ROOT (real manifest unchanged)',
    mutation: 'drift a protected production file hash while the manifest byte hash still matches',
    intended_reason: 'a tampered protected production file must block before any artifact write even when the manifest byte hash is valid; the per-file gate is independent',
    killed: blocked && zeroWrites,
    detection: blocked && zeroWrites ? 'run-contract.js exit=' + res.status + ' at per-file gate (byte-hash gate passed), zero artifacts written' : 'no per-file block or artifacts were written',
    evidence: 'exit=' + res.status + ' blocked=' + blocked + ' wroteResult=' + wroteResult + ' wroteMatrix=' + wroteMatrix + ' zeroWrites=' + zeroWrites,
  });
})();

// ════════════════════════════════════════════════════════════════════════════
// mutation-result.json (deterministic; non-exposure scanned before write)
// ════════════════════════════════════════════════════════════════════════════

const killedCount = probes.filter((p) => p.killed).length;
const survivors = probes.filter((p) => !p.killed);
const minimumRequired = 12;

const mutationResult = {
  task_id: TASK_ID,
  base_commit: EXPECTED_BASE_COMMIT,
  contract_id: CONTRACT_ID,
  write_lock_id: WRITE_LOCK_ID,
  grant_id: GRANT_ID,
  protected_files_manifest_sha256: EXPECTED_MANIFEST_HASH,
  determinism: 'no volatile fields; no timestamps/random/hash-bound values; volatile diagnostics are stdout-only',
  minimum_required: minimumRequired,
  killed_count: killedCount,
  total: probes.length,
  survivors: survivors.length,
  overall: (killedCount === probes.length && killedCount >= minimumRequired) ? 'ALL_KILLED' : 'HAS_SURVIVORS',
  families: {
    family_a_production_logic: probes.filter((p) => p.family === 'family_a_production_logic').length,
    family_b_harness_logic: probes.filter((p) => p.family === 'family_b_harness_logic').length,
    family_c_drift_before_write: probes.filter((p) => p.family === 'family_c_drift_before_write').length,
  },
  contract_coverage: {
    'fabricated missing API': 'B8',
    'parser bypass': 'B8',
    'decrypt-before-signature': 'B9',
    'dual-active grant': 'A2',
    'old envelope reuse': 'A3',
    'delayed revocation': 'B12',
    'grace extension': 'A4',
    'clock rollback acceptance': 'A5',
    'revocation rollback (epoch)': 'A1',
    'grant rollback (stale-revision)': 'A6',
    'entitlement/handler bypass': 'A7',
    'plaintext persistence/logging': 'B10',
    'forced exit zero after semantic failure': 'B11',
    'protected manifest drift gate': 'C13',
    'protected per-file drift gate': 'C14',
  },
  probes: probes.map((p) => ({
    id: p.id,
    family: p.family,
    contract_refs: p.contract_refs,
    target: p.target,
    mutation: p.mutation,
    intended_reason: p.intended_reason,
    killed: p.killed,
    detection: p.detection,
    evidence: p.evidence,
  })),
};

// Non-exposure scan over mutation-result.json before writing
function deepSecretScan(obj) {
  const found = [];
  const visit = (v) => {
    if (typeof v === 'string') SECRET_MARKERS.forEach((mk) => { if (v.indexOf(mk) !== -1) found.push(mk); });
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(obj);
  return found;
}
const secrets = deepSecretScan(mutationResult);
if (secrets.length > 0) {
  // B10 deliberately writes a secret marker into a TEMP verify artifact; that marker
  // must NOT leak into mutation-result.json. If it does, block before writing.
  console.error('[BLOCKED] secret-like material detected in mutation-result.json: ' + JSON.stringify(secrets));
  process.exit(1);
}

fs.writeFileSync(path.join(HARNESS_DIR, 'mutation-result.json'), JSON.stringify(mutationResult, null, 2) + '\n', 'utf8');

// ── Summary + exit ───────────────────────────────────────────────────────────
console.log('----------------------------------------');
console.log('task 28 mutation-probes.js summary:');
console.log('  killed=' + killedCount + '/' + probes.length + ' survivors=' + survivors.length + ' minimum_required=' + minimumRequired);
console.log('  families=' + JSON.stringify(mutationResult.families));
console.log('  overall=' + mutationResult.overall);
console.log('  manifestByteHash=' + manifestByteHash);
if (survivors.length > 0) {
  console.error('[FAIL] survivors: ' + survivors.map((p) => p.id).join(','));
  process.exit(1);
}
if (killedCount < minimumRequired) {
  console.error('[FAIL] killed_count ' + killedCount + ' < minimum_required ' + minimumRequired);
  process.exit(1);
}
process.exit(0);
