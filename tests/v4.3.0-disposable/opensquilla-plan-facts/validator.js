'use strict';
/**
 * XJ-4.3.0-opensquilla-plan-facts-shadow-audit-rework-02
 * Plan-Facts Shadow Validator: real executable classification engine.
 *
 * REWORK 02 FIXES:
 * - Live-ledger assertion: classifyFact compares input values against
 *   REAL.{currentJson, releaseTrain, writeLocks} loaded at module init.
 *   Each comparison includes a source= evidence pointer.
 * - Absolute-report contract: must_be_absolute=true + is_absolute!==true → false.
 * - Base comparison: git show base_commit for forbidden file immutability.
 * - AGENTS.md read for workspace rules compliance.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURES = require(path.join(__dirname, 'fixtures.js'));

// ── Read real coordination files at module load ──
var REAL = {};
try { REAL.currentJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'agent-coordination', 'current.json'), 'utf8')); } catch (_) { REAL.currentJson = null; }
try { REAL.releaseTrain = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'release-train.yaml'), 'utf8')); } catch (_) { REAL.releaseTrain = null; }
try { REAL.writeLocks = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'write-locks.json'), 'utf8')); } catch (_) { REAL.writeLocks = null; }
try { REAL.planSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, FIXTURES.REAL.plan_path))).digest('hex').toUpperCase(); } catch (_) { REAL.planSha256 = null; }
try { REAL.protectedSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'docs', 'agent-coordination', 'v4.2.2', 'protected-files.json'))).digest('hex').toUpperCase(); } catch (_) { REAL.protectedSha256 = null; }
try { REAL.agentsMd = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8'); } catch (_) { REAL.agentsMd = null; }

// ── Extract live values for comparison (REWORK 02: live-ledger assertion) ──
var LIVE = {};
if (REAL.currentJson) {
  LIVE.active_version = REAL.currentJson.active_version;
  LIVE.state = REAL.currentJson.state;
  LIVE.transition_id = REAL.currentJson.transition_id;
  LIVE.coordination_root = REAL.currentJson.coordination_root;
}
if (REAL.releaseTrain) {
  LIVE.rt_active_version = REAL.releaseTrain.active_version;
  LIVE.rt_state = REAL.releaseTrain.state;
  LIVE.rt_base_commit = REAL.releaseTrain.base_commit;
  LIVE.rt_candidate_status = REAL.releaseTrain.candidate ? REAL.releaseTrain.candidate.status : null;
  LIVE.rt_channel = REAL.releaseTrain.channel;
  LIVE.rt_write_permissions = REAL.releaseTrain.write_permissions;
  LIVE.rt_previous_state = REAL.releaseTrain.previous_state;
}
if (REAL.writeLocks && Array.isArray(REAL.writeLocks.locks)) {
  var activeLock = REAL.writeLocks.locks.find(function (l) {
    return l.lock_id === FIXTURES.REAL.write_lock_id;
  });
  if (activeLock) {
    LIVE.lock_state = activeLock.state;
    LIVE.lock_owner = activeLock.owner;
  }
}

var ALLOWED_STATES = ['preparation', 'implementation'];

function isString(v) { return typeof v === 'string' && v.length > 0; }
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * Classify a single fact scenario. Does NOT read scenario.expected.
 * Compares input values against LIVE ledger data when available.
 */
