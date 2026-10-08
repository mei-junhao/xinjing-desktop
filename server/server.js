'use strict';
/**
 * 心镜 XinJing — 韩国代理服务端 (v1.8.1)
 *
 * 路由：
 *  - GET  /                      健康检查（含代理配置状态）
 *  - POST /                      旧版 DeepSeek 透传（向后兼容，保留）
 *  - POST /v1/chat/completions   试用代理（按机器码配额门控 + 模型路由）
 *  - GET  /quota?mid=<machineId> 配额查询
 *  - POST /v1/embeddings         知识库向量检索（bge-m3，Pro/旗舰）
 *  - POST /v1/rerank             知识库重排序（bge-reranker-v2-m3，旗舰）
 *
 * 安全模型：
 *  - 共享密钥(APP_PROXY_KEY) + 机器码(X-Machine-Id) 双因子；
 *  - 服务端按机器码硬限额兜底（客户端密钥被逆向也不怕刷量）；
 *  - 免费档：DeepSeek-V4-Flash 受 ¥5 / 30天 滚动窗口限制，超额/过期自动降级到
 *    内置基础模型 Qwen3.5-4B（走 SiliconFlow，不限量免费）。
 *  - RAG：embedding 按文档数天然限流，rerank 按每天 200 次/机器码限制。
 *
 * 密钥全部来自 .env（dotenv），代码不含任何明文密钥。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
const stats = require('./stats')
const convSave = require('./conv-save')
const tts = require('./tts');
const { AccountAuth } = require('./account-auth');
const { ResendEmailAdapter } = require('./resend-email-adapter');

const PORT_HTTPS = 443;
const PORT_HTTP = 80;
const CERT_DIR = '/etc/letsencrypt/live/xinjingchat.online';
const DATA_DIR = process.env.XJ_DATA_DIR ? path.resolve(process.env.XJ_DATA_DIR) : path.join(__dirname, 'data');
const QUOTA_FILE = path.join(DATA_DIR, 'quota.json');

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_UPSTREAM_URL = process.env.DEEPSEEK_UPSTREAM_URL || 'https://api.deepseek.com/v1/chat/completions';
const SILICONFLOW_KEY = process.env.SILICONFLOW_API_KEY || '';
const OPENCODE_KEY = process.env.OPENCODE_KEY || '';
const OPENCODE_HOST = 'opencode.ai';
const OPENCODE_PORT = 443;
const OPENCODE_PATH = '/zen/go/v1/chat/completions';
const SF_EMBEDDING_KEY = process.env.SF_EMBEDDING_KEY || SILICONFLOW_KEY;
const SF_RERANK_KEY = process.env.SF_RERANK_KEY || SILICONFLOW_KEY;
const APP_PROXY_KEY = process.env.APP_PROXY_KEY || '';
const SKYAPI_KEY = process.env.SKYAPI_KEY || '';
const SKYAPI_HOST = process.env.SKYAPI_HOST || 'skyapi2026.com';
const SKYAPI_PORT = 443;
const SKYAPI_PATH = process.env.SKYAPI_PATH || '/v1/chat/completions';
// 2026-08-02 gemini 线路（hyhawang 中转站）
const GEMINI_KEY = process.env.GEMINI_KEY || '';
const GEMINI_HOST = process.env.GEMINI_HOST || 'api.hyhawang.com';
// 2026-08-02 claude 线路（hyhawang，独立 key——gemini key 不支持 claude）
const CLAUDE_KEY = process.env.CLAUDE_KEY || '';
const GEMINI_PORT = 443;
const GEMINI_PATH = process.env.GEMINI_PATH || '/v1/chat/completions';
const QUOTA_BUDGET = parseFloat(process.env.QUOTA_BUDGET_YUAN || '5');
const RERANK_DAILY_LIMIT = parseInt(process.env.RERANK_DAILY_LIMIT || '200', 10);
const QUOTA_WINDOW_DAYS = parseInt(process.env.QUOTA_WINDOW_DAYS || '30', 10);
const QUOTA_WINDOW_MS = QUOTA_WINDOW_DAYS * 24 * 3600 * 1000;
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';   // 空串=关闭 token 校验
const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || '10', 10) || 10;
const RATE_LIMIT_ROUNDTABLE_PER_MIN = parseInt(process.env.RATE_LIMIT_ROUNDTABLE_PER_MIN || '30', 10) || 30;   // roundtable 一次多请求，单独放宽
const PROXY_SIG_WINDOW_SEC = parseInt(process.env.PROXY_SIG_WINDOW_SEC || '300', 10) || 300;   // HMAC 签名时间戳窗口 ±5 分钟

// 模型目录是服务端唯一权威来源：客户端只能读取公开投影，不能自行定价或指定兜底模型。
const MODEL_CATALOG_FILE = path.join(__dirname, 'model-catalog.json');
// 客户端主力模型的稳定契约；Qwen 仅能由服务端在主力失败时兜底，其他目录条目不对外暴露。
const CLIENT_PRIMARY_MODEL_IDS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash', 'gpt-5.6']);
let modelCatalog = { schemaVersion: 1, catalogRevision: 'unavailable', settlementCurrency: 'CNY', fxRateUsdToCny: 7, models: [] };
try {
  const parsedCatalog = JSON.parse(fs.readFileSync(MODEL_CATALOG_FILE, 'utf8'));
  if (parsedCatalog && Array.isArray(parsedCatalog.models) && parsedCatalog.models.length) modelCatalog = parsedCatalog;
} catch (e) {
  console.error('[model-catalog] 读取失败，模型路由将 fail-closed：' + e.message);
}

function catalogModel(requested) {
  const value = String(requested || '').trim().toLowerCase();
  if (!value) return null;
  return modelCatalog.models.find((entry) => {
    if (!entry || entry.active !== true) return false;
    const names = [entry.modelId, entry.upstreamModel].concat(Array.isArray(entry.aliases) ? entry.aliases : []);
    return names.some((name) => String(name || '').trim().toLowerCase() === value);
  }) || null;
}

function isCatalogFallback(entry) {
  return !!entry && String(entry.modelId || '') === 'Qwen/Qwen3.5-4B';
}

function publicModelCatalog() {
  return {
    schemaVersion: Number(modelCatalog.schemaVersion) || 1,
    catalogRevision: String(modelCatalog.catalogRevision || ''),
    settlementCurrency: String(modelCatalog.settlementCurrency || 'CNY'),
    fxRateUsdToCny: Number(modelCatalog.fxRateUsdToCny) || 7,
    billingUnit: String(modelCatalog.billingUnit || 'per-1M-tokens'),
    models: modelCatalog.models.filter((entry) => entry && entry.active === true && (CLIENT_PRIMARY_MODEL_IDS.has(String(entry.modelId || '')) || isCatalogFallback(entry))).map((entry) => ({
      modelId: String(entry.modelId || ''),
      displayName: String(entry.displayName || entry.modelId || ''),
      provider: String(entry.provider || ''),
      upstreamModel: String(entry.upstreamModel || ''),
      aliases: Array.isArray(entry.aliases) ? entry.aliases.map((v) => String(v)) : [],
      inputPrice: Number(entry.inputPrice) || 0,
      outputPrice: Number(entry.outputPrice) || 0,
      cachedInputPrice: entry.cachedInputPrice == null ? null : Number(entry.cachedInputPrice),
      currency: String(entry.currency || 'USD'),
      billingUnit: String(entry.billingUnit || modelCatalog.billingUnit || 'per-1M-tokens'),
      catalogRevision: String(entry.catalogRevision || modelCatalog.catalogRevision || ''),
      capabilities: entry.capabilities && typeof entry.capabilities === 'object' ? {
        chat: entry.capabilities.chat === true,
        streaming: entry.capabilities.streaming === true,
        tools: entry.capabilities.tools === true,
        contextTokens: Number(entry.capabilities.contextTokens) || 0,
      } : { chat: true, streaming: false, tools: false, contextTokens: 0 },
      fallbackOnly: isCatalogFallback(entry),
    })),
  };
}

function modelCostYuan(entry, usage) {
  if (!entry || isCatalogFallback(entry) || !usage || typeof usage !== 'object') return 0;
  const inputTokens = Math.max(0, Number(usage.prompt_tokens) || 0);
  const outputTokens = Math.max(0, Number(usage.completion_tokens) || 0);
  const cachedTokens = Math.min(inputTokens, Math.max(0, Number(usage.prompt_cache_hit_tokens) || 0));
  const inputPrice = Number(entry.inputPrice) || 0;
  const cachedPrice = entry.cachedInputPrice == null ? inputPrice : (Number(entry.cachedInputPrice) || 0);
  const outputPrice = Number(entry.outputPrice) || 0;
  const fx = Number(modelCatalog.fxRateUsdToCny) || 7;
  const usd = ((inputTokens - cachedTokens) * inputPrice + cachedTokens * cachedPrice + outputTokens * outputPrice) / 1000000;
  return usd * fx;
}

function parseUpstreamUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl || '')); } catch (e) {
    throw new Error('DEEPSEEK_UPSTREAM_URL must be a valid URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error('DEEPSEEK_UPSTREAM_URL must use HTTPS without URL credentials or fragments');
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw new Error('DEEPSEEK_UPSTREAM_URL must include an upstream request path');
  }
  return {
    hostname: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 443,
    path: parsed.pathname + parsed.search,
  };
}

const DEEPSEEK_UPSTREAM = parseUpstreamUrl(DEEPSEEK_UPSTREAM_URL);

// Preserve the Qwen thinking switch while rebuilding the upstream payload.
// Only the supported boolean is forwarded across the proxy boundary.
function copyChatTemplateKwargs(data, payload) {
  const kwargs = data && data.chat_template_kwargs;
  if (!kwargs || typeof kwargs !== 'object' || Array.isArray(kwargs)) return;
  if (typeof kwargs.enable_thinking !== 'boolean') return;
  payload.chat_template_kwargs = { enable_thinking: kwargs.enable_thinking };
}

// ---------- 配额存储（进程内缓存 + 同步落盘，单进程内读改写原子）----------
let quotaStore = {};
function loadQuota() {
  try { quotaStore = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8')) || {}; } catch (e) { quotaStore = {}; }
}
function saveQuota() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(quotaStore, null, 2));
  } catch (e) { console.error('[quota] 持久化失败', e.message); }
}
loadQuota();

// ---------- 账号鉴权（rework-004 staged registration + Resend 邮箱验证；会员授权不经 HTTP）----------
const ACCOUNT_DATA_FILE = path.join(DATA_DIR, 'accounts.sqlite');
const ACCOUNT_RATE_LIMIT_PER_MIN = parseInt(process.env.ACCOUNT_RATE_LIMIT_PER_MIN || '10', 10) || 10;
const ACCOUNT_BODY_MAX = 64 * 1024;
const ACCOUNT_REQ_TIMEOUT_MS = 10000;
let accountAuth = null;
try {
  accountAuth = new AccountAuth({ dataFile: ACCOUNT_DATA_FILE });
} catch (e) {
  // 账号存储损坏：账号路由 fail-closed，但不拖垮既有 /v1、/quota 服务
  console.error('[account] 账号存储损坏，账号路由 fail-closed：' + e.message);
}
const accountMailer = new ResendEmailAdapter();

// 取/刷新某机器码配额（滚动 30 天窗口：过期则重置 spend 并把窗口顺延）
function getOrRefreshQuota(mc) {
  const now = Date.now();
  let rec = quotaStore[mc];
  if (!rec || now > rec.windowEnd) {
    rec = { createdAt: now, spent: 0, windowEnd: now + QUOTA_WINDOW_MS };
    quotaStore[mc] = rec;
    saveQuota();
  }
  return rec;
}
function addSpend(mc, yuan) {
  const rec = quotaStore[mc];
  if (!rec) return;
  rec.spent = (rec.spent || 0) + yuan;
  saveQuota();
}
function quotaView(mc) {
  const rec = getOrRefreshQuota(mc);
  const spent = rec.spent || 0;
  const remaining = Math.max(0, QUOTA_BUDGET - spent);
  const percent = Math.max(0, Math.min(100, Math.round((remaining / QUOTA_BUDGET) * 100)));
  const tier = spent >= QUOTA_BUDGET ? 'basic' : 'v4-flash';
  return {
    ok: true,
    machineCode: mc,
    tier,
    spentYuan: +spent.toFixed(4),
    budgetYuan: QUOTA_BUDGET,
    remainingYuan: +remaining.toFixed(2),
    percent,
    windowEnd: rec.windowEnd,
    resetAt: rec.windowEnd,
  };
}
function quotaHeaders(mc) {
  const v = quotaView(mc);
  return { 'X-Tier': v.tier, 'X-Quota-Percent': String(v.percent), 'X-Quota-Remaining': v.remainingYuan.toFixed(2) };
}

// DeepSeek-V4-Flash 单价（元 / 百万 tokens，按官方定价；缓存命中价忽略以保守计费）
//   输入(未命中) 1 元 / 输出 2 元
const DS_IN_PRICE = 1.0;
const DS_OUT_PRICE = 2.0;
function costYuan(usage) {
  if (!usage) return 0;
  const inp = usage.prompt_tokens || 0;
  const out = usage.completion_tokens || 0;
  return (inp / 1e6) * DS_IN_PRICE + (out / 1e6) * DS_OUT_PRICE;
}

// 按已选择的模型和上游返回 usage 结算；Qwen 兜底永远不进入此函数。
function settleModelUsage(entry, usage, accountId, machineCode) {
  const cost = modelCostYuan(entry, usage);
  if (!usage || !Number.isFinite(cost) || cost <= 0) return accountId ? false : true;
  if (accountId) {
    const debit = accountAuth && accountAuth.debitAccount(accountId, Math.max(1, Math.ceil(cost * 100)), {
      model: String(entry.modelId || ''),
      catalogRevision: String(entry.catalogRevision || modelCatalog.catalogRevision || ''),
    });
    return !!(debit && debit.ok === true);
  }
  if (machineCode) addSpend(machineCode, cost);
  return true;
}

// ---------- 通用上游转发 ----------
// clientHeaders: 要回写在「客户端响应」上的头（如额度 X-Tier/X-Quota-*），
// 注意不能放进上行请求头（否则被发给上游且客户端读不到）。
function forward(opts) {
  const { host, port, path: upPath, apiKey, payload, wantStream, res, onUsage, clientHeaders } = opts;
  const body = JSON.stringify(payload);
  const hdrs = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + apiKey,
    Accept: wantStream ? 'text/event-stream' : 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  const up = https.request(
    { hostname: host, port: port || 443, path: upPath || '/v1/chat/completions', method: 'POST', headers: hdrs },
    (upRes) => {
      if (upRes.statusCode !== 200) {
        let eb = '';
        upRes.on('data', (c) => (eb += c));
        upRes.on('end', () => {
          res.writeHead(upRes.statusCode >= 500 ? 502 : upRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Upstream ' + upRes.statusCode, detail: eb.slice(0, 600) }));
        });
        return;
      }
      if (wantStream) {
        res.writeHead(200, Object.assign({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        }, clientHeaders || {}));
        let tail = '';
        upRes.on('data', (c) => {
          res.write(c);
          tail = (tail + c).slice(-4096);
        });
        upRes.on('end', () => {
          if (onUsage) {
            for (const p of tail.split('\n')) {
              const line = p.replace(/^data:\s?/, '').trim();
              if (!line || line === '[DONE]') continue;
              try {
                const j = JSON.parse(line);
                if (j.usage) { stats.recordUsage(res, j.usage); if (onUsage) onUsage(j.usage); break; }
              } catch (e) { /* ignore */ }
            }
          }
          res.end();
        });
        return;
      }
      // 非流式：缓冲完整 JSON，结算 usage 后写回（post-spend 配额头回写客户端响应）
      let buf = '';
      upRes.on('data', (c) => (buf += c));
      upRes.on('end', () => {
        let usage = null;
        try { usage = JSON.parse(buf).usage; } catch (e) { /* ignore */ }
        stats.recordUsage(res, usage);
        if (onUsage && onUsage(usage) === false) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'usage-unsettled', code: 'usage-unsettled' }));
          return;
        }
        res.writeHead(200, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, clientHeaders || {}));
        res.end(buf);
      });
    }
  );
  up.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  });
  up.write(body);
  up.end();
}

