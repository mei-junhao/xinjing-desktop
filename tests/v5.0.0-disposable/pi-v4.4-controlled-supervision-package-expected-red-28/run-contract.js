'use strict';
/**
 * XJ-5.0.0 Pi 4.4 Controlled Supervision Package Expected-Red — Contract Runner (task 28)
 *
 * Executes the REAL current production modules through their actual export/runtime
 * surface and classifies the exact remaining 4.4-G controlled-supervision-package
 * gap against contract v4.4-controlled-supervision-package-v1:
 *
 *   CONFIRMED (real executed pure-logic invariants):
 *     - entitlements Flagship/compute/trial/Free-manual fail-closed boundaries
 *     - commercial-state-machine revocation-epoch rollback, single-device binding,
 *       transfer atomicity (no dual-active), interrupted-migration recovery,
 *       7-day offline-grace ceiling, grace-expiry run-disable, clock-anomaly,
 *       signature-required, stale-revision/idempotency/conflict, quota limits
 *     - license-core license-CODE revocation list (scoped: NOT XJSUP package epoch)
 *
 *   EXPECTED_RED (absent — proven by real enumeration of real modules/IPC):
 *     - XJSUP/1 parser, canonical package manifest, signature-before-decrypt,
 *       recipient envelope unwrap, install/run API, typed inspect/install/run IPC,
 *       commercial-state-machine runtime WIRING (orphan), author-key custody,
 *       online package-revocation fetch, per-package provider-policy registry,
 *       package-plaintext non-exposure runtime enforcement
 *
 * The overall result stays EXPECTED_RED until the production runtime is implemented
 * and accepted on one candidate SHA (contract §6). The commercial-state-machine is
 * real pure logic but is NOT wired into any main/preload/renderer path, so it proves
 * the invariants exist as logic, NOT that any runtime calls them.
 *
 * Determinism: contract-result.json and contract-matrix.json carry NO volatile
 * (timestamp/random/hash-bound) fields; volatile diagnostics are stdout-only.
 *
 * Env overrides (used ONLY by mutation-probes.js against OS-temporary copies):
 *   XJ_TASK28_OUT_DIR        — artifact output directory (default: harness dir)
 *   XJ_TASK28_MANIFEST_PATH  — protected-files manifest path (default: real)
 *   XJ_TASK28_PROTECTED_ROOT — root for resolving protected files (default: ROOT)
 * When unset, the real manifest and real project root are used, so production
 * behavior is unchanged.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve('D:\\xinjing-electron');
const HARNESS_DIR = path.join(ROOT, 'tests', 'v5.0.0-disposable', 'pi-v4.4-controlled-supervision-package-expected-red-28');
const OUT_DIR = process.env.XJ_TASK28_OUT_DIR ? path.resolve(process.env.XJ_TASK28_OUT_DIR) : HARNESS_DIR;
const MANIFEST_PATH = process.env.XJ_TASK28_MANIFEST_PATH ? path.resolve(process.env.XJ_TASK28_MANIFEST_PATH) : path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'pi-v4.4-controlled-supervision-package-expected-red-28', 'protected-files-manifest.json');
const PROTECTED_ROOT = process.env.XJ_TASK28_PROTECTED_ROOT ? path.resolve(process.env.XJ_TASK28_PROTECTED_ROOT) : ROOT;

const TASK_ID = 'XJ-5.0.0-pi-v4.4-controlled-supervision-package-expected-red-28';
const BASE_COMMIT = '9971787eb6e443ab5a5c80aee118b9b43285c093';
const CONTRACT_ID = 'v4.4-controlled-supervision-package-v1';
const WRITE_LOCK_ID = 'lock-XJ-5.0.0-pi-v4.4-controlled-supervision-package-expected-red-28';
const GRANT_ID = 'local-codex-20260727T192730Z-pi-v4.4-supervision-package-expected-red-28';
const MANIFEST_HASH = '5941356B7B24CB1D24A6B6A011C37E024F4763A13BBFB4E91263B28115A18033';

const ENT_PATH = path.join(ROOT, 'app', 'js', 'entitlements.js');
const CSM_PATH = path.join(ROOT, 'app', 'js', 'commercial-state-machine.js');
const LIC_PATH = path.join(ROOT, 'license-core.js');
const CV_PATH = path.join(ROOT, 'cloud-verify.js');
const MAIN_PATH = path.join(ROOT, 'main.js');
const PRELOAD_PATH = path.join(ROOT, 'preload.js');
const STORE_PATH = path.join(ROOT, 'app', 'js', 'store.js');
const SUP_PATH = path.join(ROOT, 'app', 'js', 'supervision.js');
const RSUP_PATH = path.join(ROOT, 'app', 'js', 'real-supervision.js');

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }
function sha256Str(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase(); }

// ──────────────────────────────────────────────────────────────────────────
// Precondition: verify protected-files manifest byte hash + all ten protected
// per-file hashes (BLOCKED on mismatch). Both gates run at module top BEFORE
// main() is invoked, so any one-byte protected-input drift forces exit(1) with
// ZERO artifact writes. Proven by mutation probes M13 + M14.
// ──────────────────────────────────────────────────────────────────────────
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const manifestByteHash = sha256(MANIFEST_PATH);
if (manifestByteHash !== MANIFEST_HASH) {
  console.error('[BLOCKED] protected-files manifest byte hash mismatch: ' + manifestByteHash + ' != ' + MANIFEST_HASH);
  process.exit(1);
}
let hashFailures = 0;
manifest.files.forEach((f) => {
  const p = path.join(PROTECTED_ROOT, f.path);
  const actual = fs.existsSync(p) ? sha256(p) : 'MISSING';
  if (actual !== f.sha256.toUpperCase()) {
    hashFailures++;
    console.error('[BLOCKED] protected hash mismatch: ' + f.path + ' -> ' + actual + ' != ' + f.sha256.toUpperCase());
  }
});
if (hashFailures > 0) {
  console.error('[BLOCKED] ' + hashFailures + ' protected-file hash mismatch(es); aborting before any task write.');
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────────
// Real production module loading. entitlements.js, commercial-state-machine.js
// and license-core.js are Node-requireable (UMD/CommonJS). They are loaded from
// the REAL project root (never mutated). cloud-verify.js / main.js / preload.js
// / store.js / supervision.js / real-supervision.js are READ as source for
// surface/enumeration evidence (cloud-verify is not required to avoid any
// network-touching code path; its export shape is read from source).
// ──────────────────────────────────────────────────────────────────────────
const XJEntitlements = require(ENT_PATH);
const XJCommercialStateMachine = require(CSM_PATH);
const licenseCore = require(LIC_PATH);

function readText(p) { return fs.readFileSync(p, 'utf8'); }

const checks = [];
let confirmedCount = 0, expectedRedCount = 0, unverifiedCount = 0, failedCount = 0;

function check(id, label, cond, classification, category, evidence) {
  const ok = !!cond;
  const cls = classification || (ok ? 'CONFIRMED' : 'EXPECTED_RED');
  if (cls === 'CONFIRMED') { if (ok) confirmedCount++; else failedCount++; }
  else if (cls === 'EXPECTED_RED') { if (ok) expectedRedCount++; else failedCount++; }
  else if (cls === 'UNVERIFIED') { if (ok) unverifiedCount++; else failedCount++; }
  checks.push({ id, label, pass: ok, classification: cls, category: category || '', evidence: evidence || '' });
  const tag = !ok ? 'FAIL' : (cls === 'EXPECTED_RED' ? 'EXPECTED_RED' : 'PASS');
  console.log('[' + tag + '] ' + id + ' (' + cls + '/' + (category || '') + '): ' + label);
  if (evidence) console.log('    evidence: ' + evidence);
  return ok;
}

// ──────────────────────────────────────────────────────────────────────────
// CONFIRMED: entitlements fail-closed / compute / Free-manual / trial-bounded
// ──────────────────────────────────────────────────────────────────────────
const ent = XJEntitlements;

// C-ENT-FC-TIER: unknown/expired/malformed entitlement fails closed to free
const etUnknown = ent.effectiveTier({ activated: false });
const etExpired = ent.effectiveTier({ activated: true, tier: 'flagship' }); // 'flagship' not a known tier -> normalizeTier -> free
const etMalformed = ent.effectiveTier({ activated: true, tier: null });
const ntUnknown = ent.normalizeTier('flagship');
check('C-ENT-FC-TIER',
  'unknown/malformed/expired entitlement tier fails closed to free, never pro/custom',
  etUnknown === 'free' && etExpired === 'free' && etMalformed === 'free' && ntUnknown === 'free',
  'CONFIRMED', 'fail-closed',
  'etUnknown=' + etUnknown + ' etExpired=' + etExpired + ' etMalformed=' + etMalformed + ' ntUnknown=' + ntUnknown);

// C-ENT-COMPUTE: compute/provider permission is a SEPARATE gate (access.computeAvailable)
const accLocked = ent.access('ai-report', { activated: true, tier: 'pro', aiUnlocked: false });
const accUnlocked = ent.access('ai-report', { activated: true, tier: 'pro', aiUnlocked: true });
check('C-ENT-COMPUTE',
  'compute/provider permission is a separate gate (access.computeAvailable=false when aiUnlocked false)',
  accLocked.eligible === true && accLocked.computeAvailable === false && accUnlocked.computeAvailable === true,
  'CONFIRMED', 'fail-closed',
  'locked.eligible=' + accLocked.eligible + ' locked.computeAvailable=' + accLocked.computeAvailable + ' unlocked.computeAvailable=' + accUnlocked.computeAvailable);

// C-ENT-FREE-MANUAL: Free manual not paywalled (manual-core minimumTier=free)
const canUseManualFree = ent.canUse('manual-core', { activated: false });
const manualMinTier = ent.minimumTier('manual-core');
check('C-ENT-FREE-MANUAL',
  'Free manual workflow not paywalled (manual-core minimumTier=free, canUse=true under free)',
  canUseManualFree === true && manualMinTier === 'free',
  'CONFIRMED', 'positive',
  'canUseManualFree=' + canUseManualFree + ' manualMinTier=' + manualMinTier);

// C-ENT-TRIAL-BOUNDED: trial is a bounded overlay; effectiveTier stays free; custom not granted
const trialState = { activated: false, mode: 'trial', aiUnlocked: true };
const trialActive = ent.isTrialActive(trialState);
const trialEffTier = ent.effectiveTier(trialState);
const trialCanUseCustom = ent.canUse('custom-supervisors', trialState);
const trialCanUseAiReport = ent.canUse('ai-report', trialState);
check('C-ENT-TRIAL-BOUNDED',
  'Trial is a bounded overlay: effectiveTier stays free, custom/Flagship not granted (only trialEligible pro features)',
  trialActive === true && trialEffTier === 'free' && trialCanUseCustom === false && trialCanUseAiReport === true,
  'CONFIRMED', 'trial-quota',
  'trialActive=' + trialActive + ' trialEffTier=' + trialEffTier + ' trialCanUseCustom=' + trialCanUseCustom + ' trialCanUseAiReport=' + trialCanUseAiReport);

// ──────────────────────────────────────────────────────────────────────────
// CONFIRMED: commercial-state-machine pure-logic security invariants
// ──────────────────────────────────────────────────────────────────────────
const csm = XJCommercialStateMachine;
const DEV_OLD = 'dev-old-hash', DEV_NEW = 'dev-new-hash', DEV_WRONG = 'dev-wrong-hash';
const DAY = 86400000;
const T0 = 1753000000000; // fixed synthetic epoch (deterministic; no Date.now in artifacts)

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
// advance a subscription through a chain of otherwise-valid transitions; throws on any failure
function advance(sub0, chain) {
  let sub = sub0;
  chain.forEach((c) => {
    const ev = mkEvent(sub, c.op, c.target, c.rev, c.extra);
    const res = csm.applySubscriptionTransition(sub, ev);
    if (!res.ok) throw new Error('advance failed at ' + c.op + ': ' + res.errorCode);
    sub = res.value;
  });
  return sub;
}

// C-CSM-REVOKE-ROLLBACK: event.revocationEpoch < current.revocationEpoch -> rejected
{
  const sub = csm.createSubscription({ subscriptionId: 'sub-rr', deviceBindingHash: DEV_OLD, tier: 'pro', revocationEpoch: 5 });
  const ev = mkEvent(sub, 'op1', 'pending', 1, { revocationEpoch: 3 }); // 3 < 5
  const res = csm.applySubscriptionTransition(sub, ev);
  check('C-CSM-REVOKE-ROLLBACK',
    'revocation-epoch rollback rejected (event.revocationEpoch < current)',
    res.ok === false && res.errorCode === 'revocation-rollback',
    'CONFIRMED', 'fail-closed',
    'res.ok=' + res.ok + ' code=' + res.errorCode);
}

// C-CSM-DEVICE-MISMATCH: event.deviceBindingHash !== current -> rejected
{
  const sub = csm.createSubscription({ subscriptionId: 'sub-dm', deviceBindingHash: DEV_OLD, tier: 'pro' });
  const ev = mkEvent(sub, 'op1', 'pending', 1, { deviceBindingHash: 'dev-other' });
  const res = csm.applySubscriptionTransition(sub, ev);
  check('C-CSM-DEVICE-MISMATCH',
    'device mismatch rejected (single-device binding; copying file does not copy authority)',
    res.ok === false && res.errorCode === 'device-mismatch',
    'CONFIRMED', 'fail-closed',
    'res.ok=' + res.ok + ' code=' + res.errorCode);
}

// C-CSM-TRANSFER-ATOMIC: full migration chain active->transfer-pending->transfer-completed->active;
// at every state the deviceBindingHash is single-valued and at most one device has paid access (no dual-active).
{
  function subAcc(rec, dev) {
    return csm.subscriptionAccess(rec, { signatureValid: true, clockValid: true, revocationEpoch: rec.revocationEpoch, deviceBindingHash: dev, nowMs: T0 });
  }
  const sub0 = csm.createSubscription({ subscriptionId: 'sub-ta', deviceBindingHash: DEV_OLD, tier: 'pro' });
  const activeOld = advance(sub0, [
    { op: 'op1', target: 'pending', rev: 1 },
    { op: 'op2', target: 'active', rev: 2 },
  ]);
  const pending = csm.applySubscriptionTransition(activeOld, mkEvent(activeOld, 'op3', 'transfer-pending', 3, { targetDeviceBindingHash: DEV_NEW })).value;
  const completed = csm.applySubscriptionTransition(pending, mkEvent(pending, 'op4', 'transfer-completed', 4, { targetDeviceBindingHash: DEV_NEW })).value;
  const activeNew = csm.applySubscriptionTransition(completed, mkEvent(completed, 'op5', 'active', 5)).value;
  const aOldOld = subAcc(activeOld, DEV_OLD).paidAccessAllowed;   // true (active+match)
  const aOldNew = subAcc(activeOld, DEV_NEW).paidAccessAllowed;   // false (device-mismatch)
  const aPendOld = subAcc(pending, DEV_OLD).paidAccessAllowed;    // false (state-not-active)
  const aPendNew = subAcc(pending, DEV_NEW).paidAccessAllowed;    // false (device-mismatch)
  const aCompOld = subAcc(completed, DEV_OLD).paidAccessAllowed;  // false (device-mismatch; device swapped)
  const aCompNew = subAcc(completed, DEV_NEW).paidAccessAllowed;  // false (state-not-active)
  const aNewOld = subAcc(activeNew, DEV_OLD).paidAccessAllowed;   // false (device-mismatch)
  const aNewNew = subAcc(activeNew, DEV_NEW).paidAccessAllowed;   // true (active+match)
  const noDualActive = !(aOldOld && aOldNew) && !(aPendOld && aPendNew) && !(aCompOld && aCompNew) && !(aNewOld && aNewNew);
  const deviceSwapped = completed.deviceBindingHash === DEV_NEW && activeOld.deviceBindingHash === DEV_OLD;
  const oldDeniedAfter = aNewOld === false && subAcc(activeNew, DEV_OLD).errorCode === 'device-mismatch';
  const newActiveAfter = aNewNew === true;
  check('C-CSM-TRANSFER-ATOMIC',
    'transfer is atomic across the full chain: deviceBindingHash stays single-valued; at most one device has paid access at any state; after migration old is denied and new is enabled',
    aOldOld === true && noDualActive && deviceSwapped && oldDeniedAfter && newActiveAfter,
    'CONFIRMED', 'fail-closed',
    'activeOld.old=' + aOldOld + ' activeOld.new=' + aOldNew + ' pending.old=' + aPendOld + ' pending.new=' + aPendNew + ' completed.old=' + aCompOld + ' completed.new=' + aCompNew + ' activeNew.old=' + aNewOld + ' activeNew.new=' + aNewNew + ' deviceSwapped=' + deviceSwapped);
}

// C-CSM-TRANSFER-RECOVERY: interrupted migration preserves one authoritative state
// (rollback to active keeps old device; forward to completed swaps; wrong target rejected)
{
  const sub0 = csm.createSubscription({ subscriptionId: 'sub-tr', deviceBindingHash: DEV_OLD, tier: 'pro' });
  const pending = advance(sub0, [
    { op: 'op1', target: 'pending', rev: 1 },
    { op: 'op2', target: 'active', rev: 2 },
    { op: 'op3', target: 'transfer-pending', rev: 3, extra: { targetDeviceBindingHash: DEV_NEW } },
  ]);
  const rollback = csm.applySubscriptionTransition(pending, mkEvent(pending, 'op4a', 'active', 4)); // old device stays
  const forward = csm.applySubscriptionTransition(pending, mkEvent(pending, 'op4b', 'transfer-completed', 4, { targetDeviceBindingHash: DEV_NEW }));
  const mismatch = csm.applySubscriptionTransition(pending, mkEvent(pending, 'op4c', 'transfer-completed', 4, { targetDeviceBindingHash: DEV_WRONG }));
  const rollbackOldAuthoritative = rollback.ok && csm.subscriptionAccess(rollback.value, { signatureValid: true, clockValid: true, revocationEpoch: rollback.value.revocationEpoch, deviceBindingHash: DEV_OLD, nowMs: T0 }).paidAccessAllowed === true;
  check('C-CSM-TRANSFER-RECOVERY',
    'interrupted migration preserves one authoritative state (rollback keeps old; forward swaps; wrong target rejected)',
    rollback.ok === true && rollbackOldAuthoritative === true && forward.ok === true && mismatch.ok === false && mismatch.errorCode === 'transfer-target-mismatch',
    'CONFIRMED', 'fail-closed',
    'rollback.ok=' + rollback.ok + ' rollbackOldAuth=' + rollbackOldAuthoritative + ' forward.ok=' + forward.ok + ' mismatch.ok=' + mismatch.ok + ' mismatch.code=' + mismatch.errorCode);
}

// C-CSM-TRANSFER-FINALITY: after transfer-completed the new device is bound and the
// old pending target is cleared, so the old envelope/target cannot be reused. This
// directly covers the task-required "old wrapped-key reuse" scenario and is the
// non-circular kill target for mutation M5 (not clearing pendingTarget).
{
  const sub0 = csm.createSubscription({ subscriptionId: 'sub-tf', deviceBindingHash: DEV_OLD, tier: 'pro' });
  const activeOld = advance(sub0, [
    { op: 'op1', target: 'pending', rev: 1 },
    { op: 'op2', target: 'active', rev: 2 },
  ]);
  const pending = csm.applySubscriptionTransition(activeOld, mkEvent(activeOld, 'op3', 'transfer-pending', 3, { targetDeviceBindingHash: DEV_NEW })).value;
  const completed = csm.applySubscriptionTransition(pending, mkEvent(pending, 'op4', 'transfer-completed', 4, { targetDeviceBindingHash: DEV_NEW })).value;
  const deviceBound = completed.deviceBindingHash === DEV_NEW;
  const pendingCleared = completed.pendingTargetDeviceBindingHash === '';
  check('C-CSM-TRANSFER-FINALITY',
    'after transfer-completed the new device is bound and the old pending target is cleared (no stale envelope reuse)',
    deviceBound && pendingCleared,
    'CONFIRMED', 'fail-closed',
    'deviceBound=' + deviceBound + ' pendingCleared=' + pendingCleared + ' pendingTarget=' + JSON.stringify(completed.pendingTargetDeviceBindingHash));
}

// C-CSM-GRACE-CEILING: offline-grace with offlineGraceEndsAtMs > lastVerified+7d rejected
{
  const sub0 = csm.createSubscription({ subscriptionId: 'sub-gc', deviceBindingHash: DEV_OLD, tier: 'pro' });
  const active = advance(sub0, [
    { op: 'op1', target: 'pending', rev: 1 },
    { op: 'op2', target: 'active', rev: 2 },
  ]);
  const overEv = mkEvent(active, 'op3', 'offline-grace', 3, { lastVerifiedOnlineAtMs: T0, offlineGraceEndsAtMs: T0 + csm.MAX_OFFLINE_GRACE_MS + 1 });
  const withinEv = mkEvent(active, 'op4', 'offline-grace', 3, { lastVerifiedOnlineAtMs: T0, offlineGraceEndsAtMs: T0 + 6 * DAY });
  const over = csm.applySubscriptionTransition(active, overEv);
  const within = csm.applySubscriptionTransition(active, withinEv);
  check('C-CSM-GRACE-CEILING',
    'offline grace ceiling = 7*24h enforced (over-7d rejected; within-7d accepted)',
    over.ok === false && over.errorCode === 'invalid-offline-grace' && within.ok === true,
    'CONFIRMED', 'fail-closed',
    'over.ok=' + over.ok + ' over.code=' + over.errorCode + ' within.ok=' + within.ok + ' maxMs=' + csm.MAX_OFFLINE_GRACE_MS);
}

// C-CSM-GRACE-EXPIRY: offline-grace past effective end disables paid run; Free manual preserved
{
  const sub0 = csm.createSubscription({ subscriptionId: 'sub-ge', deviceBindingHash: DEV_OLD, tier: 'pro' });
  const grace = advance(sub0, [
    { op: 'op1', target: 'pending', rev: 1 },
    { op: 'op2', target: 'active', rev: 2 },
    { op: 'op3', target: 'offline-grace', rev: 3, extra: { lastVerifiedOnlineAtMs: T0, offlineGraceEndsAtMs: T0 + 6 * DAY } },
  ]);
  const expired = csm.subscriptionAccess(grace, { signatureValid: true, clockValid: true, revocationEpoch: grace.revocationEpoch, deviceBindingHash: DEV_OLD, nowMs: T0 + 7 * DAY });
  const within = csm.subscriptionAccess(grace, { signatureValid: true, clockValid: true, revocationEpoch: grace.revocationEpoch, deviceBindingHash: DEV_OLD, nowMs: T0 + 3 * DAY });
  check('C-CSM-GRACE-EXPIRY',
    'grace expiry disables paid run (paidAccessAllowed=false) while Free manual stays allowed',
    expired.paidAccessAllowed === false && expired.errorCode === 'offline-grace-expired' && expired.freeManualAllowed === true && within.paidAccessAllowed === true,
    'CONFIRMED', 'fail-closed',
    'expired.paid=' + expired.paidAccessAllowed + ' expired.code=' + expired.errorCode + ' expired.freeManual=' + expired.freeManualAllowed + ' within.paid=' + within.paidAccessAllowed);
}

// C-CSM-CLOCK-ANOMALY: clockValid=false rejected in both transition and access
{
  const sub0 = csm.createSubscription({ subscriptionId: 'sub-clk', deviceBindingHash: DEV_OLD, tier: 'pro' });
  const pending = advance(sub0, [{ op: 'op1', target: 'pending', rev: 1 }]);
  const evBadClock = mkEvent(pending, 'op2', 'active', 2, { clockValid: false });
  const res = csm.applySubscriptionTransition(pending, evBadClock);
  const active = advance(sub0, [{ op: 'op1', target: 'pending', rev: 1 }, { op: 'op2', target: 'active', rev: 2 }]);
  const accBadClock = csm.subscriptionAccess(active, { signatureValid: true, clockValid: false, revocationEpoch: active.revocationEpoch, deviceBindingHash: DEV_OLD, nowMs: T0 });
  check('C-CSM-CLOCK-ANOMALY',
    'clock anomaly fails closed (transition rejected; access denied)',
    res.ok === false && res.errorCode === 'clock-anomaly' && accBadClock.paidAccessAllowed === false && accBadClock.errorCode === 'clock-anomaly',
    'CONFIRMED', 'fail-closed',
    'res.ok=' + res.ok + ' res.code=' + res.errorCode + ' acc.paid=' + accBadClock.paidAccessAllowed + ' acc.code=' + accBadClock.errorCode);
}

// C-CSM-SIGNATURE-INVALID: signatureValid=false rejected
{
  const sub0 = csm.createSubscription({ subscriptionId: 'sub-sig', deviceBindingHash: DEV_OLD, tier: 'pro' });
  const pending = advance(sub0, [{ op: 'op1', target: 'pending', rev: 1 }]);
  const ev = mkEvent(pending, 'op2', 'active', 2, { signatureValid: false });
  const res = csm.applySubscriptionTransition(pending, ev);
  check('C-CSM-SIGNATURE-INVALID',
    'invalid signature fails closed (signatureValid=false rejected)',
    res.ok === false && res.errorCode === 'invalid-signature',
    'CONFIRMED', 'fail-closed',
    'res.ok=' + res.ok + ' res.code=' + res.errorCode);
}

// C-CSM-STALE-REVISION: stale revision rejected; idempotent ok; conflict rejected
{
  const sub0 = csm.createSubscription({ subscriptionId: 'sub-st', deviceBindingHash: DEV_OLD, tier: 'pro' });
  const pending = advance(sub0, [{ op: 'op1', target: 'pending', rev: 1 }]);
  const stale = csm.applySubscriptionTransition(pending, mkEvent(pending, 'op2', 'active', 1)); // revision 1 <= current 1
  // idempotent: replay op1 with identical fingerprint AGAINST the record that recorded op1
  const ev1 = mkEvent(sub0, 'op1', 'pending', 1);
  const idem = csm.applySubscriptionTransition(pending, ev1);
  // conflict: op1 with a different fingerprint (different revocationEpoch) AGAINST the record that recorded op1
  const ev1Conflict = mkEvent(sub0, 'op1', 'pending', 1, { revocationEpoch: 9 });
  const conflict = csm.applySubscriptionTransition(pending, ev1Conflict);
  check('C-CSM-STALE-REVISION',
    'grant-sequence rollback/replay rejected (stale-revision; idempotent ok; operation-conflict)',
    stale.ok === false && stale.errorCode === 'stale-revision' && idem.ok === true && idem.idempotent === true && conflict.ok === false && conflict.errorCode === 'operation-conflict',
    'CONFIRMED', 'fail-closed',
    'stale.ok=' + stale.ok + ' stale.code=' + stale.errorCode + ' idem.ok=' + idem.ok + ' idem.idem=' + idem.idempotent + ' conflict.ok=' + conflict.ok + ' conflict.code=' + conflict.errorCode);
}

// C-CSM-QUOTA-DEBIT: quota debit over balance rejected; within-balance ok
{
  const w0 = csm.createQuotaWallet({ walletId: 'w-1', deviceBindingHash: DEV_OLD, balance: 10 });
  const debitOver = csm.applyQuotaOperation(w0, mkEvent(w0, 'qop1', 'debit', 1, { type: 'debit', amount: 11 }));
  const debitOk = csm.applyQuotaOperation(w0, mkEvent(w0, 'qop2', 'debit', 1, { type: 'debit', amount: 5 }));
  check('C-CSM-QUOTA-DEBIT',
    'quota limits enforced (debit over balance rejected; within-balance ok)',
    debitOver.ok === false && debitOver.errorCode === 'insufficient-quota' && debitOk.ok === true && debitOk.value.balance === 5,
    'CONFIRMED', 'fail-closed',
    'debitOver.ok=' + debitOver.ok + ' debitOver.code=' + debitOver.errorCode + ' debitOk.ok=' + debitOk.ok + ' debitOk.balance=' + (debitOk.ok ? debitOk.value.balance : 'n/a'));
}

// C-LIC-REVOCATION-LIST: license-core exposes a license-CODE revocation-list verifier
// that fail-closes. SCOPED: this is the license-CODE subsystem, NOT the XJSUP package
// revocation epoch (which remains EXPECTED_RED in E-ONLINE-REVOCATION-FETCH).
{
  const hasFn = typeof licenseCore.verifyRevocationList === 'function';
  const malformed = licenseCore.verifyRevocationList({}, { now: T0 });
  const malformedToo = licenseCore.verifyRevocationList('not-an-object', { now: T0 });
  check('C-LIC-REVOCATION-LIST',
    'license-CODE revocation-list verifier exists and fail-closes on malformed input (scoped: NOT XJSUP package revocation)',
    hasFn && malformed.valid === false && malformed.errorCode === 'revocation-malformed' && malformedToo.valid === false,
    'CONFIRMED', 'boundary',
    'hasFn=' + hasFn + ' malformed.code=' + malformed.errorCode + ' malformedToo.valid=' + malformedToo.valid + ' (license-CODE subsystem, not XJSUP package epoch)');
}

// ──────────────────────────────────────────────────────────────────────────
// EXPECTED_RED: absent XJSUP/1 runtime surfaces — proven by real enumeration
// ──────────────────────────────────────────────────────────────────────────
const entExports = Object.keys(ent).sort();
const csmExports = Object.keys(csm).sort();
const licExports = Object.keys(licenseCore).sort();
const allProdExports = entExports.concat(csmExports).concat(licExports);
const parserLike = allProdExports.filter((k) => /parse|xjsup|package|manifest|envelope|unwrap|decrypt|install|run/i.test(k));

// E-XJSUP-PARSER: no function parses XJSUP/1 package bytes
const mainSrc = readText(MAIN_PATH);
const preloadSrc = readText(PRELOAD_PATH);
const storeSrc = readText(STORE_PATH);
const supSrc = readText(SUP_PATH);
const rsupSrc = readText(RSUP_PATH);
const licSrc = readText(LIC_PATH);
const cvSrc = readText(CV_PATH);
const entSrc = readText(ENT_PATH);
const csmSrc = readText(CSM_PATH);
const prodSources = { main: mainSrc, preload: preloadSrc, store: storeSrc, supervision: supSrc, 'real-supervision': rsupSrc, 'license-core': licSrc, 'cloud-verify': cvSrc, entitlements: entSrc, 'commercial-state-machine': csmSrc };
const xjsupHits = Object.values(prodSources).filter((s) => /xjsup/i.test(s)).length;
check('E-XJSUP-PARSER',
  'no XJSUP/1 package-byte parser in any production module',
  parserLike.length === 0 && xjsupHits === 0,
  'EXPECTED_RED', 'expected-red',
  'parserLikeExports=' + JSON.stringify(parserLike) + ' xjsupSourceHits=' + xjsupHits);

// E-CANONICAL-MANIFEST: no canonical package-manifest builder/verifier
const manifestLike = allProdExports.filter((k) => /manifest|canonical/i.test(k)).filter((k) => k !== 'canonical'); // csm.canonical is event-fingerprint only
check('E-CANONICAL-MANIFEST',
  'no canonical package-manifest builder/verifier (csm.canonical is event-fingerprint only)',
  manifestLike.length === 0,
  'EXPECTED_RED', 'expected-red',
  'manifestLikeExports=' + JSON.stringify(manifestLike) + ' (csm.canonical=eventFingerprint)');

// E-SIGNATURE-BEFORE-DECRYPT: no decrypt path; signatureValid is a pre-validated INPUT flag, not a real package-byte signature verification
const hasDecrypt = /decrypt|unwrap/i.test(csmSrc + licSrc + cvSrc + mainSrc + preloadSrc);
const csmTakesSigFlag = /event\.signatureValid/i.test(csmSrc);
check('E-SIGNATURE-BEFORE-DECRYPT',
  'no signature-before-decrypt path for packages (no XJSUP source; csm takes signatureValid as pre-validated input flag, not a package-byte signature verification)',
  csmTakesSigFlag === true && xjsupHits === 0,
  'EXPECTED_RED', 'expected-red',
  'csmTakesSigFlag=' + csmTakesSigFlag + ' xjsupHits=' + xjsupHits + ' hasDecryptSubstring=' + hasDecrypt + ' (no XJSUP package bytes exist to verify; license-core.verifySignature is for license codes)');

// E-ENVELOPE-UNWRAP: no recipient envelope unwrap
const envelopeLike = allProdExports.filter((k) => /envelope|unwrap|seal|openPackage/i.test(k));
const envelopeSrcHits = Object.values(prodSources).filter((s) => /recipientEnvelope|unwrapEnvelope|openPackage|sealEnvelope/i.test(s)).length;
check('E-ENVELOPE-UNWRAP',
  'no recipient envelope unwrap function',
  envelopeLike.length === 0 && envelopeSrcHits === 0,
  'EXPECTED_RED', 'expected-red',
  'envelopeLikeExports=' + JSON.stringify(envelopeLike) + ' envelopeSrcHits=' + envelopeSrcHits);

// E-INSTALL-RUN-API: no install/run package API; enumerate main.js ipcMain.handle channels
const handleRe = /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g;
const handleChannels = [];
let m;
while ((m = handleRe.exec(mainSrc)) !== null) handleChannels.push(m[1]);
const packageHandleChannels = handleChannels.filter((c) => /superv|xjsup|package|inspect|install|runPackage/i.test(c));
check('E-INSTALL-RUN-API',
  'no install/run package API (main.js ipcMain.handle has no XJSUP/inspect/install/run channels)',
  handleChannels.length > 0 && packageHandleChannels.length === 0,
  'EXPECTED_RED', 'expected-red',
  'handleCount=' + handleChannels.length + ' packageHandleCount=' + packageHandleChannels.length);

// E-TYPED-IPC-INSPECT: no typed IPC for inspect; enumerate preload __XJ_API__ keys
const apiRe = /^\s{2}([a-zA-Z]+):\s*\(/gm;
const apiKeys = [];
while ((m = apiRe.exec(preloadSrc)) !== null) apiKeys.push(m[1]);
const inspectApiKeys = apiKeys.filter((k) => /supervisionPackage|xjsup|inspect|installPackage|runPackage/i.test(k));
check('E-TYPED-IPC-INSPECT',
  'no typed IPC for inspect/install/run (preload __XJ_API__ has no supervision-package channels)',
  apiKeys.length > 0 && inspectApiKeys.length === 0,
  'EXPECTED_RED', 'expected-red',
  'apiKeyCount=' + apiKeys.length + ' inspectApiCount=' + inspectApiKeys.length);

// E-CSM-WIRING: commercial-state-machine is orphan (not required/imported by main/preload/any app/js)
const wiringNeedle = /commercial-state-machine|commercialStateMachine|XJCommercialStateMachine/;
const wiringHits = [mainSrc, preloadSrc, storeSrc, supSrc, rsupSrc, entSrc].filter((s) => wiringNeedle.test(s)).length;
check('E-CSM-WIRING',
  'commercial-state-machine is real pure logic but UNWIRED (no require/import in main/preload/renderer)',
  wiringHits === 0,
  'EXPECTED_RED', 'expected-red',
  'wiringHits=' + wiringHits + ' (orphan; no runtime path calls the confirmed invariants)');

// E-AUTHOR-KEY-CUSTODY: no offline author-key signing tool / authorKeyId registry for packages
const authorKeyHits = Object.values(prodSources).filter((s) => /authorKey|authorKeyId|authorPublicKey/i.test(s)).length;
check('E-AUTHOR-KEY-CUSTODY',
  'no offline author-key signing tool / package authorKeyId registry in repo',
  authorKeyHits === 0,
  'EXPECTED_RED', 'expected-red',
  'authorKeySourceHits=' + authorKeyHits + ' (license-core.publicKeyFor is for license codes, not packages)');

// E-ONLINE-REVOCATION-FETCH: no fetch of newer package revocation evidence
const cvExports = (cvSrc.match(/module\.exports\s*=\s*\{([^}]*)\}/) || [, ''])[1].split(',').map((s) => s.trim()).filter(Boolean);
const onlineRevFetchHits = Object.values(prodSources).filter((s) => /fetchRevocation|packageRevocation|revocationEpoch.*fetch|newerRevocation/i.test(s)).length;
check('E-ONLINE-REVOCATION-FETCH',
  'no online package-revocation fetch (cloud-verify.verifyCloud is license-code cloud activation, not package revocation)',
  cvExports.length > 0 && cvExports.every((k) => /^verifyCloud$/.test(k)) && onlineRevFetchHits === 0,
  'EXPECTED_RED', 'expected-red',
  'cloudVerifyExports=' + JSON.stringify(cvExports) + ' onlineRevFetchHits=' + onlineRevFetchHits);

// E-PROVIDER-POLICY-PACKAGE: no per-package provider-policy/consent registry
const providerPolicyHits = Object.values(prodSources).filter((s) => /trustedProvider|perPackageConsent|packageProviderPolicy|packageVersionConsent/i.test(s)).length;
check('E-PROVIDER-POLICY-PACKAGE',
  'no per-package provider-policy / trusted-provider / explicit-consent registry',
  providerPolicyHits === 0,
  'EXPECTED_RED', 'expected-red',
  'providerPolicyHits=' + providerPolicyHits + ' (entitlements.computeAvailable is a feature flag, not a package-version consent registry)');

// E-PLAINTEXT-NONEXPOSURE: no package plaintext exists to expose; runtime non-exposure enforcement absent
const packagePlaintextHits = Object.values(prodSources).filter((s) => /packagePlaintext|recipientPlaintext|plaintextPackage/i.test(s)).length;
check('E-PLAINTEXT-NONEXPOSURE',
  'no package plaintext path exists; runtime non-exposure enforcement absent (no runtime)',
  packagePlaintextHits === 0 && xjsupHits === 0,
  'EXPECTED_RED', 'expected-red',
  'packagePlaintextHits=' + packagePlaintextHits + ' (no parser/envelope -> no plaintext; runtime non-exposure not enforced because no runtime)');

// ──────────────────────────────────────────────────────────────────────────
// Self-consistency invariants (defend against false-green / false-confirmed)
// ──────────────────────────────────────────────────────────────────────────
const zeroFailed = failedCount === 0;
const expectedRedAllGreen = checks.filter((c) => c.classification === 'EXPECTED_RED').every((c) => c.pass === true);
const confirmedAllGreen = checks.filter((c) => c.classification === 'CONFIRMED').every((c) => c.pass === true);
const FALSE_RUNTIME_RE = new RegExp('XJSUP parser|canonical manifest|signature-before-decrypt|envelope unwrap|install/run API|typed IPC|wiring|author-key|online revocation|provider policy|plaintext non-exposure', 'i');
const noFalseConfirmedRuntime = checks.filter((c) => c.classification === 'CONFIRMED').every((c) => !FALSE_RUNTIME_RE.test(c.label));
const totalRows = checks.length;

// Non-exposure self-scan: the result artifacts must not carry secret-like material
const SECRET_MARKERS = ['PRIVATE KEY', 'BEGIN PRIVATE', 'BEGIN ENCRYPTED', 'authorPrivateKey', 'devicePrivateKey', '-----BEGIN'];
function deepSecretScan(obj) {
  const found = [];
  const visit = (v) => {
    if (typeof v === 'string') SECRET_MARKERS.forEach((mk) => { if (v.indexOf(mk) !== -1) found.push(mk); });
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(obj);
  return found;
}

// ──────────────────────────────────────────────────────────────────────────
// Build deterministic artifacts
// ──────────────────────────────────────────────────────────────────────────
const moduleHashes = {
  'entitlements.js': sha256(ENT_PATH),
  'commercial-state-machine.js': sha256(CSM_PATH),
  'license-core.js': sha256(LIC_PATH),
  'main.js': sha256(MAIN_PATH),
  'preload.js': sha256(PRELOAD_PATH),
};

const rowCounts = {
  total: totalRows,
  positive: checks.filter((c) => c.category === 'positive').length,
  fail_closed: checks.filter((c) => c.category === 'fail-closed').length,
  boundary: checks.filter((c) => c.category === 'boundary').length,
  trial_quota: checks.filter((c) => c.category === 'trial-quota').length,
  expected_red: checks.filter((c) => c.category === 'expected-red').length,
};

const invariants = {
  totalRowsAtLeast12: totalRows >= 12,
  confirmedRealExecuted: confirmedAllGreen,
  expectedRedAtLeastOne: expectedRedCount >= 1,
  expectedRedAtLeast11: expectedRedCount >= 11,
  noExpectedRedPromoted: checks.filter((c) => c.category === 'expected-red').every((c) => c.classification === 'EXPECTED_RED'),
  expectedRedAllGreen: expectedRedAllGreen,
  noFalseConfirmedRuntime: noFalseConfirmedRuntime,
  zeroFailed: zeroFailed,
  csmPureLogicNotWired: wiringHits === 0 && confirmedAllGreen,
};

const contractResult = {
  task_id: TASK_ID,
  base_commit: BASE_COMMIT,
  contract_id: CONTRACT_ID,
  write_lock_id: WRITE_LOCK_ID,
  grant_id: GRANT_ID,
  protected_files_manifest_sha256: MANIFEST_HASH,
  module_hashes: moduleHashes,
  determinism: 'no volatile fields; no timestamps/random/hashes inside artifact; hash-stable across healthy runs',
  confirmed: confirmedCount,
  expected_red: expectedRedCount,
  unverified: unverifiedCount,
  failed: failedCount,
  row_counts: rowCounts,
  invariants: invariants,
  overall: (expectedRedCount > 0) ? 'EXPECTED_RED' : 'CONFIRMED',
  checks: checks.map((c) => ({ id: c.id, label: c.label, pass: c.pass, classification: c.classification, category: c.category })),
};

// contract-matrix.json: deterministic plan with real production_entry_point + evidence
const EXPECTED_LABEL = {
  CONFIRMED: 'behavior present and correct (CONFIRMED)',
  EXPECTED_RED: 'capability absent / behavior missing (EXPECTED_RED gap)',
};
const ENTRY_POINT = {
  'C-ENT-FC-TIER': 'app/js/entitlements.js effectiveTier/normalizeTier',
  'C-ENT-COMPUTE': 'app/js/entitlements.js access()',
  'C-ENT-FREE-MANUAL': 'app/js/entitlements.js canUse/minimumTier',
  'C-ENT-TRIAL-BOUNDED': 'app/js/entitlements.js isTrialActive/effectiveTier/canUse',
  'C-CSM-REVOKE-ROLLBACK': 'app/js/commercial-state-machine.js applySubscriptionTransition/validateSecurity',
  'C-CSM-DEVICE-MISMATCH': 'app/js/commercial-state-machine.js validateSecurity',
  'C-CSM-TRANSFER-ATOMIC': 'app/js/commercial-state-machine.js applySubscriptionTransition + subscriptionAccess',
  'C-CSM-TRANSFER-RECOVERY': 'app/js/commercial-state-machine.js transfer-pending/transfer-completed transitions',
  'C-CSM-TRANSFER-FINALITY': 'app/js/commercial-state-machine.js applySubscriptionTransition (transfer-completed binds new device + clears pendingTarget)',
  'C-CSM-GRACE-CEILING': 'app/js/commercial-state-machine.js offline-grace transition (MAX_OFFLINE_GRACE_MS)',
  'C-CSM-GRACE-EXPIRY': 'app/js/commercial-state-machine.js subscriptionAccess (offline-grace)',
  'C-CSM-CLOCK-ANOMALY': 'app/js/commercial-state-machine.js validateSecurity/subscriptionAccess',
  'C-CSM-SIGNATURE-INVALID': 'app/js/commercial-state-machine.js validateSecurity',
  'C-CSM-STALE-REVISION': 'app/js/commercial-state-machine.js applySubscriptionTransition (revision/idempotency)',
  'C-CSM-QUOTA-DEBIT': 'app/js/commercial-state-machine.js applyQuotaOperation',
  'C-LIC-REVOCATION-LIST': 'license-core.js verifyRevocationList (license-CODE subsystem)',
  'E-XJSUP-PARSER': 'NO PRODUCTION ENTRY (no parseXjsup export in any module; 0 xjsup source hits)',
  'E-CANONICAL-MANIFEST': 'NO PRODUCTION ENTRY (csm.canonical is event-fingerprint only)',
  'E-SIGNATURE-BEFORE-DECRYPT': 'NO PRODUCTION ENTRY (no decrypt step; signatureValid is an input flag)',
  'E-ENVELOPE-UNWRAP': 'NO PRODUCTION ENTRY (no envelope/unwrap export)',
  'E-INSTALL-RUN-API': 'NO PRODUCTION ENTRY (main.js ipcMain.handle: 0 package channels)',
  'E-TYPED-IPC-INSPECT': 'NO PRODUCTION ENTRY (preload __XJ_API__: 0 inspect channels)',
  'E-CSM-WIRING': 'NO PRODUCTION ENTRY (commercial-state-machine not required by main/preload/renderer)',
  'E-AUTHOR-KEY-CUSTODY': 'NO PRODUCTION ENTRY (no authorKey registry/signing tool)',
  'E-ONLINE-REVOCATION-FETCH': 'NO PRODUCTION ENTRY (cloud-verify exports verifyCloud only)',
  'E-PROVIDER-POLICY-PACKAGE': 'NO PRODUCTION ENTRY (no trusted-provider/consent registry)',
  'E-PLAINTEXT-NONEXPOSURE': 'NO PRODUCTION ENTRY (no package plaintext path; no runtime)',
};
const contractMatrix = {
  task_id: TASK_ID,
  base_commit: BASE_COMMIT,
  rows: checks.map((c) => ({
    id: c.id,
    capability: c.label,
    expected_current_result: EXPECTED_LABEL[c.classification],
    actual_result: c.pass ? (c.classification === 'CONFIRMED' ? 'behavior confirmed' : 'gap confirmed absent as expected') : 'MISMATCH',
    classification: c.classification,
    category: c.category,
    production_entry_point: ENTRY_POINT[c.id] || '',
    evidence: c.evidence,
  })),
};

// Non-exposure scan over both artifacts before writing
const secretInResult = deepSecretScan(contractResult).concat(deepSecretScan(contractMatrix));
if (secretInResult.length > 0) {
  console.error('[BLOCKED] secret-like material detected in artifact: ' + JSON.stringify(secretInResult));
  process.exit(1);
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'contract-result.json'), JSON.stringify(contractResult, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'contract-matrix.json'), JSON.stringify(contractMatrix, null, 2) + '\n', 'utf8');

// ──────────────────────────────────────────────────────────────────────────
// Summary + exit
// ──────────────────────────────────────────────────────────────────────────
console.log('----------------------------------------');
console.log('task 28 run-contract.js summary:');
console.log('  confirmed=' + confirmedCount + ' expected_red=' + expectedRedCount + ' unverified=' + unverifiedCount + ' failed=' + failedCount);
console.log('  row_counts=' + JSON.stringify(rowCounts));
console.log('  invariants=' + JSON.stringify(invariants));
console.log('  overall=' + contractResult.overall);
console.log('  manifestByteHash=' + manifestByteHash);
console.log('  module_hashes=' + JSON.stringify(moduleHashes));

if (!zeroFailed || !expectedRedAllGreen || !confirmedAllGreen || !noFalseConfirmedRuntime || !invariants.expectedRedAtLeast11 || !invariants.noExpectedRedPromoted) {
  console.error('[FAIL] self-consistency invariant violated; exiting nonzero.');
  process.exit(1);
}
process.exit(0);
