'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  dialog,
  ipcMain,
  net: electronNet,
  shell,
  safeStorage
} = require('electron');
// 2026-08-03 修复：本机 Chromium GPU 进程无法初始化（GPU process FATAL "isn't usable"）
// → 主进程启动即退出、窗口加载 net::ERR_FAILED。禁用硬件加速（软件渲染）根治此类环境。
// 对正常桌面用户无功能影响（表单类 UI 用软件渲染无感知差异）。
app.disableHardwareAcceleration();
const license = require('./license-core');
const entitlements = require('./app/js/entitlements');
const supervisionPackageCore = require('./supervision-package-core');
const recipientGrantBoundary = require('./app/js/recipient-grant-production-boundary.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const backupCrypto = require('./app/js/backup-crypto.js');
const { createCommercialFacade } = require('./app/js/commercial-ipc-facade.js');
const { normalizeServerBalance } = require('./app/js/server-balance-projection.js');
const { createPiProductionRuntime } = require('./app/js/pi/bridge/pi-production-runtime-v1.js');
const dns = require('dns').promises;
const nodeNet = require('net');
const { TextDecoder: NodeTextDecoder } = require('util');

// v3.6.7：资料库支持 .doc/.docx（mammoth 解析 docx；.doc 尽力抽取）
let mammoth = null;
try { mammoth = require('mammoth'); } catch (e) { mammoth = null; }

const CLINICAL_MATERIAL_EXTENSIONS = new Set(['.txt', '.md', '.docx']);
const CLINICAL_MATERIAL_MAX_BYTES = 20 * 1024 * 1024;
const CLINICAL_MATERIAL_MAX_CHARS = 1000000;
const clinicalMaterialSelections = new Map();

// v3.6.0：RAG 向量检索（JSON 向量存储降级方案，避免 ChromaDB 原生依赖打包问题）
let RagIndex = null;
let ragIndex = null;
let APP_PROXY_KEY = '';
try { APP_PROXY_KEY = require('./proxy-secret.generated').APP_PROXY_KEY || ''; } catch (e) { APP_PROXY_KEY = ''; }
try {
  RagIndex = require('./rag-index.js');
} catch (e) {
  console.warn('[rag] RagIndex module not available:', e.message);
}

// ---- API 密钥安全存储（H1 修复）：用 safeStorage 加密敏感凭据 ----
// safeStorage 基于 OS 密钥链（Windows DPAPI / macOS Keychain / Linux libsecret），
// 加密后数据仅当前用户/机器可解密。加密前缀 'xj-enc:' 标识已加密。
function encryptSecret(plain) {
  try {
    if (!plain || typeof plain !== 'string') return '';
    if (!safeStorage.isEncryptionAvailable()) return '';
    const buf = safeStorage.encryptString(plain);
    return 'xj-enc:' + buf.toString('base64');
  } catch (e) { return ''; }
}
function decryptSecret(stored) {
  try {
    if (!stored || typeof stored !== 'string' || !stored.startsWith('xj-enc:')) return stored;
    if (!safeStorage.isEncryptionAvailable()) return '';
    const buf = Buffer.from(stored.slice(7), 'base64');
    return safeStorage.decryptString(buf);
  } catch (e) { return ''; }
}

const AI_PROXY_BASE = 'https://xinjingchat.online/v1';
const AI_QUOTA_BASE = AI_PROXY_BASE.replace(/\/v1$/, '');
const AI_REQUEST_MAX_BYTES = 2 * 1024 * 1024;
const AI_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const AI_REDIRECT_LIMIT = 3;
const AI_REQUEST_TIMEOUT_MS = 120000;
const activeAiRequests = new Map();
let commercialFacadePromise = null;
let recipientGrantBoundaryPromise = null;

const RECIPIENT_GRANT_CHANNELS = Object.freeze({
  getProjection: 'xj:recipientGrant:getProjection',
  getAuditPage: 'xj:recipientGrant:getAuditPage',
});

// 受控督导技能包：只在主进程持有解密后的最小描述，渲染进程永远只收到脱敏元数据。
const SUPERVISION_PACKAGE_MAX_BYTES = supervisionPackageCore.DEFAULT_LIMITS.maxPackageBytes;
const supervisionPackageInspections = new Map();
const supervisionPackageRuntimeCache = new Map();
let supervisionDeviceIdentityCache = null;

function isPrivateNetworkAddress(address) {
  const value = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!value) return true;
  if (nodeNet.isIPv4(value)) {
    const parts = value.split('.').map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 0 && (parts[2] === 0 || parts[2] === 2)) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || (parts[1] === 51 && parts[2] === 100))) ||
      (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) ||
      (parts[0] >= 224);
  }
  if (nodeNet.isIPv6(value)) {
    const mappedDotted = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedDotted) return isPrivateNetworkAddress(mappedDotted[1]);
    const mappedHex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = parseInt(mappedHex[1], 16);
      const low = parseInt(mappedHex[2], 16);
      return isPrivateNetworkAddress([(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join('.'));
    }
    const first = parseInt(value.split(':')[0] || '0', 16);
    if (first < 0x2000 || first > 0x3fff) return true;
    if (/^2001:(?:0{0,3}0|db8)(?::|$)/.test(value) || /^2002(?::|$)/.test(value)) return true;
    return false;
  }
  return true;
}

async function validateAiDestination(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl || '')); } catch (e) { throw new Error('AI endpoint URL is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('AI endpoint must use HTTPS without URL credentials');
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) throw new Error('AI endpoint host is not allowed');
  if (nodeNet.isIP(hostname)) {
    if (isPrivateNetworkAddress(hostname)) throw new Error('AI endpoint resolves to a private address');
  } else {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((item) => isPrivateNetworkAddress(item.address))) {
      throw new Error('AI endpoint resolves to a private address');
    }
  }
  return parsed;
}

function isTrustedRendererEvent(event) {
  try {
    const frameUrl = new URL(event.senderFrame.url);
    return frameUrl.protocol === 'http:' && frameUrl.hostname === '127.0.0.1' && Number(frameUrl.port) === Number(PORT);
  } catch (e) { return false; }
}

function aiResponseHeaders(headers) {
  const allowed = ['content-type', 'x-quota-percent', 'x-quota-remaining', 'x-tier', 'x-quota-reset'];
  const result = {};
  allowed.forEach((name) => {
    const value = headers && headers.get ? headers.get(name) : null;
    if (value != null && value !== '') result[name] = String(value).slice(0, 512);
  });
  return result;
}

async function fetchAiWithRedirects(initialUrl, options, signal) {
  let current = await validateAiDestination(initialUrl);
  let currentOptions = Object.assign({}, options);
  for (let redirectCount = 0; redirectCount <= AI_REDIRECT_LIMIT; redirectCount++) {
    const response = await electronNet.fetch(current.toString(), Object.assign({}, currentOptions, { redirect: 'manual', signal }));
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location || redirectCount === AI_REDIRECT_LIMIT) throw new Error('AI endpoint redirect was rejected');
    const next = await validateAiDestination(new URL(location, current).toString());
    if (next.origin !== current.origin) throw new Error('AI endpoint cross-origin redirect was rejected');
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentOptions.method === 'POST')) {
      currentOptions = Object.assign({}, currentOptions, { method: 'GET' });
      delete currentOptions.body;
      currentOptions.headers = Object.assign({}, currentOptions.headers);
      delete currentOptions.headers['Content-Type'];
    }
    current = next;
  }
  throw new Error('AI endpoint redirect limit exceeded');
}

async function readAiResponse(response, onChunk) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > AI_RESPONSE_MAX_BYTES) throw new Error('AI response exceeded the size limit');
    if (onChunk) onChunk(text);
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new NodeTextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > AI_RESPONSE_MAX_BYTES) {
      try { await reader.cancel(); } catch (e) {}
      throw new Error('AI response exceeded the size limit');
    }
    const chunk = decoder.decode(part.value, { stream: true });
    text += chunk;
    if (onChunk) onChunk(chunk);
  }
  const tail = decoder.decode();
  if (tail) {
    text += tail;
    if (onChunk) onChunk(tail);
  }
  return text;
}

function normalizeAiRequestPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('AI request payload is invalid');
  const payloadKeys = Object.keys(payload);
  if (payloadKeys.some((key) => !['requestId', 'kind', 'config', 'body', 'streaming'].includes(key))) throw new Error('AI request payload contains unknown fields');
  const requestId = String(payload.requestId || '');
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(requestId)) throw new Error('AI request ID is invalid');
  const kind = payload.kind === 'quota' ? 'quota' : (payload.kind === 'chat' ? 'chat' : '');
  if (!kind) throw new Error('AI request kind is invalid');
  const config = payload.config && typeof payload.config === 'object' ? payload.config : {};
  if (Array.isArray(config) || Object.keys(config).some((key) => !['baseUrl', 'apiKey', 'model', 'isTrial'].includes(key))) {
    throw new Error('AI request config is invalid');
  }
  const isTrial = config.isTrial === true;
  const model = String(config.model || '').trim();
  if (kind === 'chat' && (!model || model.length > 200)) throw new Error('AI model is invalid');
  const rawBaseUrl = String(config.baseUrl || '').trim();
  if (rawBaseUrl.length > 2048) throw new Error('AI endpoint is invalid');
  let baseUrl = rawBaseUrl;
  if (kind === 'chat' && !isTrial) {
    let parsedBase;
    try { parsedBase = new URL(rawBaseUrl); } catch (e) { throw new Error('AI endpoint is invalid'); }
    if (parsedBase.protocol !== 'https:' || parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) {
      throw new Error('AI endpoint is invalid');
    }
    parsedBase.pathname = parsedBase.pathname.replace(/\/+$/, '');
    baseUrl = parsedBase.toString().replace(/\/$/, '');
  }
  const body = payload.body && typeof payload.body === 'object' && !Array.isArray(payload.body) ? payload.body : null;
  if (kind === 'chat' && !body) throw new Error('AI request body is invalid');
  if (kind === 'quota' && (body || payload.streaming === true || !isTrial)) throw new Error('AI quota request is invalid');
  if (kind === 'chat') {
    const bodyKeys = Object.keys(body);
    const allowedBodyKeys = ['model', 'messages', 'temperature', 'max_tokens', 'stream', 'chat_template_kwargs', 'tools', 'tool_choice'];
    if (bodyKeys.some((key) => !allowedBodyKeys.includes(key))) throw new Error('AI request body contains unknown fields');
    if (body.model !== model || (body.stream === true) !== (payload.streaming === true)) throw new Error('AI request body does not match its envelope');
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 400) throw new Error('AI message list is invalid');
    body.messages.forEach((message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message) || !['system', 'user', 'assistant', 'tool'].includes(message.role)) {
        throw new Error('AI message is invalid');
      }
    });
    if (typeof body.max_tokens !== 'number' || !Number.isFinite(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 131072) {
      throw new Error('AI token limit is invalid');
    }
    if (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2) {
      throw new Error('AI temperature is invalid');
    }
  }
  const bodyText = kind === 'chat' ? JSON.stringify(body) : '';
  if (Buffer.byteLength(bodyText, 'utf8') > AI_REQUEST_MAX_BYTES) throw new Error('AI request exceeded the size limit');
  const storedKey = String(config.apiKey || '');
  if (storedKey.length > 16384) throw new Error('AI credential is invalid');
  if (kind === 'chat' && isTrial && (baseUrl || storedKey)) throw new Error('Trial requests cannot supply endpoint credentials');
  if (kind === 'chat' && !isTrial && (!baseUrl || !storedKey)) throw new Error('BYOK request config is incomplete');
  const apiKey = isTrial ? APP_PROXY_KEY : decryptSecret(storedKey);
  if (/\r|\n|\0/.test(apiKey)) throw new Error('AI credential is invalid');
  return {
    requestId,
    kind,
    isTrial,
    model,
    baseUrl: isTrial ? AI_PROXY_BASE : baseUrl,
    apiKey,
    bodyText,
    streaming: payload.streaming === true,
  };
}

function commercialDeviceBinding() {
  return crypto.createHash('sha256')
    .update('xj-commercial-device-v1:' + getMachineCode())
    .digest('hex');
}

// 商业 IPC 的设备和授权摘要只由主进程生成。渲染层可以提交业务事件，
// 但不能伪造设备绑定、签名有效性、授权主体或撤销 epoch。
function trustedCommercialContext() {
  const state = licenseState || computeState();
  const revocationEpoch = Number.isSafeInteger(state.revocationVersion) && state.revocationVersion >= 0 ? state.revocationVersion : 0;
  const signatureValid = state.activated === true && state.revocationValid === true;
  return {
    deviceBindingHash: commercialDeviceBinding(),
    revocationEpoch,
    signedEvidence: {
      signatureValid,
      clockValid: Number.isSafeInteger(Date.now()),
      subscriptionId: signatureValid && state.licenseId ? state.licenseId : '',
      tier: state.tier || 'free',
      revocationEpoch,
    },
  };
}

async function ensureCommercialFacade() {
  if (!commercialFacadePromise) {
    commercialFacadePromise = createCommercialFacade({
      filePath: path.join(userDataDir(), 'commercial-envelope-v3.json'),
      deviceId: commercialDeviceBinding(),
      trustedReconciliation: false,
      trustedContextProvider: trustedCommercialContext,
    });
    commercialFacadePromise.catch(() => { commercialFacadePromise = null; });
  }
  return commercialFacadePromise;
}

async function ensureRecipientGrantBoundary() {
  if (!recipientGrantBoundaryPromise) {
    recipientGrantBoundaryPromise = (async () => {
      const repository = recipientGrantBoundary.createDurableRecipientGrantRepository({
        filePath: path.join(userDataDir(), 'recipient-grant-evidence-v1.json'),
      });
      await repository.initialize();
      return recipientGrantBoundary.createRecipientGrantBoundary({
        repository,
        entitlements,
        xjsupCore: supervisionPackageCore,
      });
    })();
    recipientGrantBoundaryPromise.catch(() => { recipientGrantBoundaryPromise = null; });
  }
  return recipientGrantBoundaryPromise;
}

function recipientGrantFailure(errorCode) {
  return Object.freeze({
    ok: false,
    errorCode: String(errorCode || 'recipient-grant-failed'),
    freeManualAllowed: true,
  });
}

function registerRecipientGrantIpc(targetIpcMain, options) {
  const target = targetIpcMain || ipcMain;
  const input = options || {};
  const boundaryProvider = input.boundaryProvider || ensureRecipientGrantBoundary;
  const trustedEvent = input.isTrustedEvent || isTrustedRendererEvent;
  Object.entries(RECIPIENT_GRANT_CHANNELS).forEach(([method, channel]) => {
    target.handle(channel, async (event, payload) => {
      if (!trustedEvent(event)) return recipientGrantFailure('untrusted-renderer');
      try {
        const boundary = await boundaryProvider();
        const api = boundary.publicApi();
        if (typeof api[method] !== 'function') return recipientGrantFailure('unsupported-operation');
        return await api[method](payload);
      } catch (error) {
        return recipientGrantFailure(error && (error.errorCode || error.code));
      }
    });
  });
  return Object.freeze({ channels: RECIPIENT_GRANT_CHANNELS });
}

function commercialFailure(errorCode) {
  return { ok: false, errorCode: errorCode || 'durable-read-failed', retryable: false };
}

function normalizeServerModelCatalog(body) {
  // Production 031+ returns the catalog envelope directly; older loopback
  // fixtures wrapped it in `value`. Accept both without weakening validation.
  if (!body || body.ok !== true) return null;
  const value = body && body.value && typeof body.value === 'object' ? body.value : body;
  if (!value || typeof value !== 'object' || !Array.isArray(value.models)) return null;
  const models = value.models.filter((entry) => entry && typeof entry === 'object' && entry.fallbackOnly !== true)
    .map((entry) => ({
      modelId: typeof entry.modelId === 'string' ? entry.modelId : '',
      displayName: typeof entry.displayName === 'string' ? entry.displayName : '',
      provider: typeof entry.provider === 'string' ? entry.provider : '',
      upstreamModel: typeof entry.upstreamModel === 'string' ? entry.upstreamModel : '',
      aliases: Array.isArray(entry.aliases) ? entry.aliases.filter((v) => typeof v === 'string').slice(0, 16) : [],
      inputPrice: Number.isFinite(Number(entry.inputPrice)) ? Number(entry.inputPrice) : 0,
      outputPrice: Number.isFinite(Number(entry.outputPrice)) ? Number(entry.outputPrice) : 0,
      cachedInputPrice: entry.cachedInputPrice == null ? null : Number(entry.cachedInputPrice),
      currency: typeof entry.currency === 'string' ? entry.currency : 'USD',
      billingUnit: typeof entry.billingUnit === 'string' ? entry.billingUnit : 'per-1M-tokens',
      catalogRevision: typeof entry.catalogRevision === 'string' ? entry.catalogRevision : '',
      capabilities: entry.capabilities && typeof entry.capabilities === 'object' ? {
        chat: entry.capabilities.chat === true,
        streaming: entry.capabilities.streaming === true,
        tools: entry.capabilities.tools === true,
        contextTokens: Number.isFinite(Number(entry.capabilities.contextTokens)) ? Number(entry.capabilities.contextTokens) : 0,
      } : { chat: true, streaming: false, tools: false, contextTokens: 0 },
    }))
    .filter((entry) => entry.modelId && entry.displayName && entry.catalogRevision);
  if (!models.length || typeof value.catalogRevision !== 'string' || !value.catalogRevision) return null;
  return {
    schemaVersion: Number(value.schemaVersion) || 1,
    catalogRevision: value.catalogRevision,
    settlementCurrency: typeof value.settlementCurrency === 'string' ? value.settlementCurrency : 'CNY',
    fxRateUsdToCny: Number.isFinite(Number(value.fxRateUsdToCny)) ? Number(value.fxRateUsdToCny) : 7,
    billingUnit: typeof value.billingUnit === 'string' ? value.billingUnit : 'per-1M-tokens',
    models,
  };
}

async function readServerModelCatalog(payload) {
  if (!isEmptyCommercialReadPayload(payload)) return commercialFailure('invalid-request');
  if (!ACCOUNT_API_BASE) return commercialFailure('server-model-catalog-unavailable');
  try {
    const machineCode = getMachineCode();
    if (!machineCode) return commercialFailure('server-model-catalog-unavailable');
    const sessionToken = authenticatedAccountSessionToken();
    if (!sessionToken) return commercialFailure('server-model-catalog-unavailable');
    const response = await accountNodeRequest(ACCOUNT_API_BASE + '/account/model-catalog', {
      method: 'GET',
      // Account routes must receive the account session as Authorization. The
      // proxy key is intentionally not used here because older deployments
      // interpret Authorization before X-Account-Session.
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + sessionToken,
        'X-Account-Session': sessionToken,
        'X-Machine-Id': machineCode,
      },
      body: '',
      timeoutMs: ACCOUNT_REQUEST_TIMEOUT_MS,
    });
    if (!response || response.status < 200 || response.status >= 300) return commercialFailure('server-model-catalog-unavailable');
    let body;
    try { body = JSON.parse(response.bodyText || ''); } catch (_) { return commercialFailure('server-model-catalog-unavailable'); }
    const value = normalizeServerModelCatalog(body);
    return value ? { ok: true, value, revision: null, idempotent: false } : commercialFailure('server-model-catalog-unavailable');
  } catch (_) {
    return commercialFailure('server-model-catalog-unavailable');
  }
}

function isEmptyCommercialReadPayload(payload) {
  if (payload === undefined || payload === null) return true;
  return typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 0;
}

async function handleCommercialChannel(method, event, payload) {
  if (!isTrustedRendererEvent(event)) return commercialFailure('sensitive-field-rejected');
  if (method === 'getServerModelCatalog') return readServerModelCatalog(payload);
  if (method === 'getModelPriceCatalog') {
    if (!isEmptyCommercialReadPayload(payload)) return commercialFailure('invalid-request');
    return { ok: true, value: {}, revision: null, idempotent: false };
  }
  if (method === 'getAccountBalance') return readServerAccountBalance(payload);
  try {
    const facade = await ensureCommercialFacade();
    return await facade[method](payload);
  } catch (error) {
    return commercialFailure(error && error.errorCode);
  }
}

