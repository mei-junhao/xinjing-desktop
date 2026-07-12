/* ============================================================
   心镜 XinJing — AI 集成模块
   职责：
   - 调用外部 API 生成 SOAP / 总结 / 分析 / AI 督导 / Agent 工具调用
   - 单层直连：根据用户填写的「模型名 + Base URL + 密钥」直连大模型
     （OpenAI 兼容 /chat/completions 接口）
   - 内置一个永久免费的「低性能模型」（SiliconFlow Qwen3.5-4B）作为开箱即用兜底：
     用户未填自己的 API 时自动使用；用户填入自己的模型后自动切换到用户模型。

   密钥安全说明（重要变更）：
   - 用户自己的 API 密钥唯一合法来源是「设置」页填写的 apiConfig（存于本机）。
   - 内置低性能模型的密钥由本项目所有方提供、永久免费、仅供兜底，
     按产品需求明文内置在源码常量 BUILTIN_MODEL 中（非用户密钥、非聊天项目密钥）。
   - 任何「用户模型」的调用都不使用内置密钥；仅当无用户密钥时回退到内置模型。
   ============================================================ */

const AI = (() => {
  'use strict';

  // 内置低性能模型（永久免费，开箱即用兜底）
  // 用户未填自己的 API 时自动使用；填入自己的模型后自动切换。
  const BUILTIN_MODEL = {
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: 'sk-jwbugvdncqelswmfkvpckxmjvzjnbnbhspjreeyqkdjugbns',
    model: 'Qwen/Qwen3.5-4B',
    label: '内置免费模型 (Qwen3.5-4B)',
  };

  // 角色设定：温尼科特取向心理咨询师
  const SYSTEM_PROMPT = `你是一位资深心理咨询师，精通心理动力学与温尼科特理论取向。
你的任务是协助咨询师整理会谈资料，生成标准化临床报告。
要求：
- 保持专业、克制、抱持的语气
- 优先从来访者的原话出发，不臆造未出现的信息
- 动力学视角：关注防御机制、过渡现象、抱持环境、真假自体、移情/反移情
- 输出结构化、可直接用于临床的内容`;

  function getConfig() {
    const settings = Store.getSettings();
    return settings.apiConfig || {};
  }

  // 当前生效的配置：用户已填密钥 → 用用户配置；否则回退到内置免费模型。
  function getActiveConfig() {
    const user = getConfig();
    if (user && user.apiKey && String(user.apiKey).trim()) {
      return {
        baseUrl: (user.baseUrl || '').trim() || BUILTIN_MODEL.baseUrl,
        apiKey: user.apiKey.trim(),
        model: (user.modelPreference || '').trim() || BUILTIN_MODEL.model,
        maxTokens: user.maxTokens || 4000,
        label: '用户模型',
      };
    }
    return BUILTIN_MODEL;
  }

  // 档位：'user' = 用户自有高性能模型；'builtin' = 内置低性能免费模型。
  function getTier() {
    const user = getConfig();
    return (user && user.apiKey && String(user.apiKey).trim()) ? 'user' : 'builtin';
  }

  // ---------- 发送前消息序列归一化（防御硅基流动 20015「messages 数组格式非法」）----------
  // 根因：工具调用场景下模型返回的 content 与 tool_calls 被拆开，或 reasoning_content 被夹带，
  // 累积进历史后下一轮发送给 API 时序列出现「连续两个相同 role / system 不在首位」→ 报错 20015。
  // 本函数在真正发送边界统一修正：
  //  1. system 仅保留在首位（后续 system 合并进首位）
  //  2. 合并连续相同 role 的 user / assistant（assistant 合并时拼接 content + 合并 tool_calls）
  //  3. 剥离 reasoning_content / ts / masterKey 等回声或业务字段，只留 API 所需
  //  4. 收敛悬空 tool_calls（带 tool_calls 但后面没有 tool 消息时删除，避免次级报错）
  function normalizeMessageSequence(messages) {
    if (!Array.isArray(messages) || !messages.length) return messages;
    const out = [];
    for (const m of messages) {
      if (!m || typeof m !== 'object' || !m.role) continue;
      const role = m.role;
      const cloned = { role: role };
      if (m.content !== undefined && m.content !== null) cloned.content = m.content;
      if (Array.isArray(m.tool_calls)) cloned.tool_calls = m.tool_calls;
      if (m.tool_call_id !== undefined) cloned.tool_call_id = m.tool_call_id;
      if (role === 'system') {
        // system 仅允许在首位：已有 system 则合并内容；否则提到首位（不追加到末尾）
        if (out.length && out[0].role === 'system') {
          out[0].content = (out[0].content ? out[0].content + '\n\n' : '') + (cloned.content || '');
        } else {
          out.unshift(cloned);
        }
        continue;
      }
      const last = out[out.length - 1];
      if ((role === 'user' || role === 'assistant') && last && last.role === role) {
        // 合并连续相同 role（核心修复：content + tool_calls 进同一条消息）
        if (cloned.content) {
          last.content = (last.content ? last.content + '\n\n' : '') + cloned.content;
        }
        if (role === 'assistant' && Array.isArray(cloned.tool_calls) && cloned.tool_calls.length) {
          last.tool_calls = (Array.isArray(last.tool_calls) ? last.tool_calls : []).concat(cloned.tool_calls);
        }
        continue;
      }
      out.push(cloned);
    }
    // 二次修正：收敛悬空 tool_calls（防止「tool_calls 无对应 tool 结果」次级报错）
    for (let i = 0; i < out.length; i++) {
      if (out[i].role === 'assistant' && Array.isArray(out[i].tool_calls) && out[i].tool_calls.length) {
        const next = out[i + 1];
        if (!next || next.role !== 'tool') delete out[i].tool_calls;
      }
    }
    return out;
  }

  // 单层直连：根据传入的 config 直连大模型（OpenAI 兼容 /chat/completions）。
  async function callDirect(config, messages, options) {
    const baseUrl = (config.baseUrl || 'https://api.openai.com').replace(/\/$/, '');
    const url = baseUrl + '/chat/completions';
    const model = config.model || 'Qwen/Qwen3.5-4B';
    const apiKey = config.apiKey || '';

    // 发送前归一化角色序列，防御硅基流动 20015
    const safeMessages = normalizeMessageSequence(messages);
    const body = {
      model,
      messages: safeMessages,
      temperature: 0.3,
      max_tokens: config.maxTokens || 4000,
    };
    // Qwen3 系列为「思考模型」，禁用思考可降低延迟、避免 reasoning 占用 token、
    // 并确保 function-calling 稳定输出 tool_calls。该参数为 SiliconFlow 专属，
    // 其它 OpenAI 兼容端点会忽略未知字段，不影响用户模型。
    if (model.indexOf('Qwen') !== -1) {
      body.chat_template_kwargs = { enable_thinking: false };
    }
    // 条件注入 tools / tool_choice（仅当传入且非空）
    if (options && options.tools && options.tools.length) {
      body.tools = options.tools;
      if (options.tool_choice) body.tool_choice = options.tool_choice;
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 100)}`);
    }

    const data = await resp.json();
    // 返回整条 message 对象，保留 tool_calls（若有）
    return data.choices?.[0]?.message || { content: '' };
  }

  // 统一入口：取生效配置直连大模型；出错返回 { error }。
  async function callWithFallback(messages, options) {
    const config = getActiveConfig();
    try {
      const message = await callDirect(config, messages, options);
      return {
        content: message.content || '',
        tool_calls: message.tool_calls,
        tier: config.label,
      };
    } catch (e) {
      return { error: '模型调用失败：' + (e.message || '未知错误') };
    }
  }

  // 解析 SOAP JSON 输出
  function parseSoap(text) {
    try {
      // 尝试提取 JSON
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const obj = JSON.parse(match[0]);
        return {
          subjective: obj.subjective || '',
          objective: obj.objective || '',
          assessment: obj.assessment || '',
          plan: obj.plan || '',
        };
      }
    } catch (e) {
      console.warn('SOAP JSON 解析失败，回退到文本', e);
    }
    // 回退：按段落解析
    return {
      subjective: extractSection(text, ['S', 'Subjective', '主观']),
      objective: extractSection(text, ['O', 'Objective', '客观']),
      assessment: extractSection(text, ['A', 'Assessment', '评估']),
      plan: extractSection(text, ['P', 'Plan', '计划']),
    };
  }

  function extractSection(text, keywords) {
    const lines = text.split('\n');
    let capture = false;
    let buf = [];
    for (const line of lines) {
      if (keywords.some((k) => new RegExp('\\*?\\*?' + k + '\\*?\\*?\\s*[:：]', 'i').test(line))) {
        capture = true;
        continue;
      }
      if (/^\s*[A-Z]\s*[:：]/.test(line) && capture) break;
      if (capture && line.trim()) buf.push(line.trim());
    }
    return buf.join('\n');
  }

  // ---------- 公开方法 ----------

  function generateSoapFromTranscript(transcript, callback) {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `请根据以下咨询会谈逐字稿，撰写标准 SOAP 格式个案报告。

要求：
- Subjective: 引用来访者关键原话，保持语言风格
- Objective: 观察行为、情绪状态、非言语信息
- Assessment: 动力学临床评估（防御、移情/反移情、核心议题）
- Plan: 后续咨询方向

逐字稿：
${transcript}

请严格输出 JSON（不要其他文字）：
{"subjective":"...","objective":"...","assessment":"...","plan":"..."}`,
      },
    ];

    callWithFallback(messages).then((res) => {
      if (res.error) {
        callback({ error: res.error });
        return;
      }
      callback(parseSoap(res.content));
    });
  }

  function chat(userMessage, callback) {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ];
    callWithFallback(messages).then((res) => {
      if (res.error) {
        callback(res.error);
        return;
      }
      callback(res.content);
    });
  }

  // 通用发送：接受一个完整的 messages 数组（可携带自定义 system 提示词、历史与摘要上下文）。
  // 大师对话 / 圆桌即使用此接口，传入大师人格 system prompt + 长时记忆摘要 + 对话历史。
  // options?: { tools?, tool_choice? } — 可选；不传时与旧行为字节等价（tool_calls 为 undefined）。
  function send(messages, callback, options) {
    if (!Array.isArray(messages) || !messages.length) {
      callback({ error: '空消息' });
      return;
    }
    callWithFallback(messages, options).then((res) => {
      if (res.error) {
        callback({ error: res.error });
        return;
      }
      callback({ content: res.content, tier: res.tier, tool_calls: res.tool_calls });
    });
  }

  // AI 督导：用指定督导师身份的提示词 + 会谈材料生成督导意见。
  // supervisorPrompt：督导师身份的方法论提示词（来自 Supervisors）；context：本次会谈材料文本。
  // history：（可选）该来访者既往督导记录摘要，注入后督导可给出「长时程成长视角」。
  //          兼容旧签名 supervise(prompt, context, callback)：history 传函数时视为 callback。
  function supervise(supervisorPrompt, context, history, callback) {
    if (typeof history === 'function') { callback = history; history = ''; }
    const hasHistory = history && history.replace(/\s/g, '');
    let system =
      (supervisorPrompt || SYSTEM_PROMPT) +
      '\n\n你是进行中的个案督导。';
    if (hasHistory) {
      system += '下方会先提供该来访者【既往督导记录】，再提供【本次会谈材料】。' +
        '请在给出本次督导意见的同时，纵向对照既往记录，指出来访者与咨询工作的变化、进展与反复，' +
        '为咨询师提供长时程的成长视角（如反复出现的主题、防御模式的松动、移情的演变、督导建议的落实情况）。';
    } else {
      system += '请基于下方提供的会谈材料给出督导意见。';
    }
    let userContent = '';
    if (hasHistory) {
      userContent += '【既往督导记录（由旧到新）】\n' + history + '\n\n';
    }
    userContent += '【本次会谈材料】\n' + (context || '');
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ];
    callWithFallback(messages).then((res) => {
      if (res.error) {
        callback({ error: res.error });
        return;
      }
      callback({ content: res.content });
    });
  }

  return {
    generateSoapFromTranscript,
    chat,
    send,
    supervise,
    // 新增：暴露当前生效配置与档位（供 Agent / 设置页判断与提示）
    getActiveConfig,
    getTier,
    // 测试可访问：发送前消息序列归一化（防御硅基流动 20015）
    normalizeMessageSequence,
  };
})();

if (typeof window !== 'undefined') {
  window.AI = AI;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeMessageSequence: AI.normalizeMessageSequence };
}
