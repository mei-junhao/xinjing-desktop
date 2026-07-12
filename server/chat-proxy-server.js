'use strict';
/**
 * 心镜 XinJing — 韩国代理服务端 (v1.7.0)
 *
 * 路由：
 *  - GET  /                      健康检查（含代理配置状态）
 *  - POST /                      旧版 DeepSeek 透传（向后兼容，保留）
 *  - POST /v1/chat/completions   试用代理（按机器码配额门控 + 模型路由）
 *  - GET  /quota?mid=<machineId> 配额查询
 *
 * 安全模型：
 *  - 共享密钥(APP_PROXY_KEY) + 机器码(X-Machine-Id) 双因子；
 *  - 服务端按机器码硬限额兜底（客户端密钥被逆向也不怕刷量）；
 *  - 免费档：DeepSeek-V4-Flash 受 ¥5 / 30天 滚动窗口限制，超额/过期自动降级到
 *    内置基础模型 Qwen3.5-4B（走 SiliconFlow，不限量免费）。
 *
 * 密钥全部来自 .env（dotenv），代码不含任何明文密钥。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PORT_HTTPS = 443;
const PORT_HTTP = 80;
const CERT_DIR = '/etc/letsencrypt/live/xinjingchat.online';
const DATA_DIR = path.join(__dirname, 'data');
const QUOTA_FILE = path.join(DATA_DIR, 'quota.json');

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const SILICONFLOW_KEY = process.env.SILICONFLOW_API_KEY || '';
const APP_PROXY_KEY = process.env.APP_PROXY_KEY || '';
const QUOTA_BUDGET = parseFloat(process.env.QUOTA_BUDGET_YUAN || '5');
const QUOTA_WINDOW_DAYS = parseInt(process.env.QUOTA_WINDOW_DAYS || '30', 10);
const QUOTA_WINDOW_MS = QUOTA_WINDOW_DAYS * 24 * 3600 * 1000;

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

// ---------- 通用上游转发 ----------
// clientHeaders: 要回写在「客户端响应」上的头（如额度 X-Tier/X-Quota-*），
// 注意不能放进上行请求头（否则被发给上游且客户端读不到）。
function forward(opts) {
  const { host, apiKey, payload, wantStream, res, onUsage, clientHeaders } = opts;
  const body = JSON.stringify(payload);
  const hdrs = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + apiKey,
    Accept: wantStream ? 'text/event-stream' : 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  const up = https.request(
    { hostname: host, path: '/v1/chat/completions', method: 'POST', headers: hdrs },
    (upRes) => {
      if (upRes.statusCode !== 200) {
        let eb = '';
        upRes.on('data', (c) => (eb += c));
        upRes.on('end', () => {
          res.writeHead(502, { 'Content-Type': 'application/json' });
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
                if (j.usage) { onUsage(j.usage); break; }
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
        if (onUsage) onUsage(usage);
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

// ---------- 试用代理 ----------
function handleTrial(req, res) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const providedKey = m ? m[1].trim() : '';
  const mc = (req.headers['x-machine-id'] || '').toString().trim();
  if (!APP_PROXY_KEY || providedKey !== APP_PROXY_KEY) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'unauthorized' }));
  }
  if (!mc) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'missing X-Machine-Id' }));
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    const model = (data.model || '').trim();
    const wantStream = !!data.stream;
    const isPremium = /v4-flash/i.test(model) || model === 'deepseek-v4-flash';
    const q = quotaView(mc);
    let upstream, realModel, recordSpend;
    if (isPremium && q.tier === 'v4-flash') {
      upstream = 'deepseek'; realModel = 'deepseek-v4-flash'; recordSpend = true;
    } else {
      // 超额 / 过期 / 非 premium 模型 → 降级到内置基础模型（不限量免费）
      upstream = 'siliconflow'; realModel = 'Qwen/Qwen3.5-4B'; recordSpend = false;
    }
    const payload = {
      model: realModel,
      messages: data.messages,
      stream: wantStream,
      temperature: data.temperature != null ? data.temperature : 0.7,
      max_tokens: data.max_tokens || undefined,
    };
    // 转发 function-calling 工具声明（Agent 工具调用依赖；上游模型不支持时由上游自行忽略/报错）
    if (Array.isArray(data.tools) && data.tools.length) {
      payload.tools = data.tools;
      if (data.tool_choice) payload.tool_choice = data.tool_choice;
    }
    if (wantStream && recordSpend) payload.stream_options = { include_usage: true };
    const onUsage = (usage) => {
      if (recordSpend) {
        const cost = costYuan(usage);
        if (cost > 0) addSpend(mc, cost);
      }
    };
    if (upstream === 'deepseek') {
      forward({ host: 'api.deepseek.com', apiKey: DEEPSEEK_KEY, payload, wantStream, res, onUsage, clientHeaders: quotaHeaders(mc) });
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

// ---------- 旧版 DeepSeek 透传（向后兼容，不含配额/机器码）----------
function handleLegacyPost(req, res) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!DEEPSEEK_KEY) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Key not configured' }));
    }
    let data;
    try { data = JSON.parse(body); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    let model = (data.model || '').trim();
    if (!model || model === 'proxy') model = 'deepseek-chat';
    const wantStream = !!data.stream;
    const payload = JSON.stringify({
      model,
      messages: data.messages,
      stream: wantStream,
      temperature: data.temperature != null ? data.temperature : 0.7,
      max_tokens: data.max_tokens || undefined,
    });
    const opt = {
      hostname: 'api.deepseek.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + DEEPSEEK_KEY,
        Accept: wantStream ? 'text/event-stream' : 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const up = https.request(opt, (upRes) => {
      if (upRes.statusCode !== 200) {
        let eb = '';
        upRes.on('data', (c) => (eb += c));
        upRes.on('end', () => {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'DeepSeek ' + upRes.statusCode, detail: eb.slice(0, 500) }));
        });
        return;
      }
      if (wantStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Provider': 'DeepSeek', 'X-Accel-Buffering': 'no' });
        upRes.pipe(res);
      } else {
        let buf = '';
        upRes.on('data', (c) => (buf += c));
        upRes.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Provider': 'DeepSeek' });
          res.end(buf);
        });
      }
    });
    up.on('error', (e) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    up.write(payload);
    up.end();
  });
}

// ---------- 路由 ----------
function router(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Machine-Id');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && req.url.split('?')[0] === '/quota') return handleQuota(req, res);
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, deepseekConfigured: !!DEEPSEEK_KEY, proxyConfigured: !!APP_PROXY_KEY, quotaBudgetYuan: QUOTA_BUDGET }));
  }
  if (req.method === 'POST' && req.url.split('?')[0] === '/v1/chat/completions') return handleTrial(req, res);
  if (req.method === 'POST') return handleLegacyPost(req, res);
  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Method not allowed' }));
}

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
    console.log('[xinjing-proxy] HTTPS on 0.0.0.0:' + PORT_HTTPS + ' (trial-proxy v1.7.0)')
  );
} else {
  console.error('未找到证书，无法监听 443。');
}
http.createServer((req, res) => {
  res.writeHead(301, { Location: 'https://' + req.headers.host + req.url });
  res.end();
}).listen(PORT_HTTP, '0.0.0.0', () => console.log('[xinjing-proxy] HTTP redirect on 0.0.0.0:' + PORT_HTTP));