async function readServerAccountBalance(payload) {
  if (!isEmptyCommercialReadPayload(payload)) return commercialFailure('invalid-request');
  const sessionToken = authenticatedAccountSessionToken();
  if (!ACCOUNT_API_BASE || !sessionToken) return commercialFailure('server-balance-unavailable');
  try {
    const response = await accountNodeRequest(ACCOUNT_API_BASE + '/account/balance', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + sessionToken,
        'X-Account-Session': sessionToken,
      },
      body: '{}',
      timeoutMs: ACCOUNT_REQUEST_TIMEOUT_MS,
    });
    if (!response || response.status < 200 || response.status >= 300) return commercialFailure('server-balance-unavailable');
    let body;
    try { body = JSON.parse(response.bodyText || ''); } catch (_) { return commercialFailure('server-balance-unavailable'); }
    const value = normalizeServerBalance(body, new Date().toISOString());
    return value ? { ok: true, value, revision: null, idempotent: false } : commercialFailure('server-balance-unavailable');
  } catch (_) {
    return commercialFailure('server-balance-unavailable');
  }
}

async function processCommercialAiRequest(request) {
  if (!request || request.kind !== 'chat') return null;
  const mode = request.isTrial ? 'trial' : 'byok';
  try {
    const facade = await ensureCommercialFacade();
    const result = await facade.processNonMoneyRequest({
      billingMode: mode,
      operationId: 'commercial-' + request.requestId,
    });
    if (!result || result.ok !== true) {
      return { ok: false, errorCode: result && result.errorCode || 'durable-write-failed' };
    }
    return { ok: true, billing: result.value, revision: result.revision };
  } catch (error) {
    return { ok: false, errorCode: error && error.errorCode || 'durable-read-failed' };
  }
}

function aiResponseRequiresAccountSession(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText) return false;
  let payload = null;
  try { payload = JSON.parse(bodyText); } catch (e) { payload = null; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const values = [payload.error, payload.code, payload.message]
    .map((value) => typeof value === 'string' ? value.toLowerCase() : '')
    .filter(Boolean);
  return values.some((value) => value === 'account-session-required' || value.includes('account-session-required'));
}

function authenticatedAccountSessionToken() {
  const value = typeof accountSessionToken === 'string' ? accountSessionToken : '';
  return accountSessionState.status === 'authenticated'
    && value.length >= ACCOUNT_TOKEN_MIN_LEN
    && value.length <= ACCOUNT_TOKEN_MAX_LEN
    ? value
    : '';
}

function builtInServiceHeaders(baseHeaders) {
  const headers = Object.assign({}, baseHeaders || {});
  if (APP_PROXY_KEY) headers.Authorization = 'Bearer ' + APP_PROXY_KEY;
  const sessionToken = authenticatedAccountSessionToken();
  if (sessionToken) headers['X-Account-Session'] = sessionToken;
  return headers;
}

async function handleAiRequest(event, payload) {
  if (!isTrustedRendererEvent(event)) return { ok: false, error: { code: 'XJ_IPC_SENDER_DENIED', message: 'AI request sender was rejected' } };
  let request;
  try { request = normalizeAiRequestPayload(payload); } catch (e) {
    return { ok: false, error: { code: 'XJ_AI_REQUEST_INVALID', message: e.message } };
  }
  if (request.isTrial && !APP_PROXY_KEY && !authenticatedAccountSessionToken()) {
    return { ok: false, error: { code: 'XJ_AI_ACCOUNT_SESSION_REQUIRED', message: '账号会话已失效或未登录，请重新登录后重试' } };
  }
  if (!request.isTrial && !request.apiKey) return { ok: false, error: { code: 'XJ_AI_CREDENTIAL_MISSING', message: 'AI credential is unavailable' } };
  const commercial = await processCommercialAiRequest(request);
  if (commercial && commercial.ok !== true) {
    return { ok: false, error: { code: 'XJ_COMMERCIAL_' + commercial.errorCode.toUpperCase().replace(/[^A-Z0-9_]/g, '_'), message: 'Commercial request state is unavailable' } };
  }
  if (activeAiRequests.has(request.requestId)) return { ok: false, error: { code: 'XJ_AI_REQUEST_DUPLICATE', message: 'AI request ID is already active' } };
  const activeForSender = Array.from(activeAiRequests.values()).filter((item) => item.senderId === event.sender.id).length;
  if (activeForSender >= 4) return { ok: false, error: { code: 'XJ_AI_REQUEST_LIMIT', message: 'Too many AI requests are active' } };
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, AI_REQUEST_TIMEOUT_MS);
  activeAiRequests.set(request.requestId, { controller, senderId: event.sender.id });
  try {
    let url;
    let options;
    if (request.kind === 'quota') {
      const machineCode = getMachineCode();
      url = AI_QUOTA_BASE + '/quota?mid=' + encodeURIComponent(machineCode);
      const headers = builtInServiceHeaders({ Accept: 'application/json', 'X-Machine-Id': machineCode });
      options = { method: 'GET', headers };
    } else {
      url = request.baseUrl.replace(/\/$/, '') + '/chat/completions';
      let headers = { 'Content-Type': 'application/json' };
      if (request.isTrial) {
        headers = builtInServiceHeaders(headers);
        headers['X-Machine-Id'] = getMachineCode();
      } else {
        headers.Authorization = 'Bearer ' + request.apiKey;
      }
      options = { method: 'POST', headers, body: request.bodyText };
    }
    const response = await fetchAiWithRedirects(url, options, controller.signal);
    const responseType = response.headers.get('content-type') || '';
    const shouldStream = request.streaming && response.ok && /text\/event-stream/i.test(responseType);
    const bodyText = await readAiResponse(response, shouldStream ? (chunk) => {
      if (!event.sender.isDestroyed()) event.sender.send('xj:ai-chunk', { requestId: request.requestId, chunk });
    } : null);
    const headers = aiResponseHeaders(response.headers);
    if (!response.ok) {
      let code = 'XJ_AI_PROVIDER_HTTP';
      let message = 'AI provider rejected the request';
      if (request.isTrial && aiResponseRequiresAccountSession(bodyText)) {
        code = 'XJ_AI_ACCOUNT_SESSION_REQUIRED';
        message = '账号会话已失效或未登录，请重新登录后重试';
      } else if (response.status === 401 || response.status === 403) {
        code = 'XJ_AI_AUTH_FAILED';
        message = 'AI credential was rejected';
      } else if (response.status === 429) {
        code = 'XJ_AI_RATE_LIMIT';
        message = 'AI request limit was reached';
      } else if (response.status === 400 && /tool|function_call|function-calling|tools/i.test(bodyText)) {
        code = 'XJ_AI_TOOLS_UNSUPPORTED';
        message = 'AI model rejected tool calling';
      }
      return { ok: false, status: response.status, headers, bodyText: '', error: { code, message } };
    }
    return { ok: true, status: response.status, headers, bodyText: shouldStream ? '' : bodyText, commercial: commercial || undefined };
  } catch (e) {
    const aborted = controller.signal.aborted || (e && e.name === 'AbortError');
    return {
      ok: false,
      error: {
        code: timedOut ? 'XJ_AI_TIMEOUT' : (aborted ? 'ABORT_ERR' : 'XJ_AI_NETWORK_FAILED'),
        message: timedOut ? 'AI request timed out' : (aborted ? 'AI request was cancelled' : 'AI network request failed'),
      },
      commercial: commercial || undefined,
    };
  } finally {
    clearTimeout(timeout);
    activeAiRequests.delete(request.requestId);
  }
}

function applyWindowSecurity(windowRef) {
  if (!windowRef || !windowRef.webContents) return;
  const allowedOrigin = () => 'http://127.0.0.1:' + PORT;
  windowRef.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      if (new URL(targetUrl).origin !== allowedOrigin()) event.preventDefault();
    } catch (e) { event.preventDefault(); }
  });
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowRef.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

// ---- v5.0.2 桌面强制登录门禁 + 账号会话（contract-v502-desktop-auth-session-membership-v1）----
// 原则：
//  - 未登录不得进入业务路由：主进程 webRequest 对 mainFrame 强制重定向 account.html（渲染层无法绕过）。
//  - session token 只存主进程：safeStorage 加密落盘（xj-enc:），绝不出现在渲染进程、日志或交付物中。
//  - 会员投影以服务器为唯一权威：网络失败、未知账号/档位、缺 serverAuthoritative 一律 fail-closed，不得视为成功。
//  - 凭据/验证码/token 永不写日志（只记录错误码）。
const XJAccountClientModule = require('./app/js/account-client.js');
const ACCOUNT_REQUEST_TIMEOUT_MS = 15000;
const ACCOUNT_RESPONSE_MAX_BYTES = 256 * 1024;
const ACCOUNT_TOKEN_MIN_LEN = 16;
const ACCOUNT_TOKEN_MAX_LEN = 512;
const ACCOUNT_REVOKE_TIMEOUT_MS = 3000;
const ACCOUNT_NAV_TIMEOUT_MS = 5000;

function resolveAccountApiBase() {
  const override = String(process.env.XJ_ACCOUNT_API_BASE || '').trim();
  if (process.env.XJ_AGENT_ACCEPTANCE === '1' || process.env.XJ463_HEALTH_PROBE === '1') {
    if (!override) return '';
    try {
      const parsed = new URL(override);
      const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === 'localhost';
      if (parsed.protocol === 'http:' && loopback && !parsed.username && !parsed.password) {
        return override.replace(/\/+$/, '');
      }
    } catch (e) { /* fail-closed */ }
    return '';
  }
  const candidate = override || AI_QUOTA_BASE;
  try {
    const parsed = new URL(candidate);
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === 'localhost';
    const secureOk = parsed.protocol === 'https:' && !parsed.username && !parsed.password;
    const loopbackOk = parsed.protocol === 'http:' && loopback;
    if (secureOk || loopbackOk) return candidate.replace(/\/+$/, '');
  } catch (e) { /* fail-closed */ }
  return '';
}
const ACCOUNT_API_BASE = resolveAccountApiBase();

function accountNodeRequest(url, options) {
  // node http/https 传输：独立于渲染进程 session 的默认拒网；硬超时、体积上限、拒绝重定向。
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { const err = new Error('endpoint-invalid'); err.code = 'network-error'; reject(err); return; }
    if (process.env.XJ_AGENT_ACCEPTANCE === '1' || process.env.XJ463_HEALTH_PROBE === '1') {
      const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === 'localhost';
      if (parsed.protocol !== 'http:' || !loopback) {
        const err = new Error('acceptance-network-denied');
        err.code = 'network-error';
        reject(err);
        return;
      }
    }
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    const body = typeof options.body === 'string' ? options.body : '';
    const headers = Object.assign({}, options.headers || {});
    headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
    const req = lib.request({
      method: options.method || 'POST',
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers,
      timeout: Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : ACCOUNT_REQUEST_TIMEOUT_MS,
      rejectUnauthorized: parsed.protocol === 'https:',
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        const err = new Error('redirect-rejected'); err.code = 'network-error';
        res.destroy(err);
        return;
      }
      res.setEncoding('utf8');
      let text = '';
      let overflow = false;
      res.on('data', (chunk) => {
        if (overflow) return;
        text += chunk;
        if (text.length > ACCOUNT_RESPONSE_MAX_BYTES) { overflow = true; text = ''; res.destroy(new Error('response-too-large')); }
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, bodyText: overflow ? '' : text }));
      res.on('error', (error) => reject(error));
    });
    req.on('timeout', () => { const err = new Error('request-timeout'); err.code = 'timeout'; req.destroy(err); });
    req.on('error', (error) => reject(error));
    if (body) req.write(body);
    req.end();
  });
}

function createMainAccountClient() {
  return XJAccountClientModule.createAccountClient({
    baseUrl: ACCOUNT_API_BASE,
    request: accountNodeRequest,
    timeoutMs: ACCOUNT_REQUEST_TIMEOUT_MS,
  });
}

const accountSessionState = {
  status: 'anonymous', // anonymous | restoring | authenticated
  account: null,
  membership: null,
  lastError: null,
};
let accountSessionToken = '';
let accountLastLogout = null;
let accountBootstrapPromise = null;

function accountSessionFile() { return path.join(userDataDir(), 'account-session-v1.json'); }

async function loadPersistedAccountToken() {
  const f = accountSessionFile();
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
  if (!parsed || parsed.version !== 1 || typeof parsed.tokenEnc !== 'string') return null;
  const accountId = /^[A-Za-z0-9_-]{4,140}$/.test(String(parsed.accountId || '')) ? String(parsed.accountId) : '';
  const email = typeof parsed.email === 'string' && parsed.email.length <= 254 ? parsed.email : '';
  // safeStorage 后端在 app ready 后仍可能短暂未就绪（DPAPI 密钥加载竞态），
  // 解密瞬时失败时做有界重试，避免「有已保存会话却因启动时序回退到登录页」。
  for (let attempt = 0; attempt < 12; attempt++) {
    const token = decryptSecret(parsed.tokenEnc);
    if (token && token.length >= ACCOUNT_TOKEN_MIN_LEN && token.length <= ACCOUNT_TOKEN_MAX_LEN) {
      return { token, accountId, email };
    }
    if (attempt < 11) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function persistAccountSession(token, account) {
  try {
    const tokenEnc = encryptSecret(token);
    if (!tokenEnc) return false; // safeStorage 不可用：fail-closed，不落盘明文
    const payload = {
      version: 1,
      tokenEnc,
      accountId: (account && account.accountId) || '',
      email: (account && account.email) || '',
      savedAt: new Date().toISOString(),
    };
    const file = accountSessionFile();
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { return false; }
}

function clearPersistedAccountSession() {
  try { fs.unlinkSync(accountSessionFile()); } catch (e) { /* 不存在即视为已清除 */ }
}

function accountMembershipErrorProjection(code) {
  return { status: 'error', errorCode: String(code || 'membership-unavailable').slice(0, 64), serverAuthoritative: false, fetchedAt: new Date().toISOString() };
}

function accountMembershipOkProjection(result) {
  return { status: 'ok', tier: result.tier, accountId: result.accountId, serverAuthoritative: true, fetchedAt: new Date().toISOString() };
}

async function fetchAuthoritativeMembership(token) {
  try {
    const result = await createMainAccountClient().membership(token);
    if (!result || result.ok !== true) return accountMembershipErrorProjection(result && result.error ? result.error.code : 'membership-unavailable');
    return accountMembershipOkProjection(result);
  } catch (e) {
    return accountMembershipErrorProjection('membership-unavailable');
  }
}

function sanitizedAccountStatus(extra) {
  return Object.freeze(Object.assign({
    authenticated: accountSessionState.status === 'authenticated',
    status: accountSessionState.status,
    account: accountSessionState.account ? { accountId: accountSessionState.account.accountId, email: accountSessionState.account.email } : null,
    membership: accountSessionState.membership || null,
    lastError: accountSessionState.lastError || null,
    lastLogout: accountLastLogout || null,
  }, extra || {}));
}

function broadcastAccountChanged(reason) {
  const payload = sanitizedAccountStatus({ reason: String(reason || 'changed').slice(0, 32) });
  [mainWindow, activationWindow].forEach((win) => {
    try { if (win && !win.isDestroyed()) win.webContents.send('xj:account:changed', payload); } catch (e) { /* 窗口竞争销毁时忽略 */ }
  });
}

function applyAuthenticatedSession(token, account) {
  accountSessionToken = String(token || '');
  accountSessionState.status = 'authenticated';
  accountSessionState.account = { accountId: String(account.accountId || ''), email: String(account.email || '') };
  accountSessionState.lastError = null;
  accountLastLogout = null;
  persistAccountSession(accountSessionToken, accountSessionState.account);
}

function resetAccountSession(reason) {
  accountSessionToken = '';
  accountSessionState.status = 'anonymous';
  accountSessionState.account = null;
  accountSessionState.membership = null;
  accountSessionState.lastError = reason || null;
  clearPersistedAccountSession();
}

async function bootstrapAccountSession() {
  if (accountSessionState.status === 'authenticated') return sanitizedAccountStatus();
  accountSessionState.status = 'restoring';
  const persisted = await loadPersistedAccountToken();
  if (!persisted) {
    accountSessionState.status = 'anonymous';
    return sanitizedAccountStatus({ restore: 'none' });
  }
  let validation = null;
  try {
    validation = await createMainAccountClient().validateSession(persisted.token);
  } catch (e) {
    validation = null;
  }
  if (!validation || validation.ok !== true) {
    const code = validation && validation.error ? validation.error.code : 'session-restore-failed';
    // 鉴权类失败（会话不存在/过期/禁用/未验证/未知档位）清除本地会话；
    // 纯网络类失败保持已保存会话以便网络恢复后重试，但本次启动仍 fail-closed 拒绝进入。
    const networkOnly = new Set(['network-error', 'network-timeout', 'server-unavailable', 'endpoint-invalid', 'account-unavailable', 'bad-response']);
    if (networkOnly.has(code)) {
      accountSessionToken = '';
      accountSessionState.status = 'anonymous';
      accountSessionState.account = null;
      accountSessionState.membership = null;
      accountSessionState.lastError = code;
    } else {
      resetAccountSession(code);
    }
    return sanitizedAccountStatus({ restore: 'failed' });
  }
  applyAuthenticatedSession(persisted.token, { accountId: validation.accountId, email: validation.email });
  accountSessionState.membership = await fetchAuthoritativeMembership(persisted.token);
  broadcastAccountChanged('session-restored');
  return sanitizedAccountStatus({ restore: 'ok' });
}

function accountGatePageUrl() { return `http://127.0.0.1:${PORT}/account.html`; }

// 未登录时 mainFrame 一律强制回到账号页（退出确认弹窗除外，保证仍能退出应用）。
function accountGateAllowedPage(page) {
  return page === 'account.html' || page === 'confirm-close.html';
}

function unifiedRequestGate(details, callback) {
  if (AGENT_ACCEPTANCE_MODE && !isAgentAcceptanceLoopbackUrl(details.url)) {
    callback({ cancel: true });
    return;
  }
  if (details.resourceType === 'mainFrame' && accountSessionState.status !== 'authenticated') {
    try {
      const parsed = new URL(details.url);
      if (parsed.origin === `http://127.0.0.1:${PORT}` && !accountGateAllowedPage(parsed.pathname.replace(/^\/+/, ''))) {
        callback({ redirectURL: accountGatePageUrl() });
        return;
      }
    } catch (e) { /* 非法 URL 交给默认行为 */ }
  }
  callback({});
}

function accountUntrustedFailure() {
  return { ok: false, error: { code: 'untrusted-renderer', retryable: false } };
}

function accountInvalidRequestFailure() {
  return { ok: false, error: { code: 'invalid-request', retryable: false } };
}

async function handleAccountBootstrap(event) {
  if (!isTrustedRendererEvent(event)) return accountUntrustedFailure();
  if (accountSessionState.status === 'authenticated') return sanitizedAccountStatus();
  if (!accountBootstrapPromise) {
    accountBootstrapPromise = bootstrapAccountSession();
    accountBootstrapPromise.catch(() => {}).finally(() => { accountBootstrapPromise = null; });
  }
  return accountBootstrapPromise;
}

async function handleAccountRegister(event, payload) {
  if (!isTrustedRendererEvent(event)) return accountUntrustedFailure();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return accountInvalidRequestFailure();
  let result = null;
  try {
    result = await createMainAccountClient().register({ email: payload.email, password: payload.password });
  } catch (e) { result = null; }
  if (!result || result.ok !== true) return result || { ok: false, error: { code: 'account-unavailable', retryable: true } };
  return { ok: true, accountId: result.accountId, email: result.email };
}

async function handleAccountResend(event, payload) {
  if (!isTrustedRendererEvent(event)) return accountUntrustedFailure();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return accountInvalidRequestFailure();
  let result = null;
  try {
    result = await createMainAccountClient().resend({ email: payload.email });
  } catch (e) { result = null; }
  if (!result || result.ok !== true) return result || { ok: false, error: { code: 'account-unavailable', retryable: true } };
  return { ok: true, accountId: result.accountId, email: result.email };
}

async function handleAccountVerify(event, payload) {
  if (!isTrustedRendererEvent(event)) return accountUntrustedFailure();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return accountInvalidRequestFailure();
  let result = null;
  try {
    result = await createMainAccountClient().verify({ token: payload.token });
  } catch (e) { result = null; }
  if (!result || result.ok !== true) return result || { ok: false, error: { code: 'account-unavailable', retryable: true } };
  return { ok: true, accountId: result.accountId, email: result.email };
}

async function handleAccountForgotPassword(event, payload) {
  if (!isTrustedRendererEvent(event)) return accountUntrustedFailure();
  const email = String(payload && payload.email || '').trim().toLowerCase();
  if (!email) return accountInvalidRequestFailure();
  let result = null;
  try {
    result = await createMainAccountClient().forgotPassword({ email });
  } catch (e) { result = null; }
  if (!result || result.ok !== true) return result || { ok: false, error: { code: 'account-unavailable', retryable: true } };
  return { ok: true, accountId: result.accountId, email: result.email };
}

async function handleAccountResetPassword(event, payload) {
  if (!isTrustedRendererEvent(event)) return accountUntrustedFailure();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return accountInvalidRequestFailure();
  const email = String(payload.email || '').trim().toLowerCase();
  const token = String(payload.token || '');
  const password = String(payload.password || '');
  if (!email || !token || !password) return accountInvalidRequestFailure();
  let result = null;
  try {
    result = await createMainAccountClient().resetPassword({ email, token, password });
  } catch (e) { result = null; }
  if (!result || result.ok !== true) return result || { ok: false, error: { code: 'account-unavailable', retryable: true } };
  return { ok: true, accountId: result.accountId, email: result.email };
}

async function handleAccountLogin(event, payload) {
  if (!isTrustedRendererEvent(event)) return accountUntrustedFailure();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return accountInvalidRequestFailure();
  let result = null;
  try {
    result = await createMainAccountClient().login({ email: payload.email, password: payload.password });
  } catch (e) { result = null; }
  if (!result || result.ok !== true) return result || { ok: false, error: { code: 'account-unavailable', retryable: true } };
  const email = String(payload.email || '').trim().toLowerCase();
  applyAuthenticatedSession(result.sessionToken, { accountId: result.accountId, email });
  accountSessionState.membership = await fetchAuthoritativeMembership(result.sessionToken);
  broadcastAccountChanged('login');
  return sanitizedAccountStatus({ login: true, ok: true });
}

function withAccountBoundedWait(promise, timeoutMs, code) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(code);
        err.code = code;
        reject(err);
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }),
  ]);
}

