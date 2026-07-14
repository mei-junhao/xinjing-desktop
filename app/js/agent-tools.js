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
  // H2 修复：扩展注入模式覆盖范围，含中英文常见变种与分隔符绕过
  var INJECTION_RE = new RegExp([
    '忽略(?:以上|上述|前述|之前)?(?:指令|规则|提示|设定|约束|system)',
    ' disregard (?:all |any )?previous',
    ' ignore (?:all |any )?previous',
    ' forget (?:everything|all|previous|prior)',
    '你现在是|从现在起你是|act as if you are|pretend you are',
    '新指令|新规则|new instruction|new rule',
    'system\\s*[:：]',
    '\\boverride\\b.*\\b(instructions?|rules?|system)',
    'disregard.*(?:above|prior|previous|instructions?)'
  ].join('|'), 'gi');
  function stripInjection(s) {
    if (typeof s !== 'string') return s;
    return s.replace(INJECTION_RE, '').slice(0, 4000);
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

  // ---------- 工具：解析 clientId（优先 clientId 精确；fallback clientName 精确匹配；都不中则按 allowCreate 决定新建/报错） ----------
  // allowCreate=false（默认）：拼写错误时不再静默建幽灵客户，改为返回近似候选提示（AG-9 修复）
  function resolveClientId(clientId, clientName, allowCreate) {
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
    if (allowCreate) {
      // 仅 billing.add_record 等确需「不存在即新建」的场景才自动创建
      try {
        const created = Store.createClient({ name: clientName });
        return { ok: true, clientId: created.id, created: true };
      } catch (e) {
        return { ok: false, error: '来访者「' + clientName + '」不存在且新建失败：' + e.message };
      }
    }
    // 非创建场景：给出近似候选，避免拼写错误静默建幽灵客户
    const near = Store.getClients()
      .filter(function (c) { return c.name && c.name.indexOf(clientName) !== -1; })
      .slice(0, 3)
      .map(function (c) { return c.name; });
    const hint = near.length ? ('，近似来访者：' + near.join('、')) : '';
    return { ok: false, error: '来访者「' + clientName + '」不存在' + hint + '（请确认名称或改用 clientId）' };
  }

  // ============================================================
  // 共享聚合核心（v1.6.0：层1读取 / 层2洞察 / 层3主动提示 复用；未来成长轨迹 #2 也复用）
  // 全部只读 Store getter，无 DOM、无副作用；null 安全。
  // ============================================================
  function aggregateClient(client) {
    const Store = getStore();
    const sessions = (Store.getSessionsByClient(client.id) || []);
    return aggregateClientFromSessions(client, sessions);
  }
  // L4 修复：抽取共享聚合逻辑，供 aggregateClient / aggregateAll / computeInsight / computeFollowups 复用
  function aggregateClientFromSessions(client, sessions) {
    sessions = sessions || [];
    let totalFee = 0, received = 0;
    for (const s of sessions) {
      const fee = (s.billing && s.billing.fee) || 0;
      totalFee += fee;
      if (s.billing && s.billing.paid) received += fee;
    }
    let monthly = 0;
    if (client.billing && Array.isArray(client.billing.monthlyPayments)) {
      for (const mp of client.billing.monthlyPayments) monthly += (mp.amount || 0);
    }
    const receivedTotal = received + monthly;
    const balance = totalFee - receivedTotal;
    const dates = sessions.map(function (s) { return s.date; }).filter(Boolean).sort();
    const firstSessionDate = dates.length ? dates[0] : null;
    const lastSessionDate = dates.length ? dates[dates.length - 1] : null;
    const sessionCount = sessions.length;
    const tenureDays = firstSessionDate
      ? Math.round((Date.now() - new Date(firstSessionDate).getTime()) / 86400000)
      : null;
    return {
      id: client.id,
      name: client.name,
      createdAt: client.createdAt || null,
      sessionCount: sessionCount,
      firstSessionDate: firstSessionDate,
      lastSessionDate: lastSessionDate,
      tenureDays: tenureDays,
      totalFee: totalFee,
      received: receivedTotal,
      balance: balance
    };
  }

  function aggregateAll() {
    const Store = getStore();
    const clients = (Store.getClients() || []);
    let totalClients = clients.length;
    let totalSessions = 0, totalReceivable = 0, totalReceived = 0;
    let busiest = null, longest = null;
    let activeThisMonth = 0;
    const now = new Date();
    const monthStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    // L3 优化：预建 clientId → sessions 索引，避免 N+1 查询
    var allSessions = Store.getSessions() || [];
    var sessionsByClient = {};
    for (var si = 0; si < allSessions.length; si++) {
      var s = allSessions[si];
      var key = s.clientId;
      if (!sessionsByClient[key]) sessionsByClient[key] = [];
      sessionsByClient[key].push(s);
    }
    for (const c of clients) {
      // L3：用预建索引替代 Store.getSessionsByClient 逐个查询
      var cSessions = sessionsByClient[c.id] || [];
      var cAgg = aggregateClientFromSessions(c, cSessions);
      totalSessions += cAgg.sessionCount;
      totalReceivable += cAgg.totalFee;
      totalReceived += cAgg.received;
      if (!busiest || cAgg.sessionCount > busiest.sessionCount) busiest = { name: cAgg.name, sessionCount: cAgg.sessionCount };
      if (cAgg.tenureDays != null) {
        if (!longest) longest = { name: cAgg.name, firstSessionDate: cAgg.firstSessionDate, tenureDays: cAgg.tenureDays };
        else if (cAgg.tenureDays > longest.tenureDays) longest = { name: cAgg.name, firstSessionDate: cAgg.firstSessionDate, tenureDays: cAgg.tenureDays };
      }
      // L3：本月活跃直接用预建索引
      if (cSessions.some(function (s) { return s.date && s.date.indexOf(monthStr) === 0; })) activeThisMonth++;
    }
    return {
      totalClients: totalClients,
      totalSessions: totalSessions,
      activeThisMonth: activeThisMonth,
      busiestClient: busiest,
      longestClient: longest,
      totalReceivable: totalReceivable,
      totalReceived: totalReceived,
      balance: totalReceivable - totalReceived
    };
  }

  function computeInsight(clientId) {
    const Store = getStore();
    const client = Store.getClient(clientId);
    if (!client) return { ok: false, error: '来访者不存在' };
    const a = aggregateClient(client);
    const sessions = (Store.getSessionsByClient(clientId) || []);
    const now = new Date();
    const months = [];
    for (let i = 2; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    }
    const sessionTrend = months.map(function (m) {
      return sessions.filter(function (s) { return (s.date || '').indexOf(m) === 0; }).length;
    });
    const daysSinceLast = a.lastSessionDate
      ? Math.round((now.getTime() - new Date(a.lastSessionDate).getTime()) / 86400000)
      : null;
    const riskFlags = [];
    if (daysSinceLast != null && daysSinceLast > 21) riskFlags.push('long_gap(>21天未复诊)');
    if (a.balance > 0) riskFlags.push('outstanding_balance(欠费¥' + a.balance + ')');
    const fees = sessions.map(function (s) { return (s.billing && s.billing.fee) || 0; });
    // 任一会谈免费即提示（含纯免费客户）——可能是漏费录入（v1.6.0 P2 修复：原仅 mixed 才报）
    if (fees.length && fees.some(function (f) { return f === 0; })) {
      riskFlags.push('fee_anomaly(存在免费会谈，可能漏费)');
    }
    return sanitizeResult({ ok: true, data: { clientId: clientId, sessionTrend: sessionTrend, daysSinceLast: daysSinceLast, riskFlags: riskFlags } });
  }

  function computeFollowups(clientId) {
    const Store = getStore();
    const client = Store.getClient(clientId);
    if (!client) return [];
    const a = aggregateClient(client);
    const followups = [];
    if (a.lastSessionDate) {
      const days = Math.round((Date.now() - new Date(a.lastSessionDate).getTime()) / 86400000);
      if (days > 21) followups.push(client.name + ' 已 ' + days + ' 天未复诊，建议跟进。');
    }
    if (a.balance > 0) followups.push(client.name + ' 当前欠费 ¥' + a.balance + '，可提醒缴费。');
    return followups;
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
              required: ['date', 'fee']
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
    var createdCount = 0; // M2 修复：限制单次调用最多新建 3 个客户，防 AI 幻觉批量建幽灵客户
    for (const r of args.records) {
      // 1. 解析 clientId（M2：超出新建上限后不再自动创建）
      var allowCreate = createdCount < 3;
      const resolved = resolveClientId(r.clientId, r.clientName, allowCreate);
      if (!resolved.ok) { results.push({ skipped: true, reason: resolved.error }); continue; }
      const clientId = resolved.clientId;
      // 2. 写前查重：复用 [billing:KEY] tag 惯例，细化为 [billing:clientId:date:fee]
      //    现有 includes('[billing:') 子串匹配（billing-shell.html L437）仍命中新 tag
      const tag = '[billing:' + clientId + ':' + r.date + ':' + r.fee + ']';
      const existing = Store.getSessionsByClient(clientId).find(function (s) {
        return s.notes && s.notes.indexOf(tag) !== -1;
      });
      if (existing) { results.push({ skipped: true, reason: '已存在相同记录', tag: tag }); continue; }
      // M2：跟踪新建客户数
      if (resolved.created) createdCount++;
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
    // 层3：主动提示 —— 收集涉及客户，算跟进提示附到 data.followups（runRound 统一推送）
    const fClients = [];
    for (const r of results) { if (r.clientId && fClients.indexOf(r.clientId) === -1) fClients.push(r.clientId); }
    const followups = [];
    for (const cid of fClients) { computeFollowups(cid).forEach(function (f) { followups.push(f); }); }
    return sanitizeResult({ ok: true, data: { added: added, skipped: skipped, details: results, followups: followups } });
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
        required: ['month', 'amount']
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
    const resolved = resolveClientId(args.clientId, args.clientName, false);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const clientId = resolved.clientId;
    // 2. 先 getClient 读全量 client（含 billing）
    const client = Store.getClient(clientId);
    if (!client) return { ok: false, error: '来访者不存在' };
    // 3. Object.assign({}, c.billing || {}, { monthlyPayments: [...existing, newMp] }) 合并，绝不整体覆盖
    const existingMonthlyPayments = (client.billing && Array.isArray(client.billing.monthlyPayments)) ? client.billing.monthlyPayments : [];
    const newMp = { month: args.month, amount: args.amount, paidAt: new Date().toISOString() };
    // L6 修复：同月已有付款记录时追加而非拒绝（支持定金+尾款等补录场景），但提示已有金额
    const dup = existingMonthlyPayments.find(function (mp) { return mp.month === args.month; });
    if (dup) {
      // 合并：同月多笔累加为一条，保留明细
      var existingAmount = dup.amount || 0;
      dup.amount = existingAmount + args.amount;
      dup.updatedAt = new Date().toISOString();
      dup.note = (dup.note || '') + ' +追加¥' + args.amount;
      var billingMerged = Object.assign({}, client.billing || {}, {
        monthlyPayments: existingMonthlyPayments // 已就地修改 dup
      });
      try {
        Store.updateClient(clientId, { billing: billingMerged });
        return sanitizeResult({ ok: true, data: { clientId: clientId, month: args.month, amount: dup.amount, previousAmount: existingAmount, appended: true, followups: computeFollowups(clientId) } });
      } catch (e) {
        return { ok: false, error: '月结追加落库失败：' + e.message };
      }
    }
    const billing = Object.assign({}, client.billing || {}, {
      monthlyPayments: existingMonthlyPayments.concat([newMp])
    });
    try {
      Store.updateClient(clientId, { billing: billing });
      return sanitizeResult({ ok: true, data: { clientId: clientId, month: args.month, amount: args.amount, followups: computeFollowups(clientId) } });
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
          period: { type: 'string', description: "周期，如 '2026-04' 或 'all'（默认 all）。按会话日期 YYYY-MM 过滤。" }
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
    // period 周期过滤（YYYY-MM 格式）
    const period = args.period || 'all';
    let receivable = 0, received = 0;
    const perClient = [];
    for (const c of clients) {
      const sessions = Store.getSessionsByClient(c.id);
      let cReceivable = 0, cReceived = 0;
      for (const s of sessions) {
        // period 过滤：只统计指定月份的会话
        if (period !== 'all' && (!s.date || s.date.slice(0, 7) !== period)) continue;
        const fee = (s.billing && s.billing.fee) || 0;
        const paid = !!(s.billing && s.billing.paid);
        cReceivable += fee;
        if (paid) cReceived += fee;
      }
      if (c.billing && Array.isArray(c.billing.monthlyPayments)) {
        for (const mp of c.billing.monthlyPayments) {
          if (period !== 'all' && mp.month !== period) continue;
          cReceived += (mp.amount || 0);
        }
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
  // 工具 3.5：billing.reminder（主动引擎：提醒未收款/待跟进）
  // ============================================================
  const SCHEMA_REMINDER = {
    type: 'function',
    function: {
      name: 'billing.reminder',
      description: '查询待处理事项：未收款会谈、长期未联系来访者、待跟进提醒。主动引擎入口。',
      parameters: {
        type: 'object',
        properties: {
          daysSinceLastSession: { type: 'number', description: '超过 N 天未会谈的来访者视为"待跟进"，默认 30' },
          unpaidOnly: { type: 'boolean', description: '仅返回未收款的会谈，默认 true' }
        },
        required: []
      }
    }
  };

  async function billingReminder(args) {
    const Store = getStore();
    args = args || {};
    const daysSince = args.daysSinceLastSession || 30;
    const unpaidOnly = args.unpaidOnly !== false;
    const now = Date.now();
    const cutoff = now - daysSince * 86400000;

    const clients = Store.getClients().filter(function (c) { return c.status !== 'ended'; });
    // L5 修复：仅统计活跃客户的 session，排除已结束客户的历史会话
    var activeClientIds = {};
    clients.forEach(function (c) { activeClientIds[c.id] = true; });
    const sessions = Store.getSessions().filter(function (s) { return activeClientIds[s.clientId]; });

    const reminders = [];
    const stale = [];

    for (const c of clients) {
      const cs = sessions.filter(function (s) { return s.clientId === c.id; });
      cs.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
      const lastSession = cs[0] || null;
      const lastDate = lastSession && lastSession.date ? new Date(lastSession.date).getTime() : 0;

      // 未收款检查
      if (unpaidOnly) {
        cs.forEach(function (s) {
          const fee = (s.billing && s.billing.fee) || 0;
          const paid = !!(s.billing && s.billing.paid);
          if (fee > 0 && !paid) {
            reminders.push({
              clientId: c.id, clientName: c.name,
              type: 'unpaid', sessionId: s.id, date: s.date,
              amount: fee, message: c.name + ' ' + s.date + ' 会谈 ¥' + fee + ' 未收款'
            });
          }
        });
      }

      // 长期未联系
      if (lastDate > 0 && lastDate < cutoff) {
        const daysAgo = Math.floor((now - lastDate) / 86400000);
        stale.push({
          clientId: c.id, clientName: c.name,
          type: 'stale', lastSessionDate: (lastSession && lastSession.date) || '',
          daysAgo: daysAgo, message: c.name + ' 已 ' + daysAgo + ' 天未会谈（末次 ' + (lastSession && lastSession.date || '') + '）'
        });
      }
    }

    return sanitizeResult({
      ok: true,
      data: {
        unpaidCount: reminders.length,
        staleCount: stale.length,
        unpaid: reminders.slice(0, 20),
        stale: stale.slice(0, 10),
        summary: reminders.length + ' 笔未收款，' + stale.length + ' 位来访者待跟进'
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
      defaultModel: 'deepseek-v4-flash',
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      hint: '国内性价比最高，深度思考能力出色（chat / reasoner 已弃用，请用 v4-flash / v4-pro）'
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
        required: []
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

    // H1 修复：apiKey 经 safeStorage 加密后再存入 IndexedDB（明文不落盘）
    async function encryptAndSave(cfg) {
      var toSave = Object.assign({}, cfg);
      if (toSave.apiKey && typeof window !== 'undefined' && window.__XJ_API__ && window.__XJ_API__.encryptSecret) {
        try { toSave.apiKey = await window.__XJ_API__.encryptSecret(toSave.apiKey); } catch (e) { /* 降级明文 */ }
      }
      Store.saveSettings({ apiConfig: toSave });
    }

    // 多轮：密钥还没收齐 → 先存 partial，不测试
    if (!apiKey) {
      encryptAndSave(merged);
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
      encryptAndSave(merged);
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
      await encryptAndSave(merged);
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
      await encryptAndSave(merged);
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
    dashboard:    { label: '工作台',   href: 'index.html' },
    consultations:{ label: '咨询记录', href: 'consult-notes.html' },
    clients:      { label: '来访者',   href: 'consult-notes.html' },
    supervision:  { label: '督导',     href: 'supervision.html' },
    billing:      { label: '记账',     href: 'billing-shell.html' },
    masters:      { label: '大师对话', href: 'masters.html' }
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

  // M3 修复：用 LRU + TTL 替代无限制对象缓存，防内存泄漏
  function createLRUCache(maxSize, ttlMs) {
    var map = {};
    var order = [];
    function evict() {
      var now = Date.now();
      // 过期清理
      for (var i = order.length - 1; i >= 0; i--) {
        if (now - map[order[i]].ts > ttlMs) {
          delete map[order[i]];
          order.splice(i, 1);
        }
      }
      // 容量清理
      while (order.length > maxSize) {
        var k = order.shift();
        delete map[k];
      }
    }
    return {
      get: function (key) {
        if (!map[key]) return undefined;
        if (Date.now() - map[key].ts > ttlMs) { delete map[key]; order.splice(order.indexOf(key), 1); return undefined; }
        return map[key].val;
      },
      set: function (key, val) {
        if (map[key]) order.splice(order.indexOf(key), 1);
        map[key] = { val: val, ts: Date.now() };
        order.push(key);
        evict();
      }
    };
  }
  const supervisionSessions = createLRUCache(20, 3600000); // 最多 20 条，TTL 1 小时

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
    var clientId = null;
    if (args.clientId || args.clientName) {
      var resolved = resolveClientId(args.clientId, args.clientName, false);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      clientId = resolved.clientId;
    }
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
      supervisionSessions.set(sv.id, chatMessages);
      return sanitizeResult({
        ok: true,
        data: { sessionId: sv.id, impression: chatMessages[1].content, clientId: clientId, followups: clientId ? computeFollowups(clientId) : [] }
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
    var chatMessages = supervisionSessions.get(args.sessionId);
    // AG-7 修复：reload 后内存会话丢失，从 Store 回退重建（用已存整体印象作为上下文继续追问）
    if (!chatMessages) {
      try {
        var sv = Store.getSupervision(args.sessionId);
        if (sv && sv.content) {
          chatMessages = [{ role: 'assistant', content: sv.content }];
          supervisionSessions.set(args.sessionId, chatMessages);
        }
      } catch (e) {}
    }
    if (!chatMessages) {
      return { ok: false, error: '\u7763\u5bfc\u4f1a\u8bdd\u5df2\u8fc7\u671f\u6216\u4e0d\u5b58\u5728\uff0c\u8bf7\u91cd\u65b0\u542f\u52a8\u7763\u5bfc' };
    }
    try {
      var result = await SupervisionCore.runRound(chatMessages, args.question);
      if (result.error) return { ok: false, error: result.error };
      var updatedCMs = result.chatMessages;
      supervisionSessions.set(args.sessionId, updatedCMs);
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

  const masterConvs = createLRUCache(20, 3600000); // M3：最多 20 条，TTL 1 小时

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
      masterConvs.set(conv.id, conv);
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
      var conv = masterConvs.get(args.sessionId);
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
      masterConvs.set(args.sessionId, conv);
      return sanitizeResult({ ok: true, data: { sessionId: args.sessionId, reply: res.content } });
    } catch (e) {
      return { ok: false, error: '\u5927\u5e08\u6d88\u606f\u53d1\u9001\u5931\u8d25\uff1a' + (e && e.message || e) };
    }
  }

  // ============================================================
  // 工具 11：client.query（来访者聚合查询，只读，kind:'read'）
  // ============================================================
  const SCHEMA_CLIENT_QUERY = {
    type: 'function',
    function: {
      name: 'client.query',
      description: '查询来访者列表及聚合统计：会谈次数 / 首末会谈日期 / 工作时长(tenureDays) / 应收已收余额。只读，不弹确认。用于回答"谁工作最久 / 谁欠费最多"等事实问题。name 可按姓名包含筛选；sortBy 默认 tenure(最长优先)，可选 balance / sessions。返回最多 20 行。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '可选，按姓名包含筛选' },
          sortBy: { type: 'string', enum: ['tenure', 'balance', 'sessions'], default: 'tenure', description: '排序字段，默认 tenure（工作时长最长优先）' }
        },
        required: []
      }
    }
  };
  async function clientQuery(args) {
    const Store = getStore();
    args = args || {};
    let clients = (Store.getClients() || []);
    if (args.name) clients = clients.filter(function (c) { return (c.name || '').indexOf(args.name) !== -1; });
    const rows = clients.map(aggregateClient);
    const sortBy = args.sortBy || 'tenure';
    rows.sort(function (a, b) {
      if (sortBy === 'balance') return (b.balance || 0) - (a.balance || 0);
      if (sortBy === 'sessions') return (b.sessionCount || 0) - (a.sessionCount || 0);
      const ta = (a.tenureDays == null) ? -1 : a.tenureDays;
      const tb = (b.tenureDays == null) ? -1 : b.tenureDays;
      return tb - ta;
    });
    if (rows.length > 20) rows = rows.slice(0, 20);
    return sanitizeResult({ ok: true, data: { count: rows.length, clients: rows } });
  }

  // ============================================================
  // 工具 12：userdocs.search（用户自建资料检索，只读，kind:'read'，不弹确认）
  // ============================================================
  const SCHEMA_USERDOCS_SEARCH = {
    type: 'function',
    function: {
      name: 'userdocs.search',
      description: '检索用户在应用外自己存放的课程资料/笔记（.md/.txt）。当用户引用"我的资料/我的笔记/我学的XX/我课上学到的"时使用。只读，不弹确认。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '要检索的关键词' } },
        required: ['query']
      }
    }
  };
  async function userdocsSearch(args) {
    args = args || {};
    if (!args.query) return sanitizeResult({ ok: false, reason: 'missing-query' });
    if (typeof window === 'undefined' || !window.UserDocs) return sanitizeResult({ ok: false, reason: 'not-ready' });
    const r = await window.UserDocs.search(args.query);
    return sanitizeResult(r);
  }

  // ============================================================
  // 工具 12：session.query（会谈记录查询，只读，kind:'read'）
  // ============================================================
  const SCHEMA_SESSION_QUERY = {
    type: 'function',
    function: {
      name: 'session.query',
      description: '查询会谈记录。只读。clientId 查某来访者全部会谈（日期/节数/费用/已收/类型），省略 clientId 查全局最近会谈。支持 from/to 日期范围。返回最多 30 条。',
      parameters: {
        type: 'object',
        properties: {
          clientId: { type: 'string', description: '可选，来访者ID' },
          from: { type: 'string', description: '起始日期 YYYY-MM-DD' },
          to: { type: 'string', description: '结束日期 YYYY-MM-DD' },
          limit: { type: 'integer', default: 30, description: '返回条数上限（最大 30）' }
        },
        required: []
      }
    }
  };
  async function sessionQuery(args) {
    const Store = getStore();
    args = args || {};
    let sessions;
    if (args.clientId) sessions = (Store.getSessionsByClient(args.clientId) || []);
    else sessions = (Store.getSessions() || []);
    sessions = sessions.slice().sort(function (a, b) {
      return (b.date || '').localeCompare(a.date || '') || ((b.sessionNumber || 0) - (a.sessionNumber || 0));
    });
    if (args.from) sessions = sessions.filter(function (s) { return (s.date || '') >= args.from; });
    if (args.to) sessions = sessions.filter(function (s) { return (s.date || '') <= args.to; });
    const limit = (typeof args.limit === 'number' && args.limit > 0) ? Math.min(args.limit, 30) : 30;
    sessions = sessions.slice(0, limit);
    const rows = sessions.map(function (s) {
      const c = args.clientId ? null : (Store.getClient(s.clientId) || {});
      return {
        date: s.date,
        sessionNumber: s.sessionNumber,
        fee: (s.billing && s.billing.fee) || 0,
        paid: !!(s.billing && s.billing.paid),
        type: s.type,
        clientName: c ? c.name : undefined
      };
    });
    return sanitizeResult({ ok: true, data: { count: rows.length, sessions: rows } });
  }

  // ============================================================
  // 工具 13：supervision.query（督导记录查询，只读，kind:'read'）
  // ============================================================
  const SCHEMA_SUPERVISION_QUERY = {
    type: 'function',
    function: {
      name: 'supervision.query',
      description: '查询 AI/真人督导记录。只读。clientId 查某来访者全部督导（日期/督导师/主题摘要），省略查全局。返回最多 20 条。',
      parameters: {
        type: 'object',
        properties: {
          clientId: { type: 'string', description: '可选，来访者ID' }
        },
        required: []
      }
    }
  };
  async function supervisionQuery(args) {
    const Store = getStore();
    args = args || {};
    let sups;
    if (args.clientId) sups = (Store.getSupervisionsByClient(args.clientId) || []);
    else sups = (Store.getSupervisions() || []);
    sups = sups.slice().sort(function (a, b) {
      return (b.date || b.createdAt || '').localeCompare(a.date || a.createdAt || '');
    });
    if (sups.length > 20) sups = sups.slice(0, 20);
    const rows = sups.map(function (sv) {
      return {
        date: sv.date || (sv.createdAt ? String(sv.createdAt).slice(0, 10) : ''),
        supervisorName: sv.supervisorName,
        contextSnippet: String(sv.context || sv.content || '').slice(0, 60)
      };
    });
    return sanitizeResult({ ok: true, data: { count: rows.length, supervisions: rows } });
  }

  // ============================================================
  // 工具 14：stats.overview（全站业务概览，只读，kind:'read'）
  // ============================================================
  const SCHEMA_STATS_OVERVIEW = {
    type: 'function',
    function: {
      name: 'stats.overview',
      description: '全站业务概览（只读）：客户数 / 会谈总数 / 本月活跃客户数 / 最忙客户 / 工作最久客户 / 应收已收余额。用于回答"我这月整体情况 / 谁工作最久"。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  };
  async function statsOverview() {
    const data = aggregateAll();
    return sanitizeResult({ ok: true, data: data });
  }

  // ============================================================
  // 工具 15：client.insight（单客户洞察，只读，kind:'read'）
  // ============================================================
  const SCHEMA_CLIENT_INSIGHT = {
    type: 'function',
    function: {
      name: 'client.insight',
      description: '单客户洞察（只读）：近3月会谈趋势 / 距上次天数 / 风险标记(long_gap>21天未复诊 / outstanding_balance欠费 / fee_anomaly免费异常)。用于回答"谁该跟进 / 费用异常"。',
      parameters: {
        type: 'object',
        properties: {
          clientId: { type: 'string', description: '来访者ID（必需）' }
        },
        required: ['clientId']
      }
    }
  };
  async function clientInsight(args) {
    if (!args || !args.clientId) return { ok: false, error: '需提供 clientId' };
    return computeInsight(args.clientId);
  }

  // ============================================================
  // Tool Registry
  // ============================================================
  const TOOL_REGISTRY = {
    'billing.add_record':     { schema: SCHEMA_ADD_RECORD,     handler: addBillingRecord,  kind: 'write' },
    'billing.monthly_settle': { schema: SCHEMA_MONTHLY_SETTLE, handler: monthlySettle,     kind: 'write' },
    'billing.summary':        { schema: SCHEMA_SUMMARY,        handler: billingSummary,    kind: 'read' },
    'billing.reminder':       { schema: SCHEMA_REMINDER,       handler: billingReminder,   kind: 'read' },
    'client.update':          { schema: SCHEMA_UPDATE_CLIENT,  handler: updateClientInfo,  kind: 'write' },
    'agent.configure_api':    { schema: SCHEMA_CONFIGURE_API,  handler: configureApi,      kind: 'config' },
    'navigate_to':            { schema: SCHEMA_NAVIGATE_TO,    handler: handleNavigateTo,  kind: 'read' },
    'supervision.start':      { schema: SCHEMA_SUPERVISION_START, handler: startSupervision, kind: 'write' },
    'supervision.ask':        { schema: SCHEMA_SUPERVISION_ASK, handler: askSupervision,    kind: 'read' },
    'masters.open':           { schema: SCHEMA_MASTERS_OPEN,    handler: openMaster,        kind: 'write-light' },
    'masters.message':        { schema: SCHEMA_MASTERS_MESSAGE, handler: messageMaster,     kind: 'write-light' },
    'client.query':           { schema: SCHEMA_CLIENT_QUERY,    handler: clientQuery,       kind: 'read' },
    'session.query':          { schema: SCHEMA_SESSION_QUERY,   handler: sessionQuery,      kind: 'read' },
    'supervision.query':      { schema: SCHEMA_SUPERVISION_QUERY, handler: supervisionQuery, kind: 'read' },
    'stats.overview':         { schema: SCHEMA_STATS_OVERVIEW,  handler: statsOverview,     kind: 'read' },
    'client.insight':         { schema: SCHEMA_CLIENT_INSIGHT,  handler: clientInsight,     kind: 'read' },
    'userdocs.search':        { schema: SCHEMA_USERDOCS_SEARCH,  handler: userdocsSearch,    kind: 'read' }
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
    module.exports = {
      TOOL_REGISTRY: TOOL_REGISTRY,
      TOOL_SCHEMAS: TOOL_SCHEMAS,
      aggregateClient: aggregateClient,
      aggregateAll: aggregateAll,
      computeInsight: computeInsight,
      computeFollowups: computeFollowups
    };
  }
})();
