/* ============================================================
   心镜 XinJing — AI 集成模块
   职责：
   - 调用外部 API 生成 SOAP / 总结 / 分析 / AI 督导 / Agent 工具调用
   - 单层直连：根据用户填写的「模型名 + Base URL + 密钥」直连大模型
     （OpenAI 兼容 /chat/completions 接口）
   - 免费档（未填用户密钥）：统一走韩国代理（xinjingchat.online），
     由代理按机器码做 ¥5 / 30 天额度门控：额度内用 DeepSeek-V4-Flash，
     超额/过期自动降级到内置基础模型 Qwen3.5-4B。
   - 用户填了自己的密钥且验证通过 → 用用户模型（最高优先）。

   密钥安全说明（重要变更）：
   - 用户自己的 API 密钥唯一合法来源是「设置」页填写的 apiConfig（存于本机）。
   - 代理共享密钥（APP_PROXY_KEY）由构建期注入 secret.generated.js，仅供客户端向
     本项目代理鉴权；非 provider 密钥、被逆向也无妨——服务端按机器码硬限额兜底。
   - 任何 provider 密钥（DeepSeek / SiliconFlow）只存在于服务端 .env，永不进客户端/仓库。
   ============================================================ */

const AI = (() => {
  'use strict';

  // 试用代理基址（韩国服务器，HTTPS + 共享密钥 + 机器码鉴权）
  const PROXY_BASE = 'https://xinjingchat.online/v1';
  // 从 preload 桥接读取代理共享密钥（构建期注入，不入源码）
  function getProxyKey() {
    try {
      if (typeof window !== 'undefined' && window.__XJ_API__ && window.__XJ_API__.appProxyKey) {
        return window.__XJ_API__.appProxyKey() || '';
      }
    } catch (e) { /* ignore */ }
    return '';
  }
  // 机器码：经 preload 桥接（主进程 getMachineCode，跨重装稳定）
  let _mcPromise = null;
  function getMachineCode() {
    if (!_mcPromise) {
      _mcPromise = Promise.resolve(
        (typeof window !== 'undefined' && window.__XJ_API__ && window.__XJ_API__.getMachineCode)
          ? window.__XJ_API__.getMachineCode()
          : ''
      );
    }
    return _mcPromise;
  }
  // 构建一份试用代理配置（每次取最新代理密钥，避免 preload 未就绪时拿到空串）
  function buildTrialConfig(model) {
    return {
      baseUrl: PROXY_BASE,
      apiKey: getProxyKey(),
      model: model,
      label: model === 'deepseek-v4-flash' ? '试用 v4-flash' : '内置基础模型',
      isTrial: true,
    };
  }
  // 内置基础模型（免费兜底，走代理；保留常量名供旧引用）
  const BUILTIN_MODEL = buildTrialConfig('Qwen3.5-4B');

  // ---------- 试用额度（代理侧记账，服务端硬限额 ¥5 / 30 天 / 机器码）----------
  const QUOTA_TOTAL_YUAN = 5;
  // 缓存：percent 为剩余百分比(0-100，null=未知)，tier 为代理确认的实际档位
  const QUOTA_CACHE = {
    percent: null,
    remainingYuan: null,
    resetAt: null,
    tier: null, // 'v4-flash' | 'basic' | null
    updatedAt: 0,
  };
  let _quotaSubs = [];
  function emitQuota() {
    _quotaSubs.slice().forEach(function (cb) { try { cb(QUOTA_CACHE); } catch (e) {} });
  }
  function onQuotaChange(cb) {
    if (typeof cb === 'function') _quotaSubs.push(cb);
    return QUOTA_CACHE;
  }
  function applyQuotaInfo(info) {
    if (!info || typeof info !== 'object') return;
    // M5 修复：只接受来自服务器响应头的额度信息（headers.get 来源可信），
    // 拒绝从 DevTools 直接篡改 QUOTA_CACHE 的 tier 字段。
    // 实际防护靠服务端硬限额；此处仅增加客户端 tier 篡改的最低门槛。
    if (info.percent != null) QUOTA_CACHE.percent = info.percent;
    if (info.remainingYuan != null) QUOTA_CACHE.remainingYuan = info.remainingYuan;
    if (info.resetAt != null) QUOTA_CACHE.resetAt = info.resetAt;
    // tier 仅从 HTTP 响应头（updateQuotaFromHeaders）或 fetchQuota（GET /quota 响应体）更新，
    // 这两条路径均来自代理服务器，不经渲染进程可篡改的路径。
    if (info.tier != null && (info._fromServer === true)) QUOTA_CACHE.tier = info.tier;
    QUOTA_CACHE.updatedAt = Date.now();
    emitQuota();
  }
  // 从 chat 响应头更新额度（代理每次响应都带 X-Quota-* / X-Tier）
  function updateQuotaFromHeaders(headers) {
    if (!headers || typeof headers.get !== 'function') return;
    try {
      const p = headers.get('X-Quota-Percent');
      const r = headers.get('X-Quota-Remaining');
      const t = headers.get('X-Tier');
      const rt = headers.get('X-Quota-Reset');
      const info = {};
      if (p != null && p !== '') info.percent = parseInt(p, 10);
      if (r != null && r !== '') info.remainingYuan = parseFloat(r);
      if (t != null && t !== '') info.tier = t;
      if (rt != null && rt !== '') info.resetAt = rt;
      if (Object.keys(info).length) { info._fromServer = true; applyQuotaInfo(info); }
    } catch (e) { /* ignore */ }
  }
  // 主动查询额度（GET /v1/quota?mid=...），供 UI 初始化展示与「刷新」按钮
  async function fetchQuota() {
    try {
      const mc = await getMachineCode();
      if (!mc) return QUOTA_CACHE;
      const url = PROXY_BASE + '/quota?mid=' + encodeURIComponent(mc);
      const headers = { 'Content-Type': 'application/json' };
      const key = getProxyKey();
      if (key) headers['Authorization'] = 'Bearer ' + key;
      const resp = await fetch(url, { method: 'GET', headers: headers });
      if (!resp.ok) return QUOTA_CACHE;
      const data = await resp.json().catch(() => null);
      if (data && data.remainingYuan != null) {
        applyQuotaInfo({
          percent: data.percent != null ? data.percent : Math.max(0, Math.round((data.remainingYuan / QUOTA_TOTAL_YUAN) * 100)),
          remainingYuan: data.remainingYuan,
          resetAt: data.resetAt || null,
          tier: data.tier || null,
          _fromServer: true,
        });
      }
      updateQuotaFromHeaders(resp.headers);
    } catch (e) { /* 离线/代理不可达：保留上次缓存或 null */ }
    return QUOTA_CACHE;
  }
  function getQuota() { return QUOTA_CACHE; }
  // 试用档实际请求模型：代理确认降级(basic)则直接走 Qwen；否则乐观请求 v4-flash（代理会在超额时自动降级并回传 X-Tier）
  function getTrialModel() {
    if (QUOTA_CACHE.tier === 'basic') return 'Qwen3.5-4B';
    return 'deepseek-v4-flash';
  }

  // 模型是否支持 function-calling（tools）。
  // 已知不支持的 reasoning/专属模型列入 denylist；其余 OpenAI 兼容 chat 模型默认支持。
  // 盲注 tools 到不支持的模型会触发 HTTP 400，故注入前先判断（修复 A1）。
  const NO_TOOL_MODEL_RE = /(^|[\/\-_])(o1|o2|o3|o4|reasoning|deepseek-reasoner|r1|reasoning-)([\/\-_ ]|$)/i;
  function supportsFunctionCalling(config) {
    const model = (config && config.model) || '';
    if (NO_TOOL_MODEL_RE.test(model)) return false;
    return true;
  }

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

  // 当前生效的配置：用户已填密钥 且 已通过连接验证（verified===true）→ 用用户配置（最高优先）；
  // 否则走试用代理：额度内 v4-flash，超额/过期由代理确认降级后回退 Qwen3.5-4B。
  // 关键修复（A3）：必须与 getTier 一致以 verified 为事实来源，避免「填错密钥谎报高性能」。
  function getActiveConfig() {
    const user = getConfig();
    if (user && user.apiKey && String(user.apiKey).trim() && user.verified === true) {
      return {
        baseUrl: (user.baseUrl || '').trim() || BUILTIN_MODEL.baseUrl,
        apiKey: user.apiKey.trim(),
        model: (user.modelPreference || '').trim() || BUILTIN_MODEL.model,
        maxTokens: user.maxTokens || 4000,
        label: '用户模型',
        isUser: true,
      };
    }
    return buildTrialConfig(getTrialModel());
  }

  // 档位：'user' = 用户自有高性能模型（且已验证可用）；'builtin' = 免费/试用档（经韩国代理，
  // 额度内 v4-flash，超额降级基础模型）。注意保留 'builtin' 字符串供 agent-core/shell/settings 既判定。
  function getTier() {
    const user = getConfig();
    return (user && user.apiKey && String(user.apiKey).trim() && user.verified === true) ? 'user' : 'builtin';
  }

  // 真实连接测试：最小探测一次 chat/completions，返回 { ok, error? }。
  // 供 configure_api / 设置页抽屉接入流程调用，作为档位判定的唯一事实来源。
  async function testConnection(config) {
    try {
      const msg = await callDirect(
        {
          baseUrl: (config && config.baseUrl) || '',
          apiKey: (config && config.apiKey) || '',
          model: (config && config.model) || BUILTIN_MODEL.model,
          maxTokens: 16,
        },
        [{ role: 'user', content: 'ping' }],
        {}
      );
      if (msg && typeof msg.content === 'string') return { ok: true };
      return { ok: false, error: '空响应' };
    } catch (e) {
      return { ok: false, error: (e && e.message) ? e.message : '连接失败' };
    }
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
      // M4 注释：合并连续相同 role 的消息，修复硅基流动 20015「messages 格式非法」
      // 注意：此合并仅影响 user/assistant 文本消息；tool 配对完整性由下方 (a)(b) 二次修正保护。
      // 合并不会破坏 tool 消息（role='tool' 不匹配 user/assistant，不会进入此分支）。
      // （含思考段 + tool_calls 段被拆成两条 assistant 的情形，必须并回一条）。
      // 注：此合并经下方 (a)(b) 的 orphan/悬空 tool 配对二次修正保护，不会破坏 tool 配对。
      // 原 A5「误合并 assistant」经核对：在合法对话序列（assistant 之间必有 user/tool 隔开）
      // 不会误伤；若强行不合并反而回归 Q1/Q5 的 20015 修复，故保留合并。
      if ((role === 'user' || role === 'assistant') && last && last.role === role) {
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
    // 二次修正：保证 tool 配对完整性（防御 DeepSeek / OpenAI 兼容端点的两类 HTTP 400）
    //   (a) 孤儿 tool 消息：其 tool_call_id 在前面任何 assistant 的 tool_calls 中找不到匹配
    //       → 直接删除（无法配对，留着会让端点报 "Messages with role 'tool' must be a response
    //       to a preceding message with 'tool_calls' id"）。
    //   (b) 悬空 tool_calls：assistant 的某个 tool_call 在后面没有对应 tool 结果
    //       → 从 assistant 删除该 tool_call（否则端点报 "tool_calls 缺少 tool 响应"）。
    // 这两步让最终发给模型的 payload 在 tool 配对上「物理不可能」非法，无论上游如何拼装。
    const assistToolCallIds = new Set();
    for (const m of out) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc && tc.id) assistToolCallIds.add(tc.id);
        }
      }
    }
    // (a) 删除孤儿 tool 消息（逆序 splice 安全）
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role === 'tool') {
        if (!out[i].tool_call_id || !assistToolCallIds.has(out[i].tool_call_id)) out.splice(i, 1);
      }
    }
    // (b) 删除悬空 tool_calls（孤儿 tool 已删，重算已配对 id 集合）
    const pairedIds = new Set();
    for (const m of out) {
      if (m.role === 'tool' && m.tool_call_id) pairedIds.add(m.tool_call_id);
    }
    for (const m of out) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const kept = m.tool_calls.filter(function (tc) { return tc && tc.id && pairedIds.has(tc.id); });
        if (kept.length) m.tool_calls = kept; else delete m.tool_calls;
      }
    }
    // 兜底：被清空 tool_calls 的 assistant（无 content 且无 tool_calls）补空 content，
    // 规避个别端点对纯空 assistant 消息的苛刻校验
    for (const m of out) {
      if (m.role === 'assistant' && !m.tool_calls && (m.content === undefined || m.content === null)) m.content = '';
    }
    return out;
  }

  // 单层直连：根据传入的 config 直连大模型（OpenAI 兼容 /chat/completions）。
  async function callDirect(config, messages, options) {
    const baseUrl = (config.baseUrl || 'https://api.openai.com').replace(/\/$/, '');
    const url = baseUrl + '/chat/completions';
    const model = config.model || 'Qwen/Qwen3.5-4B';
    // H1 修复：apiKey 可能经 safeStorage 加密存储（前缀 'xj-enc:'），使用前需解密
    let apiKey = config.apiKey || '';
    if (apiKey.startsWith('xj-enc:') && typeof window !== 'undefined' && window.__XJ_API__ && window.__XJ_API__.decryptSecret) {
      try { apiKey = await window.__XJ_API__.decryptSecret(apiKey); } catch (e) { /* 解密失败用空串 */ apiKey = ''; }
    }

    // 发送前归一化角色序列，防御硅基流动 20015
    const safeMessages = normalizeMessageSequence(messages);
    const body = {
      model,
      messages: safeMessages,
      temperature: (options && options.temperature != null) ? options.temperature : 0.3,
      max_tokens: (options && options.maxTokens != null) ? options.maxTokens : (config.maxTokens || 4000),
    };
    // Qwen3 系列为「思考模型」，禁用思考可降低延迟、避免 reasoning 占用 token、
    // 并确保 function-calling 稳定输出 tool_calls。该参数为 SiliconFlow 专属，
    // 其它 OpenAI 兼容端点会忽略未知字段，不影响用户模型。
    if (/qwen/i.test(model)) {
      body.chat_template_kwargs = { enable_thinking: false };
    }
    // 条件注入 tools / tool_choice：仅当模型支持 function-calling 时注入（A1 修复：盲注会触发 HTTP 400）
    const canTools = !!(options && options.tools && options.tools.length && supportsFunctionCalling(config));
    if (canTools) {
      body.tools = options.tools;
      if (options.tool_choice) body.tool_choice = options.tool_choice;
    }

    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
    };
    // 试用代理档：附机器码供服务端按机器限额记账（X-Machine-Id）
    if (config.isTrial) {
      const mc = await getMachineCode();
      if (mc) headers['X-Machine-Id'] = mc;
    }
    let resp = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      // 试用限流：代理返回 429 + JSON {message}，优先展示友好文案（不进工具重试）
      if (resp.status === 429 && config.isTrial) {
        let msg = '免费试用次数已用完，请填写自有 API 密钥解锁无限额度。';
        try { const j = JSON.parse(errText); if (j && j.message) msg = j.message; } catch (e) {}
        const rlErr = new Error(msg);
        rlErr.code = 'TRIAL_RATE_LIMIT';
        throw rlErr;
      }
      // 工具不支持类错误（部分模型对 tools 报 400）→ 去掉 tools 重试一次，避免硬失败
      if (canTools && /tool|function_call|function-calling|tools/i.test(errText)) {
        delete body.tools;
        delete body.tool_choice;
        try {
          const resp2 = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) });
          updateQuotaFromHeaders(resp2.headers);
          if (resp2.ok) {
            const data2 = await resp2.json().catch(() => null);
            return data2 && data2.choices ? (data2.choices[0].message || { content: '' }) : { content: '' };
          }
        } catch (e2) { /* 忽略，抛原错误 */ }
      }
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 100)}`);
    }
    // 读取代理回传的额度/档位响应头，实时更新 UI
    updateQuotaFromHeaders(resp.headers);

    const data = await resp.json().catch(() => null);
    // 防御：非 JSON 响应（如网关 HTML 错误页）或缺少 choices 时给出清晰错误，
    // 而非抛出难以理解的 "Unexpected token <" 或访问 undefined.choices（A7 修复）
    if (!data || !Array.isArray(data.choices) || !data.choices.length) {
      const preview = (data && typeof data === 'object' && (data.error && data.error.message))
        ? data.error.message
        : '模型返回了非预期响应';
      throw new Error(preview);
    }
    // 返回整条 message 对象，保留 tool_calls（若有）
    return data.choices[0].message || { content: '' };
  }

  // 统一入口：取生效配置直连大模型；出错返回 { error }。
  // 真降级（A2 修复）：用户模型调用失败时回退到内置免费模型，而非直接抛错。
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
      // 仅当当前确实用的是用户模型（非试用代理）才降级，避免无意义自递归
      if (config.isUser && config.apiKey) {
        try {
          const builtinMsg = await callDirect(BUILTIN_MODEL, messages, options);
          return {
            content: builtinMsg.content || '',
            tool_calls: builtinMsg.tool_calls,
            tier: BUILTIN_MODEL.label,
            degraded: true,
            degradedReason: '用户模型调用失败：' + (e.message || '未知错误') + '，已自动降级到内置免费模型',
          };
        } catch (e2) {
          return { error: '模型调用失败（含内置兜底仍失败）：' + (e2.message || e.message || '未知错误') };
        }
      }
      if (e && e.code === 'TRIAL_RATE_LIMIT') return { error: e.message };
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

  // 通用问答：与 send 保持一致的错误回调形状 { error } / { content }，
  // 避免 chat 单独返回字符串错误导致调用方无法统一处理（A4 修复）
  function chat(userMessage, callback) {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ];
    callWithFallback(messages).then((res) => {
      if (res.error) {
        callback({ error: res.error });
        return;
      }
      callback({ content: res.content });
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
    testConnection,
    // 测试可访问：发送前消息序列归一化（防御硅基流动 20015）
    normalizeMessageSequence,
    // 模型是否支持 function-calling（denylist：已知不支持的推理/专属模型拒绝，其余默认支持）
    supportsFunctionCalling,
    // 兼容文档命名：isToolCapable(model, baseUrl) → 委托 denylist 判断（P0-1 改动 D 供 Agent 启动前自检）
    isToolCapable: function (model, baseUrl) {
      return supportsFunctionCalling({ model: model, baseUrl: baseUrl });
    },
    // 试用额度（v1.7.0）：代理侧记账，客户端只读展示 + 订阅变更
    getQuota,
    fetchQuota,
    refreshQuota: fetchQuota,
    onQuotaChange,
    getTrialModel,
  };
})();

if (typeof window !== 'undefined') {
  window.AI = AI;
  // 页面加载即拉取一次试用额度（用于 UI 显示剩余百分比）；失败静默（离线/代理不可达）
  if (AI.fetchQuota) { try { AI.fetchQuota(); } catch (e) {} }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeMessageSequence: AI.normalizeMessageSequence };
}
