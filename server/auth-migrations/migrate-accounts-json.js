'use strict';
/**
 * migrate-accounts-json.js — 旧 accounts.json → Better Auth + SQLite 迁移（幂等/可回滚/可审计）。
 * 迁移策略：
 *  - 账号（user + credential account + membership）完整迁移；密码 hash 保持 salt:scryptHex 不降级、不丢弃。
 *  - session / pendingVerifications 的明文 token 在旧实现中仅哈希落盘、从未持久化明文，
 *    故无法恢复到 Better Auth 的不透明 token 模型 → 丢弃并要求用户重新登录/重发验证（显式迁移策略）。
 *  - 永不删除源 accounts.json；迁移前写 .pre-migration 备份，迁移结果写 schema_migrations 审计。
 * 用法：node server/auth-migrations/migrate-accounts-json.js --source <accounts.json> --db <auth.sqlite>
 * 安全：仅本地受控运维；不接触真实邮箱/服务器/发布链；不打印明文密码/token。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SqliteStore } = require('../auth-sqlite');

const MIGRATION_ID = '002-migrate-accounts-json';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function main() {
  const source = arg('--source');
  const dbPath = arg('--db');
  if (!source || !dbPath) {
    console.error(JSON.stringify({ ok: false, error: { code: 'missing-args', usage: '--source <accounts.json> --db <auth.sqlite>' } }));
    process.exit(2);
  }
  const sourceAbs = path.resolve(source);
  const dbAbs = path.resolve(dbPath);

  if (!fs.existsSync(sourceAbs)) {
    console.error(JSON.stringify({ ok: false, error: { code: 'source-missing' } }));
    process.exit(1);
  }

  let legacy;
  try { legacy = JSON.parse(fs.readFileSync(sourceAbs, 'utf8')); }
  catch (e) { console.error(JSON.stringify({ ok: false, error: { code: 'source-corrupt' } })); process.exit(1); }
  if (!legacy || typeof legacy !== 'object') { console.error(JSON.stringify({ ok: false, error: { code: 'source-corrupt' } })); process.exit(1); }

  const store = new SqliteStore({ dbFile: dbAbs });
  if (store.migrationApplied(MIGRATION_ID)) {
    console.log(JSON.stringify({ ok: true, idempotent: true, message: 'migration already applied' }));
    store.close();
    return;
  }

  // 预迁移备份（不删除源文件）
  const backupPath = sourceAbs + '.pre-migration-' + Date.now();
  try { fs.copyFileSync(sourceAbs, backupPath); } catch (e) { console.error(JSON.stringify({ ok: false, error: { code: 'backup-failed' } })); process.exit(1); }

  const migrated = { users: 0, accounts: 0, memberships: 0, sessionsDropped: 0, verificationsDropped: 0, audit: 0 };
  const nowIso = new Date().toISOString();

  try {
    store._transact(() => {
      const accounts = legacy.accounts || {};
      for (const email of Object.keys(accounts)) {
        const a = accounts[email] || {};
        const id = a.id || ('acct_' + crypto.randomBytes(8).toString('hex'));
        const salt = String(a.salt || '');
        const passwordHash = String(a.passwordHash || '');
        const password = (salt && passwordHash) ? (salt + ':' + passwordHash) : null;
        const createdAt = a.createdAt ? new Date(a.createdAt).toISOString() : nowIso;
        store.insert('user', { id, name: String(email).split('@')[0], email: String(email).toLowerCase(), emailVerified: a.verified ? 1 : 0, disabled: a.disabled ? 1 : 0, createdAt, updatedAt: nowIso });
        if (password) store.insert('account', { id: 'cred_' + crypto.randomBytes(8).toString('hex'), userId: id, accountId: id, providerId: 'credential', issuer: 'local:credential', password, createdAt, updatedAt: nowIso });
        migrated.users += 1; migrated.accounts += 1;
      }
      const membership = legacy.membership || {};
      for (const accountId of Object.keys(membership)) {
        store.setMembership(accountId, membership[accountId], { operator: 'migration', via: 'accounts-json' });
        migrated.memberships += 1;
      }
      migrated.sessionsDropped = Object.keys(legacy.sessions || {}).length;
      migrated.verificationsDropped = Object.keys(legacy.pendingVerifications || {}).length;
      const auditLog = Array.isArray(legacy.auditLog) ? legacy.auditLog : [];
      for (const entry of auditLog) {
        const id = 'audit_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
        store.db.prepare('INSERT INTO audit_log (id, at, action, accountId, tier, operator, via) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, entry.at || Date.now(), entry.action || 'legacy', entry.accountId || null, entry.tier || null, entry.operator || null, entry.via || null);
        migrated.audit += 1;
      }
    });
    store.recordMigration(MIGRATION_ID, sha256(fs.readFileSync(sourceAbs)));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: { code: 'migration-failed', message: String(e && e.message || e) } }));
    store.close();
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, migration: MIGRATION_ID, source: sourceAbs, backup: backupPath, db: dbAbs, migrated }));
  store.close();
}

main();
