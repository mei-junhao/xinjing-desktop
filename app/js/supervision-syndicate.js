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

  var MAX_INPUT_CHARS = 120000;
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
        return mastersCore.buildRoundSystemPrompt(card, activeNames, false, { includeUserDocs: false });
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
    if (typeof options.onDelta === 'function') {
      transportOptions.onDelta = function (piece, fullText) { options.onDelta(piece, fullText, stage); };
    }
    return new Promise(function (resolve) {
      var settled = false;
      function finish(result) {
        if (settled) return;
        settled = true;
        var normalized = result && typeof result === 'object' ? result : { content: result };
        var output = clean(normalized.content);
        telemetry.outputChars += output.length;
        telemetry.byStage[stage].outputChars += output.length;
        telemetry.byStage[stage].durationMs += elapsed(started);
        if (!output && !normalized.error) normalized = Object.assign({}, normalized, { error: 'AI 返回为空', errorCode: 'EMPTY_RESPONSE' });
        resolve(normalized);
      }
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
    var customProvider = options.provider || options.ai;
    var mastersCore = options.mastersCore || (root && root.MastersCore);
    if (!customProvider && mastersCore && typeof mastersCore.callMaster === 'function') {
      var conv = { messages: [], summary: '', importedContext: '' };
      return new Promise(function (resolve) {
        var started = Date.now();
        telemetry.calls += 1;
        telemetry.inputChars += text(prompt.system).length + text(prompt.user).length;
        telemetry.byStage[stage] = telemetry.byStage[stage] || { calls: 0, durationMs: 0, inputChars: 0, outputChars: 0 };
        telemetry.byStage[stage].calls += 1;
        telemetry.byStage[stage].inputChars += text(prompt.system).length + text(prompt.user).length;
        try {
          Promise.resolve(mastersCore.callMaster(conv, card, prompt.user, { systemPrompt: prompt.system, includeUserDocs: false, onDelta: function (piece, fullText) {
            if (typeof options.onDelta === 'function') options.onDelta(piece, fullText, stage);
          } }))
            .then(function (res) {
              var normalized = res && typeof res === 'object' ? res : { content: res };
              var output = clean(normalized.content);
              telemetry.outputChars += output.length;
              telemetry.byStage[stage].outputChars += output.length;
              telemetry.byStage[stage].durationMs += elapsed(started);
              if (!output && !normalized.error) normalized = Object.assign({}, normalized, { error: 'AI 返回为空', errorCode: 'EMPTY_RESPONSE' });
              resolve(normalized);
            }, function (error) { resolve({ error: error && error.message || String(error), errorCode: 'PROVIDER_REJECTED' }); });
        } catch (error) { resolve({ error: error && error.message || String(error), errorCode: 'PROVIDER_THROWN' }); }
      });
    }
    return callProvider([{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], stage, options, telemetry);
  }

  async function withRetry(card, prompt, stage, options, telemetry) {
    var last = null;
    for (var attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      var result = await invokeCard(card, prompt, stage, options, telemetry);
      if (result && !result.error && clean(result.content)) return { ok: true, result: result, attempts: attempt };
      last = result || { error: 'AI 返回为空', errorCode: 'EMPTY_RESPONSE' };
    }
    return { ok: false, error: clean(last && last.error) || 'AI 调用失败', errorCode: (last && last.errorCode) || 'AI_FAILED', attempts: MAX_RETRIES };
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
    var prompt = buildSummaryPrompt(source);
    var result = await withRetry(card, prompt, 'summary', options, telemetry);
    if (result.ok) {
      var summary = clean(result.result.content);
      return { source: source, used: summary, summarized: true, summary: summary, summaryError: '' };
    }
    return { source: source, used: source, summarized: false, summary: '', summaryError: result.error };
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
    if (!result.ok) return { ok: false, error: result.error, errorCode: 'LEAD_ROUTE_FAILED', attempts: result.attempts };
    var route = parseRouteResponse(result.result.content);
    if (!route.valid) return { ok: false, error: '主理人路由未返回有效学派', errorCode: 'LEAD_ROUTE_INVALID', attempts: result.attempts };
    return { ok: true, route: route, attempts: result.attempts };
  }

  async function runMultiSchoolSupervision(input, maybeOptions) {
    var request = typeof input === 'string' ? { material: input } : (input || {});
    var options = Object.assign({}, maybeOptions || {}, request.options || {});
    var material = request.material != null ? request.material : (request.context != null ? request.context : request.transcript);
    var telemetry = emptyTelemetry();
    var started = Date.now();
    var onProgress = typeof options.onProgress === 'function' ? options.onProgress : function () {};
    function progress(event) { try { onProgress(Object.assign({ mode: 'multi-school' }, event || {})); } catch (e) {} }
    if (!clean(material)) return { ok: false, mode: 'multi-school', stage: 'preprocess', errorCode: 'MATERIAL_REQUIRED', error: '请提供临床材料', usage: usageFromTelemetry(telemetry) };

    var prepared = await preprocess(material, options, telemetry);
    progress({ type: prepared.summarized ? 'summary' : 'preprocess', summarized: prepared.summarized, summaryError: prepared.summaryError });
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
      var key = schoolKeys[i];
      var card = cardFor(key);
      progress({ type: 'school-start', schoolKey: key, name: card.name });
      // 学派调用故障必须立即显式记为缺席；只有主理人路由与综合允许一次重试，
      // 避免一个学派的重试把真实缺席伪装成稳定成功。
      var schoolCall = await invokeCard(card, buildSchoolPrompt(card, prepared.source, prepared.summary, activeNames, options), 'school:' + key, options, telemetry);
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
      return { ok: false, mode: 'multi-school', stage: 'synthesis', errorCode: 'LEAD_SYNTHESIS_FAILED', error: synthesisResult.error, attempts: synthesisResult.attempts, route: route, schools: schoolKeys, summary: prepared.summary, summarized: prepared.summarized, analyses: analyses, usage: usageFromTelemetry(telemetry), elapsedMs: elapsed(started) };
    }

    var synthesisText = clean(synthesisResult.result.content);
    var output = {
      ok: true,
      mode: 'multi-school',
      route: route,
      schools: schoolKeys,
      summary: prepared.summary,
      summarized: prepared.summarized,
      summaryError: prepared.summaryError,
      analyses: analyses,
      synthesis: synthesisText,
      synthesisDetail: { format: 'three-section', content: synthesisText, sections: parseSynthesisSections(synthesisText) },
      materialChars: prepared.source.length,
      usage: usageFromTelemetry(telemetry),
      elapsedMs: elapsed(started),
      archive: { ok: false, skipped: true, reason: 'not-requested' },
    };

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
      var value = saved.value || null;
      // 旧版 AI 督导构造器只保存基础字段；用现有 durable 更新通道补齐模式元数据。
      if (value && value.id && typeof store.updateSupervisionDurable === 'function') {
        var metadata = { mode: payload.mode, schools: payload.schools, route: payload.route, analyses: payload.analyses, summary: payload.summary, usage: payload.usage };
        var updated = await store.updateSupervisionDurable(value.id, metadata);
        if (!updated || !updated.ok) return { ok: false, errorCode: updated && updated.error && updated.error.code || 'DURABLE_METADATA_SAVE_FAILED', error: updated && updated.error && updated.error.message || '督导元数据持久化失败', requested: payload, value: value };
        value = updated.value || value;
      }
      return { ok: true, value: value, requested: payload };
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
