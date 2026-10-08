/* XinJing multi-school supervision orchestration.
 * Pure core: no DOM, no storage mutation except the explicit archive call.
 */
(function (root, factory) {
  'use strict';
  var data = null;
  if (typeof module !== 'undefined' && module.exports) {
    try { data = require('./supervision-syndicate-data.js'); } catch (e) { data = null; }
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

  function buildSummaryPrompt(material) {
    var card = cardFor('sup-summarizer');
    return {
      system: card ? card.systemPrompt : '请将长篇临床逐字稿压缩为可供督导使用的四节结构化摘要。',
      user: '请摘要以下临床材料。保留时间线和原话线索，只输出四节结构化摘要，不做诊断。\n\n【材料】\n' + clip(material, MAX_INPUT_CHARS),
    };
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
    var context = summary ? '【结构化摘要】\n' + summary + '\n\n【材料节选】\n' + clip(material, 12000) : '【临床材料】\n' + clip(material, MAX_INPUT_CHARS);
    return {
      system: card ? card.systemPrompt : '请为临床督导材料选择最多三个学派，并以 JSON 返回。',
      user: context + '\n\n请判断案例类型并输出路由 JSON。',
    };
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
        return mastersCore.buildRoundSystemPrompt(card, activeNames, false, prefs);
      } catch (e) { /* fall through to the local, deterministic prompt */ }
    }
    return card.systemPrompt + '\n\n你是独立发言的督导师，只能依据提供的材料，不假定知道其他学派观点。';
  }

  function buildSchoolPrompt(card, material, summary, activeNames, options) {
    var context = summary ? '【历史结构化摘要】\n' + summary + '\n\n【当前材料】\n' + clip(material, 16000) : '【临床材料】\n' + clip(material, MAX_INPUT_CHARS);
    return {
      system: roundSystem(card, activeNames, options || {}),
      user: context + '\n\n请从你的学派督导视角分析，控制在' + MAX_SCHOOL_ANALYSIS_CHARS + '字以内，明确材料证据、判断、不确定处和可执行建议。',
    };
  }

  function buildSynthesisPrompt(material, summary, route, analyses) {
    var rows = analyses.map(function (item) {
      var name = item.name || item.key;
      return '【' + name + '】' + (item.status === 'absent' ? '（缺席：' + item.error + '）' : '\n' + item.content);
    }).join('\n\n');
    var lead = cardFor('sup-lead');
    return {
      system: (lead ? lead.systemPrompt : '') + '\n\n你现在执行综合阶段。只根据材料和各学派回传，不补写缺席学派的观点。',
      user: '案例类型：' + (route.case_type || '综合性督导') + '\n关注点：' + (route.focus || '未指定') + '\n' +
        (summary ? '摘要：\n' + summary + '\n' : '') +
        '材料节选：\n' + clip(material, 12000) + '\n\n逐派回传：\n' + rows +
        '\n\n请输出三段式综合督导：\n【对比表】逐派核心判断及依据\n【分歧点】明确冲突、互补与缺席，不把缺席冒充结论\n【整合建议】给咨询师下一步可执行的探索与风险提醒。',
    };
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
    if (!validPrompt(prompt)) return Promise.resolve({ error: '提示词结构无效', errorCode: 'INVALID_PROMPT' });
    if (prompt.system.length + prompt.user.length > MAX_STAGE_INPUT_CHARS) return Promise.resolve({ error: '当前阶段完整提示词超过预算，请缩短材料后重试', errorCode: 'STAGE_BUDGET_EXCEEDED' });
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
      if (['INVALID_PROMPT', 'STAGE_BUDGET_EXCEEDED', 'ABORTED', 'STAGE_TIMEOUT'].indexOf(last.errorCode) >= 0) break;
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

  async function preprocess(material, options, telemetry) {
    var source = clean(material).slice(0, MAX_INPUT_CHARS);
    if (source.length <= SUMMARY_THRESHOLD) return { source: source, used: source, summarized: false, summary: '', summaryError: '' };
    var card = cardFor('sup-summarizer');
    // Large accepted material is segmented, but failed summaries stop the pipeline.
    // A separate per-stage budget guards the complete system + user prompt.
    if (source.length > 30000) {
      var segments = [];
      var failedSegments = [];
      var SEG = 24000, OVERLAP = 800;
      for (var pos = 0; pos < source.length; pos += (SEG - OVERLAP)) {
        segments.push(source.slice(pos, pos + SEG));
      }
      var parts = [];
      var segError = '';
      for (var si = 0; si < segments.length; si += 1) {
        if (stageFailure(options)) return { errorCode: 'ABORTED', error: abortResult().error };
        var segPrompt = buildSegmentSummaryPrompt(segments[si], si + 1, segments.length);
        var segResult = await withRetry(card, segPrompt, 'summary:seg' + (si + 1), options, telemetry);
        if (segResult.errorCode === 'ABORTED' || segResult.errorCode === 'STAGE_TIMEOUT') return { errorCode: segResult.errorCode, error: segResult.error };
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
      summary = clip(summary, 24000);
      return { source: source, used: summary, summarized: true, summary: summary, summaryError: segError || '', failedSegments: failedSegments, totalSegments: segments.length };
    }
    var prompt = buildSummaryPrompt(source);
    var result = await withRetry(card, prompt, 'summary', options, telemetry);
    if (result.errorCode === 'ABORTED' || result.errorCode === 'STAGE_TIMEOUT') return { errorCode: result.errorCode, error: result.error };
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
    if (!result.ok) return { ok: false, error: result.error, errorCode: ['STAGE_BUDGET_EXCEEDED', 'ABORTED', 'STAGE_TIMEOUT'].indexOf(result.errorCode) >= 0 ? result.errorCode : 'LEAD_ROUTE_FAILED', attempts: result.attempts };
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
    if (clean(material).length > MAX_INPUT_CHARS) return { ok: false, mode: 'multi-school', stage: 'preprocess', errorCode: 'MATERIAL_TOO_LONG', error: '临床材料超过长度上限，请缩短后重试', usage: usageFromTelemetry(telemetry) };

    var prepared = await preprocess(material, options, telemetry);
    if (prepared.errorCode || stageFailure(options)) return { ok: false, mode: 'multi-school', stage: 'preprocess', errorCode: prepared.errorCode || 'ABORTED', error: prepared.error || abortResult().error, usage: usageFromTelemetry(telemetry), elapsedMs: elapsed(started) };
    if ((prepared.failedSegments || []).length) {
      return { ok: false, mode: 'multi-school', stage: 'preprocess', errorCode: 'PARTIAL_SUMMARY', error: '第 ' + prepared.failedSegments.join('、') + ' 段摘要失败，已停止分析以避免遗漏材料；请重试', failedSegments: prepared.failedSegments, totalSegments: prepared.totalSegments, summary: prepared.summary, usage: usageFromTelemetry(telemetry), elapsedMs: elapsed(started) };
    }
    progress({ type: prepared.summarized ? 'summary' : 'preprocess', summarized: prepared.summarized, summaryError: prepared.summaryError, failedSegments: prepared.failedSegments || [], totalSegments: prepared.totalSegments || 0 });
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
    for (var i = 0; i < schoolKeys.length; i += 1) {
      if (stageFailure(options)) return { ok: false, mode: 'multi-school', stage: 'school', errorCode: 'ABORTED', error: abortResult().error, usage: usageFromTelemetry(telemetry), elapsedMs: elapsed(started) };
      var key = schoolKeys[i];
      var card = cardFor(key);
      progress({ type: 'school-start', schoolKey: key, name: card.name });
      // 学派调用故障必须立即显式记为缺席；只有主理人路由与综合允许一次重试，
      // 避免一个学派的重试把真实缺席伪装成稳定成功。
      var schoolCall = await invokeCard(card, buildSchoolPrompt(card, prepared.source, prepared.summary, activeNames, options), 'school:' + key, options, telemetry);
      if (schoolCall && ['STAGE_BUDGET_EXCEEDED', 'ABORTED', 'STAGE_TIMEOUT'].indexOf(schoolCall.errorCode) >= 0) {
        return { ok: false, mode: 'multi-school', stage: 'school:' + key, errorCode: schoolCall.errorCode, error: schoolCall.error, route: route, schools: schoolKeys, summary: prepared.summary, analyses: analyses, usage: usageFromTelemetry(telemetry), elapsedMs: elapsed(started) };
      }
      if (!schoolCall || schoolCall.error || !clean(schoolCall.content)) {
        var absent = { key: key, name: card.name, school: card.school, status: 'absent', content: '', error: clean(schoolCall && schoolCall.error) || 'AI 返回为空', attempts: 1 };
        analyses.push(absent);
        progress({ type: 'school-result', schoolKey: key, name: card.name, result: absent });
      } else {
        var completed = { key: key, name: card.name, school: card.school, status: 'ok', content: clip(schoolCall.content, MAX_SCHOOL_ANALYSIS_CHARS), error: '', attempts: 1 };
        analyses.push(completed);
        progress({ type: 'school-result', schoolKey: key, name: card.name, result: completed });
      }
    }

    var lead = cardFor('sup-lead');
    var synthesisResult = await withRetry(lead, buildSynthesisPrompt(prepared.source, prepared.summary, route, analyses), 'synthesis', options, telemetry);
    if (!synthesisResult.ok) {
      return { ok: false, mode: 'multi-school', stage: 'synthesis', errorCode: ['STAGE_BUDGET_EXCEEDED', 'ABORTED', 'STAGE_TIMEOUT'].indexOf(synthesisResult.errorCode) >= 0 ? synthesisResult.errorCode : 'LEAD_SYNTHESIS_FAILED', error: synthesisResult.error, attempts: synthesisResult.attempts, route: route, schools: schoolKeys, summary: prepared.summary, summarized: prepared.summarized, analyses: analyses, usage: usageFromTelemetry(telemetry), elapsedMs: elapsed(started) };
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
    SUMMARY_THRESHOLD: SUMMARY_THRESHOLD,
    MAX_SCHOOLS: MAX_SCHOOLS,
    MAX_SCHOOL_ANALYSIS_CHARS: MAX_SCHOOL_ANALYSIS_CHARS,
    normalizeSchoolKeys: normalizeSchoolKeys,
    parseRouteResponse: parseRouteResponse,
    parseSynthesisSections: parseSynthesisSections,
    buildSummaryPrompt: buildSummaryPrompt,
    buildLeadPrompt: buildLeadPrompt,
    buildSchoolPrompt: buildSchoolPrompt,
    buildSynthesisPrompt: buildSynthesisPrompt,
    saveMultiSchoolDurable: saveMultiSchoolDurable,
    runMultiSchoolSupervision: runMultiSchoolSupervision,
    run: runMultiSchoolSupervision,
    runAndArchive: runAndArchive,
    archive: saveMultiSchoolDurable,
  };
});
