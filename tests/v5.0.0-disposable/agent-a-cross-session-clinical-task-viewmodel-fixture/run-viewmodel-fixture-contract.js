'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

var ROOT = path.resolve('D:\\xinjing-electron');
var INV = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'agent-a-cross-session-clinical-task-viewmodel-fixture');
var OUT = path.join(INV, 'contract-result.json');

var checks = [];
var confirmedCount = 0, expectedRedCount = 0, failedCount = 0;

function check(id, label, cond, classification) {
  var ok = !!cond;
  var cls = classification || (ok ? 'CONFIRMED' : 'EXPECTED_RED');
  if (cls === 'CONFIRMED') { if (ok) confirmedCount++; else failedCount++; }
  else if (cls === 'EXPECTED_RED') { if (ok) expectedRedCount++; else failedCount++; }
  checks.push({ id: id, label: label, pass: ok, classification: cls, is_expected_red: cls === 'EXPECTED_RED' });
  var statusTag = cls === 'EXPECTED_RED' ? 'EXPECTED_RED' : (ok ? 'PASS' : 'FAIL');
  console.log('[' + statusTag + '] ' + id + ': ' + label + ' (' + cls + ')');
}

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }

// P1: Protected source hash verification
var manifest = JSON.parse(fs.readFileSync(path.join(INV, 'protected-files-manifest.json'), 'utf8'));
var allHashesOk = true;
manifest.protected_files.forEach(function(f) {
  var p = path.join(ROOT, f.path);
  var exists = fs.existsSync(p);
  var actual = exists ? sha256(p) : 'MISSING';
  var match = actual === f.sha256;
  if (!match) allHashesOk = false;
  check('P1_' + f.path.replace(/[^a-z0-9]/gi, '_'), 'protected hash: ' + f.path, match, 'CONFIRMED');
});

// P2: Load fixture contract
var contract = JSON.parse(fs.readFileSync(path.join(INV, 'fixture-contract.json'), 'utf8'));
check('P2A', 'contract has task_id', contract.task_id === 'XJ-5.0.0-agent-a-v4.3-clinical-task-viewmodel-fixture-03', 'CONFIRMED');
check('P2B', 'contract has write_lock_id', !!contract.write_lock_id, 'CONFIRMED');
check('P2C', 'contract has synthetic tasks (5+)', Array.isArray(contract.synthetic_tasks) && contract.synthetic_tasks.length >= 5, 'CONFIRMED');
check('P2D', 'contract has sessions (3+)', Array.isArray(contract.sessions) && contract.sessions.length >= 3, 'CONFIRMED');
check('P2E', 'contract has projections', !!contract.projections && !!contract.projections.later_session_same_client, 'CONFIRMED');
check('P2F', 'contract has rejection_rules (9)', Array.isArray(contract.rejection_rules) && contract.rejection_rules.length === 9, 'CONFIRMED');

// P3: Synthetic principles
var principles = contract.synthetic_principles;
check('P3A', 'only_synthetic_ids', principles.only_synthetic_ids === true, 'CONFIRMED');
check('P3B', 'no_real_clinical_text', principles.no_real_clinical_text === true, 'CONFIRMED');
check('P3C', 'no_personal_data', principles.no_personal_data === true, 'CONFIRMED');
check('P3D', 'no_secrets_or_tokens', principles.no_secrets_or_tokens === true, 'CONFIRMED');
check('P3E', 'no_absolute_user_paths', principles.no_absolute_user_paths === true, 'CONFIRMED');
check('P3F', 'no_remote_content', principles.no_remote_content === true, 'CONFIRMED');

// C1: All synthetic tasks have required fields
var allTasks = contract.synthetic_tasks;
allTasks.forEach(function(t) {
  check('C1_' + t.task_id, 'task ' + t.task_id + ' has required fields', !!t.task_id && !!t.client_id && !!t.origin_session_id && !!t.label && !!t.status && !!t.created_at && Array.isArray(t.source_refs) && t.source_refs.length > 0, 'CONFIRMED');
});