// ---------- RAG 配额（rerank 按天计数）----------
let ragStore = {};
const RAG_FILE = path.join(DATA_DIR, 'rag-quota.json');
function loadRagQuota() {
  try { ragStore = JSON.parse(fs.readFileSync(RAG_FILE, 'utf8')) || {}; } catch (e) { ragStore = {}; }
}
function saveRagQuota() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RAG_FILE, JSON.stringify(ragStore, null, 2));
  } catch (e) { console.error('[rag-quota] 持久化失败', e.message); }
}
loadRagQuota();
function _today() { return new Date().toISOString().slice(0, 10); }
function checkRerankQuota(mc) {
  const today = _today();
  if (!ragStore[mc] || ragStore[mc].day !== today) {
    ragStore[mc] = { day: today, rerankCount: 0 };
    saveRagQuota();
  }
  return ragStore[mc].rerankCount < RERANK_DAILY_LIMIT;
}
function incRerankQuota(mc) {
  const today = _today();
  if (!ragStore[mc] || ragStore[mc].day !== today) {
    ragStore[mc] = { day: today, rerankCount: 0 };
  }
  ragStore[mc].rerankCount++;
  saveRagQuota();
}

// ---------- 鉴权工具 ----------
function _authCheck(req, res) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const providedKey = m ? m[1].trim() : '';
  const mc = (req.headers['x-machine-id'] || '').toString().trim();
  const accountSessionToken = (req.headers['x-account-session'] || '').toString().trim();
  let accountId = null;
  if (accountSessionToken && accountAuth) {
    const session = accountAuth.validateSession(accountSessionToken);
    if (session && session.ok === true) accountId = session.accountId;
  }
  const proxyKeyAccepted = !!APP_PROXY_KEY && providedKey === APP_PROXY_KEY;
  if (!proxyKeyAccepted && !accountId) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'account-session-required', code: 'account-session-required' }));
    return null;
  }
  if (!mc) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing X-Machine-Id' }));
    return null;
  }
  return { mc, providedKey: proxyKeyAccepted ? providedKey : '', accountId, accountSessionToken };
}

