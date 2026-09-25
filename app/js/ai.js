/* ============================================================
   心镜 XinJing — AI 集成模块
   职责：
   - 调用外部 API 生成 SOAP / 总结 / 分析 / AI 督导 / Agent 工具调用
   - 单层直连：根据用户填写的「模型名 + Base URL + 密钥」直连大模型
     （OpenAI 兼容 /chat/completions 接口）
   - 免费档（未填用户密钥）：统一走韩国代理（xinjingchat.online），
     默认请求 DeepSeek-V4-Pro 主力模型；仅当主力供应商失败时，
     由服务端权威路由降级到 Qwen3.5-4B 免费兜底。
   - 用户填了自己的密钥且验证通过 → 用用户模型（最高优先）。

   密钥安全说明（重要变更）：
   - 用户自己的 API 密钥唯一合法来源是「设置」页填写的 apiConfig（存于本机）。
   - 代理共享密钥（APP_PROXY_KEY）由构建期注入 secret.generated.js，仅供客户端向
     本项目代理鉴权；非 provider 密钥、被逆向也无妨——服务端按机器码硬限额兜底。
   - 任何 provider 密钥（DeepSeek / SiliconFlow）只存在于服务端 .env，永不进客户端/仓库。
   ============================================================ */

const AI = (() => {
  'use strict';

  // 试用代理地址、共享密钥和机器码只在主进程中使用，渲染层仅声明试用请求。
  const PRIMARY_TRIAL_MODEL = 'deepseek-v4-pro';
  const FREE_FALLBACK_MODEL = 'Qwen/Qwen3.5-4B';
  const BUILTIN_MODEL_SELECTION_KEY = 'aiModelSelection';
  const BUILTIN_SELECTABLE_MODELS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash', 'gpt-5.6']);

  function readSelectedBuiltinModel() {
    try {
      const settings = typeof Store !== 'undefined' && Store.getSettings ? Store.getSettings() : {};
      const selection = settings && settings[BUILTIN_MODEL_SELECTION_KEY];
      const model = selection && typeof selection.modelId === 'string' ? selection.modelId.trim() : '';
      return model ? model : PRIMARY_TRIAL_MODEL; // 2026-09-13（XJ-513 反馈 #6，审查修正）：放开白名单，信任服务器目录选择
    } catch (_) {
      return PRIMARY_TRIAL_MODEL;
    }
  }

  function buildTrialConfig(model) {
    const selected = model || PRIMARY_TRIAL_MODEL;
    const labels = {
      'deepseek-v4-pro': 'DeepSeek V4 Pro（主力模型）',
      'deepseek-v4-flash': 'DeepSeek V4 Flash（主力模型）',
      'gpt-5.6': 'GPT Terra（主力模型）',
    };
    return {
      model: selected,
      label: labels[selected] || '主力模型',
      isTrial: true,
    };
  }
  // 保留常量名供旧引用；实际默认请求主力，Qwen 只由服务端失败兜底。
  const BUILTIN_MODEL = buildTrialConfig(PRIMARY_TRIAL_MODEL);
  // 非 agent 与 Agent 共用同一主力模型路径，避免大师/督导/普通对话分裂。
  function buildNonAgentTrialConfig() {
    const selected = readSelectedBuiltinModel();
    return {
      model: selected,
      label: buildTrialConfig(selected).label,
      isTrial: true,
    };
  }

  // ---------- 长文本预算闸门（F5 §7.1-1 + §7.4）----------
  // 本模块是渲染进程唯一的 provider 出口（AI.send / AI.stream / AI.chat / AI.supervise /
  // AI.generateSoapFromTranscript / AI.testConnection 全部汇聚到 callDirect），
  // 因此「超过总输入上限必须明确拒绝、不得静默截断」在这里 fail-closed：
  // 超限时不发请求，返回带稳定 errorCode 的失败对象。
  // 上限与多学派核心 SupervisionSyndicate.MAX_INPUT_CHARS 同口径，避免三入口预算漂移。
  const MAX_TOTAL_INPUT_CHARS = 240000;
  // errorCode 复用全仓既有码表（见 supervision-syndicate.js 的 MATERIAL_TOO_LONG /
  // STAGE_BUDGET_EXCEEDED），不另造同义新码。
  const BUDGET_ERROR_CODE = 'MATERIAL_TOO_LONG';
  const BUDGET_TRANSPORT_CODE = 'XJ_AI_INPUT_BUDGET_EXCEEDED';
  /* ---------- F5-A（2026-09-24 裁决①）：公布值与判定必须是同一个口径 ----------
   * 本卡之前的形状：同一个 240,000 在**两个位置按两种量纲**判一次
   *   （callDirect 脱敏前判一次 + 脱敏后再判一次），于是「你能送 240,000 字符」
   *   这个对外口径对真实材料是假的 —— 中文会谈文本经本地脱敏会**扩写**
   *   （reviews-r1c 实测 realistic 语料 ×1.3766，本卡 logs/f5-consistency/measure-01.json
   *    复算 ×1.3745；高密度语料实测 ×1.43–1.57），真实可粘贴的原始字符远少于 240,000。
   * 现在只有一个口径：**本地脱敏后的真实出站字符数**（measureInputChars →
   * measureOutboundProjection）。公布值 240,000 说的就是它，判定也只比它；「可粘贴多少
   * 原始字符」另按**实测最坏**扩写系数换算成 RAW_MATERIAL_BUDGET_CHARS 一并公布（当前 150,000），
   * 不再与判定口径混用。
   * 脱敏规则本身（PERSON_NAME 94% 假阳性 ⇒ 扩写主因）已转脱敏专项，本卡不动
   * app/js/pii-sanitizer.js；它修好后 RAW_MATERIAL_BUDGET_CHARS 会随实测系数重新算出更高的值。
   */
  const BUDGET_METRIC = 'sanitised-outbound-chars';
  /* 扩写系数按**实测最坏语料**取，不按单份 realistic 语料取。
   * reviews-r1c / r1e 实测：realistic ×1.3766、高密度 ×1.43–1.57
   * （拒绝文案里那句本批实测系数就是 1.5676）。旧值 1.3766 折算出的 174,342
   * 高于行为学定位到的最大可放行原始量（152,851 / 153,059–153,108），
   * 高密度真实临床材料粘到公布值会被拒 ⇒ 原来那句「一定能在判定里放行」不成立。
   * 现在按 1.6（实测典型最坏 1.57 + ~2% 余量）折算 ⇒ 150,000。
   * **这不是「任何输入都保证放行」**：reviews-r1g 实测极端重复文本（背靠背同句，×2.001）
   * 的最大可放行原始量只有 119,941，仍低于该公布值 ⇒ 150,000 只对典型语料诚实。
   * 判定本身永远只比实际出站字节，超限一律 fail-closed 且零出网；这个数只是
   * 「典型临床材料可粘贴多少原始字符」的对外参考口径，不是保证额度。 */
  const SANITISATION_EXPANSION_FACTOR = 1.6;
  const RAW_MATERIAL_BUDGET_CHARS = Math.floor(MAX_TOTAL_INPUT_CHARS / SANITISATION_EXPANSION_FACTOR);

  // 出站投影缓存：判定会在一次发送里对同一批文本发生多次（前置判定 + 最终载荷判定），
  // 而脱敏是纯正则重活（240k 字符一次 ~2.6s）。键 = 原文字符串，值 = 脱敏后字符数。
  // 依赖「脱敏幂等」这一事实（wire(wire(x)) === wire(x)）；本卡套件
  // scripts/f5-budget-consistency.test.cjs 用四份语料把它钉成断言（C1-idempotent-*）。
  const OUTBOUND_CACHE_LIMIT = 24;
  const outboundCharCache = typeof Map === 'function' ? new Map() : null;
  function cachedOutboundChars(text) {
    if (!outboundCharCache) return undefined;
    const hit = outboundCharCache.get(text);
    return typeof hit === 'number' ? hit : undefined;
  }
  function rememberOutboundChars(text, chars) {
    if (!outboundCharCache || typeof chars !== 'number') return;
    outboundCharCache.set(text, chars);
    while (outboundCharCache.size > OUTBOUND_CACHE_LIMIT) outboundCharCache.delete(outboundCharCache.keys().next().value);
  }
  // 把「已经是脱敏后形态」的正文按自身长度登记为出站长度（依据：脱敏幂等）。
  function primeOutboundCache(messages) {
    const parts = payloadParts(messages);
    for (let i = 0; i < parts.length; i++) {
      if (cachedOutboundChars(parts[i]) === undefined) rememberOutboundChars(parts[i], parts[i].length);
    }
  }
  function syncSanitizer() {
    try {
      if (typeof window !== 'undefined' && window.XJPIISanitizer
        && typeof window.XJPIISanitizer.sanitizeMessages === 'function') return window.XJPIISanitizer;
    } catch (e) { /* 取不到就走降级视图 */ }
    return null;
  }
  function payloadParts(messages) {
    if (!Array.isArray(messages)) return [];
    const out = [];
    for (let i = 0; i < messages.length; i++) {
      const content = messages[i] && messages[i].content;
      if (typeof content === 'string') { if (content) out.push(content); }
      else if (Array.isArray(content)) {
        for (let p = 0; p < content.length; p++) {
          const part = typeof content[p] === 'string' ? content[p] : (content[p] && typeof content[p].text === 'string' ? content[p].text : '');
          if (part) out.push(part);
        }
      }
    }
    return out;
  }
  /* 唯一权威度量：这批 messages 交给本模块出口后**实际出站**的字符数。
   * 与 callDirect 真正发送的载荷同配方（同一条 XJPIISanitizer.sanitizeMessages 路径）；
   * 本地脱敏模块尚未加载时降级为「组装后字符数」视图，并在 basis 里如实标注 ——
   * 降级只会少拒（不产生误拒），网络侧仍由 callDirect 的最终判定 fail-closed。 */
  function measureOutboundProjection(messages) {
    const rawChars = measureComposedChars(messages);
    const sanitizer = syncSanitizer();
    if (!sanitizer) return { chars: rawChars, rawChars: rawChars, basis: 'composed-chars-no-local-sanitiser' };
    let total = 0;
    const parts = payloadParts(messages);
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      let chars = cachedOutboundChars(part);
      if (chars === undefined) {
        let projected = null;
        try { projected = sanitizer.sanitizeMessages([{ role: 'user', content: part }]); } catch (e) { projected = null; }
        chars = projected && projected.ok && Array.isArray(projected.messages)
          ? measureComposedChars(projected.messages) : part.length;
        rememberOutboundChars(part, chars);
      }
      total += chars;
    }
    return { chars: total, rawChars: rawChars, basis: BUDGET_METRIC };
  }

  // 「组装后」视图：只用于随响应回报（rawChars）与遥测，不参与任何判定。
  function measureComposedChars(messages) {
    if (!Array.isArray(messages)) return 0;
    let total = 0;
    for (let i = 0; i < messages.length; i++) {
      const content = messages[i] && messages[i].content;
      if (typeof content === 'string') total += content.length;
      else if (Array.isArray(content)) {
        for (let p = 0; p < content.length; p++) {
          const part = content[p];
          if (typeof part === 'string') total += part.length;
          else if (part && typeof part.text === 'string') total += part.text.length;
        }
      }
    }
    return total;
  }

  // 判定用的**唯一**度量：真实出站字符数（见上面 F5-A 注释）。名字沿用
  // measureInputChars，是为了让「input budget」的 input 指的是真正送进模型的那份载荷。
  function measureInputChars(messages) {
    return measureOutboundProjection(messages).chars;
  }

  // 返回 null 表示在预算内；否则返回统一的超限描述（不含任何被截断的正文）。
  // 判定只发生在这里、只按一个口径（totalChars = 脱敏后出站字符数）。
  function inputBudgetFailure(messages) {
    const totalChars = measureInputChars(messages);
    if (totalChars <= MAX_TOTAL_INPUT_CHARS) return null;
    const outbound = measureOutboundProjection(messages);
    return {
      ok: false,
      error: '本次载荷本地脱敏后实际出站 ' + totalChars + ' 字符 > 出站上限 ' + MAX_TOTAL_INPUT_CHARS
        + ' 字符（同一批材料脱敏前 ' + outbound.rawChars + ' 字符，扩写系数 '
        + (outbound.rawChars ? (totalChars / outbound.rawChars).toFixed(4) : '1') + '）。'
        + '已拒绝发送且未截断任何内容；对外公布的 ' + MAX_TOTAL_INPUT_CHARS + ' 指的就是这个出站口径，'
        + '而「可直接粘贴的原始材料」按已测最坏扩写系数 ' + SANITISATION_EXPANSION_FACTOR
        + ' 折算，保守公布为约 ' + RAW_MATERIAL_BUDGET_CHARS
        + ' 字符（本批系数只作诊断，不作为放行额度），请缩短材料，或改用带分段摘要的多学派督导入口',
      errorCode: BUDGET_ERROR_CODE,
      code: BUDGET_TRANSPORT_CODE,
      totalChars: totalChars,
      rawChars: outbound.rawChars,
      measureBasis: outbound.basis,
      metric: BUDGET_METRIC,
      limitChars: MAX_TOTAL_INPUT_CHARS,
      truncated: false,
      transportState: 'manual-only',
    };
  }

  function budgetError(failure) {
    const error = new Error(failure.error);
    error.code = failure.code;
    error.errorCode = failure.errorCode;
    error.inputBudget = failure;
    return error;
  }

  // ---------- DEC-02（FIND-04）：内置模型兜底必须可见 ----------
  // 产品裁决：供应商失败后由内置试用模型代答的行为**保留**，但不得伪装成正常成功。
  // 本模块唯一的兜底出口是 callWithManualOnly 的 manual-fallback-builtin 分支，
  // 因此降级事实在这里一次性挂齐，上层只消费、不再各自猜文案：
  //   fallback / degraded / warning            —— 可见降级标记（显式布尔 + 稳定 warning 码）
  //   originalErrorCode / originalCode /
  //   originalStatus / originalError           —— 原始失败事实，一律不得丢失
  //   requestedTier / requestedModel           —— 用户所选档位
  //   tier / actualModel                       —— 实际使用档位（归档可追溯用）
  // warning 是新概念（降级告警），不与 MATERIAL_TOO_LONG / STAGE_BUDGET_EXCEEDED 等
  // 既有 errorCode 同义；transportState 沿用既有字面量 'manual-fallback-builtin'。
  const FALLBACK_WARNING_CODE = 'BUILTIN_FALLBACK_USED';
  const FALLBACK_TRANSPORT_STATE = 'manual-fallback-builtin';
  // 「模型没答」沿用全仓既有码（app/js/supervision-syndicate.js :: callProvider 用的就是
  // EMPTY_RESPONSE），不另造同义码。
  const EMPTY_REPLY_CODE = 'EMPTY_RESPONSE';
  // 兜底事件登记表：核心管线（多学派督导）不把 AI.send 的返回对象透传给页面，
  // 页面与归档写入需要按「本次运行区间」取回降级事实与实际档位，故在此留痕。
  // 语义：单调递增 seq + 有界环形数组；上层用 count()/since(seq) 做区间关联，
  // 只会「多报一次降级」（并发请求），不会漏报——对临床可见性要求是安全方向。
  const FALLBACK_LEDGER_LIMIT = 50;
  const fallbackLedger = [];
  let fallbackLedgerSeq = 0;

  // 取消判定：用户主动取消 / 核心阶段超时（invokeCard 的 cancelTransport）都会让
  // signal.aborted === true，且抛出的错误带 ABORT_ERR / AbortError。两条都要认。
  function isAbortLike(error, options) {
    if (error && (error.code === 'ABORT_ERR' || error.name === 'AbortError')) return true;
    return !!(options && options.signal && options.signal.aborted === true);
  }

  function abortFailureResult() {
    const error = new Error('已取消生成');
    error.code = 'ABORT_ERR';
    return safeFailureResult(error, { transportState: 'manual-only' });
  }

  function recordFallbackEvent(info) {
    fallbackLedgerSeq += 1;
    const event = {
      seq: fallbackLedgerSeq,
      at: new Date().toISOString(),
      requestedTier: String(info.requestedTier || ''),
      requestedModel: String(info.requestedModel || ''),
      tier: String(info.tier || ''),
      actualModel: String(info.actualModel || ''),
      modelMismatch: info.modelMismatch === true,
      warning: FALLBACK_WARNING_CODE,
      transportState: FALLBACK_TRANSPORT_STATE,
      originalErrorCode: String(info.originalErrorCode || ''),
      originalCode: String(info.originalCode || ''),
      originalStatus: typeof info.originalStatus === 'number' ? info.originalStatus : null,
      outputChars: typeof info.outputChars === 'number' ? info.outputChars : 0,
    };
    fallbackLedger.push(event);
    if (fallbackLedger.length > FALLBACK_LEDGER_LIMIT) fallbackLedger.shift();
    return event;
  }

  function fallbackEventsSince(seq) {
    const from = Number(seq) || 0;
    return fallbackLedger.filter(function (item) { return item.seq > from; });
  }

  function uniqueValues(list, key) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const value = list[i] && list[i][key];
      if (value != null && value !== '' && out.indexOf(value) < 0) out.push(value);
    }
    return out;
  }

  // 把兜底事件投影成可落库的溯源对象（写入督导归档既有的 usage 字段，
  // 不改 store.js、不改 supervision-syndicate.js 的归档字段表）。
  function fallbackProvenance(events) {
    const list = Array.isArray(events) ? events.slice() : [];
    if (!list.length) return null;
    const last = list[list.length - 1];
    return {
      usedBuiltinFallback: true,
      degraded: true,
      warning: FALLBACK_WARNING_CODE,
      transportState: FALLBACK_TRANSPORT_STATE,
      eventCount: list.length,
      firstSeq: list[0].seq,
      lastSeq: last.seq,
      requestedTiers: uniqueValues(list, 'requestedTier'),
      actualTiers: uniqueValues(list, 'tier'),
      actualModels: uniqueValues(list, 'actualModel'),
      originalErrorCodes: uniqueValues(list, 'originalErrorCode'),
      originalCodes: uniqueValues(list, 'originalCode'),
      modelMismatch: list.some(function (item) { return item.modelMismatch === true; }),
      notice: fallbackNoticeText(last),
      at: last.at,
    };
  }

  // 用户可见文案（页面共用，措辞说人话且绝不把降级说成成功）。
  function fallbackNoticeText(source) {
    const info = source && typeof source === 'object' ? source : {};
    const requested = String(info.requestedTier || info.requestedModel || '').trim() || '你选择的模型';
    const actual = String(info.tier || info.actualTier || info.actualModel || '').trim() || '内置模型';
    const code = String(info.originalErrorCode || info.originalCode || '').trim() || '未知';
    const reason = String(info.originalError || '').trim();
    const head = info.modelMismatch === false
      ? '本次回复是内置模型「' + actual + '」在原请求失败后重发得到的，不是你选择的那一次请求的输出'
      : '本次由内置模型「' + actual + '」代答，不是你选择的「' + requested + '」';
    return head + '（原始失败：' + code + (reason ? '；' + reason : '') + '）。'
      + '这不属于所选模型的正常结果，请谨慎用于临床判断；可点重试，或在「设置 → AI 接口」配置自有模型。';
  }

  // 兜底可见字段在对外回调（send / chat / supervise / soap）中的统一投影。
  const DEGRADATION_KEYS = [
    'warning', 'degraded', 'requestedTier', 'requestedModel', 'actualModel', 'modelMismatch',
    'originalErrorCode', 'originalCode', 'originalStatus', 'originalError', 'fallbackSeq',
  ];
  function degradationFields(res) {
    if (!res || typeof res !== 'object') return { fallback: false };
    const out = {};
    // 未降级也显式表态（fallback:false），上层不必再靠「有没有 error 字段」反推；
    // tier / transportState 始终随附，使「实际用了哪个模型」在每一次落库都可核对。
    out.fallback = res.fallback === true;
    if (res.tier !== undefined) out.tier = res.tier;
    if (res.transportState !== undefined) out.transportState = res.transportState;
    if (out.fallback !== true) return out;
    for (let i = 0; i < DEGRADATION_KEYS.length; i++) {
      const key = DEGRADATION_KEYS[i];
      if (res[key] !== undefined) out[key] = res[key];
    }
    out.degraded = true;
    out.notice = fallbackNoticeText(res);
    return out;
  }

  function getAiBridge() {
    const bridge = typeof window !== 'undefined' ? window.__XJ_API__ : null;
    if (!bridge || typeof bridge.aiRequest !== 'function' || typeof bridge.cancelAiRequest !== 'function' || typeof bridge.onAiChunk !== 'function') {
      throw new Error('AI network bridge is unavailable');
    }
    return bridge;
  }

  function newAiRequestId() {
    return 'ai_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 14);
  }

  function resultError(result, fallbackMessage) {
    const detail = result && result.error && typeof result.error === 'object' ? result.error : {};
    const error = new Error(detail.message || fallbackMessage || 'AI request failed');
    if (detail.code) error.code = detail.code;
    if (result && result.status) error.status = Number(result.status);
    if (result && typeof result.bodyText === 'string') error.bodyText = result.bodyText;
    return error;
  }

  function loadPiiSanitizer() {
    if (typeof window === 'undefined') return Promise.reject(new Error('本地隐私脱敏模块不可用'));
    if (window.XJPIISanitizer && typeof window.XJPIISanitizer.sanitizeMessages === 'function') {
      return Promise.resolve(window.XJPIISanitizer);
    }
    if (window.__xjPiiSanitizerLoad) return window.__xjPiiSanitizerLoad;
    if (typeof document === 'undefined' || !document.createElement) return Promise.reject(new Error('本地隐私脱敏模块不可用'));
    window.__xjPiiSanitizerLoad = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'js/pii-sanitizer.js';
      script.async = false;
      script.onload = function () {
        var api = window.XJPIISanitizer;
        if (api && typeof api.sanitizeMessages === 'function') resolve(api);
        else reject(new Error('本地隐私脱敏模块加载失败'));
      };
      script.onerror = function () { reject(new Error('本地隐私脱敏模块加载失败')); };
      (document.head || document.documentElement).appendChild(script);
    }).catch(function (error) {
      window.__xjPiiSanitizerLoad = null;
      throw error;
    });
    return window.__xjPiiSanitizerLoad;
  }

  async function requestAiBroker(config, body, options, onChunk) {
    options = options || {};
    const bridge = getAiBridge();
    const requestId = newAiRequestId();
    const signal = options.signal;
    if (signal && signal.aborted) {
      const aborted = new Error('已取消生成');
      aborted.code = 'ABORT_ERR';
      throw aborted;
    }
    const unsubscribe = bridge.onAiChunk(function (event) {
      if (event && event.requestId === requestId && typeof onChunk === 'function') onChunk(event.chunk);
    });
    const cancel = function () { bridge.cancelAiRequest(requestId); };
    if (signal) signal.addEventListener('abort', cancel, { once: true });
    try {
      return await bridge.aiRequest({
        requestId: requestId,
        kind: body ? 'chat' : 'quota',
        config: {
          baseUrl: config && config.baseUrl ? String(config.baseUrl) : '',
          apiKey: config && config.apiKey ? String(config.apiKey) : '',
          model: config && config.model ? String(config.model) : '',
          isTrial: !!(config && config.isTrial),
        },
        body: body || undefined,
        streaming: typeof onChunk === 'function',
      });
    } finally {
      if (signal) signal.removeEventListener('abort', cancel);
      if (typeof unsubscribe === 'function') unsubscribe();
    }
  }

  // 将可观测错误归一为安全分类；分类供诊断/UI 使用，原始错误不向外泄露。
  function classifyError(error) {
    if (!error) return 'provider_http';
    if (error.code === 'ABORT_ERR' || error.name === 'AbortError') return 'aborted';
    if (error.code === 'TRIAL_RATE_LIMIT') return 'rate_limit';
    if (error.code === 'XJ_AI_ACCOUNT_SESSION_REQUIRED') return 'account_session_required';
    if (error.code === 'XJ_AI_CREDENTIAL_MISSING') return 'auth';
    const status = Number(error.status || error.httpStatus || 0);
    const message = String(error.message || '').toLowerCase();
    if (message.indexOf('account-session-required') >= 0 || message.indexOf('account session') >= 0) return 'account_session_required';
    if (status === 401 || status === 403 || /\b(401|403)\b|unauthori[sz]ed|invalid.*(key|token)|api.?key/.test(message)) return 'auth';
    if (status === 429 || /\b429\b|rate.?limit|quota|too many requests|额度|限流/.test(message)) return 'rate_limit';
    if (!status && /failed to fetch|fetch failed|network|dns|timeout|timed out|econn|enotfound|cors|网络|连接|超时/.test(message)) return 'network';
    if (status >= 400 && status < 500) return 'provider_http';
    if (status >= 500) return 'provider_http';
    return 'provider_http';
  }

  // 2026-09-15 UX 审计：把内部分类映射为「带下一步动作」的用户文案。
  // 原兜底「请检查配置、网络或服务状态」无法区分鉴权/网络/服务端故障，
  // 零先验用户看到后不知道该检查什么，只能放弃。
  function failureTextFor(errorCode) {
    if (errorCode === 'auth') return 'AI 服务鉴权失败（密钥无效或未配置），请在「设置 → AI 接口」检查配置';
    if (errorCode === 'network') return '网络连接失败，请检查网络后重试';
    return 'AI 服务暂时不可用，请稍后重试；若持续出现，请把错误码 ' + errorCode + ' 发给客服';
  }

  // 所有失败出口共用固定文案；错误详情只保留内部分类，不把服务端原文带到 UI。
  function safeFailureResult(error, options) {
    options = options || {};
    const errorCode = classifyError(error);
    const transportState = options.transportState || 'manual-only';
    if (errorCode === 'aborted') {
      return { error: '已取消生成', code: 'ABORT_ERR', errorCode: errorCode, interrupted: true, partialContent: options.partialContent || '', transportState: transportState };
    }
    if (options.partial) {
      return { error: '生成过程中断，请检查网络或服务状态', errorCode: errorCode, partialContent: options.partialContent || '', transportState: transportState };
    }
    if (errorCode === 'rate_limit') {
      return { error: '试用额度已用完，请稍后重试或配置自有 API 密钥', errorCode: errorCode, transportState: transportState };
    }
    if (errorCode === 'account_session_required') {
      return {
        error: '账号会话已失效或未登录，请重新登录后重试',
        code: 'XJ_AI_ACCOUNT_SESSION_REQUIRED',
        errorCode: errorCode,
        transportState: transportState,
      };
    }
    return { error: failureTextFor(errorCode), errorCode: errorCode, transportState: transportState };
  }

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
  function readResponseHeader(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    const lower = String(name || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(headers, lower) ? headers[lower] : null;
  }
  function updateQuotaFromHeaders(headers) {
    if (!headers) return;
    try {
      const p = readResponseHeader(headers, 'x-quota-percent');
      const r = readResponseHeader(headers, 'x-quota-remaining');
      const t = readResponseHeader(headers, 'x-tier');
      const rt = readResponseHeader(headers, 'x-quota-reset');
      const info = {};
      if (p != null && p !== '') info.percent = parseInt(p, 10);
      if (r != null && r !== '') info.remainingYuan = parseFloat(r);
      if (t != null && t !== '') info.tier = t;
      if (rt != null && rt !== '') info.resetAt = rt;
      if (Object.keys(info).length) { info._fromServer = true; applyQuotaInfo(info); }
    } catch (e) { /* ignore */ }
  }
  // 主动查询额度（当前服务端 GET /quota?mid=...），供 UI 初始化展示与「刷新」按钮
  async function fetchQuota() {
    try {
      const result = await requestAiBroker({ isTrial: true }, null, {});
      if (!result || !result.ok) return QUOTA_CACHE;
      let data = null;
      try { data = JSON.parse(result.bodyText || ''); } catch (e) { data = null; }
      if (data && data.remainingYuan != null) {
        applyQuotaInfo({
          percent: data.percent != null ? data.percent : Math.max(0, Math.round((data.remainingYuan / QUOTA_TOTAL_YUAN) * 100)),
          remainingYuan: data.remainingYuan,
          resetAt: data.resetAt || null,
          tier: data.tier || null,
          _fromServer: true,
        });
      }
      updateQuotaFromHeaders(result.headers);
    } catch (e) { /* 离线/代理不可达：保留上次缓存或 null */ }
    return QUOTA_CACHE;
  }
  function getQuota() { return QUOTA_CACHE; }
  // 试用档始终请求主力模型；是否需要兜底由服务器根据真实上游失败决定。
  function getTrialModel() {
    return readSelectedBuiltinModel();
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
  // 否则走试用代理主力 DeepSeek Pro；服务端失败时才回退 Qwen。
  // 关键修复（A3）：必须与 getTier 一致以 verified 为事实来源，避免「填错密钥谎报高性能」。
  function getActiveConfig() {
    const user = getConfig();
    if (user && user.apiKey && String(user.apiKey).trim() && user.baseUrl && String(user.baseUrl).trim() && user.verified === true) {
      return {
        baseUrl: (user.baseUrl || '').trim(),
        apiKey: user.apiKey.trim(),
        model: (user.modelPreference || '').trim() || BUILTIN_MODEL.model,
        maxTokens: user.maxTokens || 4000,
        label: '用户模型',
        isUser: true,
      };
    }
    return buildTrialConfig(getTrialModel());
  }

  // 非 agent 默认配置：与 getActiveConfig 同源（用户自有 key 优先），
  // 试用档固定走主力 DeepSeek Pro；服务端负责失败兜底。
  function getNonAgentConfig() {
    const user = getConfig();
    if (user && user.apiKey && String(user.apiKey).trim() && user.baseUrl && String(user.baseUrl).trim() && user.verified === true) {
      return {
        baseUrl: (user.baseUrl || '').trim(),
        apiKey: user.apiKey.trim(),
        model: (user.modelPreference || '').trim() || BUILTIN_MODEL.model,
        maxTokens: user.maxTokens || 4000,
        label: '用户模型',
        isUser: true,
      };
    }
    return buildNonAgentTrialConfig();
  }

  // 档位：'user' = 用户自有高性能模型（且已验证可用）；'builtin' = 服务器主力模型试用档。
  // 主力失败时由服务端决定是否切换 Qwen 兜底；客户端不提前改写模型。
  function getTier() {
    const user = getConfig();
    return (user && user.apiKey && String(user.apiKey).trim() && user.baseUrl && String(user.baseUrl).trim() && user.verified === true) ? 'user' : 'builtin';
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
      return { ok: false, error: '服务端返回空响应', errorCode: 'provider_http' };
    } catch (e) {
      if (e && e.inputBudget) return { ok: false, error: e.inputBudget.error, errorCode: e.inputBudget.errorCode, totalChars: e.inputBudget.totalChars, limitChars: e.inputBudget.limitChars, truncated: false };
      const pingCode = classifyError(e);
      return {
        ok: false,
        // 2026-09-15 UX 审计：与 safeFailureResult 共用同一套可操作文案，
        // 不再额外加「连接失败：」前缀（历史遗留的双重前缀问题）。
        error: failureTextFor(pingCode),
        errorCode: pingCode,
      };
    }
  }

  // 失败对象向上投影：稳定 errorCode 与预算/分段结构化字段必须原样带给调用方。
  // 修复前 chat / supervise / generateSoapFromTranscript 只回 {error, transportState}，
  // 把闸门与 provider 的 errorCode 吞在模块内部（与 F5-D2 同型缺陷）。
  function projectFailure(res) {
    const src = (res && typeof res === 'object') ? res : {};
    const out = {
      error: src.error,
      code: src.code,
      errorCode: src.errorCode,
      interrupted: src.interrupted,
      partialContent: src.partialContent,
      transportState: src.transportState,
    };
    if (typeof src.totalChars === 'number') out.totalChars = src.totalChars;
    if (typeof src.limitChars === 'number') out.limitChars = src.limitChars;
    if (typeof src.truncated === 'boolean') out.truncated = src.truncated;
    return out;
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

  function createSseAccumulator(onDelta, onReasoning) {
    let buffer = '';
    let content = '';
    let reasoning = '';
    let received = false;
    const toolCalls = {};
    function consume(line) {
        if (!line || line.indexOf('data:') !== 0) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let packet;
        try { packet = JSON.parse(payload); } catch (e) { return; }
        const delta = packet && packet.choices && packet.choices[0] && packet.choices[0].delta;
        // 2026-09-11 修复：流式响应中的 tool_calls 分段到达（同一 index 多帧合并），
        // 此前被丢弃导致 runRound 永远收不到模型工具调用（流式→非流式行为不一致）
        if (delta && Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = Number.isInteger(tc.index) ? tc.index : 0;
            if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            const t = toolCalls[idx];
            if (tc.id) t.id = tc.id;
            if (tc.type) t.type = tc.type;
            if (tc.function) {
              if (typeof tc.function.name === 'string') t.function.name += tc.function.name;
              if (typeof tc.function.arguments === 'string') t.function.arguments += tc.function.arguments;
            }
          }
          received = true;
        }
        const piece = delta && typeof delta.content === 'string' ? delta.content : '';
        // 2026-09-11：DeepSeek 系思考过程（reasoning_content）累积透传，供调用方渲染"思考过程"
        const rPiece = delta && typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
        if (rPiece) {
          reasoning += rPiece;
          if (typeof onReasoning === 'function') onReasoning(rPiece, reasoning);
        }
        if (!piece) return;
        received = true;
        content += piece;
        onDelta(piece, content);
    }
    return {
        push: function (chunk) {
          buffer += String(chunk || '');
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          lines.forEach(consume);
        },
        finish: function () {
          if (buffer) consume(buffer);
          buffer = '';
          const tcList = Object.keys(toolCalls).map(function (k) { return toolCalls[k]; })
            .filter(function (t) { return t && t.function && (t.function.name || t.function.arguments); });
          return { content: content, reasoning: reasoning, received: received, toolCalls: tcList };
        },
    };
    }

  function parseChatMessage(bodyText) {
    let data = null;
    try { data = JSON.parse(bodyText || ''); } catch (e) { data = null; }
    if (!data || !Array.isArray(data.choices) || !data.choices.length) {
      const preview = data && data.error && data.error.message ? data.error.message : '模型返回了非预期响应';
      throw new Error(preview);
    }
    return data.choices[0].message || { content: '' };
  }

  function acceptCommercialProjection(value) {
    if (!value || typeof value !== 'object') return null;
    const normalized = typeof XJEntitlements !== 'undefined' && XJEntitlements.normalizeCommercialProjection
      ? XJEntitlements.normalizeCommercialProjection(value)
      : null;
    if (!normalized) return null;
    if (typeof Store !== 'undefined' && Store.setCommercialProjection) {
      try { Store.setCommercialProjection(normalized); } catch (e) { /* projection cache is best effort */ }
    }
    return normalized;
  }

  // 单层调用：渲染层只组织模型请求，网络、重定向和凭据解密统一由主进程代理。
  async function callDirect(config, messages, options) {
    options = options || {};
    // F5-A（2026-09-24 裁决①）：这里**不再**有「脱敏前用同一个公布值判一次」的闸门。
    // 原先那一道量的是组装后字符数，与下面那道（量真实出站载荷）共用同一个 240,000，
    // 于是同一个对外承诺对应两种量纲、两个判定位置：脱敏会把中文会谈文本扩写
    // （实测 ×1.3766），第一道放行、第二道拒绝 ⇒「你能送 240,000」对真实材料是假的。
    // 现在总输入预算只判一次，且判的就是最终要上网的那份载荷（0 出网语义不变：
    // 判定仍在任何 bridge/网络动作之前）。
    const model = config.model || PRIMARY_TRIAL_MODEL;
    const sanitizer = await loadPiiSanitizer().catch(function () { return null; });
    if (!sanitizer || typeof sanitizer.sanitizeMessages !== 'function') {
      const unavailable = new Error('本地隐私脱敏模块未就绪，已阻止发送');
      unavailable.code = 'XJ_PII_SANITIZATION_UNAVAILABLE';
      throw unavailable;
    }
    const sanitized = sanitizer.sanitizeMessages(messages);
    if (!sanitized || !sanitized.ok) {
      const blocked = new Error('本地隐私脱敏未通过，已阻止发送');
      blocked.code = 'XJ_PII_SANITIZATION_FAILED';
      blocked.residual = sanitized && sanitized.residual ? sanitized.residual : [];
      throw blocked;
    }
    // 发送前归一化角色序列，防御硅基流动 20015
    const safeMessages = normalizeMessageSequence(sanitized.messages);
    // 已脱敏的正文再投影一次会得到同一个数（脱敏幂等，本卡 C1-idempotent-* 断言钉住），
    // 所以直接把这份最终载荷的字符数登记进缓存，避免 240k 级别的重复全量脱敏。
    primeOutboundCache(safeMessages);
    // 预算闸门（唯一判定）：对**即将上网的最终载荷**按权威口径判定，超限即抛，
    // 绝不截断后继续。这是「超限载荷不可能到达 bridge」这条不变量的最后一道防线。
    const finalBudget = inputBudgetFailure(safeMessages);
    if (finalBudget) throw budgetError(finalBudget);
    const body = {
      model,
      messages: safeMessages,
      temperature: options.temperature != null ? options.temperature : 0.3,
      max_tokens: options.maxTokens != null ? options.maxTokens : (config.maxTokens || 4000),
    };
    const streaming = typeof options.onDelta === 'function';
    if (streaming) body.stream = true;
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
    const stream = streaming ? createSseAccumulator(options.onDelta, options.onReasoning) : null;
    let result;
    try {
      result = await requestAiBroker(config, body, options, stream ? stream.push : null);
    } catch (e) {
      if (e && (e.name === 'AbortError' || options.signal && options.signal.aborted)) {
        const abortErr = new Error('已取消生成');
        abortErr.code = 'ABORT_ERR';
        throw abortErr;
      }
      throw e;
    }

    if (!result || !result.ok) {
      const status = Number(result && result.status || 0);
      if (result && result.error && stream) {
        const interrupted = stream.finish();
        if (interrupted.received || result.error.code === 'ABORT_ERR') {
          const interruptedErr = resultError(result, '生成过程已中断');
          interruptedErr.partial = interrupted.received;
          interruptedErr.partialContent = interrupted.content;
          throw interruptedErr;
        }
      }
      // 试用限流：代理返回 429 + JSON {message}，优先展示友好文案（不进工具重试）
      if (status === 429 && config.isTrial) {
        const rlErr = new Error('免费试用次数已用完，请填写自有 API 密钥解锁无限额度。');
        rlErr.code = 'TRIAL_RATE_LIMIT';
        rlErr.status = status;
        throw rlErr;
      }
      // 工具不支持类错误（部分模型对 tools 报 400）→ 去掉 tools 重试一次，避免硬失败
      if (canTools && result && result.error && result.error.code === 'XJ_AI_TOOLS_UNSUPPORTED') {
        const retryBody = Object.assign({}, body);
        delete retryBody.tools;
        delete retryBody.tool_choice;
        delete retryBody.stream;
        try {
          const retry = await requestAiBroker(config, retryBody, { signal: options.signal }, null);
          updateQuotaFromHeaders(retry && retry.headers);
          if (retry && retry.ok) {
            return parseChatMessage(retry.bodyText);
          }
        } catch (e2) { /* 忽略，抛原错误 */ }
      }
      throw resultError(result, status ? ('HTTP ' + status) : 'AI network request failed');
    }
    // 读取代理回传的额度/档位响应头，实时更新 UI
    updateQuotaFromHeaders(result.headers);

    const contentType = readResponseHeader(result.headers, 'content-type') || '';
    if (streaming && /text\/event-stream/i.test(contentType)) {
      const streamed = stream.finish();
      if (options.signal && options.signal.aborted) {
        const abortErr = new Error('已取消生成');
        abortErr.code = 'ABORT_ERR';
        abortErr.partial = streamed.received;
        abortErr.partialContent = streamed.content;
        throw abortErr;
      }
      const streamedMsg = { content: streamed.content, reasoning: streamed.reasoning, commercial: acceptCommercialProjection(result.commercial) };
      if (Array.isArray(streamed.toolCalls) && streamed.toolCalls.length) streamedMsg.tool_calls = streamed.toolCalls;
      return streamedMsg;
    }
    const message = parseChatMessage(result.bodyText);
    const commercial = acceptCommercialProjection(result.commercial);
    if (commercial) message.commercial = commercial;
    return message;
  }

  // 首版统一恢复策略：成功只报告 primary-ready；任何失败回到 manual-only，绝不跨服务重放临床请求。
  // 「模型没答」也算失败：正文为空且没有 tool_calls / reasoning 时（EMPTY_RESPONSE，
  // 复用 supervision-syndicate.js 的既有码，不新造同义码），主档不得静默返回空回复。
  function emptyReplyFailure(message) {
    if (message && (String(message.content || '').trim()
      || String(message.reasoning || message.reasoning_content || '').trim()
      || (Array.isArray(message.tool_calls) && message.tool_calls.length))) return null;
    return {
      errorCode: EMPTY_REPLY_CODE,
      code: EMPTY_REPLY_CODE,
      error: '模型未返回内容，请重试',
      status: 0,
    };
  }

  // 失败事实的可辨认投影：safeFailureResult 的安全文案 + 原始传输码（XJ_AI_RATE_LIMIT /
  // XJ_AI_TIMEOUT / ECONNRESET …）与 HTTP 状态，兜底成功后必须原样带出去（DEC-02 ①）。
  function normalizedFailure(error) {
    const res = safeFailureResult(error, { transportState: 'manual-only' });
    if (!res.code && error && error.code) res.code = String(error.code);
    const status = Number(error && (error.status || error.httpStatus)) || 0;
    if (status) res.status = status;
    return res;
  }

  // DEC-02：内置试用模型兜底（保留的产品行为）+ 全部可见降级字段。
  // original = normalizedFailure(...) / emptyReplyFailure(...)，即「原始失败」事实。
  async function builtinFallbackResult(config, messages, options, original) {
    const requestedTier = String((config && config.label) || '');
    const requestedModel = String((config && config.model) || '');
    try {
      const builtinConfig = buildNonAgentTrialConfig();
      const fbMsg = await callDirect(builtinConfig, messages, options);
      // DEC-02 ⑤（对齐 F6 迟到结果）：兜底请求在途期间用户取消、或核心阶段已
      // STAGE_TIMEOUT 并 abort 了传输，则这条迟到的兜底回复不得写回（不得交付内容）。
      if (isAbortLike(null, options)) return abortFailureResult();
      const actualTier = String((builtinConfig && builtinConfig.label) || 'builtin');
      const actualModel = String((builtinConfig && builtinConfig.model) || '');
      const empty = emptyReplyFailure(fbMsg);
      if (empty) {
        // 兜底也没内容：终态是失败，但「曾经降级代答过」与原始失败仍要让上层看见。
        return {
          error: empty.error,
          errorCode: empty.errorCode,
          code: empty.code,
          transportState: 'manual-only',
          fallback: false,
          fallbackAttempted: true,
          warning: FALLBACK_WARNING_CODE,
          requestedTier: requestedTier,
          requestedModel: requestedModel,
          tier: actualTier,
          actualModel: actualModel,
          originalErrorCode: original.errorCode,
          originalCode: original.code,
          originalError: original.error,
        };
      }
      const event = recordFallbackEvent({
        requestedTier: requestedTier,
        requestedModel: requestedModel,
        tier: actualTier,
        actualModel: actualModel,
        modelMismatch: requestedTier !== actualTier,
        originalErrorCode: original.errorCode,
        originalCode: original.code,
        originalStatus: typeof original.status === 'number' && original.status ? original.status : null,
        outputChars: String(fbMsg.content || '').length,
      });
      return {
        content: fbMsg.content || '',
        reasoning: fbMsg.reasoning || fbMsg.reasoning_content || '',
        tool_calls: fbMsg.tool_calls,
        commercial: fbMsg.commercial,
        tier: actualTier,
        transportState: FALLBACK_TRANSPORT_STATE,
        fallback: true,
        degraded: true,
        warning: FALLBACK_WARNING_CODE,
        requestedTier: requestedTier,
        requestedModel: requestedModel,
        actualModel: actualModel,
        modelMismatch: event.modelMismatch,
        originalErrorCode: original.errorCode,
        originalCode: original.code,
        originalError: original.error,
        originalStatus: event.originalStatus,
        fallbackSeq: event.seq,
      };
    } catch (e2) {
      // 兜底自身也失败：终态按「原始失败」的分类给出（既有行为），
      // 同时显式声明「曾尝试内置代答」与原始失败码，不让上层误读成主档故障。
      if (isAbortLike(e2, options)) return abortFailureResult();
      return {
        error: original.error || safeFailureResult(e2, { transportState: 'manual-only' }).error,
        errorCode: original.errorCode,
        code: original.code,
        transportState: 'manual-only',
        fallback: false,
        fallbackAttempted: true,
        warning: FALLBACK_WARNING_CODE,
        requestedTier: requestedTier,
        requestedModel: requestedModel,
      };
    }
  }

  async function callWithManualOnly(messages, options) {
    options = options || {};
    // 超限直接返回失败对象：既不发起主请求，也不进入「用户模型失败 → 内置模型重试」的
    // 兜底支路（否则同一份超限载荷会被重复投递）。
    const overBudget = inputBudgetFailure(messages);
    if (overBudget) return overBudget;
    const config = getNonAgentConfig();
    try {
      const message = await callDirect(config, messages, options);
      if (isAbortLike(null, options)) return abortFailureResult();
      const empty = emptyReplyFailure(message);
      // 产品裁决（DEC-02 追加，2026-09-24）：空正文**不触发**内置档重发。
      // DEC-02 授权的范围只有「传输失败才换档」；把「模型没答话」也当成换档理由，
      // 等于同一份临床材料多一次出网，且归档档位更不可追溯。
      if (empty) return Object.assign({ transportState: 'primary-empty' }, empty);
      return {
        content: message.content || '',
        reasoning: message.reasoning || message.reasoning_content || '',
        tool_calls: message.tool_calls,
        commercial: message.commercial,
        tier: config.label,
        transportState: 'primary-ready',
        // 未降级也要显式表态，避免上层靠「有没有 error 字段」猜是不是兜底。
        fallback: false,
      };
    } catch (e) {
      // 预算拒绝是终态：不得再打内置兜底模型（同一载荷必然再次超限，且属静默重试）。
      if (e && e.inputBudget) return e.inputBudget;
      // DEC-02 ④（对齐 F6「取消后不重试」）：用户主动取消一律直接失败，绝不触发兜底。
      // 这里既认抛出的 ABORT_ERR / AbortError，也认 signal.aborted —— 主进程在
      // abort 竞态下可能只回一个普通网络错误，此时同样不得补发第二次请求。
      if (isAbortLike(e, options)) {
        return safeFailureResult(e, { partial: e && e.partial, partialContent: e && e.partialContent, transportState: 'manual-only' });
      }
      // 首 token 已经交给 UI 后不可重放，否则用户会看到重复回答。
      if (e && e.partial) {
        return safeFailureResult(e, { partial: true, partialContent: e.partialContent, transportState: 'manual-only' });
      }
      // 2026-09-13（XJ-513 反馈 #5，审查修正）：用户自有 API 失败时自动回退服务器主力
      // 模型重试一次——必须用内置试用配置（buildNonAgentTrialConfig），不能用 getActiveConfig
      // （用户 verified 时它仍返回用户配置=重复打同一故障上游，兜底无效）。
      return builtinFallbackResult(config, messages, options, normalizedFailure(e));
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

    callWithManualOnly(messages).then((res) => {
      if (res.error) {
        callback(projectFailure(res));
        return;
      }
      callback(Object.assign(parseSoap(res.content), degradationFields(res)));
    });
  }

  // 通用问答：与 send 保持一致的错误回调形状 { error } / { content }，
  // 避免 chat 单独返回字符串错误导致调用方无法统一处理（A4 修复）
  function chat(userMessage, callback) {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ];
    callWithManualOnly(messages).then((res) => {
      if (res.error) {
        callback(projectFailure(res));
        return;
      }
      callback(Object.assign({ content: res.content, commercial: res.commercial, transportState: res.transportState }, degradationFields(res)));
    });
  }

  // 通用发送：接受一个完整的 messages 数组（可携带自定义 system 提示词、历史与摘要上下文）。
  // 大师对话 / 圆桌即使用此接口，传入大师人格 system prompt + 长时记忆摘要 + 对话历史。
  // options?: { tools?, tool_choice?, onDelta? }。有 callback 时保留回调契约；
  // 无 callback 时返回 Promise，供流式页面通过 onDelta 更新现有输出容器。
  function send(messages, callback, options) {
    if (!Array.isArray(messages) || !messages.length) {
      var empty = Promise.resolve({ error: '空消息' });
      if (typeof callback === 'function') empty.then(callback);
      return empty;
    }
    if (typeof callback !== 'function') {
      options = callback || options || {};
      return callWithManualOnly(messages, options);
    }
    const pending = callWithManualOnly(messages, options);
    pending.then((res) => {
      if (res.error) {
        callback(projectFailure(res));
        return;
      }
        callback(Object.assign({
          content: res.content,
          tier: res.tier,
          tool_calls: res.tool_calls,
          commercial: res.commercial,
        interrupted: res.interrupted,
        partialContent: res.partialContent,
        transportState: res.transportState,
        }, degradationFields(res)));
    });
    return pending;
  }

  // Explicit streaming surface for UI callers. The final promise retains the
  // same result/error shape as send(), while onDelta receives (piece, fullText).
  function stream(messages, onDelta, options) {
    if (!Array.isArray(messages) || !messages.length) return Promise.resolve({ error: '空消息' });
    const transportOptions = Object.assign({}, options || {}, { onDelta: onDelta });
    return callWithManualOnly(messages, transportOptions);
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
    callWithManualOnly(messages).then((res) => {
      if (res.error) {
        callback(projectFailure(res));
        return;
      }
      callback(Object.assign({ content: res.content, tier: res.tier, transportState: res.transportState }, degradationFields(res)));
    });
  }

  return {
    generateSoapFromTranscript,
    chat,
    send,
    stream,
    supervise,
    // 新增：暴露当前生效配置与档位（供 Agent / 设置页判断与提示）
    getActiveConfig,
    getNonAgentConfig,
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
    classifyError,
    safeFailureResult,
    // 长度闸门对上层可见：页面/工具层复用同一上限与同一 errorCode，
    // 全仓不得再出现第二套「超限」同义码（F5 §7.4 / F5-D2）。
    // F5-A/F5-D：这里同时是「唯一测量口径」的导出点 —— 三个入口（页面 ClinicalContext、
    // 多学派核心 SupervisionSyndicate、统一出口 AI.send）判定与遥测都只能读这一份，
    // 不得再各自抄一份长度算法。
    budgetGuard: {
      limitChars: MAX_TOTAL_INPUT_CHARS,
      errorCode: BUDGET_ERROR_CODE,
      transportCode: BUDGET_TRANSPORT_CODE,
      metric: BUDGET_METRIC,
      // 对外公布的「原始材料」等效上限（= 出站上限 / 实测扩写系数，向下取整）。
      rawMaterialBudgetChars: RAW_MATERIAL_BUDGET_CHARS,
      expansionFactor: SANITISATION_EXPANSION_FACTOR,
      measure: measureInputChars,
      // 两个视图：outboundChars 是判定用的权威口径；composedChars 只是「组装后」视图。
      outboundChars: measureInputChars,
      composedChars: measureComposedChars,
      projection: measureOutboundProjection,
      failure: inputBudgetFailure,
    },
    // DEC-02 对上层可见的降级面：页面与归档写入复用同一套字段名与同一句文案，
    // 全仓不得再各写一份「内置模型兜底」的判断逻辑（同 budgetGuard 的口径）。
    fallbackVisibility: {
      warningCode: FALLBACK_WARNING_CODE,
      transportState: FALLBACK_TRANSPORT_STATE,
      noticeText: fallbackNoticeText,
      provenance: fallbackProvenance,
      fields: degradationFields,
      // 兜底事件登记表（按 seq 区间关联）：count() 取当前水位，since(seq) 取增量事件。
      count: function () { return fallbackLedgerSeq; },
      list: function () { return fallbackLedger.slice(); },
      since: fallbackEventsSince,
      latest: function () { return fallbackLedger.length ? fallbackLedger[fallbackLedger.length - 1] : null; },
      limit: FALLBACK_LEDGER_LIMIT,
    },
  };
})();

if (typeof window !== 'undefined') {
  window.AI = AI;
  // 页面加载即拉取一次试用额度（用于 UI 显示剩余百分比）；失败静默（离线/代理不可达）
  if (AI.fetchQuota) { try { AI.fetchQuota(); } catch (e) {} }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeMessageSequence: AI.normalizeMessageSequence,
    classifyError: AI.classifyError,
    safeFailureResult: AI.safeFailureResult,
  };
}
