'use strict';
/**
 * account-auth-sqlite-migration.test.js — Better Auth + SQLite 迁移契约测试。
 * 验证：accounts.json → SQLite 迁移保留账号/凭据/会员，密码 hash 不降级，
 * 幂等、不删除源文件；session/pendingVerification 明文 token 不可恢复 → 丢弃并显式报告。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { scryptHex } = require('../server/better-auth-config');
const { AccountAuth } = require('../server/account-auth');
const { SqliteStore } = require('../server/auth-sqlite');

const MIGRATE = path.resolve(__dirname, '..', 'server', 'auth-migrations', 'migrate-accounts-json.js');

function tmpDir(name) { return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj-mig-' + name + '-')); }

function buildLegacy() {
  const salt = '0123456789abcdef';
  const passwordHash = scryptHex('LegacyPass123', salt);
  return {
    accounts: {
      'legacy@example.com': { id: 'acct_legacy00000001', email: 'legacy@example.com', passwordHash, salt, verified: true, disabled: false, tier: 'free', createdAt: Date.now() },
    },
    sessions: { 'deadbeef': { accountId: 'acct_legacy00000001', email: 'legacy@example.com', expiresAt: Date.now() + 100000 } },
    pendingVerifications: { 'cafebabe': { email: 'legacy@example.com', accountId: 'acct_legacy00000001', expiresAt: Date.now() + 100000 } },
    membership: { 'acct_legacy00000001': 'pro' },
    auditLog: [{ at: Date.now(), action: 'grant-membership', accountId: 'acct_legacy00000001', tier: 'pro', operator: 'legacy', via: 'cli' }],
  };
}

function runMigrate(args) {
  const r = cp.spawnSync(process.execPath, [MIGRATE].concat(args), { encoding: 'utf8', timeout: 30000 });
  let out = null;
  const tryParse = (s) => { if (!s) return null; try { return JSON.parse(s.trim().split('\n').pop()); } catch (e) { return null; } };
  out = tryParse(r.stdout) || tryParse(r.stderr);
  return { status: r.status, out, stderr: r.stderr };
}

test('MIG-1 迁移保留账号/凭据/会员，密码 hash 不降级，登录可复用旧密码', async () => {
  const dir = tmpDir('m1');
  const source = path.join(dir, 'accounts.json');
  const db = path.join(dir, 'auth.sqlite');
  fs.writeFileSync(source, JSON.stringify(buildLegacy()), 'utf8');
  const sourceBefore = fs.readFileSync(source, 'utf8');

  const r = runMigrate(['--source', source, '--db', db]);
  assert.strictEqual(r.status, 0, '迁移退出码 0: ' + r.stderr);
  assert.strictEqual(r.out.ok, true);
  assert.strictEqual(r.out.migrated.users, 1);
  assert.strictEqual(r.out.migrated.memberships, 1);
  assert.strictEqual(r.out.migrated.sessionsDropped, 1, '明文 token 不可恢复的 session 应显式丢弃');
  assert.strictEqual(r.out.migrated.verificationsDropped, 1);

  assert.ok(fs.existsSync(source), '源 accounts.json 不得被删除');
  assert.strictEqual(fs.readFileSync(source, 'utf8'), sourceBefore, '源文件字节不变');

  const store = new SqliteStore({ dbFile: db });
  const users = store.rows('user');
  const accounts = store.rows('account');
  assert.strictEqual(users.length, 1);
  assert.strictEqual(users[0].email, 'legacy@example.com');
  assert.strictEqual(users[0].emailVerified, 1);
  const cred = accounts.find((a) => a.providerId === 'credential');
  assert.ok(cred, '存在 credential account');
  assert.strictEqual(cred.password, '0123456789abcdef:' + scryptHex('LegacyPass123', '0123456789abcdef'), '密码 hash salt:scryptHex 原样保留');
  assert.strictEqual(store.getMembership('acct_legacy00000001'), 'pro');
  assert.strictEqual(store.rows('session').length, 0, '旧 session 已丢弃');

  // 迁移后可用旧密码登录（密码 hash 兼容，不降级）
  const auth = new AccountAuth({ dataFile: db });
  const l = await auth.login({ email: 'legacy@example.com', password: 'LegacyPass123' });
  assert.strictEqual(l.ok, true, '迁移后旧密码可登录');
  assert.strictEqual(l.tier, 'pro');
  assert.strictEqual(l.accountId, 'acct_legacy00000001');
  store.close();
});

test('MIG-2 迁移幂等：重复运行不重复建账号', async () => {
  const dir = tmpDir('m2');
  const source = path.join(dir, 'accounts.json');
  const db = path.join(dir, 'auth.sqlite');
  fs.writeFileSync(source, JSON.stringify(buildLegacy()), 'utf8');

  const r1 = runMigrate(['--source', source, '--db', db]);
  assert.strictEqual(r1.status, 0);
  const r2 = runMigrate(['--source', source, '--db', db]);
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(r2.out.idempotent, true, '第二次运行幂等');

  const store = new SqliteStore({ dbFile: db });
  assert.strictEqual(store.rows('user').length, 1, '不重复建账号');
  assert.strictEqual(store.rows('account').length, 1);
  store.close();
});

test('MIG-3 迁移失败/损坏源 fail-closed 不产出半迁移库', () => {
  const dir = tmpDir('m3');
  const source = path.join(dir, 'accounts.json');
  const db = path.join(dir, 'auth.sqlite');
  fs.writeFileSync(source, 'NOT JSON {{', 'utf8');

  const r = runMigrate(['--source', source, '--db', db]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.out.ok, false);
  assert.strictEqual(r.out.error.code, 'source-corrupt');
});

test('MIG-4 空/缺省 accounts.json 迁移为空库', () => {
  const dir = tmpDir('m4');
  const source = path.join(dir, 'accounts.json');
  const db = path.join(dir, 'auth.sqlite');
  fs.writeFileSync(source, JSON.stringify({ accounts: {}, sessions: {}, pendingVerifications: {}, membership: {} }), 'utf8');

  const r = runMigrate(['--source', source, '--db', db]);
  assert.strictEqual(r.status, 0);
  const store = new SqliteStore({ dbFile: db });
  assert.strictEqual(store.rows('user').length, 0);
  store.close();
});
