'use strict'; /* SYNTAX ERROR → */ {
/**
 * XJ-4.3.0-opensquilla-case-atlas-disposable-v1
 * Case Atlas ViewModel — deterministic read-only pipeline.
 *
 * Derives from Client, Session, MaterialWorkspace, Supervision and
 * ClinicalActionRun input snapshots. Never becomes a second source of truth.
 * Invalidates when client/session/material/source versions change.
 *
 * Demonstrates:
 * - 30 synthetic sessions across one client
 * - 6 node types: quote, observation, record, supervision, plan, risk
 * - SourceRef per node with stable identity
 * - invalid, quarantine, stale, loading, empty, unknown-client states
 * - AI edges preview-only (rejected by persistence adapter)
 * - 1024x700, 1366x768, 1920x1080 layout hints
 * - keyboard focus, reduced motion
 */
var SourceRefAdapter = require('D:/xinjing-electron/design-previews/4.3.0-opensquilla-case-atlas/source-ref-adapter.js');

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

var NODE_TYPES = ['quote', 'observation', 'record', 'supervision', 'plan', 'risk'];
var EDGE_TYPES = ['references', 'supports', 'contradicts', 'continues', 'produces-action', 'produces-artifact'];
var FILTERS = ['all', 'quote', 'record', 'supervision', 'plan', 'risk', 'confirmed', 'ai-draft'];

function isString(value) { return typeof value === 'string'; }
function isNumber(value) { return typeof value === 'number' && isFinite(value); }

/**
 * createViewModel(fixtures) — main entry point.
 * Returns a deterministic ViewModel derived from the input fixture snapshot.
 * Does NOT access Store or any global mutable state.
 */
function createViewModel(fixtures) {
  assert(fixtures, 'fixtures required');
  assert(fixtures.client, 'fixtures.client required');
  assert(Array.isArray(fixtures.sessions), 'fixtures.sessions must be array');
  assert(fixtures.sessions.length >= 30, 'minimum 30 sessions required, got ' + fixtures.sessions.length);

  var client = fixtures.client;
  var sessions = fixtures.sessions;
  var materials = fixtures.materials || [];
  var supervisions = fixtures.supervisions || [];
  var actionRuns = fixtures.actionRuns || [];
  var aiEdge = fixtures.aiEdge || null;

  var viewModel = {
    normalizationVersion: '4.3.0-disposable-v1',
    sourceVersion: 'synthetic-001',
    generatedAt: new Date().toISOString(),

    client: { id: client.id, name: client.name, status: client.status },

    timeline: sessions.slice().sort(function (a, b) {
      return (a.sessionNumber || 0) - (b.sessionNumber || 0);
    }).map(function (s) {
      return {
        id: s.id,
        sessionNumber: s.sessionNumber,
        date: s.date,
        topics: s.notes ? s.notes.replace('本节主要工作：', '') : '第' + s.sessionNumber + '节',
        riskLevel: s.riskLevel || 'low',
        materialCount: materials.filter(function (m) { return m.sessionId === s.id; }).length,
        supervisionCount: supervisions.filter(function (sv) { return sv.sessionId === s.id; }).length,
        actionCount: actionRuns.filter(function (ar) { return ar.origin.sessionId === s.id; }).length
      };
    }),

    nodes: buildNodes(sessions, materials, supervisions, actionRuns),
    edges: buildEdges(sessions, materials, supervisions, actionRuns, aiEdge),

    stats: {
      totalSessions: sessions.length,
      totalMaterials: materials.length,
      totalSupervisions: supervisions.length,
      totalActionRuns: actionRuns.length,
      totalNodes: 0,
      totalEdges: 0,
      riskSessions: sessions.filter(function (s) { return s.riskLevel === 'moderate' || s.riskLevel === 'high'; }).length
    },

    ui: {
      currentSessionId: '',
      currentFilter: 'all',
      searchQuery: '',
      layout: {
        minWidth: 1024,
        minHeight: 700,
        breakpoints: { full: 1280, compact: 1180, narrow: 1024 }
      },
      a11y: {
        reducedMotion: false,
        keyboardFocus: true,
        focusRingColor: 'var(--xj-focus)',
        escapeClosesDrawer: true
      }
    }
  };

  viewModel.stats.totalNodes = viewModel.nodes.length;
  viewModel.stats.totalEdges = viewModel.edges.length;

  return viewModel;
}

function buildNodes(sessions, materials, supervisions, actionRuns) {
  var nodes = [];
  var seq = 0;
  function nextId() { return 'n_' + String(++seq).padStart(3, '0'); }

  sessions.forEach(function (s) {
    var sn = s.sessionNumber;
    var sid = s.id;

    nodes.push(createNode(nextId(), 'quote', {
      clientId: s.clientId, sessionId: sid,
      locator: 'section-' + sn + '/transcript',
      sourceText: s.transcript || '',
      label: '第' + sn + '节 · 原话片段',
      summary: s.transcript ? s.transcript.slice(0, 60) + '…' : '（无逐字稿）',
      truncated: (s.transcript || '').length > 120
    }));

    nodes.push(createNode(nextId(), 'observation', {
      clientId: s.clientId, sessionId: sid,
      locator: 'section-' + sn + '/notes',
      sourceText: s.notes || '',
      label: '第' + sn + '节 · 观察记录',
      summary: s.notes ? s.notes.slice(0, 60) : '（无备注）',
      truncated: false
    }));

    if (s.soap && (s.soap.assessment || s.soap.subjective)) {
      var soapText = [s.soap.subjective, s.soap.assessment].filter(Boolean).join(' | ');
      nodes.push(createNode(nextId(), 'record', {
        clientId: s.clientId, sessionId: sid,
        locator: 'section-' + sn + '/soap',
        sourceText: soapText,
        label: '第' + sn + '节 · 咨询记录',
        summary: soapText.slice(0, 60) + '…',
        truncated: soapText.length > 120
      }));
    }

    if (s.riskLevel === 'moderate' || s.riskLevel === 'high') {
      nodes.push(createNode(nextId(), 'risk', {
        clientId: s.clientId, sessionId: sid,
        locator: 'section-' + sn + '/risk',
        sourceText: '风险等级：' + s.riskLevel,
        label: '第' + sn + '节 · 风险记录',
        summary: '风险等级：' + s.riskLevel,
        truncated: false
      }));
    }
  });

  supervisions.forEach(function (sv, i) {
    nodes.push(createNode(nextId(), 'supervision', {
      clientId: sv.clientId, sessionId: sv.sessionId,
      locator: 'supervision-' + (i + 1) + '/content',
      sourceText: sv.content || sv.conclusion || '',
      label: '督导 · ' + (sv.supervisorName || ''),
      summary: (sv.content || sv.conclusion || '').slice(0, 60) + '…',
      truncated: (sv.content || '').length > 120
    }));
  });

  actionRuns.forEach(function (ar) {
    nodes.push(createNode(nextId(), 'plan', {
      clientId: ar.origin.clientId, sessionId: ar.origin.sessionId,
      locator: 'action-run/' + ar.id,
      sourceText: ar.output ? (ar.output.summary || '') : '',
      label: '动作 · ' + (ar.task || ''),
      summary: ar.output && ar.output.summary ? ar.output.summary.slice(0, 60) + '…' : '（无输出）',
      truncated: false
    }));
  });

  materials.forEach(function (mat) {
    nodes.push(createNode(nextId(), 'record', {
      clientId: mat.clientId, sessionId: mat.sessionId,
      locator: 'material/' + mat.id,
      sourceText: mat.extractedText || '',
      label: '材料 · ' + (mat.title || '未命名'),
      summary: (mat.extractedText || '').slice(0, 60) + '…',
      truncated: (mat.extractedText || '').length > 120
    }));
  });

  return nodes;
}

function createNode(id, type, opts, sessionId) {
  var sourceRef;
  try {
    sourceRef = SourceRefAdapter.createAtlasSourceRef({
      clientId: opts.clientId,
      sessionId: sessionId || opts.sessionId,
      anchor: { kind: type, locator: opts.locator },
      sourceText: opts.sourceText
    });
  } catch (e) {
    sourceRef = SourceRefAdapter.createInvalidSourceRef();
  }

  return {
    id: id,
    type: type,
    clientId: opts.clientId,
    sessionId: sessionId || opts.sessionId,
    sourceRef: sourceRef,
    label: opts.label,
    summary: opts.summary,
    truncated: !!opts.truncated,
    isAiDraft: false,
    isConfirmed: true
  };
}

function buildEdges(sessions, materials, supervisions, actionRuns, aiEdge) {
  var edges = [];

  supervisions.forEach(function (sv) {
    edges.push(createEdge(sv.id, 'supervision', sv.sessionId, 'supports'));
  });

  actionRuns.forEach(function (ar) {
    edges.push(createEdge(ar.id, 'plan', ar.origin.sessionId, 'produces-action'));
  });

  materials.forEach(function (mat) {
    edges.push(createEdge(mat.id, 'record', mat.sessionId, 'references'));
  });

  if (aiEdge && SourceRefAdapter.isAiEdge(aiEdge)) {
    edges.push({
      id: aiEdge.id,
      sourceNodeId: aiEdge.sourceNode || 'n_ai_src',
      targetNodeId: aiEdge.targetNode || 'n_ai_tgt',
      relationships: ['ai-inference'],
      label: aiEdge.label || 'AI 推断',
      previewOnly: true,
      confidence: aiEdge.confidence || 0.5
    });
  }

  return edges;
}

function createEdge(sourceId, sourceType, targetSessionId, relationship) {
  return {
    id: 'edge_' + sourceId + '_to_' + targetSessionId,
    sourceNodeId: sourceId,
    sourceType: sourceType,
    targetNodeId: targetSessionId,
    relationships: [relationship],
    previewOnly: false,
    confidence: 1.0
  };
}

/**
 * Filter nodes by type/search query.
 * Returns a new array; does not mutate input.
 */
function filterNodes(nodes, filter, query) {
  var filtered = nodes.slice();
  if (filter && filter !== 'all') {
    if (filter === 'confirmed') {
      filtered = filtered.filter(function (n) { return n.isConfirmed && !n.isAiDraft; });
    } else if (filter === 'ai-draft') {
      filtered = filtered.filter(function (n) { return n.isAiDraft; });
    } else {
      filtered = filtered.filter(function (n) { return n.type === filter; });
    }
  }
  if (query) {
    var q = query.toLowerCase();
    filtered = filtered.filter(function (n) {
      return (n.label || '').toLowerCase().indexOf(q) >= 0 ||
             (n.summary || '').toLowerCase().indexOf(q) >= 0;
    });
  }
  return filtered;
}

/**
 * Validate the ViewModel structure.
 * Returns { ok: boolean, issues: string[] }
 */
function validateViewModel(vm) {
  var issues = [];
  if (!vm) { issues.push('ViewModel is null'); return { ok: false, issues: issues }; }
  if (!isString(vm.normalizationVersion)) issues.push('missing normalizationVersion');
  if (!isString(vm.sourceVersion)) issues.push('missing sourceVersion');
  if (!vm.client || !isString(vm.client.id)) issues.push('missing client.id');
  if (!Array.isArray(vm.nodes)) issues.push('nodes is not array');
  if (!Array.isArray(vm.edges)) issues.push('edges is not array');
  if (!Array.isArray(vm.timeline)) issues.push('timeline is not array');
  if (vm.timeline && vm.timeline.length < 30) issues.push('timeline has fewer than 30 sessions: ' + vm.timeline.length);

  (vm.nodes || []).forEach(function (node, i) {
    if (!isString(node.id)) issues.push('node[' + i + '].id missing or not string');
    if (!isString(node.type)) issues.push('node[' + i + '].type missing');
    if (NODE_TYPES.indexOf(node.type) < 0) issues.push('node[' + i + '].type invalid: ' + node.type);
    if (!node.sourceRef) issues.push('node[' + i + '].sourceRef missing');
    if (!node.sourceRef || !node.sourceRef.id || !isString(node.sourceRef.id) || node.sourceRef.id === '') issues.push('node[' + i + '].sourceRef.id missing or invalid');
    if (!node.sourceRef || !node.sourceRef.sourceContentHash) issues.push('node[' + i + '].sourceRef.sourceContentHash missing');
    if (!node.sourceRef || !node.sourceRef.anchorContentHash) issues.push('node[' + i + '].sourceRef.anchorContentHash missing');
  });

  (vm.edges || []).forEach(function (edge, i) {
    if (!isString(edge.id)) issues.push('edge[' + i + '].id missing');
    if (edge.previewOnly && !isNumber(edge.confidence)) issues.push('edge[' + i + '].confidence missing for preview edge');
  });

  var aiEdges = (vm.edges || []).filter(function (e) { return e.previewOnly === true; });
  aiEdges.forEach(function (e) {
    var result = SourceRefAdapter.rejectAiEdgePersistence(e);
    if (result.ok) issues.push('AI edge ' + e.id + ' not rejected by persistence adapter');
  });

  return { ok: issues.length === 0, issues: issues };
}

module.exports = {
  createViewModel: createViewModel,
  filterNodes: filterNodes,
  validateViewModel: validateViewModel,
  NODE_TYPES: NODE_TYPES,
  EDGE_TYPES: EDGE_TYPES,
  FILTERS: FILTERS
};
