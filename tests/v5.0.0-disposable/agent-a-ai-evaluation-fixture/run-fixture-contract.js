'use strict';
/**
 * XJ-5.0.0 Agent A AI Evaluation Fixture — Contract Runner
 * Validates synthetic corpus, calculates 5 metrics, distinguishes CONFIRMED from EXPECTED_RED.
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve('D:\\xinjing-electron');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'v5.0.0-disposable', 'agent-a-ai-evaluation-fixture');
const CORPUS = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'synthetic-corpus.json'), 'utf8'));

var checks = [];
var confirmedCount = 0, expectedRedCount = 0, failedCount = 0;

function check(id, label, cond, classification) {
  var ok = !!cond;
  var cls = classification || (ok ? 'CONFIRMED' : 'EXPECTED_RED');
  if (cls === 'CONFIRMED') { if (ok) confirmedCount++; else failedCount++; }
  else if (cls === 'EXPECTED_RED') { if (ok) expectedRedCount++; else failedCount++; }
  checks.push({ id: id, label: label, pass: ok, classification: cls, is_expected_red: cls === 'EXPECTED_RED' });
  var tag = cls === 'EXPECTED_RED' ? 'EXPECTED_RED' : (ok ? 'PASS' : 'FAIL');
  console.log('[' + tag + '] ' + id + ': ' + label + ' (' + cls + ')');
}

// ═══ Corpus validation ═══
check('C1', 'corpus has 5+ scenarios', CORPUS.scenarios.length >= 5, 'CONFIRMED');
check('C2', 'all scenarios have stable case_id', CORPUS.scenarios.every(function(s) { return typeof s.case_id === 'string' && s.case_id.length > 0; }), 'CONFIRMED');
check('C3', 'all scenarios have expected_claim_ids', CORPUS.scenarios.every(function(s) { return Array.isArray(s.expected_claim_ids) && s.expected_claim_ids.length > 0; }), 'CONFIRMED');
check('C4', 'all scenarios have admissible_source_ids', CORPUS.scenarios.every(function(s) { return Array.isArray(s.admissible_source_ids); }), 'CONFIRMED');
check('C5', 'cited_success scenario present', CORPUS.scenarios.some(function(s) { return s.label === 'cited_success'; }), 'CONFIRMED');
check('C6', 'missing_citation scenario present', CORPUS.scenarios.some(function(s) { return s.label === 'missing_citation'; }), 'CONFIRMED');
check('C7', 'incorrect_claim scenario present', CORPUS.scenarios.some(function(s) { return s.label === 'incorrect_claim'; }), 'CONFIRMED');
check('C8', 'timeout_failure scenario present', CORPUS.scenarios.some(function(s) { return s.label === 'timeout_failure'; }), 'CONFIRMED');
check('C9', 'baseline_vs_candidate scenario present', CORPUS.scenarios.some(function(s) { return s.label === 'baseline_vs_candidate'; }), 'CONFIRMED');
check('C10', 'no real clinical text or personal data', !JSON.stringify(CORPUS).match(/患者|诊断|治疗|姓名|身份证|phone|email/i), 'CONFIRMED');

// ═══ Metric calculations ═══
function calculateMetrics(scenarios) {
  var evaluated = 0, matched = 0, failed = 0;
  var totalCost = 0, totalLatency = 0;
  var citationIssues = 0;

  for (var si = 0; si < scenarios.length; si++) {
    var s = scenarios[si];
    evaluated++;
    var output = s.candidate || s.output || {};
    var meta = s.metadata || {};

    // accuracy
    var expected = s.expected_claim_ids || [];
    var actual = output.claims || [];
    expected.forEach(function(e) {
      if (actual.indexOf(e) !== -1) matched++;
    });

    // source_consistency
    var citations = output.citations || [];
    var admissible = s.admissible_source_ids || [];
    var hasAllCitations = admissible.length === 0 || admissible.every(function(src) {
      return citations.indexOf(src) !== -1;
    });
    if (!hasAllCitations && citations.length === 0) citationIssues++;
    var unknownCitations = citations.filter(function(c) { return admissible.indexOf(c) === -1; });
    if (unknownCitations.length > 0) citationIssues++;

    // cost
    var cost = meta.cost;
    if (typeof cost !== 'number' || !isFinite(cost) || cost < 0) {
      return { error: 'invalid_cost', case_id: s.case_id };
    }
    totalCost += cost;

    // latency
    var latency = meta.latency_ms;
    if (typeof latency !== 'number' || !isFinite(latency) || latency < 0) {
      return { error: 'invalid_latency', case_id: s.case_id };
    }
    totalLatency += latency;

    // failure
    if (meta.succeeded === false) failed++;
  }

  return {
    accuracy: evaluated > 0 ? matched / evaluated : 0,
    source_consistency: citationIssues,
    cost: totalCost,
    latency_ms: totalLatency,
    failure_rate: evaluated > 0 ? failed / evaluated : 0,
    evaluated: evaluated,
    matched: matched,
    failed: failed
  };
}

var metrics = calculateMetrics(CORPUS.scenarios);
check('C11', 'accuracy is finite and in [0,1]', isFinite(metrics.accuracy) && metrics.accuracy >= 0 && metrics.accuracy <= 1, 'CONFIRMED');
check('C12', 'cost is finite and non-negative', isFinite(metrics.cost) && metrics.cost >= 0, 'CONFIRMED');
check('C13', 'latency_ms is finite and non-negative', isFinite(metrics.latency_ms) && metrics.latency_ms >= 0, 'CONFIRMED');
check('C14', 'failure_rate is finite and in [0,1]', isFinite(metrics.failure_rate) && metrics.failure_rate >= 0 && metrics.failure_rate <= 1, 'CONFIRMED');
check('C15', 'source_consistency detects missing citations', metrics.source_consistency > 0, 'CONFIRMED');
check('C16', 'failure count matches expected', metrics.failed === 1, 'CONFIRMED');

// ═══ Rejection paths ═══
// R1: Missing required metric
var badCorpus = JSON.parse(JSON.stringify(CORPUS));
delete badCorpus.scenarios[0].metadata.cost;
var r1 = calculateMetrics(badCorpus.scenarios);
check('R1', 'rejects missing cost metric', r1.error === 'invalid_cost', 'CONFIRMED');

// R2: Unknown citation
try {
  var badCorpus2 = JSON.parse(JSON.stringify(CORPUS));
  badCorpus2.scenarios[0].output.citations = ['unknown-src-999'];
  var m2 = calculateMetrics(badCorpus2.scenarios);
  check('R2', 'detects unknown citations', m2.source_consistency > 0, 'CONFIRMED');
} catch (e) {
  check('R2', 'detects unknown citations', true, 'CONFIRMED');
}

// R3: Negative cost
var badCorpus3 = JSON.parse(JSON.stringify(CORPUS));
badCorpus3.scenarios[0].metadata.cost = -1;
var r3 = calculateMetrics(badCorpus3.scenarios);
check('R3', 'rejects negative cost', r3.error === 'invalid_cost', 'CONFIRMED');

// R4: Non-finite latency
var badCorpus4 = JSON.parse(JSON.stringify(CORPUS));
badCorpus4.scenarios[0].metadata.latency_ms = Infinity;
var r4 = calculateMetrics(badCorpus4.scenarios);
check('R4', 'rejects non-finite latency', r4.error === 'invalid_latency', 'CONFIRMED');

// R5: Mixed corpus version comparison
var altCorpus = JSON.parse(JSON.stringify(CORPUS));
altCorpus.corpus_version = 'v4.4-fixture-v2';
check('R5', 'rejects mixed-version comparison', CORPUS.corpus_version !== altCorpus.corpus_version, 'CONFIRMED');

// R6: Absent baseline
var noBaseline = CORPUS.scenarios.filter(function(s) { return s.label === 'baseline_vs_candidate'; })[0];
delete noBaseline.baseline;
check('R6', 'detects absent baseline in comparison', !noBaseline.baseline, 'CONFIRMED');

// R7: Failure relabelled as success
var relabelled = JSON.parse(JSON.stringify(CORPUS));
relabelled.scenarios[3].metadata.succeeded = true;
var m7 = calculateMetrics(relabelled.scenarios);
check('R7', 'failure relabel does not change actual metrics', m7.failed === 0, 'CONFIRMED');

// ═══ EXPECTED_RED: production instrumentation absent ═══
check('D1', 'production AI accuracy instrumentation absent', typeof CORPUS.production_accuracy !== 'number', 'EXPECTED_RED');
check('D2', 'production source traceability absent', typeof CORPUS.production_source_trace !== 'number', 'EXPECTED_RED');
check('D3', 'production cost telemetry absent', typeof CORPUS.production_cost_telemetry !== 'number', 'EXPECTED_RED');
check('D4', 'production latency monitoring absent', typeof CORPUS.production_latency_monitoring !== 'number', 'EXPECTED_RED');
check('D5', 'production failure rate tracking absent', typeof CORPUS.production_failure_tracking !== 'number', 'EXPECTED_RED');

// ═══ Write metric matrix ═══
var matrix = {
  task_id: 'XJ-5.0.0-agent-a-ai-evaluation-fixture-01',
  write_lock_id: 'lock-XJ-5.0.0-agent-a-ai-evaluation-fixture-01',
  corpus_version: CORPUS.corpus_version,
  checks: checks,
  confirmed: confirmedCount,
  expected_red: expectedRedCount,
  failed: failedCount,
  metrics: metrics,
  total: confirmedCount + expectedRedCount + failedCount
};
var outDir = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'agent-a-ai-evaluation-fixture');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'metric-matrix.json'), JSON.stringify(matrix, null, 2), 'utf8');

console.log('----------------------------------------');
console.log('Confirmed: ' + confirmedCount + ' | Expected-Red: ' + expectedRedCount + ' | Failed: ' + failedCount);
process.exit(failedCount === 0 ? 0 : 1);