async function revokeAccountSession(token) {
  if (!token) return { ok: false, error: { code: 'no-session', retryable: false } };
  try {
    const result = await withAccountBoundedWait(createMainAccountClient().revoke(token), ACCOUNT_REVOKE_TIMEOUT_MS, 'revoke-timeout');
    if (!result || result.ok !== true) {
      return { ok: false, error: (result && result.error) || { code: 'revoke-failed', retryable: true } };
    }
    return { ok: true, revoked: result.revoked === true };
  } catch (e) {
    const code = e && e.code === 'revoke-timeout' ? 'revoke-timeout' : 'revoke-failed';
    return { ok: false, error: { code, retryable: code === 'revoke-timeout' } };
  }
}

async function navigateToAccountGateBounded() {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: { code: 'navigation-failed', retryable: false } };
  try {
    await withAccountBoundedWait(mainWindow.loadURL(accountGatePageUrl()), ACCOUNT_NAV_TIMEOUT_MS, 'navigation-timeout');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { code: e && e.code === 'navigation-timeout' ? 'navigation-timeout' : 'navigation-failed', retryable: true } };
  }
}

async function handleAccountLogout(event) {
  if (!isTrustedRendererEvent(event)) return accountUntrustedFailure();
  const token = accountSessionToken;
  // 1) fail-closed 先清本地：内存 token + 加密会话文件立即失效，绝不因远端状态悬挂。
  resetAccountSession('logged-out');
  broadcastAccountChanged('logout');
  // 2) 有界等待撤销服务端会话；失败/超时不吞掉，随返回值上报。
  const revoke = await revokeAccountSession(token);
  // 3) 可靠导航到 account.html；导航失败也要回报，不在 renderer 悬挂。
  const navigation = await navigateToAccountGateBounded();
  // 记录最近一次登出结果（revoke/navigation 均不泄漏 token），供 status 观测，便于测试断言不被吞掉。
  accountLastLogout = Object.freeze({ revoke, navigation, at: new Date().toISOString() });
  return { ok: true, localCleared: true, revoke, navigation };
}

function handleAccountStatus(event) {
  if (!isTrustedRendererEvent(event)) return accountUntrustedFailure();
  return sanitizedAccountStatus();
}

async function handleAccountRefreshMembership(event) {
  if (!isTrustedRendererEvent(event)) return accountUntrustedFailure();
  if (accountSessionState.status !== 'authenticated' || !accountSessionToken) {
    return { ok: false, error: { code: 'no-session', retryable: false } };
  }
  accountSessionState.membership = await fetchAuthoritativeMembership(accountSessionToken);
  broadcastAccountChanged('membership-refreshed');
  const projection = accountSessionState.membership;
  if (!projection || projection.status !== 'ok') {
    return { ok: false, error: { code: projection ? projection.errorCode : 'membership-unavailable', retryable: true }, membership: projection };
  }
  return { ok: true, membership: projection };
}

app.setName('XinJing'); // 用户数据目录固定为 .../XinJing/，稳定存放试用与激活信息

// ---- XJ463 首启健康探针消费端（P1-2）：仅当更新健康适配器以 XJ463_HEALTH_PROBE=1
// 启动本进程时进入探针分支；正常启动永不进入探针，探针也永不进入正常应用流程。
// 探针使用临时 userData（--user-data-dir，位于系统临时目录）、合成数据、默认拒网，
// 全链通过后原子写出完整 health marker 并以退出码 0 结束（见 app/update/health-probe/）。
if (process.env.XJ463_HEALTH_PROBE === '1') {
  require('./app/update/health-probe/probe-main').runHealthProbe();
  return;
}

const AGENT_ACCEPTANCE_MODE = process.env.XJ_AGENT_ACCEPTANCE === '1';
const AGENT_ACCEPTANCE_CLOSE_DIALOG = AGENT_ACCEPTANCE_MODE && process.env.XJ_AGENT_ACCEPTANCE_CLOSE_DIALOG === '1';

function resolveAgentAcceptanceUserData() {
  const requested = String(process.env.XJ_AGENT_ACCEPTANCE_USER_DATA || '').trim();
  if (!requested || !path.isAbsolute(requested)) {
    throw new Error('XJ_AGENT_ACCEPTANCE_USER_DATA must be an absolute temporary directory');
  }
  let tempRoot;
  let resolved;
  try {
    // Windows may supply TEMP as an 8.3 path while Node resolves os.tmpdir()
    // to its long form. Canonicalize both sides before enforcing containment.
    tempRoot = fs.realpathSync.native(path.resolve(os.tmpdir()));
    resolved = fs.realpathSync.native(path.resolve(requested));
  } catch (e) {
    throw new Error('XJ_AGENT_ACCEPTANCE_USER_DATA must be an existing temporary directory');
  }
  if (resolved === tempRoot || !resolved.startsWith(tempRoot + path.sep)) {
    throw new Error('XJ_AGENT_ACCEPTANCE_USER_DATA must stay inside the system temporary directory');
  }
  return resolved;
}
const AGENT_ACCEPTANCE_USER_DATA = AGENT_ACCEPTANCE_MODE ? resolveAgentAcceptanceUserData() : null;

function allowAgentAcceptanceWindowExit() {
  if (AGENT_ACCEPTANCE_MODE) {
    allowAppQuit('agent-acceptance-window-close');
    return;
  }
}

// ---- 显式固定 userData 路径（防御性）----
// 早期 1.0 构建未调用 app.setName，userData 会落到 package.json 的 name（小写 xinjing），
// 与当前 .../XinJing（大写）是两个不同目录 → 旧 exe 读到空目录 = “历史记录丢失 + 像回到了 1.0”。
// 这里用字面量强制锁定同一目录，杜绝因 setName/name 差异导致的数据“消失”。
const CANON_USER_DATA = AGENT_ACCEPTANCE_MODE ? AGENT_ACCEPTANCE_USER_DATA : path.join(app.getPath('appData'), 'XinJing');
try {
  fs.mkdirSync(CANON_USER_DATA, { recursive: true });
  app.setPath('userData', CANON_USER_DATA);
} catch (e) { console.error('[userData] setPath failed:', (e && e.message) || e); }

// ---- 旧目录数据迁移：把早期构建落在其他 userData 目录的历史数据合并回标准目录 ----
// 直接恢复因目录不一致而“看不见”的来访者/会话/督导记录（不覆盖当前已有的激活与机器信息）。
function migrateLegacyUserData() {
  try {
    const appData = app.getPath('appData');
    const canonIdb = path.join(CANON_USER_DATA, 'IndexedDB');
    const canonHasData = fs.existsSync(canonIdb) && fs.readdirSync(canonIdb).length > 0;
    // 候选旧目录（早期构建可能用过的名称，均位于 LOCALAPPDATA 下）
    const candidates = ['xinjing', 'XinJingDesktop', 'xinjing-desktop', '心镜 XinJing', 'xinjing-app', 'XinJingApp', 'xinjing-electron'];
    let best = null, bestSize = -1;
    for (const c of candidates) {
      const p = path.join(appData, c);
      if (p === CANON_USER_DATA || !fs.existsSync(p)) continue;
      const idb = path.join(p, 'IndexedDB');
      if (!fs.existsSync(idb)) continue;
      let size = 0;
      try { size = fs.readdirSync(idb).length; } catch (e) { size = 0; }
      if (size > bestSize) { bestSize = size; best = p; }
    }
    if (best && !canonHasData) {
      // 只合并“用户数据”相关条目，且不覆盖当前目录已有文件（保护激活/机器标记）
      const items = ['IndexedDB', 'Local Storage', 'license.json', 'machine.json', 'trial.json'];
      for (const f of items) {
        const src = path.join(best, f);
        if (!fs.existsSync(src)) continue;
        const dst = path.join(CANON_USER_DATA, f);
        if (fs.existsSync(dst)) continue; // 不覆盖当前已有
        try { fs.cpSync(src, dst, { recursive: true }); } catch (e) { console.error('[userData] copy', f, 'failed:', (e && e.message) || e); }
      }
      fs.writeFileSync(path.join(CANON_USER_DATA, 'data-migrated.json'),
        JSON.stringify({ from: best, at: new Date().toISOString() }));
      console.log('[userData] 已从旧目录恢复数据:', best);
    } else {
      const flag = path.join(CANON_USER_DATA, 'data-migrated.json');
      if (fs.existsSync(flag)) fs.unlinkSync(flag);
    }
  } catch (e) { console.error('[userData] migrate failed:', (e && e.message) || e); }
}
if (!AGENT_ACCEPTANCE_MODE) migrateLegacyUserData();

// ---- 空库异常检测：本机曾有使用记录但标准目录 IndexedDB 为空且无旧目录可迁移 ----
// 判定为真实数据丢失，写标记供启动时告警（指向文档/心镜备份 恢复）。
function checkDataAnomaly() {
  try {
    const canonIdb = path.join(CANON_USER_DATA, 'IndexedDB');
    const hasIdb = fs.existsSync(canonIdb) && fs.readdirSync(canonIdb).length > 0;
    const priorUse = fs.existsSync(path.join(CANON_USER_DATA, 'machine.json')) ||
                     fs.existsSync(path.join(CANON_USER_DATA, 'trial.json')) ||
                     fs.existsSync(path.join(CANON_USER_DATA, 'license.json'));
    const migrated = fs.existsSync(path.join(CANON_USER_DATA, 'data-migrated.json'));
    const flag = path.join(CANON_USER_DATA, 'data-anomaly.json');
    if (priorUse && !hasIdb && !migrated) {
      fs.writeFileSync(flag, JSON.stringify({ at: new Date().toISOString(), msg: '本机曾有使用记录但历史数据目录为空，可能数据丢失或落在其他目录' }));
    } else if (fs.existsSync(flag)) {
      fs.unlinkSync(flag);
    }
  } catch (e) { /* ignore */ }
}
if (!AGENT_ACCEPTANCE_MODE) checkDataAnomaly();

// ---- IndexedDB 端口碎片自愈合并（核心修复）----
// 根因：前端经本地 http 服务加载，浏览器 IndexedDB/localStorage 按 origin(含端口) 隔离。
// 【已废弃】早期曾尝试在主进程直接复制 leveldb 目录跨 origin 合并（consolidateIndexedDB），
// 但 Chromium 的 IndexedDB 在 leveldb 内部用 database id 索引数据，跨 origin 复制后 id 不匹配，
// 引擎会当成损坏/不匹配而重建空库 —— 文件复制成功却读不出数据。
// 真正有效的迁移改为「渲染进程 IndexedDB API 级」：主进程在旧端口临时起同源服务，
// 渲染进程用隐藏 iframe 在旧 origin 上下文读出数据，再写入当前 origin（见 store.js migrateOldPorts）。

const APP_DIR = path.join(__dirname, 'app');
const BUILD_DIR = path.join(__dirname, 'build');
// M7 修复补充：以 APP_DIR 自身的真实路径为基准（APP_DIR 自身可能是软链接，
// 若直接拿字符串 APP_DIR 比较，realpathSync(resolved) 会因前缀不匹配而全部 403）。
let APP_DIR_REAL = APP_DIR;
try { APP_DIR_REAL = fs.realpathSync(APP_DIR); } catch (e) { APP_DIR_REAL = APP_DIR; }

// ---- 单实例锁：避免开多个心镜窗口；隔离验收使用独立临时 userData，必须允许并行实例 ----
if (!AGENT_ACCEPTANCE_MODE && !app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

let mainWindow = null;
let tray = null;
let server = null;
let legacyMigrateServers = [];
let PORT = 0;
let activationWindow = null;
let closeConfirmWin = null;
let applicationMenu = null;
let windowMenuItem = null;
const windowMenuBound = new WeakSet();
let windowMenuListenersInstalled = false;
let piProductionRuntime = null;
let licenseState = null; // {mode, identity, daysLeft, activated, trialDays, version}
let lastQuitBackupAt = 0;

function allowAppQuit(reason) {
  app.isQuiting = true;
  app.quitReason = reason || 'manual';
  if (closeConfirmWin) {
    try { closeConfirmWin.close(); } catch (_) {}
    closeConfirmWin = null;
  }
}

function backupBeforeQuit() {
  if (AGENT_ACCEPTANCE_MODE) return true;
  const options = arguments[0] || {};
  const forceSnapshot = !!(options && options.forceSnapshot);
  // app.quit() emits before-quit again after prepareAppQuit has already
  // completed. Do not create a second timestamped snapshot during that
  // re-entrant event; the first verified package is the authoritative one.
  if (app.isQuiting) return true;
  const now = Date.now();
  // Multiple Electron/updater quit events can arrive in one shutdown sequence.
  // A forced "保存并退出" must still create a fresh snapshot even when a
  // background/update backup ran moments earlier.
  if (!forceSnapshot && now - lastQuitBackupAt < 10000) return true;
  const targets = exportBackup({ forceSnapshot });
  if (!Array.isArray(targets) || targets.length === 0) return false;
  lastQuitBackupAt = now;
  return true;
}

function prepareAppQuit(reason) {
  if (!backupBeforeQuit({ forceSnapshot: reason === 'confirm-quit' })) {
    try {
      dialog.showErrorBox('退出前备份失败', '未能创建新的数据备份，心镜将保持打开。请检查“文档\\心镜备份”是否可写后重试。');
    } catch (_) {}
    return false;
  }
  allowAppQuit(reason);
  return true;
}

// ---- 授权与试用状态 ----
function userDataDir() { return app.getPath('userData'); }

// 读取备份配置（渲染进程通过 IPC 写入 userData/backup-config.json）
function loadBackupConfig() {
  try {
    const p = path.join(userDataDir(), 'backup-config.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (e) { /* ignore */ }
  return { locations: [], email: '', emailEnabled: false };
}

const BACKUP_IGNORED_TOP_LEVEL = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'old_DawnGraphiteCache_000',
  'old_DawnWebGPUCache_000',
  'old_GPUCache_000',
  'Shared Dictionary',
  'Network',
  'Session Storage',
  'SharedStorage',
  'WebStorage',
  'blob_storage',
  'DIPS',
  'DevToolsActivePort',
  'lockfile',
  // 更新完整性目录由它自己的加密快照/回滚链管理；其中的暂存安装包和
  // 正在使用的回滚文件不是用户业务数据，退出时也可能被更新器锁定。
  'update-integrity',
  'backup-key.json',
  'backup-config.json',
  'backup-meta.json',
  'backup-restore-safety.xjbackup'
]);

// Chromium/更新器在运行期间会创建这些锁与单例文件。它们既不是业务数据，
// 也无法在 Windows 上稳定读取；把它们打进退出快照会让一次正常退出变成
// XJ_BACKUP_SOURCE_READ_FAILED。只在已知运行时目录内按文件名过滤，其他业务
// 文件（即使恰好叫 LOCK）仍保持 fail-closed。
const BACKUP_IGNORED_ENTRY_NAMES = new Set([
  'LOCK',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
]);
const BACKUP_RUNTIME_LOCK_ROOTS = new Set([
  'IndexedDB',
  'Local Storage',
  'Session Storage',
  'Network',
  'Service Worker',
  'Storage',
]);

function isIgnoredBackupPath(relative, entryName) {
  const parts = String(relative || '').split(path.sep).filter(Boolean);
  if (!parts.length || BACKUP_IGNORED_TOP_LEVEL.has(parts[0])) return true;
  const name = String(entryName || '');
  if (!BACKUP_IGNORED_ENTRY_NAMES.has(name)) return false;
  // Chromium's singleton markers are always runtime bookkeeping, even when
  // they sit directly under userData. A generic LOCK is ignored only inside
  // the known LevelDB/runtime roots so a legitimate business file named LOCK
  // is never silently removed from the snapshot.
  if (name !== 'LOCK') return true;
  return BACKUP_RUNTIME_LOCK_ROOTS.has(parts[0]);
}

const BACKUP_DATA_KEY_FILE = 'backup-key.json';
const BACKUP_SAFETY_FILE = 'backup-restore-safety.xjbackup';
const BACKUP_LATEST_FILE = '最新.xjbackup';
const BACKUP_ERROR_CODES = new Set([
  'XJ_BACKUP_SENDER_DENIED',
  'XJ_BACKUP_PACKAGE_INVALID',
  'XJ_BACKUP_PACKAGE_UNSUPPORTED',
  'XJ_BACKUP_CIPHER_UNSUPPORTED',
  'XJ_BACKUP_KDF_UNSUPPORTED',
  'XJ_BACKUP_KDF_FAILED',
  'XJ_BACKUP_AUTH_FAILED',
  'XJ_BACKUP_PAYLOAD_HASH_MISMATCH',
  'XJ_BACKUP_PAYLOAD_INVALID',
  'XJ_BACKUP_PAYLOAD_TOO_LARGE',
  'XJ_BACKUP_PASSPHRASE_TOO_SHORT',
  'XJ_BACKUP_CRYPTO_UNAVAILABLE',
  'XJ_BACKUP_KEY_INVALID',
  'XJ_BACKUP_SAFETY_WRITE_FAILED',
  'XJ_BACKUP_WRITE_FAILED',
  'XJ_BACKUP_SOURCE_READ_FAILED',
  'XJ_BACKUP_READBACK_FAILED',
  'XJ_BACKUP_LOCATION_UNAVAILABLE',
]);

function safeBackupErrorCode(error, fallback) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return BACKUP_ERROR_CODES.has(code) ? code : (fallback || 'XJ_BACKUP_PACKAGE_INVALID');
}

function atomicWriteUtf8(target, content) {
  const temp = target + '.tmp-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const previous = target + '.previous-' + process.pid + '-' + Date.now();
  let movedPrevious = false;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
    // Windows FlushFileBuffers requires a writable handle; a read-only handle
    // makes fsyncSync fail with EPERM and would reject every backup write.
    const fd = fs.openSync(temp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fs.existsSync(target)) {
      fs.renameSync(target, previous);
      movedPrevious = true;
    }
    fs.renameSync(temp, target);
    if (movedPrevious) {
      try { fs.unlinkSync(previous); } catch (_) {}
    }
  } catch (error) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
    if (movedPrevious && !fs.existsSync(target)) {
      try { fs.renameSync(previous, target); } catch (_) {}
    }
    throw error;
  }
}

function loadOrCreateBackupDataKey() {
  try {
    const file = path.join(userDataDir(), BACKUP_DATA_KEY_FILE);
    if (fs.existsSync(file)) {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (record && record.version === 1 && typeof record.encryptedKey === 'string' && record.encryptedKey.startsWith('xj-enc:')) {
        const decoded = Buffer.from(decryptSecret(record.encryptedKey) || '', 'base64');
        if (decoded.length === 32) return decoded;
      }
    }
    if (!safeStorage.isEncryptionAvailable()) return null;
    const key = crypto.randomBytes(32);
    const encryptedKey = encryptSecret(key.toString('base64'));
    if (!encryptedKey) { key.fill(0); return null; }
    atomicWriteUtf8(file, JSON.stringify({ version: 1, encryptedKey }));
    return key;
  } catch (_) {
    return null;
  }
}

