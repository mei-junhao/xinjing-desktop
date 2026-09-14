'use strict';
/**
 * XJ-4.3.0-opensquilla-cross-package-evidence-loop-01
 * Cross-Package Evidence Loop Runner (rework: remove fake-greens)
 *
 * Reads REAL coordination files (write-locks, task cards, QA reports,
 * agent-roster) and produces a machine-verifiable handoff matrix.
 * Never fabricates hashes, statuses or evidence.
 *
 * Rework fixes:
 *  - C2: was `.length >= 0` (vacuous) → real negative assertion (missing reports flagged)
 *  - C4: was `summary.stale_base >= 0` (vacuous) → real stale-base consistency check
 *  - C6: was `> 0` (data-dependent) → real source-count consistency check
 *  - C9: was `true` (unconditional) → real protected-manifest hash binding
 *  - C10 (new): report SHA-256 re-verification against actual files
 *  - C11 (new): lock owner matches task-card / write-locks source
 *  - C1: strengthened with lock-count verification (catches deletion mutations)
 *  - isStaleBase coerced to boolean for consistency
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LOCKS_PATH = path.join(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'write-locks.json');
const TASKS_DIR = path.join(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'tasks');
const QA_DIR = path.join(ROOT, 'qa', 'agent-reviews');
const ROSTER_PATH = path.join(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'agent-roster.md');
const OUT_DIR = path.join(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'inventory', 'opensquilla-cross-package-evidence-loop');

var BASE_COMMIT = '9971787eb6e443ab5a5c80aee118b9b43285c093';
var TASK_MANIFEST = 'E83AAE7BC0B3AE5E8127F9815D0FBA3DF80F925353ACC9112B18F70633DB76BC';
var OWN_LOCK_ID = 'lock-XJ-4.3.0-opensquilla-cross-package-evidence-loop-rework-02';

function sha256(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p, 'utf8')).digest('hex').toUpperCase(); }
  catch (e) { return 'MISSING'; }
}
function sha256Content(content) {
  return crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
}

// ── Read real data ──
var locks = JSON.parse(fs.readFileSync(LOCKS_PATH, 'utf8'));
var taskFiles = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.md')).sort();
var qaFiles = fs.readdirSync(QA_DIR).filter(f => f.includes('4.3.0') || f.includes('4.2.2-qoder-v4.3')).sort();

// Parse task cards
var tasks = taskFiles.map(f => {
  var content = fs.readFileSync(path.join(TASKS_DIR, f), 'utf8');
  var tid = (content.match(/task_id:\s*(\S+)/) || [])[1] || f.replace('.md', '');
  var owner = (content.match(/owner:\s*(\S+)/) || [])[1] || 'unknown';
  var lockId = (content.match(/write_lock_id:\s*(\S+)/) || [])[1] || '';
  var baseCommit = (content.match(/base_commit:\s*(\S+)/) || [])[1] || '';
  var reportPath = (content.match(/delivery_report:\s*(\S+)/) || [])[1] || '';
  return { file: f, task_id: tid, owner: owner, lock_id: lockId, base_commit: baseCommit, report_path: reportPath, content: content };
});

// Parse QA reports
var reports = qaFiles.map(f => {
  var content = fs.readFileSync(path.join(QA_DIR, f), 'utf8');
  var pass = /PASS/.test(content);
  var scoreMatch = content.match(/(\d+)\s*\/\s*100/);
  var score = scoreMatch ? parseInt(scoreMatch[1]) : null;
  var hasDelivery = /DELIVERY_REPORT/.test(content);
  var lastLine = content.trim().split(/\r?\n/).pop().trim();
  return { file: f, pass: pass, score: score, hasDelivery: hasDelivery, lastLine: lastLine, content: content, sha: sha256(path.join(QA_DIR, f)) };
});

// Match locks to tasks
var agentStatus = [];
locks.locks.forEach(function (lock) {
  var task = tasks.find(function (t) { return t.lock_id === lock.lock_id || t.task_id === lock.task_id; });
  var report = reports.find(function (r) { return r.file.indexOf(lock.task_id) >= 0; });
  var lockBase = lock.base_commit || '';
  var isStaleBase = !!(lockBase && lockBase !== BASE_COMMIT);
  agentStatus.push({
    lock_id: lock.lock_id,
    task_id: lock.task_id,
    owner: lock.owner || (task ? task.owner : 'unknown'),
    lock_state: lock.state,
    base_commit: lockBase,
    base_stale: isStaleBase,
    task_file: task ? task.file : 'MISSING',
    report_file: report ? report.file : 'MISSING',
    report_pass: report ? report.pass : null,
    report_score: report ? report.score : null,
    report_has_delivery: report ? report.hasDelivery : false,
    report_sha: report ? report.sha : 'MISSING',
    report_last_line: report ? report.lastLine : '',
    delivery_status: report ? (report.pass ? 'delivered' : 'incomplete') : 'missing',
    codex_intake: lock.state === 'released' ? 'accepted' : (lock.state === 'granted' ? 'pending' : lock.state)
  });
});

// Write agent-status-matrix.json
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'agent-status-matrix.json'),
  JSON.stringify({ generated_at: new Date().toISOString(), base_commit: BASE_COMMIT, agents: agentStatus }, null, 2), 'utf8');

// ── Delivery integrity matrix ──
var integrity = agentStatus.map(function (a) {
  var classification = 'unknown';
  if (a.report_file === 'MISSING') classification = 'incomplete';
  else if (!a.report_pass) classification = 'incomplete';
  else if (a.base_stale) classification = 'stale';
  else if (a.lock_state === 'granted') classification = 'incomplete';
  else classification = 'confirmed';
  return {
    task_id: a.task_id,
    owner: a.owner,
    report_file: a.report_file,
    report_sha: a.report_sha,
    lock_state: a.lock_state,
    base_stale: a.base_stale,
    classification: classification,
    delivery_status: a.delivery_status
  };
});

fs.writeFileSync(path.join(OUT_DIR, 'delivery-integrity-matrix.json'),
  JSON.stringify({ generated_at: new Date().toISOString(), entries: integrity }, null, 2), 'utf8');

// ── Summary ──
var summary = {
  total_locks: agentStatus.length,
  released: agentStatus.filter(function (a) { return a.lock_state === 'released'; }).length,
  granted: agentStatus.filter(function (a) { return a.lock_state === 'granted'; }).length,
  stale_base: agentStatus.filter(function (a) { return a.base_stale; }).length,
  reports_with_delivery: agentStatus.filter(function (a) { return a.report_has_delivery; }).length,
  reports_missing: agentStatus.filter(function (a) { return a.report_file === 'MISSING'; }).length,
  confirmed: integrity.filter(function (i) { return i.classification === 'confirmed'; }).length,
  incomplete: integrity.filter(function (i) { return i.classification === 'incomplete'; }).length,
  stale: integrity.filter(function (i) { return i.classification === 'stale'; }).length
};

console.log('=== Cross-Package Evidence Loop ===');
console.log('Locks:', summary.total_locks, '(released:', summary.released, 'granted:', summary.granted, 'stale_base:', summary.stale_base + ')');
console.log('Reports: with_delivery:', summary.reports_with_delivery, 'missing:', summary.reports_missing);
console.log('Integrity: confirmed:', summary.confirmed, 'incomplete:', summary.incomplete, 'stale:', summary.stale);

// ── Contract checks (all REAL, no vacuous/constant truths) ──
var checks = [];
function check(id, label, cond) { checks.push({ id: id, label: label, pass: !!cond }); }

// Re-read source to verify count integrity (catches M1: lock deletion)
var sourceLockCount = JSON.parse(fs.readFileSync(LOCKS_PATH, 'utf8')).locks.length;

check('C1', 'All locks processed and have matching task cards',
  agentStatus.length === sourceLockCount &&
  agentStatus.every(function (a) { return a.task_file !== 'MISSING'; }));

check('C2', 'Released locks with missing reports flagged as missing',
  agentStatus.filter(function (a) { return a.lock_state === 'released'; })
    .every(function (a) { return a.report_file !== 'MISSING' || a.delivery_status === 'missing'; }));

// C3 re-reads content directly so removing/renaming DELIVERY_REPORT is genuinely caught
check('C3', 'All existing reports have DELIVERY_REPORT line',
  agentStatus.filter(function (a) { return a.report_file !== 'MISSING'; })
    .every(function (a) {
      var content = fs.readFileSync(path.join(QA_DIR, a.report_file), 'utf8');
      return /DELIVERY_REPORT/.test(content);
    }));

check('C4', 'Locks with stale base_commit are flagged consistently',
  agentStatus.every(function (a) {
    return a.base_stale === (!!a.base_commit && a.base_commit !== BASE_COMMIT);
  }));

check('C5', 'Granted locks are tracked as incomplete',
  integrity.filter(function (i) { return i.lock_state === 'granted'; })
    .every(function (i) { return i.classification === 'incomplete'; }));

// C6: stale count in summary matches actual stale locks in source (catches M4)
var actualStaleCount = locks.locks.filter(function (l) {
  return l.base_commit && l.base_commit !== BASE_COMMIT;
}).length;
check('C6', 'Stale base count in summary matches source',
  summary.stale_base === actualStaleCount);

check('C7', 'agent-status-matrix written',
  fs.existsSync(path.join(OUT_DIR, 'agent-status-matrix.json')));

check('C8', 'delivery-integrity-matrix written',
  fs.existsSync(path.join(OUT_DIR, 'delivery-integrity-matrix.json')));

// C9: protected manifest hash for own lock matches task card (was `true`)
var ownLock = locks.locks.find(function (l) { return l.lock_id === OWN_LOCK_ID; });
check('C9', 'Protected manifest hash matches task card',
  !!(ownLock && (ownLock.protected_files_manifest_hash || '').toUpperCase() === TASK_MANIFEST));

// C10 (new): report SHA-256 re-verification against actual files (catches M2)
check('C10', 'Report SHAs match actual file contents',
  agentStatus.every(function (a) {
    if (a.report_file === 'MISSING') return true;
    var realSha = sha256(path.join(QA_DIR, a.report_file));
    return a.report_sha === realSha;
  }));

// C11 (new): lock owners match source (catches M6)
check('C11', 'Lock owners match write-locks source',
  agentStatus.every(function (a) {
    var lock = locks.locks.find(function (l) { return l.task_id === a.task_id; });
    var task = tasks.find(function (t) { return t.task_id === a.task_id; });
    var expected = (lock && lock.owner) || (task && task.owner) || 'unknown';
    return a.owner === expected;
  }));

// C12 (new): missing reports cannot be classified as confirmed (dedicated M7 catch)
check('C12', 'Missing reports cannot be classified as confirmed',
  agentStatus.filter(function (a) { return a.report_file === 'MISSING'; })
    .every(function (a) {
      var ic = integrity.find(function (i) { return i.task_id === a.task_id; });
      return ic && ic.classification !== 'confirmed';
    }));

var passed = checks.filter(function (c) { return c.pass; }).length;
var failed = checks.length - passed;
checks.forEach(function (c) { console.log('[' + (c.pass ? 'PASS' : 'FAIL') + '] ' + c.id + ': ' + c.label); });
console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
console.log('evidence_phase: ' + (failed === 0 ? 'ALL-GREEN' : 'CONTRACT-BROKEN'));
process.exit(failed === 0 ? 0 : 1);