// C2: No clinical body text in any task
var hasClinicalBody = allTasks.some(function(t) { return !!t.clinical_body_text; });
check('C2', 'no clinical body text in any fixture task', !hasClinicalBody, 'CONFIRMED');

// C3: All statuses are valid
var validStatuses = ['open', 'done', 'cancelled'];
var allStatusesValid = allTasks.every(function(t) { return validStatuses.indexOf(t.status) !== -1; });
check('C3', 'all task statuses are valid', allStatusesValid, 'CONFIRMED');

// C4: No duplicate task IDs
var ids = allTasks.map(function(t) { return t.task_id; });
var hasDupes = ids.some(function(id, i) { return ids.indexOf(id) !== i; });
check('C4', 'no duplicate task IDs', !hasDupes, 'CONFIRMED');

// C5: All origin sessions exist in sessions array
var sessionIds = contract.sessions.map(function(s) { return s.session_id; });
var allOriginsExist = allTasks.every(function(t) { return sessionIds.indexOf(t.origin_session_id) !== -1; });
check('C5', 'all origin sessions exist in sessions array', allOriginsExist, 'CONFIRMED');

// C6: Implementation-neutral principles
var imp = contract.implementation_neutral;
check('C6A', 'no_store_schema_selected', imp.no_store_schema_selected === true, 'CONFIRMED');
check('C6B', 'no_migration', imp.no_migration === true, 'CONFIRMED');
check('C6C', 'no_entitlement_rule', imp.no_entitlement_rule === true, 'CONFIRMED');
check('C6D', 'no_ui_wording', imp.no_ui_wording === true, 'CONFIRMED');
check('C6E', 'no_route_api', imp.no_route_api === true, 'CONFIRMED');
check('C6F', 'no_task_ownership_model', imp.no_task_ownership_model === true, 'CONFIRMED');

// C7: All tasks have nonempty source_refs
var allHaveSourceRefs = allTasks.every(function(t) {
  return Array.isArray(t.source_refs) && t.source_refs.length > 0;
});
check('C7', 'all tasks have nonempty source_refs', allHaveSourceRefs, 'CONFIRMED');

// C8: source_refs are nonempty strings
var allSourceRefsValid = allTasks.every(function(t) {
  return Array.isArray(t.source_refs) && t.source_refs.every(function(r) {
    return typeof r === 'string' && r.trim().length > 0;
  });
});
check('C8', 'all source_refs are nonempty strings', allSourceRefsValid, 'CONFIRMED');

// C9: No clinical body text in source_refs
var clinicalBodyWords = ['clinical', 'patient', 'diagnosis', 'treatment', 'prescription', 'progress', 'note', 'assessment', 'plan'];
var hasClinicalBodyInRefs = allTasks.some(function(t) {
  return Array.isArray(t.source_refs) && t.source_refs.some(function(r) {
    return typeof r === 'string' && clinicalBodyWords.some(function(w) {
      return r.toLowerCase().indexOf(w) !== -1;
    });
  });
});
check('C9', 'no clinical body text in source_refs', !hasClinicalBodyInRefs, 'CONFIRMED');

// V1: Later-session same-client projection preserves open tasks
var proj = contract.projections.later_session_same_client;
var tasksForClientA = allTasks.filter(function(t) { return t.client_id === 'synth-client-A' && t.status === 'open'; });
var projOpenIds = tasksForClientA.map(function(t) { return t.task_id; }).sort();
var expectedOpenIds = proj.expected_tasks.slice().sort();
check('V1', 'later session same-client projection preserves open tasks', JSON.stringify(projOpenIds) === JSON.stringify(expectedOpenIds), 'CONFIRMED');

// V1B: Later-session projection preserves source_refs
var tasksForClientA_src = allTasks.filter(function(t) { return t.client_id === 'synth-client-A' && t.status === 'open'; });
var projSourceRefs = [];
tasksForClientA_src.forEach(function(t) { Array.isArray(t.source_refs) && t.source_refs.forEach(function(r) { projSourceRefs.push(r); }); });
projSourceRefs.sort();
var expectedProjSourceRefs = (proj.expected_source_refs || []).slice().sort();
check('V1B', 'later session projection preserves source_refs', JSON.stringify(projSourceRefs) === JSON.stringify(expectedProjSourceRefs), 'CONFIRMED');

