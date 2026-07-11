/* ============================================================
   心镜 XinJing — AI 集成模块
   职责：
   - 调用外部 API 生成 SOAP / 总结 / 分析 / AI 督导
   - 四层降级策略（复用 winnicott-chat 的模式骨架，但密钥体系完全独立）
   - 从设置读取 API 配置
   密钥安全（硬约束）：
   - API 密钥的唯一合法来源是用户在「设置」页自行填写的 apiConfig.apiKey，
     仅存于本机 localStorage（个人本地工具），不在页面明文显示。
   - 本模块绝不沿用 winnicott-chat 项目的任何密钥、不读取任何环境变量、
     不读取任何外部密钥文件、不在代码中硬编码任何 key。
   - 下方 assertNoHardcodedKey() 在加载期强制校验，杜绝误引入 chat 密钥。
   ============================================================ */

const AI = (() => {
  'use strict';

  // 四层 API 端点（可在设置中覆盖 baseUrl）
  // 默认走 OpenAI 兼容接口格式。注意：此处严禁出现 key / apiKey / token 字段。
  const DEFAULT_TIERS = [
    { name: 'deepseek-pro', path: '/v1/chat/completions', model: 'deepseek-chat', label: 'DeepSeek Pro', supportsTools: true },
    { name: 'deepseek-flash', path: '/v1/chat/completions', model: 'deepseek-chat', label: 'DeepSeek Flash', supportsTools: true },
    { name: 'minimax-m3', path: '/v1/chat/completions', model: 'MiniMax-M3', label: 'MiniMax M3', supportsTools: false },
    { name: 'agnes', path: '/v1/chat/completions', model: 'agnes', label: 'Agnes', supportsTools: false },
  ];

  // 已知支持 function-calling 的 model 名单（可扩展）。
  // 最终判断以"解析后的 model 是否在此名单"为准，而非 tier.supportsTools（因为 ai.js:55 的实际模型由 modelPreference 决定，与 tier 解耦）。
  const TOOL_CAPABLE_MODELS = ['deepseek-chat'];

  // 安全断言：本模块严禁内置任何密钥。若有人误在 DEFAULT_TIERS 写入 key 字段，立即拒绝加载。
  (function assertNoHardcodedKey() {
    const bad = DEFAULT_TIERS.filter((t) => t && (t.key || t.apiKey || t.token));
    if (bad.length) {
      console.error('[AI] 安全断言失败：DEFAULT_TIERS 中检测到疑似密钥字段，已拒绝加载', bad.map((b) => b.name));
      throw new Error('AI 模块不允许内置密钥');
    }
  })();

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

  // 解析 tier + config 得出实际发出的 model 名（与旧逻辑一致，L55）
  function resolveModel(tier) {
    const config = getConfig();
    return config.modelPreference && config.modelPreference !== 'deepseek-pro' ? config.modelPreference : tier.model;
  }

  // 实际发送请求（单层）。
  // options?: { tools?, tool_choice? } — 仅当传入且非空时条件注入 body。
  // 返回值：整条 message 对象（保留 tool_calls），而非仅 content 字符串。
  async function callOnce(tier, apiKey, messages, options) {
    const config = getConfig();
    const baseUrl = config.baseUrl || 'https://api.openai.com';
    const url = baseUrl.replace(/\/$/, '') + tier.path;
    const model = resolveModel(tier);

    // 若调用方传了 tools 但当前解析出的 model 不支持 function-calling，直接抛错让降级链跳过此层
    if (options && options.tools && options.tools.length && !TOOL_CAPABLE_MODELS.includes(model)) {
      throw new Error('模型 ' + model + ' 不支持工具调用（tool_calls），跳过此层');
    }

    const body = {
      model,
      messages,
      temperature: 0.3,
      max_tokens: config.maxTokens || 4000,
    };
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

  // 四层降级调用。
  // options?: { tools?, tool_choice? } — 透传给 callOnce；当 tools 存在时先按"解析 model ∈ TOOL_CAPABLE_MODELS"过滤候选档。
  async function callWithFallback(messages, options) {
    const config = getConfig();
    // 密钥唯一来源：用户在设置页填写的 apiConfig.apiKey（本机 localStorage）。
    // 不读取任何 chat 项目密钥 / 环境变量 / 外部文件。
    const apiKey = config.apiKey;
    if (!apiKey) {
      return { error: '未配置 API 密钥，请到"设置"页配置' };
    }
    if (!config.baseUrl) {
      return { error: '未配置 API 端点，请到"设置"页配置' };
    }

    // 当调用方传了 tools，先过滤候选档：只保留"解析后 model ∈ TOOL_CAPABLE_MODELS"的 tier
    let tiers = DEFAULT_TIERS;
    if (options && options.tools && options.tools.length) {
      tiers = DEFAULT_TIERS.filter((t) => TOOL_CAPABLE_MODELS.includes(resolveModel(t)));
      if (!tiers.length) {
        return { error: '当前配置的模型不支持工具调用，请在设置中切换到 deepseek-chat 等支持模型' };
      }
    }

    let lastErr = null;
    for (let i = 0; i < tiers.length; i++) {
      try {
        const message = await callOnce(tiers[i], apiKey, messages, options);
        return {
          content: message.content || '',
          tool_calls: message.tool_calls,
          tier: tiers[i].label,
        };
      } catch (e) {
        lastErr = e;
        console.warn(`AI 层 ${tiers[i].label} 失败，尝试下一层`, e);
      }
    }
    return { error: '所有 API 层均失败：' + (lastErr ? lastErr.message : '未知错误') };
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
  // 密钥来源同 chat —— 仅用户在设置页填写的 apiConfig.apiKey（不沿用 chat 项目密钥）。
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
  };
})();

if (typeof window !== 'undefined') {
  window.AI = AI;
}
