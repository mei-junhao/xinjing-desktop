'use strict';
/**
 * XJ-4.3.0-opensquilla-long-source-graph-integration-harness-01
 * Source-Graph Projection: deterministic read-only multi-client projection.
 * Uses REAL production SourceRef for all source identity/hashing.
 * All nodes/edges carry stable source identity + disposition.
 * No persistence. No mutation of input fixtures. Deep copies only.
 */
const path = require('path');
const SourceRef = require(path.resolve('D:\\xinjing-electron\\design-previews\\4.3.0-opensquilla-atlas-integration', '..', '..', 'app', 'js', 'source-ref.js'));

function isString(v) { return typeof v === 'string' && v.length > 0; }
function deepCopy(obj) {
  if (obj === null || obj === undefined) return obj;
  return JSON.parse(JSON.stringify(obj));
}

function createNode(opts) {
  if (!opts.clientId || !opts.sessionId) throw new Error('createNode: clientId and sessionId required');
  var sourceRef = SourceRef.create({
    clientId: opts.clientId,
    sessionId: opts.sessionId,
    anchor: { kind: opts.kind || 'unknown', locator: opts.locator || opts.objectId || '', fragment: opts.fragment || '' },
    sourceText: opts.sourceText || '',
    anchorText: opts.anchorText
  });
  return {
    id: 'node:' + opts.clientId + ':' + opts.sessionId + ':' + (opts.kind || 'unknown') + ':' + (opts.locator || opts.objectId || ''),
    type: opts.type || 'observation',
    sourceKind: opts.kind || 'unknown',
    sourceObjectId: opts.objectId || '',
    clientId: opts.clientId,
    sessionId: opts.sessionId,
    label: opts.label || '',
    summary: opts.summary || '',
    truncated: !!opts.truncated,
    sourceRef: sourceRef,
    isAiDraft: !!opts.isAiDraft,
    isConfirmed: !opts.isAiDraft
  };
}

function validateViewModel(vm) {
  if (!vm) return { ok: false, issues: ['vm is null'] };
  var issues = [];
  if (!Array.isArray(vm.nodes)) issues.push('nodes is not array');
  if (!Array.isArray(vm.edges)) issues.push('edges is not array');
  if (vm.nodes) {
    if (vm.nodes.length === 0) issues.push('nodes is empty');
    vm.nodes.forEach(function (node, i) {
      if (!node.id) issues.push('node[' + i + '].id missing');
      if (!node.clientId) issues.push('node[' + i + '].clientId missing');
      if (!node.sessionId) issues.push('node[' + i + '].sessionId missing');
      if (!node.sourceRef) issues.push('node[' + i + '].sourceRef missing');
      if (node.sourceRef) {
        if (!isString(node.sourceRef.id)) issues.push('node[' + i + '].sourceRef.id missing or invalid');
        if (!isString(node.sourceRef.sourceContentHash)) issues.push('node[' + i + '].sourceRef.sourceContentHash missing');
        if (!isString(node.sourceRef.anchorContentHash)) issues.push('node[' + i + '].sourceRef.anchorContentHash missing');
        if (!isString(node.sourceRef.normalizationVersion)) issues.push('node[' + i + '].sourceRef.normalizationVersion missing');
        if (!isString(node.sourceRef.sourceVersion)) issues.push('node[' + i + '].sourceRef.sourceVersion missing');
      }
      var validTypes = ['quote', 'observation', 'record', 'supervision', 'plan', 'risk'];
      if (validTypes.indexOf(node.type) < 0) issues.push('node[' + i + '].type invalid: ' + node.type);
    });
  }
  if (vm.edges) {
    vm.edges.forEach(function (edge, i) {
      if (!edge.id) issues.push('edge[' + i + '].id missing');
      if (!edge.from) issues.push('edge[' + i + '].from missing');
      if (!edge.to) issues.push('edge[' + i + '].to missing');
      if (!edge.relation) issues.push('edge[' + i + '].relation missing');
    });
    var aiEdges = vm.edges.filter(function (e) { return e.isAi || e.previewOnly; });
    aiEdges.forEach(function (e) {
      if (e.isConfirmed) issues.push('AI edge ' + e.id + ' marked confirmed — must remain preview-only');
    });
  }
  return { ok: issues.length === 0, issues: issues };
}

