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
  // 2026-09-12（XJ-512-009 缺陷1）：8→5。实测退化循环场景下模型拿到检索结果仍反复发同一工具调用，
  // 8 步只延长用户等待、并不提高成功率；压到 5 步让失败更早收敛到明确回复。
  const MAX_STEPS = 5;
  const WINDOW = 20;
  const TOOL_RESULT_MAX = 4000;
  const READ_RESULT_MAX = 20000; // 读/洞察类工具结果较大，用更高上限避免半截 JSON（v1.6.0 B1 修复）
  // 2026-09-12（XJ-512-009 缺陷1 层②）：工具协议漂移标记。模型在 tool_choice:'none' 的强制文字阶段
  // 会退化为输出 Claude/Anthropic 风格的 XML 工具调用文本（</toolcall><toolcall name="...">…</invoke>），
  // 客户端若不拦截会原样渲染成"未执行的工具调用"回复。
  const PROTOCOL_DRIFT_PATTERNS = [
    /<\/?toolcall\b[^>]*>/i,
    /<\/?invoke\b[^>]*>/i,
    /<\/?parameter\b[^>]*>/i,
    /<\/?function_calls\b[^>]*>/i,
    /<\/?antml:invoke\b[^>]*>/i,
    /<\/?antml:parameter\b[^>]*>/i
  ];
  const REDIRECT_ONLY_TOOLS = new Set([
    'supervision.start',
    'supervision.ask',
    'masters.open',
    'masters.message'
  ]);

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
    let result = [];
    let count = 0;
    for (let j = units.length - 1; j >= 0; j--) {
      const unit = units[j];
      if (count + unit.length > windowSize) break;
      result.unshift.apply(result, unit);
      count += unit.length;
    }
    // 极端兜底：若上述循环因首个单元就超窗口导致 result 为空，强制保留最后一个单元
    if (result.length === 0 && units.length) {
      result.push.apply(result, units[units.length - 1]);
    }
    // L1 修复：确保 system 消息始终保留（即使窗口极小）
    var hasSystem = result.some(function (m) { return m.role === 'system'; });
    if (!hasSystem && system.length) {
      result = system.concat(result);
    }
    // 安全保障：若首条仍是孤立 tool（理论不会），丢弃
    while (result.length > 0 && result[0].role === 'tool') {
      result.shift();
    }
    return result;
  }

  // ---------- 工具：XML 工具调用文本过滤（XJ-512-009 缺陷1 层②） ----------
  // 背景：模型在 tool_choice:'none' 强制文字阶段不再返回 JSON tool_calls，而是把工具调用
  // 写成 Claude/Anthropic 风格 XML 普通文本。这种文本不是真调用、也不会被执行，若直接渲染
  // 就成了用户看到的"未执行的工具调用"回复。此处只做展示层剥离，不猜测模型意图、不伪造工具结果。
  function looksLikeProtocolDrift(text) {
    if (typeof text !== 'string') return false;
    for (let i = 0; i < PROTOCOL_DRIFT_PATTERNS.length; i++) {
      if (PROTOCOL_DRIFT_PATTERNS[i].test(text)) return true;
    }
    return false;
  }

  // 返回 { text, stripped }：stripped=true 表示确实剥离过 XML 片段。
  function stripXmlToolCalls(text) {
    if (typeof text !== 'string' || !text) return { text: text || '', stripped: false };
    let out = text;
    // 去成对块：<invoke …>…</invoke> / <toolcall …>…</toolcall> / <function_calls>…</function_calls>
    out = out.replace(/<(?:antml:)?(?:invoke|toolcall|function_calls)\b[^>]*>[\s\S]*?<\/(?:antml:)?(?:invoke|toolcall|function_calls)>/gi, '');
    // 去残留开闭标签（含自闭合）
    out = out.replace(/<\/?(?:antml:)?(?:invoke|toolcall|function_calls|parameter)\b[^>]*>/gi, '');
    // 去可能残留的孤立 </invoke> 之类零散闭合标签
    out = out.replace(/<\/(?:antml:)?[a-z_:]+\s*>/gi, function (m) {
      return looksLikeProtocolDrift(m) ? '' : m;
    });
    // 折叠因剥离产生的大量空行，避免回复成为一片空白
    out = out.replace(/\n{3,}/g, '\n\n').trim();
    const stripped = looksLikeProtocolDrift(text);
    return { text: out, stripped: stripped };
  }

  const DRIFT_NOTICE = '模型输出格式异常（返回了未执行的工具调用文本），已忽略该部分内容。请重新提问，或换用支持 function-calling 的模型。';

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
          // M1 修复：防止 ReDoS——限制正则执行时间（同步快速超时检测）
          try {
            const re = new RegExp(spec.pattern.replace(/^\/|\/$/g, ''));
            if (!re.test(v)) return k + ' 格式不符：' + spec.pattern;
          } catch (e) {
            return k + ' 正则校验异常';
          }
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

  // 结构化截断：保证 result 序列化为【合法 JSON】，绝不从中途切断字符（避免半截 JSON 被模型误解析）
  // 做法：仅对字符串值按长度截断（字符串值内部切断仍是合法 JSON），必要时逐步缩小单串上限直到整体 <= cap。
  function _truncateStrings(v, maxStr) {
    if (typeof v === 'string') {
      return v.length > maxStr ? v.slice(0, maxStr) + '…[已截断]' : v;
    }
    if (Array.isArray(v)) {
      return v.map(function (x) { return _truncateStrings(x, maxStr); });
    }
    if (v && typeof v === 'object') {
      const o = {};
      for (const k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        o[k] = _truncateStrings(v[k], maxStr);
      }
      return o;
    }
    return v;
  }
  function safeStringify(result, cap) {
    const full = JSON.stringify(result);
    if (full.length <= cap) return full;
    // L2 优化：根据超限比例一次性估算 maxStr，减少迭代次数
    const ratio = cap / full.length;
    let maxStr = Math.max(60, Math.floor(cap * ratio / 4));
    let last = full;
    while (maxStr >= 60) {
      const t = JSON.stringify(_truncateStrings(result, maxStr));
      if (t.length <= cap) return t;
      last = t;
      maxStr = Math.floor(maxStr / 2);
    }
    // 兜底：返回最后一次「仅切字符串值」的结果（仍是合法 JSON，可能略超 cap，但绝不会半截损坏）
    return last;
  }

  // ---------- 主循环：runRound ----------
  // onConfirm(toolCall, args) → Promise<{ ok, edited?, args? }>
  // onProgress(toolName, status, result?) → 同步回调，状态：'executing' / 'done'
  // 返回 { reply, messages, error? }
  async function runRound(messages, onConfirm, onProgress, onEvent, onDelta, onReasoning) {
      const AI = getAI();
      const tools = getTools();
      // 历史消毒（2026-09-11）：会话记忆经 30 条截断可能携带孤儿 tool / 悬空 tool_calls，
      // 注入模型后导致上下文错乱、退化短答（实测复现“OK”退化）。统一净化后再进入工具循环；
      // 净化失败不阻断（AI.send 内部仍有兜底配对修正）。
      if (AI && typeof AI.normalizeMessageSequence === 'function') {
        try {
          const cleaned = AI.normalizeMessageSequence(messages);
          if (Array.isArray(cleaned)) {
            messages.length = 0;
            Array.prototype.push.apply(messages, cleaned);
          }
        } catch (e) { /* ignore */ }
      }
    // 深度临床工作依赖专用页面的材料、历史和状态机。小镜只获得跳转工具，
    // 不把这些兼容性 handler 暴露给模型，避免低能力模型误执行后声称完成。
    // 2026-09-11 读写模式：模式（chat/plan/readwrite/goal）控制文件工具可见性；其余业务工具恒可见
    const xjAgentMode = (typeof localStorage !== 'undefined' && localStorage.getItem('xj_agent_mode')) || 'chat';
    const fileToolsVisible = xjAgentMode !== 'chat';
    const toolSchemas = tools.TOOL_SCHEMAS.filter(function (schema) {
      if (REDIRECT_ONLY_TOOLS.has(schema.function.name)) return false;
      const tName = String(schema.function.name || '');
      if (tName.indexOf('file.') === 0) return fileToolsVisible;
      return true;
    });
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

    // === 模型能力自检（P0-1 改动 D）===
    // 当前生效模型明确不支持 function-calling（denylist 命中 o1/o2/o3/o4/reasoning/deepseek-reasoner/r1）时，
    // 直接友好提示，避免工具被盲注后静默 400 或「无工具可用却无反馈」。
    try {
      const _cfg = (typeof AI !== 'undefined' && AI.getActiveConfig) ? AI.getActiveConfig() : {};
      const _capable = (typeof AI !== 'undefined' && AI.isToolCapable)
        ? AI.isToolCapable(_cfg.model, _cfg.baseUrl)
        : true;
      if (!_capable) {
        return { error: '当前模型（' + (_cfg.model || '内置') + '）不支持工具调用，请到设置接入支持 function-calling 的模型（DeepSeek / 硅基流动 / OpenAI / Kimi / 智谱 / 通义 / 豆包等）后再使用 Agent 工具。' };
      }
    } catch (e) { /* 自检异常不阻断，交由 callDirect 兜底 */ }

    // === 退化循环防护（v1.6.2 修复）===
    // 症状：模型拿到工具结果后仍反复发同一查询工具调用、始终不产出最终文字——这是 DeepSeek 在
    // 「必须先查工具」强约束下的典型退化循环（如问"工作最久的来访"连发 stats.overview 8 次撞步数上限）。
    // 防护：① 拿到首个结果后注入"直接回答"提示；② 同一工具连续调用 ≥2 次即判定退化，强制
    // tool_choice:'none' 文字回答；③ MAX_STEPS 兜底也强制回答，避免空手而归。
    const ANSWER_NUDGE = {
      role: 'system',
      content: '你已通过工具取得真实业务数据。优先基于已有数据直接用自然语言回答用户（可引用具体姓名与数字）；除非确实需要另一项不同的数据，否则不要再调用工具，尤其不得重复调用已查过的同一工具。'
    };
    if (typeof PromptGovernance !== 'undefined' && PromptGovernance.registerPrompt) {
      PromptGovernance.registerPrompt({
        id: 'agent-core.answer-nudge.system',
        version: '4.4.0',
        task: 'assistant-tool-answer',
        model: 'chat-completions-compatible',
        author: 'XinJing product team',
        source: 'app/js/agent-core.js',
        changeLog: ['4.4.0: registered the post-tool answer nudge system template.'],
        content: ANSWER_NUDGE.content,
      });
    }
    let resultSeen = false;
    let prevSingleKey = null;
    let repeatCount = 0;
    // 2026-09-12（XJ-512-009 缺陷1）：区分"模型拒绝给文字"与"给了但格式漂移"两种失败，
    // 前者可再试，后者必须立刻停止循环并给出明确提示，否则用户只会看到空转的"✓ 已完成"。
    async function forceTextAnswer(baseMessages) {
      try {
        const r = await new Promise(function (resolve, reject) {
          // 声明工具 + tool_choice:'none'：模型无法再发 tool_call，只能回文字（且不触发"tool 消息无 tools"报错）
          AI.send(baseMessages.concat([ANSWER_NUDGE]), function (rr) {
            if (rr && rr.error) reject(new Error(rr.error));
            else resolve(rr);
          }, { tools: wireSchemas, tool_choice: 'none', onDelta: onDelta, onReasoning: onReasoning });
        });
        const m = (r && r.choices && r.choices[0] && r.choices[0].message) || r;
        const raw = (m && typeof m.content === 'string') ? m.content : '';
        if (!raw) return { text: '', drift: false, empty: true };
        const cleaned = stripXmlToolCalls(raw);
        return { text: cleaned.text, drift: cleaned.stripped, empty: false };
      } catch (e) {
        return { text: '', drift: false, empty: true, error: e.message || '未知错误' };
      }
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
          // 已拿到过工具结果后注入"直接回答"提示，抑制反复调工具的退化循环
          AI.send(resultSeen ? trimmed.concat([ANSWER_NUDGE]) : trimmed, function (r) {
            if (r && r.error) reject(new Error(r.error));
            else resolve(r);
          }, { tools: wireSchemas, tool_choice: 'auto', onDelta: onDelta, onReasoning: onReasoning });
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
        // 2026-09-12（XJ-512-009 缺陷1 层②）：正常出口同样过滤 XML 工具调用文本，
        // 这是用户实际看到泄漏文本的主路径（模型无 tool_calls 但正文是 XML 调用）。
        const plain = stripXmlToolCalls(msg.content);
        if (plain.stripped) {
          if (plain.text) return { reply: plain.text, messages: messages, driftFiltered: true };
          return { error: DRIFT_NOTICE, drift: true, messages: messages };
        }
        return { reply: plain.text, messages: messages };
      }
      // === 退化循环检测（v1.6.2）===
      const willCallKeys = msg.tool_calls.map(function (tc) {
        const rn = (tc.function && tc.function.name) || '';
        return internalMap[rn] || rn;
      });
      const singleKey = willCallKeys.length === 1 ? willCallKeys[0] : null;
      if (resultSeen && singleKey && singleKey === prevSingleKey) {
        repeatCount++;
      } else {
        repeatCount = singleKey ? 1 : 0;
      }
      // 同一工具连续调用 ≥2 次 → 判定退化循环，强制文字回答（不再浪费步数）
      // 2026-09-12（XJ-512-009 缺陷1）：阈值 2→1。实测模型一旦开始重复调用，第二次必然继续重复，
      // 等满 2 次只是白等一个往返；首次重复即强制文字，既省时间也降低撞步数上限的概率。
      if (resultSeen && singleKey && singleKey === prevSingleKey && repeatCount >= 1) {
        const forced = await forceTextAnswer(trimmed);
        if (forced.text) return { reply: forced.text, messages: messages, forced: true };
        if (forced.drift) {
          // 模型只肯吐 XML 工具文本 → 明确告知异常，绝不把 XML 渲染成回复
          return { error: DRIFT_NOTICE, drift: true, messages: messages };
        }
        // 强制回答为空且非漂移：不再静默继续循环（原逻辑会导致用户只看到"✓ 已完成"空转）
        return { error: '模型未能给出最终回答（工具调用重复且强制文字回答为空），请重试或换用其他模型。', messages: messages };
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
        // 默认拒绝：仅已登记的 read 工具可跳过确认，其他种类均须用户确认。
        if (tool.kind !== 'read') {
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
          // 读/洞察类工具返回可能较大，用更高上限，避免半截 JSON（v1.6.0 B1 修复）
          const cap = (tool.kind === 'read' || tool.kind === 'read-light') ? READ_RESULT_MAX : TOOL_RESULT_MAX;
          const content = safeStringify(result, cap);
          messages.push({ role: 'tool', tool_call_id: tc.id || '', content: content });
          if (typeof onProgress === 'function') onProgress(toolKey, 'done', result.data);
          // 主动提示：写工具 handler 成功分支附 result.data.followups，由调用方渲染（层3，非阻断）
          if (result && result.data && Array.isArray(result.data.followups) && typeof onEvent === 'function') {
            onEvent({ type: 'followups', items: result.data.followups });
          }
        } catch (e) {
          messages.push(toolError(tc, e.message || '工具执行异常'));
        }
      }
      prevSingleKey = singleKey;
      resultSeen = true;
    }
    // MAX_STEPS 兜底：仍尝试强制文字回答，避免空手而归
    // 2026-09-12（XJ-512-009 缺陷1）：兜底路径同样过滤 XML 漂移；且无论成败都必须回一条
    // 用户可见的消息（原实现在部分 UI 路径下 error 未渲染，用户只见"✓ 已完成"后无下文）。
    try {
      const forcedFinal = await forceTextAnswer(trimToWindow(messages, WINDOW));
      if (forcedFinal.text) return { reply: forcedFinal.text, messages: messages, forced: true };
      if (forcedFinal.drift) return { error: DRIFT_NOTICE, drift: true, messages: messages };
    } catch (e) { /* ignore */ }
    return { error: '操作步数超限（' + MAX_STEPS + ' 步），未能得出最终回答。请把问题拆小，或改用更明确的问法（例如指定日期范围或对象名）。' };
  }

  // ---------- 构建系统提示 ----------
  function registerSystemPromptTemplate() {
    if (typeof PromptGovernance === 'undefined' || !PromptGovernance.registerPrompt) return;
    PromptGovernance.registerPrompt({
      id: 'agent-core.system',
      version: '4.4.0',
      task: 'assistant-routing-and-tools',
      model: 'chat-completions-compatible',
      author: 'XinJing product team',
      source: 'app/js/agent-core.js',
      changeLog: ['4.4.0: registered the assistant system template; dynamic client and user-library context are excluded from the manifest hash.'],
      content: [
        'You are the XinJing lightweight work assistant.',
        'Use only registered tools and never invent data.',
        'Write-like tools require confirmation and clinical tasks route to their dedicated workspace.',
        'Dynamic client and user-library context is not part of the versioned template hash.',
      ].join('\n'),
    });
  }

  function buildSystemPrompt() {
    registerSystemPromptTemplate();
    let tools = '';
    try { tools = getTools(); } catch (e) { /* 未注入时降级 */ }
    let toolList = '';
    if (tools && tools.TOOL_REGISTRY) {
      toolList = Object.keys(tools.TOOL_REGISTRY).filter(function (k) {
        return !REDIRECT_ONLY_TOOLS.has(k);
      }).map(function (k) {
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
      (typeof PersonaPreamble !== 'undefined' && PersonaPreamble.build) ? PersonaPreamble.build() : '',
      '你是心镜 XinJing 的轻量工作助手。你可以可靠完成：统计与业务数据查询、简单记账、月结、白名单内的来访者信息修改、资料检索和 API 接口配置。',
      '规则：',
      '1. 你只能调用提供的工具，不要凭空编造数据。',
      '2. 所有非查询工具（包括记账、改信息、配置 API 和会话操作）执行前都会向用户确认；你只需发起 tool_call，不要在回复里假装已执行。',
      '3. 如果用户请求含多条记录，用 records 数组一次性提交，不要分多次调用。',
      '4. 查不到来访者时先问用户是否新建，不要自行假设。',
      '5. 金额日期等字段严格按 schema 填，不要省略 required 字段。',
      '6. 你不生成诊断、不替代临床判断、不替代真人督导。',
      '7. 咨询记录、逐字稿、报告、督导、大师对话、日历排期、文档中心和资料库都必须调用 navigate_to，交给对应专业页面；不要声称已在聊天中完成。',
      '8. 配置 API 接口时，如果用户只说了服务商名（如 DeepSeek 或 硅基流动）和密钥，从 agent.configure_api 的 provider 参数填预设名即可——handler 会自动查出 baseUrl 和默认 model。不要让用户手动找 baseUrl 和 model 名。若用户说出未在预设列表的服务商，选 other 并问用户要 baseUrl 和 model 名。',
      '9. 涉及「谁 / 几次 / 多久 / 欠费 / 最久」等事实问题，必须先调用 client.query / session.query / supervision.query / stats.overview / client.insight 查询真实数据，再基于返回回答，严禁凭记忆编造。例：想知道工作最久的来访，调 stats.overview（看 longestClient）或 client.query（默认按 tenure 降序）。',
      '10. 调用查询工具拿到结果后，用一次文字回复直接回答用户即可，不要再调用同一查询工具；同一查询工具连续调用两次即视为已获取足够信息，必须停止调用工具。',
      '11. 工具调用只能通过接口提供的 function-calling 机制发起，绝不能用文字书写工具调用。严禁输出任何形式的 XML/标签式工具调用文本（如 <toolcall>、</toolcall>、<invoke>、<parameter>、<function_calls> 或 antml: 前缀变体）——这类文本不会被执行，只会被当作乱码展示给用户。若你无法调用工具，就用自然语言直接回答或说明缺少什么信息。',
      '',
      '可用工具：',
      toolList || '（未注入工具）',
      clientList,
      // 档位提示：模型档位只影响理解与表达质量，不扩大可执行操作边界。
      (function () {
        try {
          if (typeof AI !== 'undefined' && AI.getTier) {
            return AI.getTier() === 'builtin'
              ? '\n\n[档位] 你运行在免费试用档，默认使用 DeepSeek-V4-Pro 主力模型，可完成记账 / 月结 / 查统计 / 改来访者信息 / 配 API 等任务；仅当主力供应商失败时由服务器尝试 Qwen3.5-4B 免费兜底。Qwen 兜底为低性能模型，仅用于普通任务。若主力线路要求账号会话，请引导用户重新登录后重试；不得把 Qwen 兜底当作默认主力。用户接入自己的高性能模型 key 后，理解与表达质量会提升，但可执行操作仍以已提供工具为准。注意：若用户接入的模型不支持 function-calling（如 o1/o2/o3/o4 或 reasoning 模型），Agent 会主动提示其换用支持的模型，而非静默失效。'
              : '\n\n[档位] 你已接入用户的高性能模型，可获得更好的理解与表达质量；可执行操作的边界不变，复杂工作仍进入专业页面。';
          }
        } catch (e) { /* ignore */ }
        return '';
      })(),
      // v3.5.0 用户自建知识库：被动注入 [我的资料库] 块（仅本机读取，零出网）
      (function () {
        try {
          if (typeof window !== 'undefined' && window.UserDocs && window.UserDocs.getContextBlock) {
            var _ud = window.UserDocs.getContextBlock();
            if (_ud) return _ud;
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
      TOOL_RESULT_MAX: TOOL_RESULT_MAX,
      READ_RESULT_MAX: READ_RESULT_MAX
    };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      runRound: runRound,
      buildSystemPrompt: buildSystemPrompt,
      trimToWindow: trimToWindow,
      MAX_STEPS: MAX_STEPS,
      WINDOW: WINDOW,
      TOOL_RESULT_MAX: TOOL_RESULT_MAX,
      READ_RESULT_MAX: READ_RESULT_MAX
    };
  }
})();