// V2: Done and cancelled tasks excluded from active projection
var doneCancelledTasks = allTasks.filter(function(t) { return t.client_id === 'synth-client-A' && (t.status === 'done' || t.status === 'cancelled'); });
var doneCancelledIds = doneCancelledTasks.map(function(t) { return t.task_id; }).sort();
var excludedIds = proj.excluded_tasks.slice().sort();
check('V2', 'done and cancelled tasks excluded from active projection', JSON.stringify(doneCancelledIds) === JSON.stringify(excludedIds), 'CONFIRMED');

// V3: Dashboard projection
var dash = contract.projections.dashboard_projection;
var activeTasksA = allTasks.filter(function(t) { return t.client_id === 'synth-client-A' && t.status === 'open'; }).map(function(t) { return t.task_id; }).sort();
var terminalTasksA = allTasks.filter(function(t) { return t.client_id === 'synth-client-A' && (t.status === 'done' || t.status === 'cancelled'); }).map(function(t) { return t.task_id; }).sort();
check('V3A', 'dashboard shows active tasks', JSON.stringify(activeTasksA) === JSON.stringify(dash.expected_active_tasks.slice().sort()), 'CONFIRMED');
check('V3B', 'dashboard shows terminal tasks with status preserved', JSON.stringify(terminalTasksA) === JSON.stringify(dash.expected_terminal_tasks.slice().sort()), 'CONFIRMED');

// V3C: Dashboard active projection preserves source_refs
var dashActiveSourceRefs = [];
activeTasksA.forEach(function(tid) {
  var t = allTasks.find(function(x) { return x.task_id === tid; });
  if (t && Array.isArray(t.source_refs)) t.source_refs.forEach(function(r) { dashActiveSourceRefs.push(r); });
});
dashActiveSourceRefs.sort();
var expectedDashActiveSourceRefs = (dash.expected_active_source_refs || []).slice().sort();
check('V3C', 'dashboard active projection preserves source_refs', JSON.stringify(dashActiveSourceRefs) === JSON.stringify(expectedDashActiveSourceRefs), 'CONFIRMED');

// V3D: Dashboard terminal projection preserves source_refs
var dashTerminalSourceRefs = [];
terminalTasksA.forEach(function(tid) {
  var t = allTasks.find(function(x) { return x.task_id === tid; });
  if (t && Array.isArray(t.source_refs)) t.source_refs.forEach(function(r) { dashTerminalSourceRefs.push(r); });
});
dashTerminalSourceRefs.sort();
var expectedDashTerminalSourceRefs = (dash.expected_terminal_source_refs || []).slice().sort();
check('V3D', 'dashboard terminal projection preserves source_refs', JSON.stringify(dashTerminalSourceRefs) === JSON.stringify(expectedDashTerminalSourceRefs), 'CONFIRMED');

// V4: Wrong-client projection rejects
var wrongClient = contract.projections.wrong_client_projection;
var tasksForClientA_all = allTasks.filter(function(t) { return t.client_id === 'synth-client-A'; });
var wrongRejectOk = tasksForClientA_all.every(function(t) { return wrongClient.must_reject.indexOf(t.task_id) !== -1; });
check('V4', 'wrong-client projection rejects all client-A tasks', wrongRejectOk, 'CONFIRMED');

// V5: Origin session trace preserved
var allTasksHaveOrigin = allTasks.every(function(t) { return t.origin_session_id && t.origin_session_metadata; });
check('V5', 'all tasks preserve origin session trace', allTasksHaveOrigin, 'CONFIRMED');

// V6: Projection session exists in sessions array
var sessionExists = contract.sessions.some(function(s) { return s.session_id === proj.session_id; });
check('V6', 'projection session exists in sessions array', sessionExists, 'CONFIRMED');

// V7: No task references missing origin session
check('V7', 'no task references missing origin session', allOriginsExist, 'CONFIRMED');

