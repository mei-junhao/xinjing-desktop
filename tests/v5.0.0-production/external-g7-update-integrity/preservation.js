'use strict';
// preservation.js — Free manual workflow, clinical SourceRef, server balance
// projection, recipient grant, entitlement, encrypted-backup semantics
// (contract §11 / production decision 8).
const fs = require('fs');
const path = require('path');
const { Suite } = require('./_testkit');
const preserve = require('../../../app/update/preserve');
const bridge = require('../../../app/update/durable-bridge');
const backupCrypto = require('../../../app/js/backup-crypto.js');
const s = new Suite('preservation');

const ROOT = path.resolve(__dirname, '..');
const candidateUpdateDir = path.join(ROOT, '..', '..', 'app', 'update');
const candidateSource = fs.readdirSync(candidateUpdateDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => fs.readFileSync(path.join(candidateUpdateDir, f), 'utf8'))
  .join('\n');

// 1) snapshot never carries authority keys
const payload = {
  version: '2.0.0', exportedAt: new Date().toISOString(),
  clients: [{ id: 'c1' }], sessions: [], supervisions: [], supervisorIdentities: [],
  masterConversations: [], expenses: [], materialWorkspaces: [],
  clinicalActionRuns: [{ id: 'r1', clientId: 'c1', sourceRef: 'clinical:src-1' }],
  clinicalTasks: [], importQuarantine: [], deletionBatches: [], deletionQuarantine: []
};
s.ok('no authority keys in export key set', !bridge.EXPORT_KEYS.has('commercialProjection') && !bridge.EXPORT_KEYS.has('entitlements') && !bridge.EXPORT_KEYS.has('recipientGrants') && !bridge.EXPORT_KEYS.has('balance'));
s.ok('snapshot rejects authority keys', (() => {
  let ok = true;
  try { preserve.assertSnapshotNoAuthorityKeys(Object.assign({}, payload, { commercialProjection: { balance: 100 } })); ok = false; } catch (e) { ok = e.code === 'snapshot-carries-authority:commercialProjection'; }
  return ok;
})());

// 2) clinical SourceRef survives round trip (exportable keys)
s.ok('clinical trace keys present', preserve.assertClinicalTraceKeysPresent(payload) === true);

// 3) balance projection read-only: candidate never writes it
s.ok('balance projection read-only', preserve.assertBalanceProjectionReadOnly(candidateSource) === true && bridge.EXPORT_KEYS.has('commercialProjection') === false);

// 4) grants/entitlement untouched
s.ok('grant/entitlement untouched', preserve.assertGrantEntitlementUntouched(candidateSource) === true);

// 5) encrypted backup semantics preserved (frozen crypto + passphrase floor)
s.ok('encrypted backup semantics', preserve.assertEncryptedBackupSemantics(backupCrypto) === true);

// 6) Free manual workflow not gated by update code
s.ok('free workflow not gated', preserve.assertFreeWorkflowNotGated(candidateSource) === true);

// 7) quarantine keys preserved in exportAll/importAll (frozen store.js boundary)
const liveStore = fs.readFileSync(path.join(ROOT, '..', '..', 'app', 'js', 'store.js'), 'utf8');
s.ok('frozen store exportAll/importAll intact (single boundary)', /async function exportAll\(\)/.test(liveStore) && /async function importAll\(jsonStr\)/.test(liveStore) && /allowFallback: false/.test(liveStore));
s.ok('candidate renderer bridge awaits real importAll', (() => {
  const rb = fs.readFileSync(path.join(ROOT, '..', '..', 'app', 'js', 'update-durable-renderer.js'), 'utf8');
  return /Store\.importAll\(request\.payload\)/.test(rb) && /await/.test(rb) && !/mock/i.test(rb);
})());

// 8) entitlement/trial semantics: candidate must not broaden (no reference to tier in update code)
s.ok('candidate does not touch entitlement/tier', !/entitlement\s*=\s*|tier\s*=\s*/.test(candidateSource));

console.log('PRESERVATION_STATUS=' + (s.fail === 0 ? 'PASS' : 'FAIL'));
process.exit(s.finish() ? 0 : 1);
