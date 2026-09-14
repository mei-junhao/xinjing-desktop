'use strict';
/**
 * XJ-4.3.0-opensquilla-plan-facts-shadow-audit-rework-02
 * Synthetic fact fixtures: 30 positive + 18 negative/drift scenarios.
 * All data is synthetic, derived from real coordination ledger structure.
 * No real credentials, clinical data, or network access.
 *
 * REWORK 02 FIXES:
 * - pos-13: report_path now uses TRUE absolute path (D:\...) with is_absolute:true
 * - neg-11: workspace-relative path now explicitly tested as false
 * - contract_id, write_lock_id, report_path updated for rework-02
 */
'use strict';

// ── Known-good reference values (from Checkpoint A real reads) ──
const REAL = {
  plan_sha256: 'E95F8F973846ECE9C4B4E8082874B7931F565034252FC4B2D1792446361DA861',
  protected_manifest_sha256: 'E83AAE7BC0B3AE5E8127F9815D0FBA3DF80F925353ACC9112B18F70633DB76BC',
  base_commit: '9971787eb6e443ab5a5c80aee118b9b43285c093',
  active_version: '4.3.0',
  state: 'implementation',
  transition_id: 'rt-4.3.0-0001',
  candidate_status: 'not-created',
  candidate_sha256: null,
  release_train_path: 'docs/agent-coordination/v4.3.0/release-train.yaml',
  coordination_root: 'docs/agent-coordination/v4.3.0',
  plan_path: 'XinJing-中远期发展计划-v4.1.1-v6.0.md',
  contract_id: 'XJ-4.3.0-plan-facts-shadow-v1-rework-02',
  write_lock_id: 'lock-XJ-4.3.0-opensquilla-plan-facts-shadow-audit-rework-02',
  report_path: 'D:\\xinjing-electron\\qa\\agent-reviews\\XJ-4.3.0-opensquilla-plan-facts-shadow-rework-02.md',
  report_last_line: 'DELIVERY_REPORT: D:\\xinjing-electron\\qa\\agent-reviews\\XJ-4.3.0-opensquilla-plan-facts-shadow-rework-02.md',
  agent_owner: 'opensquilla',
  verification_route: 'pending',
  old_base_commit: '6910e90bcc2206658a3c66f6c203216b70089001',
  old_protected_hash: 'C8A1F39566C3FD01C0FD6DF649F470430D68CEBB6E7C067A8B7FFE41CF432250'
};

// ── 30 positive scenarios (confirmed) ──
const positive = [
  { id: 'pos-01', name: 'active-version-match', input: { active_version: '4.3.0', plan_version: '4.3.0', release_train_version: '4.3.0' }, expected: 'confirmed' },
  { id: 'pos-02', name: 'state-implementation', input: { state: 'implementation', plan_phase: 'implementation' }, expected: 'confirmed' },
  { id: 'pos-03', name: 'transition-id-match', input: { transition_id: 'rt-4.3.0-0001', release_train_transition: 'rt-4.3.0-0001' }, expected: 'confirmed' },
  { id: 'pos-04', name: 'base-commit-current', input: { base_commit: REAL.base_commit, release_train_base: REAL.base_commit }, expected: 'confirmed' },
  { id: 'pos-05', name: 'candidate-not-created', input: { candidate_status: 'not-created', candidate_sha256: null }, expected: 'confirmed' },
  { id: 'pos-06', name: 'plan-sha-match', input: { plan_sha256: REAL.plan_sha256 }, expected: 'confirmed' },
  { id: 'pos-07', name: 'protected-manifest-match', input: { protected_manifest_sha256: REAL.protected_manifest_sha256 }, expected: 'confirmed' },
  { id: 'pos-08', name: 'task-card-release-train-match', input: { task_card_train: '4.3.0/implementation/rt-4.3.0-0001', release_train: '4.3.0/implementation/rt-4.3.0-0001' }, expected: 'confirmed' },
  { id: 'pos-09', name: 'contract-id-match', input: { contract_id: REAL.contract_id, task_card_contract: REAL.contract_id }, expected: 'confirmed' },
  { id: 'pos-10', name: 'write-lock-granted', input: { write_lock_id: REAL.write_lock_id, lock_state: 'granted', lock_owner: 'opensquilla' }, expected: 'confirmed' },
  { id: 'pos-11', name: 'verification-route-pending', input: { verification_route: 'pending', candidate_status: 'not-created' }, expected: 'confirmed' },
  { id: 'pos-12', name: 'agent-owner-match', input: { agent_owner: 'opensquilla', task_card_owner: 'opensquilla', lock_owner: 'opensquilla' }, expected: 'confirmed' },
  { id: 'pos-13', name: 'report-path-absolute', input: { report_path: REAL.report_path, is_absolute: true, must_be_absolute: true }, expected: 'confirmed' },
  { id: 'pos-14', name: 'report-last-line-format', input: { report_last_line: REAL.report_last_line }, expected: 'confirmed' },
  { id: 'pos-15', name: 'coordination-root-match', input: { coordination_root: 'docs/agent-coordination/v4.3.0', release_train_root: 'docs/agent-coordination/v4.3.0' }, expected: 'confirmed' },
  { id: 'pos-16', name: 'release-train-path-match', input: { release_train_path: REAL.release_train_path }, expected: 'confirmed' },
  { id: 'pos-17', name: 'plan-path-match', input: { plan_path: REAL.plan_path }, expected: 'confirmed' },
  { id: 'pos-18', name: 'lock-allowlist-within-globs', input: { lock_globs: ['tests/v4.3.0-disposable/opensquilla-plan-facts/**', 'docs/agent-coordination/v4.3.0/inventory/opensquilla-plan-facts/**', 'qa/agent-reviews/XJ-4.3.0-opensquilla-plan-facts-shadow-rework-02.md'] }, expected: 'confirmed' },
  { id: 'pos-19', name: 'no-production-file-in-allowlist', input: { allowlist_files: ['tests/v4.3.0-disposable/opensquilla-plan-facts/fixtures.js', 'docs/agent-coordination/v4.3.0/inventory/opensquilla-plan-facts/fact-schema.json'] }, expected: 'confirmed' },
  { id: 'pos-20', name: 'previous-state-preparation', input: { previous_state: 'preparation', current_state: 'implementation' }, expected: 'confirmed' },
  { id: 'pos-21', name: 'channel-local', input: { channel: 'local' }, expected: 'confirmed' },
  { id: 'pos-22', name: 'write-permissions-granted', input: { write_permissions: 'granted', lock_state: 'granted' }, expected: 'confirmed' },
  { id: 'pos-23', name: 'rework-count-zero', input: { rework_count: 0 }, expected: 'confirmed' },
  { id: 'pos-24', name: 'parent-release-4.2.4', input: { parent_release_version: '4.2.4', parent_release_status: 'user-confirmed-installed' }, expected: 'confirmed' },
  { id: 'pos-25', name: 'candidate-scope-evidence-only', input: { candidate_scope: 'No 4.3.0 production candidate has been frozen. Preparation artifacts are evidence only.' }, expected: 'confirmed' },
  { id: 'pos-26', name: 'evidence-refs-includes-plan', input: { evidence_refs: [REAL.plan_path, 'docs/agent-coordination/v4.3.0/preparation-plan.md', 'docs/agent-coordination/current.json'] }, expected: 'confirmed' },
  { id: 'pos-27', name: 'transition-history-present', input: { transition_history: [{ from: '4.3.0/preparation', to: '4.3.0/implementation', actor: 'codex' }] }, expected: 'confirmed' },
  { id: 'pos-28', name: 'remote-write-log-empty', input: { remote_write_log: [] }, expected: 'confirmed' },
  { id: 'pos-29', name: 'rollback-evidence-empty', input: { rollback_evidence: [] }, expected: 'confirmed' },
  { id: 'pos-30', name: 'schema-version-one', input: { schema_version: 1, release_train_schema: 1, write_locks_schema: 1 }, expected: 'confirmed' }
];