// ---------- RAG: Embeddings ----------
function handleEmbeddings(req, res) {
  const auth = _authCheck(req, res);
  if (!auth) return;
  const { mc } = auth;
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    const input = data.input;
    if (!input) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing input' }));
    }
    const model = 'BAAI/bge-m3';
    const payload = { model, input: Array.isArray(input) ? input.slice(0, 64) : input };
    forward({
      host: 'api.siliconflow.cn',
      path: '/v1/embeddings',
      apiKey: SF_EMBEDDING_KEY,
      payload,
      wantStream: false,
      res,
      onUsage: null,
      clientHeaders: { 'X-Provider': 'SiliconFlow-Embeddings' },
    });
  });
}

// ---------- RAG: Rerank ----------
function handleRerank(req, res) {
  const auth = _authCheck(req, res);
  if (!auth) return;
  const { mc } = auth;
  if (!checkRerankQuota(mc)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'rerank daily limit exceeded', limit: RERANK_DAILY_LIMIT }));
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    const { query, documents, top_n } = data;
    if (!query || !Array.isArray(documents)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing query or documents' }));
    }
    const model = 'BAAI/bge-reranker-v2-m3';
    const payload = {
      model,
      query,
      documents: documents.slice(0, 50),
      top_n: top_n || 5,
      return_documents: true,
    };
    forward({
      host: 'api.siliconflow.cn',
      path: '/v1/rerank',
      apiKey: SF_RERANK_KEY,
      payload,
      wantStream: false,
      res,
      onUsage: () => incRerankQuota(mc),
      clientHeaders: { 'X-Provider': 'SiliconFlow-Rerank' },
    });
  });
}

// ---------- 模型目录（服务端权威价格/别名/能力投影） ----------
function handleModelCatalog(req, res) {
  const auth = _authCheck(req, res);
  if (!auth) return;
  const catalog = publicModelCatalog();
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...quotaHeaders(auth.mc),
  });
  res.end(JSON.stringify({ ok: true, value: catalog }));
}