function collectUserDataSnapshot(src) {
  const files = [];
  function sourceReadError() {
    const error = new Error('XJ_BACKUP_SOURCE_READ_FAILED');
    error.code = 'XJ_BACKUP_SOURCE_READ_FAILED';
    return error;
  }
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { throw sourceReadError(); }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(src, full);
      if (!relative || isIgnoredBackupPath(relative, entry.name)) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        let bytes;
        try { bytes = fs.readFileSync(full); } catch (_) { throw sourceReadError(); }
        files.push({ path: relative.split(path.sep).join('/'), data: bytes.toString('base64') });
      }
    }
  }
  walk(src);
  return files;
}

function buildDeviceBackupPayload(src) {
  return JSON.stringify({
    version: '1.0.0',
    kind: 'user-data-snapshot',
    createdAt: new Date().toISOString(),
    files: collectUserDataSnapshot(src),
  });
}

function readBackupPayloadHash(file) {
  try {
    return backupCrypto.getPackageMeta(fs.readFileSync(file, 'utf8')).payloadSha256 || '';
  } catch (_) { return ''; }
}

// v3.8.2 智能增量备份参数
const BACKUP_MAX_SNAPSHOTS = 7;                       // 历史快照最多保留份数（超出删最旧）
const BACKUP_SNAPSHOT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 历史快照最小间隔：1 天
const BACKUP_LATEST_DIR = '最新';                     // 固定增量目录名（滚动镜像，磁盘恒定≈单份）

function copyUserDataBackup(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (entry) => {
      const relative = path.relative(src, entry);
      if (!relative) return true;
      return !isIgnoredBackupPath(relative, path.basename(entry));
    }
  });
}

// v3.8.2 文件级「近似指纹」：size + 前 1MB sha256（避免读大文件全文，又快又稳）
function backupFileQuickHash(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    const h = crypto.createHash('sha256');
    h.update(String(st.size));
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(Math.min(1024 * 1024, st.size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    h.update(buf.subarray(0, n));
    fs.closeSync(fd);
    return h.digest('hex');
  } catch (e) { return null; }
}

// v3.8.2 文件级差异复制（rsync 式增量）：把 src 镜像同步到 dest。
// 仅复制变化的文件、删除 src 已不存在的文件；未变化的文件直接跳过。
// 返回 { changed, copied, removed }。磁盘占用恒定≈单份，杜绝整目录复制导致的数 GB 冗余。
function syncBackupDir(src, dest) {
  const ignored = (rel) => isIgnoredBackupPath(rel, path.basename(rel));
  const srcFiles = new Map(); // rel -> full
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      const rel = path.relative(src, full);
      if (!rel || ignored(rel)) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) srcFiles.set(rel, full);
    }
  })(src);

  const destFiles = new Set();
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      const rel = path.relative(dest, full);
      if (!rel || ignored(rel)) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) destFiles.add(rel);
    }
  })(dest);

  let changed = false, copied = 0, removed = 0;
  for (const [rel, full] of srcFiles) {
    const destFull = path.join(dest, rel);
    let needCopy = true;
    if (destFiles.has(rel)) {
      try {
        const dst = fs.statSync(destFull);
        if (dst.size === fs.statSync(full).size) {
          const a = backupFileQuickHash(full), b = backupFileQuickHash(destFull);
          if (a && b && a === b) needCopy = false; // 内容相同，跳过
        }
      } catch (e) { needCopy = true; }
    }
    if (needCopy) {
      try {
        fs.mkdirSync(path.dirname(destFull), { recursive: true });
        fs.copyFileSync(full, destFull);
        copied++; changed = true;
      } catch (e) { console.error('[backup] copy failed', rel, (e && e.message) || e); }
    }
    destFiles.delete(rel);
  }
  for (const rel of destFiles) {
    const destFull = path.join(dest, rel);
    try {
      const st = fs.statSync(destFull);
      if (st.isDirectory()) fs.rmSync(destFull, { recursive: true, force: true });
      else fs.unlinkSync(destFull);
      removed++; changed = true;
    } catch (e) { /* ignore */ }
  }
  return { changed, copied, removed };
}

// v3.8.2 智能增量备份：每位置维护固定「最新」目录（文件级差异复制，磁盘恒定≈单份），
// 仅当数据确有变化且距上次快照≥1天时才复制一份带时间戳历史快照（最多保留 7 份），
// 彻底消除「每次整目录复制导致数GB 相同内容冗余备份」。
function exportBackup(options) {
  let key = null;
  try {
    const forceSnapshot = !!(options && options.forceSnapshot);
    const src = userDataDir();
    key = loadOrCreateBackupDataKey();
    if (!key) {
      console.error('[backup] XJ_BACKUP_KEY_UNAVAILABLE');
      return null;
    }
    // 先完整扫描并序列化源目录；扫描失败时不碰任何目标位置，避免把旧备份删成半份。
    const payload = buildDeviceBackupPayload(src);
    const packageText = backupCrypto.encryptPayloadWithKey(payload, key, {
      kind: 'user-data-snapshot',
      payloadVersion: '1.0.0',
    });
    const payloadSha256 = backupCrypto.getPackageMeta(packageText).payloadSha256;
    const cfg = loadBackupConfig();
    const targets = [];
    const now = Date.now();

    function doLocation(rootDir) {
      fs.mkdirSync(rootDir, { recursive: true });
      const locationTargets = [];
      const writeVerifiedPackage = (target) => {
        atomicWriteUtf8(target, packageText);
        if (readBackupPayloadHash(target) !== payloadSha256) {
          const readback = new Error('XJ_BACKUP_READBACK_FAILED');
          readback.code = 'XJ_BACKUP_READBACK_FAILED';
          throw readback;
        }
        locationTargets.push(target);
      };
      const latest = path.join(rootDir, BACKUP_LATEST_FILE);
      const previousHash = readBackupPayloadHash(latest);
      const changed = previousHash !== payloadSha256;
      if (changed || !fs.existsSync(latest)) {
        try {
          writeVerifiedPackage(latest);
        } catch (latestError) {
          // Windows may keep the old “最新” file open (antivirus, sync
          // client, or an interrupted previous shutdown). A fresh immutable
          // package is still a valid quit backup; do not discard it merely
          // because the rolling pointer cannot be replaced right now.
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const suffix = process.pid + '-' + crypto.randomBytes(3).toString('hex');
          const fallback = path.join(rootDir, 'XinJing-' + ts + '-' + suffix + '.xjbackup');
          try {
            writeVerifiedPackage(fallback);
          } catch (fallbackError) {
            fallbackError.cause = latestError;
            throw fallbackError;
          }
        }
      } else {
        // Existing bytes were parsed above and already match the current
        // payload hash; retain the path as a valid target.
        locationTargets.push(latest);
      }

      const metaPath = path.join(rootDir, '.xj-backup-meta.json');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) || {}; } catch (_) {}
      const due = !meta.lastSnapshot || (now - meta.lastSnapshot) >= BACKUP_SNAPSHOT_MIN_INTERVAL_MS;
      if (forceSnapshot || (changed && due)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        let snapshotName = 'XinJing-' + ts + '.xjbackup';
        let snapshot = path.join(rootDir, snapshotName);
        let snapshotWritten = false;
        try {
          writeVerifiedPackage(snapshot);
          snapshotWritten = true;
        } catch (snapshotError) {
          // A timestamped snapshot can be held by an antivirus/sync process too.
          // Keep the forced quit guarantee by trying a unique immutable name in
          // the same authoritative directory before declaring the location bad.
          snapshotName = 'XinJing-' + ts + '-' + process.pid + '-' + crypto.randomBytes(3).toString('hex') + '.xjbackup';
          snapshot = path.join(rootDir, snapshotName);
          try {
            writeVerifiedPackage(snapshot);
            snapshotWritten = true;
          } catch (fallbackError) {
            fallbackError.cause = snapshotError;
            if (forceSnapshot) throw fallbackError;
            // The rolling latest package has already been verified. Historical
            // retention is best-effort during background/normal backups; defer
            // it and retry on the next run instead of blocking a safe backup.
            console.warn('[backup] historical snapshot deferred:', safeBackupErrorCode(fallbackError, 'XJ_BACKUP_WRITE_FAILED'));
          }
        }
        if (snapshotWritten) {
          meta.lastSnapshot = now;
          meta.lastSnapshotName = snapshotName;
        }
      }
      if (changed) meta.lastChange = now;
      meta.lastPayloadSha256 = payloadSha256;
      try {
        atomicWriteUtf8(metaPath, JSON.stringify(meta));
      } catch (metaError) {
        // The encrypted package has already been atomically written and
        // verified. Metadata is advisory bookkeeping; a transient metadata
        // lock must not turn a valid user-data backup into a false failure.
        console.warn('[backup] metadata write deferred:', safeBackupErrorCode(metaError, 'XJ_BACKUP_WRITE_FAILED'));
      }

      let snapshots = [];
      try { snapshots = fs.readdirSync(rootDir).filter((name) => /^XinJing-\d{4}-\d{2}-\d{2}T.*\.xjbackup$/.test(name)).sort(); } catch (_) {}
      while (snapshots.length > BACKUP_MAX_SNAPSHOTS) {
        const old = snapshots.shift();
        try { fs.unlinkSync(path.join(rootDir, old)); } catch (_) {}
      }
      // Record verified targets before returning from this location. This keeps
      // a successful latest package visible to the caller even if a non-forced
      // historical snapshot was deferred above.
      targets.push(...locationTargets);
    }

    // 默认位置是用户可见的权威备份位置。自定义位置只是额外容灾，
    // 不能掩盖默认位置失败，否则退出提示会让用户误以为“文档\心镜备份”
    // 已经安全写入。
    let defaultLocationError = null;
    let defaultLocationSucceeded = false;
    try {
      doLocation(path.join(app.getPath('documents'), '心镜备份'));
      defaultLocationSucceeded = true;
    } catch (error) {
      defaultLocationError = error;
      console.warn('[backup] default location unavailable; configured locations remain diagnostic only');
    }
    (cfg.locations || []).forEach((loc) => {
      if (!loc || typeof loc !== 'string') return;
      let st;
      try { st = fs.statSync(loc); } catch (_) { return; }
      if (!st.isDirectory()) return;
      try { doLocation(loc); } catch (_) { /* preserve other locations */ }
    });
    if (!defaultLocationSucceeded) {
      const failure = defaultLocationError || new Error('XJ_BACKUP_LOCATION_UNAVAILABLE');
      if (!failure.code) failure.code = 'XJ_BACKUP_LOCATION_UNAVAILABLE';
      throw failure;
    }

    try {
      atomicWriteUtf8(path.join(src, 'backup-meta.json'), JSON.stringify({
        lastAutoBackup: new Date().toISOString(),
        time: now,
        payloadSha256,
      }));
    } catch (_) {}

    if (cfg.emailEnabled && cfg.email) {
      try {
        const body = encodeURIComponent('心镜数据已自动备份（加密包）：\n' + targets.join('\n'));
        shell.openExternal('mailto:' + cfg.email + '?subject=' + encodeURIComponent('心镜自动备份通知') + '&body=' + body);
      } catch (_) {}
    }
    return targets;
  } catch (error) {
    console.error('[backup] ' + safeBackupErrorCode(error, 'XJ_BACKUP_WRITE_FAILED'));
    return null;
  } finally {
    if (key) key.fill(0);
  }
}
function readTrialFirstLaunch() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(userDataDir(), 'trial.json'), 'utf8'));
    return j.firstLaunch || null;
  } catch (e) { return null; }
}
function ensureTrial() {
  let ts = readTrialFirstLaunch();
  if (!ts) {
    ts = Date.now();
    try { fs.writeFileSync(path.join(userDataDir(), 'trial.json'), JSON.stringify({ firstLaunch: ts })); } catch (e) { /* ignore */ }
  }
  return ts;
}
// ---- 防重装刷新试用：公共目录隐藏标记 ----
// 记录「真正的首次安装时间」到 %ProgramData%\XinJing\.xjinstall（隐藏、base64 轻混淆）。
// 该目录随机器存在、卸载不清除、独立于 userData：用户即使卸载重装心镜，也会读回最早的安装时间，
// 无法通过重装把 30 天 AI 免费试用刷新为满额。标记内绑定机器码，跨机复制无效。
function programDataMarkerPath() {
  const base = process.env.ProgramData || process.env.ALLUSERSPROFILE || userDataDir();
  return path.join(base, 'XinJing', '.xjinstall');
}
function readInstallMarker() {
  try {
    const raw = fs.readFileSync(programDataMarkerPath(), 'utf8');
    const j = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (j && j.firstInstall) return j;
  } catch (e) { /* ignore */ }
  return null;
}
function writeInstallMarker(obj) {
  try {
    const p = programDataMarkerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'));
    if (process.platform === 'win32') {
      try { require('child_process').execFileSync('attrib', ['+h', p]); } catch (e) { /* 隐藏失败不影响功能 */ }
    }
  } catch (e) { /* ignore */ }
}
// 计算真正的首次安装时间戳（跨重装稳定）：取「公共目录标记」与「userData 首次启动」的较早者，并回写标记。
function resolveFirstInstall() {
  if (AGENT_ACCEPTANCE_MODE) return ensureTrial();
  const mc = getMachineCode();
  const trialTs = ensureTrial(); // userData 内首次启动（卸载重装会重置）
  let firstInstall = trialTs;
  const marker = readInstallMarker();
  if (marker && marker.firstInstall && (!marker.mc || marker.mc === mc)) {
    firstInstall = Math.min(firstInstall, marker.firstInstall);
  }
  writeInstallMarker({ mc, firstInstall }); // 补齐/修正为更早时间，保证后续重装仍读到最早时间
  return firstInstall;
}

function atomicWriteJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  let handle = null;
  try {
    handle = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(handle, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(tmp, target);
  } catch (error) {
    if (handle !== null) {
      try { fs.closeSync(handle); } catch (ignore) {}
    }
    try { fs.unlinkSync(tmp); } catch (ignore) {}
    throw error;
  }
}

function atomicWriteBytes(target, bytes) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  let handle = null;
  try {
    handle = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(handle, value);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(tmp, target);
  } catch (error) {
    if (handle !== null) { try { fs.closeSync(handle); } catch (ignore) {} }
    try { fs.unlinkSync(tmp); } catch (ignore) {}
    throw error;
  }
}

function supervisionPackageDir() { return path.join(userDataDir(), 'supervision-packages'); }
function supervisionPackageIndexPath() { return path.join(supervisionPackageDir(), 'index-v1.json'); }
function supervisionPackageHighWaterPath() { return path.join(supervisionPackageDir(), 'high-water-v1.json'); }

function readSupervisionJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return fallback; }
}

function readSupervisionPackageIndex() {
  const value = readSupervisionJson(supervisionPackageIndexPath(), null);
  if (!value) return { schemaVersion: 1, entries: {} };
  if (value.schemaVersion !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
    return { schemaVersion: 1, entries: {}, corrupt: true };
  }
  return value;
}

function readSupervisionHighWater() {
  const value = readSupervisionJson(supervisionPackageHighWaterPath(), null);
  if (!value || value.schemaVersion !== 1 || !value.grants || !value.packages) {
    return supervisionPackageCore.createHighWaterState();
  }
  return value;
}

function supervisionPackageKey(packageId, packageVersion) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(String(packageId || '')) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(packageVersion || ''))) return '';
  return String(packageId) + '@' + String(packageVersion);
}

function supervisionPackageFileName(packageId, packageVersion) {
  const key = supervisionPackageKey(packageId, packageVersion);
  return key ? key.replace(/@/g, '--') + '.xjsup' : '';
}

function supervisionDeviceRawPublic(keyObject) {
  const der = crypto.createPublicKey(keyObject).export({ format: 'der', type: 'spki' });
  const prefix = Buffer.from('302a300506032b656e032100', 'hex');
  if (!der.subarray(0, prefix.length).equals(prefix) || der.length !== prefix.length + 32) return null;
  return Buffer.from(der.subarray(prefix.length));
}

function getSupervisionDeviceIdentity() {
  if (supervisionDeviceIdentityCache) return supervisionDeviceIdentityCache;
  const recordPath = path.join(userDataDir(), 'supervision-device-v1.json');
  try {
    const record = readSupervisionJson(recordPath, null);
    if (record && record.schemaVersion === 1 && record.deviceKeyId && record.protectedKey && record.devicePublicKeyHash) {
      const pem = decryptSecret(record.protectedKey);
      if (!pem) return null;
      const keyObject = crypto.createPrivateKey(pem);
      const rawPublic = supervisionDeviceRawPublic(keyObject);
      if (!rawPublic || supervisionPackageCore.hashBytesBase64url(rawPublic) !== record.devicePublicKeyHash) return null;
      supervisionDeviceIdentityCache = Object.freeze({ deviceKeyId: record.deviceKeyId, devicePublicKeyHash: record.devicePublicKeyHash, keyObject });
      return supervisionDeviceIdentityCache;
    }
  } catch (error) {
    return null;
  }
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const pair = crypto.generateKeyPairSync('x25519');
    const rawPublic = supervisionDeviceRawPublic(pair.privateKey);
    if (!rawPublic) return null;
    const protectedKey = encryptSecret(pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
    if (!protectedKey) return null;
    const record = {
      schemaVersion: 1,
      deviceKeyId: 'xjdev_' + crypto.randomBytes(12).toString('hex'),
      devicePublicKeyHash: supervisionPackageCore.hashBytesBase64url(rawPublic),
      publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      protectedKey,
    };
    atomicWriteJson(recordPath, record);
    supervisionDeviceIdentityCache = Object.freeze({ deviceKeyId: record.deviceKeyId, devicePublicKeyHash: record.devicePublicKeyHash, keyObject: pair.privateKey });
    return supervisionDeviceIdentityCache;
  } catch (error) {
    return null;
  }
}

function readSupervisionRevocationEvidence(nowMs) {
  const file = path.join(userDataDir(), 'supervision-package-revocations.json');
  const raw = readSupervisionJson(file, null);
  if (!raw) return { valid: false, cachedValid: false, lastVerifiedOnlineAtMs: 0 };
  try {
    const checked = supervisionPackageCore.verifyRevocationEvidence(raw, { nowMs });
    if (checked.valid) return Object.assign(checked, { cachedValid: true, lastVerifiedOnlineAtMs: checked.lastVerifiedOnlineAtMs });
    const issued = Date.parse(String(raw.issuedAt || ''));
    return { valid: false, cachedValid: Number.isFinite(issued), lastVerifiedOnlineAtMs: Number.isFinite(issued) ? issued : 0, revocationEpoch: Number(raw.revocationEpoch || 0) };
  } catch (error) {
    return { valid: false, cachedValid: false, lastVerifiedOnlineAtMs: 0 };
  }
}

function supervisionRuntimeContext() {
  const state = licenseState || computeState();
  const nowMs = Date.now();
  const access = entitlements.access('custom-supervisors', state);
  const entitlementAllowed = state.activated === true && state.expired !== true && state.tier === 'custom' && access.eligible === true;
  const device = entitlementAllowed ? getSupervisionDeviceIdentity() : null;
  const revocation = readSupervisionRevocationEvidence(nowMs);
  return {
    entitlementAllowed,
    subjectIdHash: state.subjectId ? supervisionPackageCore.hashOpaque(state.subjectId) : '',
    licenseIdHash: state.licenseId ? supervisionPackageCore.hashOpaque(state.licenseId) : '',
    deviceKeyId: device ? device.deviceKeyId : '',
    devicePublicKeyHash: device ? device.devicePublicKeyHash : '',
    keyObject: device ? device.keyObject : null,
    appVersion: app.getVersion(),
    nowMs,
    online: revocation.valid === true,
    revocation,
  };
}

function supervisionError(error) {
  const code = error && error.code ? String(error.code) : 'runtime-failed';
  const messages = {
    'entitlement-denied': '需要旗舰版授权',
    'author-key-unknown': '作者验证密钥不可用',
    'signature-invalid': '技能包签名无效',
    'subject-mismatch': '技能包未绑定当前账户',
    'license-mismatch': '技能包未绑定当前授权',
    'device-mismatch': '技能包未绑定当前设备',
    'device-key-unavailable': '设备密钥暂不可用',
    'grant-expired': '技能包已过期',
    'package-revoked': '技能包已撤销',
    'offline-grace-expired': '离线宽限已结束',
    'revocation-unavailable': '在线撤销状态不可验证',
    'clock-rollback': '检测到系统时间回拨',
    'grant-sequence-rollback': '授权版本回退',
    'package-version-rollback': '技能包版本回退',
    'revocation-epoch-rollback': '撤销版本回退',
  };
  return { ok: false, errorCode: code, message: messages[code] || '技能包暂不可用' };
}

function supervisionDescriptorWithState(descriptor, status, reason) {
  return Object.assign({}, descriptor || {}, { status: status || descriptor && descriptor.status || 'locked', reason: reason || '' });
}

