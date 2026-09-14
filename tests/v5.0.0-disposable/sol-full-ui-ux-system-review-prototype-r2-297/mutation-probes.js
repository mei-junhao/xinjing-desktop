'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const TASK_ID = 'XJ-5.0.0-sol-v5-full-ui-ux-system-review-prototype-r2-297';
const ROOT = 'D:/xinjing-electron';
const CANDIDATE = path.join(ROOT, 'design-previews/5.0.0-sol-full-ui-ux-system-review-prototype-r2-297');
const TEST_ROOT = path.join(ROOT, 'tests/v5.0.0-disposable/sol-full-ui-ux-system-review-prototype-r2-297');
const WORKSPACE = path.join(ROOT, 'docs/agent-coordination/v5.0.0/cli-coordination/runs', TASK_ID, 'workspace');
const OUT = path.join(WORKSPACE, 'evidence/mutation');
const sha = (body) => crypto.createHash('sha256').update(body).digest('hex');
const copyTree = (source, target) => {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
};
const candidateFiles = ['index.html', 'styles.css', 'app.js', 'fixtures.js', 'route-manifest.json', 'state-manifest.json', 'design-system.md', 'route-review.md', 'decision-matrix.md', 'README.md'];
const mutations = [
  { id: 'M01-delete-route', file: 'route-manifest.json', mutate(body) { const json = JSON.parse(body); json.routes.pop(); json.route_count -= 1; return JSON.stringify(json); }, mustFail: true },
  { id: 'M02-change-primary-action', file: 'route-manifest.json', mutate(body) { const json = JSON.parse(body); json.routes[0].primaryAction = ''; return JSON.stringify(json); }, mustFail: true },
  { id: 'M03-point-old-candidate', file: 'run-contract.js', mutate(body) { return body.replace(/design-previews\/5\.0\.0-sol-full-ui-ux-system-review-prototype-r2-297/g, 'design-previews/5.0.0-trae-full-ui-system-prototype'); }, mustFail: true },
  { id: 'M04-change-default-skin', file: 'route-manifest.json', mutate(body) { const json = JSON.parse(body); json.skins = ['theatre']; return JSON.stringify(json); }, mustFail: true },
  { id: 'M05-share-token-map', file: 'styles.css', mutate(body) { return body.replace(/body\[data-skin="theatre"\][^{]*\{[^}]*\}/, ''); }, mustFail: true },
  { id: 'M06-remove-await-result', file: 'app.js', mutate(body) { return body.replace("setTimeout(() => { state.aiStatus = 'draft';", "state.aiStatus = 'draft'; setTimeout(() => { state.aiStatus = 'draft';"); }, mustFail: true },
  { id: 'M07-success-before-failure', file: 'app.js', mutate(body) { return body.replace("toast('保存失败：输入已保留，请重试', 'error')", "toast('记录已在本地保存')"); }, mustFail: true },
  { id: 'M08-remove-failure-retention', file: 'app.js', mutate(body) { return body.replace("state.noteDraft = document.getElementById('note-draft')?.value || state.noteDraft; render(); toast('保存失败", "render(); toast('保存失败"); }, mustFail: true },
  { id: 'M09-bypass-membership', file: 'app.js', mutate(body) { return body.replace("未知功能键", "允许未知功能键"); }, mustFail: true },
  { id: 'M10-unknown-feature-open', file: 'state-manifest.json', mutate(body) { return body.replace('unknown-feature-fail-closed', 'unknown-feature-open'); }, mustFail: true },
  { id: 'M11-byok-upgrades-tier', file: 'app.js', mutate(body) { return body.replace('BYOK 不改变产品档位', 'BYOK 将升级产品档位'); }, mustFail: true },
  { id: 'M12-free-blocked', file: 'state-manifest.json', mutate(body) { return body.replace('Free manual clinical workflows remain available', 'Free manual clinical workflows blocked'); }, mustFail: true },
  { id: 'M13-client-balance-authority', file: 'app.js', mutate(body) { return body.replace('同步失败，不显示缓存值', '同步失败，继续显示缓存值'); }, mustFail: true },
  { id: 'M14-auto-save-draft', file: 'app.js', mutate(body) { return body.replace('AI 草稿已生成，尚未保存', 'AI 草稿已生成，已自动保存'); }, mustFail: true },
  { id: 'M15-admit-quarantined-source', file: 'app.js', mutate(body) { return body.replace("source.status === 'quarantined' ? ' disabled title=\"隔离来源不可打开\"' : ''", "''"); }, mustFail: true },
  { id: 'M16-no-passphrase-choice', file: 'app.js', mutate(body) { return body.replace('不会预设口令', '系统预设口令'); }, mustFail: true },
  { id: 'M17-skip-rollback', file: 'app.js', mutate(body) { return body.replace('确认回滚', '无需回滚'); }, mustFail: true },
  { id: 'M18-remove-keyboard-equivalence', file: 'styles.css', mutate(body) { return body.replace(':focus-visible', ':focus-visible-disabled'); }, mustFail: true },
  { id: 'M19-remove-reduced-motion', file: 'styles.css', mutate(body) { return body.replace('@media (prefers-reduced-motion:reduce)', '@media (motion-always)'); }, mustFail: true },
  { id: 'M20-remove-source-context', file: 'app.js', mutate(body) { return body.replace('data-testid="clinical-context"', 'data-testid="hidden-context"'); }, mustFail: true },
  { id: 'M21-replace-consult-notes', file: 'route-manifest.json', mutate(body) { const json = JSON.parse(body); json.representative_routes = json.representative_routes.map((route) => route === 'consult-notes' ? 'transcript' : route); return JSON.stringify(json); }, mustFail: true },
  { id: 'M22-allow-external-network', file: 'styles.css', mutate(body) { return body + '\n@import url(https://example.invalid/x.css);\n'; }, mustFail: true },
  { id: 'M23-delete-route-review', file: 'route-review.md', mutate(body) { return ''; }, mustFail: true },
  { id: 'M24-remove-server-balance-label', file: 'app.js', mutate(body) { return body.replace('服务端权威余额', '本地余额'); }, mustFail: true },
];
function runContract(candidateDir, testDir) {
  const source = fs.readFileSync(path.join(TEST_ROOT, 'run-contract.js'), 'utf8')
    .replace(/const CANDIDATE_ROOT = path\.join\([\s\S]*?\);/, `const CANDIDATE_ROOT = ${JSON.stringify(candidateDir)};`)
    .replace(/const TEST_ROOT = path\.join\([\s\S]*?\);/, `const TEST_ROOT = ${JSON.stringify(testDir)};`)
    .replace(/const WORKSPACE = path\.join\([\s\S]*?\);/, `const WORKSPACE = ${JSON.stringify(candidateDir)};`);
  const runner = path.join(candidateDir, 'mutated-run-contract.js');
  fs.writeFileSync(runner, source, 'utf8');
  const output = childProcess.spawnSync('"C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe"', [runner], { encoding: 'utf8', shell: true });
  return { code: output.status, stdout: output.stdout, stderr: output.stderr };
}

