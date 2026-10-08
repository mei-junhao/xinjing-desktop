'use strict';
/* account-client.js — 账号认证客户端契约（contract-v502-desktop-auth-session-membership-v1）。
 * 主进程（node http/https 注入传输）与 node 测试共享；渲染进程从不直接联网，只经 IPC。
 * fail-closed：网络失败/超时/未知字段/未知会员档一律 ok:false；调用方不得视为成功。
 * 安全：不打印密码/令牌；返回值只在受控字段内裁剪；会员投影必须携带 serverAuthoritative:true。
 */
(function (root, factory) {
  const exported = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root && typeof root === 'object') root.XJAccountClient = exported;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const VALID_TIERS = Object.freeze(['free', 'pro', 'flagship']);
  const ACCOUNT_ID_RE = /^acct_[A-Za-z0-9]{8,128}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const MAX_EMAIL_LEN = 254;
  const MAX_ERROR_CODE_LEN = 64;
  const MAX_BODY_CHARS = 256 * 1024;

  const KNOWN_ERROR_CODES = Object.freeze(new Set([
    'invalid-email', 'weak-password', 'email-taken',
    'email-delivery-failed', 'persistence-failed',
    'account-not-found', 'already-verified', 'account-disabled', 'resend-cooldown', 'no-prepared-resend',
    'invalid-token', 'token-not-found', 'token-expired', 'account-missing',
    'invalid-credentials', 'email-unverified',
    'no-session', 'session-not-found', 'session-expired', 'account-invalid', 'account-unverified', 'unknown-tier',
    'body-too-large', 'invalid-json', 'request-error', 'request-aborted', 'not-found',
  ]));

  const RETRYABLE_CODES = Object.freeze(new Set([
    'network-error', 'network-timeout', 'server-unavailable', 'email-delivery-failed', 'persistence-failed', 'resend-cooldown', 'rate-limited',
  ]));

  function failure(code, extra) {
    const normalized = String(code || 'unknown-error').slice(0, MAX_ERROR_CODE_LEN);
    return Object.freeze(Object.assign({ ok: false, error: { code: normalized, retryable: RETRYABLE_CODES.has(normalized) === true } }, extra || {}));
  }

  function parseBodySafely(bodyText) {
    if (typeof bodyText !== 'string' || !bodyText) return null;
    if (bodyText.length > MAX_BODY_CHARS) return null;
    try { return JSON.parse(bodyText); } catch (e) { return null; }
  }

  function transportFailure(status) {
    if (status === 0) return failure('network-error');
    if (status === 413) return failure('body-too-large');
    if (status === 429) return failure('rate-limited');
    if (status >= 500) return failure('server-unavailable');
    return failure('server-rejected', { status });
  }

  function normalizeErrorPayload(status, body) {
    if (body && body.ok === false && body.error && typeof body.error.code === 'string' && KNOWN_ERROR_CODES.has(body.error.code)) {
      const retryable = RETRYABLE_CODES.has(body.error.code) || status === 429 || status >= 500;
      const out = { ok: false, error: { code: body.error.code, retryable } };
      if (typeof body.error.retryAfterMs === 'number' && Number.isFinite(body.error.retryAfterMs) && body.error.retryAfterMs >= 0) {
        out.error.retryAfterMs = Math.min(Math.round(body.error.retryAfterMs), 24 * 3600 * 1000);
      }
      return out;
    }
    return transportFailure(status);
  }

  function cleanEmail(value) {
    if (typeof value !== 'string') return '';
    const email = value.trim().toLowerCase();
    if (email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) return '';
    return email;
  }

  function cleanAccountId(value) {
    if (typeof value !== 'string' || !ACCOUNT_ID_RE.test(value)) return '';
    return value;
  }

  function cleanTier(value) {
    return VALID_TIERS.indexOf(value) !== -1 ? value : '';
  }

  // 注册促销用机器码（可选字段）：16 位十六进制（xj-commercial-device-v1）；非法则省略（服务端不发放促销）。
  function cleanMachineCode(value) {
    if (typeof value !== 'string') return '';
    const mc = value.trim();
    if (mc.length < 8 || mc.length > 64 || !/^[A-Za-z0-9_-]+$/.test(mc)) return '';
    return mc;
  }

  function requireOkEnvelope(status, bodyText, shape) {
    if (status >= 200 && status < 300) {
      const body = parseBodySafely(bodyText);
      if (body && body.ok === true) return shape(body);
      if (body && body.ok === false) return normalizeErrorPayload(status, body);
      return failure('bad-response');
    }
    const body = parseBodySafely(bodyText);
    return normalizeErrorPayload(status, body);
  }

  function shapeAccountOnly(body) {
    const accountId = cleanAccountId(body.accountId);
    const email = cleanEmail(body.email);
    if (!accountId || !email) return failure('bad-response');
    return { ok: true, accountId, email };
  }

  function shapeSessionToken(body) {
    const accountId = cleanAccountId(body.accountId);
    const token = typeof body.sessionToken === 'string' ? body.sessionToken : '';
    const tier = cleanTier(body.tier);
    if (!accountId || token.length < 16 || token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token) || !tier) {
      return failure(!tier && accountId && token ? 'unknown-tier' : 'bad-response');
    }
    return { ok: true, accountId, sessionToken: token, tier };
  }

  function shapeSessionValidation(body) {
    const accountId = cleanAccountId(body.accountId);
    const email = cleanEmail(body.email);
    const tier = cleanTier(body.tier);
    if (!accountId || !email || !tier) return failure(!tier && accountId && email ? 'unknown-tier' : 'bad-response');
    return { ok: true, accountId, email, tier };
  }

  function shapeMembership(body) {
    const accountId = cleanAccountId(body.accountId);
    const tier = cleanTier(body.tier);
    if (!accountId || !tier) return failure(!tier && accountId ? 'unknown-tier' : 'bad-response');
    if (body.serverAuthoritative !== true) return failure('bad-membership-projection');
    return { ok: true, accountId, tier, serverAuthoritative: true };
  }

  function shapeRevoke(body) {
    if (body.revoked !== true && body.revoked !== false) return failure('bad-response');
    return { ok: true, revoked: body.revoked === true };
  }

  function validateCommonPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return failure('invalid-request');
    return null;
  }

  function createAccountClient(options) {
    const opts = options || {};
    const baseUrlRaw = String(opts.baseUrl || '').trim().replace(/\/+$/, '');
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Math.min(opts.timeoutMs, 60000) : 15000;
    let baseError = null;
    let parsedBase = null;
    try {
      parsedBase = new URL(baseUrlRaw);
    } catch (e) {
      baseError = 'endpoint-invalid';
    }
    if (!baseError) {
      const loopback = parsedBase.hostname === '127.0.0.1' || parsedBase.hostname === '::1' || parsedBase.hostname === 'localhost';
      const secureOk = parsedBase.protocol === 'https:' && !parsedBase.username && !parsedBase.password;
      const loopbackOk = parsedBase.protocol === 'http:' && loopback;
      if (!secureOk && !loopbackOk) baseError = 'endpoint-invalid';
    }
    if (typeof opts.request !== 'function') baseError = 'transport-missing';
    const request = opts.request;

    async function call(pathname, payload) {
      if (baseError) return failure(baseError);
      let bodyText = '';
      if (payload !== undefined) {
        try { bodyText = JSON.stringify(payload); } catch (e) { return failure('invalid-request'); }
      }
      if (Buffer.byteLength) {
        if (Buffer.byteLength(bodyText, 'utf8') > 64 * 1024) return failure('request-too-large');
      }
      const url = baseUrlRaw + pathname;
      let response;
      try {
        response = await request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: bodyText,
          timeoutMs,
        });
      } catch (error) {
        const code = error && (error.code === 'timeout' || error.code === 'ETIMEDOUT' || error.name === 'AbortError') ? 'network-timeout' : 'network-error';
        return failure(code);
      }
      if (!response || typeof response.status !== 'number') return failure('network-error');
      if (response.status === 408) return failure('network-timeout');
      return { status: response.status, bodyText: typeof response.bodyText === 'string' ? response.bodyText : '' };
    }

    return Object.freeze({
      baseUrl: baseUrlRaw,
      timeoutMs,
      async register(input) {
        const invalid = validateCommonPayload(input);
        if (invalid) return invalid;
        const email = cleanEmail(input.email);
        const password = typeof input.password === 'string' ? input.password : '';
        if (!email) return failure('invalid-email');
        if (password.length < 8 || password.length > 1024) return failure('weak-password');
        const registerPayload = { email, password };
        const machineCode = cleanMachineCode(input.machineCode);
        if (machineCode) registerPayload.machineCode = machineCode;
        const response = await call('/account/register', registerPayload);
        if (response.ok === false) return response;
        return requireOkEnvelope(response.status, response.bodyText, shapeAccountOnly);
      },
      async resend(input) {
        const invalid = validateCommonPayload(input);
        if (invalid) return invalid;
        const email = cleanEmail(input.email);
        if (!email) return failure('invalid-email');
        const response = await call('/account/resend', { email });
        if (response.ok === false) return response;
        return requireOkEnvelope(response.status, response.bodyText, shapeAccountOnly);
      },
      async forgotPassword(input) {
        const invalid = validateCommonPayload(input);
        if (invalid) return invalid;
        const email = cleanEmail(input.email);
        if (!email) return failure('invalid-email');
        const response = await call('/account/forgot-password', { email });
        if (response.ok === false) return response;
        return requireOkEnvelope(response.status, response.bodyText, shapeAccountOnly);
      },
      async resetPassword(input) {
        const invalid = validateCommonPayload(input);
        if (invalid) return invalid;
        const email = cleanEmail(input.email);
        const token = typeof input.token === 'string' ? input.token.trim() : '';
        const password = typeof input.password === 'string' ? input.password : '';
        if (!email) return failure('invalid-email');
        if (!/^[0-9]{6}$/.test(token)) return failure('invalid-token');
        if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return failure('weak-password');
        const response = await call('/account/reset-password', { email, token, password });
        if (response.ok === false) return response;
        return requireOkEnvelope(response.status, response.bodyText, shapeAccountOnly);
      },
      async verify(input) {
        const invalid = validateCommonPayload(input);
        if (invalid) return invalid;
        const token = typeof input.token === 'string' ? input.token.trim() : '';
        if (!/^[0-9]{6}$/.test(token)) return failure('invalid-token');
        const verifyPayload = { token };
        const machineCode = cleanMachineCode(input.machineCode);
        if (machineCode) verifyPayload.machineCode = machineCode;
        const response = await call('/account/verify', verifyPayload);
        if (response.ok === false) return response;
        return requireOkEnvelope(response.status, response.bodyText, shapeAccountOnly);
      },
      async login(input) {
        const invalid = validateCommonPayload(input);
        if (invalid) return invalid;
        const email = cleanEmail(input.email);
        const password = typeof input.password === 'string' ? input.password : '';
        if (!email) return failure('invalid-email');
        if (!password || password.length > 1024) return failure('invalid-credentials');
        const response = await call('/account/login', { email, password });
        if (response.ok === false) return response;
        return requireOkEnvelope(response.status, response.bodyText, shapeSessionToken);
      },
      async validateSession(token) {
        const value = typeof token === 'string' ? token : '';
        if (value.length < 16 || value.length > 512) return failure('no-session');
        const response = await call('/account/session', { sessionToken: value });
        if (response.ok === false) return response;
        return requireOkEnvelope(response.status, response.bodyText, shapeSessionValidation);
      },
      async revoke(token) {
        const value = typeof token === 'string' ? token : '';
        if (value.length < 16 || value.length > 512) return failure('no-session');
        const response = await call('/account/revoke', { sessionToken: value });
        if (response.ok === false) return response;
        return requireOkEnvelope(response.status, response.bodyText, shapeRevoke);
      },
      async membership(token) {
        const value = typeof token === 'string' ? token : '';
        if (value.length < 16 || value.length > 512) return failure('no-session');
        const response = await call('/account/membership', { sessionToken: value });
        if (response.ok === false) return response;
        return requireOkEnvelope(response.status, response.bodyText, shapeMembership);
      },
    });
  }

  return Object.freeze({
    createAccountClient,
    VALID_TIERS,
    KNOWN_ERROR_CODES,
    RETRYABLE_CODES,
    failure,
  });
});