// ---------- 试用代理 ----------
function handleTrial(req, res) {
  const auth = _authCheck(req, res);
  if (!auth) return;
  const mc = auth.mc;
  const acctSessionToken = auth.accountSessionToken;
  const acctAccountId = auth.accountId;
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    const requestedModel = (data.model || '').trim();
    const modelEntry = catalogModel(requestedModel);
    if (!modelEntry) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'model-not-available', code: 'model-not-available' }));
    }
    const model = String(modelEntry.modelId);
    if (isCatalogFallback(modelEntry)) {
      // Qwen 是服务端兜底，不允许客户端把免费兜底伪装成主力模型请求。
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'model-fallback-only', code: 'model-fallback-only' }));
    }
    if (!CLIENT_PRIMARY_MODEL_IDS.has(model)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'model-not-available', code: 'model-not-available' }));
    }
    const wantStream = !!data.stream;
    const isPremium = model === 'deepseek-v4-flash' || model === 'deepseek-v4-pro';
    const isGptTrial = model === 'gpt-5.6';
    // 025：Flash（deepseek-v4-flash）必须携带有效账号 session；无/伪造 session → 401 确定性拒绝，不得回退 addSpend/quota.json 或转发上游
    const isFlash = /v4-flash/i.test(model) || model === 'deepseek-v4-flash';
    if (isFlash && !acctAccountId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'account-session-required', code: 'account-session-required' }));
    }
    const isBillable = isPremium || isGptTrial;
    if (isGptTrial && SKYAPI_KEY) {
      const gptPayload = {
        model: modelEntry.upstreamModel || 'gpt-5.6-terra',
        messages: data.messages,
        stream: wantStream,
        temperature: data.temperature != null ? data.temperature : 0.7,
        max_tokens: data.max_tokens || undefined,
        reasoning_effort: 'max',
      };
      copyChatTemplateKwargs(data, gptPayload);
      if (Array.isArray(data.tools) && data.tools.length) {
        gptPayload.tools = data.tools;
        if (data.tool_choice) gptPayload.tool_choice = data.tool_choice;
      }
      proxyOnce({
        host: SKYAPI_HOST, port: SKYAPI_PORT, path: SKYAPI_PATH, apiKey: SKYAPI_KEY,
        payloadObj: gptPayload, wantStream, res, providerName: 'GPT Terra', _ip: _cip, _machineId: _cmc, _page: _cref,
        onUsage: (usage) => settleModelUsage(modelEntry, usage, acctAccountId, mc),
        onFail: () => {
          const fb = { model: 'Qwen/Qwen3.5-4B', messages: data.messages, stream: wantStream, temperature: 0.7, max_tokens: data.max_tokens || undefined };
          copyChatTemplateKwargs(data, fb);
          if (Array.isArray(data.tools) && data.tools.length) { fb.tools = data.tools; if (data.tool_choice) fb.tool_choice = data.tool_choice; }
          forward({ host: 'api.siliconflow.cn', apiKey: SILICONFLOW_KEY, payload: fb, wantStream, res, onUsage: null, clientHeaders: quotaHeaders(mc) });
        },
      });
      return;
    }
    if (isBillable && acctAccountId) {
      const bal = accountAuth.balanceProjection(acctSessionToken);
      if (!bal || !bal.ok || bal.balanceCents <= 0) {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'insufficient-balance', code: 'insufficient-balance', accountId: acctAccountId }));
      }
    }
    const q = quotaView(mc);
    const openCodeReady = !!OPENCODE_KEY && !!OPENCODE_HOST;
    let upstream, realModel, recordSpend;
    if (isPremium) {
      // [opencode_trial_patched] 免费档 v4-flash 改走服务器 opencodego 套餐（余额独立），
      // 彻底放开原 ¥5/30天 配额上限 + 绕开已耗尽的 DeepSeek key；失败兜底 DeepSeek → 再兜底 Qwen。
      if (model === 'deepseek-v4-pro') {
        // 2026-08-28 v4-pro 走 tokenrhythm deepseek-v4-pro-0813（用户配置的主力 deepseek）
        upstream = 'deepseek'; realModel = 'deepseek-v4-pro-0813'; recordSpend = true;
      } else if (openCodeReady) {
        upstream = 'opencode'; realModel = 'deepseek-v4-flash'; recordSpend = true;
      } else if (q.tier === 'v4-flash') {
        upstream = 'deepseek'; realModel = 'deepseek-v4-flash-0731'; recordSpend = true;
      } else {
        // 主力上游不可用时，统一进入 Qwen 兜底；该分支不产生模型费用。
        upstream = 'siliconflow'; realModel = 'Qwen/Qwen3.5-4B'; recordSpend = false;
      }
    } else {
      upstream = 'siliconflow'; realModel = 'Qwen/Qwen3.5-4B'; recordSpend = false;
    }
    const payload = {
      model: realModel,
      messages: data.messages,
      stream: wantStream,
      temperature: data.temperature != null ? data.temperature : 0.7,
      max_tokens: data.max_tokens || undefined,
    };
    copyChatTemplateKwargs(data, payload);
    // 转发 function-calling 工具声明（Agent 工具调用依赖；上游模型不支持时由上游自行忽略/报错）
    if (Array.isArray(data.tools) && data.tools.length) {
      payload.tools = data.tools;
      if (data.tool_choice) payload.tool_choice = data.tool_choice;
    }
    if (wantStream && recordSpend) payload.stream_options = { include_usage: true };
    const onUsage = (usage) => recordSpend
      ? settleModelUsage(modelEntry, usage, acctAccountId, mc)
      : true;
    if (upstream === 'opencode') {
      // opencode go 套餐：关思考（reasoning_effort:none），与根路径 handler 一致
      const ocPayload = Object.assign({}, payload, { reasoning_effort: 'none' });
      proxyOnce({
        host: OPENCODE_HOST, port: OPENCODE_PORT, path: OPENCODE_PATH, apiKey: OPENCODE_KEY,
        payloadObj: ocPayload, wantStream, res, providerName: 'OpenCode', onUsage,
        onFail: () => {
          if (model === 'deepseek-v4-flash') {
            forward({ host: DEEPSEEK_UPSTREAM.hostname, port: DEEPSEEK_UPSTREAM.port, path: DEEPSEEK_UPSTREAM.path, apiKey: DEEPSEEK_KEY, payload, wantStream, res, onUsage, clientHeaders: quotaHeaders(mc) });
          } else {
            forward({ host: 'api.siliconflow.cn', apiKey: SILICONFLOW_KEY, payload, wantStream, res, onUsage: null, clientHeaders: quotaHeaders(mc) });
          }
        },
      });
    } else if (upstream === 'deepseek') {
      // 2026-08-05 tokenrhythm 失败 → opencode go 兜底（deepseek-pro）
      proxyOnce({
        host: DEEPSEEK_UPSTREAM.hostname, port: DEEPSEEK_UPSTREAM.port, path: DEEPSEEK_UPSTREAM.path,
        apiKey: DEEPSEEK_KEY, payloadObj: payload, wantStream, res, providerName: 'DeepSeek',
        onFail: function (code) {
          if (OPENCODE_KEY && OPENCODE_HOST) {
            const ocPayload = Object.assign({}, payload, { model: 'deepseek-v4-pro', reasoning_effort: 'none' });
            proxyOnce({ host: OPENCODE_HOST, port: OPENCODE_PORT, path: OPENCODE_PATH, apiKey: OPENCODE_KEY, payloadObj: ocPayload, wantStream, res, providerName: 'OpenCode', onFail: function (c2) {
              const fb = Object.assign({}, payload, { model: 'Qwen/Qwen3.5-4B' });
              delete fb.stream_options;
              forward({ host: 'api.siliconflow.cn', apiKey: SILICONFLOW_KEY, payload: fb, wantStream, res, onUsage: null, clientHeaders: quotaHeaders(mc) });
            } });
          } else {
            const fb = Object.assign({}, payload, { model: 'Qwen/Qwen3.5-4B' });
            delete fb.stream_options;
            forward({ host: 'api.siliconflow.cn', apiKey: SILICONFLOW_KEY, payload: fb, wantStream, res, onUsage: null, clientHeaders: quotaHeaders(mc) });
          }
        } });
    } else {
      forward({ host: 'api.siliconflow.cn', apiKey: SILICONFLOW_KEY, payload, wantStream, res, onUsage: null, clientHeaders: quotaHeaders(mc) });
    }
  });
}