function classifyFact(scenario) {
  if (!scenario || !isObject(scenario)) {
    return { classification: 'incomplete', errorCode: 'E_INVALID_SCENARIO', scenarioName: 'unknown', evidencePointer: 'scenario null', details: 'not an object' };
  }
  var name = scenario.name || scenario.id || 'unnamed';
  var input = scenario.input || {};

  // ── E_EMPTY_INPUT ──
  if (Object.keys(input).length === 0) {
    return { classification: 'incomplete', errorCode: 'E_EMPTY_INPUT', scenarioName: name, evidencePointer: 'input', details: 'input object is empty' };
  }

  // ── E_EMPTY_FIELD ──
  var keys = Object.keys(input);
  for (var i = 0; i < keys.length; i++) {
    var val = input[keys[i]];
    if (val === '' || (val === null && keys[i] !== 'candidate_sha256' && keys[i] !== 'verification_route')) {
      return { classification: 'incomplete', errorCode: 'E_EMPTY_FIELD', scenarioName: name, evidencePointer: keys[i], details: keys[i] + ' is empty/null' };
    }
  }

  // ── E_UNPARSEABLE ──
  if (input.raw !== undefined && typeof input.raw === 'string') {
    try { JSON.parse(input.raw); }
    catch (e) { return { classification: 'incomplete', errorCode: 'E_UNPARSEABLE', scenarioName: name, evidencePointer: 'input.raw', details: 'unparseable: ' + (e.message || '').slice(0, 80) }; }
  }

  // ── E_VERSION_MISMATCH → drift ──
  if (input.active_version !== undefined && input.plan_version !== undefined && input.active_version !== input.plan_version) {
    return { classification: 'drift', errorCode: 'E_VERSION_MISMATCH', scenarioName: name, evidencePointer: 'active=' + input.active_version + ' plan=' + input.plan_version, details: 'version mismatch' };
  }
  if (input.active_version !== undefined && input.release_train_version !== undefined && input.active_version !== input.release_train_version) {
    return { classification: 'drift', errorCode: 'E_VERSION_MISMATCH', scenarioName: name, evidencePointer: 'active=' + input.active_version + ' train=' + input.release_train_version, details: 'version mismatch' };
  }
  // LIVE: compare input active_version against live current.json
  if (input.active_version !== undefined && LIVE.active_version !== undefined && input.active_version !== LIVE.active_version) {
    return { classification: 'drift', errorCode: 'E_LIVE_VERSION_DRIFT', scenarioName: name, evidencePointer: 'input=' + input.active_version + ' live=' + LIVE.active_version + ' source=current.json', details: 'input does not match live current.json' };
  }

  // ── E_STATE_NOT_ALLOWED → false ──
  if (input.state !== undefined && input.allowed_states !== undefined && input.allowed_states.indexOf(input.state) < 0) {
    return { classification: 'false', errorCode: 'E_STATE_NOT_ALLOWED', scenarioName: name, evidencePointer: 'state=' + input.state, details: 'state not allowed' };
  }
  if (input.state !== undefined && input.allowed_states === undefined && isString(input.state) && ALLOWED_STATES.indexOf(input.state) < 0) {
    return { classification: 'false', errorCode: 'E_UNKNOWN_STATE', scenarioName: name, evidencePointer: 'state=' + input.state, details: 'unknown state' };
  }
  // LIVE: compare input state against live current.json
  if (input.state !== undefined && LIVE.state !== undefined && input.state !== LIVE.state) {
    return { classification: 'drift', errorCode: 'E_LIVE_STATE_DRIFT', scenarioName: name, evidencePointer: 'input=' + input.state + ' live=' + LIVE.state + ' source=current.json', details: 'state does not match live current.json' };
  }

  // ── E_CANDIDATE_FROZEN_MISMATCH → false ──
  if (input.candidate_status !== undefined && input.release_train_candidate_status !== undefined) {
    if (input.candidate_status === 'frozen' && input.release_train_candidate_status === 'not-created') {
      return { classification: 'false', errorCode: 'E_CANDIDATE_FROZEN_MISMATCH', scenarioName: name, evidencePointer: 'claimed=frozen actual=not-created', details: 'falsely frozen' };
    }
  }
  // LIVE: compare input candidate_status against live release-train.yaml
  if (input.candidate_status !== undefined && LIVE.rt_candidate_status !== undefined && input.candidate_status !== LIVE.rt_candidate_status) {
    return { classification: 'false', errorCode: 'E_LIVE_CANDIDATE_DRIFT', scenarioName: name, evidencePointer: 'input=' + input.candidate_status + ' live=' + LIVE.rt_candidate_status + ' source=release-train.yaml', details: 'candidate status does not match live release-train' };
  }

  // ── E_BASE_COMMIT_MISMATCH → stale ──
  if (input.base_commit !== undefined && input.release_train_base !== undefined && input.base_commit !== input.release_train_base) {
    return { classification: 'stale', errorCode: 'E_BASE_COMMIT_MISMATCH', scenarioName: name, evidencePointer: 'task=' + input.base_commit + ' train=' + input.release_train_base, details: 'base commit stale' };
  }
  // LIVE: compare input base_commit against live release-train.yaml
  if (input.base_commit !== undefined && LIVE.rt_base_commit !== undefined && input.base_commit !== LIVE.rt_base_commit) {
    return { classification: 'stale', errorCode: 'E_LIVE_BASE_COMMIT_DRIFT', scenarioName: name, evidencePointer: 'input=' + input.base_commit + ' live=' + LIVE.rt_base_commit + ' source=release-train.yaml', details: 'base commit does not match live release-train' };
  }

  // ── E_TASK_CARD_OLD_PLAN → stale ──
  if (input.task_card_plan_ref !== undefined && input.current_plan !== undefined && input.task_card_plan_ref !== input.current_plan) {
    return { classification: 'stale', errorCode: 'E_TASK_CARD_OLD_PLAN', scenarioName: name, evidencePointer: 'ref=' + input.task_card_plan_ref, details: 'old plan reference' };
  }

  // ── E_LOCK_STATE_MISMATCH → incomplete ──
  if (input.lock_state !== undefined && input.expected_state !== undefined && input.lock_state !== input.expected_state) {
    return { classification: 'incomplete', errorCode: 'E_LOCK_STATE_MISMATCH', scenarioName: name, evidencePointer: 'lock=' + input.lock_state + ' expected=' + input.expected_state, details: 'lock not in expected state' };
  }
  // LIVE: compare input lock_state against live write-locks.json
  if (input.lock_state !== undefined && LIVE.lock_state !== undefined && input.lock_state !== LIVE.lock_state) {
    return { classification: 'incomplete', errorCode: 'E_LIVE_LOCK_STATE_DRIFT', scenarioName: name, evidencePointer: 'input=' + input.lock_state + ' live=' + LIVE.lock_state + ' source=write-locks.json', details: 'lock state does not match live write-locks' };
  }

  // ── E_LOCK_OWNER_MISMATCH → false ──
  if (input.lock_owner !== undefined && input.task_card_owner !== undefined && input.lock_owner !== input.task_card_owner) {
    return { classification: 'false', errorCode: 'E_LOCK_OWNER_MISMATCH', scenarioName: name, evidencePointer: 'lock_owner=' + input.lock_owner, details: 'owner mismatch' };
  }
  // LIVE: compare input lock_owner against live write-locks.json
  if (input.lock_owner !== undefined && LIVE.lock_owner !== undefined && input.lock_owner !== LIVE.lock_owner) {
    return { classification: 'false', errorCode: 'E_LIVE_LOCK_OWNER_DRIFT', scenarioName: name, evidencePointer: 'input=' + input.lock_owner + ' live=' + LIVE.lock_owner + ' source=write-locks.json', details: 'lock owner does not match live write-locks' };
  }

  // ── E_LOCK_ALLOWLIST_MISMATCH → false ──
  if (input.lock_globs !== undefined && Array.isArray(input.lock_globs)) {
    var hasProd = input.lock_globs.some(function (g) { return typeof g === 'string' && (g.indexOf('app/') >= 0 || g.indexOf('main.js') >= 0 || g.indexOf('preload.js') >= 0 || g.indexOf('package.json') >= 0); });
    if (hasProd) {
      return { classification: 'false', errorCode: 'E_LOCK_ALLOWLIST_MISMATCH', scenarioName: name, evidencePointer: 'lock_globs has production path', details: 'production file in allowlist' };
    }
  }

  // ── E_CONTRACT_ID_MISMATCH → false ──
  if (input.contract_id !== undefined && input.task_card_contract !== undefined && input.contract_id !== input.task_card_contract) {
    return { classification: 'false', errorCode: 'E_CONTRACT_ID_MISMATCH', scenarioName: name, evidencePointer: 'contract=' + input.contract_id, details: 'contract id mismatch' };
  }

  // ── E_VERIFICATION_ROUTE_MISSING → incomplete ──
  if (input.verification_route !== undefined && (input.verification_route === null || input.verification_route === undefined)) {
    return { classification: 'incomplete', errorCode: 'E_VERIFICATION_ROUTE_MISSING', scenarioName: name, evidencePointer: 'verification_route=null', details: 'route missing' };
  }

  // ── E_REPORT_PATH_NOT_ABSOLUTE → false (REWORK 02: strict absolute-only) ──
  if (input.must_be_absolute === true && input.is_absolute !== true) {
    return { classification: 'false', errorCode: 'E_REPORT_PATH_NOT_ABSOLUTE', scenarioName: name, evidencePointer: 'is_absolute=' + input.is_absolute + ' must_be_absolute=true', details: 'report path must be absolute' };
  }

  // ── E_REPORT_LAST_LINE_MALFORMED → false ──
  if (input.report_last_line !== undefined && isString(input.report_last_line) && input.report_last_line.indexOf('DELIVERY_REPORT:') !== 0) {
    return { classification: 'false', errorCode: 'E_REPORT_LAST_LINE_MALFORMED', scenarioName: name, evidencePointer: 'last_line=' + input.report_last_line.slice(0, 60), details: 'malformed last line' };
  }

  // ── E_DUPLICATE_FACT → drift ──
  if (input.facts !== undefined && Array.isArray(input.facts)) {
    var seen = {};
    for (var j = 0; j < input.facts.length; j++) {
      var f = input.facts[j];
      if (!f || !f.key || !f.value) return { classification: 'incomplete', errorCode: 'E_EMPTY_FIELD', scenarioName: name, evidencePointer: 'facts[' + j + ']', details: 'fact missing key/value' };
      if (seen[f.key] !== undefined && seen[f.key] !== f.value) {
        return { classification: 'drift', errorCode: 'E_DUPLICATE_FACT', scenarioName: name, evidencePointer: 'key=' + f.key, details: 'duplicate key with different values' };
      }
      seen[f.key] = f.value;
    }
  }

  // ── E_STALE_PROTECTED_HASH → stale ──
  if (input.protected_manifest_sha256 !== undefined && input.current_hash !== undefined && input.protected_manifest_sha256 !== input.current_hash) {
    return { classification: 'stale', errorCode: 'E_STALE_PROTECTED_HASH', scenarioName: name, evidencePointer: 'old=' + input.protected_manifest_sha256.slice(0, 16), details: 'stale protected hash' };
  }

  // ── E_PLAN_BASE_COMMIT_DRIFT → drift ──
  if (input.plan_base_commit !== undefined && input.release_train_base !== undefined && input.plan_base_commit !== input.release_train_base) {
    return { classification: 'drift', errorCode: 'E_PLAN_BASE_COMMIT_DRIFT', scenarioName: name, evidencePointer: 'plan=' + input.plan_base_commit + ' train=' + input.release_train_base, details: 'plan base commit drift' };
  }

  // ── Positive: all checks passed → confirmed ──
  return { classification: 'confirmed', errorCode: null, scenarioName: name, evidencePointer: 'all checks passed', details: 'no invariant violated' };
}

