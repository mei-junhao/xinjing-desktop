'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TASK_ID = 'XJ-5.0.0-sol-v5-full-ui-ux-system-review-prototype-r2-297';
const ROOT = 'D:/xinjing-electron';
const CANDIDATE_ROOT = path.join(ROOT, 'design-previews/5.0.0-sol-full-ui-ux-system-review-prototype-r2-297');
const TEST_ROOT = path.join(ROOT, 'tests/v5.0.0-disposable/sol-full-ui-ux-system-review-prototype-r2-297');
const WORKSPACE = path.join(ROOT, 'docs/agent-coordination/v5.0.0/cli-coordination/runs', TASK_ID, 'workspace');
const CONTRACT_DIR = path.join(WORKSPACE, 'evidence/contract');
const RESULT_PATH = path.join(CONTRACT_DIR, 'contract-result.json');
const EXPECTED_RED_PATH = path.join(WORKSPACE, 'evidence/expected-red-result.json');
const REQUIRED = ['index.html', 'styles.css', 'app.js', 'fixtures.js', 'route-manifest.json', 'state-manifest.json', 'design-system.md', 'route-review.md', 'decision-matrix.md', 'README.md'];
const ROUTES = ['index', 'chat-home', 'session-calendar', 'consult-notes', 'transcript', 'transcript-guide', 'report-writing', 'supervision', 'supervision-mindmap', 'real-supervision', 'real-supervision-ai', 'masters', 'doc-center', 'doc-growth', 'knowledge', 'billing-shell', 'billing-calendar', 'settings', 'feedback', 'activation', 'confirm-close', 'migrate-helper'];
const REPRESENTATIVES = ['index', 'doc-center', 'consult-notes', 'supervision', 'masters', 'activation', 'settings'];
const FORBIDDEN = [
  /5\.0\.0-trae-full-ui-system-prototype/i,
  new RegExp('full-ui-ux-system-review-prototype-' + '282', 'i'),
  /5\.0\.0-sol-full-ui-ux-system-review-prototype(?!-r2-297)/i,
  /trae-full-ui-system-prototype-spec\.md/i,
];
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const read = (name) => fs.readFileSync(path.join(CANDIDATE_ROOT, name), 'utf8');
const exists = (name) => fs.existsSync(path.join(CANDIDATE_ROOT, name));

function recordExpectedRed() {
  const checks = REQUIRED.map((relativePath) => ({
    id: `candidate:${relativePath}`,
    relative_path: relativePath,
    exists: exists(relativePath),
    status: exists(relativePath) ? 'UNEXPECTED_PRESENT' : 'EXPECTED_MISSING',
  }));
  const present = checks.filter((item) => item.exists);
  const result = {
    task_id: TASK_ID,
    suite: 'run-contract-expected-red',
    candidate_root: CANDIDATE_ROOT.replace(/\\\\/g, '/'),
    required: REQUIRED.length,
    expected_missing: checks.length - present.length,
    unexpectedly_present: present.length,
    expected_red_confirmed: present.length === 0,
    checks,
  };
  fs.mkdirSync(path.dirname(EXPECTED_RED_PATH), { recursive: true });
  fs.writeFileSync(EXPECTED_RED_PATH, JSON.stringify(result, null, 2) + '\\n');
  console.log(JSON.stringify(result, null, 2));
  process.exit(present.length === 0 ? 1 : 3);
}

if (process.argv.includes('--expected-red')) recordExpectedRed();

const checks = [];
function check(id, run) {
  try { run(); checks.push({ id, status: 'PASS' }); }
  catch (error) { checks.push({ id, status: 'FAIL', message: error && error.message ? error.message : String(error) }); }
}

check('contract:required-files', () => REQUIRED.forEach((name) => assert.strictEqual(exists(name), true, name)));
const manifest = JSON.parse(read('route-manifest.json'));
const states = JSON.parse(read('state-manifest.json'));
const app = read('app.js');
const css = read('styles.css');
const fixtures = read('fixtures.js');
const allCandidateText = REQUIRED.map((name) => read(name)).join('\\n');

