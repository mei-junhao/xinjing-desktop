/* ============================================================
 * 心镜 XinJing — 统一测试路由（scripts/run-tests.js）
 *
 * 供 `npm test` 调用：按显式清单依次运行已验证可从干净状态
 * 离线执行的自包含测试文件（node *.test.js，各自以退出码汇报）。
 *
 * 清单外的测试（如 ui-language 系列、self-test.js、依赖外部
 * 认证服务的 account-auth-production-contract 等）目前存在已知
 * 红项或环境依赖，暂不纳入默认路由，可单独 `node <文件>` 执行。
 *
 * 运行：`node scripts/run-tests.js`（可跟关键字过滤，如 `... auth`）
 * ============================================================ */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

// 显式绿灯清单：相对项目根目录的测试文件路径
const TEST_FILES = [
  'scripts/account-auth-contract.test.js',
  'scripts/account-auth-quota-sqlite.test.js',
  'scripts/account-auth-session-security.test.js',
  'scripts/account-auth-sqlite-migration.test.js',
  'scripts/pii-sanitizer.test.js',
  'scripts/redaction-engine.test.js',
  'scripts/multi-school-archive.test.cjs',
  'scripts/multi-school-core.test.cjs',
  'scripts/f4-durable-txn.test.cjs',
  'scripts/f4-degraded-contract.test.cjs',
  'scripts/clinical-action-run-contract.test.cjs',
  'scripts/f5-entry-budget.test.cjs',
  'scripts/f5-budget-consistency.test.cjs',
  // 5.1.19 对账轮收口（reports/governance-reconciliation.md §7）：下面 5 条先前只按
  // 「单独 node <文件> 执行」的约定跑，不在默认路由里 —— 这正是 f5 那 6 条红能在两次
  // 改动互相撞车后存活到最后的直接原因（主代理跑 run-tests 看到 13/13 就以为全绿）。
  // 现在全部纳入：任一条转红都会让 `npm test` / run-tests 直接失败。
  'scripts/f5-syndicate-governance.test.cjs',
  'scripts/f7-governance-semantics.test.cjs',
  'scripts/f3-alias-temperature.test.cjs',
  'scripts/f3-payload-hygiene.test.cjs',
  // F1 的 E1 页面自动化仍明确 SKIP；默认回归通过不等于真实 UI 验收通过。
  'scripts/f1-fallback-visibility.test.cjs',
  'tests/local-agent-bus/agent-queue.test.js',
  'tests/local-agent-bus/mutation-sensitivity.test.js',
  'tests/local-agent-bus/opencode-watcher-config.test.js',
];

const rootDir = path.resolve(__dirname, '..');
const filter = process.argv[2];
const selected = filter
  ? TEST_FILES.filter((f) => f.toLowerCase().includes(filter.toLowerCase()))
  : TEST_FILES;

if (selected.length === 0) {
  process.stderr.write('run-tests: 没有匹配 "' + filter + '" 的测试文件\n');
  process.exit(2);
}

const results = [];
for (const rel of selected) {
  const abs = path.join(rootDir, rel);
  process.stdout.write('--- RUN ' + rel + '\n');
  const r = spawnSync(process.execPath, [abs], { stdio: 'inherit', cwd: rootDir });
  const ok = r.status === 0;
  results.push({ file: rel, ok });
  process.stdout.write((ok ? '--- PASS ' : '--- FAIL ') + rel + ' (exit=' + r.status + ')\n\n');
}

const failed = results.filter((x) => !x.ok);
process.stdout.write('run-tests: total=' + results.length + ' passed=' + (results.length - failed.length) + ' failed=' + failed.length + '\n');
for (const f of failed) {
  process.stderr.write('FAILED: ' + f.file + '\n');
}
process.exit(failed.length === 0 ? 0 : 1);