function createViewModel(fixtures) {
  if (!fixtures || !fixtures.clients || !fixtures.sessions) throw new Error('createViewModel: invalid fixtures');
  var timeline = fixtures.sessions.slice().sort(function (a, b) {
    return (a.date || '').localeCompare(b.date || '');
  }).map(function (s) {
    return { id: s.id, sessionNumber: s.sessionNumber, date: s.date, clientId: s.clientId, hasTranscript: !!s.hasTranscript, hasSoap: !!(s.soap && s.soap.subjective) };
  });
  var nodes = fixtures.nodes ? fixtures.nodes.map(deepCopy) : [];
  var edges = fixtures.edges ? fixtures.edges.map(deepCopy) : [];
  var aiPreviewEdges = edges.filter(function (e) { return e.isAi || e.previewOnly; });
  aiPreviewEdges.forEach(function (e) { e.isConfirmed = false; });
  var clientProjections = {};
  fixtures.clients.forEach(function (client) {
    var clientNodes = nodes.filter(function (n) { return n.clientId === client.id; });
    var nodeIds = {};
    clientNodes.forEach(function (n) { nodeIds[n.id] = true; });
    var clientEdges = edges.filter(function (e) { return nodeIds[e.from] && nodeIds[e.to] && !e.isAi && !e.previewOnly; });
    var clientAiEdges = edges.filter(function (e) { return nodeIds[e.from] && nodeIds[e.to] && (e.isAi || e.previewOnly); });
    clientProjections[client.id] = { clientId: client.id, clientName: client.name, nodes: clientNodes, edges: clientEdges, aiPreviewEdges: clientAiEdges, nodeCount: clientNodes.length, edgeCount: clientEdges.length };
  });
  return { nodes: nodes, edges: edges, aiPreviewEdges: aiPreviewEdges, timeline: timeline, clientProjections: clientProjections, stats: { totalNodes: nodes.length, totalEdges: edges.length, aiPreviewCount: aiPreviewEdges.length, clientCount: fixtures.clients.length, sessionCount: fixtures.sessions.length } };
}

function filterNodes(nodes, opts) {
  opts = opts || {};
  var result = (nodes || []).slice();
  if (opts.type) result = result.filter(function (n) { return n.type === opts.type; });
  if (opts.clientId) result = result.filter(function (n) { return n.clientId === opts.clientId; });
  if (opts.search) {
    var q = opts.search.toLowerCase();
    result = result.filter(function (n) { return (n.label || '').toLowerCase().indexOf(q) >= 0 || (n.summary || '').toLowerCase().indexOf(q) >= 0; });
  }
  if (opts.confirmedOnly) result = result.filter(function (n) { return !n.isAiDraft && n.isConfirmed; });
  return result;
}

function createSnapshot(fixtures, clientId) {
  var client = fixtures.clients.find(function (c) { return c.id === clientId; });
  if (!client) return null;
  var clientSessions = fixtures.sessions.filter(function (s) { return s.clientId === clientId; });
  var sessionVersions = {};
  clientSessions.forEach(function (s) { sessionVersions[s.id] = s.updatedAt || s.date || ''; });
  var clientMaterials = fixtures.materials.filter(function (m) { return m.clientId === clientId; });
  var clientSupervisions = fixtures.supervisions.filter(function (s) { return s.clientId === clientId; });
  var clientActions = fixtures.actionDrafts.filter(function (a) { return a.clientId === clientId; });
  return {
    clientId: clientId,
    normalizationVersion: SourceRef.NORMALIZATION_VERSION,
    sourceVersion: SourceRef.SOURCE_VERSION,
    sessionVersions: sessionVersions,
    materialUpdatedAt: clientMaterials.length > 0 ? clientMaterials[0].updatedAt : '',
    supervisionUpdatedAt: clientSupervisions.length > 0 ? clientSupervisions[0].updatedAt : '',
    actionDraftUpdatedAt: clientActions.length > 0 ? clientActions[0].updatedAt : '',
    generation: Date.now()
  };
}

function verifyCrossClientIsolation(clientId, fixtures) {
  var vm = createViewModel(fixtures);
  var projection = vm.clientProjections[clientId];
  if (!projection) return { ok: false, reason: 'unknown-client' };
  var leaked = projection.nodes.filter(function (n) { return n.clientId !== clientId; });
  if (leaked.length > 0) return { ok: false, reason: 'cross-client-leak', leakedCount: leaked.length, leakedIds: leaked.map(function (n) { return n.id; }) };
  return { ok: true, nodeCount: projection.nodes.length };
}

function verifyAiEdgeRejection(adapter) {
  var aiEdge = { id: 'edge_ai_test', isAi: true, previewOnly: true, from: 'n1', to: 'n2', relation: 'AI 推论' };
  var humanEdge = { id: 'edge_human_test', from: 'n1', to: 'n2', relation: '支持' };
  var results = { aiEdge: adapter.persistAiEdge(aiEdge), humanEdge: adapter.persistHumanEdge(humanEdge), edge: adapter.persistEdge(aiEdge), projection: adapter.persistProjection({}), graph: adapter.saveGraph({}), commit: adapter.commitEdge(aiEdge), flush: adapter.flushCache() };
  var allRejected = Object.keys(results).every(function (k) { return results[k].rejected === true && results[k].ok === false; });
  return { ok: allRejected, results: results };
}

module.exports = {
  createNode: createNode,
  validateViewModel: validateViewModel,
  createViewModel: createViewModel,
  filterNodes: filterNodes,
  createSnapshot: createSnapshot,
  deepCopy: deepCopy,
  verifyCrossClientIsolation: verifyCrossClientIsolation,
  verifyAiEdgeRejection: verifyAiEdgeRejection,
  SourceRef: SourceRef
};
