'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '../../../../../');
const TASK_ID = 'XJ-5.0.0-full-ui-ux-review-successor-391';
const RUN_ROOT = path.join(PROJECT_ROOT, 'docs/agent-coordination/v5.0.0/cli-coordination/runs', TASK_ID, 'workspace');
const EVIDENCE_ROOT = path.join(RUN_ROOT, 'evidence');
const REPORT = path.join(RUN_ROOT, 'delivery/DELIVERY_REPORT.md');
const MANIFEST = path.join(RUN_ROOT, 'input/INPUT_MANIFEST.json');
const PROTOTYPE_ROOT = path.join(PROJECT_ROOT, 'design-previews/5.0.0-rerun-ui-ux');
const TEST_ROOT = path.join(PROJECT_ROOT, 'tests/v5.0.0-disposable/rerun-ui-ux');

function hash(filePath) { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase(); }
function rel(filePath) { return path.relative(PROJECT_ROOT, filePath).replaceAll(path.sep, '/'); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function listFiles(root) { return fs.existsSync(root) ? fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath || root, entry.name)) : []; }

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const reportLastLine = fs.readFileSync(REPORT, 'utf8').trimEnd().split(/\r?\n/).at(-1);
  assert(reportLastLine === 'DELIVERY_REPORT: D:/xinjing-electron/docs/agent-coordination/v5.0.0/cli-coordination/runs/XJ-5.0.0-full-ui-ux-review-successor-391/workspace/delivery/DELIVERY_REPORT.md', 'REPORT_LAST_LINE_INVALID');
  assert(manifest.task_id === TASK_ID && manifest.checkpoint === 'A', 'MANIFEST_ID_OR_CHECKPOINT_INVALID');
  const allowlisted = [...listFiles(PROTOTYPE_ROOT), ...listFiles(TEST_ROOT), REPORT, MANIFEST, ...listFiles(EVIDENCE_ROOT)];
  const normalized = allowlisted.map(rel);
  const forbidden = normalized.filter((file) => !(
    file.startsWith('design-previews/5.0.0-rerun-ui-ux/') ||
    file.startsWith('tests/v5.0.0-disposable/rerun-ui-ux/') ||
    file.startsWith(`docs/agent-coordination/v5.0.0/cli-coordination/runs/${TASK_ID}/workspace/evidence/`) ||
    file === `docs/agent-coordination/v5.0.0/cli-coordination/runs/${TASK_ID}/workspace/input/INPUT_MANIFEST.json` ||
    file === `docs/agent-coordination/v5.0.0/cli-coordination/runs/${TASK_ID}/workspace/delivery/DELIVERY_REPORT.md`
  ));
  assert(forbidden.length === 0, `ALLOWLIST_VIOLATION ${forbidden.join(',')}`);
  const commandResultsPath = path.join(EVIDENCE_ROOT, 'acceptance-command-results.json');
  const evidenceFiles = listFiles(EVIDENCE_ROOT).filter((filePath) => path.basename(filePath) !== 'artifact-hashes.json' && path.basename(filePath) !== 'acceptance-command-results.json' && !rel(filePath).includes('/evidence/commands/'));
  const requiredEvidence = ['contract-results.json', 'browser-matrix-results.json', 'interaction-results.json', 'mutation-results.json'];
  for (const name of requiredEvidence) assert(fs.existsSync(path.join(EVIDENCE_ROOT, name)), `EVIDENCE_MISSING ${name}`);
  const screenshots = listFiles(path.join(EVIDENCE_ROOT, 'visual-matrix')).filter((filePath) => filePath.endsWith('.png'));
  const inventory = {
    task_id: TASK_ID,
    generated_at: new Date().toISOString(),
    manifest_sha256: hash(MANIFEST),
    delivery_report_sha256: hash(REPORT),
    prototype: listFiles(PROTOTYPE_ROOT).map((filePath) => ({ path: rel(filePath), sha256: hash(filePath), bytes: fs.statSync(filePath).size })),
    tests: listFiles(TEST_ROOT).map((filePath) => ({ path: rel(filePath), sha256: hash(filePath), bytes: fs.statSync(filePath).size })),
    evidence: evidenceFiles.map((filePath) => ({ path: rel(filePath), sha256: hash(filePath), bytes: fs.statSync(filePath).size })),
    screenshots: screenshots.map((filePath) => ({ path: rel(filePath), sha256: hash(filePath), bytes: fs.statSync(filePath).size })),
    acceptance_command_results: fs.existsSync(commandResultsPath) ? { path: rel(commandResultsPath), sha256: hash(commandResultsPath), bytes: fs.statSync(commandResultsPath).size } : null,
    counts: { screenshots: screenshots.length, evidence_files: evidenceFiles.length, prototype_files: listFiles(PROTOTYPE_ROOT).length, test_files: listFiles(TEST_ROOT).length },
    browser_result: JSON.parse(fs.readFileSync(path.join(EVIDENCE_ROOT, 'browser-matrix-results.json'), 'utf8')).status,
    interaction_result: JSON.parse(fs.readFileSync(path.join(EVIDENCE_ROOT, 'interaction-results.json'), 'utf8')).status,
    mutation_result: JSON.parse(fs.readFileSync(path.join(EVIDENCE_ROOT, 'mutation-results.json'), 'utf8')).status
  };
  fs.writeFileSync(path.join(EVIDENCE_ROOT, 'artifact-hashes.json'), `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  console.log(`ARTIFACT VERIFY PASS prototype=${inventory.counts.prototype_files} tests=${inventory.counts.test_files} evidence=${inventory.counts.evidence_files} screenshots=${inventory.counts.screenshots} browser=${inventory.browser_result}`);
}

try { main(); } catch (error) { console.error(`ARTIFACT VERIFY FAIL: ${error.message}`); process.exitCode = 1; }
