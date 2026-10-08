'use strict';
/* XJ-5.0.2-023 quota SQLite：钱包/流水/管理员充值/扣费/幂等/并发安全 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SqliteStore } = require('../server/auth-sqlite');

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj-quota-' + name + '-')), 'a.sqlite');
}

test('Q-1 钱包表/流水表/迁移标记存在', () => {
  const s = new SqliteStore({ dbFile: tmpFile('q1') });
  assert.strictEqual(s.migrationApplied('004-quota-wallet-ledger-v1'), true);
  const t = s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('quota_wallet','quota_ledger')").all();
  assert.strictEqual(t.length, 2);
  s.close();
});

test('Q-2 管理员充值：余额增加、写流水、写审计、revision 递增', () => {
  const s = new SqliteStore({ dbFile: tmpFile('q2') });
  const r = s.walletCredit('acct_test_0000000001', 500, { idempotencyKey: 'credit-1', operator: 'admin', via: 'admin-credit' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.balanceCents, 500);
  assert.strictEqual(r.revision, 1);
  assert.strictEqual(s.walletLedger('acct_test_0000000001').length, 1);
  const audits = s.auditAll();
  assert.ok(audits.some(a => a.action === 'admin-credit'));
  s.close();
});

test('Q-3 幂等充值：同 idempotencyKey 不重复入账', () => {
  const s = new SqliteStore({ dbFile: tmpFile('q3') });
  s.walletCredit('acct_test_0000000002', 500, { idempotencyKey: 'credit-x' });
  const r2 = s.walletCredit('acct_test_0000000002', 500, { idempotencyKey: 'credit-x' });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.idempotent, true);
  assert.strictEqual(r2.balanceCents, 500);
  assert.strictEqual(s.walletLedger('acct_test_0000000002').length, 1);
  s.close();
});

test('Q-4 扣费：余额减少，revision 递增；余额不足确定性拒绝', () => {
  const s = new SqliteStore({ dbFile: tmpFile('q4') });
  s.walletCredit('acct_test_0000000003', 100, {});
  const d = s.walletDebit('acct_test_0000000003', 40, {});
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.balanceCents, 60);
  assert.strictEqual(d.revision, 2);
  const ins = s.walletDebit('acct_test_0000000003', 999, {});
  assert.strictEqual(ins.ok, false);
  assert.strictEqual(ins.error.code, 'insufficient-balance');
  assert.strictEqual(s.walletGet('acct_test_0000000003').balanceCents, 60); // 无半状态
  s.close();
});

test('Q-5 负数/零/超大金额/空账号 全部拒绝', () => {
  const s = new SqliteStore({ dbFile: tmpFile('q5') });
  assert.strictEqual(s.walletCredit('acct_x', -1, {}).ok, false);
  assert.strictEqual(s.walletCredit('acct_x', 0, {}).ok, false);
  assert.strictEqual(s.walletCredit('acct_x', 1.5, {}).ok, false);
  assert.strictEqual(s.walletCredit('acct_x', 1_000_000_000_01, {}).ok, false);
  assert.strictEqual(s.walletCredit('', 100, {}).ok, false);
  assert.strictEqual(s.walletDebit('acct_x', -5, {}).ok, false);
  s.close();
});

test('Q-6 脱敏余额投影：只返回余额/revision，不泄漏流水/元数据', () => {
  const s = new SqliteStore({ dbFile: tmpFile('q6') });
  s.walletCredit('acct_test_0000000004', 12345, { meta: { secret: 'should-not-leak' } });
  const p = s.walletProjection('acct_test_0000000004');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.balanceCents, 12345);
  assert.strictEqual(p.balanceYuan, 123.45);
  assert.ok(!('ledger' in p) && !('meta' in p));
  s.close();
});