// ── 18 negative/drift scenarios ──
const negative = [
  { id: 'neg-01', name: 'version-mismatch', input: { active_version: '4.3.0', plan_version: '4.2.4', release_train_version: '4.3.0' }, expected: 'drift' },
  { id: 'neg-02', name: 'state-not-allowed', input: { state: 'released', allowed_states: ['preparation', 'implementation'] }, expected: 'false' },
  { id: 'neg-03', name: 'candidate-falsely-frozen', input: { candidate_status: 'frozen', candidate_sha256: 'fake123', release_train_candidate_status: 'not-created' }, expected: 'false' },
  { id: 'neg-04', name: 'base-commit-mismatch', input: { base_commit: REAL.old_base_commit, release_train_base: REAL.base_commit }, expected: 'stale' },
  { id: 'neg-05', name: 'task-card-old-plan', input: { task_card_plan_ref: 'XinJing-中远期发展计划-v3.1-v5.0.md', current_plan: REAL.plan_path }, expected: 'stale' },
  { id: 'neg-06', name: 'lock-not-released', input: { lock_id: 'lock-XJ-4.3.0-test', lock_state: 'granted', expected_state: 'released' }, expected: 'incomplete' },
  { id: 'neg-07', name: 'lock-owner-mismatch', input: { lock_owner: 'trae', task_card_owner: 'opensquilla', agent_owner: 'opensquilla' }, expected: 'false' },
  { id: 'neg-08', name: 'lock-allowlist-mismatch', input: { lock_globs: ['app/js/store.js', 'tests/disposable/**'], expected_globs: ['tests/v4.3.0-disposable/opensquilla-plan-facts/**'] }, expected: 'false' },
  { id: 'neg-09', name: 'contract-id-mismatch', input: { contract_id: 'XJ-4.3.0-source-graph-prep-v1', task_card_contract: REAL.contract_id }, expected: 'false' },
  { id: 'neg-10', name: 'verification-route-missing', input: { verification_route: null, candidate_status: 'not-created' }, expected: 'incomplete' },
  { id: 'neg-11', name: 'report-path-workspace-relative', input: { report_path: 'qa/agent-reviews/report.md', is_absolute: false, workspace_relative: true, must_be_absolute: true }, expected: 'false' },
  { id: 'neg-12', name: 'report-last-line-malformed', input: { report_last_line: 'Report delivered successfully.' }, expected: 'false' },
  { id: 'neg-13', name: 'empty-field', input: { active_version: '', state: 'implementation' }, expected: 'incomplete' },
  { id: 'neg-14', name: 'duplicate-fact', input: { facts: [{ key: 'active_version', value: '4.3.0' }, { key: 'active_version', value: '4.2.4' }] }, expected: 'drift' },
  { id: 'neg-15', name: 'unknown-state', input: { state: 'frozen', allowed_states: ['preparation', 'implementation'] }, expected: 'false' },
  { id: 'neg-16', name: 'unparseable-input', input: { raw: '{invalid json', active_version: null }, expected: 'incomplete' },
  { id: 'neg-17', name: 'old-protected-manifest-hash', input: { protected_manifest_sha256: REAL.old_protected_hash, current_hash: REAL.protected_manifest_sha256 }, expected: 'stale' },
  { id: 'neg-18', name: 'plan-still-references-old-commit', input: { plan_base_commit: REAL.old_base_commit, release_train_base: REAL.base_commit }, expected: 'drift' }
];

module.exports = { REAL, positive, negative, all: positive.concat(negative) };