function handleSupervisionInspect(event, payload) {
  if (!isTrustedRendererEvent(event)) return { ok: false, errorCode: 'untrusted-renderer', message: '请求来源不受信任' };
  try {
    const input = payload && payload.bytes;
    const bytes = Buffer.from(input instanceof Uint8Array ? input : []);
    if (!bytes.length || bytes.length > SUPERVISION_PACKAGE_MAX_BYTES) throw new Error('package-too-large');
    const inspected = supervisionPackageCore.inspectPackage(bytes, { fileName: payload && payload.fileName });
    const token = crypto.randomBytes(18).toString('base64url');
    supervisionPackageInspections.set(String(event.sender.id) + ':' + token, {
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes,
      fileName: String((payload && payload.fileName) || ''),
      descriptor: inspected.descriptor,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    return { ok: true, inspectionToken: token, descriptor: inspected.descriptor };
  } catch (error) {
    return supervisionError(error);
  }
}

function handleSupervisionInstall(event, payload) {
  if (!isTrustedRendererEvent(event)) return { ok: false, errorCode: 'untrusted-renderer', message: '请求来源不受信任' };
  try {
    if (!payload || payload.confirmed !== true || typeof payload.inspectionToken !== 'string') throw new Error('confirmation-required');
    const key = String(event.sender.id) + ':' + payload.inspectionToken;
    const inspection = supervisionPackageInspections.get(key);
    if (!inspection || inspection.expiresAt < Date.now()) throw new Error('inspection-expired');
    const bytes = Buffer.from(payload.bytes instanceof Uint8Array ? payload.bytes : []);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!bytes.length || hash !== inspection.hash) throw new Error('inspection-mismatch');
    const context = supervisionRuntimeContext();
    const opened = supervisionPackageCore.openPackage(bytes, context, { fileName: inspection.fileName });
    const descriptor = opened.descriptor;
    const fileName = supervisionPackageFileName(descriptor.packageId, descriptor.packageVersion);
    const entryKey = supervisionPackageKey(descriptor.packageId, descriptor.packageVersion);
    if (!fileName || !entryKey) throw new Error('package-id');
    const index = readSupervisionPackageIndex();
    const now = new Date().toISOString();
    const record = {
      schemaVersion: 1,
      key: entryKey,
      fileName,
      descriptor,
      installedAt: now,
      lastUsedAt: '',
      state: 'installed',
    };
    atomicWriteBytes(path.join(supervisionPackageDir(), fileName), bytes);
    atomicWriteJson(supervisionPackageHighWaterPath(), supervisionPackageCore.advanceHighWater(readSupervisionHighWater(), opened.parsed.manifest, context.nowMs));
    index.entries[entryKey] = record;
    atomicWriteJson(supervisionPackageIndexPath(), { schemaVersion: 1, entries: index.entries });
    supervisionPackageInspections.delete(key);
    return { ok: true, descriptor: supervisionDescriptorWithState(descriptor, 'installed', '') };
  } catch (error) {
    return supervisionError(error);
  }
}

function assessSupervisionPackageEntry(entry, context) {
  try {
    const bytes = fs.readFileSync(path.join(supervisionPackageDir(), entry.fileName));
    const parsed = supervisionPackageCore.parseXjsup(bytes, { fileName: entry.fileName });
    supervisionPackageCore.authorizePackage(parsed, context);
    return { status: 'installed', reason: '' };
  } catch (error) {
    const result = supervisionError(error);
    return { status: 'locked', reason: result.errorCode };
  }
}

function handleSupervisionList(event) {
  if (!isTrustedRendererEvent(event)) return { ok: false, errorCode: 'untrusted-renderer', message: '请求来源不受信任' };
  const index = readSupervisionPackageIndex();
  const context = supervisionRuntimeContext();
  return {
    ok: true,
    packages: Object.keys(index.entries).sort().map((key) => {
      const entry = index.entries[key];
      const state = assessSupervisionPackageEntry(entry, context);
      return supervisionDescriptorWithState(entry.descriptor, state.status, state.reason);
    }),
  };
}

function handleSupervisionRuntimeDescriptor(event, payload) {
  if (!isTrustedRendererEvent(event)) return { ok: false, errorCode: 'untrusted-renderer', message: '请求来源不受信任' };
  const key = supervisionPackageKey(payload && payload.packageId, payload && payload.packageVersion);
  if (!key) return { ok: false, errorCode: 'package-id', message: '技能包标识无效' };
  const entry = readSupervisionPackageIndex().entries[key];
  if (!entry) return { ok: false, errorCode: 'package-not-installed', message: '技能包未安装' };
  const context = supervisionRuntimeContext();
  const state = assessSupervisionPackageEntry(entry, context);
  return { ok: true, descriptor: supervisionDescriptorWithState(entry.descriptor, state.status, state.reason) };
}

function handleSupervisionRun(event, payload) {
  if (!isTrustedRendererEvent(event)) return { ok: false, errorCode: 'untrusted-renderer', message: '请求来源不受信任' };
  try {
    const key = supervisionPackageKey(payload && payload.packageId, payload && payload.packageVersion);
    if (!key) throw new Error('package-id');
    const index = readSupervisionPackageIndex();
    const entry = index.entries[key];
    if (!entry) throw new Error('package-not-installed');
    const bytes = fs.readFileSync(path.join(supervisionPackageDir(), entry.fileName));
    const context = supervisionRuntimeContext();
    const opened = supervisionPackageCore.openPackage(bytes, context, { fileName: entry.fileName });
    const now = new Date().toISOString();
    entry.lastUsedAt = now;
    atomicWriteJson(supervisionPackageHighWaterPath(), supervisionPackageCore.advanceHighWater(readSupervisionHighWater(), opened.parsed.manifest, context.nowMs));
    atomicWriteJson(supervisionPackageIndexPath(), { schemaVersion: 1, entries: index.entries });
    supervisionPackageRuntimeCache.set(key, { resources: opened.resources, expiresAt: Date.now() + 2 * 60 * 1000 });
    const ref = {
      packageId: opened.descriptor.packageId,
      supervisorId: opened.descriptor.supervisorId,
      packageVersion: opened.descriptor.packageVersion,
      contentHash: opened.descriptor.contentHash,
      authorKeyId: opened.descriptor.authorKeyId,
      recipientGrantIdHash: opened.descriptor.bindingSummary,
      grantSequence: opened.descriptor.grantSequence,
      bindingAssurance: 'device-bound',
      providerPolicyHash: supervisionPackageCore.hashBytesBase64url(supervisionPackageCore.canonicalBytes(opened.parsed.manifest.providerPolicy)),
      actualProviderId: opened.parsed.manifest.providerPolicy.mode === 'local-only' ? 'local-only' : opened.parsed.manifest.providerPolicy.providerId,
      status: 'authorized',
    };
    return { ok: true, runId: 'sup_run_' + crypto.randomBytes(12).toString('hex'), descriptor: opened.descriptor, supervisionSkillRef: ref };
  } catch (error) {
    return supervisionError(error);
  }
}

function handleSupervisionRemove(event, payload) {
  if (!isTrustedRendererEvent(event)) return { ok: false, errorCode: 'untrusted-renderer', message: '请求来源不受信任' };
  const key = supervisionPackageKey(payload && payload.packageId, payload && payload.packageVersion);
  if (!key) return { ok: false, errorCode: 'package-id', message: '技能包标识无效' };
  const index = readSupervisionPackageIndex();
  const entry = index.entries[key];
  if (!entry) return { ok: false, errorCode: 'package-not-installed', message: '技能包未安装' };
  try { fs.unlinkSync(path.join(supervisionPackageDir(), entry.fileName)); } catch (error) { if (error.code !== 'ENOENT') return { ok: false, errorCode: 'remove-failed', message: '技能包移除失败' }; }
  delete index.entries[key];
  supervisionPackageRuntimeCache.delete(key);
  atomicWriteJson(supervisionPackageIndexPath(), { schemaVersion: 1, entries: index.entries });
  return { ok: true, packageId: payload.packageId, packageVersion: payload.packageVersion };
}

function licenseFilePath() { return path.join(userDataDir(), 'license.json'); }
function revocationStatePath() { return path.join(userDataDir(), 'license-revocation-state.json'); }

function readStoredLicense() {
  try {
    const record = JSON.parse(fs.readFileSync(licenseFilePath(), 'utf8'));
    if (record && record.schemaVersion === 2 && record.claim && typeof record.claim === 'object') {
      return { kind: 'v2', claim: record.claim, source: record.source === 'cloud' ? 'cloud' : 'offline' };
    }
    if (record && typeof record === 'object') return { kind: 'legacy' };
  } catch (error) {
    if (error && error.code !== 'ENOENT') return { kind: 'invalid' };
  }
  return { kind: 'none' };
}

function readMinimumRevocationVersion() {
  try {
    const state = JSON.parse(fs.readFileSync(revocationStatePath(), 'utf8'));
    return Number.isInteger(state.minimumVersion) && state.minimumVersion > 0 ? state.minimumVersion : 0;
  } catch (error) {
    return 0;
  }
}

function loadVerifiedRevocationList(now) {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(path.join(__dirname, 'license-revocations.json'), 'utf8'));
  } catch (error) {
    return { valid: false, errorCode: 'revocation-unavailable', minimumVersion: readMinimumRevocationVersion() };
  }
  const minimumVersion = readMinimumRevocationVersion();
  const checked = license.verifyRevocationList(list, { now, minimumVersion });
  if (!checked.valid) return Object.assign({ minimumVersion }, checked);
  if (checked.listVersion > minimumVersion) {
    try {
      atomicWriteJson(revocationStatePath(), {
        schemaVersion: 1,
        minimumVersion: checked.listVersion,
        updatedAt: new Date(now).toISOString(),
      });
    } catch (error) {
      return { valid: false, errorCode: 'revocation-state-write', minimumVersion };
    }
  }
  return Object.assign({ minimumVersion: checked.listVersion }, checked);
}

function verifyStoredLicense(machineCode, now, revocation) {
  const stored = readStoredLicense();
  if (stored.kind === 'legacy') return { valid: false, tier: 'free', migrationRequired: true, errorCode: 'legacy-record' };
  if (stored.kind === 'invalid') return { valid: false, tier: 'free', migrationRequired: false, errorCode: 'stored-record-malformed' };
  if (stored.kind !== 'v2') return { valid: false, tier: 'free', migrationRequired: false, errorCode: '' };
  if (!revocation.valid) return { valid: false, tier: 'free', migrationRequired: false, errorCode: revocation.errorCode };
  return license.verifyStoredRecord({ schemaVersion: 2, claim: stored.claim }, machineCode, {
    now,
    revocationList: revocation.list,
    minimumRevocationVersion: revocation.minimumVersion,
  });
}

// 毫秒时间戳 → YYYY-MM-DD（0 视为终身）
function fmtDate(ms) {
  if (!ms) return '终身';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 机器码：每台设备安装后稳定生成一次并持久化于 userData/machine.json。
// 用于把激活码绑定到具体机器（一张码只能激活一台设备）。
// 基于 hostname+username+homedir 哈希，重装后（同账号同机）仍保持一致。
function getMachineCode() {
  const p = path.join(userDataDir(), 'machine.json');
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && j.code) return j.code;
  } catch (e) { /* ignore */ }
  let raw = '';
  try { raw = os.hostname() + '__' + os.userInfo().username + '__' + os.homedir(); } catch (e) { raw = 'xj-' + Math.random(); }
  const code = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16).toUpperCase();
  try { fs.writeFileSync(p, JSON.stringify({ code })); } catch (e) { /* ignore */ }
  return code;
}
function computeState() {
  const now = Date.now();
  const trial = license.trialStatus(ensureTrial(), now);
  const revocation = loadVerifiedRevocationList(now);
  const verified = verifyStoredLicense(getMachineCode(), now, revocation);
  const activated = verified.valid === true;
  const expired = verified.errorCode === 'expired';
  // Trial 不是产品档位：未激活用户始终保留 Free 产品权益，AI 体验由显式 allowlist 决定。
  // AI 免费试用窗口（安装后 30 天，跨重装稳定）
  const aiTrial = license.aiTrialStatus(resolveFirstInstall(), now);
  const aiTrialActive = !activated && aiTrial.active; // 已激活用户不再走试用口径
  // AI 解锁条件：已激活（未过期）或 处于 30 天免费试用窗口内。
  const aiUnlocked = activated || aiTrialActive;
  licenseState = {
    mode: license.overallMode(activated, trial),
    identity: activated ? verified.subjectId : '',
    subjectId: activated ? verified.subjectId : '',
    tier: activated ? verified.tier : 'free',
    aiUnlocked,
    aiTrialActive,
    aiTrialDaysLeft: aiTrial.daysLeft,
    aiTrialDays: license.AI_TRIAL_DAYS,
    daysLeft: trial.daysLeft,
    activated,
    expired,
    expiresAt: activated || expired ? (verified.expiresAt || 0) : 0,
    licenseId: activated ? verified.licenseId : '',
    migrationRequired: verified.migrationRequired === true,
    licenseErrorCode: verified.errorCode || '',
    revocationValid: revocation.valid === true,
    revocationVersion: revocation.valid ? revocation.listVersion : 0,
    trialDays: license.TRIAL_DAYS,
    version: app.getVersion()
  };
  return licenseState;
}

// 安全 MIME 映射（经典 <script>，.js 用 text/javascript）
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

// 静态文件服务处理器：供主静态服务与「旧端口迁移临时服务」共用（同源 serve APP_DIR）
function serveApp(req, res) {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/' || urlPath === '') urlPath = '/chat-home.html';
    const resolved = path.resolve(APP_DIR, '.' + path.normalize(urlPath));
    if (!resolved.startsWith(APP_DIR + path.sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.stat(resolved, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      // M7 修复：fs.stat 会跟随符号链接，需再校验真实路径仍在 APP_DIR 内，
      // 否则 APP_DIR 内的 symlink 可指向任意外部文件实现穿越读取。
      let realPath;
      try { realPath = fs.realpathSync(resolved); } catch (e) { res.writeHead(403); res.end('Forbidden'); return; }
      if (realPath !== APP_DIR_REAL && !realPath.startsWith(APP_DIR_REAL + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(resolved).pipe(res);
    });
  } catch (e) {
    res.writeHead(500);
    res.end('Internal Error');
  }
}

// ---- 内置静态文件服务（避免 file:// 下 IndexedDB 不可用）----
function startStaticServer() {
  return new Promise((resolve) => {
    server = http.createServer(serveApp);
    // Acceptance must never attach to a user's already-running stable origin.
    // Its userData is isolated, so an ephemeral loopback origin is both safe and
    // necessary to prove that CDP serves the current workspace bytes.
    if (AGENT_ACCEPTANCE_MODE) {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      return;
    }
    // 固定端口：IndexedDB/localStorage 按 origin(含端口) 隔离，端口一变=空库=历史"丢失"。
    // 优先固定 18765；若被占用则按确定性候选列表逐个尝试（避免随机端口造成 origin 漂移），
    // 仍全部失败才回退随机端口。无论最终绑定哪个端口，consolidateIndexedDB 都会把历史数据带过来。
    const CANDIDATE_PORTS = [18765, 18766, 18767, 18768, 18769, 11817];
    let idx = 0;
    const tryNext = () => {
      if (idx >= CANDIDATE_PORTS.length) {
        console.warn('[server] 固定端口候选均被占用，回退随机端口（历史数据仍会由合并逻辑自动带回）');
        server.removeAllListeners('error');
        server.once('error', (e) => console.error('[server] 静态服务启动失败', e));
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
        return;
      }
      const p = CANDIDATE_PORTS[idx++];
      server.removeAllListeners('error');
      const onErr = (err) => {
        if (err && err.code === 'EADDRINUSE') { tryNext(); }
        else { console.error('[server] 静态服务启动失败', err); }
      };
      server.once('error', onErr);
      server.listen(p, '127.0.0.1', () => {
        server.removeListener('error', onErr);
        resolve(p);
      });
    };
    tryNext();
  });
}

function isAgentAcceptanceLoopbackUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && Number(parsed.port) === PORT;
  } catch (e) {
    return false;
  }
}

function configureAgentAcceptanceSession() {
  const acceptanceSession = require('electron').session.defaultSession;
  acceptanceSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (typeof acceptanceSession.setPermissionCheckHandler === 'function') {
    acceptanceSession.setPermissionCheckHandler(() => false);
  }
  // 默认拒网与未登录强制登录门禁统一在 whenReady 内注册（unifiedRequestGate）：
  // Electron 的 onBeforeRequest 只允许一个监听器，拆开注册会互相覆盖。
}

