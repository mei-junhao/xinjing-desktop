/* 心镜临床上下文：仅构造受控数据，不访问 DOM，也不直接调用 AI。 */
(function () {
  'use strict';

  var TASKS = {
    'transcript-ai-detect': { feature: 'ai-detect', label: '逐字稿 AI 检测' },
    'report-ai-fill': { feature: 'ai-report', label: '报告 AI 填写' },
    'supervision-ai': { feature: 'ai-supervise', label: 'AI 督导' },
    'real-supervision-ai-organize': { feature: 'ai-analyze', label: '真人督导 AI 整理' },
    'real-supervision-ai-record-analyze': { feature: 'real-sup-ai', label: '督导记录 AI 分析' }
  };

  function text(value) { return String(value || '').trim(); }
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
    function add() {
      var total = 0;
      for (var argIndex = 0; argIndex < arguments.length; argIndex++) total = (total + arguments[argIndex]) >>> 0;
      return total;
    }
    function rotateRight(number, amount) { return (number >>> amount) | (number << (32 - amount)); }
    for (var offset = 0; offset < bytes.length; offset += 64) {
      var words = new Array(64);
      for (var wordIndex = 0; wordIndex < 16; wordIndex++) {
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
    var seen = {};
    return (Array.isArray(values) ? values : []).map(String).filter(function (id) {
      if (!id || seen[id]) return false;
      seen[id] = true;
      return true;
    }).sort();
  }
  function sessionVersion(id) {
    var item = Store.getSession(id);
    return item ? String(item.updatedAt || item.date || '') : '';
  }
  function resolve(selection) {
    selection = selection || {};
    var material = selection.materialId && Store.getMaterialWorkspace ? Store.getMaterialWorkspace(selection.materialId) : null;
    var clientId = text(selection.clientId);
    var sessionId = text(selection.sessionId);
    var supervisionId = text(selection.supervisionId);
    if (material && material.clientId) {
      if (clientId && clientId !== material.clientId) return { ok: false, reason: 'material-client-conflict' };
      clientId = material.clientId;
      if (material.sessionId) {
        if (sessionId && sessionId !== material.sessionId) return { ok: false, reason: 'material-session-conflict' };
        sessionId = material.sessionId;
      }
    }
    var client = clientId ? Store.getClient(clientId) : null;
    if (clientId && !client) return { ok: false, reason: 'client-not-found' };
    var session = sessionId ? Store.getSession(sessionId) : null;
    if (sessionId && (!session || !client || session.clientId !== client.id)) return { ok: false, reason: 'session-client-conflict' };
    var supervision = supervisionId && Store.getSupervision ? Store.getSupervision(supervisionId) : null;
    if (supervisionId && !supervision) return { ok: false, reason: 'supervision-not-found' };
    if (supervision && clientId && supervision.clientId && supervision.clientId !== clientId) return { ok: false, reason: 'supervision-client-conflict' };
    if (supervision && !clientId) clientId = text(supervision.clientId);
    return { ok: true, clientId: clientId, sessionId: sessionId, materialId: material ? material.id : '', supervisionId: supervisionId, client: client, session: session, material: material, supervision: supervision };
  }
  function createSnapshot(context, inputText) {
    var ids = uniqueIds(context.selectedSessionIds || []);
    var versions = {};
    ids.forEach(function (id) { versions[id] = sessionVersion(id); });
    return {
      clientId: context.origin.clientId, sessionId: context.origin.sessionId, materialId: context.origin.materialId, supervisionId: context.origin.supervisionId,
      selectedSessionIds: ids, sessionVersions: versions,
      materialUpdatedAt: context.material ? String(context.material.updatedAt || '') : '',
      supervisionUpdatedAt: context.supervision ? String(context.supervision.updatedAt || '') : '',
      inputDigest: digest(inputText),
      key: [context.origin.clientId, context.origin.sessionId, context.origin.materialId, context.origin.supervisionId, ids.join(','), digest(inputText)].join('|')
    };
  }
  function isSnapshotCurrent(snapshot, inputText, selection) {
    if (!snapshot) return false;
    if (digest(inputText) !== snapshot.inputDigest) return false;
    if (selection) {
      var current = resolve(selection);
      if (!current.ok || current.clientId !== snapshot.clientId || current.sessionId !== snapshot.sessionId || current.materialId !== snapshot.materialId || current.supervisionId !== snapshot.supervisionId) return false;
      var currentSessionIds = uniqueIds(selection.selectedSessionIds || (current.sessionId ? [current.sessionId] : []));
      if (currentSessionIds.join(',') !== uniqueIds(snapshot.selectedSessionIds).join(',')) return false;
    }
    var material = snapshot.materialId && Store.getMaterialWorkspace ? Store.getMaterialWorkspace(snapshot.materialId) : null;
    if (snapshot.materialId && (!material || String(material.updatedAt || '') !== snapshot.materialUpdatedAt)) return false;
    var supervision = snapshot.supervisionId && Store.getSupervision ? Store.getSupervision(snapshot.supervisionId) : null;
    if (snapshot.supervisionId && (!supervision || String(supervision.updatedAt || '') !== snapshot.supervisionUpdatedAt)) return false;
    return (snapshot.selectedSessionIds || []).every(function (id) { return sessionVersion(id) === snapshot.sessionVersions[id]; });
  }
  function build(task, selection, options) {
    options = options || {};
    var taskSpec = TASKS[task];
    if (!taskSpec) return { ok: false, reason: 'unknown-task' };
    if (typeof App !== 'undefined' && App.featureGate && !App.featureGate(taskSpec.feature)) return { ok: false, reason: 'feature-locked' };
    if (typeof App !== 'undefined' && App.hasAICompute && !App.hasAICompute()) return { ok: false, reason: 'compute-unavailable' };
    var resolved = resolve(selection);
    if (!resolved.ok) return resolved;
    var selectedSessionIds = uniqueIds(options.selectedSessionIds || (resolved.sessionId ? [resolved.sessionId] : []));
    if (!selectedSessionIds.every(function (id) { var s = Store.getSession(id); return s && (!resolved.clientId || s.clientId === resolved.clientId); })) return { ok: false, reason: 'selected-session-conflict' };
    var sources = [], blocks = [], displaySources = [];
    function addSource(source, display) { sources.push(source); displaySources.push(display || source.label); }
    if (resolved.client) {
      var clientCut = clip('来访者：' + (resolved.client.name || '未命名') + '（化名）' + (resolved.client.notes ? '\n备注：' + resolved.client.notes : ''), 1200);
      addSource({ kind: 'client', id: resolved.client.id, label: '当前来访者', chars: clientCut.chars, truncated: clientCut.truncated }, resolved.client.name ? '当前来访者：' + resolved.client.name : '当前来访者');
      if (clientCut.text) blocks.push('[当前来访者]\n' + clientCut.text);
    }
    selectedSessionIds.forEach(function (id) {
      var session = Store.getSession(id);
      var soap = session.soap || {};
      var sessionText = ['第' + (session.sessionNumber || '?') + '节（' + (session.date || '') + '）', session.transcript || '', 'SOAP: S=' + (soap.subjective || '') + ' O=' + (soap.objective || '') + ' A=' + (soap.assessment || '') + ' P=' + (soap.plan || ''), session.notes || ''].join('\n');
      var cut = clip(sessionText, 1800);
      addSource({ kind: 'session', id: id, label: '已选会谈', chars: cut.chars, truncated: cut.truncated }, '已选会谈：第' + (session.sessionNumber || '?') + '节 · ' + (session.date || '日期未填写'));
      if (cut.text) blocks.push('[已选会谈]\n' + cut.text);
    });
    if (resolved.material && resolved.material.parseStatus === 'ready') {
      var materialCut = clip(resolved.material.extractedText, 12000);
      addSource({ kind: 'material', id: resolved.material.id, label: '当前上传材料', chars: materialCut.chars, truncated: materialCut.truncated }, '当前上传材料：' + (resolved.material.title || '未命名材料'));
      if (materialCut.text) blocks.push('[当前上传材料]\n' + materialCut.text);
    }
    if (resolved.supervision) {
      var supervisionCut = clip(resolved.supervision.content || resolved.supervision.conclusion, 8000);
      addSource({ kind: 'supervision', id: resolved.supervision.id, label: '当前督导记录', chars: supervisionCut.chars, truncated: supervisionCut.truncated }, '当前督导记录');
      if (supervisionCut.text) blocks.push('[当前督导记录]\n' + supervisionCut.text);
    }
    if (options.includeUserDocs && task === 'real-supervision-ai-organize') {
      var userDocsBlock = '';
      try { userDocsBlock = typeof window !== 'undefined' && window.UserDocs && window.UserDocs.getContextBlock ? text(window.UserDocs.getContextBlock()) : ''; } catch (e) { userDocsBlock = ''; }
      if (userDocsBlock) {
        var userDocsCut = clip(userDocsBlock, 1200);
        addSource({ kind: 'userdocs', id: 'retrieval:library-summary', label: '我的资料库概览', chars: userDocsCut.chars, truncated: userDocsCut.truncated }, '我的资料库概览');
        blocks.push('[我的资料库检索结果]\n' + userDocsCut.text);
      }
    }
    var input = text(options.inputText);
    if (input) blocks.push('[当前输入]\n' + input);
    var origin = { clientId: resolved.clientId, sessionId: resolved.sessionId, materialId: resolved.materialId, supervisionId: resolved.supervisionId };
    var context = { ok: true, task: task, taskLabel: taskSpec.label, feature: taskSpec.feature, origin: origin, material: resolved.material, supervision: resolved.supervision, selectedSessionIds: selectedSessionIds, sources: sources, displaySources: displaySources, estimatedChars: blocks.join('\n\n').length, warnings: [] };
    var history = (Array.isArray(options.history) ? options.history : []).map(function (message) {
      var role = message && (message.role === 'assistant' || message.role === 'user') ? message.role : '';
      var content = clip(message && message.content, 2000).text;
      return role && content ? { role: role, content: content } : null;
    }).filter(Boolean).slice(-12);
    context.snapshot = createSnapshot(context, input);
    context.messages = [{ role: 'system', content: text(options.system) }].concat(history).concat([{ role: 'user', content: blocks.join('\n\n') + (options.instruction ? '\n\n[本轮指令]\n' + text(options.instruction) : '') }]);
    return context;
  }
  function summarize(context) { return (context.sources || []).map(function (source) { return source.label + (source.truncated ? '（已截断）' : ''); }); }
  function createActionRun(context) { return Store.createClinicalActionRun({ task: context.task, status: 'pending', origin: context.origin, sources: context.sources, snapshot: context.snapshot }); }
  function completeActionRun(id, output) {
    var run = Store.updateClinicalActionRun(id, { status: 'succeeded', output: output || {}, completedAt: new Date().toISOString() });
    if (!run || !run.origin.materialId || !Store.updateMaterialWorkspace) return run;
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

  window.ClinicalContext = { TASKS: TASKS, resolve: resolve, build: build, summarize: summarize, createSnapshot: createSnapshot, isSnapshotCurrent: isSnapshotCurrent, createActionRun: createActionRun, completeActionRun: completeActionRun, failActionRun: failActionRun, digest: digest };
})();