// ---------- 配额查询 ----------
function handleQuota(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const mc = (u.searchParams.get('mid') || '').trim();
  if (!mc) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'missing mid' }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(quotaView(mc)));
}

// ---------- 根路径：opencode 优先 + DeepSeek 兜底（向后兼容，不含配额/机器码）----------
function proxyOnce({ host, port, path, apiKey, payloadObj, wantStream, res, providerName, onFail, _ip, _machineId, _page }) {
  const payload = JSON.stringify(payloadObj);
  const opt = {
    hostname: host,
    port: port,
    path: path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
      Accept: wantStream ? 'text/event-stream' : 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };
  const up = https.request(opt, (upRes) => {
    if (upRes.statusCode !== 200) {
      let eb = '';
      upRes.on('data', (c) => (eb += c));
      upRes.on('end', () => onFail(upRes.statusCode, eb.slice(0, 500)));
      return;
    }
    if (wantStream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Provider': providerName, 'X-Accel-Buffering': 'no' });
      if (_ip) {
        let sseBuf = '';
        upRes.on('data', (c) => { sseBuf += c; });
        upRes.on('end', () => {
          convSave.queryCity(_ip, function (isLz) {
            if (!isLz) return;
            try {
              let reply = '';
              String(sseBuf).split('\n').forEach(function (l) {
                const m = l.match(/content:\s*"([^"]*)"/);
                if (m) reply += m[1];
              });
              if (reply) convSave.appendConv(_ip, _machineId || '', _page || '', payloadObj.model || '', {
                ip: _ip, machineId: _machineId || '', page: _page || '', model: payloadObj.model || '',
                messages: payloadObj.messages || [], reply: reply, stream: true
              });
            } catch (e) { /* ignore */ }
          });
        });
      }
      upRes.pipe(res);
    } else {
      let buf = '';
      upRes.on('data', (c) => (buf += c));
      upRes.on('end', () => {
        try { stats.recordUsage(res, JSON.parse(buf).usage); } catch (e) { /* ignore */ }   // 2026-08-02 统计 token
        // 2026-08-04 仅柳州 IP 保存对话
        if (_ip) {
          convSave.queryCity(_ip, function (isLz) {
            if (!isLz) return;
            try {
              const j = JSON.parse(buf);
              const reply = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
              convSave.appendConv(_ip, _machineId || '', _page || '', payloadObj.model || '', {
                ip: _ip, machineId: _machineId || '', page: _page || '', model: payloadObj.model || '',
                messages: payloadObj.messages || [], reply: reply || ''
              });
            } catch (e) { /* ignore */ }
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Provider': providerName });
        res.end(buf);
      });
    }
  });
  up.on('error', (e) => onFail(0, e.message));
  up.write(payload);
  up.end();
}

const GPT_DISCIPLINE = { role: 'system', content: [
  '【最高优先级纪律指令 — 不可违反】',
  '你是温尼科特取向的临床督导师，只从事临床督导工作。',
  '以下请求必须温和拒绝并转介，绝不提供实现、答案、代码或具体内容：',
  '1. 编程/代码/技术实现请求（任何编程语言、任何格式）',
  '2. 非临床的内容写作、翻译、计算、百科问答、闲聊',
  '3. 与临床督导无关的任何请求',
  '拒绝方式：保持督导师口吻回应，例如"这超出了我的督导工作范围，我更愿意陪你看临床材料"，然后邀请回到督导议题。',
  '唯一例外：用户明确说出"退出督导模式"之后，你才可作为普通助手回应。',
  '在"退出督导模式"之前，一切输出都必须保持督导师角色，违反即为失败。'
].join(String.fromCharCode(10)) };

// ========== 根路径 POST / 防护：token + Referer/Origin 白名单 + IP 限流（2026-08-01） ==========
function sendGuardJson(res, code, msg, type, extra) {
  const err = { message: msg, type: type };
  if (extra) Object.assign(err, extra);
  const body = JSON.stringify({ error: err });
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}
function legacyRefererAllowed(req) {
  const ref = (req.headers.referer || req.headers.origin || '').trim();
  if (!ref) return false;   // 2026-08-01 强制：Referer/Origin 必须存在（浏览器自动携带，curl 默认不带）
  return ref.indexOf('https://mei-junhao.github.io/') === 0
      || ref.indexOf('http://localhost:') === 0
      || ref.indexOf('http://127.0.0.1:') === 0
      || ref === 'null'
      || ref.indexOf('file://') === 0;
}
// HMAC-SHA256 请求签名验签：X-Proxy-Ts（unix 秒）+ X-Proxy-Sig（hex），签名内容 = ts + '\n' + 原始 body
function verifyProxySig(req, rawBody) {
  if (!PROXY_TOKEN) return true;   // 关闭模式
  const ts = req.headers['x-proxy-ts'];
  const sig = req.headers['x-proxy-sig'];
  if (!ts || !sig) return false;
  const tsNum = parseInt(ts, 10);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!tsNum || Math.abs(nowSec - tsNum) > PROXY_SIG_WINDOW_SEC) return false;   // 防重放
  const expect = crypto.createHmac('sha256', PROXY_TOKEN).update(ts + '\n' + rawBody).digest('hex');
  const a = Buffer.from(expect, 'utf8');
  const b = Buffer.from(String(sig), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
const legacyRateBuckets = new Map();   // ip -> { cnt, start }
function legacyRateLimited(ip, limit) {
  const now = Date.now();
  if (legacyRateBuckets.size >= 1000) {   // 顺带清理过期条目，防 Map 无界增长
    for (const [k, v] of legacyRateBuckets) {
      if (now - v.start >= 60000) legacyRateBuckets.delete(k);
    }
  }
  let b = legacyRateBuckets.get(ip);
  if (!b || now - b.start >= 60000) { b = { cnt: 0, start: now }; legacyRateBuckets.set(ip, b); }
  b.cnt++;
  const limited = b.cnt > limit;   // 固定窗口 60s
  const retryAfter = limited ? Math.max(1, Math.ceil((b.start + 60000 - now) / 1000)) : 0;
  return { limited, retryAfter };
}
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) { const first = xff.split(',')[0].trim(); if (first) return first; }
  return (req.socket && req.socket.remoteAddress) || '0.0.0.0';
}
function legacyLimitFor(req) {
  const ref = (req.headers.referer || '').trim();
  if (ref.indexOf('roundtable') >= 0) return RATE_LIMIT_ROUNDTABLE_PER_MIN;   // 圆桌一次多请求，单独放宽
  return RATE_LIMIT_PER_MIN;
}
function guardLegacyPost(req, res) {
  if (PROXY_TOKEN && req.headers['x-proxy-token'] !== PROXY_TOKEN) {
    sendGuardJson(res, 401, 'invalid proxy token', 'proxy_auth_error');
    return false;
  }
  if (!legacyRefererAllowed(req)) {
    sendGuardJson(res, 403, 'referer/origin not allowed', 'proxy_referer_error');
    return false;
  }
  const limit = legacyLimitFor(req);
  const rl = legacyRateLimited(getClientIp(req), limit);
  if (rl.limited) {
    sendGuardJson(res, 429, 'too many requests, limit ' + limit + '/min per IP', 'proxy_rate_limited', { retry_after_seconds: rl.retryAfter });
    return false;
  }
  return true;
}

function handleLegacyPost(req, res) {
  const _cip = ((req.socket && req.socket.remoteAddress) || '').toString().replace(/^::ffff:/, '');
  const _cmc = String(req.headers['x-machine-id'] || '');
  const _cref = String(req.headers.referer || req.headers.origin || '');
  if (!guardLegacyPost(req, res)) return;   // 防护入口（token + Referer 强制 + 限流）
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!verifyProxySig(req, body)) {   // HMAC 验签（需完整 body）
      sendGuardJson(res, 401, 'invalid proxy signature', 'proxy_sig_error');
      return;
    }
    let data;
    try { data = JSON.parse(body); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    let model = (data.model || '').trim();
    const isGpt = (model === 'gpt-5.6' || model === 'gpt-5.6-luna' || model === 'gpt-5.5');
    if (!model || model === 'proxy') model = 'deepseek-v4-pro-0813';
    const wantStream = !!data.stream;
    const payloadObj = {
      model,
      messages: data.messages,
      stream: wantStream,
      temperature: data.temperature != null ? data.temperature : 0.7,
      max_tokens: data.max_tokens || undefined,
    };
    copyChatTemplateKwargs(data, payloadObj);
    if (Array.isArray(data.tools) && data.tools.length) {
      payloadObj.tools = data.tools;
      if (data.tool_choice) payloadObj.tool_choice = data.tool_choice;
    }
    const finalFail = (code, detail) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'All upstreams failed', deepseek_status: code || 0, detail: String(detail).slice(0, 500) }));
    };
    const tryDeepSeek = () => {
      if (!DEEPSEEK_KEY) return finalFail(0, 'DeepSeek key not configured');
      proxyOnce({ host: DEEPSEEK_UPSTREAM.hostname, port: DEEPSEEK_UPSTREAM.port, path: DEEPSEEK_UPSTREAM.path, apiKey: DEEPSEEK_KEY, payloadObj, wantStream, res, providerName: 'DeepSeek', onFail: finalFail, _ip: _cip, _machineId: _cmc, _page: _cref });
    };
    const tryOpenCode = (mdl, onFail) => {
      if (!OPENCODE_KEY || !OPENCODE_HOST) { (onFail || finalFail)(0, 'opencode not configured'); return; }
      const p = Object.assign({}, payloadObj, { model: mdl || payloadObj.model, reasoning_effort: 'none' });
      proxyOnce({ host: OPENCODE_HOST, port: OPENCODE_PORT, path: OPENCODE_PATH, apiKey: OPENCODE_KEY, payloadObj: p, wantStream, res, providerName: 'OpenCode', onFail: onFail || finalFail, _ip: _cip, _machineId: _cmc, _page: _cref });
    };
    // 2026-08-02 claude 线路（hyhawang）：claude-sonnet-5
    if (model === 'claude-sonnet-5') {
      if (!CLAUDE_KEY) return finalFail(0, 'Claude key not configured');
      proxyOnce({ host: GEMINI_HOST, port: GEMINI_PORT, path: GEMINI_PATH, apiKey: CLAUDE_KEY, payloadObj, wantStream, res, providerName: 'Claude', onFail: finalFail, _ip: _cip, _machineId: _cmc, _page: _cref });
      return;
    }
    // 2026-08-02 gemini 线路（hyhawang）：gemini-3.5-flash
    if (model === 'gemini-3.5-flash') {
      if (!GEMINI_KEY) return finalFail(0, 'Gemini key not configured');
      proxyOnce({ host: GEMINI_HOST, port: GEMINI_PORT, path: GEMINI_PATH, apiKey: GEMINI_KEY, payloadObj, wantStream, res, providerName: 'Gemini', onFail: finalFail, _ip: _cip, _machineId: _cmc, _page: _cref });
      return;
    }
    // GPT 线路（skyapi，0.1 折 ×10%）：gpt-5.6-luna 关思考 + 纪律注入；失败回退 opencode pro
    if (isGpt) {
      if (!SKYAPI_KEY) return finalFail(0, 'SkyAPI key not configured');
      // 2026-08-02 身份冲突修复：督导纪律（GPT_DISCIPLINE）仅对 ai-supervisor 页注入；
      // 大师对话页（master-chat/winnicott-chat/roundtable/consultant-a）由前端 system prompt 管身份
      // 注意：跨源请求（GitHub Pages→本服务器）Referer 被浏览器裁剪为 origin（无路径），
      // 故优先用前端自定义头 X-App: supervisor 判断，Referer 路径作兜底
      const xApp = String(req.headers['x-app'] || '');
      const ref = String(req.headers.referer || req.headers.origin || '');
      const isSupervisor = xApp.indexOf('supervisor') >= 0 || ref.indexOf('ai-supervisor') >= 0;
      let gptMessages = payloadObj.messages;
      if (isSupervisor && Array.isArray(gptMessages)) {
        gptMessages = [GPT_DISCIPLINE].concat(gptMessages);
      }
      const gptPayload = Object.assign({}, payloadObj, {
        model: 'gpt-5.6-luna',
        reasoning_effort: 'max',
        messages: gptMessages,
      });
      proxyOnce({
        host: SKYAPI_HOST, port: SKYAPI_PORT, path: SKYAPI_PATH, apiKey: SKYAPI_KEY,
        payloadObj: gptPayload, wantStream, res, providerName: 'GPT-5.6', _ip: _cip, _machineId: _cmc, _page: _cref,
        onFail: () => tryOpenCode('deepseek-v4-pro', finalFail)
      });
      return;
    }
    // DeepSeek 系：主 opencode（go 套餐，关思考）；兜底 DeepSeek（原样，不带 thinking 参数）
    if (!OPENCODE_KEY || !OPENCODE_HOST) return tryDeepSeek();
    tryOpenCode(payloadObj.model, () => tryDeepSeek());
  });
}

