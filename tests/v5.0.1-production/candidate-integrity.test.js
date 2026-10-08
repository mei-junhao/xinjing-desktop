'use strict';
/**
 * candidate-integrity.test.js — XinJing 5.0.1 生产候选完整性契约测试
 *
 * 任务: XJ-5.0.1-production-candidate-integration-001
 * 契约: XJ-5.0.1-CANDIDATE-INTEGRATION-V1
 *
 * 运行: node --test tests/v5.0.1-production/candidate-integrity.test.js
 *
 * 覆盖：
 *  T1 校验器两次运行退出码 0 且输出逐字节一致（无时间戳/易变字段）；
 *  T2 候选聚合摘要真实重算并与冻结值一致（防止“读字符串即通过”的假绿）；
 *  T3 反向变异必须被真实字节比对捕获：篡改期望 SHA / 删除成员 / 注入禁止路径；
 *  T4 独立复断言版本链（不依赖校验器输出文本）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const VERIFIER = path.join(__dirname, 'candidate-integrity-verifier.js');
const { verifyCandidate } = require(VERIFIER);

function runVerifier() {
  return spawnSync(process.execPath, [VERIFIER], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
}

test('T1 校验器两次运行均 exit 0，且 stdout 逐字节一致（确定性输出）', () => {
  const r1 = runVerifier();
  const r2 = runVerifier();
  assert.strictEqual(r1.status, 0, '第一次运行必须 PASS；输出: ' + String(r1.stdout).slice(0, 3000));
  assert.strictEqual(r2.status, 0, '第二次运行必须 PASS；输出: ' + String(r2.stdout).slice(0, 3000));
  assert.strictEqual(r1.stdout, r2.stdout, '两次运行输出必须逐字节一致');
  const j = JSON.parse(r1.stdout);
  assert.strictEqual(j.result, 'PASS');
  assert.ok(j.total > 30, '检查项数量异常: ' + j.total);
});

test('T2 候选聚合摘要由真实工作树字节重算，且与三处指针一致', () => {
  const j = JSON.parse(runVerifier().stdout);
  const pass = j.failures.filter(f => /^candidate-sha:/.test(f.id));
  assert.strictEqual(pass.length, 0, 'candidate-sha 检查不得失败: ' + JSON.stringify(pass));
  const freeze = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/agent-coordination/v5.0.1/candidate-freeze/5.0.1-rt-5.0.1-0001-001-production-candidate-integration/freeze.json'), 'utf8'));
  assert.match(freeze.candidate_sha256, /^[0-9A-F]{64}$/, '候选摘要必须为 64 位大写十六进制');
  assert.strictEqual(freeze.entry_count, 193);
});

test('T3 反向变异必须 FAIL：篡改期望 SHA / 删除成员 / 注入禁止路径 / 未声明漂移', () => {
  const flip = verifyCandidate(ROOT, { tamper: { flipSha: 'main.js' } });
  assert.strictEqual(flip.result, 'FAIL', '篡改 main.js 期望 SHA 必须被捕获');
  assert.ok(flip.failures.some(f => f.id === 'live-bytes:all-193-match' || f.id === 'candidate-sha:recomputed==freeze.json'), '必须给出真实字节或摘要层失败');

  const drop = verifyCandidate(ROOT, { tamper: { dropMember: 'preload.js' } });
  assert.strictEqual(drop.result, 'FAIL', '删除 preload.js 成员必须被捕获');

  const inject = verifyCandidate(ROOT, { tamper: { addMember: 'qa/task-scratch/evil.js' } });
  assert.strictEqual(inject.result, 'FAIL', '注入 qa/task-scratch 路径必须被捕获');
  assert.ok(inject.failures.some(f => f.id === 'forbidden:zero-member-hits'), '必须命中禁止范围检查');

  const drift = verifyCandidate(ROOT, { tamper: { addMember: 'server/account-auth.js' } });
  assert.strictEqual(drift.result, 'FAIL', '注入未完成线上闭环的账号服务文件必须被捕获');
  assert.ok(drift.failures.some(f => f.id === 'freeze009:added-set-exact' || f.id === 'forbidden:zero-member-hits'));
});

test('T4 版本链独立复断言：5.0.1 在六处真实文件中一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const vg = fs.readFileSync(path.join(ROOT, 'version.generated.js'), 'utf8');
  const settingsHtml = fs.readFileSync(path.join(ROOT, 'app/settings.html'), 'utf8');
  const settingsJs = fs.readFileSync(path.join(ROOT, 'app/js/settings.js'), 'utf8');
  const policyJs = fs.readFileSync(path.join(ROOT, 'scripts/verify-build-files-policy.js'), 'utf8');
  const train = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/agent-coordination/v5.0.1/release-train.yaml'), 'utf8'));
  assert.strictEqual(pkg.version, '5.0.1');
  assert.strictEqual(lock.version, '5.0.1');
  assert.strictEqual(lock.packages[''].version, '5.0.1');
  assert.match(vg, /VERSION:\s*"5\.0\.1"/);
  assert.ok(settingsHtml.includes('id="ver-text">v5.0.1'));
  assert.ok(settingsHtml.includes('id="about-version">v5.0.1'));
  assert.ok(settingsJs.includes("var ver = '5.0.1'"));
  assert.ok(policyJs.includes("const EXPECTED_VERSION = '5.0.1';"));
  assert.strictEqual(train.active_version, '5.0.1');
  assert.strictEqual(train.transition_id, 'rt-5.0.1-0001');
});
