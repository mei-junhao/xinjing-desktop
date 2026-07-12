/* ============================================================
 * 心镜 XinJing — Agent Orchestrator 纯核（v1.3.0 U1）
 *
 * function-calling 循环状态机：INIT→AWAIT→THINKING→DISPATCH→
 * CONFIRM(写)→EXECUTE→OBSERVE→RESPOND→AWAIT(循环)；
 * ERROR/ABORT 回 AWAIT。
 *
 * 范式：IIFE + window.AgentCore 全局，被 agent-shell.js 调用。
 * 依赖裸全局 AI/Store/App + typeof 守卫，无 DOM API
 * （与 supervision-core.js / masters-core.js 同范式）。
 *
 * 不弹 DOM——确认 UX 由调用方注入 onConfirm 回调驱动：
 *   onConfirm(toolCall, args) → { ok: true } | { ok: false, edited: true, args: {...} } | { ok: false }
 * ============================================================ */
'use strict';

(function () {
  const MAX_STEPS = 8;
  const WINDOW = 20;
  const TOOL_RESULT_MAX = 4000;

  // ---------- 宿主全局守卫 ----------
  function getAI() {
    if (typeof AI === 'undefined') throw new Error('AI 未注入');
    return AI;
  }
  function getStore() {
    if (typeof Store === 'undefined') throw new Error('Store 未注入');
    return Store;
  }
  function getTools() {
    if (typeof AgentTools === 'undefined') throw new Error('AgentTools 未注入');
    return AgentTools;
  }
  function isUnlocked() {
    if (typeof App === 'undefined' || typeof App.aiUnlocked !== 'function') return true;
    return App.aiUnlocked();
  }

  // ---------- 工具：上下文截断（保留未闭合 tool_call/tool_result 对） ----------
  // 关键约束（DeepSeek / OpenAI 兼容端点）：
  //   ① 任何 role:'tool' 消息必须紧跟在含匹配 tool_call_id 的 assistant(tool_calls) 之后；
  //   ② assistant 含 tool_calls 时，其每个 tool_call 都必须有对应的 tool 结果消息。
  // 否则报 HTTP 400（"Messages with role 'tool' must be a response to a preceding message with 'tool_calls' id"）。
  // 因此将 assistant(tool_calls)+其后连续的 tool* 视为一个【原子单元】，窗口截断时整组保留或整组丢弃，
  // 绝不允许从中间拆开产生孤儿 tool 消息 / 未应答的 tool_call。
  function trimToWindow(messages, windowSize) {
    if (!Array.isArray(messages) || messages.length <= windowSize) return messages;
    const system = [];
    const nonSystem = [];
    for (let k = 0; k < messages.length; k++) {
      if (messages[k].role === 'system') system.push(messages[k]);
      else nonSystem.push(messages[k]);
    }
    if (nonSystem.length <= windowSize) return system.concat(nonSystem);

    // 切分为原子单元
    const units = [];
    let i = 0;
    while (i < nonSystem.length) {
      const m = nonSystem[i];
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const unit = [m];
        i++;
        while (i < nonSystem.length && nonSystem[i].role === 'tool') {
          unit.push(nonSystem[i]);
          i++;
        }
        units.push(unit);
      } else {
        units.push([m]);
        i++;
      }
    }
    // 从尾部贪心取，整单元不拆；允许略微不足 windowSize 以保完整
    const result = [];
    let count = 0;
    for (let j = units.length - 1; j >= 0; j--) {
      const unit = units[j];
      if (count + unit.length > windowSize && result.length > 0) break;
      result.unshift.apply(result, unit);
      count += unit.length;
    }
    // 极端兜底：若上述循环因首个单元就超窗口导致 result 为空，强制保留最后一个单元
    if (result.length === 0 && units.length) {
      result.push.apply(result, units[units.length - 1]);
    }
    // 安全保障：若首条仍是孤立 tool（理论不会），丢弃
    while (result.length > 0 && result[0].role === 'tool') {
      result.shift();
    }
    return system.concat(result);
  }

  // ---------- 工具：JSON Schema 简校验（draft-07 子集） ----------
  function validateSchema(args, schema) {
    if (!schema || !schema.function || !schema.function.parameters) return null;
    const params = schema.function.parameters;
    if (!args || typeof args !== 'object') {
      if (params.type === 'object') return '参数须为对象';
      return null;
    }
    // required 检查
    if (Array.isArray(params.required)) {
      for (const k of params.required) {
        if (!(k in args) || args[k] === undefined || args[k] === null) {
          return '缺少必填字段：' + k;
        }
      }
    }
    // properties 类型检查（仅做浅层，深度交给 handler 业务校验）
    if (params.properties) {
      for (const k in args) {
        if (!Object.prototype.hasOwnProperty.call(params.properties, k)) continue;
        const spec = params.properties[k];
        const v = args[k];
        if (v === undefined || v === null) continue;
        if (spec.type === 'string' && typeof v !== 'string') return k + ' 须为字符串';
        if (spec.type === 'number' && typeof v !== 'number') return k + ' 须为数字';
        if (spec.type === 'integer' && (!Number.isInteger(v))) return k + ' 须为整数';
        if (spec.type === 'boolean' && typeof v !== 'boolean') return k + ' 须为布尔';
        if (spec.type === 'array' && !Array.isArray(v)) return k + ' 须为数组';
        if (spec.type === 'object' && (typeof v !== 'object' || Array.isArray(v))) return k + ' 须为对象';
        if (spec.minimum !== undefined && typeof v === 'number' && v < spec.minimum) return k + ' 不能小于 ' + spec.minimum;
        if (spec.pattern && typeof v === 'string') {
          const re = new RegExp(spec.pattern.replace(/^\/|\/$/g, ''));
          if (!re.test(v)) return k + ' 格式不符：' + spec.pattern;
        }
        if (Array.isArray(spec.enum) && spec.enum.indexOf(v) === -1) return k + ' 须为枚举值之一：' + spec.enum.join('/');
      }
    }
    return null;
  }

  // ---------- 工具：safeParse / toolError / toolAbort ----------
  function safeParse(s) {
    if (typeof s !== 'string') return {};
    try { return JSON.parse(s); } catch (e) { return {}; }
  }
  function toolError(tc, msg) {
    return { role: 'tool', tool_call_id: tc.id || '', content: '{"ok":false,"error":' + JSON.stringify(String(msg)) + '}' };
  }
  function toolAbort(tc) {
    return { role: 'tool', tool_call_id: tc.id || '', content: '{"ok":false,"error":"用户取消"}' };
  }

  // ---------- 主循环：runRound ----------
  // onConfirm(toolCall, args) → Promise<{ ok, edited?, args? }>
  // onProgress(toolName, status, result?) → 同步回调，状态：'executing' / 'done'
  // 返回 { reply, messages, error? }
  async function runRound(messages, onConfirm, onProgress) {
    const AI = getAI();
    const tools = getTools();
    const toolSchemas = tools.TOOL_SCHEMAS;
    const registry = tools.TOOL_REGISTRY;

    // 线格式消毒：DeepSeek / OpenAI 兼容端点要求工具名匹配 ^[A-Za-z0-9_-]{1,64}$
    // 内部契约仍用点号名（billing.add_record 等），仅在发往模型时消毒，并建立 wire→internal 映射
    const internalMap = {};
    function wireName(n) { return String(n).replace(/[^A-Za-z0-9_-]/g, '_'); }
    const wireSchemas = toolSchemas.map(function (s) {
      const wn = wireName(s.function.name);
      internalMap[wn] = s.function.name;
      return { type: 'function', function: Object.assign({}, s.function, { name: wn }) };
    });

    if (!isUnlocked()) {
      return { error: '授权已失效，请重新激活后继续' };
    }

    let steps = 0;
    while (steps < MAX_STEPS) {
      if (!isUnlocked()) {
        return { error: '授权已失效，请重新激活后继续' };
      }
      const trimmed = trimToWindow(messages, WINDOW);
      let resp;
      try {
        // ai.js send(messages, callback, options) 是回调形态；用 Promise 包裹，不修改 ai.js 签名
        resp = await new Promise(function (resolve, reject) {
          AI.send(trimmed, function (r) {
            if (r && r.error) reject(new Error(r.error));
            else resolve(r);
          }, { tools: wireSchemas, tool_choice: 'auto' });
        });
      } catch (e) {
        return { error: '模型调用失败：' + (e.message || '未知错误') };
      }
      // 兼容 {choices:[{message}]} 与 {content, tool_calls, tier} 两种形态
      const msg = (resp && resp.choices && resp.choices[0] && resp.choices[0].message) || resp;
      // 归一化 tool_calls 的 id：个别端点可能省略 id，DeepSeek 要求必填且须与 tool 结果消息的
      // tool_call_id 一一对应，否则报 HTTP 400
      if (msg && Array.isArray(msg.tool_calls)) {
        msg.tool_calls = msg.tool_calls.map(function (tc, idx) {
          const id = (tc && tc.id) ? tc.id : ('call_' + Date.now() + '_' + idx);
          const fn = (tc && tc.function) ? tc.function : {};
          return { id: id, type: 'function', function: fn };
        });
      }
      messages.push(msg);
      if (!msg.tool_calls || !Array.isArray(msg.tool_calls) || !msg.tool_calls.length) {
        return { reply: msg.content || '', messages: messages };
      }
      // 分发 tool_calls
      for (const tc of msg.tool_calls) {
        const rawName = (tc.function && tc.function.name) || '';
        const toolKey = internalMap[rawName] || rawName; // 映射回内部点号名
        const tool = registry[toolKey];
        // 归一化 tc（function.name 用内部名），供 onConfirm / 确认卡预览按点号名匹配
        const normTc = tc.function
          ? Object.assign({}, tc, { function: Object.assign({}, tc.function, { name: toolKey }) })
          : tc;
        if (!tool) {
          messages.push(toolError(tc, '未知工具：' + toolKey));
          continue;
        }
        const args = safeParse(tc.function && tc.function.arguments);
        const err = validateSchema(args, tool.schema);
        if (err) {
          messages.push(toolError(tc, '参数校验失败：' + err));
          continue;
        }
        // 写工具：走确认 UX
        if (tool.kind === 'write') {
          if (typeof onConfirm !== 'function') {
            messages.push(toolError(tc, '写工具未配置确认回调'));
            continue;
          }
          let decision;
          try {
            decision = await onConfirm(normTc, args);
          } catch (e) {
            messages.push(toolError(tc, '确认回调异常：' + e.message));
            continue;
          }
          if (!decision || !decision.ok) {
            if (decision && decision.edited && decision.args) {
              // 修改路径：重校验 schema
              Object.assign(args, decision.args);
              const err2 = validateSchema(args, tool.schema);
              if (err2) {
                messages.push(toolError(tc, '修改后参数不合法：' + err2));
                continue;
              }
            } else {
              messages.push(toolAbort(tc));
              continue;
            }
          }
        }
        // 执行
        steps++;
        try {
          if (typeof onProgress === 'function') onProgress(toolKey, 'executing');
          const result = await tool.handler(args);
          const content = JSON.stringify(result).slice(0, TOOL_RESULT_MAX);
          messages.push({ role: 'tool', tool_call_id: tc.id || '', content: content });
          if (typeof onProgress === 'function') onProgress(toolKey, 'done', result);
        } catch (e) {
          messages.push(toolError(tc, e.message || '工具执行异常'));
        }
      }
    }
    return { error: '操作步数超限（' + MAX_STEPS + ' 步），请分步或改用批量 records' };
  }

  // ---------- 构建系统提示 ----------
  function buildSystemPrompt() {
    let tools = '';
    try { tools = getTools(); } catch (e) { /* 未注入时降级 */ }
    let toolList = '';
    if (tools && tools.TOOL_REGISTRY) {
      toolList = Object.keys(tools.TOOL_REGISTRY).map(function (k) {
        const t = tools.TOOL_REGISTRY[k];
        const desc = (t.schema && t.schema.function && t.schema.function.description) || '';
        return '- ' + k + '：' + desc;
      }).join('\n');
    }
    // 可选注入来访者列表（本版注入 name+id，与设计文档 M3 调和见方案 §10 #4）
    let clientList = '';
    try {
      const Store = getStore();
      const clients = Store.getClients();
      if (Array.isArray(clients) && clients.length) {
        clientList = '\n\n现有来访者（clientId + 姓名）：\n' + clients.map(function (c) {
          return '- ' + c.id + ' · ' + (c.name || '(无名)');
        }).join('\n');
      }
    } catch (e) { /* ignore */ }

    return [
      '你是心镜 XinJing 的工作助手。你可以通过工具帮用户完成：记账录入 / 月结 / 统计查询 / 改来访者信息 / 启动 AI 督导（女娲版或仓颉版）/ 督导追问 / 开启大师对话 / 向大师发消息 / API 接口配置。',
      '规则：',
      '1. 你只能调用提供的工具，不要凭空编造数据。',
      '2. 写操作（记账/月结/改信息/督导启动）执行前会向用户确认，你只需发起 tool_call，不要在回复里假装已执行。',
      '3. 如果用户请求含多条记录，用 records 数组一次性提交，不要分多次调用。',
      '4. 查不到来访者时先问用户是否新建，不要自行假设。',
      '5. 金额日期等字段严格按 schema 填，不要省略 required 字段。',
      '6. 你不生成诊断、不替代临床判断、不替代真人督导。',
      '7. 督导与大师对话涉及深度临床分析，请提醒用户：Agent 浮窗是便捷入口，完整界面请在对应页面使用。',
      '8. 配置 API 接口时，如果用户只说了服务商名（如 DeepSeek 或 硅基流动）和密钥，从 agent.configure_api 的 provider 参数填预设名即可——handler 会自动查出 baseUrl 和默认 model。不要让用户手动找 baseUrl 和 model 名。若用户说出未在预设列表的服务商，选 other 并问用户要 baseUrl 和 model 名。',
      '',
      '可用工具：',
      toolList || '（未注入工具）',
      clientList,
      // 档位提示：内置低性能模型提醒只能做普通任务；用户高性能模型提示已是完全体
      (function () {
        try {
          if (typeof AI !== 'undefined' && AI.getTier) {
            return AI.getTier() === 'builtin'
              ? '\n\n[档位] 你运行在内置低性能免费模型（Qwen3.5-4B，永久免费），只能完成普通任务（记账 / 月结 / 查统计 / 改来访者信息 / 配 API）。复杂长篇分析、真人督导式深度工作请引导用户填入自己高性能模型的 key——支持的服务商：DeepSeek / 硅基流动 / OpenAI / 月之暗面 Kimi / 智谱 / 通义千问 / 豆包。用户只需说出服务商名和 API Key，你就能从内置预设表自动帮用户配好。'
              : '\n\n[档位] 你已接入用户的高性能模型，是完全体，可以完成更复杂的任务。';
          }
        } catch (e) { /* ignore */ }
        return '';
      })()
    ].join('\n');
  }

  // ---------- 导出 ----------
  if (typeof window !== 'undefined') {
    window.AgentCore = {
      runRound: runRound,
      buildSystemPrompt: buildSystemPrompt,
      MAX_STEPS: MAX_STEPS,
      WINDOW: WINDOW,
      TOOL_RESULT_MAX: TOOL_RESULT_MAX
    };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      runRound: runRound,
      buildSystemPrompt: buildSystemPrompt,
      trimToWindow: trimToWindow,
      MAX_STEPS: MAX_STEPS,
      WINDOW: WINDOW,
      TOOL_RESULT_MAX: TOOL_RESULT_MAX
    };
  }
})();
