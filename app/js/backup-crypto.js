'use strict';

// The renderer uses only sanitizeExportPayload. Node-side callers use the
// authenticated encryption functions through CommonJS; no key crosses this
// module's browser-facing surface.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('crypto'));
  } else {
    root.XJBackupCrypto = factory(null);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (nodeCrypto) {
  const FORMAT = 'xj-encrypted-backup';
  const FORMAT_VERSION = '1.0.0';
  const PASSPHRASE_MIN_LENGTH = 12;
  const PASSPHRASE_MAX_LENGTH = 4096;
  const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
  const SCRYPT = Object.freeze({ name: 'scrypt', version: 1, N: 16384, r: 8, p: 1 });
  const CIPHER = Object.freeze({ name: 'aes-256-gcm', version: 1, keyBytes: 32, nonceBytes: 12, tagBytes: 16 });
  const DEVICE_KDF = Object.freeze({ name: 'device-safe-storage', version: 1 });
  const PACKAGE_KEYS = Object.freeze(['format', 'formatVersion', 'kind', 'payloadVersion', 'createdAt', 'kdf', 'cipher', 'aad', 'ciphertext', 'authTag', 'payloadSha256']);
  const USER_EXPORT_KEYS = new Set(['version', 'exportedAt', 'clients', 'sessions', 'supervisions', 'supervisorIdentities', 'masterConversations', 'expenses', 'materialWorkspaces', 'clinicalActionRuns', 'clinicalTasks', 'importQuarantine', 'deletionBatches', 'deletionQuarantine']);
  const SNAPSHOT_KEYS = new Set(['version', 'kind', 'createdAt', 'files']);
  const SENSITIVE_SETTING_KEYS = new Set(['apiKey', 'accessToken', 'refreshToken', 'secret', 'password', 'token', 'privateKey', 'clientSecret']);

  function backupError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function requireNodeCrypto() {
    if (!nodeCrypto) throw backupError('XJ_BACKUP_CRYPTO_UNAVAILABLE');
    return nodeCrypto;
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function cloneJson(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { throw backupError('XJ_BACKUP_PAYLOAD_INVALID'); }
  }

  function sanitizeSettingsValue(value) {
    if (Array.isArray(value)) return value.map(sanitizeSettingsValue);
    if (!isPlainObject(value)) return value;
    const result = {};
    Object.keys(value).forEach((key) => {
      if (SENSITIVE_SETTING_KEYS.has(key)) return;
      result[key] = sanitizeSettingsValue(value[key]);
    });
    return result;
  }

  function sanitizeExportPayload(payload) {
    const copy = cloneJson(payload);
    if (!isPlainObject(copy) || !isPlainObject(copy.settings)) return copy;
    copy.settings = sanitizeSettingsValue(copy.settings);
    return copy;
  }

  function passphraseLength(value) {
    return typeof value === 'string' ? Array.from(value).length : 0;
  }

  function assertPassphrase(passphrase) {
    const length = passphraseLength(passphrase);
    if (length < PASSPHRASE_MIN_LENGTH || length > PASSPHRASE_MAX_LENGTH || !String(passphrase).trim()) {
      throw backupError('XJ_BACKUP_PASSPHRASE_TOO_SHORT');
    }
  }

  function assertPayloadSize(payloadText) {
    if (typeof payloadText !== 'string' || Buffer.byteLength(payloadText, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw backupError('XJ_BACKUP_PAYLOAD_TOO_LARGE');
    }
  }

  function normalizePayload(payloadText, options) {
    assertPayloadSize(payloadText);
    let parsed;
    try { parsed = JSON.parse(payloadText); } catch (_) { throw backupError('XJ_BACKUP_PAYLOAD_INVALID'); }
    if (!isPlainObject(parsed)) throw backupError('XJ_BACKUP_PAYLOAD_INVALID');
    const kind = options && options.kind ? String(options.kind) : 'user-export';
    const expectedVersion = options && options.payloadVersion ? String(options.payloadVersion) : (kind === 'user-export' ? '2.0.0' : '1.0.0');
    if (String(parsed.version || '') !== expectedVersion) throw backupError('XJ_BACKUP_PAYLOAD_INVALID');
    const allowed = kind === 'user-export' ? USER_EXPORT_KEYS : SNAPSHOT_KEYS;
    if (Object.keys(parsed).some((key) => !allowed.has(key))) throw backupError('XJ_BACKUP_PAYLOAD_INVALID');
    if (kind === 'user-data-snapshot' && String(parsed.kind || '') !== 'user-data-snapshot') {
      throw backupError('XJ_BACKUP_PAYLOAD_INVALID');
    }
    if (kind === 'user-data-snapshot') {
      if (!Array.isArray(parsed.files) || parsed.files.some((file) => !isPlainObject(file) || typeof file.path !== 'string' || !file.path || file.path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file.path) || file.path.split('/').includes('..') || typeof file.data !== 'string')) {
        throw backupError('XJ_BACKUP_PAYLOAD_INVALID');
      }
    }
    return JSON.stringify(kind === 'user-export' ? sanitizeExportPayload(parsed) : parsed);
  }

  function encodeBase64(value) {
    return Buffer.from(value).toString('base64');
  }

  function decodeBase64(value, code) {
    if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
      throw backupError(code || 'XJ_BACKUP_PACKAGE_INVALID');
    }
    const decoded = Buffer.from(value, 'base64');
    if (!decoded.length || decoded.toString('base64') !== value) throw backupError(code || 'XJ_BACKUP_PACKAGE_INVALID');
    return decoded;
  }

  function payloadHash(payloadText) {
    return requireNodeCrypto().createHash('sha256').update(payloadText, 'utf8').digest('hex');
  }

  function buildAad(kind, payloadVersion, createdAt) {
    return JSON.stringify({
      application: 'XinJing',
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      kind,
      payloadVersion,
      createdAt,
    });
  }

  function validateKdf(kdf, expectedName) {
    if (!isPlainObject(kdf) || kdf.name !== expectedName || kdf.version !== 1) throw backupError('XJ_BACKUP_PACKAGE_INVALID');
    if (expectedName === SCRYPT.name) {
      if (kdf.N !== SCRYPT.N || kdf.r !== SCRYPT.r || kdf.p !== SCRYPT.p) throw backupError('XJ_BACKUP_KDF_UNSUPPORTED');
      return decodeBase64(kdf.salt);
    }
    return null;
  }

  function parsePackage(packageText) {
    if (typeof packageText !== 'string' || Buffer.byteLength(packageText, 'utf8') > MAX_PAYLOAD_BYTES * 2) {
      throw backupError('XJ_BACKUP_PACKAGE_INVALID');
    }
    let pkg;
    try { pkg = JSON.parse(packageText); } catch (_) { throw backupError('XJ_BACKUP_PACKAGE_INVALID'); }
    if (!isPlainObject(pkg) || Object.keys(pkg).some((key) => !PACKAGE_KEYS.includes(key)) ||
        PACKAGE_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(pkg, key))) {
      throw backupError('XJ_BACKUP_PACKAGE_INVALID');
    }
    if (pkg.format !== FORMAT || pkg.formatVersion !== FORMAT_VERSION || typeof pkg.createdAt !== 'string' || pkg.createdAt.length > 80 ||
        (pkg.kind !== 'user-export' && pkg.kind !== 'user-data-snapshot') || typeof pkg.payloadVersion !== 'string') {
      throw backupError('XJ_BACKUP_PACKAGE_UNSUPPORTED');
    }
    const expectedPayloadVersion = pkg.kind === 'user-export' ? '2.0.0' : '1.0.0';
    if (pkg.payloadVersion !== expectedPayloadVersion) throw backupError('XJ_BACKUP_PACKAGE_UNSUPPORTED');
    if (!isPlainObject(pkg.cipher) || pkg.cipher.name !== CIPHER.name || pkg.cipher.version !== CIPHER.version) {
      throw backupError('XJ_BACKUP_CIPHER_UNSUPPORTED');
    }
    const nonce = decodeBase64(pkg.cipher.nonce);
    if (nonce.length !== CIPHER.nonceBytes) throw backupError('XJ_BACKUP_PACKAGE_INVALID');
    const authTag = decodeBase64(pkg.authTag);
    if (authTag.length !== CIPHER.tagBytes) throw backupError('XJ_BACKUP_PACKAGE_INVALID');
    const ciphertext = decodeBase64(pkg.ciphertext);
    if (!/^[0-9a-f]{64}$/.test(pkg.payloadSha256)) throw backupError('XJ_BACKUP_PACKAGE_INVALID');
    if (!isPlainObject(pkg.aad) || pkg.aad.application !== 'XinJing' || pkg.aad.format !== FORMAT ||
        pkg.aad.formatVersion !== FORMAT_VERSION || pkg.aad.kind !== pkg.kind || pkg.aad.payloadVersion !== pkg.payloadVersion || pkg.aad.createdAt !== pkg.createdAt) {
      throw backupError('XJ_BACKUP_PACKAGE_INVALID');
    }
    return { pkg, nonce, authTag, ciphertext, aad: Buffer.from(buildAad(pkg.kind, pkg.payloadVersion, pkg.createdAt), 'utf8') };
  }

  function deriveKey(passphrase, salt) {
    const crypto = requireNodeCrypto();
    const passphraseBytes = Buffer.from(passphrase, 'utf8');
    return new Promise((resolve, reject) => {
      crypto.scrypt(passphraseBytes, salt, CIPHER.keyBytes, {
        N: SCRYPT.N,
        r: SCRYPT.r,
        p: SCRYPT.p,
        maxmem: 64 * 1024 * 1024,
      }, (error, key) => {
        passphraseBytes.fill(0);
        if (error) reject(backupError('XJ_BACKUP_KDF_FAILED'));
        else resolve(key);
      });
    });
  }

  function encryptWithKey(payloadText, key, options) {
    const crypto = requireNodeCrypto();
    if (!Buffer.isBuffer(key) || key.length !== CIPHER.keyBytes) throw backupError('XJ_BACKUP_KEY_INVALID');
    const kind = options && options.kind ? String(options.kind) : 'user-export';
    const payloadVersion = options && options.payloadVersion ? String(options.payloadVersion) : (kind === 'user-export' ? '2.0.0' : '1.0.0');
    const normalized = normalizePayload(payloadText, { kind, payloadVersion });
    const createdAt = new Date().toISOString();
    const nonce = crypto.randomBytes(CIPHER.nonceBytes);
    const aad = Buffer.from(buildAad(kind, payloadVersion, createdAt), 'utf8');
    const cipher = crypto.createCipheriv(CIPHER.name, key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(normalized, 'utf8')), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return JSON.stringify({
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      kind,
      payloadVersion,
      createdAt,
      kdf: options && options.kdf ? options.kdf : DEVICE_KDF,
      cipher: { name: CIPHER.name, version: CIPHER.version, nonce: encodeBase64(nonce) },
      aad: JSON.parse(aad.toString('utf8')),
      ciphertext: encodeBase64(ciphertext),
      authTag: encodeBase64(authTag),
      payloadSha256: payloadHash(normalized),
    }, null, 2);
  }

  function decryptWithKey(packageText, key, expectedKdfName) {
    const crypto = requireNodeCrypto();
    const parsed = parsePackage(packageText);
    if (parsed.pkg.kind === 'user-export' && expectedKdfName === DEVICE_KDF.name) throw backupError('XJ_BACKUP_KDF_UNSUPPORTED');
    if (parsed.pkg.kind === 'user-data-snapshot' && expectedKdfName === SCRYPT.name) throw backupError('XJ_BACKUP_KDF_UNSUPPORTED');
    validateKdf(parsed.pkg.kdf, expectedKdfName);
    if (!Buffer.isBuffer(key) || key.length !== CIPHER.keyBytes) throw backupError('XJ_BACKUP_KEY_INVALID');
    try {
      const decipher = crypto.createDecipheriv(CIPHER.name, key, parsed.nonce);
      decipher.setAAD(parsed.aad);
      decipher.setAuthTag(parsed.authTag);
      const plaintext = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString('utf8');
      if (payloadHash(plaintext) !== parsed.pkg.payloadSha256) throw backupError('XJ_BACKUP_PAYLOAD_HASH_MISMATCH');
      normalizePayload(plaintext, { kind: parsed.pkg.kind, payloadVersion: parsed.pkg.payloadVersion });
      return normalizePayload(plaintext, { kind: parsed.pkg.kind, payloadVersion: parsed.pkg.payloadVersion });
    } catch (error) {
      if (error && error.code === 'XJ_BACKUP_PAYLOAD_HASH_MISMATCH') throw error;
      if (error && error.code === 'XJ_BACKUP_PAYLOAD_INVALID') throw error;
      throw backupError('XJ_BACKUP_AUTH_FAILED');
    }
  }

  async function encryptPayload(payloadText, passphrase, options) {
    assertPassphrase(passphrase);
    const crypto = requireNodeCrypto();
    const salt = crypto.randomBytes(16);
    const key = await deriveKey(passphrase, salt);
    try {
      return encryptWithKey(payloadText, key, Object.assign({}, options, { kdf: Object.assign({}, SCRYPT, { salt: encodeBase64(salt) }) }));
    } finally {
      key.fill(0);
    }
  }

  async function decryptPayload(packageText, passphrase) {
    assertPassphrase(passphrase);
    const parsed = parsePackage(packageText);
    const salt = validateKdf(parsed.pkg.kdf, SCRYPT.name);
    const key = await deriveKey(passphrase, salt);
    try { return decryptWithKey(packageText, key, SCRYPT.name); } finally { key.fill(0); }
  }

  function encryptPayloadWithKey(payloadText, key, options) {
    return encryptWithKey(payloadText, key, Object.assign({}, options, { kdf: DEVICE_KDF }));
  }

  function decryptPayloadWithKey(packageText, key) {
    return decryptWithKey(packageText, key, DEVICE_KDF.name);
  }

  function getPackageMeta(packageText) {
    const parsed = parsePackage(packageText);
    return {
      format: parsed.pkg.format,
      formatVersion: parsed.pkg.formatVersion,
      kind: parsed.pkg.kind,
      payloadVersion: parsed.pkg.payloadVersion,
      createdAt: parsed.pkg.createdAt,
      payloadSha256: parsed.pkg.payloadSha256,
      kdf: parsed.pkg.kdf.name,
    };
  }

  return {
    FORMAT,
    FORMAT_VERSION,
    PASSPHRASE_MIN_LENGTH,
    PASSPHRASE_MAX_LENGTH,
    MAX_PAYLOAD_BYTES,
    SCRYPT,
    CIPHER,
    DEVICE_KDF,
    sanitizeExportPayload,
    encryptPayload,
    decryptPayload,
    encryptPayloadWithKey,
    decryptPayloadWithKey,
    getPackageMeta,
  };
}));
