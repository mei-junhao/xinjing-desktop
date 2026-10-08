'use strict';
/**
 * better-auth-config.js — Better Auth 实例装配（CJS 动态 import ESM）。
 * 负责：数据库适配器（node:sqlite）、email+password 密码学（scrypt，兼容旧 accounts.json）、
 * 邮件验证、受信源、secret。会话令牌为不透明 DB token，不经 JWT/COOKIE 暴露给渲染层。
 * 凭据安全：secret 优先取 BETTER_AUTH_SECRET，否则每进程随机；绝不写日志/交付物。
 */
const crypto = require('crypto');
const { createSqliteAdapter } = require('./better-auth-adapter');

// 与旧 accounts.json 完全一致的 scrypt 参数，保证旧密码 hash 可继续验证、不降级。
function scryptHex(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function randomHex(bytes) { return crypto.randomBytes(bytes).toString('hex'); }
function passwordHashSync(password) {
  const salt = randomHex(16);
  return salt + ':' + scryptHex(password, salt);
}
function verifyPasswordHash(hash, password) {
  if (typeof hash !== 'string') return false;
  const idx = hash.indexOf(':');
  if (idx <= 0) return false;
  const salt = hash.slice(0, idx);
  const expected = hash.slice(idx + 1);
  const a = Buffer.from(scryptHex(password, salt), 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const DEFAULT_PASSWORD_MAX = 1024;

async function _buildAuth(store, opts) {
  opts = opts || {};
  const { betterAuth } = await import('better-auth');
  const adapter = await createSqliteAdapter(store);
  const secret = process.env.BETTER_AUTH_SECRET || crypto.randomBytes(32).toString('hex');
  const baseURL = opts.baseURL || 'http://127.0.0.1:0';
  return betterAuth({
    baseURL,
    secret,
    trustedOrigins: opts.trustedOrigins || [baseURL],
    database: adapter,
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
      requireEmailVerification: true,
      minPasswordLength: 8,
      maxPasswordLength: opts.maxPasswordLength || DEFAULT_PASSWORD_MAX,
      password: {
        hash: async (password) => passwordHashSync(password),
        verify: async ({ hash, password }) => verifyPasswordHash(hash, password),
      },
    },
  });
}

// 每个 SqliteStore 一个 Better Auth 实例（实例与数据文件一一对应）。
function initBetterAuth(store, opts) {
  return _buildAuth(store, opts);
}

module.exports = { initBetterAuth, scryptHex, passwordHashSync, verifyPasswordHash, randomHex };