fs.mkdirSync(OUT, { recursive: true });
const results = [];
for (const mutation of mutations) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xj297-mut-'));
  const mutatedCandidate = path.join(temp, 'candidate');
  const mutatedTests = path.join(temp, 'tests');
  copyTree(CANDIDATE, mutatedCandidate);
  copyTree(TEST_ROOT, mutatedTests);
  const targetRoot = mutation.file === 'run-contract.js' ? mutatedTests : mutatedCandidate;
  const target = path.join(targetRoot, mutation.file);
  const before = fs.readFileSync(target, 'utf8');
  const after = mutation.mutate(before);
  fs.writeFileSync(target, after, 'utf8');
  const execution = runContract(mutatedCandidate, mutatedTests);
  const killed = execution.code !== 0;
  results.push({ id: mutation.id, file: mutation.file, before_sha256: sha(before), after_sha256: sha(after), byte_changed: before !== after, exit_code: execution.code, killed, expected_killed: mutation.mustFail, stderr_tail: (execution.stderr || '').slice(-500) });
}
const failed = results.filter((item) => !item.byte_changed || item.killed !== item.expected_killed);
const summary = { task_id: TASK_ID, suite: 'mutation-probes', total: results.length, killed: results.filter((item) => item.killed).length, survivors: results.filter((item) => !item.killed).length, failed: failed.length, results };
fs.writeFileSync(path.join(OUT, 'mutation-results.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ total: summary.total, killed: summary.killed, survivors: summary.survivors, failed: summary.failed }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