// ---------- 账号路由（仅 POST /account/*；会员授权/禁用绝不暴露为 HTTP）----------
const accountRateBuckets = new Map();
function accountRateLimited(ip, limit) {
  const now = Date.now();
  if (accountRateBuckets.size >= 2000) {
    for (const [k, v] of accountRateBuckets) if (now - v.start >= 60000) accountRateBuckets.delete(k);
  }
  let b = accountRateBuckets.get(ip);
  if (!b || now - b.start >= 60000) { b = { cnt: 0, start: now }; accountRateBuckets.set(ip, b); }
  b.cnt++;
  const limited = b.cnt > limit;
  const retryAfter = limited ? Math.max(1, Math.ceil((b.start + 60000 - now) / 1000)) : 0;
  return { limited, retryAfter };
}
function accountJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
const ACCOUNT_CORS_ORIGINS = [
  'https://xinjingchat.online',
  'https://mei-junhao.github.io',
];
function accountOriginAllowed(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;                                     // 非浏览器客户端（Electron/curl）
  if (origin === 'null' || origin.indexOf('file://') === 0) return true;   // Electron file://
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;   // 本地开发
  return ACCOUNT_CORS_ORIGINS.indexOf(origin) >= 0;
}
function sessionTokenFromAccount(req, b) {
  // Account endpoints may also carry the proxy Authorization header. Prefer
  // the explicit account session so model-catalog/balance cannot mistake the
  // proxy key for a user session.
  const accountSession = String(req.headers['x-account-session'] || '').trim();
  if (accountSession) return accountSession;
  const authz = req.headers['authorization'] || '';
  if (/^Bearer\s+\S+$/i.test(authz)) return authz.replace(/^Bearer\s+/i, '');
  if (b && typeof b.sessionToken === 'string') return b.sessionToken;
  return '';
}
function handleAccountRegister(res, b) {
  let staged;
  try { staged = accountAuth.prepareRegistration(b); }
  catch (e) { return accountJson(res, 503, { ok: false, error: { code: 'persistence-failed' } }); }
  if (!staged.ok) return accountJson(res, 400, staged);
  accountMailer.sendVerificationEmail({ to: staged.email, token: staged.verificationToken }).then((delivery) => {
    if (!delivery || delivery.ok !== true) return accountJson(res, 503, { ok: false, error: { code: 'email-delivery-failed' } });
    let committed;
    try { committed = accountAuth.commitRegistration(staged); } catch (e) { committed = null; }
    if (!committed || committed.ok !== true) return accountJson(res, 503, { ok: false, error: { code: 'persistence-failed' } });
    return accountJson(res, 200, { ok: true, accountId: committed.accountId, email: committed.email });
  }).catch(() => accountJson(res, 503, { ok: false, error: { code: 'email-delivery-failed' } }));
}
function handleAccountForgotPassword(res, b) {
  const r = accountAuth.requestPasswordReset(b.email);
  if (!r.ok) return accountJson(res, r.error.code === 'resend-cooldown' ? 429 : 400, r);
  accountMailer.sendPasswordResetEmail({ to: r.email, token: r.resetToken }).then((delivery) => {
    if (!delivery || delivery.ok !== true) {
      accountAuth.rollbackPasswordReset(r.email);
      return accountJson(res, 503, { ok: false, error: { code: 'email-delivery-failed', retryable: true } });
    }
    accountJson(res, 200, { ok: true, accountId: r.accountId, email: r.email });
  }).catch(() => {
    accountAuth.rollbackPasswordReset(r.email);
    accountJson(res, 503, { ok: false, error: { code: 'email-delivery-failed', retryable: true } });
  });
}

