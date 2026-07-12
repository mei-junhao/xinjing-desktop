/* ============================================================
 * 心镜 XinJing — Agent 写工具集（v1.3.0 U2）
 *
 * 4 个高 ROI 工具的 JSON Schema + handler：
 *   billing.add_record    — 批量新增会谈记账（写）
 *   billing.monthly_settle — 月结付款录入（写，先读后合并）
 *   billing.summary       — 记账统计查询（只读）
 *   client.update         — 改来访者基本信息（写，白名单过滤）
 *
 * 范式：IIFE + window.AgentTools 全局，被 agent-core.js 调用。
 * 依赖裸全局 Store + typeof 守卫，无 window. 前缀、无 DOM API
 * （与 supervision-core.js / masters-core.js 同范式）。
 *
 * handler 返回契约：{ ok: true, data: {...} } 或 { ok: false, error: '...' }
 * 字符串字段返回前统一做指令模式剥离（提示注入防御，正则 /忽略|ignore previous|system:/i）。
 * ============================================================ */
'use strict';

(function () {
  // ---------- 宿主全局守卫 ----------
  function getStore() {
    if (typeof Store === 'undefined') throw new Error('Store 未注入');
    return Store;
  }

  // ---------- 工具：剥离提示注入模式 ----------
  function stripInjection(s) {
    if (typeof s !== 'string') return s;
    return s.replace(/忽略|ignore previous|system:|新指令|disregard/gi, '').slice(0, 4000);
  }
  function sanitizeResult(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const out = Array.isArray(obj) ? [] : {};
    for (const k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      const v = obj[k];
      out[k] = typeof v === 'string' ? stripInjection(v) : (v && typeof v === 'object' ? sanitizeResult(v) : v);
    }
    return out;
  }

  // ---------- 工具：解析 clientId（优先 clientId 精确；fallback clientName 精确匹配；都不中则 createClient） ----------
  function resolveClientId(clientId, clientName) {
    const Store = getStore();
    if (clientId) {
      const c = Store.getClient(clientId);
      if (c) return { ok: true, clientId: c.id };
      return { ok: false, error: '来访者 ID「' + clientId + '」不存在' };
    }
    if (!clientName) return { ok: false, error: '需提供 clientId 或 clientName' };
    const match = Store.getClients().find(function (c) { return c.name === clientName; });
    if (match) return { ok: true, clientId: match.id };
    // 多个同名（理论上 Store 用 id 唯一，name 可重）—— 取第一个
    // 无匹配 → 新建
    try {
      const created = Store.createClient({ name: clientName });
      return { ok: true, clientId: created.id, created: true };
    } catch (e) {
      return { ok: false, error: '来访者「' + clientName + '」不存在且新建失败：' + e.message };
    }
  }

  // ============================================================
  // 工具 1：billing.add_record（批量新增会谈记账，写）
  // ============================================================
  const SCHEMA_ADD_RECORD = {
    type: 'function',
    function: {
      name: 'billing.add_record',
      description: '新增一条或多条心理咨询会谈的记账记录（批量用 records 数组）。写操作，执行前会向用户确认。落库路径：fee 经 session.billing.fee 落库，paid 经 session.billing.paid 落库（与现有手动记账等价），settleType/sessionCount 仅作 Agent 认知用不直接落顶层 session 字段。',
      parameters: {
        type: 'object',
        properties: {
          records: {
            type: 'array',
            description: '一条或多条会谈记录',
            items: {
              type: 'object',
              properties: {
                clientName: { type: 'string', description: '来访者姓名，匹配现有来访者；不存在则新建' },
                clientId: { type: 'string', description: '可选，现有来访者ID，优先精确匹配（避免重名歧义）' },
                date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '会谈日期 YYYY-MM-DD' },
                fee: { type: 'number', minimum: 0, description: '本次费用（元）' },
                sessionCount: { type: 'integer', minimum: 1, default: 1, description: '本次记录几节（仅作认知用，handler 不落库为 session 顶层字段）' },
                paid: { type: 'boolean', default: false, description: '是否已收' },
                settleType: { type: 'string', enum: ['次结', '月结'], default: '次结', description: '结算类型（仅作认知用，handler 不落库为 session 顶层字段）' },
                note: { type: 'string', description: '备注' }
              },
              required: ['clientName', 'date', 'fee']
            }
          }
        },
        required: ['records']
      }
    }
  };

  async function addBillingRecord(args) {
    const Store = getStore();
    if (!args || !Array.isArray(args.records) || !args.records.length) {
      return { ok: false, error: 'records 为必填数组' };
    }
    const results = [];
    for (const r of args.records) {
      // 1. 解析 clientId
      const resolved = resolveClientId(r.clientId, r.clientName);
      if (!resolved.ok) { results.push({ skipped: true, reason: resolved.error }); continue; }
      const clientId = resolved.clientId;
      // 2. 写前查重：复用 [billing:KEY] tag 惯例，细化为 [billing:clientId:date:fee]
      //    现有 includes('[billing:') 子串匹配（billing-shell.html L437）仍命中新 tag
      const tag = '[billing:' + clientId + ':' + r.date + ':' + r.fee + ']';
      const existing = Store.getSessionsByClient(clientId).find(function (s) {
        return s.notes && s.notes.indexOf(tag) !== -1;
      });
      if (existing) { results.push({ skipped: true, reason: '已存在相同记录', tag: tag }); continue; }
      // 3. 构造 session 对象并落库
      //    字段路径对齐真代码：billing-sync.js L57-58 + billing-shell.html L443
      //    session 顶层无 fee/paid/sessionCount/settleType；金额走 session.billing.fee，缴费走 session.billing.paid
      //    id/sessionNumber 由 createSession 内部自动填（store.js L374 genId('s') + L376 nextSessionNumber），handler 不重复构造
      const session = {
        clientId: clientId,
        date: r.date,
        durationMinutes: 0,
        type: 'individual',
        billing: { fee: r.fee, paid: !!r.paid, source: 'agent' },
        notes: (r.note ? r.note + '｜' : '') + '[来源：Agent 录入]｜' + tag
      };
      try {
        Store.createSession(session);
        results.push({ ok: true, clientId: clientId, date: r.date, fee: r.fee, paid: !!r.paid, tag: tag });
      } catch (e) {
        results.push({ skipped: true, reason: '落库失败：' + e.message, tag: tag });
      }
    }
    const added = results.filter(function (x) { return x.ok; }).length;
    const skipped = results.filter(function (x) { return x.skipped; }).length;
    return sanitizeResult({ ok: true, data: { added: added, skipped: skipped, details: results } });
  }

  // ============================================================
  // 工具 2：billing.monthly_settle（月结付款录入，写，先读后合并）
  // ============================================================
  const SCHEMA_MONTHLY_SETTLE = {
    type: 'function',
    function: {
      name: 'billing.monthly_settle',
      description: '录入某来访者某月的月结付款金额。写操作，执行前确认。handler 须先读后合并 billing，禁止整体覆盖（避免抹除 feePerSession/billingMode/manualSessions）。',
      parameters: {
        type: 'object',
        properties: {
          clientName: { type: 'string', description: '来访者姓名' },
          clientId: { type: 'string', description: '可选，优先精确匹配，避免重名歧义' },
          month: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: '月份 YYYY-MM' },
          amount: { type: 'number', minimum: 0, description: '月结付款金额（元）' }
        },
        required: ['clientName', 'month', 'amount']
      }
    }
  };

  async function monthlySettle(args) {
    const Store = getStore();
    if (!args || !args.month || typeof args.amount !== 'number') {
      return { ok: false, error: '需提供 clientName/clientId + month + amount' };
    }
    if (args.amount < 0) return { ok: false, error: 'amount 不能为负' };
    // 1. 解析 clientId
    const resolved = resolveClientId(args.clientId, args.clientName);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const clientId = resolved.clientId;
    // 2. 先 getClient 读全量 client（含 billing）
    const client = Store.getClient(clientId);
    if (!client) return { ok: false, error: '来访者不存在' };
    // 3. Object.assign({}, c.billing || {}, { monthlyPayments: [...existing, newMp] }) 合并，绝不整体覆盖
    const existingMonthlyPayments = (client.billing && Array.isArray(client.billing.monthlyPayments)) ? client.billing.monthlyPayments : [];
    const newMp = { month: args.month, amount: args.amount, paidAt: new Date().toISOString() };
    // 写前查重：同月已存在付款记录则跳过
    const dup = existingMonthlyPayments.find(function (mp) { return mp.month === args.month; });
    if (dup) return { ok: false, error: '来访者「' + (client.name || clientId) + '」的 ' + args.month + ' 已存在月结付款记录（¥' + (dup.amount || 0) + '），如需修改请联系开发者或在记账页手动改' };
    const billing = Object.assign({}, client.billing || {}, {
      monthlyPayments: existingMonthlyPayments.concat([newMp])
    });
    try {
      Store.updateClient(clientId, { billing: billing });
      return sanitizeResult({ ok: true, data: { clientId: clientId, month: args.month, amount: args.amount } });
    } catch (e) {
      return { ok: false, error: '月结落库失败：' + e.message };
    }
  }

  // ============================================================
  // 工具 3：billing.summary（记账统计，只读）
  // ============================================================
  const SCHEMA_SUMMARY = {
    type: 'function',
    function: {
      name: 'billing.summary',
      description: '查询记账统计：应收合计、已收合计、某来访者余额等。只读。统计口径：应收=全量会谈 fee，已收=已付会话 fee + monthlyPayments.amount。',
      parameters: {
        type: 'object',
        properties: {
          clientName: { type: 'string', description: '限定某来访者；省略返回全部' },
          clientId: { type: 'string', description: '可选，优先精确匹配' },
          period: { type: 'string', description: "周期，如 '2026-04' 或 'all'（默认 all）。当前版本 handler 暂不按周期过滤，返回全量。" }
        },
        required: []
      }
    }
  };

  async function billingSummary(args) {
    const Store = getStore();
    args = args || {};
    let clients;
    if (args.clientId) {
      const c = Store.getClient(args.clientId);
      if (!c) return { ok: false, error: '来访者 ID「' + args.clientId + '」不存在' };
      clients = [c];
    } else {
      clients = Store.getClients();
      if (args.clientName) {
        clients = clients.filter(function (c) { return c.name === args.clientName; });
        if (!clients.length) return { ok: false, error: '来访者「' + args.clientName + '」不存在' };
      }
    }
    // 注：period 参数当前版本不实际过滤，返回全量；后续可扩展按 month/date 过滤
    let receivable = 0, received = 0;
    const perClient = [];
    for (const c of clients) {
      const sessions = Store.getSessionsByClient(c.id);
      let cReceivable = 0, cReceived = 0;
      for (const s of sessions) {
        // 字段路径对齐 billing-sync.js L57-58：s.billing.fee / s.billing.paid；无 sessionCount
        const fee = (s.billing && s.billing.fee) || 0;
        const paid = !!(s.billing && s.billing.paid);
        cReceivable += fee;
        if (paid) cReceived += fee;
      }
      if (c.billing && Array.isArray(c.billing.monthlyPayments)) {
        for (const mp of c.billing.monthlyPayments) cReceived += (mp.amount || 0);
      }
      receivable += cReceivable;
      received += cReceived;
      perClient.push({ clientId: c.id, name: c.name, receivable: cReceivable, received: cReceived, balance: cReceivable - cReceived });
    }
    return sanitizeResult({
      ok: true,
      data: {
        receivable: receivable,
        received: received,
        balance: receivable - received,
        clientCount: clients.length,
        perClient: perClient
      }
    });
  }

  // ============================================================
  // 工具 4：client.update（改来访者基本信息，写，白名单过滤）
  // ============================================================
  const SCHEMA_UPDATE_CLIENT = {
    type: 'function',
    function: {
      name: 'client.update',
      description: '修改来访者基本信息（姓名/联系方式/备注等）。写操作，执行前确认。handler 先读后合并，禁止整体覆盖。仅允许改 name/phone/email/note/tags 字段，billing 等深层字段禁止经此工具改（用 billing.monthly_settle）。',
      parameters: {
        type: 'object',
        properties: {
          clientId: { type: 'string', description: '来访者ID（必需，精确匹配）' },
          patch: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '姓名/化名' },
              phone: { type: 'string', description: '联系电话' },
              email: { type: 'string', description: '邮箱' },
              note: { type: 'string', description: '备注' },
              tags: { type: 'array', items: { type: 'string' }, description: '标签数组' }
            },
            description: '要修改的字段，只传需要改的'
          }
        },
        required: ['clientId', 'patch']
      }
    }
  };

  async function updateClientInfo(args) {
    const Store = getStore();
    if (!args || !args.clientId || !args.patch) {
      return { ok: false, error: '需提供 clientId + patch' };
    }
    const client = Store.getClient(args.clientId);
    if (!client) return { ok: false, error: '来访者不存在' };
    // 显式白名单：只允许 name/phone/email/note/tags（防 billing 等深层字段整体覆盖）
    const ALLOWED = ['name', 'phone', 'email', 'note', 'tags'];
    const safePatch = {};
    for (const k of ALLOWED) {
      if (k in args.patch) {
        const v = args.patch[k];
        // tags 须为数组
        if (k === 'tags' && !Array.isArray(v)) continue;
        // 字符串字段去掉首尾空
        if (typeof v === 'string') safePatch[k] = v.trim();
        else safePatch[k] = v;
      }
    }
    const updatedKeys = Object.keys(safePatch);
    if (!updatedKeys.length) return { ok: false, error: 'patch 无可识别字段（仅允许 name/phone/email/note/tags）' };
    try {
      Store.updateClient(args.clientId, safePatch);
      return sanitizeResult({ ok: true, data: { clientId: args.clientId, updated: updatedKeys } });
    } catch (e) {
      return { ok: false, error: '更新失败：' + e.message };
    }
  }

  // ============================================================
  // 工具 5：agent.configure_api（配置 AI 接口，kind='config' 不弹确认卡）
  // v1.3.8：新增 provider 预设——用户只需给服务商名 + apiKey，handler 自动查 baseUrl + 默认 model
  // ============================================================
  var API_PROVIDERS = {
    'deepseek': {
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      defaultModel: 'deepseek-chat',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      hint: '国内性价比最高，深度思考能力出色'
    },
    'siliconflow': {
      label: '硅基流动 SiliconFlow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      defaultModel: 'Qwen/Qwen3.5-4B',
      models: ['Qwen/Qwen3.5-4B', 'Qwen/Qwen3-235B-A22B', 'deepseek-ai/DeepSeek-V3', 'meta-llama/Meta-Llama-3.1-405B-Instruct'],
      hint: '聚合多模型，内置免费模型即此平台'
    },
    'openai': {
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
      models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
      hint: '需海外网络，能力强但国内访问不便'
    },
    'moonshot': {
      label: '月之暗面 Kimi',
      baseUrl: 'https://api.moonshot.cn/v1',
      defaultModel: 'moonshot-v1-8k',
      models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
      hint: '长文本上下文，适合长材料分析'
    },
    'zhipu': {
      label: '智谱 AI GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      defaultModel: 'glm-4-flash',
      models: ['glm-4', 'glm-4-flash', 'glm-4-air', 'glm-4-long'],
      hint: '清华系，Flash 版有免费额度'
    },
    'qwen': {
      label: '阿里通义千问',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      defaultModel: 'qwen-plus',
      models: ['qwen-turbo', 'qwen-plus', 'qwen-max', 'qwen-long'],
      hint: '阿里云生态，长文本和 max 版能力强'
    },
    'doubao': {
      label: '字节豆包',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      defaultModel: 'doubao-pro-32k',
      models: ['doubao-pro-32k', 'doubao-pro-4k', 'doubao-lite-32k', 'doubao-1.5-pro-256k'],
      hint: '火山引擎，需先在控制台创建接入点 ID'
    },
    'other': {
      label: '自定义 / 其他',
      baseUrl: '',
      defaultModel: '',
      hint: '其他 OpenAI 兼容平台，需手动指定 baseUrl 和 model'
    }
  };

  var SCHEMA_CONFIGURE_API = {
    type: 'function',
    function: {
      name: 'agent.configure_api',
      description: '为用户配置 AI 接口。用户只需提供服务商预设名（provider）+ API Key 即可——handler 会从内置预设表自动查出 baseUrl 和推荐默认模型。也可手动指定 baseUrl + model 自定义配置。自动写好后后续对话即用新模型。',
      parameters: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            enum: ['deepseek', 'siliconflow', 'openai', 'moonshot', 'zhipu', 'qwen', 'doubao', 'other'],
            description: '服务商预设名，handler 自动查出 baseUrl + 默认 model。选 other 时需手动给 baseUrl + model。'
          },
          apiKey: { type: 'string', description: 'API 密钥，如 sk-...' },
          model: { type: 'string', description: '可选。不传则用该服务商推荐默认模型。' },
          baseUrl: { type: 'string', description: '可选。provider 为 other 或需自定义覆盖预设时填。' }
        },
        required: ['apiKey']
      }
    }
  };

  async function configureApi(args) {
    var Store = getStore();
    if (!args) return { ok: false, error: '参数缺失' };
    // 多轮合并：沿用已存的 partial 配置，本次给的字段覆盖旧的
    var prev = (Store.getSettings().apiConfig) || {};
    var baseUrl = (prev.baseUrl || '').trim();
    var model = (prev.modelPreference || '').trim();
    var provider = (args.provider || prev.provider || '');
    var apiKey = (args.apiKey != null ? String(args.apiKey).trim() : (prev.apiKey || ''));

    // 解析 provider 预设
    if (args.provider && API_PROVIDERS[args.provider]) {
      var p = API_PROVIDERS[args.provider];
      if (args.provider === 'other') {
        if (args.baseUrl) baseUrl = String(args.baseUrl).trim();
        if (args.model) model = String(args.model).trim();
        if (!baseUrl) return { ok: false, error: 'other 服务商需手动指定 baseUrl' };
        if (!model) return { ok: false, error: 'other 服务商需手动指定 model' };
      } else {
        baseUrl = (args.baseUrl || p.baseUrl || baseUrl).trim();
        model = (args.model || p.defaultModel || model).trim();
        if (!baseUrl) return { ok: false, error: '服务商「' + p.label + '」预设 baseUrl 缺失，需手动指定' };
        if (!model) return { ok: false, error: '需指定 model 名' };
      }
    } else if (args.baseUrl && args.model) {
      baseUrl = String(args.baseUrl).trim();
      model = String(args.model).trim();
    }

    var merged = {
      baseUrl: baseUrl,
      apiKey: apiKey,
      modelPreference: model,
      provider: provider,
      maxTokens: 4000,
    };

    // 多轮：密钥还没收齐 → 先存 partial，不测试
    if (!apiKey) {
      Store.saveSettings({ apiConfig: merged });
      return sanitizeResult({
        ok: true,
        data: {
          switchedTo: 'partial',
          need: 'apiKey',
          message: '已记录端点' + (model ? ' 与模型 ' + model : '') + '，还差 API 密钥。请让用户把密钥（sk- 开头）发来。'
        },
      });
    }
    // 端点或模型仍未定 → 提示，不测试
    if (!baseUrl || !model) {
      Store.saveSettings({ apiConfig: merged });
      return sanitizeResult({
        ok: false,
        error: '还需 baseUrl 与 model 才能测试连接（或给一个已知服务商名）'
      });
    }

    // 真实连接测试——档位判定的唯一事实来源
    var test = (typeof AI !== 'undefined' && AI.testConnection)
      ? await AI.testConnection({ baseUrl: baseUrl, apiKey: apiKey, model: model })
      : { ok: true };
    var providerLabel = (provider && API_PROVIDERS[provider]) ? API_PROVIDERS[provider].label : '自定义';
    if (test.ok) {
      merged.verified = true;
      Store.saveSettings({ apiConfig: merged });
      return sanitizeResult({
        ok: true,
        data: {
          switchedTo: 'user',
          provider: providerLabel,
          model: model,
          verified: true,
          message: '接入成功并已验证可用（' + providerLabel + ' · ' + model + '）。你现在是完全体。'
        },
      });
    } else {
      // 测试失败：保留输入供重试，但 verified=false → 档位回 builtin（自动降级）
      merged.verified = false;
      Store.saveSettings({ apiConfig: merged });
      return sanitizeResult({
        ok: true,
        data: {
          switchedTo: 'builtin',
          model: model,
          verified: false,
          testError: test.error,
          message: '连接测试未通过（' + (test.error || '未知错误') + '），已自动降级到内置免费模型。密钥已保留，可检查后重试。'
        },
      });
    }
  }

  // ============================================================
  // 工具 6：navigate_to（提示跳转，不真跳转，kind='read' 不弹确认卡）
  // ============================================================
  const NAV_TARGETS = {
    dashboard:  { label: '工作台',   href: 'index.html' },
    clients:    { label: '来访者',   href: 'clients.html' },
    supervision:{ label: '督导',     href: 'supervision.html' },
    billing:    { label: '记账',     href: 'billing-shell.html' },
    masters:    { label: '大师对话', href: 'masters.html' },
    reports:    { label: '报告中心', href: 'reports.html' }
  };
  const SCHEMA_NAVIGATE_TO = {
    type: 'function',
    function: {
      name: 'navigate_to',
      description: '建议用户跳转到指定页面（督导 / 大师对话 / 记账 / 来访者 / 工作台等）。仅生成跳转提示卡片，由用户主动点击才跳转，不强制跳转。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: Object.keys(NAV_TARGETS), description: '目标页面 key' },
          reason: { type: 'string', description: '为何建议跳转，一句话原因（会出现在提示卡中）' }
        },
        required: ['target', 'reason']
      }
    }
  };
  function handleNavigateTo(args) {
    const target = args && args.target;
    const m = NAV_TARGETS[target];
    if (!m) return { ok: false, error: 'unknown target: ' + target };
    return sanitizeResult({
      ok: true,
      card: {
        kind: 'navigate_hint',
        target: target,
        label: m.label,
        href: m.href,
        reason: (args && args.reason) || '',
        hint: m.label + '页面：可执行更专业的操作'
      },
      summary: '建议跳转到「' + m.label + '」：' + ((args && args.reason) || '')
    });
  }

  // ============================================================
  // 工具 7：supervision.start（启动 AI 督导，写，确认）
  // ============================================================
  const SCHEMA_SUPERVISION_START = {
    type: 'function',
    function: {
      name: 'supervision.start',
      description: '启动 AI 督导（女娲版或仓颉版）。传入督导材料（个案详情），生成整体印象并落库。返回 sessionId 供后续 supervision.ask 追问。写操作，执行前确认。',
      parameters: {
        type: 'object',
        properties: {
          supervisorName: { type: 'string', enum: ['nvwa', 'cangjie'], description: '督导师版本：nvwa=女娲版, cangjie=仓颉版' },
          material: { type: 'string', description: '督导材料（个案详情，至少10字）' },
          clientId: { type: 'string', description: '可选，来访者ID（精确匹配）' },
          clientName: { type: 'string', description: '可选，来访者姓名（模糊匹配或新建）' }
        },
        required: ['supervisorName', 'material']
      }
    }
  };

  const supervisionSessions = {};

  async function startSupervision(args) {
    const Store = getStore();
    if (!args || !args.supervisorName || !args.material) {
      return { ok: false, error: '需提供 supervisorName + material' };
    }
    if (['nvwa', 'cangjie'].indexOf(args.supervisorName) === -1) {
      return { ok: false, error: 'supervisorName 只能是 nvwa 或 cangjie' };
    }
    if (String(args.material).trim().length < 10) {
      return { ok: false, error: '材料至少需要 10 字' };
    }
    if (typeof SupervisionCore === 'undefined') {
      return { ok: false, error: 'SupervisionCore 未注入，请在督导页使用' };
    }
    var resolved = resolveClientId(args.clientId, args.clientName);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    var clientId = resolved.clientId;
    try {
      var result = await SupervisionCore.runImpression(args.supervisorName, args.material);
      if (result.error) return { ok: false, error: result.error };
      var chatMessages = result.chatMessages;
      if (!chatMessages || chatMessages.length < 2) {
        return { ok: false, error: '整体印象生成失败：返回消息不完整' };
      }
      var full = '\u3010\u6574\u4f53\u5370\u8c61\u3011\n' + chatMessages[1].content;
      var supervisorDisplayName = args.supervisorName === 'cangjie'
        ? '\u6e29\u5c3c\u79d1\u7279\u53d6\u5411\u7763\u5bfc\u5e08 \u00b7 \u4ed3\u988d\u7248'
        : '\u6e29\u5c3c\u79d1\u7279\u53d6\u5411\u7763\u5bfc\u5e08 \u00b7 \u5973\u5a23\u7248';
      var sv = Store.saveAiSupervision({
        supervisorName: supervisorDisplayName,
        clientId: clientId,
        sessionId: '',
        context: args.material,
        content: full
      });
      if (!sv) {
        return { ok: false, error: '\u4fdd\u5b58\u5931\u8d25\uff08\u53ef\u80fd\u53d7\u9650\u6a21\u5f0f\u5df2\u8fbe\u7763\u5bfc\u8bb0\u5f55\u4e0a\u9650\uff09' };
      }
      supervisionSessions[sv.id] = chatMessages;
      return sanitizeResult({
        ok: true,
        data: { sessionId: sv.id, impression: chatMessages[1].content, clientId: clientId }
      });
    } catch (e) {
      return { ok: false, error: '\u7763\u5bfc\u542f\u52a8\u5931\u8d25\uff1a' + (e && e.message || e) };
    }
  }

  // ============================================================
  // 工具 8：supervision.ask（督导追问，读/对话，不确认）
  // ============================================================
  const SCHEMA_SUPERVISION_ASK = {
    type: 'function',
    function: {
      name: 'supervision.ask',
      description: '在已有 AI 督导会话中追加追问。对话类，无需确认。返回督导师回复与更新后的会话ID。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '督导会话ID（supervision.start 返回）' },
          question: { type: 'string', description: '追问内容' }
        },
        required: ['sessionId', 'question']
      }
    }
  };

  async function askSupervision(args) {
    if (!args || !args.sessionId || !args.question) {
      return { ok: false, error: '需提供 sessionId + question' };
    }
    if (typeof SupervisionCore === 'undefined') {
      return { ok: false, error: 'SupervisionCore 未注入' };
    }
    var chatMessages = supervisionSessions[args.sessionId];
    if (!chatMessages) {
      return { ok: false, error: '\u7763\u5bfc\u4f1a\u8bdd\u5df2\u8fc7\u671f\u6216\u4e0d\u5b58\u5728\uff0c\u8bf7\u91cd\u65b0\u542f\u52a8\u7763\u5bfc' };
    }
    try {
      var result = await SupervisionCore.runRound(chatMessages, args.question);
      if (result.error) return { ok: false, error: result.error };
      var updatedCMs = result.chatMessages;
      supervisionSessions[args.sessionId] = updatedCMs;
      var fullUpdatedText = '\u3010\u6574\u4f53\u5370\u8c61\u3011\n' + updatedCMs[1].content + '\n\n' +
        updatedCMs.slice(2).map(function (m) {
          return (m.role === 'user' ? '\u54a8\u8be2\u5e08\uff1a' : '\u7763\u5bfc\u5e08\uff1a') + m.content;
        }).join('\n\n');
      try {
        Store.updateSupervision(args.sessionId, { conclusion: fullUpdatedText, content: fullUpdatedText });
      } catch (e) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[Agent] supervision.ask \u9644\u52a0\u5b58\u50a8\u672a\u4fdd\u5b58:', e && e.message || e);
        }
      }
      return sanitizeResult({ ok: true, data: { sessionId: args.sessionId, reply: result.reply } });
    } catch (e) {
      return { ok: false, error: '\u7763\u5bfc\u8ffd\u95ee\u5931\u8d25\uff1a' + (e && e.message || e) };
    }
  }

  // ============================================================
  // 工具 9：masters.open（开启大师对话，轻量写，不确认）
  // ============================================================
  const SCHEMA_MASTERS_OPEN = {
    type: 'function',
    function: {
      name: 'masters.open',
      description: '开启某位心理学大师的对话会话（1v1 或圆桌）。轻量写操作。返回 sessionId 供后续 masters.message 使用。',
      parameters: {
        type: 'object',
        properties: {
          masterId: {
            type: 'string',
            enum: ['winnicott', 'lacan', 'freud', 'klein', 'jung', 'bion', 'rogers', 'beck', 'yalom', 'adler', 'susan_johnson'],
            description: '大师 ID'
          },
          mode: { type: 'string', enum: ['1v1', 'round'], default: '1v1', description: '1v1 或圆桌' },
          topic: { type: 'string', description: '可选，首条消息（会立即发送并获取回复）' }
        },
        required: ['masterId']
      }
    }
  };

  const masterConvs = {};

  async function openMaster(args) {
    if (!args || !args.masterId) {
      return { ok: false, error: '需提供 masterId' };
    }
    if (typeof MastersCore === 'undefined') {
      return { ok: false, error: 'MastersCore 未注入' };
    }
    try {
      var mode = args.mode || '1v1';
      var conv = MastersCore.openOrCreateConv(args.masterId, mode);
      if (!conv) return { ok: false, error: '\u5927\u5e08\u4f1a\u8bdd\u521b\u5efa\u5931\u8d25' };
      var firstReply = null;
      if (args.topic) {
        var master = (typeof getMasterByKey === 'function') ? getMasterByKey(args.masterId) : null;
        if (!master) return { ok: false, error: '\u672a\u627e\u5230\u5927\u5e08\uff1a' + args.masterId };
        var res = await MastersCore.callMaster(conv, master, args.topic);
        if (res && res.error) return { ok: false, error: res.error };
        conv.messages.push({ role: 'user', content: args.topic });
        conv.messages.push({ role: 'assistant', content: res.content, masterKey: args.masterId });
        firstReply = res.content;
        MastersCore.maybeSummarize(conv);
        Store.saveMasterConversation(conv);
      }
      masterConvs[conv.id] = conv;
      return sanitizeResult({
        ok: true,
        data: { sessionId: conv.id, masterName: conv.title, firstReply: firstReply }
      });
    } catch (e) {
      return { ok: false, error: '\u5927\u5e08\u5bf9\u8bdd\u5f00\u542f\u5931\u8d25\uff1a' + (e && e.message || e) };
    }
  }

  // ============================================================
  // 工具 10：masters.message（向大师发消息，轻量写，不确认）
  // ============================================================
  const SCHEMA_MASTERS_MESSAGE = {
    type: 'function',
    function: {
      name: 'masters.message',
      description: '向已开启的大师会话发送一条消息并获取回复。轻量写操作。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '大师会话ID（masters.open 返回）' },
          message: { type: 'string', description: '发送内容' },
          masterId: { type: 'string', description: '可选。圆桌模式下指定回复的大师ID。1v1模式忽略（自动用 conv.masterKeys[0]）。' }
        },
        required: ['sessionId', 'message']
      }
    }
  };

  async function messageMaster(args) {
    if (!args || !args.sessionId || !args.message) {
      return { ok: false, error: '需提供 sessionId + message' };
    }
    if (typeof MastersCore === 'undefined') {
      return { ok: false, error: 'MastersCore 未注入' };
    }
    try {
      var conv = masterConvs[args.sessionId];
      if (!conv && typeof Store !== 'undefined') {
        conv = Store.getMasterConversation(args.sessionId);
      }
      if (!conv) return { ok: false, error: '\u5927\u5e08\u4f1a\u8bdd\u4e0d\u5b58\u5728\u6216\u5df2\u8fc7\u671f' };
      var masterKey = (conv.mode === 'round' && args.masterId) ? args.masterId : conv.masterKeys[0];
      var master = (typeof getMasterByKey === 'function') ? getMasterByKey(masterKey) : null;
      if (!master) master = (typeof getMasterByKey === 'function') ? getMasterByKey(conv.masterKeys[0]) : null;
      if (!master) return { ok: false, error: '\u672a\u627e\u5230\u5927\u5e08\uff1a' + masterKey };
      var res = await MastersCore.callMaster(conv, master, args.message);
      if (res && res.error) return { ok: false, error: res.error };
      conv.messages.push({ role: 'user', content: args.message });
      conv.messages.push({ role: 'assistant', content: res.content, masterKey: masterKey });
      MastersCore.maybeSummarize(conv);
      Store.saveMasterConversation(conv);
      masterConvs[args.sessionId] = conv;
      return sanitizeResult({ ok: true, data: { sessionId: args.sessionId, reply: res.content } });
    } catch (e) {
      return { ok: false, error: '\u5927\u5e08\u6d88\u606f\u53d1\u9001\u5931\u8d25\uff1a' + (e && e.message || e) };
    }
  }

  // ============================================================
  // Tool Registry
  // ============================================================
  const TOOL_REGISTRY = {
    'billing.add_record':     { schema: SCHEMA_ADD_RECORD,     handler: addBillingRecord,  kind: 'write' },
    'billing.monthly_settle': { schema: SCHEMA_MONTHLY_SETTLE, handler: monthlySettle,     kind: 'write' },
    'billing.summary':        { schema: SCHEMA_SUMMARY,        handler: billingSummary,    kind: 'read' },
    'client.update':          { schema: SCHEMA_UPDATE_CLIENT,  handler: updateClientInfo,  kind: 'write' },
    'agent.configure_api':    { schema: SCHEMA_CONFIGURE_API,  handler: configureApi,      kind: 'config' },
    'navigate_to':            { schema: SCHEMA_NAVIGATE_TO,    handler: handleNavigateTo,  kind: 'read' },
    'supervision.start':      { schema: SCHEMA_SUPERVISION_START, handler: startSupervision, kind: 'write' },
    'supervision.ask':        { schema: SCHEMA_SUPERVISION_ASK, handler: askSupervision,    kind: 'read' },
    'masters.open':           { schema: SCHEMA_MASTERS_OPEN,    handler: openMaster,        kind: 'write-light' },
    'masters.message':        { schema: SCHEMA_MASTERS_MESSAGE, handler: messageMaster,     kind: 'write-light' }
  };
  const TOOL_SCHEMAS = Object.keys(TOOL_REGISTRY).map(function (k) { return TOOL_REGISTRY[k].schema; });

  // ---------- 导出 ----------
  if (typeof window !== 'undefined') {
    window.AgentTools = {
      TOOL_REGISTRY: TOOL_REGISTRY,
      TOOL_SCHEMAS: TOOL_SCHEMAS,
      // 单工具手测入口（不经 Orchestrator，直接调 handler）
      invoke: async function (name, args) {
        const t = TOOL_REGISTRY[name];
        if (!t) return { ok: false, error: '未知工具：' + name };
        try { return await t.handler(args || {}); }
        catch (e) { return { ok: false, error: e.message }; }
      }
    };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TOOL_REGISTRY: TOOL_REGISTRY, TOOL_SCHEMAS: TOOL_SCHEMAS };
  }
})();
