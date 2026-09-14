'use strict';
/**
 * XJ-4.3.0-opensquilla-source-graph-goal-loop-01
 * Goal-loop fixtures: 3 clients × 30 sessions = 90 sessions, 240+ nodes, 48+ negative cases.
 * All data synthetic. No real clinical data.
 * Uses REAL production SourceRef and source-graph projection/adapter.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SourceRef = require(path.resolve(ROOT, 'app', 'js', 'source-ref.js'));
const PROJ = require(path.resolve(ROOT, 'design-previews', '4.3.0-opensquilla-atlas-integration', 'source-graph-projection.js'));
const ADAPTER = require(path.resolve(ROOT, 'design-previews', '4.3.0-opensquilla-atlas-integration', 'source-boundary-adapter.js'));

function sha(s) { return SourceRef.sha256(s); }

// ── 3 clients ──
const clientA = { id: 'synth-client-alpha', name: '来访者甲（合成）', status: 'active', gender: 'unspecified', notes: '合成长程个案，30节', createdAt: '2025-09-01T08:00:00+08:00', updatedAt: '2026-05-01T10:00:00+08:00' };
const clientB = { id: 'synth-client-beta', name: '来访者甲（合成）', status: 'active', gender: 'unspecified', notes: 'INTENTIONAL NAME COLLISION with clientA', createdAt: '2025-10-01T08:00:00+08:00', updatedAt: '2026-05-01T10:00:00+08:00' };
const clientC = { id: 'synth-client-gamma', name: '来访者丙（合成）', status: 'active', gender: 'unspecified', notes: '合成关系创伤个案，30节', createdAt: '2025-11-01T08:00:00+08:00', updatedAt: '2026-05-01T10:00:00+08:00' };

// ── 90 sessions (30 per client) ──
function buildSessions(client, prefix, count) {
  var sessions = [];
  for (var i = 1; i <= count; i++) {
    var hasTx = i % 3 !== 0;
    sessions.push({
      id: prefix + String(i).padStart(2, '0'),
      sessionNumber: i,
      date: '2025-' + String(9 + Math.floor((i-1)/4)).padStart(2,'0') + '-' + String(((i-1)%4)*7+8).padStart(2,'0'),
      durationMinutes: 50, type: 'individual', recordKind: 'clinical',
      transcript: hasTx ? '合成第' + i + '节逐字稿内容。来访者表达了情绪体验。' : '',
      hasTranscript: hasTx,
      soap: { subjective: '第' + i + '节主观', objective: '第' + i + '节客观', assessment: '第' + i + '节评估', plan: '第' + i + '节计划' },
      notes: '第' + i + '节记录', billing: { fee: 400, paid: i <= 28 },
      clientId: client.id, updatedAt: '2026-0' + (3 + Math.floor(i/10)) + '-' + String(i).padStart(2,'0') + 'T10:00:00+08:00'
    });
  }
  return sessions;
}
var sessionsA = buildSessions(clientA, 'synth-sess-A', 30);
var sessionsB = buildSessions(clientB, 'synth-sess-B', 30);
var sessionsC = buildSessions(clientC, 'synth-sess-C', 30);
var allSessions = sessionsA.concat(sessionsB).concat(sessionsC);

// ── Materials (12) ──
var materials = [
  { id: 'mat-A-01', clientId: clientA.id, sessionId: 'synth-sess-A01', title: '初始评估', content: '来访者甲初始评估内容', updatedAt: '2026-01-05T10:00:00+08:00' },
  { id: 'mat-A-02', clientId: clientA.id, sessionId: 'synth-sess-A10', title: '中期评估', content: '甲中期阻抗分析', updatedAt: '2026-01-10T10:00:00+08:00' },
  { id: 'mat-A-03', clientId: clientA.id, sessionId: 'synth-sess-A20', title: '进展总结', content: '甲进展总结', updatedAt: '2026-02-01T10:00:00+08:00' },
  { id: 'mat-A-04', clientId: clientA.id, sessionId: 'synth-sess-A25', title: '风险评估', content: '甲风险评估内容', updatedAt: '2026-02-15T10:00:00+08:00' },
  { id: 'mat-B-01', clientId: clientB.id, sessionId: 'synth-sess-B01', title: '初始评估', content: '来访者乙初始评估', updatedAt: '2026-02-01T10:00:00+08:00' },
  { id: 'mat-B-02', clientId: clientB.id, sessionId: 'synth-sess-B08', title: '风险评估', content: '乙风险评估内容', updatedAt: '2026-02-05T10:00:00+08:00' },
  { id: 'mat-B-03', clientId: clientB.id, sessionId: 'synth-sess-B15', title: '中期评估', content: '乙中期评估', updatedAt: '2026-03-01T10:00:00+08:00' },
  { id: 'mat-B-04', clientId: clientB.id, sessionId: 'synth-sess-B22', title: '转介评估', content: '乙转介评估', updatedAt: '2026-03-15T10:00:00+08:00' },
  { id: 'mat-C-01', clientId: clientC.id, sessionId: 'synth-sess-C01', title: '初始评估', content: '丙初始关系创伤评估', updatedAt: '2026-03-01T10:00:00+08:00' },
  { id: 'mat-C-02', clientId: clientC.id, sessionId: 'synth-sess-C10', title: '中期评估', content: '丙中期评估', updatedAt: '2026-03-15T10:00:00+08:00' },
  { id: 'mat-C-03', clientId: clientC.id, sessionId: 'synth-sess-C20', title: '边界评估', content: '丙边界评估', updatedAt: '2026-04-01T10:00:00+08:00' },
  { id: 'mat-CROSS-01', clientId: clientB.id, sessionId: 'synth-sess-A05', title: '跨来访者材料', content: 'clientId=B但sessionId属于A', updatedAt: '2026-03-02T10:00:00+08:00' }
];

// ── Supervisions (8) ──
var supervisions = [
  { id: 'sup-A-01', clientId: clientA.id, sessionId: 'synth-sess-A03', content: '甲督导：阻抗与移情讨论', date: '2025-10-01', supervisorName: '督导者X', updatedAt: '2026-01-03T10:00:00+08:00' },
  { id: 'sup-A-02', clientId: clientA.id, sessionId: 'synth-sess-A15', content: '甲督导：中期评估', date: '2025-12-01', supervisorName: '督导者X', updatedAt: '2026-01-08T10:00:00+08:00' },
  { id: 'sup-A-03', clientId: clientA.id, sessionId: 'synth-sess-A25', content: '甲督导：结案评估', date: '2026-02-01', supervisorName: '督导者X', updatedAt: '2026-02-10T10:00:00+08:00' },
  { id: 'sup-B-01', clientId: clientB.id, sessionId: 'synth-sess-B02', content: '乙督导：用药评估讨论', date: '2025-11-01', supervisorName: '督导者Y', updatedAt: '2026-02-03T10:00:00+08:00' },
  { id: 'sup-B-02', clientId: clientB.id, sessionId: 'synth-sess-B12', content: '乙督导：中期评估', date: '2026-01-01', supervisorName: '督导者Y', updatedAt: '2026-03-01T10:00:00+08:00' },
  { id: 'sup-C-01', clientId: clientC.id, sessionId: 'synth-sess-C04', content: '丙督导：边界议题', date: '2025-12-01', supervisorName: '督导者Z', updatedAt: '2026-03-05T10:00:00+08:00' },
  { id: 'sup-C-02', clientId: clientC.id, sessionId: 'synth-sess-C15', content: '丙督导：关系模式', date: '2026-02-01', supervisorName: '督导者Z', updatedAt: '2026-04-01T10:00:00+08:00' },
  { id: 'sup-C-03', clientId: clientC.id, sessionId: 'synth-sess-C25', content: '丙督导：结案评估', date: '2026-03-01', supervisorName: '督导者Z', updatedAt: '2026-05-01T10:00:00+08:00' }
];

// ── Action drafts (8) ──
var actionDrafts = [
  { id: 'act-A-01', clientId: clientA.id, sessionId: 'synth-sess-A01', title: '建议阅读自助材料', status: 'completed', dueRange: '下节', updatedAt: '2026-01-02T10:00:00+08:00' },
  { id: 'act-A-02', clientId: clientA.id, sessionId: 'synth-sess-A10', title: '情绪日记作业', status: 'pending', dueRange: '今天', updatedAt: '2026-01-06T10:00:00+08:00' },
  { id: 'act-A-03', clientId: clientA.id, sessionId: 'synth-sess-A20', title: '放松练习', status: 'completed', dueRange: '明天', updatedAt: '2026-02-01T10:00:00+08:00' },
  { id: 'act-B-01', clientId: clientB.id, sessionId: 'synth-sess-B01', title: '转介精神科评估', status: 'pending', dueRange: '明天', updatedAt: '2026-02-02T10:00:00+08:00' },
  { id: 'act-B-02', clientId: clientB.id, sessionId: 'synth-sess-B10', title: '行为激活计划', status: 'completed', dueRange: '下节', updatedAt: '2026-02-15T10:00:00+08:00' },
  { id: 'act-C-01', clientId: clientC.id, sessionId: 'synth-sess-C03', title: '边界练习作业', status: 'completed', dueRange: '下节', updatedAt: '2026-03-03T10:00:00+08:00' },
  { id: 'act-C-02', clientId: clientC.id, sessionId: 'synth-sess-C12', title: '关系模式记录', status: 'pending', dueRange: '下节', updatedAt: '2026-03-20T10:00:00+08:00' },
  { id: 'act-C-03', clientId: clientC.id, sessionId: 'synth-sess-C22', title: '情绪调节练习', status: 'completed', dueRange: '今天', updatedAt: '2026-04-10T10:00:00+08:00' }
];

// ── Build source nodes ──
function buildNodes(clients, allSessions, mats, sups, acts) {
  var nodes = [];
  function addNode(opts) {
    var ref = SourceRef.create({
      clientId: opts.clientId, sessionId: opts.sessionId,
      anchor: { kind: opts.kind, locator: opts.locator, fragment: opts.fragment || '' },
      sourceText: opts.sourceText, anchorText: opts.anchorText
    });
    nodes.push({
      id: 'node:' + opts.clientId + ':' + opts.sessionId + ':' + opts.kind + ':' + opts.locator,
      type: opts.type, sourceKind: opts.kind, sourceObjectId: opts.objectId || '',
      clientId: opts.clientId, sessionId: opts.sessionId,
      label: opts.label || '', summary: opts.summary || '', truncated: !!opts.truncated,
      sourceRef: ref, isAiDraft: !!opts.isAiDraft, isConfirmed: !opts.isAiDraft
    });
  }
  allSessions.forEach(function (s) {
    if (s.transcript && s.transcript.trim()) {
      addNode({ clientId: s.clientId, sessionId: s.id, kind: 'transcript', locator: s.id, type: 'quote', objectId: s.id, label: '第' + s.sessionNumber + '节原话', summary: s.transcript.slice(0, 80), sourceText: s.transcript, anchorText: s.transcript.slice(0, 40) });
    }
  });
  allSessions.forEach(function (s) {
    if (s.soap && s.soap.subjective) {
      addNode({ clientId: s.clientId, sessionId: s.id, kind: 'soap', locator: s.id, type: 'observation', objectId: s.id, label: '第' + s.sessionNumber + '节观察', summary: s.soap.objective.slice(0, 80), sourceText: JSON.stringify(s.soap), anchorText: s.soap.assessment });
    }
  });
  allSessions.forEach(function (s) {
    if (s.notes) {
      addNode({ clientId: s.clientId, sessionId: s.id, kind: 'notes', locator: s.id, type: 'record', objectId: s.id, label: '第' + s.sessionNumber + '节记录', summary: s.notes.slice(0, 80), sourceText: s.notes, anchorText: s.notes.slice(0, 40) });
    }
  });
  sups.forEach(function (sup) {
    addNode({ clientId: sup.clientId, sessionId: sup.sessionId, kind: 'supervision', locator: sup.id, type: 'supervision', objectId: sup.id, label: '督导：' + (sup.supervisorName || ''), summary: sup.content.slice(0, 80), sourceText: sup.content, anchorText: sup.content.slice(0, 40) });
  });
  acts.forEach(function (act) {
    addNode({ clientId: act.clientId, sessionId: act.sessionId, kind: 'action', locator: act.id, type: 'plan', objectId: act.id, label: '动作：' + act.title, summary: act.title, sourceText: act.title, anchorText: act.title });
  });
  mats.forEach(function (m) {
    if (m.title.indexOf('风险') >= 0) {
      addNode({ clientId: m.clientId, sessionId: m.sessionId, kind: 'material', locator: m.id, type: 'risk', objectId: m.id, label: '风险：' + m.title, summary: m.content.slice(0, 80), sourceText: m.content, anchorText: m.content.slice(0, 40) });
    }
  });
  return nodes;
}

// ── Build edges ──
function buildEdges(nodes) {
  var edges = [];
  var groups = {};
  nodes.forEach(function (n) { var k = n.clientId + ':' + n.sessionId; if (!groups[k]) groups[k] = []; groups[k].push(n); });
  Object.keys(groups).forEach(function (key) {
    var g = groups[key], chain = { quote: null, observation: null, record: null, supervision: null, plan: null };
    g.forEach(function (n) { if (chain.hasOwnProperty(n.type)) chain[n.type] = n; });
    var order = ['quote', 'observation', 'record', 'supervision', 'plan'];
    for (var i = 0; i < order.length - 1; i++) {
      if (chain[order[i]] && chain[order[i + 1]]) {
        edges.push({ id: 'edge:' + chain[order[i]].id + '->' + chain[order[i + 1]].id, from: chain[order[i]].id, to: chain[order[i + 1]].id, relation: i === 0 ? '引用' : i === 1 ? '支持' : i === 2 ? '延续' : '产生动作', previewOnly: false, isAi: false });
      }
    }
  });
  for (var j = 0; j < 3; j++) {
    if (nodes.length > j * 2 + 1) {
      edges.push({ id: 'edge_ai_' + (j + 1), from: nodes[j * 2].id, to: nodes[j * 2 + 1].id, relation: 'AI 推论（预览）', previewOnly: true, isAi: true, confidence: 0.6 + j * 0.1 });
    }
  }
  return edges;
}

var nodes = buildNodes([clientA, clientB, clientC], allSessions, materials, supervisions, actionDrafts);
var edges = buildEdges(nodes);

// ── 48 negative cases (4 per goal × 12 goals) ──
var negativeCases = [
  { id: 'neg-G01-01', goal: 'G01', name: 'missing-clientId', input: { clientId: '', sessionId: 'synth-sess-A01' }, expect: 'fail-closed' },
  { id: 'neg-G01-02', goal: 'G01', name: 'missing-sessionId', input: { clientId: clientA.id, sessionId: '' }, expect: 'fail-closed' },
  { id: 'neg-G01-03', goal: 'G01', name: 'cross-client-session', input: { clientId: clientA.id, sessionId: 'synth-sess-B01' }, expect: 'fail-closed' },
  { id: 'neg-G01-04', goal: 'G01', name: 'null-subject', input: { clientId: null, sessionId: null }, expect: 'fail-closed' },
  { id: 'neg-G02-01', goal: 'G02', name: 'missing-sourceContentHash', input: { sourceRef: { id: 'x', clientId: clientA.id, sessionId: 'synth-sess-A01', sourceContentHash: '' } }, expect: 'invalid' },
  { id: 'neg-G02-02', goal: 'G02', name: 'missing-anchorContentHash', input: { sourceRef: { id: 'x', clientId: clientA.id, sessionId: 'synth-sess-A01', sourceContentHash: 'h', anchorContentHash: '' } }, expect: 'invalid' },
  { id: 'neg-G02-03', goal: 'G02', name: 'missing-normalizationVersion', input: { sourceRef: { id: 'x', clientId: clientA.id, sessionId: 'synth-sess-A01', sourceContentHash: 'h', anchorContentHash: 'h', normalizationVersion: '' } }, expect: 'invalid' },
  { id: 'neg-G02-04', goal: 'G02', name: 'malformed-id', input: { sourceRef: { id: 'not-sr-prefix', clientId: clientA.id, sessionId: 'synth-sess-A01', sourceContentHash: 'h', anchorContentHash: 'h' } }, expect: 'invalid' },
  { id: 'neg-G03-01', goal: 'G03', name: 'source-changed-stale', input: { ref: nodes[0].sourceRef, newSourceText: 'changed content' }, expect: 'stale' },
  { id: 'neg-G03-02', goal: 'G03', name: 'anchor-changed', input: { ref: nodes[0].sourceRef, newAnchorText: 'changed anchor' }, expect: 'stale' },
  { id: 'neg-G03-03', goal: 'G03', name: 'source-and-anchor-changed', input: { ref: nodes[0].sourceRef, newSourceText: 'changed', newAnchorText: 'changed' }, expect: 'stale' },
  { id: 'neg-G03-04', goal: 'G03', name: 'old-snapshot-version', input: { ref: nodes[0].sourceRef, normalizationVersion: '0' }, expect: 'stale' },
  { id: 'neg-G04-01', goal: 'G04', name: 'expired-snapshot', input: { snapshot: { generation: 1 }, currentGeneration: 100 }, expect: 'stale' },
  { id: 'neg-G04-02', goal: 'G04', name: 'client-switched-during-async', input: { snapshot: { clientId: clientA.id }, currentClientId: clientB.id }, expect: 'stale' },
  { id: 'neg-G04-03', goal: 'G04', name: 'stale-async-result', input: { asyncResult: { generation: 1 }, currentGeneration: 5 }, expect: 'stale' },
  { id: 'neg-G04-04', goal: 'G04', name: 'null-snapshot', input: { snapshot: null }, expect: 'invalid' },
  { id: 'neg-G05-01', goal: 'G05', name: 'cross-client-node', input: { clientId: clientA.id, nodeId: nodes.filter(function(n){return n.clientId===clientB.id})[0].id }, expect: 'fail-closed' },
  { id: 'neg-G05-02', goal: 'G05', name: 'cross-client-material', input: { clientId: clientA.id, materialId: 'mat-B-01' }, expect: 'fail-closed' },
  { id: 'neg-G05-03', goal: 'G05', name: 'cross-client-session', input: { clientId: clientA.id, sessionId: 'synth-sess-C01' }, expect: 'fail-closed' },
  { id: 'neg-G05-04', goal: 'G05', name: 'cross-client-deep-link', input: { clientId: clientC.id, sessionId: 'synth-sess-A01' }, expect: 'fail-closed' },
  { id: 'neg-G06-01', goal: 'G06', name: 'unknown-client-quarantine', input: { clientId: 'unknown-client', sessionId: 'synth-sess-A01' }, expect: 'quarantined' },
  { id: 'neg-G06-02', goal: 'G06', name: 'unknown-session-quarantine', input: { clientId: clientA.id, sessionId: 'unknown-session' }, expect: 'quarantined' },
  { id: 'neg-G06-03', goal: 'G06', name: 'malformed-record', input: { sourceRef: { clientId: '', sessionId: '' } }, expect: 'quarantined' },
  { id: 'neg-G06-04', goal: 'G06', name: 'old-source-version', input: { sourceRef: { id: 'x', clientId: clientA.id, sessionId: 'synth-sess-A01', sourceVersion: '0', sourceContentHash: 'h', anchorContentHash: 'h' } }, expect: 'quarantined' },
  { id: 'neg-G07-01', goal: 'G07', name: 'broken-chain', input: { edges: [{ from: 'missing-node', to: nodes[0].id, relation: '引用' }] }, expect: 'invalid' },
  { id: 'neg-G07-02', goal: 'G07', name: 'correlation-as-causation', input: { edge: { from: nodes[0].id, to: nodes[2].id, relation: '导致' } }, expect: 'warning' },
  { id: 'neg-G07-03', goal: 'G07', name: 'missing-relation', input: { edge: { from: nodes[0].id, to: nodes[1].id } }, expect: 'invalid' },
  { id: 'neg-G07-04', goal: 'G07', name: 'self-loop', input: { edge: { from: nodes[0].id, to: nodes[0].id, relation: '引用' } }, expect: 'invalid' },
  { id: 'neg-G08-01', goal: 'G08', name: 'ai-edge-confirmed', input: { edge: { id: 'ai', isAi: true, isConfirmed: true }, check: 'isConfirmed' }, expect: 'fail-closed' },
  { id: 'neg-G08-02', goal: 'G08', name: 'ai-edge-persisted', input: { edge: { id: 'ai', isAi: true }, action: 'persistEdge' }, expect: 'rejected' },
  { id: 'neg-G08-03', goal: 'G08', name: 'ai-edge-in-human-projection', input: { clientId: clientA.id, edgeType: 'ai-in-human' }, expect: 'fail-closed' },
  { id: 'neg-G08-04', goal: 'G08', name: 'ai-edge-cross-session', input: { edge: { id: 'ai', isAi: true, from: nodes[0].id, to: nodes.filter(function(n){return n.sessionId!==nodes[0].sessionId})[0].id } }, expect: 'fail-closed' },
  { id: 'neg-G09-01', goal: 'G09', name: 'duplicate-node', input: { node1: nodes[0], node2: nodes[0] }, expect: 'idempotent' },
  { id: 'neg-G09-02', goal: 'G09', name: 'out-of-order-result', input: { results: [{ seq: 2 }, { seq: 1 }] }, expect: 'reordered' },
  { id: 'neg-G09-03', goal: 'G09', name: 'replay-identical', input: { action: 'replay', original: nodes[0].id, replay: nodes[0].id }, expect: 'idempotent' },
  { id: 'neg-G09-04', goal: 'G09', name: 'concurrent-overwrite', input: { writes: [{ ts: 1 }, { ts: 2, overwrite: true }] }, expect: 'last-write-wins' },
  { id: 'neg-G10-01', goal: 'G10', name: 'timeout', input: { action: 'resolve', timeout: true }, expect: 'timeout' },
  { id: 'neg-G10-02', goal: 'G10', name: 'cancel-mid-operation', input: { action: 'cancel', partial: true }, expect: 'cancelled' },
  { id: 'neg-G10-03', goal: 'G10', name: 'partial-failure', input: { results: [{ ok: true }, { ok: false }] }, expect: 'partial' },
  { id: 'neg-G10-04', goal: 'G10', name: 'swallowed-error', input: { action: 'fail', catch: 'empty' }, expect: 'error-preserved' },
  { id: 'neg-G11-01', goal: 'G11', name: 'projection-mutated-input', input: { vm: { clients: [clientA], sessions: allSessions, nodes: nodes, edges: edges }, mutate: true }, expect: 'unaltered' },
  { id: 'neg-G11-02', goal: 'G11', name: 'cross-page-reference-leak', input: { fromPage: 'clientA', toPage: 'clientB', ref: nodes[0].id }, expect: 'fail-closed' },
  { id: 'neg-G11-03', goal: 'G11', name: 'stale-cache', input: { cache: { generation: 1 }, current: { generation: 5 } }, expect: 'invalidated' },
  { id: 'neg-G11-04', goal: 'G11', name: 'no-business-data-copy', input: { projection: { clientId: clientA.id }, copy: 'deep' }, expect: 'deep-copy' },
  { id: 'neg-G12-01', goal: 'G12', name: 'mismatched-iteration-sha', input: { iteration: 1, sha: 'wrong' }, expect: 'mismatch' },
  { id: 'neg-G12-02', goal: 'G12', name: 'stale-contract-ref', input: { contractId: 'XJ-4.3.0-source-graph-goal-loop-v0' }, expect: 'stale' },
  { id: 'neg-G12-03', goal: 'G12', name: 'missing-write-lock', input: { lockId: 'nonexistent' }, expect: 'missing' },
  { id: 'neg-G12-04', goal: 'G12', name: 'report-path-not-absolute', input: { reportPath: 'qa/agent-reviews/relative.md' }, expect: 'false' }
];

// ── 96 scenario bundles (8 per goal × 12 goals) ──
function buildScenarios() {
  var bundles = [];
  for (var g = 1; g <= 12; g++) {
    for (var s = 1; s <= 8; s++) {
      bundles.push({
        id: 'scn-G' + String(g).padStart(2, '0') + '-' + s,
        goal: 'G' + String(g).padStart(2, '0'),
        scenario: s,
        description: 'Goal ' + g + ' scenario ' + s,
        positive: s <= 4,
        focus: s <= 4 ? 'happy-path' : s <= 6 ? 'boundary' : 'negative'
      });
    }
  }
  return bundles;
}

module.exports = {
  SourceRef: SourceRef,
  PROJ: PROJ,
  ADAPTER: ADAPTER,
  clients: [clientA, clientB, clientC],
  sessions: allSessions,
  materials: materials,
  supervisions: supervisions,
  actionDrafts: actionDrafts,
  nodes: nodes,
  edges: edges,
  negativeCases: negativeCases,
  scenarioBundles: buildScenarios(),
  sessionCount: allSessions.length,
  nodeCount: nodes.length,
  edgeCount: edges.length,
  clientCount: 3,
  negativeCount: negativeCases.length,
  scenarioBundleCount: 96,
  REAL: {
    base_commit: '9971787eb6e443ab5a5c80aee118b9b43285c093',
    plan_sha256: 'E95F8F973846ECE9C4B4E8082874B7931F565034252FC4B2D1792446361DA861',
    protected_manifest_sha256: 'E83AAE7BC0B3AE5E8127F9815D0FBA3DF80F925353ACC9112B18F70633DB76BC'
  }
};
