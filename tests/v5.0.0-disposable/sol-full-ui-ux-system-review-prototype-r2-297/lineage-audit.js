'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TASK_ID = 'XJ-5.0.0-sol-v5-full-ui-ux-system-review-prototype-r2-297';
const ROOT = 'D:/xinjing-electron';
const TEST_ROOT = path.join(
  ROOT,
  'tests/v5.0.0-disposable/sol-full-ui-ux-system-review-prototype-r2-297'
);
const WORKSPACE = path.join(
  ROOT,
  'docs/agent-coordination/v5.0.0/cli-coordination/runs',
  TASK_ID,
  'workspace'
);
const LINEAGE_PATH = path.join(
  WORKSPACE,
  'evidence/lineage/lineage-audit.json'
);
const OUTPUT_PATH = path.join(
  WORKSPACE,
  'evidence/lineage/lineage-audit-result.json'
);

const checks = [];
function check(id, run) {
  try {
    run();
    checks.push({ id, status: 'PASS' });
  } catch (error) {
    checks.push({
      id,
      status: 'FAIL',
      message: error && error.message ? error.message : String(error),
    });
  }
}

check('lineage:file-exists', () => {
  assert.strictEqual(fs.existsSync(LINEAGE_PATH), true);
});

const lineage = JSON.parse(fs.readFileSync(LINEAGE_PATH, 'utf8'));

check('lineage:task-local-identity', () => {
  assert.strictEqual(lineage.task_id, TASK_ID);
});

check('lineage:predecessor-rejected-blocked', () => {
  assert.strictEqual(lineage.predecessor.status, 'rejected-blocked');
});

check('lineage:no-pass-inheritance', () => {
  assert.strictEqual(lineage.predecessor.inherit_pass, false);
});

check('lineage:no-predecessor-artifact-reuse', () => {
  for (
    const key of [
      'reuse_candidate',
      'reuse_tests',
      'reuse_report',
      'reuse_screenshots',
      'reuse_dom_snapshots',
      'reuse_artifact_manifest',
    ]
  ) {
    assert.strictEqual(lineage.predecessor[key], false, key);
  }
});

check('lineage:four-root-causes', () => {
  assert.strictEqual(lineage.confirmed_failure_roots.length, 4);
  assert.deepStrictEqual(
    lineage.confirmed_failure_roots.map((item) => item.id),
    ['L01', 'L02', 'L03', 'L04']
  );
});

check('lineage:successor-roots-are-r2-297', () => {
  assert.ok(lineage.successor_candidate_root.endsWith('prototype-r2-297'));
  assert.ok(lineage.successor_test_root.endsWith('prototype-r2-297'));
  assert.ok(lineage.successor_evidence_root.includes(TASK_ID));
});

check('lineage:production-not-authorized', () => {
  assert.strictEqual(lineage.production_implementation_authorized, false);
  assert.strictEqual(lineage.user_review_required, true);
});

const failed = checks.filter((item) => item.status === 'FAIL');
const result = {
  task_id: TASK_ID,
  suite: 'lineage-audit',
  test_root: TEST_ROOT.replace(/\\/g, '/'),
  total: checks.length,
  passed: checks.length - failed.length,
  failed: failed.length,
  checks,
};
fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
