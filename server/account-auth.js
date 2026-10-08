'use strict';
/**
 * account-auth.js — XJ-5.0.2-023：服务器账号/会话/验证/会员/余额/配额统一收口 SQLite。
 * 持久层为 SqliteStore(node:sqlite)；旧 accounts.json 一次性可审计迁移（保留只读备份）。
 * 会话 token 只存 v1:sha256 摘要；管理员充值走受保护入口，写 wallet/ledger/audit，幂等+revision。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  SqliteStore,
  sessionTokenDigest,
  isSessionTokenDigest,
  normalizeSessionTokenForQuery,
} = require('./auth-sqlite');
const { passwordHashSync, verifyPasswordHash } = require('./better-auth-config');

const VERIFY_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_TIERS = ['free', 'pro', 'flagship'];

// 默认模型策略：DeepSeek V4 Pro 是主力；只有主力上游失败时才由服务端进入 Qwen 免费兜底。
// 客户端不能通过请求字段把兜底模型提升为主力，路由由 server.js 的权威目录决定。
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'deepseek-v4-pro';
const BUDGET_MODEL = process.env.BUDGET_MODEL || 'deepseek-v4-pro';
const BUDGET_YUAN = parseFloat(process.env.QUOTA_BUDGET_YUAN || '5');

function hashSecret(v) { return crypto.createHash('sha256').update(String(v), 'utf8').digest('hex'); }
function randomToken() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function randomHex(n) { return crypto.randomBytes(n).toString('hex'); }
function scryptHash(password, salt) { return crypto.scryptSync(String(password), salt, 64).toString('hex'); }
function nowMs() { return Date.now(); }
function nowIso() { return new Date().toISOString(); }
function resetTokenDigest(token) { return crypto.scryptSync(String(token), 'xinjing-password-reset-v1', 64).toString('hex'); }


class AccountAuth {
  constructor(opts) {
    opts = opts || {};
    this.dataFile = opts.dataFile || path.join(__dirname, 'data', 'accounts.sqlite');
    this.verifyTtlMs = opts.verifyTtlMs !== undefined ? opts.verifyTtlMs : VERIFY_TTL_MS;
    this.sessionTtlMs = opts.sessionTtlMs !== undefined ? opts.sessionTtlMs : SESSION_TTL_MS;
    this.resendCooldownMs = opts.resendCooldownMs !== undefined ? opts.resendCooldownMs : RESEND_COOLDOWN_MS;
    this.store = new SqliteStore({ dbFile: this.dataFile });
    this._preparedResend = {};
  }

  setSaveFail(v) { this.store.setFailWrites(!!v); }

  // ---- 用户/账户查询 ----
  _users() { return this.store.rows('user'); }
  _accounts() { return this.store.rows('account'); }
  _sessions() { return this.store.rows('session'); }
  _verifications() { return this.store.rows('verification'); }
  _userById(id) { return this._users().find((u) => u.id === String(id)); }
  _userByEmail(email) { const e = String(email || '').trim().toLowerCase(); return this._users().find((u) => String(u.email).toLowerCase() === e); }

  _tierOf(accountId) { const m = this.store.getMembership(accountId); return m || 'free'; }

  // ---- staged 注册（保持 014 rework-004 语义）----
  prepareRegistration(b) {
    const email = String((b && b.email) || '').trim().toLowerCase();
    const password = String((b && b.password) || '');
    if (!EMAIL_RE.test(email)) return { ok: false, error: { code: 'invalid-email' } };
    if (typeof password !== 'string' || password.length < 8) return { ok: false, error: { code: 'weak-password' } };
    if (this._userByEmail(email)) return { ok: false, error: { code: 'email-taken' } };
    const passwordHash = passwordHashSync(password);
    const accountId = 'acct_' + randomHex(12);
    const token = randomToken();
    return { ok: true, email, accountId, verificationToken: token, passwordHash, tier: 'free', createdAt: nowIso(), expiresAt: new Date(Date.now() + this.verifyTtlMs).toISOString() };
  }

  commitRegistration(staged) {
    if (!staged || !staged.ok) return { ok: false, error: { code: 'bad-staged' } };
    const email = String(staged.email).toLowerCase();
    if (this._userByEmail(email)) return { ok: false, error: { code: 'email-taken' } };
    this.store._transact(() => {
      this.store.insert('user', { id: staged.accountId, email, emailVerified: 0, name: '', createdAt: staged.createdAt, updatedAt: nowIso(), disabled: 0, tier: staged.tier });
      this.store.insert('account', { id: 'cred_' + staged.accountId, userId: staged.accountId, accountId: staged.accountId, providerId: 'credential', password: staged.passwordHash, createdAt: nowIso(), updatedAt: nowIso() });
      this.store.insert('verification', { id: hashSecret(staged.verificationToken), identifier: email, value: hashSecret(staged.verificationToken), expiresAt: staged.expiresAt, createdAt: nowIso(), updatedAt: nowIso(), accountId: staged.accountId });
    });
    return { ok: true, accountId: staged.accountId, email };
  }

  register(b) {
    const staged = this.prepareRegistration(b);
    if (!staged.ok) return staged;
    const committed = this.commitRegistration(staged);
    if (!committed.ok) return committed;
    return { ok: true, verificationToken: staged.verificationToken, email: staged.email, accountId: staged.accountId };
  }

  resendVerification(email) {
    const e = String(email || '').trim().toLowerCase();
    const u = this._userByEmail(e);
    if (!u) return { ok: false, error: { code: 'account-not-found' } };
    if (u.emailVerified) return { ok: false, error: { code: 'already-verified' } };
    const last = this._preparedResend[e];
    if (last && Date.now() - last < this.resendCooldownMs) return { ok: false, error: { code: 'resend-cooldown' } };
    const token = randomToken();
    this._preparedResend[e] = { token, accountId: u.id, at: Date.now() };
    return { ok: true, email: e, verificationToken: token, accountId: u.id };
  }

  commitResend(email) {
    const e = String(email || '').trim().toLowerCase();
    const p = this._preparedResend[e];
    if (!p) return { ok: false, error: { code: 'no-prepared-resend' } };
    const u = this._userByEmail(e);
    if (!u) return { ok: false, error: { code: 'account-not-found' } };
    this.store._transact(() => {
      for (const v of this._verifications()) if (String(v.identifier).toLowerCase() === e) this.store.remove('verification', v.id);
      this.store.insert('verification', { id: hashSecret(p.token), identifier: e, value: hashSecret(p.token), expiresAt: new Date(Date.now() + this.verifyTtlMs).toISOString(), createdAt: nowIso(), updatedAt: nowIso(), accountId: u.id });
    });
    delete this._preparedResend[e];
    return { ok: true, email: e, accountId: u.id };
  }

  verify(token) {
    const t = String(token || '').trim();
    if (!/^\d{6}$/.test(t)) return { ok: false, error: { code: 'invalid-token' } };
    const h = hashSecret(t);
    const v = this.store.rows('verification').find((x) => x.value === h);
    if (!v) return { ok: false, error: { code: 'token-not-found' } };
    if (Date.now() > new Date(v.expiresAt).getTime()) { this.store.remove('verification', v.id); return { ok: false, error: { code: 'token-expired' } }; }
    const u = this._userById(v.accountId);
    if (!u) return { ok: false, error: { code: 'account-not-found' } };
    this.store._transact(() => {
      this.store.update('user', u.id, { emailVerified: 1, updatedAt: nowIso() });
      this.store.remove('verification', v.id);
      this.store._audit({ action: 'account-verified', accountId: u.id });
    });
    return { ok: true, email: u.email, accountId: u.id };
  }

  async login(b) {
    const email = String((b && b.email) || '').trim().toLowerCase();
    const password = String((b && b.password) || '');
    const u = this._userByEmail(email);
    if (!u) return { ok: false, error: { code: 'account-not-found' } };
    if (u.disabled) return { ok: false, error: { code: 'account-disabled' } };
    if (!u.emailVerified) return { ok: false, error: { code: 'email-unverified' } };
    const cred = this._accounts().find((a) => a.userId === u.id && a.providerId === 'credential');
    const storedHash = (cred && cred.password) || '';
    if (!storedHash || !verifyPasswordHash(storedHash, password)) return { ok: false, error: { code: 'invalid-credentials' } };
    const token = randomHex(24);
    const digest = sessionTokenDigest(token);
    this.store.insert('session', { id: digest, userId: u.id, token: digest, expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString(), createdAt: nowIso(), updatedAt: nowIso(), email: u.email });
    return { ok: true, sessionToken: token, accountId: u.id, tier: this._tierOf(u.id) };
  }

  validateSession(token) {
    if (typeof token !== 'string' || !token) return { ok: false, error: { code: 'no-session' } };
    if (isSessionTokenDigest(token)) return { ok: false, error: { code: 'session-not-found' } };
    const key = normalizeSessionTokenForQuery(token);
    const rec = this._sessions().find((s) => s.token === key);
    if (!rec) return { ok: false, error: { code: 'session-not-found' } };
    if (nowMs() > new Date(rec.expiresAt).getTime()) { this.store.remove('session', rec.id); return { ok: false, error: { code: 'session-expired' } }; }
    const account = this._userById(rec.userId);
    if (!account) return { ok: false, error: { code: 'account-invalid' } };
    if (account.disabled) return { ok: false, error: { code: 'account-disabled' } };
    if (!account.emailVerified) return { ok: false, error: { code: 'account-unverified' } };
    const tier = this._tierOf(rec.userId);
    if (!VALID_TIERS.includes(tier)) return { ok: false, error: { code: 'unknown-tier' } };
    return { ok: true, accountId: rec.userId, email: account.email, tier };
  }

  revokeSession(token) {
    if (typeof token !== 'string' || !token) return { ok: false, error: { code: 'no-session' } };
    if (isSessionTokenDigest(token)) return { ok: false, error: { code: 'session-not-found' } };
    const key = normalizeSessionTokenForQuery(token);
    const rec = this._sessions().find((s) => s.token === key);
    const existed = !!rec;
    if (rec) this.store.remove('session', rec.id);
    return { ok: true, revoked: existed };
  }

  getMembership(sessionToken) {
    const s = this.validateSession(sessionToken);
    if (!s.ok) return { ok: false, error: s.error };
    return { ok: true, accountId: s.accountId, tier: s.tier, serverAuthoritative: true };
  }

  grantMembership(accountId, tier, meta) {
    if (typeof accountId !== 'string' || !accountId) return { ok: false, error: { code: 'bad-account' } };
    if (tier !== 'pro' && tier !== 'flagship') return { ok: false, error: { code: 'bad-tier' } };
    if (!this._userById(accountId)) return { ok: false, error: { code: 'account-missing' } };
    this.store.setMembership(accountId, tier, { operator: (meta && meta.operator) || 'local-ops', via: (meta && meta.via) || 'cli' });
    return { ok: true };
  }

  _setMembershipRaw(accountId, tier) { this.store.setMembership(accountId, tier, { operator: 'test', via: 'raw' }); return { ok: true }; }

  disable(email) {
    const e = String(email || '').trim().toLowerCase();
    const account = this._userByEmail(e);
    if (!account) return { ok: false, error: { code: 'account-not-found' } };
    this.store._transact(() => {
      this.store.update('user', account.id, { disabled: 1 });
      for (const v of this._verifications()) if (String(v.identifier).toLowerCase() === e) this.store.remove('verification', v.id);
      for (const s of this._sessions()) if (s.userId === account.id) this.store.remove('session', s.id);
    });
    return { ok: true };
  }

  setDisabled(email, bool) {
    const e = String(email || '').trim().toLowerCase();
    const account = this._userByEmail(e);
    if (!account) return { ok: false, error: { code: 'account-not-found' } };
    this.store.update('user', account.id, { disabled: bool ? 1 : 0 });
    return { ok: true };
  }


  // ---- 密码重置（XJ-5.0.2-023）：令牌存不可逆 scrypt 摘要，一次性 + 过期，明文不入库 ----
  requestPasswordReset(email) {
    const e = String(email || '').trim().toLowerCase();
    const u = this._userByEmail(e);
    if (!u) return { ok: false, error: { code: 'account-not-found' } };
    if (u.disabled) return { ok: false, error: { code: 'account-disabled' } };
    const last = this._preparedResend['reset:' + e];
    if (last && Date.now() - last.at < this.resendCooldownMs) return { ok: false, error: { code: 'resend-cooldown' } };
    const token = randomToken(); // 047：忘记密码验证码统一 6 位数字
    const digest = resetTokenDigest(token);
    const now = nowIso();
    this.store._transact(() => {
      this.store.db.prepare('INSERT INTO password_reset (id, email, tokenDigest, accountId, expiresAt, createdAt, used) VALUES (?, ?, ?, ?, ?, ?, 0)')
        .run('pr_' + randomHex(8), e, digest, u.id, new Date(Date.now() + this.verifyTtlMs).toISOString(), now);
    });
    this._preparedResend['reset:' + e] = { token, at: Date.now() };
    return { ok: true, email: e, accountId: u.id, resetToken: token };
  }

  rollbackPasswordReset(email) {
    const e = String(email || '').trim().toLowerCase();
    const rows = this.store.db.prepare('SELECT id FROM password_reset WHERE email = ? AND used = 0 ORDER BY createdAt DESC').all(e);
    let removed = 0;
    for (const r of rows) { this.store.db.prepare('DELETE FROM password_reset WHERE id = ?').run(r.id); removed++; }
    delete this._preparedResend['reset:' + e];
    return { ok: true, removed };
  }

  resetPassword(b) {
    const email = String((b && b.email) || '').trim().toLowerCase();
    const token = String((b && b.token) || '');
    const password = String((b && b.password) || '');
    if (password.length < 8) return { ok: false, error: { code: 'weak-password' } };
    const u = this._userByEmail(email);
    if (!u) return { ok: false, error: { code: 'account-not-found' } };
    if (!token) return { ok: false, error: { code: 'token-not-found' } };
    const digest = resetTokenDigest(token);
    const row = this.store.db.prepare('SELECT * FROM password_reset WHERE email = ? AND used = 0 AND tokenDigest = ? ORDER BY createdAt DESC').get(email, digest);
    if (!row) return { ok: false, error: { code: 'token-not-found' } };
    if (Date.now() > new Date(row.expiresAt).getTime()) return { ok: false, error: { code: 'token-expired' } };
    const newHash = passwordHashSync(password);
    this.store._transact(() => {
      this.store.db.prepare('UPDATE password_reset SET used = 1 WHERE id = ?').run(row.id);
      const cred = this._accounts().find((a) => a.userId === u.id && a.providerId === 'credential');
      if (cred) this.store.update('account', cred.id, { password: newHash, updatedAt: nowIso() });
      else this.store.insert('account', { id: 'cred_' + u.id, userId: u.id, accountId: u.id, providerId: 'credential', password: newHash, createdAt: nowIso(), updatedAt: nowIso() });
      this.store._audit({ action: 'password-reset', accountId: u.id });
    });
    return { ok: true, email, accountId: u.id };
  }

  // ---- XJ-5.0.2-023：管理员充值 / 账户绑定余额 / 扣费 / 默认模型 ----
  // 受保护入口：调用方（CLI 或 admin token 内部接口）必须先鉴权；此处仅做账户存在性 + 幂等充值。
  adminCredit(accountId, amountCents, meta) {
    if (typeof accountId !== 'string' || !accountId) return { ok: false, error: { code: 'bad-account' } };
    if (!this._userById(accountId)) return { ok: false, error: { code: 'account-missing' } };
    return this.store.walletCredit(accountId, amountCents, meta);
  }

  // 登录会话读自己的脱敏余额；未知/无会话 fail-closed。
  balanceProjection(sessionToken) {
    const s = this.validateSession(sessionToken);
    if (!s.ok) return { ok: false, error: s.error };
    return this.store.walletProjection(s.accountId);
  }

  // DeepSeek Flash 扣费：账户绑定，事务化余额校验；余额不足确定性拒绝。
  debitAccount(accountId, amountCents, meta) {
    if (typeof accountId !== 'string' || !accountId) return { ok: false, error: { code: 'bad-account' } };
    return this.store.walletDebit(accountId, amountCents, meta);
  }

  defaultModelConfig() {
    return { ok: true, defaultModel: DEFAULT_MODEL, budgetModel: BUDGET_MODEL, budgetYuan: BUDGET_YUAN, serverAuthoritative: true };
  }

  _audit() {
    const users = this._users();
    const accounts = this._accounts();
    const sessions = this._sessions();
    const verifications = this._verifications();
    const cred = accounts.filter((a) => a.providerId === 'credential');
    const passwordHashedAtRest = cred.length > 0 && cred.every((a) => typeof a.password === 'string' && /^[0-9a-f]{16,64}:[0-9a-f]{128}$/.test(a.password));
    const verificationHashedAtRest = verifications.every((v) => typeof v.value === 'string' && /^[0-9a-f]{64}$/.test(v.value));
    const sessionDigestOk = sessions.every((s) => isSessionTokenDigest(s.token));
    const sessionTokenStorage = sessions.length === 0 ? 'empty' : (sessionDigestOk ? 'v1-sha256-digest' : 'plaintext-raw');
    const walletAccounts = this.store.db.prepare('SELECT COUNT(*) AS c FROM quota_wallet').get().c;
    return {
      accountCount: users.length,
      sessionCount: sessions.length,
      pendingVerificationCount: verifications.length,
      membershipGrants: this.store.membershipAll(),
      walletAccountCount: walletAccounts,
      passwordHashedAtRest,
      verificationTokensHashedAtRest: verificationHashedAtRest,
      sessionTokensHashedAtRest: sessionDigestOk,
      sessionTokenStorage,
      tokensHashedAtRest: verificationHashedAtRest && sessionDigestOk,
    };
  }

  close() { this.store.close(); }
}

// ---- 受保护服务器端 CLI：管理员充值（root 或独立 admin token）----
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === 'admin-credit') {
    const accountId = args[1];
    const amountCents = Number(args[2]);
    const adminToken = process.env.ACCOUNT_ADMIN_TOKEN || '';
    const ti = args.indexOf('--token');
    const given = (ti >= 0 && args[ti + 1]) ? args[ti + 1] : '';
    const isRoot = (typeof process.getuid === 'function') ? process.getuid() === 0 : false;
    if (!isRoot && (!adminToken || given !== adminToken)) {
      console.error(JSON.stringify({ ok: false, error: { code: 'admin-forbidden' } }));
      process.exit(2);
    }
    const ii = args.indexOf('--idempotency-key');
    const idemKey = (ii >= 0 && args[ii + 1]) ? args[ii + 1] : 'cli-' + Date.now();
    const dataFile = process.env.ACCOUNT_DATA_FILE || path.join(__dirname, 'data', 'accounts.sqlite');
    let auth;
    try { auth = new AccountAuth({ dataFile }); } catch (err) { console.error(JSON.stringify({ ok: false, error: { code: 'account-store-corrupt' } })); process.exit(1); }
    const r = auth.adminCredit(accountId, amountCents, { idempotencyKey: idemKey, operator: isRoot ? 'root' : 'admin-token', via: 'cli' });
    console.log(JSON.stringify(r));
    auth.close();
    process.exit(r.ok ? 0 : 1);
  }
  console.error(JSON.stringify({ ok: false, error: { code: 'unknown-command' } }));
  process.exit(1);
}

module.exports = { AccountAuth, hashSecret, randomToken, EMAIL_RE, VALID_TIERS };