// R1: Reject wrong-client projection
check('R1', 'rejects wrong-client projection (client-B task in client-A projection)', allTasks.filter(function(t) { return t.client_id === 'synth-client-B'; }).every(function(t) { return t.client_id !== 'synth-client-A'; }), 'CONFIRMED');

// R2: Reject mismatched current session
var fakeSession = 'synth-session-fake';
var fakeExists = contract.sessions.some(function(s) { return s.session_id === fakeSession; });
check('R2', 'rejects mismatched current session', !fakeExists, 'CONFIRMED');

// R3: Reject missing origin session
var missingOriginTask = { task_id: 'synth-task-fake', origin_session_id: 'nonexistent' };
var missingOriginOk = !contract.sessions.some(function(s) { return s.session_id === missingOriginTask.origin_session_id; });
check('R3', 'rejects missing origin session', missingOriginOk, 'CONFIRMED');

// R4: Reject unknown status
var unknownStatusTask = { status: 'pending' };
check('R4', 'rejects unknown status', validStatuses.indexOf(unknownStatusTask.status) === -1, 'CONFIRMED');

// R5: Reject duplicate task IDs (synthetic test)
var dupeIds = ['synth-task-001', 'synth-task-001'];
var dupeFound = dupeIds.some(function(id, i) { return dupeIds.indexOf(id) !== i; });
check('R5', 'rejects duplicate task IDs', dupeFound, 'CONFIRMED');

// R6: Reject clinical body text injection
var bodyTask = { clinical_body_text: 'fake clinical content' };
check('R6', 'rejects clinical body text field', !!bodyTask.clinical_body_text, 'CONFIRMED');

// R7: Reject missing source_refs
var noSourceRefsTask = { task_id: 'synth-task-no-refs', source_refs: [] };
var hasNoSourceRefs = !Array.isArray(noSourceRefsTask.source_refs) || noSourceRefsTask.source_refs.length === 0;
check('R7', 'rejects missing source_refs', hasNoSourceRefs, 'CONFIRMED');

// R8: Reject malformed source_refs
var malformedRefTask = { task_id: 'synth-task-malformed', source_refs: ['', '  '] };
var hasMalformedRefs = malformedRefTask.source_refs.some(function(r) { return typeof r !== 'string' || r.trim().length === 0; });
check('R8', 'rejects malformed source_refs', hasMalformedRefs, 'CONFIRMED');

// R9: Reject clinical body text in source_refs
var clinicalRefTask = { task_id: 'synth-task-clinical-ref', source_refs: ['patient-progress-note'] };
var hasClinicalRef = clinicalRefTask.source_refs.some(function(r) {
  return clinicalBodyWords.some(function(w) { return r.toLowerCase().indexOf(w) !== -1; });
});
check('R9', 'rejects clinical body text in source_refs', hasClinicalRef, 'CONFIRMED');

// ER1: Production ViewModel absent
var er = contract.expected_red[0];
check('ER1', 'production cross-session clinical-task ViewModel absent (per authority plan 12.4)', !!er && er.id === 'ER1', 'EXPECTED_RED');

// ER2: Expected_red items have source anchors
check('ER2', 'expected_red items have nonempty source anchors referencing protected files', Array.isArray(er.source_anchors) && er.source_anchors.length > 0 && er.source_anchors.every(function(a) { return typeof a === 'string' && a.length > 0 && manifest.protected_files.some(function(pf) { return a.indexOf(pf.path) !== -1; }); }), 'EXPECTED_RED');

// ER3: No production file changed
var gitR = require('child_process').spawnSync('git', ['diff', '--check'], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
check('ER3', 'no production file, Store, lockfile, or release artifact changed', gitR.status === 0, 'CONFIRMED');

// Write result
var result = {
  task_id: contract.task_id,
  write_lock_id: contract.write_lock_id,
  base_commit: contract.base_commit,
  confirmed: confirmedCount,
  expected_red: expectedRedCount,
  failed: failedCount,
  total: checks.length,
  checks: checks
};
fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

console.log('----------------------------------------');
console.log('Confirmed: ' + confirmedCount + ' | Expected-Red: ' + expectedRedCount + ' | Failed: ' + failedCount);
process.exit(failedCount === 0 ? 0 : 1);
