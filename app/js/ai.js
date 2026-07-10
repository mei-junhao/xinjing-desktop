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
    { name: 'deepseek-pro', path: '/v1/chat/completions', model: 'deepseek-chat', label: 'DeepSeek Pro' },
    { name: 'deepseek-flash', path: '/v1/chat/completions', model: 'deepseek-chat', label: 'DeepSeek Flash' },
    { name: 'minimax-m3', path: '/v1/chat/completions', model: 'MiniMax-M3', label: 'MiniMax M3' },
    { name: 'agnes', path: '/v1/chat/completions', model: 'agnes', label: 'Agnes' },
  ];

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

  // 实际发送请求（单层）
  async function callOnce(tier, apiKey, messages) {
    const config = getConfig();
    const baseUrl = config.baseUrl || 'https://api.openai.com';
    const url = baseUrl.replace(/\/$/, '') + tier.path;
    const model = config.modelPreference && config.modelPreference !== 'deepseek-pro' ? config.modelPreference : tier.model;

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: config.maxTokens || 4000,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 100)}`);
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
  }

  // 四层降级调用
  async function callWithFallback(messages) {
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

    const tiers = DEFAULT_TIERS;
    let lastErr = null;
    for (let i = 0; i < tiers.length; i++) {
      try {
        const content = await callOnce(tiers[i], apiKey, messages);
        return { content, tier: tiers[i].label };
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

  // AI 督导：用指定督导师身份的提示词 + 会谈材料生成督导意见。
  // supervisorPrompt：督导师身份的方法论提示词（来自 Supervisors）；context：会谈材料文本。
  // 密钥来源同 chat —— 仅用户在设置页填写的 apiConfig.apiKey（不沿用 chat 项目密钥）。
  function supervise(supervisorPrompt, context, callback) {
    const system =
      (supervisorPrompt || SYSTEM_PROMPT) +
      '\n\n你是进行中的个案督导，请基于下方提供的会谈材料给出督导意见。';
    const userContent = '以下是本次会谈的材料：\n\n' + (context || '');
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
    supervise,
  };
})();

if (typeof window !== 'undefined') {
  window.AI = AI;
}
