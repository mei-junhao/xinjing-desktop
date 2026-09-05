/* 心镜临床上下文：受控任务注册、来源准入和 preview-only action-run。 */
(function () {
  'use strict';

  function taskSpec(id, feature, label, allowed, required, maxChars, maxTokens, outputKind, fixtureId) {
    return Object.freeze({
      id: id,
      feature: feature,
      label: label,
      allowedSourceKinds: Object.freeze(allowed.slice()),
      requiredSourceKinds: Object.freeze(required.slice()),
      forbiddenSourceKinds: Object.freeze(['raw-clinical-body', 'unknown']),
      budget: Object.freeze({ maxChars: maxChars, maxTokens: maxTokens }),
      outputSchema: Object.freeze({
        type: 'object',
        required: Object.freeze(['kind', 'citations']),
        allowedProperties: Object.freeze(['kind', 'findings', 'summary', 'changes', 'citations']),
        kind: outputKind
      }),
      writeTarget: 'clinical-action-run-metadata',
      humanConfirmationRequired: true,
      cancellationPolicy: 'user-cancellable',
      expiryMs: 15 * 60 * 1000,
      partialStreamPolicy: 'reject-until-complete',
      evaluationFixtureId: fixtureId,
      outputMode: 'preview-only'
    });
  }

  var TASKS = Object.freeze({
    'transcript-ai-detect': taskSpec('transcript-ai-detect', 'ai-detect', '逐字稿 AI 检测', ['client', 'session', 'material'], ['session'], 18000, 4500, 'transcript-detection-preview', 'fixture-transcript-ai-detect-v1'),
    'report-ai-fill': taskSpec('report-ai-fill', 'ai-report', '报告 AI 填写', ['client', 'session', 'material'], ['session'], 20000, 5000, 'report-fill-preview', 'fixture-report-ai-fill-v1'),
    'supervision-ai': taskSpec('supervision-ai', 'ai-supervise', 'AI 督导', ['client', 'session', 'material', 'supervision'], ['session'], 24000, 6000, 'supervision-preview', 'fixture-supervision-ai-v1'),
    'growth-summary': taskSpec('growth-summary', 'ai-growth', 'AI 成长摘要', ['material'], ['material'], 26400, 6600, 'growth-summary-preview', 'fixture-growth-summary-v1'),
    'real-supervision-ai-organize': taskSpec('real-supervision-ai-organize', 'ai-analyze', '真人督导 AI 整理', ['client', 'session', 'material', 'supervision', 'userdocs'], ['supervision'], 26000, 6500, 'real-supervision-organize-preview', 'fixture-real-supervision-organize-v1'),
    'real-supervision-ai-record-analyze': taskSpec('real-supervision-ai-record-analyze', 'real-sup-ai', '督导记录 AI 分析', ['client', 'session', 'material', 'supervision'], ['supervision'], 26000, 6500, 'real-supervision-analysis-preview', 'fixture-real-supervision-analysis-v1')
  });

  function text(value) { return String(value == null ? '' : value).trim(); }
  function clip(value, limit) {
    var source = text(value);
    return { text: source.slice(0, limit), truncated: source.length > limit, chars: Math.min(source.length, limit) };
  }
  function digest(value) {
    var input = String(value || '');
    var bytes;
    if (typeof TextEncoder !== 'undefined') bytes = Array.prototype.slice.call(new TextEncoder().encode(input));
    else {
      var encoded = unescape(encodeURIComponent(input));
      bytes = [];
      for (var byteIndex = 0; byteIndex < encoded.length; byteIndex++) bytes.push(encoded.charCodeAt(byteIndex));
    }
    var bitLength = bytes.length * 8;
    bytes.push(0x80);
    while ((bytes.length % 64) !== 56) bytes.push(0);
    for (var shift = 7; shift >= 0; shift--) bytes.push(Math.floor(bitLength / Math.pow(2, shift * 8)) & 0xff);
    var k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    var hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    function add() { var total = 0; for (var ai = 0; ai < arguments.length; ai++) total = (total + arguments[ai]) >>> 0; return total; }
    function rotateRight(number, amount) { return (number >>> amount) | (number << (32 - amount)); }
    for (var offset = 0; offset < bytes.length; offset += 64) {
      var words = new Array(64);
      var wordIndex;
      for (wordIndex = 0; wordIndex < 16; wordIndex++) {
        var base = offset + wordIndex * 4;
        words[wordIndex] = ((bytes[base] << 24) | (bytes[base + 1] << 16) | (bytes[base + 2] << 8) | bytes[base + 3]) >>> 0;
      }
      for (wordIndex = 16; wordIndex < 64; wordIndex++) {
        var s0 = rotateRight(words[wordIndex - 15], 7) ^ rotateRight(words[wordIndex - 15], 18) ^ (words[wordIndex - 15] >>> 3);
        var s1 = rotateRight(words[wordIndex - 2], 17) ^ rotateRight(words[wordIndex - 2], 19) ^ (words[wordIndex - 2] >>> 10);
        words[wordIndex] = add(words[wordIndex - 16], s0, words[wordIndex - 7], s1);
      }
      var a = hash[0], b = hash[1], c = hash[2], d = hash[3], e = hash[4], f = hash[5], g = hash[6], h = hash[7];
      for (wordIndex = 0; wordIndex < 64; wordIndex++) {
        var upper1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        var choose = (e & f) ^ ((~e) & g);
        var temp1 = add(h, upper1, choose, k[wordIndex], words[wordIndex]);
        var upper0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        var majority = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = add(upper0, majority);
        h = g; g = f; f = e; e = add(d, temp1); d = c; c = b; b = a; a = add(temp1, temp2);
      }
      hash[0] = add(hash[0], a); hash[1] = add(hash[1], b); hash[2] = add(hash[2], c); hash[3] = add(hash[3], d);
      hash[4] = add(hash[4], e); hash[5] = add(hash[5], f); hash[6] = add(hash[6], g); hash[7] = add(hash[7], h);
    }
    return 'sha256:' + hash.map(function (part) { return part.toString(16).padStart(8, '0'); }).join('');
  }
  function uniqueIds(values) {
    var seen = Object.create(null);
    return (Array.isArray(values) ? values : []).map(String).filter(function (id) { if (!id || seen[id]) return false; seen[id] = true; return true; }).sort();
  }
  function sessionVersion(id) { var item = Store.getSession(id); return item ? String(item.updatedAt || item.date || '') : ''; }
  function getTaskSpec(taskId) { return Object.prototype.hasOwnProperty.call(TASKS, taskId) ? TASKS[taskId] : null; }
  function hashPresent(value) { return /^sha256:\S+$/i.test(text(value)); }

  function validateSources(taskId, sources, origin) {
    var spec = getTaskSpec(taskId);
    if (!spec) return { ok: false, reason: 'unknown-task' };
    if (taskId === 'supervision-ai' && (!sources || !sources.length) && origin && !text(origin.clientId) && !text(origin.sessionId) && !text(origin.materialId) && !text(origin.supervisionId)) return { ok: true };
    if (!Array.isArray(sources) || !sources.length) return { ok: false, reason: 'source-required' };
    origin = origin || {};
    var counts = Object.create(null);
    for (var index = 0; index < sources.length; index++) {
      var source = sources[index] || {};
      var kind = text(source.kind);
      if (!kind || spec.allowedSourceKinds.indexOf(kind) < 0 || spec.forbiddenSourceKinds.indexOf(kind) >= 0) return { ok: false, reason: 'source-kind-unknown', index: index };
      if (!text(source.id)) return { ok: false, reason: 'source-id-missing', index: index };
      if (!hashPresent(source.sourceContentHash) || !hashPresent(source.anchorContentHash)) return { ok: false, reason: 'source-hash-missing', index: index };
      if (!text(source.normalizationVersion) || !text(source.sourceVersion)) return { ok: false, reason: 'source-version-missing', index: index };
      if (['verified', 'valid', 'unchanged'].indexOf(text(source.status)) < 0) return { ok: false, reason: 'source-not-admissible', index: index };
      if (text(origin.clientId) && !text(source.clientId)) return { ok: false, reason: 'source-client-missing', index: index };
      if (text(origin.clientId) && text(source.clientId) !== text(origin.clientId)) return { ok: false, reason: 'source-client-mismatch', index: index };
      if (text(origin.sessionId) && !text(source.sessionId)) return { ok: false, reason: 'source-session-missing', index: index };
      if (text(origin.sessionId) && text(source.sessionId) !== text(origin.sessionId)) return { ok: false, reason: 'source-session-mismatch', index: index };
      counts[kind] = (counts[kind] || 0) + 1;
    }
    for (index = 0; index < spec.requiredSourceKinds.length; index++) {
      if (!counts[spec.requiredSourceKinds[index]]) return { ok: false, reason: 'required-source-missing', kind: spec.requiredSourceKinds[index] };
    }
    return { ok: true };
  }

  function validateOutput(taskId, output) {
    var spec = getTaskSpec(taskId);
    if (!spec) return { ok: false, reason: 'unknown-task' };
    if (!output || typeof output !== 'object' || Array.isArray(output)) return { ok: false, reason: 'output-schema-type' };
    var schema = spec.outputSchema;
    for (var index = 0; index < schema.required.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(output, schema.required[index])) return { ok: false, reason: 'output-schema-required', field: schema.required[index] };
    }
    var keys = Object.keys(output);
    for (index = 0; index < keys.length; index++) {
      if (schema.allowedProperties.indexOf(keys[index]) < 0) return { ok: false, reason: 'output-schema-additional-property', field: keys[index] };
    }
    if (output.kind !== schema.kind) return { ok: false, reason: 'output-schema-kind' };
    if (!Array.isArray(output.citations)) return { ok: false, reason: 'output-schema-citations' };
    if (output.findings !== undefined && !Array.isArray(output.findings)) return { ok: false, reason: 'output-schema-findings' };
    if (output.changes !== undefined && !Array.isArray(output.changes)) return { ok: false, reason: 'output-schema-changes' };
    if (output.summary !== undefined && typeof output.summary !== 'string') return { ok: false, reason: 'output-schema-summary' };
    return { ok: true };
  }

  function resolve(selection) {
    selection = selection || {};
    var material = selection.materialId && Store.getMaterialWorkspace ? Store.getMaterialWorkspace(selection.materialId) : null;
    var clientId = text(selection.clientId), sessionId = text(selection.sessionId), supervisionId = text(selection.supervisionId);
    if (material && material.clientId) {
      if (clientId && clientId !== material.clientId) return { ok: false, reason: 'material-client-conflict' };
      clientId = material.clientId;
      if (material.sessionId) { if (sessionId && sessionId !== material.sessionId) return { ok: false, reason: 'material-session-conflict' }; sessionId = material.sessionId; }
    }
    var client = clientId ? Store.getClient(clientId) : null;
    if (clientId && !client) return { ok: false, reason: 'client-not-found' };
    var session = sessionId ? Store.getSession(sessionId) : null;
    if (sessionId && (!session || !client || session.clientId !== client.id)) return { ok: false, reason: 'session-client-conflict' };
    var supervision = supervisionId && Store.getSupervision ? Store.getSupervision(supervisionId) : null;
    if (supervisionId && !supervision) return { ok: false, reason: 'supervision-not-found' };
    if (supervision) {
      var supervisionClientId = text(supervision.clientId);
      var supervisionSessionIds = Array.isArray(supervision.sessionIds) ? supervision.sessionIds.map(text).filter(Boolean) : [];
      if (!supervisionSessionIds.length && text(supervision.sessionId)) supervisionSessionIds = [text(supervision.sessionId)];
      if (supervisionClientId) {
        if (clientId && supervisionClientId !== clientId) return { ok: false, reason: 'supervision-client-conflict' };
        clientId = supervisionClientId;
      } else {
        if (!supervisionSessionIds.length) return { ok: false, reason: 'supervision-client-missing' };
        var owners = supervisionSessionIds.map(function (id) { var item = Store.getSession(id); return item ? text(item.clientId) : ''; });
        if (owners.some(function (owner) { return !owner; }) || owners.some(function (owner) { return owner !== owners[0]; })) return { ok: false, reason: 'supervision-session-owner-invalid' };
        if (clientId && owners[0] !== clientId) return { ok: false, reason: 'supervision-client-conflict' };
        clientId = owners[0];
      }
    }
    return { ok: true, clientId: clientId, sessionId: sessionId, materialId: material ? material.id : '', supervisionId: supervisionId, client: client, session: session, material: material, supervision: supervision };
  }

  function createSnapshot(context, inputText) {
    var ids = uniqueIds(context.selectedSessionIds || []), versions = {};
    ids.forEach(function (id) { versions[id] = sessionVersion(id); });
    return {
      clientId: context.origin.clientId, sessionId: context.origin.sessionId, materialId: context.origin.materialId, supervisionId: context.origin.supervisionId,
      selectedSessionIds: ids, sessionVersions: versions,
      materialUpdatedAt: context.material ? String(context.material.updatedAt || '') : '', supervisionUpdatedAt: context.supervision ? String(context.supervision.updatedAt || '') : '',
      inputDigest: digest(inputText), key: [context.origin.clientId, context.origin.sessionId, context.origin.materialId, context.origin.supervisionId, ids.join(','), digest(inputText)].join('|')
    };
  }
  function isSnapshotCurrent(snapshot, inputText, selection) {
    if (!snapshot || digest(inputText) !== snapshot.inputDigest) return false;
    if (selection) {
      var current = resolve(selection);
      if (!current.ok || current.clientId !== snapshot.clientId || current.sessionId !== snapshot.sessionId || current.materialId !== snapshot.materialId || current.supervisionId !== snapshot.supervisionId) return false;
      var ids = uniqueIds(selection.selectedSessionIds || (current.sessionId ? [current.sessionId] : []));
      if (ids.join(',') !== uniqueIds(snapshot.selectedSessionIds).join(',')) return false;
    }
    var material = snapshot.materialId && Store.getMaterialWorkspace ? Store.getMaterialWorkspace(snapshot.materialId) : null;
    if (snapshot.materialId && (!material || String(material.updatedAt || '') !== snapshot.materialUpdatedAt)) return false;
    var supervision = snapshot.supervisionId && Store.getSupervision ? Store.getSupervision(snapshot.supervisionId) : null;
    if (snapshot.supervisionId && (!supervision || String(supervision.updatedAt || '') !== snapshot.supervisionUpdatedAt)) return false;
    return (snapshot.selectedSessionIds || []).every(function (id) { return sessionVersion(id) === snapshot.sessionVersions[id]; });
  }

  function governedSource(kind, id, label, body, origin, version, truncated) {
    var bodyText = text(body);
    return Object.freeze({
      kind: kind, id: text(id), label: text(label), chars: bodyText.length, truncated: !!truncated,
      clientId: text(origin.clientId), sessionId: text(origin.sessionId), normalizationVersion: '1', sourceVersion: text(version) || '1',
      sourceContentHash: digest(bodyText), anchorContentHash: digest(kind + '|' + text(id) + '|' + bodyText), status: 'verified'
    });
  }

  function build(task, selection, options) {
    options = options || {};
    var spec = getTaskSpec(task);
    if (!spec) return { ok: false, reason: 'unknown-task' };
    if (typeof App !== 'undefined' && App.featureGate && !App.featureGate(spec.feature)) return { ok: false, reason: 'feature-locked' };
    if (typeof App !== 'undefined' && App.hasAICompute && !App.hasAICompute()) return { ok: false, reason: 'compute-unavailable' };
    var resolved = resolve(selection);
    if (!resolved.ok) return resolved;
    var selectedSessionIds = uniqueIds(options.selectedSessionIds || (resolved.sessionId ? [resolved.sessionId] : []));
    if (!selectedSessionIds.every(function (id) { var s = Store.getSession(id); return s && (!resolved.clientId || s.clientId === resolved.clientId); })) return { ok: false, reason: 'selected-session-conflict' };
    var origin = { clientId: resolved.clientId, sessionId: resolved.sessionId, materialId: resolved.materialId, supervisionId: resolved.supervisionId };
    var sources = [], blocks = [], displaySources = [];
    function add(kind, id, label, value, limit, version) {
      var cut = clip(value, limit);
      if (!cut.text) return;
      sources.push(governedSource(kind, id, label, cut.text, origin, version, cut.truncated));
      displaySources.push(label);
      blocks.push('[' + label + ']\n' + cut.text);
    }
    if (resolved.client) add('client', resolved.client.id, '当前来访者', '来访者：' + (resolved.client.name || '未命名') + '（化名）' + (resolved.client.notes ? '\n备注：' + resolved.client.notes : ''), 1200, resolved.client.updatedAt);
    selectedSessionIds.forEach(function (id) {
      var session = Store.getSession(id), soap = session.soap || {};
      var value = ['第' + (session.sessionNumber || '?') + '节（' + (session.date || '') + '）', session.transcript || '', 'SOAP: S=' + (soap.subjective || '') + ' O=' + (soap.objective || '') + ' A=' + (soap.assessment || '') + ' P=' + (soap.plan || ''), session.notes || ''].join('\n');
      var sessionOrigin = Object.assign({}, origin, { sessionId: id });
      var cut = clip(value, 1800);
      if (cut.text) {
        sources.push(governedSource('session', id, '已选会谈', cut.text, sessionOrigin, session.updatedAt || session.date, cut.truncated));
        displaySources.push('已选会谈：第' + (session.sessionNumber || '?') + '节 · ' + (session.date || '日期未填写'));
        blocks.push('[已选会谈]\n' + cut.text);
      }
    });
    if (resolved.material && resolved.material.parseStatus === 'ready') add('material', resolved.material.id, '当前上传材料', resolved.material.extractedText, 12000, resolved.material.updatedAt);
    if (resolved.supervision) add('supervision', resolved.supervision.id, '当前督导记录', resolved.supervision.content || resolved.supervision.conclusion, 8000, resolved.supervision.updatedAt);
    if (options.includeUserDocs && task === 'real-supervision-ai-organize') {
      var userDocs = '';
      try { userDocs = typeof window !== 'undefined' && window.UserDocs && window.UserDocs.getContextBlock ? text(window.UserDocs.getContextBlock()) : ''; } catch (error) { userDocs = ''; }
      if (userDocs) add('userdocs', 'retrieval:library-summary', '我的资料库概览', userDocs, 1200, 'retrieval-v1');
    }
    var input = text(options.inputText);
    if (input) blocks.push('[当前输入]\n' + input);
    var admission = validateSources(task, sources, origin);
    if (!admission.ok) return admission;
    var payload = blocks.join('\n\n') + (options.instruction ? '\n\n[本轮指令]\n' + text(options.instruction) : '');
    var estimatedChars = payload.length;
    var estimatedTokens = Math.ceil(estimatedChars / 4);
    if (estimatedChars > spec.budget.maxChars || estimatedTokens > spec.budget.maxTokens) return { ok: false, reason: 'task-budget-exceeded' };
    var context = { ok: true, task: task, taskSpec: spec, taskLabel: spec.label, feature: spec.feature, outputMode: spec.outputMode, origin: origin, material: resolved.material, supervision: resolved.supervision, selectedSessionIds: selectedSessionIds, sources: sources, displaySources: displaySources, estimatedChars: estimatedChars, estimatedTokens: estimatedTokens, warnings: [] };
    var history = (Array.isArray(options.history) ? options.history : []).map(function (message) {
      var role = message && (message.role === 'assistant' || message.role === 'user') ? message.role : '';
      var content = clip(message && message.content, 2000).text;
      return role && content ? { role: role, content: content } : null;
    }).filter(Boolean).slice(-12);
    context.snapshot = createSnapshot(context, input);
    context.messages = [{ role: 'system', content: text(options.system) }].concat(history).concat([{ role: 'user', content: payload }]);
    return context;
  }

  function summarize(context) { return (context.sources || []).map(function (source) { return source.label + (source.truncated ? '（已截断）' : ''); }); }
  function sourceProjection(source) {
    return { kind: source.kind, id: source.id, clientId: source.clientId, sessionId: source.sessionId, normalizationVersion: source.normalizationVersion, sourceVersion: source.sourceVersion, sourceContentHash: source.sourceContentHash, anchorContentHash: source.anchorContentHash, status: source.status };
  }
  function createActionRun(context) {
    if (!context || !getTaskSpec(context.task) || context.outputMode !== 'preview-only') return null;
    var admission = validateSources(context.task, context.sources, context.origin);
    if (!admission.ok) return null;
    return Store.createClinicalActionRun({ task: context.task, status: 'pending', outputMode: 'preview-only', origin: Object.assign({}, context.origin), sources: context.sources.map(sourceProjection), snapshot: Object.assign({}, context.snapshot), createdAt: new Date().toISOString() });
  }
  function completeActionRun(id, output) {
    var existing = Store.updateClinicalActionRun(id, {});
    if (!existing) return null;
    var validation = validateOutput(existing.task, output);
    // 向后兼容：即使输出未通过校验，也回写动作追踪 ID（不标记 succeeded），
    // 保证 v4.3 artifacts 白名单字段（transcriptActionRunId 等）可追踪失败动作。
    var status = validation.ok ? 'succeeded' : 'failed';
    var run = Store.updateClinicalActionRun(id, {
      status: status,
      output: validation.ok ? { kind: output.kind, ref: digest(JSON.stringify(output)) } : { kind: text(output && output.kind || ''), ref: '' },
      completedAt: new Date().toISOString()
    });
    if (!run || !run.origin || !run.origin.materialId || !Store.updateMaterialWorkspace) return run;
    var artifactKeys = {
      'transcript-ai-detect': 'transcriptActionRunId',
      'report-ai-fill': 'reportActionRunId',
      'supervision-ai': 'supervisionActionRunId',
      'real-supervision-ai-organize': 'realSupervisionActionRunId',
      'real-supervision-ai-record-analyze': 'realSupervisionActionRunId'
    };
    var artifactKey = artifactKeys[run.task];
    if (artifactKey) Store.updateMaterialWorkspace(run.origin.materialId, { artifacts: (function () { var patch = {}; patch[artifactKey] = run.id; return patch; })() });
    return run;
  }
  function failActionRun(id, error, status) { return Store.updateClinicalActionRun(id, { status: status || 'failed', error: text(error).slice(0, 200), completedAt: new Date().toISOString() }); }

  window.ClinicalContext = Object.freeze({ TASKS: TASKS, getTaskSpec: getTaskSpec, validateSources: validateSources, validateOutput: validateOutput, resolve: resolve, build: build, summarize: summarize, createSnapshot: createSnapshot, isSnapshotCurrent: isSnapshotCurrent, createActionRun: createActionRun, completeActionRun: completeActionRun, failActionRun: failActionRun, digest: digest });
})();
