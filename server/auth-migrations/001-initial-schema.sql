-- 001-initial-schema.sql
-- Better Auth + SQLite 认证底座初始 schema（与 server/auth-sqlite.js _ensureSchema 保持一致）。
-- 主键 TEXT；布尔存 INTEGER(0/1)；日期存 ISO-8601 TEXT；复杂字段进 _json 溢出列。
-- membership 为服务器权威会员投影，独立于 Better Auth 身份/会话表。

CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  emailVerified INTEGER,
  image TEXT,
  createdAt TEXT,
  updatedAt TEXT,
  _json TEXT
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  userId TEXT,
  token TEXT,
  expiresAt TEXT,
  ipAddress TEXT,
  userAgent TEXT,
  createdAt TEXT,
  updatedAt TEXT,
  _json TEXT
);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  userId TEXT,
  accountId TEXT,
  providerId TEXT,
  issuer TEXT,
  password TEXT,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt TEXT,
  refreshTokenExpiresAt TEXT,
  scope TEXT,
  createdAt TEXT,
  updatedAt TEXT,
  _json TEXT
);

CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY,
  identifier TEXT,
  value TEXT,
  expiresAt TEXT,
  createdAt TEXT,
  updatedAt TEXT,
  _json TEXT
);

CREATE TABLE IF NOT EXISTS membership (
  accountId TEXT PRIMARY KEY,
  tier TEXT NOT NULL,
  updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  appliedAt TEXT NOT NULL,
  checksum TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  action TEXT,
  accountId TEXT,
  tier TEXT,
  operator TEXT,
  via TEXT
);