check('contract:task-identity', () => {
  assert.strictEqual(manifest.task_id, TASK_ID);
  assert.strictEqual(states.task_id, TASK_ID);
  assert.ok(read('README.md').includes('R2-297'));
});
check('contract:route-count-and-order', () => {
  assert.strictEqual(manifest.route_count, 22);
  assert.deepStrictEqual(manifest.routes.map((route) => route.id), ROUTES);
});
check('contract:representative-matrix', () => {
  assert.deepStrictEqual(manifest.representative_routes, REPRESENTATIVES);
  assert.strictEqual(manifest.viewports.length, 3);
  assert.deepStrictEqual(manifest.skins, ['clinical', 'theatre', 'observatory']);
  assert.deepStrictEqual(manifest.modes, ['light', 'dark']);
});
check('contract:state-coverage', () => {
  const allStates = Object.values(states.fixture_groups).flat();
  for (const requiredState of ['loading', 'empty', 'error', 'offline', 'stale', 'expired', 'revoked', 'quarantined', 'context-mismatch', 'long-chinese', 'narrow', 'keyboard-only', 'focus-visible', 'manual-only', 'draft', 'running', 'cancelled', 'partial-stream', 'unknown-result', 'passphrase-choice', 'wrong-passphrase', 'verification-failure', 'rollback', 'balance-sync-failed', 'model-unavailable']) assert.ok(allStates.includes(requiredState), requiredState);
});
check('contract:clinical-fixtures', () => {
  assert.ok(fixtures.includes('client-a'));
  assert.ok(fixtures.includes('session-a1'));
  assert.ok(fixtures.includes('source-01'));
  assert.ok(fixtures.includes('quarantined'));
  assert.ok(fixtures.includes('longChinese'));
});
check('contract:context-visible', () => {
  assert.ok(app.includes('data-testid="clinical-context"'));
  assert.ok(app.includes('clientId'));
  assert.ok(app.includes('sessionId'));
  assert.ok(app.includes('sourceId'));
});
check('contract:source-and-draft-boundary', () => {
  assert.ok(app.includes('只读投影'));
  assert.ok(app.includes('未保存'));
  assert.ok(app.includes('source-expired') || states.fixture_groups.ai.includes('source-expired'));
  assert.ok(app.includes('quarantined'));
});
check('contract:entitlement-compute-separation', () => {
  assert.ok(app.includes('产品资格'));
  assert.ok(app.includes('计算状态'));
  assert.ok(app.includes('BYOK'));
  assert.ok(app.includes('未知功能键'));
});
check('contract:manual-free-path', () => {
  assert.ok(states.invariants.includes('Free manual clinical workflows remain available'));
  assert.ok(app.includes('手工临床工作仍可使用'));
});
check('contract:failure-retains-input', () => {
  assert.ok(app.includes('retained-input'));
  assert.ok(app.includes('state.noteDraft = document.getElementById'));
  assert.ok(app.includes('保存失败：输入已保留'));
});
check('contract:balance-server-authority', () => {
  assert.ok(app.includes('服务端权威余额'));
  assert.ok(app.includes('同步失败，不显示缓存值'));
  assert.ok(app.includes('余额同步失败：未展示缓存余额'));
});
check('contract:recovery-update-rollback', () => {
  assert.ok(app.includes('选择恢复口令'));
  assert.ok(app.includes('不会预设口令'));
  assert.ok(app.includes('更新验证失败'));
  assert.ok(app.includes('确认回滚'));
});
check('contract:accessibility-responsive', () => {
  assert.ok(read('index.html').includes('skip-link'));
  assert.ok(css.includes(':focus-visible'));
  assert.ok(css.includes('prefers-reduced-motion:reduce'));
  assert.ok(css.includes('@media (max-width:1100px)'));
  assert.ok(css.includes('@media (max-width:760px)'));
  assert.ok(!/https?:\/\//i.test(css.replace(/data:image\/svg\+xml[^;]*;/gi, '')));
});
check('contract:no-old-binding', () => {
  for (const pattern of FORBIDDEN) assert.strictEqual(pattern.test(allCandidateText), false, pattern.toString());
});
check('contract:no-remote-font-or-cdn', () => {
  assert.strictEqual(/@import|url\(\s*https?:/i.test(css), false);
  assert.strictEqual(/fonts\.googleapis|cdn\./i.test(allCandidateText), false);
});
check('contract:source-manifest-present', () => {
  assert.strictEqual(fs.existsSync(path.join(WORKSPACE, 'input/source-manifest.json')), true);
  assert.strictEqual(fs.existsSync(path.join(WORKSPACE, 'evidence/source-manifest.json')), true);
});
check('contract:test-root-independent', () => {
  const testFiles = fs.readdirSync(TEST_ROOT).filter((name) => name.endsWith('.js'));
  for (const name of testFiles) {
    const body = fs.readFileSync(path.join(TEST_ROOT, name), 'utf8');
    assert.strictEqual(new RegExp('5\\.0\\.0-trae-full-ui-system-prototype|' + 'full-ui-ux-system-review-prototype-' + '282', 'i').test(body), false, name);
  }
});

const failed = checks.filter((item) => item.status === 'FAIL');
const result = {
  task_id: TASK_ID,
  suite: 'run-contract',
  candidate_root: CANDIDATE_ROOT.replace(/\\\\/g, '/'),
  total: checks.length,
  passed: checks.length - failed.length,
  failed: failed.length,
  candidate_files: REQUIRED.map((name) => ({ path: name, bytes: fs.statSync(path.join(CANDIDATE_ROOT, name)).size, sha256: sha(fs.readFileSync(path.join(CANDIDATE_ROOT, name))) })),
  checks,
};
fs.mkdirSync(CONTRACT_DIR, { recursive: true });
fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2) + '\\n');
console.log(JSON.stringify(result, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
