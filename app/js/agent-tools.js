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
  // 工具 5：agent.configure_api（配置 AI 接口，写设置但不弹确认卡，kind='config'）
  // ============================================================
  const SCHEMA_CONFIGURE_API = {
    type: 'function',
    function: {
      name: 'agent.configure_api',
      description: '为用户配置 AI 接口（apiKey / baseUrl / model）。自动写好后后续对话即用新模型。当用户给出自己的高性能模型 key 后调用本工具即可自动切换，无需再确认。',
      parameters: {
        type: 'object',
        properties: {
          apiKey: { type: 'string', description: 'API 密钥（Bearer Token），如 sk-...' },
          baseUrl: { type: 'string', description: 'OpenAI 兼容 Base URL，如 https://api.siliconflow.cn/v1' },
          model: { type: 'string', description: '模型名，如 Qwen/Qwen3.5-4B 或 deepseek-chat 或 gpt-4o' }
        },
        required: ['apiKey', 'baseUrl', 'model']
      }
    }
  };

  async function configureApi(args) {
    const Store = getStore();
    if (!args || !args.apiKey || !args.baseUrl || !args.model) {
      return { ok: false, error: '需提供 apiKey + baseUrl + model' };
    }
    Store.saveSettings({
      apiConfig: {
        baseUrl: String(args.baseUrl).trim(),
        apiKey: String(args.apiKey).trim(),
        modelPreference: String(args.model).trim(),
        maxTokens: 4000,
      },
    });
    return sanitizeResult({
      ok: true,
      data: {
        switchedTo: 'user',
        model: args.model,
        note: '已切换到你的高性能模型，我现在是完全体，可以做更多事',
      },
    });
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
  // Tool Registry
  // ============================================================
  const TOOL_REGISTRY = {
    'billing.add_record':     { schema: SCHEMA_ADD_RECORD,     handler: addBillingRecord,  kind: 'write' },
    'billing.monthly_settle': { schema: SCHEMA_MONTHLY_SETTLE, handler: monthlySettle,     kind: 'write' },
    'billing.summary':        { schema: SCHEMA_SUMMARY,        handler: billingSummary,    kind: 'read' },
    'client.update':          { schema: SCHEMA_UPDATE_CLIENT,  handler: updateClientInfo,  kind: 'write' },
    'agent.configure_api':    { schema: SCHEMA_CONFIGURE_API,  handler: configureApi,      kind: 'config' },
    'navigate_to':            { schema: SCHEMA_NAVIGATE_TO,    handler: handleNavigateTo,  kind: 'read' }
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