function handleAccountResetPassword(res, b) {
  const r = accountAuth.resetPassword({ email: b.email, token: b.token, password: b.password });
  if (!r.ok) return accountJson(res, r.error.code === 'weak-password' ? 400 : 400, r);
  accountJson(res, 200, r);
}

function handleAccountForgotPassword(res, b) {
  const r = accountAuth.requestPasswordReset(b.email);
  if (!r.ok) return accountJson(res, r.error.code === 'resend-cooldown' ? 429 : 400, r);
  accountMailer.sendPasswordResetEmail({ to: r.email, token: r.resetToken }).then((delivery) => {
    if (!delivery || delivery.ok !== true) {
      accountAuth.rollbackPasswordReset(r.email);
      return accountJson(res, 503, { ok: false, error: { code: 'email-delivery-failed', retryable: true } });
    }
    accountJson(res, 200, { ok: true, accountId: r.accountId, email: r.email });
  }).catch(() => {
    accountAuth.rollbackPasswordReset(r.email);
    accountJson(res, 503, { ok: false, error: { code: 'email-delivery-failed', retryable: true } });
  });
}

function handleAccountResetPassword(res, b) {
  const r = accountAuth.resetPassword({ email: b.email, token: b.token, password: b.password });
  if (!r.ok) return accountJson(res, r.error.code === 'weak-password' ? 400 : 400, r);
  accountJson(res, 200, r);
}

