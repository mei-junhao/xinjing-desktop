'use strict';
/* XJ-5.0.2-023 配额/管理员充值 反向验证：至少 10 项 expected-red 全部 fail-closed */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { AccountAuth } = require('../server/account-auth');

function tmp(name) { return path.join(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj-023-adv-' + name + '-')), 'a.sqlite'); }
function regLogin(a, email) {
  const reg = a.register({ email, password: 'Password123' });
  a.verify(reg.verificationToken);
  return a.login({ email, password: 'Password123' }).then((l) => ({ reg, l }));
}

test('X-1 匿名 credit：无 admin token 的 CLI 必须 admin-forbidden', () => {
  const a = new AccountAuth({ dataFile: tmp('x1') });
  const reg = a.register({ email: 'x1@example.com', password: 'Password123' }); a.verify(reg.verificationToken);
  const r = cp.spawnSync(process.execPath, ['server/account-auth.js', 'admin-credit', reg.accountId, '100'], { encoding: 'utf8', env: Object.assign({}, process.env, { ACCOUNT_ADMIN_TOKEN: 'secret-admin' }), cwd: path.resolve(__dirname, '..'), timeout: 30000 });
  assert.ok(/admin-forbidden/.test(r.stderr || r.stdout), '无 token 必须 admin-forbidden');
  a.close();
});

test('X-2 伪造 accountId：未知账号 admin credit 必须 account-missing', () => {
  const a = new AccountAuth({ dataFile: tmp('x2') });
  const r = a.adminCredit('acct_does_not_exist', 100, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'account-missing');
  a.close();
});

test('X-3 负数/零/超大金额/非整数 全部拒绝', () => {
  const a = new AccountAuth({ dataFile: tmp('x3') });
  const reg = a.register({ email: 'x3@example.com', password: 'Password123' }); a.verify(reg.verificationToken);
  assert.strictEqual(a.adminCredit(reg.accountId, -1, {}).error.code, 'bad-amount');
  assert.strictEqual(a.adminCredit(reg.accountId, 0, {}).error.code, 'bad-amount');
  assert.strictEqual(a.adminCredit(reg.accountId, 1.5, {}).error.code, 'bad-amount');
  assert.strictEqual(a.adminCredit(reg.accountId, 1_000_000_000_01, {}).error.code, 'amount-overflow');
  a.close();
});

test('X-4 重复幂等键：不重复入账，只记一笔 ledger', () => {
  const a = new AccountAuth({ dataFile: tmp('x4') });
  const reg = a.register({ email: 'x4@example.com', password: 'Password123' }); a.verify(reg.verificationToken);
  const r1 = a.adminCredit(reg.accountId, 500, { idempotencyKey: 'dup-key' });
  const r2 = a.adminCredit(reg.accountId, 500, { idempotencyKey: 'dup-key' });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.idempotent, true);
  assert.strictEqual(r2.balanceCents, 500);
  assert.strictEqual(a.store.walletLedger(reg.accountId).filter((x) => x.kind === 'credit').length, 1);
  a.close();
});

test('X-5 并发 revision 冲突：revision 单调递增，余额 = credit - debit', () => {
  const a = new AccountAuth({ dataFile: tmp('x5') });
  const reg = a.register({ email: 'x5@example.com', password: 'Password123' }); a.verify(reg.verificationToken);
  a.adminCredit(reg.accountId, 1000, {});
  a.debitAccount(reg.accountId, 300, {});
  const w = a.store.walletGet(reg.accountId);
  assert.strictEqual(w.balanceCents, 700);
  assert.strictEqual(w.revision, 2);
  a.close();
});

test('X-6 余额不足仍放行：必须 insufficient-balance 且无半状态', () => {
  const a = new AccountAuth({ dataFile: tmp('x6') });
  const reg = a.register({ email: 'x6@example.com', password: 'Password123' }); a.verify(reg.verificationToken);
  a.adminCredit(reg.accountId, 100, {});
  const d = a.debitAccount(reg.accountId, 999, {});
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.error.code, 'insufficient-balance');
  assert.strictEqual(a.store.walletGet(reg.accountId).balanceCents, 100);
  a.close();
});

test('X-7 无会话/伪造会话查余额：no-session 或 session-not-found', () => {
  const a = new AccountAuth({ dataFile: tmp('x7') });
  assert.strictEqual(a.balanceProjection('').error.code, 'no-session');
  assert.strictEqual(a.balanceProjection('forged-token-1234567890').error.code, 'session-not-found');
  a.close();
});

test('X-8 摘要形态 token 重放查余额：session-not-found', () => {
  const a = new AccountAuth({ dataFile: tmp('x8') });
  const reg = a.register({ email: 'x8@example.com', password: 'Password123' }); a.verify(reg.verificationToken);
  a.login({ email: 'x8@example.com', password: 'Password123' }).then((l) => {
    const digest = require('../server/auth-sqlite').sessionTokenDigest(l.sessionToken);
    assert.strictEqual(a.balanceProjection(digest).error.code, 'session-not-found');
    a.close();
  });
});

test('X-9 余额投影不泄漏 ledger/meta', () => {
  const a = new AccountAuth({ dataFile: tmp('x9') });
  const reg = a.register({ email: 'x9@example.com', password: 'Password123' }); a.verify(reg.verificationToken);
  a.login({ email: 'x9@example.com', password: 'Password123' }).then((l) => {
    a.adminCredit(reg.accountId, 500, { idempotencyKey: 'x9', meta: { note: 'secret-meta' } });
    const p = a.balanceProjection(l.sessionToken);
    assert.ok(!('ledger' in p) && !('meta' in p) && !('idempotencyKey' in p));
    a.close();
  });
});

test('X-10 默认模型不可由客户端提升：defaultModelConfig serverAuthoritative=true', () => {
  const a = new AccountAuth({ dataFile: tmp('x10') });
  const c = a.defaultModelConfig();
  assert.strictEqual(c.serverAuthoritative, true);
  assert.ok(c.defaultModel && c.budgetModel);
  a.close();
});

test('X-11 跳过 SQLite 事务/持久化失败：setSaveFail 后 credit/debit 必须抛错不落盘', () => {
  const a = new AccountAuth({ dataFile: tmp('x11') });
  const reg = a.register({ email: 'x11@example.com', password: 'Password123' }); a.verify(reg.verificationToken);
  a.setSaveFail(true);
  assert.throws(() => a.adminCredit(reg.accountId, 100, {}));
  assert.strictEqual(a.store.walletGet(reg.accountId), null);
  a.close();
});
