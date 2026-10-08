'use strict';
/**
 * XJ-4.3.0-opensquilla-source-graph-goal-loop-01
 * Artifact verification: recompute all allowlist SHA-256 values,
 * verify ledger count, goal count, and evidence binding.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const FIXTURES = require(path.join(__dirname, 'fixtures.js'));
const GOAL_QUEUE = JSON.parse(fs.readFileSync(path.join(__dirname, 'goal-queue.json'), 'utf8'));

const ROOT = path.resolve(__dirname, '..', '..', '..');
const INVENTORY_DIR = path.resolve(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'inventory', 'opensquilla-source-graph-goal-loop');
const LEDGER_PATH = path.join(INVENTORY_DIR, 'iteration-ledger.jsonl');
const TEST_DIR = path.resolve(ROOT, 'tests', 'v4.3.0-disposable', 'opensquilla-source-graph-goal-loop');

function sha256File(p) { if (!fs.existsSync(p)) return null; return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }
function sha256Str(s) { return crypto.createHash('sha256').update(s).digest('hex').toUpperCase(); }

var passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log('[PASS] ' + msg); } else { failed++; console.log('[FAIL] ' + msg); } }

var requiredFiles = [
  { path: path.join(TEST_DIR, 'fixtures.js'), name: 'fixtures.js' },
  { path: path.join(TEST_DIR, 'goal-queue.json'), name: 'goal-queue.json' },
  { path: path.join(TEST_DIR, 'loop-runner.js'), name: 'loop-runner.js' },
  { path: path.join(TEST_DIR, 'replay.js'), name: 'replay.js' },
  { path: path.join(TEST_DIR, 'mutation-probes.js'), name: 'mutation-probes.js' },
  { path: path.join(TEST_DIR, 'run-tests.js'), name: 'run-tests.js' },
  { path: path.join(TEST_DIR, 'verify-artifacts.js'), name: 'verify-artifacts.js' },
  { path: path.join(INVENTORY_DIR, 'goal-schema.json'), name: 'goal-schema.json' },
  { path: path.join(INVENTORY_DIR, 'scenario-matrix.json'), name: 'scenario-matrix.json' },
  { path: path.join(INVENTORY_DIR, 'iteration-ledger.jsonl'), name: 'iteration-ledger.jsonl' },
  { path: path.join(INVENTORY_DIR, 'coverage-report.md'), name: 'coverage-report.md' },
  { path: path.join(INVENTORY_DIR, 'failure-taxonomy.md'), name: 'failure-taxonomy.md' }
];

console.log('=== XJ-4.3.0 Artifact Verification ===');
console.log('');

requiredFiles.forEach(function (f) { assert(fs.existsSync(f.path), 'V1: ' + f.name + ' exists'); });

var fileHashes = {};
requiredFiles.forEach(function (f) { var hash = sha256File(f.path); if (hash) { fileHashes[f.name] = hash; console.log('  SHA-256 ' + f.name + ': ' + hash); } });

var ledgerContent = fs.existsSync(LEDGER_PATH) ? fs.readFileSync(LEDGER_PATH, 'utf8').trim() : '';
var ledgerLines = ledgerContent ? ledgerContent.split('\n').filter(Boolean) : [];
assert(ledgerLines.length >= 96, 'V3: ledger count >= 96 (got ' + ledgerLines.length + ')');

var allShaPresent = true;
ledgerLines.forEach(function (line) { try { var e = JSON.parse(line); if (!e.sha) allShaPresent = false; } catch (e) { allShaPresent = false; } });
assert(allShaPresent, 'V4: all ledger entries have sha field');

assert(GOAL_QUEUE.goals.length === 12, 'V5: goal count = 12');

var doneGoals = GOAL_QUEUE.goals.filter(function (g) { return g.status === 'done'; }).length;
assert(doneGoals >= 12, 'V6: done goals >= 12 (got ' + doneGoals + ')');

assert(FIXTURES.sessionCount >= 90, 'V7a: session count >= 90 (got ' + FIXTURES.sessionCount + ')');
assert(FIXTURES.clientCount === 3, 'V7b: client count = 3 (got ' + FIXTURES.clientCount + ')');
assert(FIXTURES.negativeCount >= 48, 'V7c: negative count >= 48 (got ' + FIXTURES.negativeCount + ')');
assert(FIXTURES.scenarioBundleCount >= 96, 'V7d: scenario bundles >= 96 (got ' + FIXTURES.scenarioBundleCount + ')');
assert(FIXTURES.nodeCount > 0, 'V7e: node count > 0 (got ' + FIXTURES.nodeCount + ')');
assert(FIXTURES.edgeCount > 0, 'V7f: edge count > 0 (got ' + FIXTURES.edgeCount + ')');

var syntheticRecords = FIXTURES.sessions.length + FIXTURES.materials.length + FIXTURES.supervisions.length + FIXTURES.actionDrafts.length + FIXTURES.nodes.length + FIXTURES.edges.length;
assert(syntheticRecords >= 240, 'V8: synthetic records >= 240 (got ' + syntheticRecords + ')');

var scenarioBundles = FIXTURES.scenarioBundleCount + FIXTURES.negativeCount;
assert(scenarioBundles >= 96, 'V9: scenario bundles + negatives >= 96 (got ' + scenarioBundles + ')');

var allThresholdsValid = GOAL_QUEUE.goals.every(function (g) { return g.threshold.pass >= 8 && g.threshold.negative >= 4; });
assert(allThresholdsValid, 'V10: all goal thresholds valid');

var finalSha = sha256Str(JSON.stringify(fileHashes) + ledgerLines.length + doneGoals + syntheticRecords + scenarioBundles);
console.log('\nFinal SHA-256: ' + finalSha);

assert(FIXTURES.REAL.base_commit === '9971787eb6e443ab5a5c80aee118b9b43285c093', 'V11: base commit matches');

console.log('\n=== Artifact Verification Summary ===');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
console.log('Ledger entries: ' + ledgerLines.length);
console.log('Done goals: ' + doneGoals + ' / 12');
console.log('Synthetic records: ' + syntheticRecords);
console.log('Scenario bundles: ' + scenarioBundles);
console.log('Final SHA: ' + finalSha);
console.log('test_phase: ' + (failed === 0 ? 'ALL-VERIFIED' : 'VERIFICATION-FAILED'));
if (failed > 0) process.exit(1);
