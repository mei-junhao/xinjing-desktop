/* Verified-source longitudinal summary preparation and preview validation. */
(function (root) {
  'use strict';

  var MAX_SOURCES = 12;
  var MAX_SOURCE_CHARS = 2200;
  var MAX_SUMMARY_CHARS = 2400;
  var MAX_CHANGE_CHARS = 700;

  function text(value) { return String(value == null ? '' : value).trim(); }
  function clip(value, limit) {
    var source = text(value);
    return { text: source.slice(0, limit), chars: Math.min(source.length, limit), truncated: source.length > limit };
  }
  function unique(values) {
    var seen = Object.create(null);
    return (Array.isArray(values) ? values : []).filter(function (value) {
      var key = text(value);
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }
  function materialIdFromRef(ref) {
    var locator = text(ref && ref.anchor && ref.anchor.locator);
    return locator.indexOf('material:') === 0 ? locator.slice('material:'.length) : '';
  }
  function sourceKey(reference) {
    return [reference.nodeId, reference.sourceId, reference.sessionId].join('|');
  }
  function referenceProjection(node, materialId) {
    var ref = node && node.sourceRef || {};
    return Object.freeze({
      nodeId: text(node && node.id),
      sourceId: text(ref.id),
      sessionId: text(node && node.sessionId),
      materialId: text(materialId),
      normalizationVersion: text(ref.normalizationVersion),
      sourceVersion: text(ref.sourceVersion),
      sourceContentHash: text(ref.sourceContentHash),
      anchorContentHash: text(ref.anchorContentHash),
      status: text(node && node.sourceStatus)
    });
  }
  function referenceKey(clientId, references) {
    var basis = [text(clientId)].concat((references || []).map(sourceKey).sort()).join('|');
    return root.ClinicalContext && typeof root.ClinicalContext.digest === 'function'
      ? root.ClinicalContext.digest(basis)
      : basis;
  }
  function featureReady() {
    if (!root.App || typeof root.App.featureGate !== 'function' || !root.App.featureGate('ai-growth')) return { ok: false, reason: 'feature-locked' };
    if (typeof root.App.hasAICompute === 'function' && !root.App.hasAICompute()) return { ok: false, reason: 'compute-unavailable' };
    return { ok: true };
  }
  function messageTemplate(references, blocks) {
    var sourceList = references.map(function (reference) {
      return '节点=' + reference.nodeId + '；来源=' + reference.sourceId + '；会谈=' + reference.sessionId;
    }).join('\n');
    return [
      {
        role: 'system',
        content: '你是临床纵向变化摘要助手。只能依据用户消息中给出的已验证材料，不能补造来源。只输出 JSON：' +
          '{"summary":"...","changes":[{"title":"...","detail":"..."}],"citations":[{"nodeId":"...","sourceId":"...","sessionId":"..."}]}。' +
          'citations 中每一项必须逐字匹配允许来源；没有足够依据时返回空 changes，但仍说明资料不足。'
      },
      {
        role: 'user',
        content: '[允许引用]\n' + sourceList + '\n\n[已验证材料]\n' + blocks.join('\n\n')
      }
    ];
  }
  function modelReferences(clientId, model) {
    var entries = [];
    var nodes = model && Array.isArray(model.nodes) ? model.nodes : [];
    nodes.forEach(function (node) {
      if (!node || node.kind !== 'material' || node.clientId !== clientId || node.sourceStatus !== 'verified' || !node.sourceRef || !node.sourceRef.id) return;
      var materialId = materialIdFromRef(node.sourceRef);
      var material = materialId && root.Store && root.Store.getMaterialWorkspace ? root.Store.getMaterialWorkspace(materialId) : null;
      if (!material || material.clientId !== clientId || material.sessionId !== node.sessionId || material.parseStatus !== 'ready') return;
      if (!text(material.extractedText)) return;
      var reference = referenceProjection(node, materialId);
      if (!reference.normalizationVersion || !reference.sourceVersion || !/^sha256:/i.test(reference.sourceContentHash) || !/^sha256:/i.test(reference.anchorContentHash)) return;
      entries.push({
        nodeId: reference.nodeId,
        sourceId: reference.sourceId,
        sessionId: reference.sessionId,
        materialId: materialId,
        reference: reference,
        occurredAt: text(node.occurredAt || material.updatedAt || material.createdAt),
        material: material
      });
    });
    entries.sort(function (left, right) {
      return (left.occurredAt + '|' + left.sourceId).localeCompare(right.occurredAt + '|' + right.sourceId);
    });
    return unique(entries.map(sourceKey)).map(function (key) {
      return entries.find(function (entry) { return sourceKey(entry) === key; });
    }).slice(0, MAX_SOURCES);
  }
  async function prepare(clientId, options) {
    options = options || {};
    clientId = text(clientId);
    if (!clientId) return { ok: false, reason: 'client-required' };
    var readiness = options.skipFeatureGate ? { ok: true } : featureReady();
    if (!readiness.ok) return readiness;
    if (!root.Store || !root.Store.getClient || !root.Store.getClient(clientId)) return { ok: false, reason: 'client-not-found' };
    if (!root.CaseSpaceViewModel || typeof root.CaseSpaceViewModel.refresh !== 'function') return { ok: false, reason: 'source-projection-unavailable' };
    if (!root.ClinicalContext || typeof root.ClinicalContext.createSnapshot !== 'function') return { ok: false, reason: 'clinical-context-unavailable' };

    var projection = await root.CaseSpaceViewModel.refresh(clientId, { currentContext: { clientId: clientId }, signal: options.signal });
    var model = projection && projection.ok === true ? projection.model : null;
    if (!model || model.clientId !== clientId) return { ok: false, reason: 'source-projection-' + text(projection && projection.code || 'unavailable') };
    var entries = modelReferences(clientId, model);
    if (!entries.length) return { ok: false, reason: 'no-verified-sources', model: model };

    var taskSpec = root.ClinicalContext.getTaskSpec && root.ClinicalContext.getTaskSpec('growth-summary');
    if (!taskSpec || taskSpec.outputMode !== 'preview-only') return { ok: false, reason: 'task-registry-unavailable' };
    var references = entries.map(function (entry) { return entry.reference; });
    var sources = entries.map(function (entry, index) {
      var cut = clip(entry.material.extractedText, MAX_SOURCE_CHARS);
      entry.cut = cut;
      return Object.freeze({
        kind: 'material', id: entry.materialId, label: '已验证材料 ' + String(index + 1), chars: cut.chars, truncated: cut.truncated,
        clientId: clientId, sessionId: entry.sessionId, normalizationVersion: entry.reference.normalizationVersion,
        sourceVersion: entry.reference.sourceVersion, sourceContentHash: entry.reference.sourceContentHash,
        anchorContentHash: entry.reference.anchorContentHash, status: entry.reference.status
      });
    });
    var selectedSessionIds = unique(entries.map(function (entry) { return entry.sessionId; })).sort();
    var blocks = entries.map(function (entry) {
      return '[节点=' + entry.nodeId + '；来源=' + entry.sourceId + '；会谈=' + entry.sessionId + ']\n' + entry.cut.text;
    });
    var context = {
      task: 'growth-summary',
      taskSpec: taskSpec,
      outputMode: taskSpec.outputMode,
      origin: { clientId: clientId, sessionId: '', materialId: '', supervisionId: '' },
      selectedSessionIds: selectedSessionIds,
      sources: sources,
      material: null
    };
    var admission = root.ClinicalContext.validateSources('growth-summary', sources, context.origin);
    if (!admission.ok) return admission;
    var input = blocks.join('\n\n');
    context.snapshot = root.ClinicalContext.createSnapshot(context, input);
    context.input = input;
    context.references = references;
    context.referenceKey = referenceKey(clientId, references);
    context.messages = messageTemplate(references, blocks);
    return { ok: true, context: context, model: model };
  }
  async function isCurrent(context) {
    if (!context || !context.origin || !context.origin.clientId) return false;
    // A preview cannot outlive the feature or compute authorization that admitted it.
    var next = await prepare(context.origin.clientId);
    if (!next.ok) return false;
    if (!root.ClinicalContext.isSnapshotCurrent(context.snapshot, next.context.input, {
      clientId: context.origin.clientId,
      selectedSessionIds: context.selectedSessionIds
    })) return false;
    return next.context.referenceKey === context.referenceKey;
  }
  function parsePreview(raw, context) {
    var parsed;
    try {
      parsed = JSON.parse(text(raw).replace(/^```json\s*/i, '').replace(/```\s*$/i, ''));
    } catch (error) {
      return { ok: false, reason: 'invalid-json' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'invalid-shape' };
    var summary = clip(parsed.summary, MAX_SUMMARY_CHARS).text;
    if (!summary) return { ok: false, reason: 'summary-missing' };
    var allowed = Object.create(null);
    (context && context.references || []).forEach(function (reference) { allowed[sourceKey(reference)] = reference; });
    var citations = [];
    var seen = Object.create(null);
    var rawCitations = Array.isArray(parsed.citations) ? parsed.citations : [];
    if (!rawCitations.length) return { ok: false, reason: 'citation-missing' };
    for (var index = 0; index < rawCitations.length; index++) {
      var citation = rawCitations[index] || {};
      var key = sourceKey({ nodeId: text(citation.nodeId), sourceId: text(citation.sourceId), sessionId: text(citation.sessionId) });
      if (!allowed[key] || seen[key]) return { ok: false, reason: !allowed[key] ? 'citation-unknown' : 'citation-duplicate' };
      seen[key] = true;
      citations.push(allowed[key]);
    }
    var changes = (Array.isArray(parsed.changes) ? parsed.changes : []).slice(0, 8).map(function (change) {
      change = change || {};
      return { title: clip(change.title, 120).text, detail: clip(change.detail, MAX_CHANGE_CHARS).text };
    }).filter(function (change) { return change.title && change.detail; });
    return { ok: true, preview: Object.freeze({ mode: 'preview-only', kind: 'growth-summary-preview', summary: summary, changes: Object.freeze(changes), citations: Object.freeze(citations) }) };
  }
  function createPreviewActionRun(context) {
    if (!context || context.task !== 'growth-summary' || context.outputMode !== 'preview-only') return null;
    return root.ClinicalContext.createActionRun(context);
  }
  function completePreviewActionRun(id, preview) {
    if (!preview || preview.mode !== 'preview-only') return null;
    return root.ClinicalContext.completeActionRun(id, { kind: 'growth-summary-preview', summary: preview.summary, changes: preview.changes, citations: preview.citations });
  }

  var api = Object.freeze({ prepare: prepare, isCurrent: isCurrent, parsePreview: parsePreview, createPreviewActionRun: createPreviewActionRun, completePreviewActionRun: completePreviewActionRun });
  root.LongitudinalSummary = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
