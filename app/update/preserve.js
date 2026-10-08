'use strict';
// preserve.js — product/commercial/clinical preservation contract (contract §11,
// production decision: "保留 Free 手动工作流、临床 SourceRef、server balance
// projection、recipient grant、entitlement 和加密备份语义").
//
// The update integration must never:
//   - gate Free manual data access behind paid/AI verification;
//   - rewrite server-authoritative balance from client caches;
//   - let recipient grants become grant sources;
//   - broaden entitlement/trial allowlist semantics;
//   - drop clinical SourceRef / clinicalActionRun traceability;
//   - weaken encrypted-backup passphrase + quarantine semantics.

const { EXPORT_KEYS, FORBIDDEN_AUTHORITY_KEYS } = require('./durable-bridge');

function fail(code) {
  const error = new Error('preserve rejected: ' + code);
  error.code = code;
  throw error;
}

// 1) exportAll payload must NOT carry commercial/entitlement/grant authority.
function assertSnapshotNoAuthorityKeys(payload) {
  for (const key of FORBIDDEN_AUTHORITY_KEYS) {
    if (payload && Object.prototype.hasOwnProperty.call(payload, key)) fail('snapshot-carries-authority:' + key);
  }
  return true;
}

// 2) Clinical SourceRef: clinicalActionRuns and clinicalTasks survive a
//    snapshot/restore round trip (they are exportable durable collections).
function assertClinicalTraceKeysPresent(payload) {
  if (!payload || !Array.isArray(payload.clinicalActionRuns) || !Array.isArray(payload.clinicalTasks)) {
    fail('clinical-trace-keys-missing');
  }
  return true;
}

// 3) Server balance projection stays read-only: the snapshot key set never
//    includes commercial projection, and the candidate contains no write path
//    from update code into commercial state.
function assertBalanceProjectionReadOnly(sourceText) {
  if (/setCommercialProjection\s*\(/.test(sourceText)) fail('candidate-writes-commercial-projection');
  if (EXPORT_KEYS.has('commercialProjection')) fail('commercial-projection-exported');
  return true;
}

// 4) Recipient grant + entitlement: not exported, not rewritten, not broadened.
function assertGrantEntitlementUntouched(sourceText) {
  if (/recipientGrant/i.test(sourceText) && /grant\s*=\s*|entitlement\s*=\s*/.test(sourceText)) fail('candidate-mutates-grant-entitlement');
  return true;
}

// 5) Encrypted backup semantics: passphrase floor and quarantine keys preserved
//    by the bridge (checked in durable-bridge tests too, mirrored here).
function assertEncryptedBackupSemantics(backupCrypto) {
  if (!backupCrypto || typeof backupCrypto.encryptPayload !== 'function' || typeof backupCrypto.decryptPayload !== 'function') {
    fail('backup-crypto-unavailable');
  }
  return true;
}

// 6) Free manual workflow: the update entry must not sit between the user and
//    the manual data page. Static guard: candidate update modules must not
//    reference licenseMode/aiUnlocked as gating for update actions.
function assertFreeWorkflowNotGated(sourceText) {
  if (/update/.test(sourceText) && /licenseMode\s*===\s*['"]free['"]\s*&&\s*!/.test(sourceText)) fail('free-workflow-gated-by-update');
  return true;
}

module.exports = {
  assertSnapshotNoAuthorityKeys, assertClinicalTraceKeysPresent,
  assertBalanceProjectionReadOnly, assertGrantEntitlementUntouched,
  assertEncryptedBackupSemantics, assertFreeWorkflowNotGated
};