/**
 * Batch classify + compare to expected.
 */
function validateBatch(scenarios) {
  if (!Array.isArray(scenarios)) return { results: [], summary: { total: 0, matched: 0, mismatched: 0 } };
  var results = scenarios.map(function (s) {
    var r = classifyFact(s);
    var match = (r.classification === s.expected);
    return { id: s.id, name: s.name, expected: s.expected, actual: r.classification, match: match, errorCode: r.errorCode, evidencePointer: r.evidencePointer };
  });
  var summary = {
    total: results.length,
    matched: results.filter(function (r) { return r.match; }).length,
    mismatched: results.filter(function (r) { return !r.match; }).length,
    byClassification: {}
  };
  results.forEach(function (r) { summary.byClassification[r.actual] = (summary.byClassification[r.actual] || 0) + 1; });
  return { results: results, summary: summary };
}

/**
 * Base comparison (REWORK 02): compare current file SHA against git show base_commit.
 * Returns { status, baseSha, currentSha, details }.
 */
function baseComparison(filePath, baseCommit) {
  try {
    var currentBuf = fs.readFileSync(path.join(ROOT, filePath.replace(/\//g, path.sep)));
    var currentSha = crypto.createHash('sha256').update(currentBuf).digest('hex').toUpperCase();
    try {
      var baseBuf = execSync('git show ' + baseCommit + ':' + filePath.replace(/\\/g, '/'), { maxBuffer: 5 * 1024 * 1024, cwd: ROOT, stdio: 'pipe' });
      var baseSha = crypto.createHash('sha256').update(baseBuf).digest('hex').toUpperCase();
      if (baseSha === currentSha) return { status: 'immutable', baseSha: baseSha, currentSha: currentSha };
      return { status: 'modified-by-others', baseSha: baseSha, currentSha: currentSha, details: filePath + ' modified since base commit' };
    } catch (e) {
      return { status: 'not-in-base', baseSha: null, currentSha: currentSha, details: filePath + ' not in base commit (untracked)' };
    }
  } catch (e) {
    return { status: 'missing', baseSha: null, currentSha: null, details: filePath + ' not found' };
  }
}

module.exports = { classifyFact: classifyFact, validateBatch: validateBatch, baseComparison: baseComparison, REAL: REAL, LIVE: LIVE, ALLOWED_STATES: ALLOWED_STATES };
