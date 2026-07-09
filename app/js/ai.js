/* ============================================================
   心镜 XinJing — AI 集成模块
   职责：
   - 调用外部 API 生成 SOAP / 总结 / 分析
   - 四层降级策略（复用 winnicott-chat 模式）
   - 从设置读取 API 配置
   注意：API 密钥仅存于 localStorage（个人本地工具），不在页面明文显示
   ============================================================ */

const AI = (() => {
  'use strict';

  // 四层 API 端点（可在设置中覆盖 baseUrl）
  // 默认走 OpenAI 兼容接口格式
  const DEFAULT_TIERS = [
    { name: 'deepseek-pro', path: '/v1/chat/completions', model: 'deepseek-chat', label: 'DeepSeek Pro' },
    { name: 'deepseek-flash', path: '/v1/chat/completions', model: 'deepseek-chat', label: 'DeepSeek Flash' },
    { name: 'minimax-m3', path: '/v1/chat/completions', model: 'MiniMax-M3', label: 'MiniMax M3' },
    { name: 'agnes', path: '/v1/chat/completions', model: 'agnes', label: 'Agnes' },
  ];

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

  return {
    generateSoapFromTranscript,
    chat,
  };
})();

if (typeof window !== 'undefined') {
  window.AI = AI;
}
