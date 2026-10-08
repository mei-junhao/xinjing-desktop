'use strict';
/**
 * auth-sqlite.js — 认证底座的 SQLite 持久层（node:sqlite 内置驱动，无原生编译）。
 * 表：user / session / account / verification（Better Auth 模型，真实类型列 + JSON 溢出列）
 *     membership（服务器权威会员投影，独立于 Better Auth identity/session）
 *     schema_migrations（迁移审计，幂等/可回滚）audit_log（运维审计）
 * 原则：
 *  - 所有写走事务；崩溃安全由 SQLite WAL + 单文件原子性保证。
 *  - 会员投影与身份/会话完全独立，任何身份变更不触碰 membership。
 *  - 密码/令牌不明文写日志；令牌只在 Better Auth 主进程边界内流转。
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Better Auth 模型 → 表列映射（core 列类型化，其余进 JSON 溢出列）。
const MODELS = {
  user: { cols: { id: 'TEXT', name: 'TEXT', email: 'TEXT', emailVerified: 'INTEGER', image: 'TEXT', createdAt: 'TEXT', updatedAt: 'TEXT' } },
  session: { cols: { id: 'TEXT', userId: 'TEXT', token: 'TEXT', expiresAt: 'TEXT', ipAddress: 'TEXT', userAgent: 'TEXT', createdAt: 'TEXT', updatedAt: 'TEXT' } },
  account: { cols: { id: 'TEXT', userId: 'TEXT', accountId: 'TEXT', providerId: 'TEXT', issuer: 'TEXT', password: 'TEXT', accessToken: 'TEXT', refreshToken: 'TEXT', idToken: 'TEXT', accessTokenExpiresAt: 'TEXT', refreshTokenExpiresAt: 'TEXT', scope: 'TEXT', createdAt: 'TEXT', updatedAt: 'TEXT' } },
  verification: { cols: { id: 'TEXT', identifier: 'TEXT', value: 'TEXT', expiresAt: 'TEXT', createdAt: 'TEXT', updatedAt: 'TEXT' } },
};

const QUOTED_COL_NAMES = new Set(['user']); // SQLite 保留字保护

// ---- session token 摘要规范化边界（XJ-5.0.2-015）----
// 数据库只允许保存带版本前缀的不可逆摘要 v1:sha256:<hex>；原始 token 只在主进程内存
// 和 safeStorage 加密会话文件中短暂存在。查询侧永远对输入 token 现算摘要，摘要本身
// 不作为可重放凭证：validateSession/revokeSession 会先拒绝摘要形态输入。
const SESSION_TOKEN_DIGEST_PREFIX = 'v1:sha256:';
const SESSION_TOKEN_DIGEST_RE = /^v1:sha256:[0-9a-f]{64}$/;
const LEGACY_RAW_SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{16,512}$/;
const SESSION_TOKEN_DIGEST_MIGRATION_ID = '003-session-token-digest-v1';

function sessionTokenDigest(token) {
  if (typeof token !== 'string' || !token) return null;
  return SESSION_TOKEN_DIGEST_PREFIX + crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function isSessionTokenDigest(token) {
  return typeof token === 'string' && SESSION_TOKEN_DIGEST_RE.test(token);
}

// 存储侧：raw -> digest；已 digest 的输入保持原样（幂等）。
function normalizeSessionTokenForStorage(token) {
  if (typeof token !== 'string' || !token) return token;
  if (isSessionTokenDigest(token)) return token;
  const digest = sessionTokenDigest(token);
  return digest || token;
}

// 查询侧：任何输入都只做“现算摘要”，绝不透传已摘要值，避免摘要本身成为可重放凭证。
function normalizeSessionTokenForQuery(token) {
  if (typeof token !== 'string' || !token) return token;
  return sessionTokenDigest(token) || token;
}

function q(name) { return QUOTED_COL_NAMES.has(name) ? '"' + name + '"' : name; }

class SqliteStore {
  constructor(opts) {
    opts = opts || {};
    this.dbFile = opts.dbFile || ':memory:';
    this._failWrites = false;
    this._onMutations = 0;
    if (this.dbFile === ':memory:') {
      this.db = new DatabaseSync(':memory:');
    } else {
      const dir = path.dirname(this.dbFile);
      if (dir && dir !== '.' && dir !== '') fs.mkdirSync(dir, { recursive: true });
      this.db = new DatabaseSync(this.dbFile);
    }
    try {
      try { this.db.exec('PRAGMA journal_mode = WAL;'); } catch (e) { /* :memory: 不支持 WAL，忽略 */ }
      this.db.exec('PRAGMA foreign_keys = ON;');
      this._ensureSchema();
        this._recordBaseSchemaMigration();
        this._migrateSessionTokenDigests();
        this._recordQuotaMigration();
        this._recordPasswordResetMigration();
    } catch (e) {
      try { this.db.close(); } catch (_) {}
      const msg = String(e && e.message || e);
      if (/not a database|SQLITE_NOTADB/i.test(msg)) { const err = new Error('account-store-corrupt'); err.cause = e; throw err; }
      throw e;
    }
  }

  setFailWrites(v) { this._failWrites = !!v; }

  _checkWrite() { if (this._failWrites) { const e = new Error('persistence-failed'); e.code = 'persistence-failed'; throw e; } }

  _ensureSchema() {
    for (const model of Object.keys(MODELS)) {
      const spec = MODELS[model];
      const colDefs = Object.keys(spec.cols).map((c) => q(c) + ' ' + spec.cols[c]).join(', ');
      const pk = q('id');
      this.db.exec('CREATE TABLE IF NOT EXISTS ' + q(model) + ' (' + colDefs + ', _json TEXT, PRIMARY KEY (' + pk + '))');
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS membership (
      accountId TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      updatedAt TEXT
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      appliedAt TEXT NOT NULL,
      checksum TEXT
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      action TEXT,
      accountId TEXT,
      tier TEXT,
      operator TEXT,
      via TEXT
    )`);
    // ---- XJ-5.0.2-023：配额钱包/流水/管理员审计（账户绑定余额，整数分避免浮点）----
    this.db.exec(`CREATE TABLE IF NOT EXISTS quota_wallet (
      accountId TEXT PRIMARY KEY,
      balanceCents INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT,
      updatedAt TEXT
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS quota_ledger (
      id TEXT PRIMARY KEY,
      accountId TEXT NOT NULL,
      kind TEXT NOT NULL,
      amountCents INTEGER NOT NULL,
      balanceAfterCents INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      idempotencyKey TEXT,
      meta TEXT,
      at INTEGER NOT NULL
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_quota_ledger_account ON quota_ledger (accountId, at)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS password_reset (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      tokenDigest TEXT NOT NULL,
      accountId TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_password_reset_email ON password_reset (email)`);
  }
    _recordMigrationInTx(id, checksum) {
      this.db.prepare('INSERT INTO schema_migrations (id, appliedAt, checksum) VALUES (?, ?, ?)')
        .run(String(id), new Date().toISOString(), checksum || null);
    }

    _corruptStore(message) {
      return new Error('account-store-corrupt: ' + String(message || 'session-token-migration'));
    }

    // 一次性、事务性、幂等：把 014 遗留的 raw session token 迁移为 v1:sha256 摘要。
    // 未知/缺失 token 一律 fail-closed，绝不让半迁移状态被当成已登录。
    _migrateSessionTokenDigests() {
      const rows = this.db.prepare('SELECT id, token FROM session').all();
      let hasRaw = false;
      for (const row of rows) {
        const token = row.token;
        if (token === null || token === undefined || token === '') {
          throw this._corruptStore('session token missing');
        }
        if (isSessionTokenDigest(token)) continue;
        if (!LEGACY_RAW_SESSION_TOKEN_RE.test(String(token))) {
          throw this._corruptStore('session token format unknown');
        }
        hasRaw = true;
      }
      if (!hasRaw && this.migrationApplied(SESSION_TOKEN_DIGEST_MIGRATION_ID)) return; // 已迁移且无 raw
      if (hasRaw && this.migrationApplied(SESSION_TOKEN_DIGEST_MIGRATION_ID)) {
        throw this._corruptStore('raw session token found after digest migration was applied');
      }
      this._transact(() => {
        const current = this.db.prepare('SELECT id, token FROM session').all();
        for (const row of current) {
          const token = row.token;
          if (isSessionTokenDigest(token)) continue;
          if (!LEGACY_RAW_SESSION_TOKEN_RE.test(String(token))) {
            throw this._corruptStore('session token format unknown');
          }
          this.db.prepare('UPDATE session SET token = ? WHERE id = ?')
            .run(sessionTokenDigest(token), row.id);
        }
        this._recordMigrationInTx(SESSION_TOKEN_DIGEST_MIGRATION_ID, null);
      });
    }

  _rowToObject(model, dbRow) {
    if (!dbRow) return null;
    const spec = MODELS[model];
    const out = {};
    for (const c of Object.keys(spec.cols)) {
      const v = dbRow[c];
      if (v !== undefined && v !== null) out[c] = v;
    }
    if (dbRow._json) {
      try { const extra = JSON.parse(dbRow._json); if (extra && typeof extra === 'object') Object.assign(out, extra); } catch (e) { /* 忽略溢出列损坏 */ }
    }
    return out;
  }

  _objectToCols(model, row) {
    const spec = MODELS[model];
    const cols = {};
    const extra = {};
    for (const k of Object.keys(row)) {
      if (k in spec.cols) cols[k] = row[k];
      else extra[k] = row[k];
    }
    return { cols, json: Object.keys(extra).length ? JSON.stringify(extra) : null };
  }

  rows(model) {
    const spec = MODELS[model];
    if (!spec) return [];
    const list = this.db.prepare('SELECT * FROM ' + q(model)).all();
    return list.map((r) => this._rowToObject(model, r));
  }

  insert(model, row) {
    this._checkWrite();
    const spec = MODELS[model];
      if (model === 'session' && row && typeof row.token === 'string') {
        row = Object.assign({}, row, { token: normalizeSessionTokenForStorage(row.token) });
      }
    const { cols, json } = this._objectToCols(model, row);
    const names = ['id'];
    const qs = ['?'];
    const vals = [String(cols.id !== undefined ? cols.id : row.id)];
    for (const c of Object.keys(spec.cols)) {
      if (c === 'id') continue;
      if (cols[c] !== undefined && cols[c] !== null) { names.push(q(c)); qs.push('?'); vals.push(this._norm(cols[c])); }
    }
    names.push('_json'); qs.push('?'); vals.push(json);
    this.db.prepare('INSERT INTO ' + q(model) + ' (' + names.join(',') + ') VALUES (' + qs.join(',') + ')').run(...vals);
    this._onMutations += 1;
    return row;
  }

  update(model, id, patch) {
    this._checkWrite();
    const spec = MODELS[model];
      if (model === 'session' && patch && typeof patch.token === 'string') {
        patch = Object.assign({}, patch, { token: normalizeSessionTokenForStorage(patch.token) });
      }
    const existing = this.rows(model).find((r) => r.id === id);
    const merged = Object.assign({}, existing || {}, patch, { id: id });
    const { cols, json } = this._objectToCols(model, merged);
    const sets = [];
    const vals = [];
    for (const c of Object.keys(spec.cols)) {
      if (c === 'id') continue;
      sets.push(q(c) + ' = ?'); vals.push(cols[c] !== undefined ? this._norm(cols[c]) : null);
    }
    sets.push('_json = ?'); vals.push(json);
    vals.push(String(id));
    this.db.prepare('UPDATE ' + q(model) + ' SET ' + sets.join(', ') + ' WHERE ' + q('id') + ' = ?').run(...vals);
    this._onMutations += 1;
    return merged;
  }

  remove(model, id) {
    this._checkWrite();
    this.db.prepare('DELETE FROM ' + q(model) + ' WHERE ' + q('id') + ' = ?').run(String(id));
    this._onMutations += 1;
  }

  removeAll(model) {
    this._checkWrite();
    this.db.prepare('DELETE FROM ' + q(model)).run();
    this._onMutations += 1;
  }

  _norm(v) {
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return JSON.stringify(v);
    return v;
  }

  _transact(fn) {
    this.db.exec('BEGIN');
    try { fn(); this.db.exec('COMMIT'); } catch (e) { try { this.db.exec('ROLLBACK'); } catch (_) {} throw e; }
  }

  async withTransaction(fn) {
    this.db.exec('BEGIN');
    try { const r = await fn(); this.db.exec('COMMIT'); return r; } catch (e) { try { this.db.exec('ROLLBACK'); } catch (_) {} throw e; }
  }

  // ---- XJ-5.0.2-023：配额 schema migration 标记 ----
  _recordQuotaMigration() {
    const id = '004-quota-wallet-ledger-v1';
    if (this.migrationApplied(id)) return;
    this._transact(() => { this._recordMigrationInTx(id, null); });
  }

  _recordBaseSchemaMigration() {
    const id = '001-base-schema-v1';
    if (this.migrationApplied(id)) return;
    this._transact(() => { this._recordMigrationInTx(id, null); });
  }

  _recordPasswordResetMigration() {
    const id = '005-password-reset-v1';
    if (this.migrationApplied(id)) return;
    this._transact(() => { this._recordMigrationInTx(id, null); });
  }

  // ---- XJ-5.0.2-023：配额钱包/流水（账户绑定，事务化，幂等，revision 校验）----
  _walletEnsureTx(accountId) {
    const id = String(accountId);
    const row = this.db.prepare('SELECT accountId, balanceCents, revision FROM quota_wallet WHERE accountId = ?').get(id);
    if (row) return row;
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO quota_wallet (accountId, balanceCents, revision, createdAt, updatedAt) VALUES (?, 0, 0, ?, ?)').run(id, now, now);
    return this.db.prepare('SELECT accountId, balanceCents, revision FROM quota_wallet WHERE accountId = ?').get(id);
  }

  walletGet(accountId) {
    const row = this.db.prepare('SELECT accountId, balanceCents, revision FROM quota_wallet WHERE accountId = ?').get(String(accountId));
    return row ? { accountId: row.accountId, balanceCents: row.balanceCents, revision: row.revision } : null;
  }

  // 管理员充值：受保护入口调用；幂等键 + revision 事务校验；写 ledger + audit。
  walletCredit(accountId, amountCents, meta) {
    this._checkWrite();
    const id = String(accountId || '');
    if (!id) return { ok: false, error: { code: 'bad-account' } };
    const amt = Number(amountCents);
    if (!Number.isInteger(amt) || amt <= 0) return { ok: false, error: { code: 'bad-amount' } };
    if (amt > 1_000_000_000_00) return { ok: false, error: { code: 'amount-overflow' } };
    const idem = String((meta && meta.idempotencyKey) || '');
    if (idem) {
      const dup = this.db.prepare('SELECT * FROM quota_ledger WHERE idempotencyKey = ? AND accountId = ? AND kind = ?').get(idem, id, 'credit');
      if (dup) return { ok: true, idempotent: true, accountId: id, balanceCents: dup.balanceAfterCents, revision: dup.revision };
    }
    let out = null;
    this._transact(() => {
      const w = this._walletEnsureTx(id);
      const nextBalance = w.balanceCents + amt;
      const nextRev = w.revision + 1;
      const nowIso = new Date().toISOString();
      this.db.prepare('UPDATE quota_wallet SET balanceCents = ?, revision = ?, updatedAt = ? WHERE accountId = ?').run(nextBalance, nextRev, nowIso, id);
      const ledgerId = 'led_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
      this.db.prepare('INSERT INTO quota_ledger (id, accountId, kind, amountCents, balanceAfterCents, revision, idempotencyKey, meta, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ledgerId, id, 'credit', amt, nextBalance, nextRev, idem, (meta && meta.meta) ? JSON.stringify(meta.meta) : null, Date.now());
      this._audit({ action: 'admin-credit', accountId: id, operator: (meta && meta.operator) || 'admin', via: (meta && meta.via) || 'admin-credit', tier: 'credit:' + amt });
      out = { ok: true, accountId: id, amountCents: amt, balanceCents: nextBalance, revision: nextRev };
    });
    return out || { ok: false, error: { code: 'credit-failed' } };
  }

  // 扣费：事务内余额校验 + revision 递增；余额不足确定性拒绝，不产生半状态。
  walletDebit(accountId, amountCents, meta) {
    this._checkWrite();
    const id = String(accountId || '');
    if (!id) return { ok: false, error: { code: 'bad-account' } };
    const amt = Number(amountCents);
    if (!Number.isInteger(amt) || amt <= 0) return { ok: false, error: { code: 'bad-amount' } };
    let out = null;
    this._transact(() => {
      const w = this._walletEnsureTx(id);
      if (w.balanceCents < amt) { out = { ok: false, error: { code: 'insufficient-balance', balanceCents: w.balanceCents, requiredCents: amt } }; return; }
      const nextBalance = w.balanceCents - amt;
      const nextRev = w.revision + 1;
      const nowIso = new Date().toISOString();
      this.db.prepare('UPDATE quota_wallet SET balanceCents = ?, revision = ?, updatedAt = ? WHERE accountId = ?').run(nextBalance, nextRev, nowIso, id);
      const ledgerId = 'led_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
      this.db.prepare('INSERT INTO quota_ledger (id, accountId, kind, amountCents, balanceAfterCents, revision, idempotencyKey, meta, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ledgerId, id, 'debit', amt, nextBalance, nextRev, (meta && meta.idempotencyKey) || null, (meta && meta.meta) ? JSON.stringify(meta.meta) : null, Date.now());
      out = { ok: true, accountId: id, amountCents: amt, balanceCents: nextBalance, revision: nextRev };
    });
    return out || { ok: false, error: { code: 'debit-failed' } };
  }

  walletLedger(accountId) {
    return this.db.prepare('SELECT * FROM quota_ledger WHERE accountId = ? ORDER BY at ASC').all(String(accountId));
  }

  // 脱敏余额投影（登录会话只读自己的余额，绝不暴露 ledger/meta）。
  walletProjection(accountId) {
    const w = this.walletGet(accountId);
    return { ok: true, accountId: String(accountId), balanceYuan: w ? +(w.balanceCents / 100).toFixed(2) : 0, balanceCents: w ? w.balanceCents : 0, revision: w ? w.revision : 0 };
  }

  // ---- membership（服务器权威，独立）----
  setMembership(accountId, tier, meta) {
    this._checkWrite();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO membership (accountId, tier, updatedAt) VALUES (?, ?, ?) ON CONFLICT(accountId) DO UPDATE SET tier = excluded.tier, updatedAt = excluded.updatedAt')
      .run(String(accountId), String(tier), now);
    this._audit({ action: 'grant-membership', accountId: String(accountId), tier: String(tier), operator: (meta && meta.operator) || 'local-ops', via: (meta && meta.via) || 'cli' });
    return { ok: true, accountId: String(accountId), tier: String(tier) };
  }

  getMembership(accountId) {
    const r = this.db.prepare('SELECT tier FROM membership WHERE accountId = ?').get(String(accountId));
    return r ? r.tier : null;
  }

  membershipAll() {
    const rows = this.db.prepare('SELECT * FROM membership').all();
    const out = {};
    for (const r of rows) out[r.accountId] = r.tier;
    return out;
  }

  // ---- audit ----
  _audit(rec) {
    const id = 'audit_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
    this.db.prepare('INSERT INTO audit_log (id, at, action, accountId, tier, operator, via) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, Date.now(), rec.action || null, rec.accountId || null, rec.tier || null, rec.operator || null, rec.via || null);
  }

  auditAll() { return this.db.prepare('SELECT * FROM audit_log ORDER BY at ASC').all(); }

  // ---- migrations ----
  migrationApplied(id) { return !!this.db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(String(id)); }

  recordMigration(id, checksum) {
    this._transact(() => {
      this.db.prepare('INSERT INTO schema_migrations (id, appliedAt, checksum) VALUES (?, ?, ?)')
        .run(String(id), new Date().toISOString(), checksum || null);
    });
  }

  close() { try { this.db.close(); } catch (e) { /* already closed */ } }
}

function checksumHex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

module.exports = {
  SqliteStore,
  MODELS,
  checksumHex,
  sessionTokenDigest,
  isSessionTokenDigest,
  normalizeSessionTokenForStorage,
  normalizeSessionTokenForQuery,
  SESSION_TOKEN_DIGEST_RE,
  LEGACY_RAW_SESSION_TOKEN_RE,
};