// ---- 旧端口历史数据迁移：扫描 IndexedDB 目录下所有旧端口库，在其上临时起同源服务 ----
// 渲染进程用隐藏 iframe 在旧 origin 上下文经 IndexedDB API 读出数据并合并写回当前端口库。
// 注意：Chromium 的 IndexedDB 用 database id 索引，跨 origin 复制 leveldb 目录无效，
//       必须用 API 级迁移（本函数只负责"起同源临时服务 + 返回端口列表"）。
async function startLegacyMigrateServers() {
  const found = [];
  const idbDir = path.join(userDataDir(), 'IndexedDB');
  if (!fs.existsSync(idbDir)) return found;
  const entries = fs.readdirSync(idbDir);
  const reValid = /^http_127\.0\.0\.1_(\d+)\.indexeddb\.leveldb$/;
  const reOrphan = /^http_127\.0\.0\.1_(\d+)\.indexeddb\.leveldb\.orphan/;
  for (const name of entries) {
    let m = name.match(reValid);
    let port = m ? parseInt(m[1], 10) : null;
    let isOrphan = false;
    if (!port) {
      m = name.match(reOrphan);
      if (m) { port = parseInt(m[1], 10); isOrphan = true; }
    }
    if (!port || port === PORT) continue; // 跳过当前端口（避免自读/端口冲突）
    if (isOrphan) {
      // orphan 是早期 consolidateIndexedDB 把"最大旧库"改名归档的产物，含真实数据但 Chromium 不认。
      // 读取前临时还原成规范名（读取后由 archiveLegacyPorts 归档为 .migrated），以便 iframe 同源读出。
      const canonical = 'http_127.0.0.1_' + port + '.indexeddb.leveldb';
      const canonPath = path.join(idbDir, canonical);
      const orphanPath = path.join(idbDir, name);
      if (fs.existsSync(canonPath)) continue; // 已有规范名则跳过 orphan，避免重复
      try { fs.renameSync(orphanPath, canonPath); }
      catch (e) { console.error('[migrate] 还原 orphan 失败', port, (e && e.message) || e); continue; }
    }
    const srv = http.createServer(serveApp);
    const ok = await new Promise((resolve) => {
      srv.once('error', (e) => { console.warn('[migrate] 端口', port, '占用，跳过', (e && e.code) || e); resolve(false); });
      srv.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) { legacyMigrateServers.push(srv); found.push(port); }
  }
  if (found.length) console.log('[migrate] 发现旧端口待迁移:', found);
  return found;
}

// 迁移完成后归档旧端口库（防重复迁移）：规范名 → .migrated-<ts>
function archiveLegacyPorts(ports) {
  const idbDir = path.join(userDataDir(), 'IndexedDB');
  const ts = Date.now();
  for (const port of (ports || [])) {
    const p = 'http_127.0.0.1_' + port + '.indexeddb.leveldb';
    const src = path.join(idbDir, p);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(idbDir, p + '.migrated-' + ts);
    try { fs.renameSync(src, dst); console.log('[migrate] 归档旧端口', port); }
    catch (e) { console.error('[migrate] 归档失败', port, (e && e.message) || e); }
  }
}

// 当前端口 orphan 预合并：consolidateIndexedDB 曾把「最大旧库」改名归档为 .orphan。
// 若该 orphan 的端口正好是本次启动绑定的 PORT，临时同源服务会因端口冲突而绑不上、数据漏迁移。
// 故在渲染进程打开 IndexedDB 之前，把它还原为规范名，使渲染进程直接以旧数据作为当前库打开。
// 仅当规范库不存在、或规范库几乎为空（log < 100KB，说明尚无用户数据）时才覆盖，避免丢失当前记录。
function preConsolidateCurrentPortOrphan(port) {
  try {
    const idbDir = path.join(userDataDir(), 'IndexedDB');
    if (!fs.existsSync(idbDir)) return;
    const orphanName = 'http_127.0.0.1_' + port + '.indexeddb.leveldb.orphan';
    const orphanPath = path.join(idbDir, orphanName);
    if (!fs.existsSync(orphanPath)) return;
    const canonName = 'http_127.0.0.1_' + port + '.indexeddb.leveldb';
    const canonPath = path.join(idbDir, canonName);
    if (fs.existsSync(canonPath)) {
      let maxLog = 0;
      try {
        for (const f of fs.readdirSync(canonPath)) {
          if (f.endsWith('.log')) {
            const s = fs.statSync(path.join(canonPath, f)).size;
            if (s > maxLog) maxLog = s;
          }
        }
      } catch (e) { /* ignore */ }
      if (maxLog > 100 * 1024) {
        console.log('[migrate] 当前端口规范库已有数据，跳过 orphan 预合并（端口', port, '）');
        return;
      }
    }
    fs.renameSync(orphanPath, canonPath);
    console.log('[migrate] 预合并当前端口 orphan:', port);
  } catch (e) {
    console.error('[migrate] 预合并当前端口 orphan 失败', (e && e.message) || e);
  }
}

// ---- Window 菜单：最大化 / 还原 ----
// 只允许真正聚焦的普通主窗口参与，避免把确认窗、激活工具窗或 modal
// 子窗口误当作工作区最大化；没有合适窗口时菜单项保持禁用并 fail-closed。
function getFocusedNormalWindow() {
  let focusedWindow = null;
  try { focusedWindow = BrowserWindow.getFocusedWindow(); } catch (_) { return null; }
  if (!focusedWindow || (typeof focusedWindow.isDestroyed === 'function' && focusedWindow.isDestroyed())) return null;
  if (focusedWindow === closeConfirmWin || focusedWindow === activationWindow) return null;
  try {
    if (typeof focusedWindow.isModal === 'function' && focusedWindow.isModal()) return null;
    if (typeof focusedWindow.getParentWindow === 'function' && focusedWindow.getParentWindow()) return null;
    if (typeof focusedWindow.isMinimized === 'function' && focusedWindow.isMinimized()) return null;
  } catch (_) { return null; }
  return focusedWindow;
}

function refreshWindowMenuItem() {
  if (!windowMenuItem) return;
  const focusedWindow = getFocusedNormalWindow();
  windowMenuItem.enabled = !!focusedWindow;
  windowMenuItem.label = focusedWindow && typeof focusedWindow.isMaximized === 'function' && focusedWindow.isMaximized()
    ? '还原窗口'
    : '最大化窗口';
}

function toggleFocusedNormalWindowMaximize() {
  const focusedWindow = getFocusedNormalWindow();
  if (!focusedWindow || typeof focusedWindow.isMaximized !== 'function') {
    refreshWindowMenuItem();
    return { ok: false, reason: 'no-focused-normal-window' };
  }
  const wasMaximized = focusedWindow.isMaximized();
  if (wasMaximized) focusedWindow.restore();
  else focusedWindow.maximize();
  refreshWindowMenuItem();
  return { ok: true, action: wasMaximized ? 'restore' : 'maximize' };
}

function trackWindowForApplicationMenu(windowRef) {
  if (!windowRef || typeof windowRef.on !== 'function' || windowMenuBound.has(windowRef)) return;
  windowMenuBound.add(windowRef);
  for (const eventName of ['maximize', 'unmaximize', 'restore', 'minimize', 'closed']) {
    windowRef.on(eventName, refreshWindowMenuItem);
  }
}

function createApplicationMenu() {
  const template = [];
  if (process.platform === 'darwin') template.push({ role: 'appMenu' });
  template.push(
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Window',
      submenu: [
        {
          id: 'xj-window-toggle-maximize',
          label: '最大化窗口',
          click: () => toggleFocusedNormalWindowMaximize()
        },
        { type: 'separator' },
        { role: 'minimize', label: '最小化窗口' },
        { role: 'close', label: '关闭窗口' }
      ]
    },
    {
      role: 'help',
      submenu: [{ label: '检查更新', click: () => checkForUpdatesManual() }]
    }
  );
  applicationMenu = Menu.buildFromTemplate(template);
  windowMenuItem = applicationMenu && typeof applicationMenu.getMenuItemById === 'function'
    ? applicationMenu.getMenuItemById('xj-window-toggle-maximize')
    : null;
  Menu.setApplicationMenu(applicationMenu);
  if (!windowMenuListenersInstalled) {
    app.on('browser-window-focus', refreshWindowMenuItem);
    app.on('browser-window-blur', refreshWindowMenuItem);
    windowMenuListenersInstalled = true;
  }
  refreshWindowMenuItem();
  return applicationMenu;
}

// ---- 主窗口 ----
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: '心镜 v' + app.getVersion(), // 顶部窗口标题固定为「心镜 v1.0.X」
    icon: path.join(BUILD_DIR, 'icon.png'),
    backgroundColor: '#f6f1ea',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  trackWindowForApplicationMenu(mainWindow);
  applyWindowSecurity(mainWindow);

  // 强制登录门禁：未登录一律停留账号页；已登录直达工作台首页。
  if (accountSessionState.status === 'authenticated') {
    mainWindow.loadURL(`http://127.0.0.1:${PORT}/index.html`);
  } else {
    mainWindow.loadURL(accountGatePageUrl());
  }

  // 顶部窗口标题始终固定为「心镜 v1.0.X」，阻止各页面 document.title 覆盖
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
    if (mainWindow) mainWindow.setTitle('心镜 v' + app.getVersion());
  });

  mainWindow.webContents.on('preload-error', (ev, err) => {
    console.error('[preload-error] main window:', (err && err.stack) || err);
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow) mainWindow.show();
  });

  // 关闭 → 弹出美化版确认窗：后台常驻 or 完全退出
  // 顶部自定义 ✕ 与 Alt+F4 均等同「后台常驻」（拒绝退出）
  mainWindow.on('close', (e) => {
    if (AGENT_ACCEPTANCE_MODE && !AGENT_ACCEPTANCE_CLOSE_DIALOG) {
      allowAgentAcceptanceWindowExit();
      return;
    }
    if (app.isQuiting) return;            // 明确退出（托盘"退出"/确认选"完全退出"）不拦截
    e.preventDefault();
    if (closeConfirmWin) { try { closeConfirmWin.focus(); } catch (_) {} return; }
    // M9 修复：若主窗口已隐藏（托盘后台常驻），不可把确认窗作为「隐藏父窗口的 modal」——
    // 那样确认窗会因父窗口不可见而无法显示/点击。此时改为无父、非 modal 的独立窗口。
    const parentVisible = !!(mainWindow && mainWindow.isVisible());
    closeConfirmWin = new BrowserWindow({
      width: 456,
      height: 378,
      parent: parentVisible ? mainWindow : undefined,
      modal: parentVisible,
      frame: false,
      resizable: false,
      show: false,
      backgroundColor: '#f7f6f2',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        preload: path.join(__dirname, 'confirm-close-preload.js')
      }
    });
    applyWindowSecurity(closeConfirmWin);
    closeConfirmWin.webContents.on('preload-error', (ev, err) => {
      console.error('[preload-error] close-confirm:', (err && err.stack) || err);
    });
    closeConfirmWin.loadURL(`http://127.0.0.1:${PORT}/confirm-close.html`);
    closeConfirmWin.once('ready-to-show', () => { if (closeConfirmWin) closeConfirmWin.show(); });
    // 用户直接关掉确认窗（Alt+F4 等）→ 等同「取消退出」：主窗口保持打开，不隐藏、不退
    closeConfirmWin.on('close', () => { /* 取消退出由抉择逻辑处理，主窗口保持打开 */ });
    closeConfirmWin.on('closed', () => { closeConfirmWin = null; });
  });

  mainWindow.on('show', () => {
    if (mainWindow) mainWindow.focus();
  });
}

// ---- 托盘 ----
function createTray() {
  const icon = nativeImage.createFromPath(path.join(BUILD_DIR, 'icon.png'));
  if (icon.isEmpty()) return;
  tray = new Tray(icon);
  tray.setToolTip('心镜 XinJing');
  const trayMenu = Menu.buildFromTemplate([
    {
      label: '显示心镜',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { label: '检查更新', click: () => checkForUpdatesManual() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        if (prepareAppQuit('tray-quit')) app.quit();
      }
    }
  ]);
  tray.setContextMenu(trayMenu);
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ---- 开机自启 ----
function enableAutoStart() {
  app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath,
    args: []
  });
}

// ---- 更新完整性：typed feed + durable 快照 + 首启健康 + portable 回滚（v5.0 update-integrity）----
// 由已验证候选 Task 463 生产集成（main-update-integration 协调流）替代旧 electron-updater 链路。
// 融合说明：本文件其余部分（含用户/其他 agent 的 dirty 改动）原样保留，仅替换此更新区。
const updateIntegration = require('./app/update/main-update-integration');
const updateAdapters = require('./app/update/production-adapters');
const updateEnvAdapter = require('./app/update/env-adapter');

function isPortableRuntime() {
  return !!(process.env.PORTABLE_EXECUTABLE_FILE || /portable/i.test(path.basename(process.execPath)));
}

function updateIntegrationOptions() {
  // REAL production adapters (Codex intake P0-3/P0-4 fix): no adapter may stay
  // null. Electron APIs (net/dialog/ipcMain) are injected so the wiring is the
  // same code path exercised in tests; acceptance mode forces default-deny
  // network and never starts a real update.
  // P1-1 fix: the durable adapters (xj:update:snapshot / xj:update:restore)
  // require a controlled production env; buildAdapters fails closed when it is
  // missing. env is userData-scoped via env-adapter (bounded, never shared dir).
  const env = updateEnvAdapter.productionEnv(CANON_USER_DATA, null);
  updateEnvAdapter.assertBounded(env);
  const adapters = updateAdapters.buildProductionUpdateOptions({
    net: electronNet,
    dialog: dialog,
    ipcMain: ipcMain,
    getMainWindow: () => mainWindow || null,
    appVersion: app.getVersion(),
    denyNetwork: () => !!AGENT_ACCEPTANCE_MODE, // acceptance / probe: never hit the network
    probeDir: __dirname,
    electronExe: process.execPath,
    currentExePath: process.execPath
  });
  const opts = {
    win: null,
    ipcMain: ipcMain,
    mainWindow: null,
    appVersion: app.getVersion(),
    isPortable: isPortableRuntime(),
    channel: 'stable',
    strategy: isPortableRuntime() ? 'portable' : 'installer',
    userDataDir: CANON_USER_DATA,
    previousInstallerPath: null,
    backupCrypto: backupCrypto,
    backupKey: (typeof loadOrCreateBackupDataKey === 'function' ? loadOrCreateBackupDataKey() : null),
    agentAcceptanceMode: AGENT_ACCEPTANCE_MODE,
    sourceManifestHash: null,
    releaseId: null,
    fs: fs,
    lockHeld: () => false,
    env: env,
    transport: adapters.transport,
    recoverUpdate: adapters.recoverUpdate,
    confirmDecision: adapters.confirmDecision,
    rendererIpc: adapters.rendererIpc,
    rendererDurable: adapters.rendererDurable,
    healthCheck: adapters.healthCheck,
    portableRestart: adapters.portableRestart
  };
  return opts;
}

function checkForUpdatesManual() {
  if (AGENT_ACCEPTANCE_MODE) return;
  const opts = updateIntegrationOptions();
  if (mainWindow) opts.mainWindow = mainWindow;
  updateIntegration.checkForUpdatesManual(opts);
}

function setupUpdateIntegration() {
  const opts = updateIntegrationOptions();
  if (mainWindow) opts.mainWindow = mainWindow;
  return updateIntegration.setupUpdateIntegration(opts);
}

app.whenReady().then(async () => {
  if (!fs.existsSync(APP_DIR)) {
    console.error('app 目录缺失:', APP_DIR);
    app.quit();
    return;
  }
  try { computeState(); } catch (e) { console.error('[computeState] 启动计算授权状态失败，使用默认未激活态:', (e && e.message) || e); } // M1 修复：抛错不得阻断窗口创建
  if (AGENT_ACCEPTANCE_MODE) configureAgentAcceptanceSession();
  createApplicationMenu();
  PORT = await startStaticServer();
  // 5.1.0 Pi production bridge：主进程唯一编排入口；Store 读写经 preload
  // 结构化 transport 回到 renderer，未知账号/会员/发送方均 fail-closed。
  try {
    piProductionRuntime = createPiProductionRuntime({
      ipcMain,
      getMainWindow: () => mainWindow,
      isTrustedRendererEvent,
      userDataDir: userDataDir(),
      serverMembershipProjection: () => {
        const membership = accountSessionState.membership;
        if (accountSessionState.status !== 'authenticated' || !membership || membership.status !== 'ok' || membership.serverAuthoritative !== true) return null;
        return { tier: String(membership.tier || '') };
      },
      audit: (entry) => {
        if (entry && entry.ok === false) console.warn('[pi] durable boundary rejected:', String(entry.code || 'unknown'));
      },
    });
    if (!piProductionRuntime.replay || piProductionRuntime.replay.ok !== true) {
      console.error('[pi] event replay blocked; bridge remains fail-closed');
    }
  } catch (e) {
    piProductionRuntime = null;
    console.error('[pi] production bridge initialization failed (fail-closed):', (e && e.message) || e);
  }
  // 统一请求门禁：验收模式默认拒网（仅放行回环静态源）+ 未登录强制停留账号页。
  // onBeforeRequest 只能有一个监听器，故两种策略合并为 unifiedRequestGate。
  try {
    require('electron').session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*', 'ws://*/*', 'wss://*/*'] }, unifiedRequestGate);
  } catch (e) { console.error('[account-gate] webRequest 注册失败', (e && e.message) || e); }
  // 启动即尝试会话恢复（有已保存会话时）；失败 fail-closed，窗口仍停留账号页。
  // safeStorage DPAPI 后端在 ready 后存在短暂初始化竞态：先让出事件循环，再配合内部有界重试。
  await new Promise((r) => setTimeout(r, 1200));
  accountBootstrapPromise = bootstrapAccountSession();
  accountBootstrapPromise.catch(() => {}).finally(() => { accountBootstrapPromise = null; });
  // 当前端口 orphan 预合并：渲染进程打开 IndexedDB 之前，先把「恰好是当前端口」的 .orphan 旧库还原，
  // 否则它因端口冲突无法经临时服务迁移而永久丢失（store.js migrateOldPorts 负责其余非当前端口）。
  if (!AGENT_ACCEPTANCE_MODE) preConsolidateCurrentPortOrphan(PORT);
  // 历史端口数据迁移已改由渲染进程在窗口加载后执行（store.js migrateOldPorts）：
  // 主进程仅负责扫描旧端口并在其上临时起同源服务、通知渲染进程，迁移完成后再归档旧库。
  createWindow();
  // 旧端口历史数据迁移：窗口加载完成后，扫描旧端口并在其上临时起同源服务，
  // 由渲染进程用隐藏 iframe 在旧 origin 上下文读出数据、合并写入当前端口库（根治「换端口=历史丢失」）
  if (!AGENT_ACCEPTANCE_MODE && mainWindow) {
    mainWindow.webContents.once('did-finish-load', async () => {
      // M2 修复：窗口加载完成即推送授权/试用状态，避免付费/试用用户短暂读到默认 aiUnlocked=false 而锁死 AI
      try { if (licenseState) mainWindow.webContents.send('xj:license-state', licenseState); } catch (e) {}
      // M4 修复：迁移服务启动必须 try/catch，否则异常会变成未处理的 rejection 并阻断后续 legacy-ports 推送
      try {
        const ports = await startLegacyMigrateServers();
        if (ports.length) mainWindow.webContents.send('xj:legacy-ports', ports);
      } catch (e) { console.error('[migrate] 启动旧端口迁移服务失败（已跳过）', (e && e.message) || e); }
    });
  }
  if (!AGENT_ACCEPTANCE_MODE) {
    createTray();
    enableAutoStart();
  }
  setupUpdateIntegration(); // 注册 typed 更新桥（acceptance 模式内部 fail-safe，真实更新被门拦下）
  // 数据异常告警：本机曾有使用记录但历史数据缺失（可能丢失或落错目录）
  const anomalyFlag = path.join(CANON_USER_DATA, 'data-anomaly.json');
  if (!AGENT_ACCEPTANCE_MODE && app.isPackaged && fs.existsSync(anomalyFlag)) {
    try {
      dialog.showMessageBox({
        type: 'warning',
        title: '心镜 · 数据异常提示',
        message: '未检测到历史数据，但本机此前已有使用记录。',
        detail: '可能原因：\n• 数据目录因版本/构建差异落在其他文件夹（已尝试自动恢复）\n• 强制重启导致本地数据库损坏\n\n建议：检查「文档\\心镜备份」是否有自动备份可恢复；或在文件管理器中查看\nC:\\Users\\<你>\\AppData\\Local\\ 下是否存在 xinjing / XinJingDesktop 等目录（含 IndexedDB 子目录即为真实数据）。',
        buttons: ['我知道了']
      });
    } catch (e) { /* ignore */ }
  }
});

// ---- 激活窗口 ----
function openActivationWindow() {
  if (activationWindow) { activationWindow.focus(); return; }
  activationWindow = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 700,
    minHeight: 620,
    parent: mainWindow || undefined,
    show: true,
    center: true,
    resizable: true,
    icon: path.join(BUILD_DIR, 'icon.png'),
    backgroundColor: '#f6f1ea',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  applyWindowSecurity(activationWindow);
  activationWindow.loadURL(`http://127.0.0.1:${PORT}/activation.html`);
  activationWindow.webContents.on('preload-error', (ev, err) => {
    console.error('[preload-error] activation window:', (err && err.stack) || err);
  });
  activationWindow.on('closed', () => { activationWindow = null; });
}

// ---- API 密钥写入与受控 AI 网络 IPC ----
ipcMain.handle('xj:encryptSecret', (event, plain) => {
  if (!isTrustedRendererEvent(event) || typeof plain !== 'string' || plain.length > 16384) return '';
  return encryptSecret(plain);
});
ipcMain.handle('xj:backup:encrypt', async (event, input) => {
  if (!isTrustedRendererEvent(event)) return { ok: false, errorCode: 'XJ_BACKUP_SENDER_DENIED' };
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.payload !== 'string' || typeof input.passphrase !== 'string') {
    return { ok: false, errorCode: 'XJ_BACKUP_PACKAGE_INVALID' };
  }
  try {
    const packageText = await backupCrypto.encryptPayload(input.payload, input.passphrase, { kind: 'user-export', payloadVersion: '2.0.0' });
    return { ok: true, package: packageText };
  } catch (error) {
    return { ok: false, errorCode: safeBackupErrorCode(error) };
  }
});
ipcMain.handle('xj:backup:decrypt', async (event, input) => {
  if (!isTrustedRendererEvent(event)) return { ok: false, errorCode: 'XJ_BACKUP_SENDER_DENIED' };
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.packageText !== 'string' || typeof input.passphrase !== 'string') {
    return { ok: false, errorCode: 'XJ_BACKUP_PACKAGE_INVALID' };
  }
  try {
    const payload = await backupCrypto.decryptPayload(input.packageText, input.passphrase);
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, errorCode: safeBackupErrorCode(error) };
  }
});
ipcMain.handle('xj:backup:writeSafetySnapshot', async (event, input) => {
  if (!isTrustedRendererEvent(event)) return { ok: false, errorCode: 'XJ_BACKUP_SENDER_DENIED' };
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.payload !== 'string' || typeof input.passphrase !== 'string') {
    return { ok: false, errorCode: 'XJ_BACKUP_PACKAGE_INVALID' };
  }
  try {
    const packageText = await backupCrypto.encryptPayload(input.payload, input.passphrase, { kind: 'user-export', payloadVersion: '2.0.0' });
    atomicWriteUtf8(path.join(userDataDir(), BACKUP_SAFETY_FILE), packageText);
    return { ok: true };
  } catch (error) {
    const code = safeBackupErrorCode(error, 'XJ_BACKUP_SAFETY_WRITE_FAILED');
    return { ok: false, errorCode: code === 'XJ_BACKUP_PACKAGE_INVALID' ? 'XJ_BACKUP_SAFETY_WRITE_FAILED' : code };
  }
});
[
  ['xj:commercial:getSnapshot', 'getSnapshot'],
  ['xj:commercial:evaluateAccess', 'evaluateAccess'],
  ['xj:commercial:applySubscriptionEvent', 'applySubscriptionEvent'],
  ['xj:commercial:applyOrderEvent', 'applyOrderEvent'],
  ['xj:commercial:applyDeviceEvent', 'applyDeviceEvent'],
  ['xj:commercial:applyQuotaOperation', 'applyQuotaOperation'],
  ['xj:commercial:getAuditPage', 'getAuditPage'],
  ['xj:commercial:getServerModelCatalog', 'getServerModelCatalog'],
  ['xj:commercial:getModelPriceCatalog', 'getModelPriceCatalog'],
  ['xj:commercial:getAccountBalance', 'getAccountBalance'],
  ['xj:commercial:quoteRequestCharge', 'quoteRequestCharge'],
  ['xj:commercial:reserveRequestCharge', 'reserveRequestCharge'],
  ['xj:commercial:settleRequestCharge', 'settleRequestCharge'],
  ['xj:commercial:releaseRequestCharge', 'releaseRequestCharge'],
  ['xj:commercial:markRequestUnknown', 'markRequestUnknown'],
  ['xj:commercial:reconcileRequestCharge', 'reconcileRequestCharge'],
  ].forEach(([channel, method]) => {
   ipcMain.handle(channel, (event, payload) => handleCommercialChannel(method, event, payload));
 });
