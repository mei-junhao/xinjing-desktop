'use strict';
/**
 * account-auth-session-security.test.js — XJ-5.0.2-015 token 摘要边界与 legacy raw-token 迁移契约。
 * 覆盖：登录后 SQLite 仅存 v1:sha256 摘要、摘要不可重放、raw-token 迁移幂等/未知格式 fail-closed、
 * 审计字段拆分且不泄漏 token、Better Auth adapter 的 create/find/update/delete 全部走同一摘要边界。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { AccountAuth } = require('../server/account-auth');
const {
  SqliteStore,
  sessionTokenDigest,
  isSessionTokenDigest,
  normalizeSessionTokenForStorage,
  normalizeSessionTokenForQuery,
} = require('../server/auth-sqlite');
const { createSqliteAdapter } = require('../server/better-auth-adapter');

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj-ss-' + name + '-')), 'a.sqlite');
}

function createLegacySessionDb(file, token, id, userId) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    userId TEXT,
    token TEXT,
    expiresAt TEXT,
    ipAddress TEXT,
    userAgent TEXT,
    createdAt TEXT,
    updatedAt TEXT,
    _json TEXT
  )`);
  db.prepare('INSERT INTO session (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(id), String(userId), token, new Date(Date.now() + 3600000).toISOString(), new Date().toISOString(), new Date().toISOString());
  db.close();
}

test('SS-1 登录后 SQLite 仅存带版本前缀的不可逆摘要，原始 token 不在库中', async () => {
  const dataFile = tmpFile('ss1');
  const a = new AccountAuth({ dataFile });
  const reg = a.register({ email: 'user@example.com', password: 'Password123' });
  assert.strictEqual(reg.ok, true);
  a.verify(reg.verificationToken);
  const login = await a.login({ email: 'user@example.com', password: 'Password123' });
  assert.strictEqual(login.ok, true);
  const raw = login.sessionToken;
  assert.strictEqual(typeof raw, 'string');
  assert.ok(raw.length >= 16, 'raw token length ok');
  assert.ok(!isSessionTokenDigest(raw), 'Better Auth 返回的原始 token 不是摘要形态');

  const sessions = a._sessions();
  assert.strictEqual(sessions.length, 1);
  assert.ok(isSessionTokenDigest(sessions[0].token), 'SQLite session.token 必须是摘要');
  assert.strictEqual(sessions[0].token, sessionTokenDigest(raw));
  assert.notStrictEqual(sessions[0].token, raw);
  assert.ok(!JSON.stringify(a.store.rows('session')).includes(raw), 'session 行不包含原始 token');

  const audit = a._audit();
  assert.strictEqual(audit.sessionTokensHashedAtRest, true);
  assert.strictEqual(audit.sessionTokenStorage, 'v1-sha256-digest');
  assert.ok(!JSON.stringify(audit).includes(raw), '审计输出不泄漏原始 token');

  // 重启持久化后仍为摘要，且原始 token 可验证
  const a2 = new AccountAuth({ dataFile });
  const sessions2 = a2._sessions();
  assert.strictEqual(sessions2.length, 1);
  assert.ok(isSessionTokenDigest(sessions2[0].token));
  assert.notStrictEqual(sessions2[0].token, raw);
  assert.strictEqual(a2.validateSession(raw).ok, true);
  a2.store.close();
  a.store.close();
});

test('SS-2 摘要本身不可作为会话凭证重放', async () => {
  const a = new AccountAuth({ dataFile: tmpFile('ss2') });
  const reg = a.register({ email: 'user@example.com', password: 'Password123' });
  a.verify(reg.verificationToken);
  const login = await a.login({ email: 'user@example.com', password: 'Password123' });
  const raw = login.sessionToken;
  const digest = sessionTokenDigest(raw);

  assert.strictEqual(a.validateSession(digest).ok, false, 'validateSession 必须拒绝摘要形态输入');
  assert.strictEqual(a.revokeSession(digest).ok, false, 'revokeSession 必须拒绝摘要形态输入');
  assert.strictEqual(a.validateSession(raw).ok, true, '原始 token 仍有效');
  assert.strictEqual(a.revokeSession(raw).revoked, true);
  assert.strictEqual(a.validateSession(raw).ok, false);
  a.store.close();
});

test('SS-3 legacy raw-token 行做一次性、事务性、幂等迁移', () => {
  const dataFile = tmpFile('ss3');
  const raw = 'LegacyRawSessionToken_1234567890';
  createLegacySessionDb(dataFile, raw, 'sess_legacy_1', 'acct_legacy00000001');

  const store = new SqliteStore({ dbFile: dataFile });
  assert.strictEqual(store.migrationApplied('003-session-token-digest-v1'), true, '迁移应已记录');
  const rows = store.rows('session');
  assert.strictEqual(rows.length, 1);
  assert.ok(isSessionTokenDigest(rows[0].token), 'legacy raw token 应被迁移为摘要');
  assert.strictEqual(rows[0].token, sessionTokenDigest(raw));
  assert.notStrictEqual(rows[0].token, raw);
  store.close();

  const reopened = new SqliteStore({ dbFile: dataFile });
  assert.strictEqual(reopened.migrationApplied('003-session-token-digest-v1'), true);
  assert.strictEqual(reopened.rows('session')[0].token, sessionTokenDigest(raw));
  reopened.close();
});

test('SS-4 未知 token 格式必须 fail-closed，不得把半迁移状态当已登录', () => {
  const dataFile = tmpFile('ss4');
  createLegacySessionDb(dataFile, 'not a valid raw token!', 'sess_bad_1', 'acct_bad00000000001');
  let threw = null;
  try { new SqliteStore({ dbFile: dataFile }); } catch (e) { threw = e; }
  assert.ok(threw, '未知 token 格式必须抛错');
  assert.strictEqual(threw.message, 'account-store-corrupt: session token format unknown');
});

test('SS-5 迁移已应用后出现 raw 行必须 fail-closed', () => {
  const dataFile = tmpFile('ss5');
  createLegacySessionDb(dataFile, 'LegacyRawSessionToken_1234567890', 'sess_legacy_1', 'acct_legacy00000001');
  const store = new SqliteStore({ dbFile: dataFile });
  store.close();

  const db = new DatabaseSync(dataFile);
  db.prepare('INSERT INTO session (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run('sess_raw_after', 'acct_legacy00000001', 'AnotherRawSessionToken_1234567890', new Date(Date.now() + 3600000).toISOString(), new Date().toISOString(), new Date().toISOString());
  db.close();

  let threw = null;
  try { new SqliteStore({ dbFile: dataFile }); } catch (e) { threw = e; }
  assert.ok(threw, '迁移已应用后出现 raw 行必须 fail-closed');
  assert.strictEqual(threw.message, 'account-store-corrupt: raw session token found after digest migration was applied');
});

test('SS-6 审计拆分 verificationTokensHashedAtRest / sessionTokensHashedAtRest / sessionTokenStorage，且不泄漏 token', async () => {
  const dataFile = tmpFile('ss6');
  const a = new AccountAuth({ dataFile });
  const reg = a.register({ email: 'user@example.com', password: 'Password123' });
  a.verify(reg.verificationToken);
  const login = await a.login({ email: 'user@example.com', password: 'Password123' });
  const raw = login.sessionToken;
  const audit = a._audit();
  assert.strictEqual(audit.verificationTokensHashedAtRest, true);
  assert.strictEqual(audit.sessionTokensHashedAtRest, true);
  assert.strictEqual(audit.sessionTokenStorage, 'v1-sha256-digest');
  assert.strictEqual(audit.tokensHashedAtRest, true);
  assert.ok(!JSON.stringify(audit).includes(raw), '审计输出不得包含原始 token');

  // 强制制造 plaintext-raw 行，审计必须如实降级且不泄漏 token
  a.store.db.prepare('UPDATE session SET token = ?').run(raw);
  const degraded = a._audit();
  assert.strictEqual(degraded.sessionTokensHashedAtRest, false);
  assert.strictEqual(degraded.sessionTokenStorage, 'plaintext-raw');
  assert.strictEqual(degraded.tokensHashedAtRest, false);
  assert.ok(!JSON.stringify(degraded).includes(raw), '降级审计输出也不得包含原始 token');
  a.store.close();
});

test('SS-7 查询规范化：摘要值不会被透传，规范化函数行为正确', () => {
  const raw = 'RawQueryNormalizeToken_1234567890';
  const digest = sessionTokenDigest(raw);
  assert.ok(isSessionTokenDigest(digest));
  assert.strictEqual(normalizeSessionTokenForStorage(raw), digest);
  assert.strictEqual(normalizeSessionTokenForStorage(digest), digest);
  assert.strictEqual(normalizeSessionTokenForQuery(raw), digest);
  assert.notStrictEqual(normalizeSessionTokenForQuery(digest), digest, '查询侧不得透传摘要值');
});

test('SS-8 Better Auth adapter 的 create/find/update/delete 全部走同一摘要边界', async () => {
  const store = new SqliteStore({ dbFile: tmpFile('ss8') });
  const adapterFactory = await createSqliteAdapter(store);
  const db = adapterFactory({});
  const raw = 'RawAdapterSessionToken_1234567890';
  const base = {
    id: 'sess_adapter_1',
    userId: 'acct_adapter00000001',
    token: raw,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await db.create({ model: 'session', data: base });
  const rows = store.rows('session');
  assert.strictEqual(rows.length, 1);
  assert.ok(isSessionTokenDigest(rows[0].token), 'create 必须落摘要');
  assert.strictEqual(rows[0].token, sessionTokenDigest(raw));

  const found = await db.findOne({ model: 'session', where: [{ field: 'token', value: raw }] });
  assert.ok(found, 'findOne 按原始 token 查询必须命中（查询侧规范化）');
  assert.strictEqual(found.token, sessionTokenDigest(raw));

  const newExpiry = new Date(Date.now() + 7200000).toISOString();
  const updated = await db.update({ model: 'session', where: [{ field: 'token', value: raw }], update: { expiresAt: newExpiry } });
  assert.ok(updated, 'update 按原始 token 查询必须命中');
  assert.strictEqual(store.rows('session')[0].expiresAt, newExpiry, 'update 必须把新过期时间写穿到 SQLite');
  assert.ok(isSessionTokenDigest(store.rows('session')[0].token), 'update 路径不得旁路 token 摘要边界');

  await db.delete({ model: 'session', where: [{ field: 'token', value: raw }] });
  assert.strictEqual(store.rows('session').length, 0, 'delete 按原始 token 查询必须命中并删除');
  store.close();
});
