'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TASK_ID = 'XJ-5.0.0-sol-v5-full-ui-ux-system-review-prototype-r2-297';
const ROOT = 'D:/xinjing-electron';
const CANDIDATE_ROOT = path.join(
  ROOT,
  'design-previews/5.0.0-sol-full-ui-ux-system-review-prototype-r2-297'
);
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
const OUTPUT_PATH = path.join(
  WORKSPACE,
  'evidence/scope-audit-result.json'
);

const FORBIDDEN_RUNTIME_PATTERNS = [
  /5\.0\.0-sol-full-ui-ux-system-review-prototype(?!-r2-297)/i,
  /5\.0\.0-trae-full-ui-system-prototype/i,
  new RegExp(
    'full-ui-ux-system-review-prototype-' +
      '282',
    'i'
  ),
  /trae-full-ui-system-prototype-spec\.md/i,
  /XJ-5\.0\.0-trae-full-ui-system-prototype-01\.md/i,
  /XJ-5\.0\.0-codex-takeover-trae-full-ui-system-prototype-14\.md/i,
];
const EXPECTED_REPRESENTATIVE_ROUTES = [
  'index',
  'doc-center',
  'consult-notes',
  'supervision',
  'masters',
  'activation',
  'settings',
];

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...listFiles(absolute));
    else output.push(absolute);
  }
  return output.sort();
}

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

check('scope:candidate-root-task-local', () => {
  assert.ok(CANDIDATE_ROOT.replace(/\\/g, '/').endsWith('prototype-r2-297'));
});

check('scope:test-root-task-local', () => {
  assert.ok(TEST_ROOT.replace(/\\/g, '/').endsWith('prototype-r2-297'));
});

const scanFiles = [...listFiles(CANDIDATE_ROOT), ...listFiles(TEST_ROOT)];
check('scope:no-old-runtime-binding', () => {
  const violations = [];
  for (const file of scanFiles) {
    const body = fs.readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN_RUNTIME_PATTERNS) {
      if (pattern.test(body)) violations.push({ file, pattern: String(pattern) });
    }
  }
  assert.deepStrictEqual(violations, []);
});

check('scope:representative-routes-exact', () => {
  const candidateManifest = path.join(CANDIDATE_ROOT, 'route-manifest.json');
  if (!fs.existsSync(candidateManifest)) return;
  const manifest = JSON.parse(fs.readFileSync(candidateManifest, 'utf8'));
  assert.deepStrictEqual(
    manifest.representative_routes,
    EXPECTED_REPRESENTATIVE_ROUTES
  );
  assert.strictEqual(
    manifest.representative_routes.includes('transcript'),
    false
  );
});

check('scope:no-production-write-targets', () => {
  const normalizedCandidate = CANDIDATE_ROOT.replace(/\\/g, '/');
  const normalizedTests = TEST_ROOT.replace(/\\/g, '/');
  assert.strictEqual(normalizedCandidate.includes('/app/'), false);
  assert.strictEqual(normalizedTests.includes('/app/'), false);
});

const failed = checks.filter((item) => item.status === 'FAIL');
const result = {
  task_id: TASK_ID,
  suite: 'scope-audit',
  candidate_root: CANDIDATE_ROOT.replace(/\\/g, '/'),
  test_root: TEST_ROOT.replace(/\\/g, '/'),
  scanned_files: scanFiles.length,
  expected_representative_routes: EXPECTED_REPRESENTATIVE_ROUTES,
  total: checks.length,
  passed: checks.length - failed.length,
  failed: failed.length,
  checks,
};
fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