// Recipient-grant renderer boundary is intentionally read-only. Issuance, lifecycle,
// quota, entitlement and decryption authority remain inside the main process.
registerRecipientGrantIpc(ipcMain);
ipcMain.handle('xj:aiRequest', handleAiRequest);
ipcMain.on('xj:aiCancel', (event, requestId) => {
  if (!isTrustedRendererEvent(event)) return;
  const active = activeAiRequests.get(String(requestId || ''));
  if (active && active.senderId === event.sender.id) active.controller.abort();
});

// ---- 授权相关 IPC ----
ipcMain.handle('xj:getState', () => licenseState || computeState());
ipcMain.handle('xj:getVersion', () => app.getVersion());

// ---- v5.0.2 桌面账号：注册/验证/登录/会话恢复/登出/会员投影（渲染进程永不见 session token）----
ipcMain.handle('xj:account:bootstrap', handleAccountBootstrap);
ipcMain.handle('xj:account:register', handleAccountRegister);
ipcMain.handle('xj:account:resend', handleAccountResend);
ipcMain.handle('xj:account:verify', handleAccountVerify);
ipcMain.handle('xj:account:forgotPassword', handleAccountForgotPassword);
ipcMain.handle('xj:account:resetPassword', handleAccountResetPassword);
ipcMain.handle('xj:account:login', handleAccountLogin);
ipcMain.handle('xj:account:logout', handleAccountLogout);
ipcMain.handle('xj:account:status', handleAccountStatus);
ipcMain.handle('xj:account:refreshMembership', handleAccountRefreshMembership);
// 受控督导技能包 IPC：所有字节、授权、解密和原始密文路径都停留在主进程边界内。
ipcMain.handle('xj:supervisionSkill:inspectPackage', handleSupervisionInspect);
ipcMain.handle('xj:supervisionSkill:installPackage', handleSupervisionInstall);
ipcMain.handle('xj:supervisionSkill:listInstalled', handleSupervisionList);
ipcMain.handle('xj:supervisionSkill:getRuntimeDescriptor', handleSupervisionRuntimeDescriptor);
ipcMain.handle('xj:supervisionSkill:run', handleSupervisionRun);
ipcMain.handle('xj:supervisionSkill:removePackage', handleSupervisionRemove);
// 保存备份配置（多位置 + 邮箱），供 exportBackup 在退出/常驻时读取
ipcMain.handle('xj:saveBackupConfig', (e, cfg) => {
  if (!isTrustedRendererEvent(e)) return { ok: false, errorCode: 'XJ_BACKUP_SENDER_DENIED' };
  try {
    // H4 修复：过滤 cfg 中的危险路径，仅允许合法目录名
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ok: false, errorCode: 'XJ_BACKUP_PACKAGE_INVALID' };
    const safe = Object.assign({}, cfg);
    if (Array.isArray(safe.locations)) {
      safe.locations = safe.locations.filter(function (loc) {
        if (!loc || typeof loc !== 'string') return false;
        // 禁止系统根目录 / Windows 系统目录
        const lower = loc.toLowerCase();
        if (lower === 'c:\\' || lower === 'c:/' || lower === '/' || lower.length < 3) return false;
        if (lower.indexOf('\\windows\\') !== -1 || lower.indexOf('/windows/') !== -1) return false;
        if (lower.indexOf('\\program files') !== -1 || lower.indexOf('/program files') !== -1) return false;
        return true;
      });
    }
    if (safe.email !== undefined && typeof safe.email !== 'string') delete safe.email;
    fs.writeFileSync(path.join(userDataDir(), 'backup-config.json'), JSON.stringify(safe));
    return { ok: true };
  } catch (_) { return { ok: false, errorCode: 'XJ_BACKUP_WRITE_FAILED' }; }
});
// 选择备份文件夹（自定义多位置容灾）
ipcMain.handle('xj:selectBackupFolder', async () => {
  try {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '选择备份位置' });
    return r.canceled ? null : (r.filePaths && r.filePaths[0]) || null;
  } catch (err) { console.error('[backup] select folder failed', err.message); return null; }
});

// ---- 用户自建知识库（v3.5.0）：外部文件夹 .md/.txt 经主进程读取，仅本机、零出网 ----
// 基线 = 用户所选资料目录（非 APP_DIR）。防 ../../ 穿越与符号链接跳出。
// 对"用户主动选择的根目录"放宽：允许根是 junction/云同步入口；仅校验其下文件路径。
function ensureInsideUserDoc(resolved, userDocFolder) {
  const r = path.resolve(resolved);
  if (r !== userDocFolder && !r.startsWith(userDocFolder + path.sep)) return false;
  try {
    const real = fs.realpathSync(r);
    const realBase = fs.realpathSync(userDocFolder);
    return real === realBase || real.startsWith(realBase + path.sep);
  } catch (e) {
    // 符号链接/云同步 reparse point 解析异常：降级拒绝，避免误放行
    return false;
  }
}

// 资料库配置读写（照 xj:saveBackupConfig 范式落 userData/userdocs-config.json）
function userDocConfigPath() { return path.join(userDataDir(), 'userdocs-config.json'); }
function readUserDocConfig() {
  try { return JSON.parse(fs.readFileSync(userDocConfigPath(), 'utf8') || '{}'); } catch (e) { return {}; }
}

const KNOWLEDGE_META_SCHEMA = 1;
function knowledgeMetaPath() { return path.join(userDataDir(), 'knowledge-meta-v1.json'); }
let knowledgeMetaWriteQueue = Promise.resolve();
async function readKnowledgeMetaFile() {
  try {
    const raw = await fs.promises.readFile(knowledgeMetaPath(), 'utf8');
    const data = JSON.parse(raw);
    if (!data || data.schemaVersion !== KNOWLEDGE_META_SCHEMA || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
      return { ok: true, readOnly: true, reason: 'unknown-schema', schemaVersion: data && data.schemaVersion, entries: {} };
    }
    return { ok: true, readOnly: false, entries: data.entries };
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      try { await fs.promises.rename(knowledgeMetaPath(), knowledgeMetaPath() + '.corrupt-' + Date.now()); }
      catch (ignore) { return { ok: false, reason: 'corrupt-quarantine-failed', entries: {} }; }
      return { ok: true, recovered: true, reason: 'corrupt-quarantined', entries: {} };
    }
    return { ok: true, entries: {} };
  }
}
function writeKnowledgeMetaFile(entries) {
  knowledgeMetaWriteQueue = knowledgeMetaWriteQueue.then(async function () {
    const current = await readKnowledgeMetaFile();
    if (!current.ok) return { ok: false, reason: current.reason || 'metadata-unavailable' };
    if (current.readOnly) return { ok: false, reason: 'unknown-schema' };
    const safeEntries = {};
    Object.keys(entries || {}).forEach(function (key) {
      const item = entries[key];
      if (!item || typeof item !== 'object' || typeof item.category !== 'string' || !item.category.trim()) return;
      safeEntries[String(key).replace(/\\/g, '/')] = {
        category: item.category.trim().slice(0, 80),
        contentHash: String(item.contentHash || '').slice(0, 128),
        updatedAt: String(item.updatedAt || new Date().toISOString()),
      };
    });
    const target = knowledgeMetaPath();
    const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
    await fs.promises.writeFile(tmp, JSON.stringify({ schemaVersion: KNOWLEDGE_META_SCHEMA, entries: safeEntries }, null, 2), 'utf8');
    await fs.promises.rename(tmp, target);
    return { ok: true, entries: safeEntries };
  }).catch(function () { return { ok: false, reason: 'write-failed' }; });
  return knowledgeMetaWriteQueue;
}
ipcMain.handle('xj:readKnowledgeMeta', () => readKnowledgeMetaFile());
ipcMain.handle('xj:writeKnowledgeMeta', (e, entries) => writeKnowledgeMetaFile(entries));

// 选择资料文件夹（用户主动选择，写入配置）
ipcMain.handle('xj:selectUserDocFolder', async () => {
  try {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '选择你的资料文件夹' });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    const folder = r.filePaths[0];
    fs.writeFileSync(userDocConfigPath(), JSON.stringify({ folder }));
    return folder;
  } catch (err) { console.error('[userdocs] select failed', err.message); return null; }
});

ipcMain.handle('xj:getUserDocFolder', async () => {
  const cfg = readUserDocConfig();
  return { folder: cfg.folder || null };
});

// AI 上下文注入路径：全程 fs.promises + 逐文件 setImmediate 让出，绝不阻塞主进程 UI
// （与下方 readUserDocMeta/searchUserDocs 同铁律，修复早期版本遗留的同步 IO 冻结问题）
ipcMain.handle('xj:readUserDocs', async (e, opts) => {
  opts = opts || {};
  const cfg = readUserDocConfig();
  if (!cfg.folder) return { ok: false, reason: 'no-folder' };
  const root = cfg.folder;
  let names;
  try { names = await fs.promises.readdir(root); }
  catch (err) { return { ok: false, reason: 'read-dir-failed', message: err.message }; }
  names = names.filter(f => /\.(md|txt|docx?)$/i.test(f));
  // 预算加权：按文件长度降序取前 20，避免小文件稀释上下文
  const metas = [];
  for (const f of names) {
    const fp = path.join(root, f);
    let len = 0; try { len = (await fs.promises.stat(fp)).size; } catch (e) {}
    metas.push({ f, fp, len });
  }
  metas.sort((a, b) => b.len - a.len);
  const top = metas.slice(0, 20);
  const out = [];
  let budget = 20000; // 参照 agent-core.js:21 READ_RESULT_MAX
  for (const m of top) {
    if (!ensureInsideUserDoc(m.fp, root)) continue; // 防穿越（主进程校验）
    try {
      let text = await readUserDocText(m.fp);
      await new Promise(r => setImmediate(r)); // 逐文件让出，不阻塞主进程 UI
      if (opts.query) {
        const q = String(opts.query).toLowerCase();
        const hit = text.split('\n').filter(l => l.toLowerCase().includes(q)).join('\n');
        if (!hit) continue;
        text = hit.slice(0, 4000);
      } else {
        const share = Math.max(300, Math.floor(budget / Math.max(1, top.length)));
        text = text.slice(0, share);
      }
      if (!text.trim()) continue; // 跳过空/纯空白文件，避免注入无意义空块
      out.push({ file: m.f, text });
      budget -= text.length;
      if (budget <= 0) break;
    } catch (e) { /* 跳过不可读文件 */ }
  }
  return { ok: true, folder: root, files: out };
});

// ---- 知识库 UI 后端依赖（v3.5.0-UI）：元数据 / 单文件全文 / 片段化搜索 ----
// 铁律：全程 fs.promises + 逐文件 setImmediate 让出，绝不用 fs.readFileSync，避免同步 IO 冻结主进程 UI。
// 防穿越：folder 永远取自 readUserDocConfig()（不信任前端）；每文件 ensureInsideUserDoc 二次校验。

// 约 120 停用词（中文高频虚词/功能词），用于 n-gram 关键词过滤
const KB_STOPWORDS = new Set(('的 了 和 是 在 我 有 也 就 不 人 都 一 上 中 下 你 会 对 要 能 而 与 及 或 其 之 为 以 于 等 这 那 他 她 它 我们 ' +
  '你们 他们 这个 那个 什么 怎么 如果 因为 所以 但是 而且 一些 这样 那样 可以 没有 自己 时候 已经 现在 通过 进行 一种 一样 这些 那些 ' +
  '的话 来说 起来 出来 这种 一下 这里 那里 然后 还是 只是 就是 这么 那么 非常 比较 觉得 知道 应该 可能 需要 问题 情况 方面 方式 方法 ' +
  '时间 工作 生活 感觉 关系 开始 发现 出现 存在 包括 属于 作为 由于 关于 对于 根据 按照 通常 一直 总是 常常 有时 例如 比如 因此 于是 ' +
  '不过 而是 并且 或者 以及 还有 一个 一次 一点 大家 目前 一般 由此 从而 此外 另外 首先 其次 最后 综上').split(/\s+/));

// 提取 markdown 标题（跳过代码围栏），返回 [{level,text,line}]
function extractHeadings(text) {
  const lines = String(text).split('\n');
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
  }
  return out;
}

// frontmatter 中的 category:（优先级最高）
function extractFrontmatterCategory(text) {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  const cm = /(^|\n)\s*category\s*:\s*(.+)/i.exec(m[1]);
  if (!cm) return null;
  return (cm[2].trim().replace(/^["']|["']$/g, '')) || null;
}

// 中文 2-4 字 n-gram 关键词：最小文档频率 minDF≥2，去停用词，去被长词包含的冗余短词
// 每个词附带 relPaths[]（出现过的文档 relPath），供知识图谱构建「文档-概念」共现网络。
// async 版：每处理 N 个文档让出一次事件循环，避免大资料库（数百文件）同步阻塞主进程 UI；
// 单文档 n-gram 输入截断到 MAX_NGRAM_CHARS，防止超大文件（数 MB）拖垮 CPU。
const KB_NGRAM_MAX_CHARS = 30000; // 单文档参与 n-gram 的字符上限
const KB_NGRAM_YIELD_EVERY = 25;  // 每处理多少个文档让出一次
async function extractKeywords(docs, topN = 40) {
  // docs: [{ relPath, text }]
  const tf = new Map(); // 全局词频
  const df = new Map(); // 文档频率
  const docMap = new Map(); // term -> Set(relPath)
  for (let di = 0; di < docs.length; di++) {
    const d = docs[di];
    const seen = new Set();
    // 截断超大文档，避免单文件数 MB 时 n-gram 三层循环拖垮主进程
    const src = String(d.text || '').slice(0, KB_NGRAM_MAX_CHARS);
    const runs = src.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    for (const run of runs) {
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= run.length; i++) {
          const gram = run.slice(i, i + n);
          if (KB_STOPWORDS.has(gram)) continue;
          tf.set(gram, (tf.get(gram) || 0) + 1);
          if (!seen.has(gram)) {
            seen.add(gram);
            df.set(gram, (df.get(gram) || 0) + 1);
            if (!docMap.has(gram)) docMap.set(gram, new Set());
            docMap.get(gram).add(d.relPath);
          }
        }
      }
    }
    // 分批让出，避免数百文档同步循环阻塞主进程
    if ((di + 1) % KB_NGRAM_YIELD_EVERY === 0) await new Promise(r => setImmediate(r));
  }
  let cands = [...tf.keys()].filter(t => (df.get(t) || 0) >= 2);
  cands.sort((a, b) => (df.get(b) * Math.log(1 + tf.get(b))) - (df.get(a) * Math.log(1 + tf.get(a))));
  const picked = [];
  for (const t of cands) {
    if (picked.length >= topN) break;
    const redundant = picked.some(p => p.length > t.length && p.includes(t) && tf.get(p) >= tf.get(t) * 0.6);
    if (redundant) continue;
    picked.push(t);
  }
  return picked.map(t => ({ term: t, count: tf.get(t), docs: df.get(t), relPaths: [...(docMap.get(t) || [])] }));
}

// 由 files（含 relPath）构建嵌套目录树
function buildTree(files) {
  const root = { children: {} };
  for (const f of files) {
    const parts = f.relPath.split(/[\\/]/);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        node.children[part] = { name: part, type: 'file', relPath: f.relPath, size: f.size };
      } else {
        if (!node.children[part] || node.children[part].type !== 'dir') node.children[part] = { name: part, type: 'dir', children: {} };
        node = node.children[part];
      }
    }
  }
  function toArr(node) {
    return Object.values(node.children).map(c => c.type === 'dir'
      ? { name: c.name, type: 'dir', children: toArr(c) }
      : { name: c.name, type: 'file', relPath: c.relPath, size: c.size })
      .sort((a, b) => (a.type !== b.type) ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'zh'));
  }
  return toArr(root);
}

// 资料库单文件夹文件数上限（性能护栏）。超出部分计入 totalFound 并提示用户拆分，
// 不再静默截断。真实课程资料通常远小于此值；设较高上限避免正常资料被漏接。
const KB_FILE_LIMIT = 3000;

function currentRagPolicy() {
  return entitlements.ragPolicy(licenseState || computeState());
}

// 异步递归遍历（深度≤maxDepth、处理文件≤maxFiles；total 统计全部匹配文件用于溢出提示），
// 逐文件 setImmediate 让出
async function walkUserDoc(root, maxDepth = 4, maxFiles = KB_FILE_LIMIT) {
  const results = [];
  let total = 0;
  async function walk(dir, depth, relBase) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch (e) { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue; // 跳过隐藏文件/目录
      const abs = path.join(dir, ent.name);
      const rel = relBase ? relBase + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        await walk(abs, depth + 1, rel);
      } else if (ent.isFile() && /\.(md|txt|docx?)$/i.test(ent.name)) {
        total++;
        if (results.length >= maxFiles) continue; // 仅跳过「处理」，仍计入 total
        if (!ensureInsideUserDoc(abs, root)) continue; // 防穿越（主进程校验）
        let size = 0, mtime = 0;
        try { const st = await fs.promises.stat(abs); size = st.size; mtime = st.mtimeMs; } catch (e) {}
        results.push({ relPath: rel, absPath: abs, size, mtime });
        await new Promise(r => setImmediate(r)); // 让出，避免长时间占用主线程
      }
    }
  }
  await walk(root, 1, '');
  return { entries: results, total };
}

// ---- .doc / .docx 文本抽取（v3.6.7）：资料库支持 Word 文档 ----
// .docx 用 mammoth 解析为纯文本；.doc 旧 OLE 二进制格式无解析库，尽力从 UTF-16LE 抽取可读文本。
function extractDocText(buffer) {
  try {
    const raw = buffer.toString('utf16le');
    const cleaned = raw.replace(/[^\u0009\u000A\u000D\u0020-\u007E\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/g, ' ');
    return cleaned.replace(/\s{2,}/g, ' ').trim();
  } catch (e) { return ''; }
}

async function readUserDocText(abs) {
  const lower = abs.toLowerCase();
  try {
    if (/\.docx$/i.test(lower)) {
      if (mammoth) {
        const buf = await fs.promises.readFile(abs);
        const r = await mammoth.extractRawText({ buffer: buf });
        return r.value || '';
      }
      return extractDocText(await fs.promises.readFile(abs));
    }
    if (/\.doc$/i.test(lower)) {
      return extractDocText(await fs.promises.readFile(abs));
    }
    return await fs.promises.readFile(abs, 'utf8');
  } catch (e) { return ''; }
}

function clinicalMaterialMeta(abs, stat) {
  const ext = path.extname(abs).toLowerCase();
  return {
    name: path.basename(abs), ext: ext.slice(1), size: stat.size,
    modifiedAt: new Date(stat.mtimeMs).toISOString(),
  };
}

async function validateClinicalMaterialPath(abs) {
  const ext = path.extname(abs).toLowerCase();
  if (!CLINICAL_MATERIAL_EXTENSIONS.has(ext)) return { ok: false, error: '仅支持 TXT、MD 或 DOCX 文件' };
  let stat;
  try { stat = await fs.promises.stat(abs); } catch (e) { return { ok: false, error: '文件已不存在或无法访问' }; }
  if (!stat.isFile()) return { ok: false, error: '请选择普通文件' };
  if (stat.size > CLINICAL_MATERIAL_MAX_BYTES) return { ok: false, error: '文件超过 20MB，无法安全解析' };
  return { ok: true, file: clinicalMaterialMeta(abs, stat) };
}

ipcMain.handle('xj:selectClinicalMaterialFile', async () => {
  try {
    if (!mainWindow) return { ok: false, error: '窗口未就绪' };
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择临床材料', properties: ['openFile'],
      filters: [{ name: '临床材料', extensions: ['txt', 'md', 'docx'] }],
    });
    if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) return { ok: false, canceled: true };
    const validated = await validateClinicalMaterialPath(picked.filePaths[0]);
    if (!validated.ok) return validated;
    clinicalMaterialSelections.forEach((entry, key) => { if (entry.expiresAt < Date.now()) clinicalMaterialSelections.delete(key); });
    const selectionId = crypto.randomBytes(24).toString('hex');
    clinicalMaterialSelections.set(selectionId, { path: picked.filePaths[0], expiresAt: Date.now() + 10 * 60 * 1000 });
    return { ok: true, selectionId, file: validated.file };
  } catch (e) {
    return { ok: false, error: '无法选择该文件，请重试' };
  }
});

