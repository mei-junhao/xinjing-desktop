/* XinJing multi-school supervision orchestration.
 * Pure core: no DOM, no storage mutation except the explicit archive call.
 */
(function (root, factory) {
  'use strict';
  var data = null;
  if (typeof module !== 'undefined' && module.exports) {
    try { data = require('./supervision-syndicate-data.js'); } catch (e) { data = null; }
    // node 侧（自测 / 契约测试）也必须走真实治理层：没有 window 时不能静默跳过登记
    // 与 guard 拼接，否则测试看到的是一条页面上不存在的文本。
    try { require('./prompt-governance.js'); } catch (e) { /* 浏览器侧由 <script> 链提供 */ }
  }
  data = data || {
    CARDS: root && root.SUPERVISION_SYNDICATE || [],
    SCHOOLS: root && root.SUPERVISION_SYNDICATE_SCHOOLS || [],
    getCard: root && root.getSupervisionSyndicateCard,
  };
  var api = factory(data, root);
  if (root) root.SupervisionSyndicate = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (data, root) {
  'use strict';

  var CARDS = Array.isArray(data.CARDS) ? data.CARDS : [];
  var SCHOOL_KEYS = Array.isArray(data.SCHOOLS) ? data.SCHOOLS.slice() : [];
  var CARD_BY_KEY = Object.create(null);
  CARDS.forEach(function (card) { if (card && card.key) CARD_BY_KEY[card.key] = card; });

  var MAX_INPUT_CHARS = 240000; // Core ceiling; page admission may be stricter.
  var MAX_STAGE_INPUT_CHARS = 30000; // system + user; reject rather than silently truncate.
  var MAX_STAGE_MS = 120000;
  var SUMMARY_THRESHOLD = 4000;
  /* ---------- F5-B（2026-09-24 产品负责人裁决①）：两处阶段材料 clip 压低 ----------
   * 缺陷原状：分段摘要拼接上限 clip(summary, 24000) + 学派阶段材料节选
   * clip(material, 16000) = 40,000+ > MAX_STAGE_INPUT_CHARS = 30000 ⇒ **产品自己允许的
   * 合法状态**（页面准入 24,000 字符的材料 + 契约内 4000 token 的摘要）可以被自己的阶段
   * 闸门硬拒（reviews-r1c §6.2：可行摘要上界实测只有 ≈13,570 字符）。
   * 裁决①：压低这两处 clip，使组合后的阶段 prompt 必然 ≤ 30000；不放宽 30000 闸门，
   * 也不许「超限后再静默截一刀」。
   * 取值理由（两条不等式，常数与开销全部由真实 builder 实测，见
   * scripts/f5-budget-consistency.test.cjs C2-*；开销实测件
   * logs/f5-consistency/measure-01.json）：
   *   组装后口径（判定口径，DEC-01 冻结）：
   *     8001 (摘要) + 10001 (材料节选) + 2554 (最坏固定开销=综合阶段模板 724 + 三派回传
   *     3×(600+10)) = 20556 <= 30000                      —— 余量 9444 (31%)
   *   出站口径（真实发往供应商的字节，实测 realistic 语料扩写 ×1.3766）：
   *     (8001 + 10001 + 1830) × 1.3766 + 724 = 28026 <= 30000   —— 余量 1974 (6.6%)
   * ⇒ 学派/路由/综合三个由本模块常数控制的阶段，其真实出站也不再超过自己声明的阶段预算
   *   （复审 F5-C 实测的「判 28,417 / 实发 34,468」差额被消除）。
   * 分段摘要阶段的 21,000 字符窗口（MAX_SEGMENT_CHARS）不在本次裁决范围内：它由 DEC-01 的
   * 段窗规划冻结（scripts/f5-syndicate-governance.test.cjs B15 把 30000-21000-226-68=8706
   * 钉成断言），且再压低会丢材料覆盖（B4）；它在 realistic 密度下出站 21000×1.3766+377=
   * 29286 <= 30000，更高密度时由总闸 240,000（脱敏后判定）封顶，见 §F5-C 注释。
   */
  var MAX_STAGE_SUMMARY_CHARS = 8000;   // 裁决①：原 24000
  var MAX_STAGE_MATERIAL_CHARS = 10000; // 裁决①：原学派 16000 / 路由与综合 12000（统一）
  /* 单次（非分段）摘要不另加 clip：它被出口 max_tokens=4000 的契约封顶，按产品自己的
   * token 口径（tokens = ceil(chars/4)，clinical-context.js 与 usageFromTelemetry 同一份）
   * 最坏 16,000 字符，而 16000 + 10001 + 2554 = 28555 <= 30000 ⇒ 契约内不可能越阶段预算；
   * 违反契约的回包（复审 F7 S3-e / 本仓 B13 的替身形状）仍由阶段闸门硬拒、不截断。 */
  var STAGE_TOKEN_CHAR_RATIO = 4; // 产品自身 token 口径：tokens = ceil(chars / 4)
  var MAX_STAGE_OUTPUT_TOKENS = 4000; // 出口 body.max_tokens（app/js/ai.js callDirect）
  /* ---------- F5-C：长度测量只有一个来源 ----------
   * 阶段预算的量纲是「组装后的完整提示词字符数」（脱敏前）。这个量纲必须写出来，
   * 因为同一个数在出口侧另有一层（总闸 240,000 量的是脱敏后的出站字符数），
   * 复审 F5-C 扣的就是「声明与判定不报口径」。判定继续用组装后口径的原因见
   * measureStagePrompt 上方注释。真实出站字符数用**同一个权威度量**（AI.budgetGuard）
   * 一并量出来，随错误对象回报 ⇒ 上层与遥测读到的是同一个数，不再各抄一份算法。
   */
  var STAGE_INPUT_METRIC = 'composed-prompt-chars';
  /* DEC-01 (2026-09-24): the segmentation trigger must live *inside* the page
   * admission budget (ClinicalContext 'supervision-multi-school' = 24000 chars
   * including the system/instruction overhead, i.e. ~23940 chars of material),
   * otherwise "segmented summary + failed segment ids" is unreachable from the
   * real page. 8000 = 2 * SUMMARY_THRESHOLD, which also keeps the single-call
   * band (4000..8000) byte-identical to the previous behaviour.
   * MAX_SEGMENT_CHARS = 70% of MAX_STAGE_INPUT_CHARS: the shipped summarizer
   * template plus the per-segment instruction costs 294 chars, so the largest
   * window stays 8906 chars (29%) below the - untouched - 30000 stage budget.
   */
  var SUMMARY_SEGMENT_THRESHOLD = 2 * SUMMARY_THRESHOLD; // 8000 < 24000 page admission
  var MAX_SEGMENT_CHARS = 21000;
  var SEGMENT_OVERLAP_CHARS = 800; // continuity window, unchanged from before
  var MAX_SCHOOLS = 3;
  var MAX_SCHOOL_ANALYSIS_CHARS = 600;
  var MAX_RETRIES = 2;

  var SCHOOL_ALIASES = {
    '温尼科特': 'sup-winnicott', 'winnicott': 'sup-winnicott',
    '弗洛伊德': 'sup-freud', 'freud': 'sup-freud',
    '克莱因': 'sup-klein', 'klein': 'sup-klein',
    '比昂': 'sup-bion', 'bion': 'sup-bion',
    '荣格': 'sup-jung', 'jung': 'sup-jung',
    '科胡特': 'sup-kohut', 'kohut': 'sup-kohut',
    '费伦齐': 'sup-ferenczi', 'ferenczi': 'sup-ferenczi',
  };

  function cardFor(key) {
    var direct = CARD_BY_KEY[String(key || '').trim()];
    if (direct) return direct;
    var alias = SCHOOL_ALIASES[String(key || '').trim().toLowerCase()];
    return alias ? CARD_BY_KEY[alias] : null;
  }

  function text(value) { return String(value == null ? '' : value); }
  function clean(value) { return text(value).replace(/\r\n?/g, '\n').trim(); }
  function clip(value, limit) {
    var s = text(value);
    return s.length > limit ? s.slice(0, limit) + '…' : s;
  }
  /* 长度测量的唯一入口：本模块自己不再实现第二份口径。
   * 权威度量来自渲染进程唯一出口 app/js/ai.js :: AI.budgetGuard（同一条脱敏配方 +
   * 同一个出站字符数），页面入口 ClinicalContext 与主进程出口读的是同一份导出。
   * 出口模块不在（node 侧 stub provider 夹具、纯核心单测）时，交给这个 provider 的载荷
   * 就是组装后的提示词本身，所以 assembled 视图即出站视图，basis 里如实标注；
   * 这个降级只会「少拒」（不会产生误拒），网络侧仍由 ai.js 的最终判定 fail-closed。 */
  function budgetAuthority(options) {
    var explicit = options && options.budgetGuard;
    if (explicit && typeof explicit.outboundChars === 'function') return explicit;
    var ai = root && root.AI;
    if (ai && ai.budgetGuard && typeof ai.budgetGuard.outboundChars === 'function') return ai.budgetGuard;
    return null;
  }
  function measurePayload(messages, options) {
    var composed = 0;
    var i;
    for (i = 0; i < messages.length; i += 1) composed += text(messages[i] && messages[i].content).length;
    var authority = budgetAuthority(options);
    if (authority && typeof authority.composedChars === 'function') {
      var view = authority.composedChars(messages);
      if (Number.isFinite(view)) composed = view;
    }
    var outbound = composed;
    var basis = 'composed-prompt-chars(no-egress-module)';
    if (authority) {
      var projected = authority.outboundChars(messages);
      if (Number.isFinite(projected)) {
        outbound = projected;
        basis = text(authority.metric) || 'sanitised-outbound-chars';
      }
    }
    return { composedChars: composed, outboundChars: outbound, basis: basis };
  }
  function measureStagePrompt(prompt, options) {
    var measured = measurePayload([{ role: 'system', content: text(prompt && prompt.system) },
      { role: 'user', content: text(prompt && prompt.user) }], options);
    measured.limitChars = MAX_STAGE_INPUT_CHARS;
    return measured;
  }
  function now() { return new Date().toISOString(); }
  function archiveKeyFor(result) {
    if (typeof result.archiveKey === 'string' && result.archiveKey) return result.archiveKey;
    var cryptoApi = root && root.crypto;
    result.archiveKey = cryptoApi && typeof cryptoApi.randomUUID === 'function'
      ? cryptoApi.randomUUID() : 'draft-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    return result.archiveKey;
  }
  function elapsed(start) { return Math.max(0, Date.now() - start); }
  function safeNumber(value) { return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0; }
  function normalizeSchoolKeys(value) {
    var list = Array.isArray(value) ? value : (value == null || value === '' ? [] : String(value).split(/[,，、\s]+/));
    var out = [];
    list.forEach(function (item) {
      var key = cardFor(item);
      if (!key || key.role !== 'school' || out.indexOf(key.key) !== -1) return;
      if (out.length < MAX_SCHOOLS) out.push(key.key);
    });
    return out;
  }

  function parseObject(raw) {
    if (raw && typeof raw === 'object') return raw;
    var source = clean(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    if (!source) return null;
    var start = source.indexOf('{');
    var end = source.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(source.slice(start, end + 1)); } catch (e) { return null; }
  }

  function parseRouteResponse(raw) {
    var obj = parseObject(raw) || {};
    var rawSchools = obj.schools || obj.schoolKeys || obj.orientations || [];
    var schools = normalizeSchoolKeys(rawSchools);
    return {
      case_type: clean(obj.case_type || obj.caseType || '综合性督导'),
      schools: schools,
      focus: clean(obj.focus || ''),
      workflow: clean(obj.workflow || (schools.length > 1 ? 'focused' : 'comprehensive')) || 'focused',
      valid: !!(obj && schools.length),
    };
  }

  /* ---------- prompt governance wiring (D-5 / F7-P1-2 / F7-P0-1) ----------
   * Each stage registers the *exact* system text it is about to send, at the site
   * where the template identity is still known (the builder), never inside
   * invokeCard, and always before the per-stage budget check so the manifest covers
   * the prompt that would actually go out.
   *
   * 5.1.19 F7-P1-2 是**行为变更**：摘要 / 路由 / 综合三个阶段此前只登记、不拼
   * appendFactAndSourceGuard，于是真实送出的 5 条 system 里有 3 条缺事实与来源边界，
   * 而被归档的那段正文正是综合阶段的输出。现在这三个阶段登记与发送同一条
   * 「模板 + guard」文本（manifest 覆盖的就是实际发出去的那条），并按新语义升版
   * （4.4.0 → 4.5.0）写真实 changeLog —— 版本号是声明出来的，不再由内容哈希派生
   * （F7-P0-1：派生会让「同版本改文本」的拒绝判据结构性永不触发）。
   * 学派阶段的 guard 由 buildSchoolPrompt 统一追加（幂等），因此 MastersCore 在场
   * 与不在场两条分支都不会漏边界。
   * The round-table branch (school stage) is already registered by
   * MastersCore.buildRoundSystemPrompt -> registerMasterPrompt as
   * `masters.system.<schoolKey>`; 页面未加载 masters-core.js 时（app/supervision.html
   * 的脚本链里没有它，这是主路径不是兜底）由 roundSystem 以**逐字相同的 id / 版本核 /
   * 模板原文**补登记，绝不重复登记成第二条不同内容。
   */
  var PROMPT_TASK = 'supervision-multi-school';
  var PROMPT_MODEL = 'chat-completions-compatible';
  var PROMPT_AUTHOR = 'XinJing multi-school pipeline';
  var PROMPT_SOURCE = 'app/js/supervision-syndicate-data.js';
  var PROMPT_FALLBACK_VERSION = '4.4.0';

  // F7-P0-1 / F7-P1-2：版本核由本模块显式声明，并与「实际发出的文本」同步升降。
  // 4.5.0 = 本轮把「事实与来源边界」段接到这三个阶段的 system 上（文本已变）。
  // 学派卡所在文件不在本轮写集内，卡片将来自己声明 promptVersion 时以卡片为准。
  var STAGE_PROMPT_VERSIONS = {
    'masters.system.sup-summarizer': '4.5.0',
    'masters.system.sup-lead': '4.5.0',
    'supervision.multi-school.synthesis.system': '4.5.0',
  };
  /* 综合阶段的文本是本模块合成的（主理人模板 + 阶段指令 + 边界段），没有任何一张卡声明它，
   * 所以由这里作为模板属主自声明版本并把该声明透传给治理层（ownTemplateVersion）。
   * 它取自 STAGE_PROMPT_VERSIONS —— 只有一份声明，改文本时两处同步升降，不允许漂移。
   */
  var SYNTHESIS_TEMPLATE_VERSION = STAGE_PROMPT_VERSIONS['supervision.multi-school.synthesis.system'];
  var GUARD_CHANGE_LOG = '4.5.0: 5.1.19 F7-P1-2 把「事实与来源边界」段接到本阶段发出的 system 上，'
    + '文本确实改变（模板 + 边界段），故升版并如实记录 —— 更早那条「登记但未改文本」的记录不成立。';
  var STAGE_PROMPT_CHANGE_LOGS = {
    'masters.system.sup-summarizer': [
      '4.4.0: 按发送点登记摘要师模板原文（D-5 接线）。',
      GUARD_CHANGE_LOG,
    ],
    'masters.system.sup-lead': [
      '4.4.0: 按发送点登记主理人路由模板原文（D-5 接线）。',
      GUARD_CHANGE_LOG,
    ],
    'supervision.multi-school.synthesis.system': [
      '4.4.0: 登记综合阶段模板（主理人模板 + 综合指令）。',
      GUARD_CHANGE_LOG + ' 这段输出正是被归档的综合督导，边界缺失时归档记录里就没有任何来源约束。',
    ],
    // 学派阶段登记的仍是**模板原文**（与 MastersCore.registerMasterPrompt 逐字一致），
    // 文本未变，所以版本核保持 4.4.0；guard 在发出的文本上追加，不进这条登记内容。
    'school-template': [
      '4.4.0: 学派卡模板原文；页面未加载 masters-core.js 时由本模块按 MastersCore 同源约定登记。',
    ],
  };

  /* F7-P1-2：事实与来源边界段。治理层在场时一律用它的 appendFactAndSourceGuard
   * （幂等、恒在风格段之后）；只有 prompt-governance.js 完全缺席的宿主才走下面的
   * 兜底常量，由 scripts/f7-governance-semantics.test.cjs 断言两者字节相同以防漂移。
   */
  var FACT_AND_SOURCE_GUARD_FALLBACK = [
    '[事实与来源边界 - 高于表达风格]',
    '只把已提供且可追溯的材料当作事实。资料库、内置知识和既往对话只是带标签的参考来源。',
    '写作风格只能改变表达方式，不能补写事实、弱化来源要求、改变确认边界，或把相关性说成因果。',
  ].join('\n');

  function governanceApi() {
    if (root && root.PromptGovernance && typeof root.PromptGovernance.registerPrompt === 'function') return root.PromptGovernance;
    if (typeof PromptGovernance !== 'undefined' && PromptGovernance && typeof PromptGovernance.registerPrompt === 'function') return PromptGovernance;
    return null;
  }

  function appendFactAndSourceGuard(value) {
    var governance = governanceApi();
    if (governance && typeof governance.appendFactAndSourceGuard === 'function') return governance.appendFactAndSourceGuard(value);
    var base = clean(value);
    if (!base) return FACT_AND_SOURCE_GUARD_FALLBACK;
    return base.indexOf(FACT_AND_SOURCE_GUARD_FALLBACK) >= 0 ? base : base + '\n\n' + FACT_AND_SOURCE_GUARD_FALLBACK;
  }

  function messageOf(error) { return error && error.message ? String(error.message) : String(error); }

  // 治理层的「同版本内容变更」拒绝与其它实现异常必须区分对待：前者绝不能被吞掉后
  // 换一条未登记文本继续发（F7-P2-1③），后者才允许回退到本地确定性文本。
  function isGovernanceRejection(error) {
    var governance = governanceApi();
    if (governance && typeof governance.isRegistrationRejection === 'function') return !!governance.isRegistrationRejection(error);
    return messageOf(error).indexOf('Prompt governance rejected') === 0;
  }

  // Returns '' on success, or the rejection message. registerPrompt throws
  // synchronously on a same-version content change, so a rejection is carried on the
  // prompt and stops the stage from being sent at all; it is never swallowed while
  // the old text keeps going to the provider.
  function registerStagePrompt(entry) {
    var governance = governanceApi();
    if (!governance) return '';
    try {
      governance.registerPrompt(entry);
      return '';
    } catch (error) {
      return error && error.message ? String(error.message) : String(error);
    }
  }

  function templateVersion(card, entryId) {
    return String((card && card.promptVersion) || STAGE_PROMPT_VERSIONS[entryId] || PROMPT_FALLBACK_VERSION);
  }

  function stageChangeLog(entryId) {
    var log = STAGE_PROMPT_CHANGE_LOGS[entryId];
    return Array.isArray(log) ? log.slice() : [];
  }

  function segmentPlan(length) {
    // ceil(n / ceil(n / k)) === k, so `count` windows are produced for every length
    // and the adaptive window can never exceed MAX_SEGMENT_CHARS.
    var count = Math.max(2, Math.ceil(length / (MAX_SEGMENT_CHARS - SEGMENT_OVERLAP_CHARS)));
    var stride = Math.ceil(length / count);
    return { count: count, stride: stride, window: stride + SEGMENT_OVERLAP_CHARS };
  }

  function buildSummaryPrompt(material) {
    var card = cardFor('sup-summarizer');
    var prompt = {
      // F7-P1-2：登记与发送用的是**同一条**已拼 guard 的 system，所以 manifest 覆盖
      // 的就是实际会发出去的那条（模板可反查：治理层按「文本包含模板原文」判定同源）。
      system: appendFactAndSourceGuard(card ? card.systemPrompt : '请将长篇临床逐字稿压缩为可供督导使用的四节结构化摘要。'),
      user: '请摘要以下临床材料。保留时间线和原话线索，只输出四节结构化摘要，不做诊断。\n\n【材料】\n' + clip(material, MAX_INPUT_CHARS),
    };
    var rejected = registerStagePrompt({
      id: 'masters.system.sup-summarizer',
      version: templateVersion(card, 'masters.system.sup-summarizer'),
      task: PROMPT_TASK,
      model: PROMPT_MODEL,
      author: PROMPT_AUTHOR,
      source: PROMPT_SOURCE,
      changeLog: stageChangeLog('masters.system.sup-summarizer'),
      content: prompt.system,
    });
    if (rejected) prompt.governanceError = rejected;
    return prompt;
  }

  function buildSegmentSummaryPrompt(segment, index, total) {
    var prompt = buildSummaryPrompt(segment);
    prompt.user = '请摘要以下临床材料分段（第 ' + index + ' / ' + total + ' 段）。保留时间线、关键原话与人物关系线索，只输出四节结构化摘要，不做诊断。\n\n【材料分段】\n' + segment;
    return prompt;
  }

  function validPrompt(prompt) {
    return prompt && typeof prompt.system === 'string' && !!prompt.system.trim()
      && typeof prompt.user === 'string' && !!prompt.user.trim();
  }
  function abortResult() { return { error: '本次分析已取消', errorCode: 'ABORTED' }; }
  function stageSignal(options) { return options && (options.signal || options.transportOptions && options.transportOptions.signal); }
  function stageFailure(options) {
    var signal = stageSignal(options);
    return signal && signal.aborted ? abortResult() : null;
  }
  function stageLimit(options) {
    var ms = options && options.stageTimeoutMs;
    return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_STAGE_MS) : MAX_STAGE_MS;
  }

  function buildLeadPrompt(material, summary) {
    var card = cardFor('sup-lead');
    var context = summary ? '【结构化摘要】\n' + summary + '\n\n【材料节选】\n' + clip(material, MAX_STAGE_MATERIAL_CHARS) : '【临床材料】\n' + clip(material, MAX_INPUT_CHARS);
    var prompt = {
      // F7-P1-2：路由阶段的 system 同样必须带事实与来源边界（此前只登记不拼 guard）。
      // 卡片存在却缺失 systemPrompt 时必须拒发；事实边界尾段不能把空模板伪装成有效提示词。
      system: card && clean(card.systemPrompt) ? appendFactAndSourceGuard(card.systemPrompt) : '',
      user: context + '\n\n请判断案例类型并输出路由 JSON。',
    };
    var rejected = registerStagePrompt({
      id: 'masters.system.sup-lead',
      version: templateVersion(card, 'masters.system.sup-lead'),
      task: PROMPT_TASK,
      model: PROMPT_MODEL,
      author: PROMPT_AUTHOR,
      source: PROMPT_SOURCE,
      changeLog: stageChangeLog('masters.system.sup-lead'),
      content: prompt.system,
    });
    if (rejected) prompt.governanceError = rejected;
    return prompt;
  }

  function roundSystem(card, activeNames, options) {
    var mastersCore = options && options.mastersCore;
    if (!mastersCore && root && root.MastersCore) mastersCore = root.MastersCore;
    if (mastersCore && typeof mastersCore.buildRoundSystemPrompt === 'function') {
      try {
        // P1-3：圆桌 callsite 显式携带温度通道（缺省交由内核安全回退）。
        // P2-4：学派卡（sup-*）本身不在内置大师知识库 RAW 中，故其知识分支按设计为空
        //       —— 本入口不伪造知识；卡片自带督导 systemPrompt。若日后接线学派知识，
        //       由内核按实际槽位溯源头判定（不为空则必须对得上）。
        var prefs = { includeUserDocs: false };
        if (options && options.temperature != null) prefs.temperature = options.temperature;
        return { system: mastersCore.buildRoundSystemPrompt(card, activeNames, false, prefs), governanceError: '' };
      } catch (e) {
        // F7-P2-1③（本文件 :136-138 注释要求的 fail-closed）：治理层抛出的是「同版本
        // 内容变更」拒绝时，绝不能吞掉异常改用未登记、不带 guard 的本地文本继续发 ——
        // 那等于让被拒的那条文本从另一个出口绕过治理。只有与登记无关的实现异常
        // （例如宿主 Knowledge 层抛错）才回退到本地确定性文本。
        if (isGovernanceRejection(e)) return { system: '', governanceError: messageOf(e) };
      }
    }
    // 真实督导页不加载 masters-core.js（app/supervision.html 的脚本链里没有它），所以
    // 这条分支在生产里是主路径。此前它既不登记也不带 guard；现在按 MastersCore 的
    // 同源约定登记**卡片模板原文**（id / 版本核 / content 与 registerMasterPrompt 逐字
    // 一致，避免同 id 登记出两种内容），guard 只追加在发出的文本上。
    var rejected = registerStagePrompt({
      id: 'masters.system.' + card.key,
      version: templateVersion(card),
      task: 'ai-masters',
      model: PROMPT_MODEL,
      author: 'XinJing master library',
      source: PROMPT_SOURCE,
      changeLog: stageChangeLog('school-template'),
      content: card.systemPrompt,
    });
    return { system: card.systemPrompt + '\n\n你是独立发言的督导师，只能依据提供的材料，不假定知道其他学派观点。', governanceError: rejected };
  }

  function buildSchoolPrompt(card, material, summary, activeNames, options) {
    var context = summary ? '【历史结构化摘要】\n' + summary + '\n\n【当前材料】\n' + clip(material, MAX_STAGE_MATERIAL_CHARS) : '【临床材料】\n' + clip(material, MAX_INPUT_CHARS);
    var composed = roundSystem(card, activeNames, options || {});
    var prompt = {
      // F7-P1-2：两条分支（内核在场 / 本地确定性文本）都必须带来源边界；
      // appendFactAndSourceGuard 幂等，内核已拼过时不会重复。
      system: composed.system ? appendFactAndSourceGuard(composed.system) : composed.system,
      user: context + '\n\n请从你的学派督导视角分析，控制在' + MAX_SCHOOL_ANALYSIS_CHARS + '字以内，明确材料证据、判断、不确定处和可执行建议。',
    };
    if (composed.governanceError) prompt.governanceError = composed.governanceError;
    return prompt;
  }

  function buildSynthesisPrompt(material, summary, route, analyses) {
    var rows = analyses.map(function (item) {
      var name = item.name || item.key;
      return '【' + name + '】' + (item.status === 'absent' ? '（缺席：' + item.error + '）' : '\n' + item.content);
    }).join('\n\n');
    var lead = cardFor('sup-lead');
    var prompt = {
      // F7-P1-2：综合阶段的输出正是被归档的那段正文，来源边界必须出现在它上面。
      system: appendFactAndSourceGuard((lead ? lead.systemPrompt : '') + '\n\n你现在执行综合阶段。只根据材料和各学派回传，不补写缺席学派的观点。'),
      user: '案例类型：' + (route.case_type || '综合性督导') + '\n关注点：' + (route.focus || '未指定') + '\n' +
        (summary ? '摘要：\n' + summary + '\n' : '') +
        '材料节选：\n' + clip(material, MAX_STAGE_MATERIAL_CHARS) + '\n\n逐派回传：\n' + rows +
        '\n\n请输出三段式综合督导：\n【对比表】逐派核心判断及依据\n【分歧点】明确冲突、互补与缺席，不把缺席冒充结论\n【整合建议】给咨询师下一步可执行的探索与风险提醒。',
    };
    // templateKey is required: this stage rewrites the lead template, so without the
    // addressing hint governance could not map the stage text back to its template
    // (and the plain `masters.system.sup-lead` id would be overwritten by the route
    // version, making the two stages indistinguishable in the manifest).
    // ownTemplateVersion（5.1.19 对账轮 A6）：综合阶段的这条文本不属于任何一张卡 —— 它是
    // 「主理人模板 + 阶段指令 + 边界段」的合成物，本模块就是它的模板属主，所以版本由这里
    // 自声明。缺了它，条目会落进「version = 声明核 + sha256(内容)」的派生族，即 F7-P0-1
    // 判为 P0 的那个形态（版本成为内容的函数）。改这段文本必须同步升 SYNTHESIS_TEMPLATE_VERSION。
    var rejected = registerStagePrompt({
      id: 'supervision.multi-school.synthesis.system',
      templateKey: 'sup-lead',
      ownTemplateVersion: SYNTHESIS_TEMPLATE_VERSION,
      version: templateVersion(lead, 'supervision.multi-school.synthesis.system'),
      task: PROMPT_TASK,
      model: PROMPT_MODEL,
      author: PROMPT_AUTHOR,
      source: PROMPT_SOURCE,
      changeLog: stageChangeLog('supervision.multi-school.synthesis.system'),
      content: prompt.system,
    });
    if (rejected) prompt.governanceError = rejected;
    return prompt;
  }

  function callProvider(messages, stage, options, telemetry) {
    options = options || {};
    var provider = options.provider || options.ai || (root && root.AI);
    if (typeof provider === 'function') provider = { send: provider };
    if (!provider || typeof provider.send !== 'function') return Promise.resolve({ error: 'AI 模块未就绪', errorCode: 'AI_UNAVAILABLE' });
    var inputChars = messages.reduce(function (sum, item) { return sum + text(item && item.content).length; }, 0);
    var started = Date.now();
    telemetry.calls += 1;
    telemetry.inputChars += inputChars;
    telemetry.byStage[stage] = telemetry.byStage[stage] || { calls: 0, durationMs: 0, inputChars: 0, outputChars: 0 };
    telemetry.byStage[stage].calls += 1;
    telemetry.byStage[stage].inputChars += inputChars;
    var transportOptions = Object.assign({}, options.transportOptions || {});
    var parentSignal = stageSignal(options);
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) transportOptions.signal = controller.signal;
    return new Promise(function (resolve) {
      var settled = false;
      var timer = null;
      function cancelTransport() { if (controller) controller.abort(); }
      function finish(result) {
        if (settled) return;
        settled = true;
        if (timer != null) clearTimeout(timer);
        if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
        var failure = stageFailure(options);
        if (failure) result = failure;
        if (result && result.errorCode === 'STAGE_TIMEOUT') cancelTransport();
        var normalized = result && typeof result === 'object' ? result : { content: result };
        var output = clean(normalized.content);
        telemetry.outputChars += output.length;
        telemetry.byStage[stage].outputChars += output.length;
        telemetry.byStage[stage].durationMs += elapsed(started);
        if (!output && !normalized.error) normalized = Object.assign({}, normalized, { error: 'AI 返回为空', errorCode: 'EMPTY_RESPONSE' });
        resolve(normalized);
      }
      function onAbort() { cancelTransport(); finish(abortResult()); }
      transportOptions.onDelta = function (piece, fullText) {
        if (!settled && !stageFailure(options) && typeof options.onDelta === 'function') options.onDelta(piece, fullText, stage);
      };
      if (parentSignal) {
        if (parentSignal.aborted) { onAbort(); return; }
        parentSignal.addEventListener('abort', onAbort, { once: true });
      }
      timer = setTimeout(function () { finish({ error: '本阶段分析超时，请重试', errorCode: 'STAGE_TIMEOUT' }); }, stageLimit(options));
      try {
        var returned = provider.send(messages, finish, transportOptions);
        if (returned && typeof returned.then === 'function') returned.then(finish, function (error) { finish({ error: error && error.message || String(error), errorCode: 'PROVIDER_REJECTED' }); });
        else if (returned && typeof returned === 'object' && (returned.content != null || returned.error)) finish(returned);
      } catch (error) {
        finish({ error: error && error.message || String(error), errorCode: 'PROVIDER_THROWN' });
      }
    });
  }

  function invokeCard(card, prompt, stage, options, telemetry) {
    options = options || {};
    if (stageFailure(options)) return Promise.resolve(abortResult());
    // Fail closed on a governance rejection: the text the governance layer refused
    // must not be sent to the provider.
    if (prompt && prompt.governanceError) {
      return Promise.resolve({ error: '提示词未通过治理登记，已停止发送：' + prompt.governanceError, errorCode: 'PROMPT_GOVERNANCE_REJECTED' });
    }
    if (!validPrompt(prompt)) return Promise.resolve({ error: '提示词结构无效', errorCode: 'INVALID_PROMPT' });
    /* 阶段闸门（F5-B / F5-C）：
     * - 判定口径与量纲写死成「组装后的完整提示词字符数」（STAGE_INPUT_METRIC），
     *   上限 30000 一字未放宽（DEC-01）。不改成出站口径的原因：21,000 字符的分段窗口是
     *   DEC-01 冻结的规划常数，改用出站口径后它在实测中密度语料（×1.93）上会**反过来
     *   误拒页面合法材料**，正是 F5-B 那一类缺陷；
     * - 同一次判定顺带用**同一个权威度量**量出该阶段真实出站字符数并随错误对象回报，
     *   所以「判 28,417、实发 34,468」那种「自己声明的量不封顶实际」既被写明、也被本模块
     *   的常数排除（裁决①压低两处 clip 后，三个受控阶段实测出站 ≤ 30000）；
     * - 超限只拒不断，truncated:false 显式声明。 */
    var stageInput = measureStagePrompt(prompt, options);
    if (stageInput.composedChars > MAX_STAGE_INPUT_CHARS) return Promise.resolve({
      error: '当前阶段组装后提示词 ' + stageInput.composedChars + ' 字符 > 阶段预算 '
        + MAX_STAGE_INPUT_CHARS + ' 字符（量纲=' + STAGE_INPUT_METRIC + '，即脱敏前组装后的 system+user；'
        + '本阶段脱敏后实际出站 ' + stageInput.outboundChars + ' 字符，口径=' + stageInput.basis + '，'
        + '网络侧另由总闸 240000 脱敏后字符数封顶）。已停止发送且未截断任何内容，请缩短材料后重试',
      errorCode: 'STAGE_BUDGET_EXCEEDED',
      stageChars: stageInput.composedChars,
      outboundChars: stageInput.outboundChars,
      measureBasis: stageInput.basis,
      metric: STAGE_INPUT_METRIC,
      limitChars: MAX_STAGE_INPUT_CHARS,
      truncated: false,
    });
    var customProvider = options.provider || options.ai;
    var mastersCore = options.mastersCore || (root && root.MastersCore);
    if (!customProvider && mastersCore && typeof mastersCore.callMaster === 'function') {
      var conv = { messages: [], summary: '', importedContext: '' };
      return new Promise(function (resolve) {
        var started = Date.now();
        var settled = false;
        var timer = null;
        var parentSignal = stageSignal(options);
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        function finish(res) {
          if (settled) return;
          settled = true;
          if (timer != null) clearTimeout(timer);
          if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
          if (stageFailure(options)) res = abortResult();
          if (res && res.errorCode === 'STAGE_TIMEOUT' && controller) controller.abort();
          resolve(res);
        }
        function onAbort() { if (controller) controller.abort(); finish(abortResult()); }
        if (parentSignal) {
          if (parentSignal.aborted) { onAbort(); return; }
          parentSignal.addEventListener('abort', onAbort, { once: true });
        }
        timer = setTimeout(function () { finish({ error: '本阶段分析超时，请重试', errorCode: 'STAGE_TIMEOUT' }); }, stageLimit(options));
        telemetry.calls += 1;
        telemetry.inputChars += text(prompt.system).length + text(prompt.user).length;
        telemetry.byStage[stage] = telemetry.byStage[stage] || { calls: 0, durationMs: 0, inputChars: 0, outputChars: 0 };
        telemetry.byStage[stage].calls += 1;
        telemetry.byStage[stage].inputChars += text(prompt.system).length + text(prompt.user).length;
        try {
          Promise.resolve(mastersCore.callMaster(conv, card, prompt.user, { systemPrompt: prompt.system, includeUserDocs: false, signal: controller && controller.signal || parentSignal, onDelta: function (piece, fullText) {
            if (!settled && !stageFailure(options) && typeof options.onDelta === 'function') options.onDelta(piece, fullText, stage);
          } }))
            .then(function (res) {
              if (settled) return;
              var normalized = res && typeof res === 'object' ? res : { content: res };
              var output = clean(normalized.content);
              telemetry.outputChars += output.length;
              telemetry.byStage[stage].outputChars += output.length;
              telemetry.byStage[stage].durationMs += elapsed(started);
              if (!output && !normalized.error) normalized = Object.assign({}, normalized, { error: 'AI 返回为空', errorCode: 'EMPTY_RESPONSE' });
              finish(normalized);
            }, function (error) { finish({ error: error && error.message || String(error), errorCode: 'PROVIDER_REJECTED' }); });
        } catch (error) { finish({ error: error && error.message || String(error), errorCode: 'PROVIDER_THROWN' }); }
      });
    }
    return callProvider([{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], stage, options, telemetry);
  }

  async function withRetry(card, prompt, stage, options, telemetry) {
    var last = null;
    var attempts = 0;
    for (var attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      attempts = attempt;
      var result = await invokeCard(card, prompt, stage, options, telemetry);
      if (stageFailure(options)) return { ok: false, error: abortResult().error, errorCode: 'ABORTED', attempts: attempt };
      if (result && !result.error && clean(result.content)) return { ok: true, result: result, attempts: attempt };
      last = result || { error: 'AI 返回为空', errorCode: 'EMPTY_RESPONSE' };
      if (STAGE_FATAL_CODES.indexOf(last.errorCode) >= 0) break;
    }
    return { ok: false, error: clean(last && last.error) || 'AI 调用失败', errorCode: (last && last.errorCode) || 'AI_FAILED', attempts: attempts };
  }

  function emptyTelemetry() {
    return { calls: 0, inputChars: 0, outputChars: 0, byStage: Object.create(null) };
  }

  function usageFromTelemetry(telemetry) {
    var estimate = Math.ceil((telemetry.inputChars + telemetry.outputChars) / 4);
    return {
      calls: telemetry.calls,
      inputChars: telemetry.inputChars,
      outputChars: telemetry.outputChars,
      estimatedTokens: estimate,
      byStage: telemetry.byStage,
    };
  }

  function parseSynthesisSections(content) {
    var raw = clean(content);
    var result = { comparison: '', disagreements: '', recommendations: '' };
    var re = /【(对比表|分歧点|整合建议)】/g;
    var hits = [];
    var match;
    while ((match = re.exec(raw))) hits.push({ name: match[1], index: match.index, end: re.lastIndex });
    if (!hits.length) return { comparison: raw, disagreements: '', recommendations: '' };
    hits.forEach(function (hit, index) {
      var body = raw.slice(hit.end, index + 1 < hits.length ? hits[index + 1].index : raw.length).trim();
      if (hit.name === '对比表') result.comparison = body;
      else if (hit.name === '分歧点') result.disagreements = body;
      else result.recommendations = body;
    });
    return result;
  }

  function isHardStop(errorCode) {
    return ['ABORTED', 'STAGE_TIMEOUT', 'PROMPT_GOVERNANCE_REJECTED'].indexOf(errorCode) >= 0;
  }

  /* F1 §3.1-3 / §7.4 + D-1（真实 Electron 实测缺陷）：「结构性无效的提示词」不是一次可以
   * 靠重试或换派补救的模型故障 —— 同一条 prompt 再跑一百次也还是无效。改前它只在
   * analyses[].status='absent' 的自由文本里留了个痕迹，流水线照常综合、终态 ok=true /
   * errorCode=null，页面显示「综合完成，可归档」，稳定 errorCode 在页面上彻底消失。
   * 这类码必须一路带到终态（带阶段与学派名 = 有信息），不得被折算成「缺席 + 成功」。
   * 注意与 isHardStop 的分工：治理层拒绝/取消/超时是整单立刻停止；提示词无效则保留
   * 「另一派正常」这一局部事实 —— 各派如实留档、综合仍产出并随终态带回，只是整单不再报成功。
   */
  var FATAL_PROMPT_CODES = ['INVALID_PROMPT'];
  function isFatalPromptFault(errorCode) {
    return FATAL_PROMPT_CODES.indexOf(errorCode) >= 0;
  }
  // 致命阶段码：必须原样带进终态 errorCode，不得被压成 LEAD_ROUTE_FAILED / LEAD_SYNTHESIS_FAILED
  // 这类「谁失败了都同一个码」的泛化码（那等于丢掉可辨认性）。
  var STAGE_FATAL_CODES = ['STAGE_BUDGET_EXCEEDED', 'ABORTED', 'STAGE_TIMEOUT', 'PROMPT_GOVERNANCE_REJECTED', 'INVALID_PROMPT'];
  function stageFatalCode(errorCode, fallback) {
    return STAGE_FATAL_CODES.indexOf(errorCode) >= 0 ? errorCode : fallback;
  }

  async function preprocess(material, options, telemetry) {
    var source = clean(material).slice(0, MAX_INPUT_CHARS);
    if (source.length <= SUMMARY_THRESHOLD) return { source: source, used: source, summarized: false, summary: '', summaryError: '' };
    var card = cardFor('sup-summarizer');
    // Large accepted material is segmented, but failed summaries stop the pipeline.
    // A separate per-stage budget guards the complete system + user prompt.
    // DEC-01: the trigger sits inside the page admission budget (24000 chars) so a
    // page-typical long transcript really takes this branch.
    if (source.length > SUMMARY_SEGMENT_THRESHOLD) {
      var segments = [];
      var failedSegments = [];
      var SEG = segmentPlan(source.length).window;
      for (var pos = 0; pos < source.length; pos += (SEG - SEGMENT_OVERLAP_CHARS)) {
        segments.push(source.slice(pos, pos + SEG));
      }
      var parts = [];
      var segError = '';
      for (var si = 0; si < segments.length; si += 1) {
        if (stageFailure(options)) return { errorCode: 'ABORTED', error: abortResult().error };
        var segPrompt = buildSegmentSummaryPrompt(segments[si], si + 1, segments.length);
        var segResult = await withRetry(card, segPrompt, 'summary:seg' + (si + 1), options, telemetry);
        if (isHardStop(segResult.errorCode)) return { errorCode: segResult.errorCode, error: segResult.error };
        if (segResult.ok) {
          parts.push('【第' + (si + 1) + '段摘要】\n' + clean(segResult.result.content));
        } else {
          segError = segResult.error || segError;
          failedSegments.push(si + 1);
          parts.push('【第' + (si + 1) + '段原文节选】\n' + segments[si].slice(0, 6000));
        }
      }
      var summary = parts.join('\n\n');
      // 2026-09-13 审查加固：分段摘要拼接后统一裁剪，避免全段失败 fallback（每段 6000
      // 原文节选）时 summary 过长（可达数万字符）导致后续路由/逐派/综合 stage 超限。
      // 2026-09-24 裁决①（F5-B）：这里必须与学派阶段的材料节选**互相自洽** ——
      // MAX_STAGE_SUMMARY_CHARS + MAX_STAGE_MATERIAL_CHARS + 实测最坏固定开销
      // (2554) = 20556 <= MAX_STAGE_INPUT_CHARS (30000)，所以本模块自己允许的摘要长度
      // 区间里不再存在「自己的阶段闸门必拒」那一段（原 24000 + 16000 = 40000+ 时存在）。
      // 裁剪带 '…' 可视标记，且只在分段路径发生（单次摘要受出口 max_tokens 契约封顶）。
      summary = clip(summary, MAX_STAGE_SUMMARY_CHARS);
      return { source: source, used: summary, summarized: true, summary: summary, summaryError: segError || '', failedSegments: failedSegments, totalSegments: segments.length };
    }
    var prompt = buildSummaryPrompt(source);
    var result = await withRetry(card, prompt, 'summary', options, telemetry);
    if (isHardStop(result.errorCode)) return { errorCode: result.errorCode, error: result.error };
    if (result.ok) {
      var summary = clean(result.result.content);
      return { source: source, used: summary, summarized: true, summary: summary, summaryError: '' };
    }
    return { source: source, used: source, summarized: false, summary: '', summaryError: result.error, failedSegments: [1], totalSegments: 1 };
  }

  async function resolveRoute(material, summary, selectedSchools, options, telemetry) {
    if (selectedSchools != null) {
      var manual = normalizeSchoolKeys(selectedSchools);
      // 空选择表示“跟随主理人路由”；只有包含无效值但没有任何有效学派时才拒绝。
      var supplied = Array.isArray(selectedSchools) ? selectedSchools : String(selectedSchools || '').split(/[,，、\s]+/).filter(Boolean);
      if (!manual.length && supplied.length) return { ok: false, error: '未选择有效学派', errorCode: 'INVALID_SCHOOL_SELECTION' };
      if (manual.length) return { ok: true, route: { case_type: '手动指定', schools: manual, focus: '按用户指定学派比较', workflow: 'focused' }, attempts: 0 };
    }
    var lead = cardFor('sup-lead');
    var result = await withRetry(lead, buildLeadPrompt(material, summary), 'route', options, telemetry);
    if (!result.ok) return { ok: false, error: result.error, errorCode: stageFatalCode(result.errorCode, 'LEAD_ROUTE_FAILED'), attempts: result.attempts };
    if (stageFailure(options)) return { ok: false, errorCode: 'ABORTED', error: abortResult().error, attempts: result.attempts };
    var route = parseRouteResponse(result.result.content);
    if (!route.valid) return { ok: false, error: '主理人路由未返回有效学派', errorCode: 'LEAD_ROUTE_INVALID', attempts: result.attempts };
    return { ok: true, route: route, attempts: result.attempts };
  }

  async function runMultiSchoolSupervision(input, maybeOptions) {
    var request = typeof input === 'string' ? { material: input } : (input || {});
    var options = Object.assign({}, maybeOptions || {}, request.options || {});
    if (typeof options.onProgress !== 'function' && typeof request.onProgress === 'function') options.onProgress = request.onProgress;
    if (typeof options.onDelta !== 'function' && typeof request.onDelta === 'function') options.onDelta = request.onDelta;
    if (maybeOptions && maybeOptions.requireArchive === true) {
      options.autoSave = true;
      options.requireArchive = true;
    }
    var material = request.material != null ? request.material : (request.context != null ? request.context : request.transcript);
    var telemetry = emptyTelemetry();
    var started = Date.now();
    var onProgress = typeof options.onProgress === 'function' ? options.onProgress : function () {};
    function progress(event) { try { onProgress(Object.assign({ mode: 'multi-school' }, event || {})); } catch (e) {} }
    if (stageFailure(options)) return { ok: false, mode: 'multi-school', stage: 'preprocess', errorCode: 'ABORTED', error: abortResult().error, usage: usageFromTelemetry(telemetry) };
    if (!clean(material)) return { ok: false, mode: 'multi-school', stage: 'preprocess', errorCode: 'MATERIAL_REQUIRED', error: '请提供临床材料', usage: usageFromTelemetry(telemetry) };
    /* 核心入口的材料准入（F5-D：与页面入口、统一出口同一份测量、同一张码表、同一拒绝时机）：
     * 度量来自 AI.budgetGuard（没有第二份长度算法），码表来自同一处（MATERIAL_TOO_LONG），
     * 拒绝发生在任何一次出网之前。量纲在文案里写明：本闸是「原始材料字符数」上限，
     * 与出口那道「脱敏后出站字符数」上限 240,000 不是同一个量纲（F5-A 的缺陷正是这两个
     * 量纲共用一个公布值却互不声明），所以这里不再宣称「能送 240,000 字符到模型」。 */
    var materialAdmission = measurePayload([{ role: 'user', content: clean(material) }], options);
    if (materialAdmission.composedChars > MAX_INPUT_CHARS) return { ok: false, mode: 'multi-school', stage: 'preprocess', errorCode: 'MATERIAL_TOO_LONG', error: '临床材料 ' + materialAdmission.composedChars + ' 字符 > 核心材料上限 ' + MAX_INPUT_CHARS + ' 字符（量纲=原始材料字符数；单次请求另有出口总闸按脱敏后出站字符数封顶）。已拒绝且未截断任何内容，请缩短后重试', materialChars: materialAdmission.composedChars, limitChars: MAX_INPUT_CHARS, metric: 'raw-material-chars', truncated: false, usage: usageFromTelemetry(telemetry) };

    var prepared = await preprocess(material, options, telemetry);
    if (prepared.errorCode || stageFailure(options)) return { ok: false, mode: 'multi-school', stage: 'preprocess', errorCode: prepared.errorCode || 'ABORTED', error: prepared.error || abortResult().error, usage: usageFromTelemetry(telemetry), elapsedMs: elapsed(started) };
    // F1 §3.4 / D-2（真实 Electron 实测缺陷）：失败段号必须先随 progress 事件发出去，再短路返回。
    // 页面唯一的「材料摘要不完整：第 N 段未成功」提示读的就是这条 summary 进度事件；
    // 早退在前会让这条通路在失败路径上永远不可达（改前实测 progressTypes=[]）。
    // 顺序调整不改变短路本身：下一条 return 仍在任何 route/school/synthesis 出网之前。
    progress({ type: prepared.summarized ? 'summary' : 'preprocess', summarized: prepared.summarized, summaryError: prepared.summaryError, failedSegments: prepared.failedSegments || [], totalSegments: prepared.totalSegments || 0 });
    if ((prepared.failedSegments || []).length) {
      return { ok: false, mode: 'multi-school', stage: 'preprocess', errorCode: 'PARTIAL_SUMMARY', error: '第 ' + prepared.failedSegments.join('、') + ' 段摘要失败，已停止分析以避免遗漏材料；请重试', failedSegments: prepared.failedSegments, totalSegments: prepared.totalSegments, summary: prepared.summary, usage: usageFromTelemetry(telemetry), elapsedMs: elapsed(started) };
    }
    var selected = request.schools != null ? request.schools : (request.schoolKeys != null ? request.schoolKeys : options.schools);
    var routing = await resolveRoute(prepared.source, prepared.summary, selected, options, telemetry);
    if (!routing.ok) {
      return { ok: false, mode: 'multi-school', stage: 'route', errorCode: routing.errorCode, error: routing.error, attempts: routing.attempts || 0, summary: prepared.summary, summarized: prepared.summarized, usage: usageFromTelemetry(telemetry), elapsedMs: elapsed(started) };
    }

    var route = routing.route;
    var schoolKeys = normalizeSchoolKeys(route.schools);
    progress({ type: 'route', schoolKeys: schoolKeys.slice(), caseType: route.case_type, focus: route.focus });
    var activeNames = schoolKeys.map(function (key) { return cardFor(key).name; }).join('、');
    var analyses = [];
    var fatalPromptFault = null;
    for (var i = 0; i < schoolKeys.length; i += 1) {
      if (stageFailure(options)) return { ok: false, mode: 'multi-school', stage: 'school', errorCode: 'ABORTED', error: abortResult().error, usage: usageFromTelemetry(telemetry), elapsedMs: elapsed(started) };
      var key = schoolKeys[i];
      var card = cardFor(key);
      progress({ type: 'school-start', schoolKey: key, name: card.name });
      // 学派调用故障必须立即显式记为缺席；只有主理人路由与综合允许一次重试，
      // 避免一个学派的重试把真实缺席伪装成稳定成功。
      var schoolCall = await invokeCard(card, buildSchoolPrompt(card, prepared.source, prepared.summary, activeNames, options), 'school:' + key, options, telemetry);
      // 治理层拒绝与预算/超时同级：整轮停止。绝不能把「被治理层拒发的学派」降级成
      // status='absent' 后继续综合并归档 —— 那等于让被拒的文本换一条路（少一派的综合）
      // 仍然落地。
      // INVALID_PROMPT 故意**不**并进这条整轮停止的名单：它往往是「某一派提示词写错、
      // 另一派正常」的局部故障（真实页面实测 D-1 就是两派各算一次缺席）。停在这里会把
      // 另一派的真实结论一起丢掉，等于用一条缺陷吃掉尚未损坏的信息。改法是把这条致命码
      // 记下来带到终态（见下方 fatalPromptFault 分支），既保住局部事实又让整单可辨认。
      if (schoolCall && ['STAGE_BUDGET_EXCEEDED', 'ABORTED', 'STAGE_TIMEOUT', 'PROMPT_GOVERNANCE_REJECTED'].indexOf(schoolCall.errorCode) >= 0) {
        return { ok: false, mode: 'multi-school', stage: 'school:' + key, errorCode: schoolCall.errorCode, error: schoolCall.error, route: route, schools: schoolKeys, summary: prepared.summary, analyses: analyses, usage: usageFromTelemetry(telemetry), elapsedMs: elapsed(started) };
      }
      if (!schoolCall || schoolCall.error || !clean(schoolCall.content)) {
        var absent = { key: key, name: card.name, school: card.school, status: 'absent', content: '', error: clean(schoolCall && schoolCall.error) || 'AI 返回为空', attempts: 1 };
        analyses.push(absent);
        progress({ type: 'school-result', schoolKey: key, name: card.name, result: absent });
        if (schoolCall && isFatalPromptFault(schoolCall.errorCode) && !fatalPromptFault) {
          fatalPromptFault = { schoolKey: key, name: card.name, errorCode: schoolCall.errorCode, error: clean(schoolCall.error) || '提示词结构无效' };
        }
      } else {
        var completed = { key: key, name: card.name, school: card.school, status: 'ok', content: clip(schoolCall.content, MAX_SCHOOL_ANALYSIS_CHARS), error: '', attempts: 1 };
        analyses.push(completed);
        progress({ type: 'school-result', schoolKey: key, name: card.name, result: completed });
      }
    }

    var lead = cardFor('sup-lead');
    var synthesisResult = await withRetry(lead, buildSynthesisPrompt(prepared.source, prepared.summary, route, analyses), 'synthesis', options, telemetry);
    if (!synthesisResult.ok) {
      return { ok: false, mode: 'multi-school', stage: 'synthesis', errorCode: stageFatalCode(synthesisResult.errorCode, 'LEAD_SYNTHESIS_FAILED'), error: synthesisResult.error, attempts: synthesisResult.attempts, route: route, schools: schoolKeys, summary: prepared.summary, summarized: prepared.summarized, analyses: analyses, usage: usageFromTelemetry(telemetry), elapsedMs: elapsed(started) };
    }

    if (stageFailure(options)) return { ok: false, mode: 'multi-school', stage: 'synthesis', errorCode: 'ABORTED', error: abortResult().error, usage: usageFromTelemetry(telemetry), elapsedMs: elapsed(started) };
    var synthesisText = clean(synthesisResult.result.content);
    var output = {
      ok: true,
      mode: 'multi-school',
      route: route,
      schools: schoolKeys,
      summary: prepared.summary,
      summarized: prepared.summarized,
      summaryError: prepared.summaryError,
      failedSegments: prepared.failedSegments || [],
      totalSegments: prepared.totalSegments || 0,
      analyses: analyses,
      synthesis: synthesisText,
      synthesisDetail: { format: 'three-section', content: synthesisText, sections: parseSynthesisSections(synthesisText) },
      materialChars: prepared.source.length,
      usage: usageFromTelemetry(telemetry),
      elapsedMs: elapsed(started),
      archive: { ok: false, skipped: true, reason: 'not-requested' },
    };

    // F1 §3.1-3 / §7.4 + D-1：某个学派的提示词结构性无效时，终态必须带着那条稳定 errorCode
    // 出去（含是哪个学派、原因文案），并且**不进归档通道** —— 改前这里是 ok=true /
    // errorCode=null，页面显示「综合完成，可归档」、保存按钮可用，用户以为两派都在。
    // 局部事实保留：analyses 里两派各自的状态与原因、综合文本一并未丢弃，随终态带回。
    if (fatalPromptFault) {
      output.ok = false;
      output.stage = 'school:' + fatalPromptFault.schoolKey;
      output.errorCode = fatalPromptFault.errorCode;
      output.error = '【' + fatalPromptFault.name + '】' + fatalPromptFault.error + '（' + fatalPromptFault.errorCode
        + '）：该派提示词无效，综合结果缺少这一派，已按失败处理且不可归档';
      output.fatalSchoolKey = fatalPromptFault.schoolKey;
      output.archive = { ok: false, skipped: true, reason: fatalPromptFault.errorCode, errorCode: fatalPromptFault.errorCode, error: output.error };
      return output;
    }

    if (stageFailure(options)) return { ok: false, mode: 'multi-school', stage: 'archive', errorCode: 'ABORTED', error: abortResult().error, usage: usageFromTelemetry(telemetry), elapsedMs: elapsed(started) };
    var store = options.store || (root && root.Store);
    // 页面先展示草稿，只有用户点击“归档”时才调用持久化；批处理调用可显式传 autoSave=true。
    if (options.autoSave === true && store && typeof store.saveAiSupervisionDurable === 'function') {
      output.archive = await saveMultiSchoolDurable(output, request, { store: store });
      if (!output.archive.ok && options.requireArchive) {
        output.ok = false;
        output.stage = 'archive';
        output.errorCode = output.archive.errorCode || 'ARCHIVE_FAILED';
        output.error = output.archive.error || '督导归档失败';
      }
    } else if (options.requireArchive) {
      output.ok = false;
      output.stage = 'archive';
      output.errorCode = 'STORE_UNAVAILABLE';
      output.error = '督导保存通道未就绪';
      output.archive = { ok: false, errorCode: 'STORE_UNAVAILABLE', error: output.error };
    }
    return output;
  }

  async function saveMultiSchoolDurable(result, request, options) {
    options = options || {};
    var store = options.store || (root && root.Store);
    if (!result || result.mode !== 'multi-school') return { ok: false, errorCode: 'MODE_REQUIRED', error: '多学派归档必须声明 mode=multi-school' };
    if (!store || typeof store.saveAiSupervisionDurable !== 'function') return { ok: false, errorCode: 'STORE_UNAVAILABLE', error: '督导保存通道未就绪' };
    var payload = {
      mode: 'multi-school',
      archiveKey: archiveKeyFor(result),
      supervisorName: '何执鉴 · 多学派督导',
      clientId: request && (request.clientId || request.loadedSession && request.loadedSession.clientId) || '',
      sessionId: request && (request.sessionId || request.loadedSession && request.loadedSession.id) || '',
      sessionIds: request && request.sessionIds || [],
      context: request && (request.material || request.context || request.transcript) || '',
      content: typeof result.synthesis === 'string' ? result.synthesis : (result.synthesis && result.synthesis.content) || '',
      schools: Array.isArray(result.schools) ? result.schools.slice() : [],
      route: result.route,
      analyses: Array.isArray(result.analyses) ? result.analyses : [],
      summary: result.summary || '',
      usage: result.usage,
      createdAt: now(),
    };
    if (payload.mode !== 'multi-school') return { ok: false, errorCode: 'MODE_REQUIRED', error: '归档 mode 缺失' };
    try {
      var saved = await store.saveAiSupervisionDurable(payload);
      if (!saved || !saved.ok) return { ok: false, errorCode: saved && saved.error && saved.error.code || 'DURABLE_SAVE_FAILED', error: saved && saved.error && saved.error.message || '督导记录持久化失败', requested: payload };
      // Store persists the complete record in one durable write. Never report
      // success when a legacy adapter silently drops multi-school metadata.
      var value = saved.value || null;
      if (!value || value.mode !== 'multi-school' || value.archiveKey !== payload.archiveKey || !Array.isArray(value.analyses)) {
        return { ok: false, errorCode: 'ARCHIVE_INCOMPLETE', error: '持久化结果缺少多学派元数据', requested: payload, value: value };
      }
      return { ok: true, value: value, requested: payload, reused: saved.reused === true };
    } catch (error) {
      return { ok: false, errorCode: 'DURABLE_SAVE_FAILED', error: error && error.message || String(error), requested: payload };
    }
  }

  async function runAndArchive(input, maybeOptions) {
    var options = Object.assign({}, maybeOptions || {}, { autoSave: true, requireArchive: true });
    return runMultiSchoolSupervision(input, options);
  }

  return {
    CARDS: CARDS,
    SCHOOLS: SCHOOL_KEYS,
    MAX_INPUT_CHARS: MAX_INPUT_CHARS,
    MAX_STAGE_INPUT_CHARS: MAX_STAGE_INPUT_CHARS,
    // 裁决①（F5-B）压低后的两处阶段 clip 上限 + 阶段预算量纲；测试与上层一律从这里读，
    // 不再抄第二份字面量（算术自证 C2-* 用的就是这两个导出值）。
    MAX_STAGE_SUMMARY_CHARS: MAX_STAGE_SUMMARY_CHARS,
    MAX_STAGE_MATERIAL_CHARS: MAX_STAGE_MATERIAL_CHARS,
    MAX_STAGE_OUTPUT_TOKENS: MAX_STAGE_OUTPUT_TOKENS,
    STAGE_TOKEN_CHAR_RATIO: STAGE_TOKEN_CHAR_RATIO,
    STAGE_INPUT_METRIC: STAGE_INPUT_METRIC,
    measureStagePrompt: measureStagePrompt,
    measurePayload: measurePayload,
    SUMMARY_THRESHOLD: SUMMARY_THRESHOLD,
    SUMMARY_SEGMENT_THRESHOLD: SUMMARY_SEGMENT_THRESHOLD,
    MAX_SEGMENT_CHARS: MAX_SEGMENT_CHARS,
    SEGMENT_OVERLAP_CHARS: SEGMENT_OVERLAP_CHARS,
    segmentPlan: segmentPlan,
    MAX_SCHOOLS: MAX_SCHOOLS,
    MAX_SCHOOL_ANALYSIS_CHARS: MAX_SCHOOL_ANALYSIS_CHARS,
    normalizeSchoolKeys: normalizeSchoolKeys,
    parseRouteResponse: parseRouteResponse,
    parseSynthesisSections: parseSynthesisSections,
    buildSummaryPrompt: buildSummaryPrompt,
    buildLeadPrompt: buildLeadPrompt,
    buildSchoolPrompt: buildSchoolPrompt,
    buildSynthesisPrompt: buildSynthesisPrompt,
    // F7 自证入口（scripts/f7-governance-semantics.test.cjs）：guard 兜底常量与各阶段
    // 声明的版本核都从这里取，测的就是产品内同一份实现，不是测试自己的替身。
    FACT_AND_SOURCE_GUARD_FALLBACK: FACT_AND_SOURCE_GUARD_FALLBACK,
    appendFactAndSourceGuard: appendFactAndSourceGuard,
    STAGE_PROMPT_VERSIONS: Object.assign({}, STAGE_PROMPT_VERSIONS),
    // 综合阶段自声明的模板版本（A6 对账轮的落点）：测试直接读这一份，不另抄字面量。
    SYNTHESIS_TEMPLATE_VERSION: SYNTHESIS_TEMPLATE_VERSION,
    isGovernanceRejection: isGovernanceRejection,
    // D-1 的可辨认性判据（F1 §3.1-3）：提示词结构性无效必须一路带到终态 errorCode。
    isFatalPromptFault: isFatalPromptFault,
    stageFatalCode: stageFatalCode,
    roundSystem: roundSystem,
    saveMultiSchoolDurable: saveMultiSchoolDurable,
    runMultiSchoolSupervision: runMultiSchoolSupervision,
    run: runMultiSchoolSupervision,
    runAndArchive: runAndArchive,
    archive: saveMultiSchoolDurable,
  };
});