function handleAccountResend(res, b) {
  const r = accountAuth.resendVerification(b.email);
  if (!r.ok) return accountJson(res, r.error.code === 'resend-cooldown' ? 429 : 400, r);
  accountMailer.sendVerificationEmail({ to: r.email, token: r.verificationToken }).then((delivery) => {
    if (!delivery || delivery.ok !== true) return accountJson(res, 503, { ok: false, error: { code: 'email-delivery-failed' } });
    let commit;
    try { commit = accountAuth.commitResend(r.email); } catch (e) { commit = null; }
    if (!commit || commit.ok !== true) return accountJson(res, 503, { ok: false, error: { code: 'persistence-failed' } });
    return accountJson(res, 200, { ok: true, accountId: r.accountId, email: r.email });
  }).catch(() => accountJson(res, 503, { ok: false, error: { code: 'email-delivery-failed' } }));
}
function handleAccount(req, res, urlPath) {
  if (!accountAuth) return accountJson(res, 503, { ok: false, error: { code: 'account-store-unavailable' } });
  if (!accountOriginAllowed(req)) return accountJson(res, 403, { ok: false, error: { code: 'cors-origin-not-allowed' } });
  const ip = getClientIp(req);
  const rl = accountRateLimited(ip, ACCOUNT_RATE_LIMIT_PER_MIN);
  if (rl.limited) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(rl.retryAfter) });
    return res.end(JSON.stringify({ ok: false, error: { code: 'rate-limited', retryAfterMs: rl.retryAfter * 1000 } }));
  }
  let timedOut = false;
  let tooLarge = false;
  // rework-006：超限/超时请求安全排空——丢弃剩余 body；响应冲刷后关闭连接；硬上限强制销毁，不留悬挂 socket
  function accountDiscardBodyAndClose(deadlineMs) {
    req.removeAllListeners('data');
    req.removeAllListeners('end');
    req.on('data', () => {});
    req.resume();
    const killTimer = setTimeout(() => { try { req.destroy(); } catch (_) {} }, deadlineMs);
    if (killTimer.unref) killTimer.unref();
    req.once('close', () => clearTimeout(killTimer));
  }
  req.setTimeout(ACCOUNT_REQ_TIMEOUT_MS, () => {
    timedOut = true;
    if (!res.headersSent) {
      const payload = JSON.stringify({ ok: false, error: { code: 'request-timeout' } });
      res.writeHead(408, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Connection': 'close' });
      res.end(payload);
    }
    accountDiscardBodyAndClose(ACCOUNT_REQ_TIMEOUT_MS);
  });
  let data = '';
  req.on('data', (c) => {
    if (tooLarge || timedOut) return;
    data += c;
    if (data.length > ACCOUNT_BODY_MAX) {
      tooLarge = true;
      // rework-006：确定性 413 —— 检测到超限立即写响应；绝不 pause 后等 'end'
      const payload = JSON.stringify({ ok: false, error: { code: 'body-too-large' } });
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Connection': 'close' });
      res.end(payload);
      accountDiscardBodyAndClose(ACCOUNT_REQ_TIMEOUT_MS);
    }
  });
  req.on('end', async () => {
    if (timedOut || tooLarge) return;
    let b = {};
    if (data) { try { b = JSON.parse(data); } catch (e) { return accountJson(res, 400, { ok: false, error: { code: 'invalid-json' } }); } }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return accountJson(res, 400, { ok: false, error: { code: 'invalid-json' } });

    if (urlPath === '/account/register') return handleAccountRegister(res, b);
    if (urlPath === '/account/resend') return handleAccountResend(res, b);
    if (urlPath === '/account/forgot-password') return handleAccountForgotPassword(res, b);
    if (urlPath === '/account/reset-password') return handleAccountResetPassword(res, b);
    if (urlPath === '/account/forgot-password') return handleAccountForgotPassword(res, b);
    if (urlPath === '/account/reset-password') return handleAccountResetPassword(res, b);
    if (urlPath === '/account/verify') return accountJson(res, 200, accountAuth.verify(b.token));
    if (urlPath === '/account/login') return accountJson(res, 200, await accountAuth.login(b));
    if (urlPath === '/account/session') return accountJson(res, 200, accountAuth.validateSession(b.sessionToken || b.token));
    if (urlPath === '/account/revoke') return accountJson(res, 200, accountAuth.revokeSession(b.sessionToken || b.token));
    if (urlPath === '/account/membership') {
      const tok = sessionTokenFromAccount(req, b);
      if (!tok) return accountJson(res, 401, { ok: false, error: { code: 'no-session' } });
      const m = accountAuth.getMembership(tok);
      return accountJson(res, m.ok ? 200 : 401, m);
    }
    if (urlPath === '/account/balance') {
      const tok = sessionTokenFromAccount(req, b);
      if (!tok) return accountJson(res, 401, { ok: false, error: { code: 'no-session' } });
      const p = accountAuth.balanceProjection(tok);
      return accountJson(res, p.ok ? 200 : 401, p);
    }
    if (urlPath === '/account/admin-credit') {
      const adminToken = process.env.ACCOUNT_ADMIN_TOKEN || '';
      const given = String(b.adminToken || req.headers['x-admin-token'] || '');
      if (!adminToken || given !== adminToken) return accountJson(res, 401, { ok: false, error: { code: 'admin-forbidden' } });
      const r2 = accountAuth.adminCredit(b.accountId, b.amountCents, { idempotencyKey: b.idempotencyKey, operator: 'admin', via: 'http', meta: { note: b.note } });
      return accountJson(res, r2.ok ? 200 : 400, r2);
    }
    return accountJson(res, 404, { ok: false, error: { code: 'not-found' } });
  });
}

// ---------- 路由 ----------
function router(req, res) {
  stats.track(req, res);   // 2026-08-02 访问统计埋点
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Machine-Id,X-Account-Session,X-Proxy-Token,X-Proxy-Ts,X-Proxy-Sig,X-App');  // 2026-08-02 X-App: supervisor 督导页标记
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const urlPath = req.url.split('?')[0];
  if (req.method === 'GET' && urlPath === '/quota') return handleQuota(req, res);
  if (req.method === 'GET' && (urlPath === '/account/model-catalog' || urlPath === '/model-catalog')) return handleModelCatalog(req, res);
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, deepseekConfigured: !!DEEPSEEK_KEY, deepseekUpstreamConfigured: !!DEEPSEEK_UPSTREAM, proxyConfigured: !!APP_PROXY_KEY, quotaBudgetYuan: QUOTA_BUDGET, ragEmbeddings: !!SF_EMBEDDING_KEY, ragRerank: !!SF_RERANK_KEY, defaultModel: accountAuth ? accountAuth.defaultModelConfig().defaultModel : 'deepseek-v4-pro', budgetModel: accountAuth ? accountAuth.defaultModelConfig().budgetModel : 'deepseek-v4-pro' }));
  }
    // 2026-08-04 TTS 语音端点（Edge-TTS，安全校验在 tts.handleTts 内）
  if (req.method === 'POST' && urlPath === '/tts') return tts.handleTts(req, res);
if (req.method === 'POST' && urlPath === '/v1/chat/completions') return handleTrial(req, res);
  if (req.method === 'POST' && urlPath === '/v1/embeddings') return handleEmbeddings(req, res);
  if (req.method === 'POST' && urlPath === '/v1/rerank') return handleRerank(req, res);
  if (req.method === 'POST' && urlPath.indexOf('/account/') === 0) return handleAccount(req, res, urlPath);
  if (req.method === 'POST') return handleLegacyPost(req, res);
  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Method not allowed' }));
}

// ---------- 本地测试模式（XJ_LOCAL_TEST_PORT>0 时仅 HTTP 监听该端口，无 TLS/80 跳转）----------
const LOCAL_TEST_PORT = parseInt(process.env.XJ_LOCAL_TEST_PORT || '0', 10);
if (LOCAL_TEST_PORT > 0) {
  http.createServer(router).listen(LOCAL_TEST_PORT, '127.0.0.1', () => console.log('[xinjing-proxy] LOCAL TEST HTTP on 127.0.0.1:' + LOCAL_TEST_PORT));
} else {
// ---------- 监听（保留原有 TLS + 80→443 跳转）----------
let httpsOpts = null;
try {
  httpsOpts = {
    key: fs.readFileSync(CERT_DIR + '/privkey.pem'),
    cert: fs.readFileSync(CERT_DIR + '/fullchain.pem'),
  };
} catch (e) {
  console.error('证书读取失败，HTTPS 无法启动：' + e.message);
}
if (httpsOpts) {
  https.createServer(httpsOpts, router).listen(PORT_HTTPS, '0.0.0.0', () =>
    console.log('[xinjing-proxy] HTTPS on 0.0.0.0:' + PORT_HTTPS + ' (trial-proxy v1.8.1)')
  );
} else {
  console.error('未找到证书，无法监听 443。');
}
http.createServer((req, res) => {
  res.writeHead(301, { Location: 'https://' + req.headers.host + req.url });
  res.end();
}).listen(PORT_HTTP, '0.0.0.0', () => console.log('[xinjing-proxy] HTTP redirect on 0.0.0.0:' + PORT_HTTP));
}