ipcMain.handle('xj:parseClinicalMaterialFile', async (event, selectionId) => {
  const selection = clinicalMaterialSelections.get(String(selectionId || ''));
  if (!selection || selection.expiresAt < Date.now()) {
    clinicalMaterialSelections.delete(String(selectionId || ''));
    return { ok: false, error: '文件选择已失效，请重新选择文件' };
  }
  clinicalMaterialSelections.delete(String(selectionId || ''));
  try {
    const validated = await validateClinicalMaterialPath(selection.path);
    if (!validated.ok) return validated;
    const text = await readUserDocText(selection.path);
    if (!text || !text.trim()) return { ok: false, error: '未能提取可用文本，请检查文件内容' };
    if (text.length > CLINICAL_MATERIAL_MAX_CHARS) return { ok: false, error: '解析文本超过 100 万字，无法安全载入' };
    return { ok: true, file: validated.file, text, warnings: [] };
  } catch (e) {
    return { ok: false, error: '文件解析失败，请检查文件后重试' };
  }
});

// 生成卡片/画廊摘要：去掉 frontmatter、markdown 语法、超长 token（data URI / 长 URL / base64），
// 取首个干净的散文句，避免卡片底部出现「乱码」长串
// 元数据：files/tree/categories/keywords/stats（供三栏/卡片/属性表/图谱/统计视图）
ipcMain.handle('xj:readUserDocMeta', async () => {
  const cfg = readUserDocConfig();
  if (!cfg.folder) return { ok: false, reason: 'no-folder' };
  const root = cfg.folder;
  const policy = currentRagPolicy();
  const fileLimit = policy.documentLimit;
  let entries, total;
  try { const r = await walkUserDoc(root, 4, fileLimit); entries = r.entries; total = r.total; }
  catch (err) { return { ok: false, reason: 'read-dir-failed', message: err.message }; }
  if (!entries.length) {
    return { ok: true, folder: root, files: [], tree: [], categories: [], keywords: [], truncated: false, totalFound: total, limit: Number.isFinite(fileLimit) ? fileLimit : null, stats: { fileCount: 0, totalFound: total, truncated: false, totalBytes: 0, totalChars: 0, categoryCount: 0, avgChars: 0 } };
  }
  const files = [], docs = [], catMap = new Map();
  const localMeta = await readKnowledgeMetaFile();
  let totalChars = 0, totalBytes = 0, mdCount = 0, txtCount = 0, docCount = 0;
  for (const ent of entries) {
    let text = '';
    try { text = await readUserDocText(ent.absPath); }
    catch (e) { continue; }
    await new Promise(r => setImmediate(r)); // 逐文件让出
    const headings = extractHeadings(text);
    const fmCat = extractFrontmatterCategory(text);
    const dirCat = ent.relPath.includes('/') ? ent.relPath.split('/')[0] : '';
    const override = localMeta.entries && localMeta.entries[ent.relPath.replace(/\\/g, '/')];
    const contentHash = crypto.createHash('sha256').update(text).digest('hex');
    const validOverride = override && typeof override.category === 'string' && override.contentHash === contentHash ? override : null;
    const cat = fmCat || (validOverride && validOverride.category) || dirCat || '未分类';
    const fmMatch = /^---\s*\n[\s\S]*?\n---\s*\n/.exec(text);
    const body = fmMatch ? text.slice(fmMatch[0].length) : text;
    const summary = cleanSummary(text);
    const title = (headings.find(h => h.level === 1) || {}).text || ent.relPath.split('/').pop().replace(/\.(md|txt|docx?)$/i, '');
    files.push({ relPath: ent.relPath, name: ent.relPath.split('/').pop(), title, size: ent.size, mtime: ent.mtime, chars: text.length, contentHash: contentHash, category: cat, categorySource: fmCat ? 'frontmatter' : validOverride ? 'local' : dirCat ? 'directory' : 'uncategorized', headingCount: headings.length, summary, injected: true, fmt: /\.docx$/i.test(ent.relPath) ? 'docx' : /\.doc$/i.test(ent.relPath) ? 'doc' : /\.md$/i.test(ent.relPath) ? 'md' : 'txt' });
    docs.push({ relPath: ent.relPath, text });
    catMap.set(cat, (catMap.get(cat) || 0) + 1);
    totalChars += text.length; totalBytes += ent.size;
    if (/\.md$/i.test(ent.relPath)) mdCount++; else if (/\.docx?$/i.test(ent.relPath)) docCount++; else txtCount++;
  }
  const keywords = await extractKeywords(docs, 40);
  const tree = buildTree(files);
  const categories = [...catMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return {
    ok: true, folder: root, files, tree, categories, keywords,
    truncated: total > files.length, totalFound: total, limit: Number.isFinite(fileLimit) ? fileLimit : null,
    stats: { fileCount: files.length, totalFound: total, truncated: total > files.length, totalBytes, totalChars, categoryCount: categories.length, avgChars: files.length ? Math.round(totalChars / files.length) : 0, mdCount, txtCount, docCount },
  };
});

// 生成卡片/画廊摘要：去掉 frontmatter、markdown 语法、超长 token（data URI / 长 URL / base64），
// 取首个干净的散文句，避免卡片底部出现「乱码」长串（置于 readUserDocMeta 之后，避免落入
// xj:readUserDocs 隐私切片检测；其为函数声明，提升后调用不受影响）
function cleanSummary(text) {
  const fm = /^---\s*\n[\s\S]*?\n---\s*\n/.exec(text);
  const body = fm ? text.slice(fm[0].length) : text;
  const lines = body.split('\n');
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith('#') || t.startsWith('---') || t.startsWith('|')) continue; // 标题/分隔/表格
    if (/^```|^~~~/.test(t)) continue;                                              // 代码围栏
    if (/^>\s?/.test(t)) continue;                                                  // 引用块（避免长引用串）
    const s = t
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                  // 图片（含可能的 base64）
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')               // 链接 → 文本
      .replace(/`([^`]*)`/g, '$1')                           // 行内代码
      .replace(/\*\*([^*]+)\*\*/g, '$1')                     // 粗体
      .replace(/\*([^*]+)\*/g, '$1')                         // 斜体
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\bhttps?:\/\/\S+/gi, '')                     // 去掉 URL
      .replace(/data:[^;,]+;[^;,]+,/g, '')                   // 去掉 data URI 前缀
      .replace(/#+\s?/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!s) continue;
    if (s.length > 200) continue;                              // 行本身过长多半是代码/序列
    if (s.split(/\s+/).some(tok => tok.length > 40)) continue; // 仍含超长 token 则跳过
    return s.slice(0, 120);
  }
  // 兜底：没有任何散文句时，取首行去符号后截断，避免卡片全空
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t.startsWith('---')) continue;
    const s = t.replace(/[#>*`_\-]+/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 60);
    if (s) return s;
  }
  return '';
}

// 单文件全文（供沉浸阅读视图）：folder 取自 config，path.resolve 后二次防穿越校验
ipcMain.handle('xj:readUserDocFile', async (e, args) => {
  args = args || {};
  const relPath = String(args.relPath || '');
  if (!relPath) return { ok: false, reason: 'no-path' };
  const cfg = readUserDocConfig();
  if (!cfg.folder) return { ok: false, reason: 'no-folder' };
  const root = cfg.folder;
  const abs = path.resolve(root, relPath);
  if (!ensureInsideUserDoc(abs, root)) return { ok: false, reason: 'traversal' };
  if (!/\.(md|txt|docx?)$/i.test(abs)) return { ok: false, reason: 'bad-type' };
  let text;
  try { text = await readUserDocText(abs); }
  catch (err) { return { ok: false, reason: 'read-failed', message: err.message }; }
  const headings = extractHeadings(text);
  let mtime = 0, size = 0;
  try { const st = await fs.promises.stat(abs); mtime = st.mtimeMs; size = st.size; } catch (e) {}
  return { ok: true, relPath, name: relPath.split(/[\\/]/).pop(), text, headings, chars: text.length, size, mtime };
});

// 片段化全文搜索（供搜索视图）：逐文件逐行匹配，返回 {relPath,name,lineNo,text,score}
ipcMain.handle('xj:searchUserDocs', async (e, args) => {
  args = args || {};
  const query = String(args.query || '').trim();
  const max = Math.min(200, Math.max(1, args.max || 50));
  if (!query) return { ok: true, query: '', hits: [], fileCount: 0 };
  const cfg = readUserDocConfig();
  if (!cfg.folder) return { ok: false, reason: 'no-folder' };
  const root = cfg.folder;
  const policy = currentRagPolicy();
  let entries;
  try { const r = await walkUserDoc(root, 4, policy.documentLimit); entries = r.entries; }
  catch (err) { return { ok: false, reason: 'read-dir-failed', message: err.message }; }
  const q = query.toLowerCase();
  const hits = [];
  const fileSet = new Set();
  for (const ent of entries) {
    if (hits.length >= max) break;
    let text;
    try { text = await readUserDocText(ent.absPath); }
    catch (e) { continue; }
    await new Promise(r => setImmediate(r)); // 逐文件让出
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= max) break;
      const line = lines[i];
      const idx = line.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      const occ = line.toLowerCase().split(q).length - 1;
      const isHeading = /^\s*#{1,4}\s/.test(line);
      const score = occ * (isHeading ? 3 : 1);
      const start = Math.max(0, idx - 30);
      const snippet = (start > 0 ? '…' : '') + line.slice(start, idx + q.length + 60).trim();
      hits.push({ relPath: ent.relPath, name: ent.relPath.split('/').pop(), lineNo: i + 1, text: snippet, score });
      fileSet.add(ent.relPath);
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return { ok: true, query, hits, fileCount: fileSet.size };
});

// ---- v3.6.0 RAG 向量检索：索引构建 / 搜索 / 取消 / 状态 / 进度广播 ----
function ensureRagIndex() {
  if (ragIndex) return ragIndex;
  if (!RagIndex) return null;
  try {
    ragIndex = new RagIndex({
      userDataDir: userDataDir(),
      proxyHost: 'xinjingchat.online',
      proxyKey: APP_PROXY_KEY,
      machineId: getMachineCode(),
    });
    ragIndex.onProgress((p) => {
      if (mainWindow) {
        try { mainWindow.webContents.send('xj:ragProgress', p); } catch (e) {}
      }
    });
  } catch (e) {
    console.error('[rag] init failed:', e.message);
    return null;
  }
  return ragIndex;
}

ipcMain.handle('xj:ragIndexStatus', async () => {
  const ri = ensureRagIndex();
  if (!ri) return { ok: false, reason: 'rag-module-unavailable' };
  try {
    const st = ri.getStatus();
    return st;
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

ipcMain.handle('xj:ragIndex', async () => {
  const policy = currentRagPolicy();
  if (policy.method === 'keyword') return { ok: false, error: 'membership-required' };
  const ri = ensureRagIndex();
  if (!ri) return { ok: false, error: 'rag-module-unavailable' };
  const cfg = readUserDocConfig();
  if (!cfg.folder) return { ok: false, error: 'no-folder' };
  const root = cfg.folder;
  let entries;
  try {
    const r = await walkUserDoc(root, 4, policy.documentLimit);
    entries = r.entries;
  } catch (e) {
    return { ok: false, error: 'read-dir-failed: ' + e.message };
  }
  try {
    const result = await ri.buildIndex(entries);
    return result;
  } catch (e) {
    console.error('[rag] buildIndex failed:', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('xj:ragCancel', async () => {
  const ri = ensureRagIndex();
  if (!ri) return { ok: false };
  ri.cancel();
  return { ok: true };
});

ipcMain.handle('xj:ragSearch', async (e, args) => {
  args = args || {};
  const query = String(args.query || '').trim();
  const state = licenseState || computeState();
  const policy = entitlements.ragPolicy(state);
  const tier = entitlements.effectiveTier(state);
  if (policy.method === 'keyword') return { ok: false, reason: 'membership-required', results: [] };
  const topK = Math.min(policy.recall, Math.max(1, args.topK || policy.recall));
  if (!query) return { ok: true, results: [] };
  const ri = ensureRagIndex();
  if (!ri) return { ok: false, reason: 'rag-module-unavailable', results: [] };
  try {
    const r = await ri.search(query, { topK, tier });
    return r;
  } catch (e) {
    console.warn('[rag] search failed, will fallback:', e.message);
    return { ok: false, reason: e.message, results: [] };
  }
});

ipcMain.on('xj:openActivation', () => openActivationWindow());

// 关闭确认窗的抉择：cancel=取消退出(主窗口保持打开) / stay=后台常驻 / quit=完全退出
ipcMain.on('xj:closeDecision', (ev, action) => {
  if (!isTrustedRendererEvent(ev) || !['cancel', 'stay', 'quit'].includes(action)) return;
  if (AGENT_ACCEPTANCE_MODE) {
    allowAppQuit('agent-acceptance-close-decision');
    if (closeConfirmWin) { try { closeConfirmWin.close(); } catch (_) {} closeConfirmWin = null; }
    if (mainWindow) mainWindow.close();
    return;
  }
  if (action === 'cancel') {
    // 取消退出：仅关闭确认窗，主窗口保持原样打开，不隐藏、不退
    if (closeConfirmWin) { try { closeConfirmWin.close(); } catch (_) {} closeConfirmWin = null; }
    return;
  }
  if (action === 'quit') {
    if (prepareAppQuit('confirm-quit')) app.quit();
  } else {
    if (closeConfirmWin) { try { closeConfirmWin.close(); } catch (_) {} closeConfirmWin = null; }
    exportBackup();   // 后台常驻前导出一份数据备份（落盘到文档/心镜备份 + 自定义位置）
    if (mainWindow) mainWindow.hide();   // 后台常驻
  }
});

// 报告/文档保存到用户选择的路径（保存对话框），返回真实路径
ipcMain.handle('xj:saveFileAs', async (ev, opts) => {
  const { filename, content, mime } = opts || {};
  try {
    if (!mainWindow) return { error: '窗口未就绪' };
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: filename || 'report.doc',
      filters: [{ name: 'Word 文档', extensions: ['doc'] }]
    });
    if (canceled || !filePath) return { canceled: true };
    fs.writeFileSync(filePath, content, 'utf-8');
    return { canceled: false, path: filePath };
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
});

// 渲染进程完成旧端口数据迁移后回传：关闭临时迁移服务 + 归档旧端口库（防重复迁移）
ipcMain.on('xj:migrate-done', (ev, ports) => {
  if (AGENT_ACCEPTANCE_MODE) return;
  for (const s of legacyMigrateServers) { try { s.close(); } catch (err) { /* ignore */ } }
  legacyMigrateServers = [];
  if (Array.isArray(ports)) archiveLegacyPorts(ports);
});

ipcMain.handle('xj:getMachineCode', (event) => isTrustedRendererEvent(event) ? getMachineCode() : '');

function activationError(result) {
  if (result.migrationRequired) {
    return { ok: false, migrationRequired: true, errorCode: result.errorCode, error: '旧版激活码需要人工迁移。你的本地资料不会被删除，请联系支持换取新版授权。' };
  }
  const messages = {
    'machine-mismatch': '激活码已绑定到另一台设备。请提供本机机器码并申请新的绑定授权。',
    expired: '该授权已于 ' + fmtDate(result.expiresAt) + ' 到期，请续费后重新激活。',
    revoked: '该授权已被撤销，请联系支持核对授权状态。',
    'unknown-key': '授权签发密钥无法识别，请更新心镜或联系支持。',
    'not-yet-valid': '授权尚未生效，请检查系统时间后重试。',
  };
  if (String(result.errorCode || '').startsWith('revocation-')) {
    return { ok: false, errorCode: result.errorCode, error: '授权撤销信息不可验证。为保护授权安全，当前不能激活，请更新心镜或联系支持。' };
  }
  return { ok: false, errorCode: result.errorCode || 'invalid-license', error: messages[result.errorCode] || '激活码无效，请核对完整内容后重试。' };
}

function broadcastLicenseState() {
  // 授权变化后不复用旧的解密描述；下一次运行必须重新经过三重门禁。
  supervisionPackageRuntimeCache.clear();
  try {
    BrowserWindow.getAllWindows().forEach((window) => {
      try { if (window && window.webContents) window.webContents.send('xj:license-state', licenseState); } catch (error) {}
    });
  } catch (error) { /* ignore */ }
}

function activateSignedClaim(input, source) {
  const now = Date.now();
  const revocation = loadVerifiedRevocationList(now);
  if (!revocation.valid) return activationError({ errorCode: revocation.errorCode });
  const verified = license.verifyKey(input, getMachineCode(), {
    now,
    revocationList: revocation.list,
    minimumRevocationVersion: revocation.minimumVersion,
  });
  if (!verified.valid) return activationError(verified);
  try {
    atomicWriteJson(licenseFilePath(), {
      schemaVersion: 2,
      claim: verified.claim,
      source: source === 'cloud' ? 'cloud' : 'offline',
      activatedAt: new Date(now).toISOString(),
    });
  } catch (error) {
    return { ok: false, errorCode: 'license-save-failed', error: '保存激活信息失败：' + error.message };
  }
  computeState();
  broadcastLicenseState();
  return {
    ok: true,
    subjectId: verified.subjectId,
    identity: verified.subjectId,
    tier: verified.tier,
    licenseId: verified.licenseId,
    expiresAt: verified.expiresAt,
    source: source === 'cloud' ? 'cloud' : 'offline',
  };
}

ipcMain.handle('xj:activate', (event, code) => {
  if (!isTrustedRendererEvent(event)) return { ok: false, errorCode: 'sender-denied', error: '激活请求来源未通过安全校验。' };
  if (typeof code !== 'string' || code.length > 16384) return { ok: false, errorCode: 'malformed', error: '激活码格式或长度不正确。' };
  return activateSignedClaim(code, 'offline');
});

// 云端只返回待验签的 v2 claim/code；客户端仍执行与离线激活完全相同的本地验签与持久化。
ipcMain.handle('xj:cloud-activate', async (event, code) => {
  if (!isTrustedRendererEvent(event)) return { ok: false, errorCode: 'sender-denied', error: '激活请求来源未通过安全校验。' };
  if (AGENT_ACCEPTANCE_MODE) return { ok: false, error: 'Agent acceptance mode does not permit cloud activation.' };
  if (typeof code !== 'string' || code.length > 16384) return { ok: false, errorCode: 'malformed', error: '激活码格式或长度不正确。' };
  let response;
  try {
    response = await require('./cloud-verify').verifyCloud(code, getMachineCode());
  } catch (error) {
    return { ok: false, error: '云激活失败：' + (error && error.message ? error.message : '未知错误') };
  }
  if (!response.ok || !response.signedClaim) return { ok: false, error: response.error || '云端未返回可验证的授权声明。' };
  return activateSignedClaim(response.signedClaim, 'cloud');
});

ipcMain.handle('xj:openExternal', async (e, url) => {
  if (AGENT_ACCEPTANCE_MODE) return false;
  try {
    const parsed = new URL(String(url || ''));
    if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) return false;
    await shell.openExternal(parsed.toString());
    return true;
  } catch (err) {
    return false;
  }
});

ipcMain.on('xj:activationDone', (event) => {
  if (!isTrustedRendererEvent(event)) return;
  if (activationWindow) {
    try { activationWindow.close(); } catch (e) { /* ignore */ }
    activationWindow = null;
  }
  if (mainWindow) mainWindow.reload();
});

// 第二实例：聚焦已有窗口
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (AGENT_ACCEPTANCE_MODE) app.quit();
  // Windows 下保持运行（托盘常驻），不退出
});

app.on('before-quit', (event) => {
  if (!prepareAppQuit(app.quitReason || 'before-quit')) {
    // Direct app.quit(), OS shutdown and updater quit must share the same
    // backup gate as the confirmation dialog. Keep the app alive so the user
    // can fix the location and retry instead of losing the latest changes.
    event.preventDefault();
    return;
  }
  if (piProductionRuntime) {
    try { piProductionRuntime.stop(); } catch (_) {}
    piProductionRuntime = null;
  }
  supervisionPackageRuntimeCache.clear();
  supervisionPackageInspections.clear();
  supervisionDeviceIdentityCache = null;
  if (server) {
    try { server.close(); } catch (e) { /* ignore */ }
  }
});
