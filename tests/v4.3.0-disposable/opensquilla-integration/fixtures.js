'use strict';
/**
 * XJ-4.3.0-opensquilla-long-source-graph-integration-harness-01
 * Multi-client synthetic fixtures for source-graph projection validation.
 * All data is synthetic. No real clinical data.
 */
const path = require('path');
const SourceRef = require(path.resolve(__dirname, '..', '..', '..', 'app', 'js', 'source-ref.js'));

function sha(s) { return SourceRef.sha256(s); }

// ── Client A: 20 sessions (anxiety → adaptation → growth) ──
const clientA = {
  id: 'synth-client-alpha',
  name: '案例甲（合成）',
  status: 'active',
  gender: 'unspecified',
  notes: '合成来访者甲，20节长程个案',
  createdAt: '2025-09-01T08:00:00+08:00',
  updatedAt: '2026-03-15T10:00:00+08:00'
};

const sessionsA = [];
for (let i = 1; i <= 20; i++) {
  const hasTx = i % 3 !== 0; // sessions 3,6,9,12,15,18 have no transcript
  sessionsA.push({
    id: 'synth-sess-A' + String(i).padStart(2, '0'),
    sessionNumber: i,
    date: '2025-' + String(9 + Math.floor((i - 1) / 4)).padStart(2, '0') + '-' + String(((i - 1) % 4) * 7 + 8).padStart(2, '0'),
    durationMinutes: 50,
    type: 'individual',
    recordKind: 'clinical',
    transcript: hasTx ? '合成：第' + i + '节会谈逐字稿内容，来访者表达了各种情绪体验。' : '',
    hasTranscript: hasTx,
    soap: {
      subjective: '第' + i + '节主观描述',
      objective: '第' + i + '节客观观察',
      assessment: '第' + i + '节评估',
      plan: '第' + i + '节计划'
    },
    notes: '第' + i + '节过程记录',
    billing: { fee: 400, paid: i <= 18 },
    updatedAt: '2026-01-' + String(i).padStart(2, '0') + 'T10:00:00+08:00'
  });
}

// ── Client B: 18 sessions (depression → recovery) ──
const clientB = {
  id: 'synth-client-beta',
  name: '案例甲（合成）', // INTENTIONAL NAME COLLISION with clientA for collision testing
  status: 'active',
  gender: 'unspecified',
  notes: '合成来访者乙，18节个案，显示名与甲相同',
  createdAt: '2025-10-01T08:00:00+08:00',
  updatedAt: '2026-04-20T10:00:00+08:00'
};

const sessionsB = [];
for (let i = 1; i <= 18; i++) {
  const hasTx = i % 4 !== 0;
  sessionsB.push({
    id: 'synth-sess-B' + String(i).padStart(2, '0'),
    sessionNumber: i,
    date: '2025-' + String(10 + Math.floor((i - 1) / 4)).padStart(2, '0') + '-' + String(((i - 1) % 4) * 7 + 8).padStart(2, '0'),
    durationMinutes: 50,
    type: 'individual',
    recordKind: 'clinical',
    transcript: hasTx ? '合成：乙第' + i + '节逐字稿，描述抑郁情绪变化。' : '',
    hasTranscript: hasTx,
    soap: {
      subjective: '乙第' + i + '节主观',
      objective: '乙第' + i + '节客观',
      assessment: '乙第' + i + '节评估',
      plan: '乙第' + i + '节计划'
    },
    notes: '乙第' + i + '节记录',
    billing: { fee: 500, paid: true },
    updatedAt: '2026-02-' + String(i).padStart(2, '0') + 'T10:00:00+08:00'
  });
}

// ── Client C: 16 sessions (relational trauma → boundary work) ──
const clientC = {
  id: 'synth-client-gamma',
  name: '案例丙（合成）',
  status: 'active',
  gender: 'unspecified',
  notes: '合成来访者丙，16节关系创伤个案',
  createdAt: '2025-11-01T08:00:00+08:00',
  updatedAt: '2026-05-10T10:00:00+08:00'
};

const sessionsC = [];
for (let i = 1; i <= 16; i++) {
  const hasTx = i % 5 !== 0;
  sessionsC.push({
    id: 'synth-sess-C' + String(i).padStart(2, '0'),
    sessionNumber: i,
    date: '2025-' + String(11 + Math.floor((i - 1) / 4)).padStart(2, '0') + '-' + String(((i - 1) % 4) * 7 + 8).padStart(2, '0'),
    durationMinutes: 50,
    type: 'individual',
    recordKind: 'clinical',
    transcript: hasTx ? '合成：丙第' + i + '节逐字稿，探讨关系模式。' : '',
    hasTranscript: hasTx,
    soap: {
      subjective: '丙第' + i + '节主观',
      objective: '丙第' + i + '节客观',
      assessment: '丙第' + i + '节评估',
      plan: '丙第' + i + '节计划'
    },
    notes: '丙第' + i + '节记录',
    billing: { fee: 450, paid: i <= 14 },
    updatedAt: '2026-03-' + String(i).padStart(2, '0') + 'T10:00:00+08:00'
  });
}

// ── Materials (collision-prone anchors across clients) ──
const materials = [
  { id: 'mat-A-01', clientId: clientA.id, sessionId: sessionsA[0].id, title: '初始评估材料', content: '来访者甲初始评估内容', updatedAt: '2026-01-05T10:00:00+08:00' },
  { id: 'mat-A-05', clientId: clientA.id, sessionId: sessionsA[4].id, title: '中期材料', content: '甲中期阻抗分析', updatedAt: '2026-01-10T10:00:00+08:00' },
  { id: 'mat-B-01', clientId: clientB.id, sessionId: sessionsB[0].id, title: '初始评估材料', content: '来访者乙初始评估', updatedAt: '2026-02-01T10:00:00+08:00' },
  { id: 'mat-B-03', clientId: clientB.id, sessionId: sessionsB[2].id, title: '风险评估', content: '乙风险评估内容', updatedAt: '2026-02-05T10:00:00+08:00' },
  { id: 'mat-C-01', clientId: clientC.id, sessionId: sessionsC[0].id, title: '初始评估材料', content: '丙初始关系创伤评估', updatedAt: '2026-03-01T10:00:00+08:00' },
  { id: 'mat-CROSS-01', clientId: clientB.id, sessionId: sessionsA[2].id, title: '跨来访者材料（异常）', content: 'clientId=B但sessionId属于A', updatedAt: '2026-03-02T10:00:00+08:00' }
];

// ── Supervisions ──
const supervisions = [
  { id: 'sup-A-01', clientId: clientA.id, sessionId: sessionsA[2].id, content: '甲督导：阻抗与移情讨论', date: '2025-10-01', supervisorName: '督导者X', updatedAt: '2026-01-03T10:00:00+08:00' },
  { id: 'sup-A-02', clientId: clientA.id, sessionId: sessionsA[9].id, content: '甲督导：中期评估', date: '2025-12-01', supervisorName: '督导者X', updatedAt: '2026-01-08T10:00:00+08:00' },
  { id: 'sup-B-01', clientId: clientB.id, sessionId: sessionsB[1].id, content: '乙督导：用药评估讨论', date: '2025-11-01', supervisorName: '督导者Y', updatedAt: '2026-02-03T10:00:00+08:00' },
  { id: 'sup-C-01', clientId: clientC.id, sessionId: sessionsC[3].id, content: '丙督导：边界议题', date: '2025-12-01', supervisorName: '督导者Z', updatedAt: '2026-03-05T10:00:00+08:00' }
];

// ── Clinical Action Drafts ──
const actionDrafts = [
  { id: 'act-A-01', clientId: clientA.id, sessionId: sessionsA[0].id, title: '建议阅读自助材料', status: 'completed', dueRange: '下节', updatedAt: '2026-01-02T10:00:00+08:00' },
  { id: 'act-A-02', clientId: clientA.id, sessionId: sessionsA[5].id, title: '情绪日记作业', status: 'pending', dueRange: '今天', updatedAt: '2026-01-06T10:00:00+08:00' },
  { id: 'act-B-01', clientId: clientB.id, sessionId: sessionsB[0].id, title: '转介精神科评估', status: 'pending', dueRange: '明天', updatedAt: '2026-02-02T10:00:00+08:00' },
  { id: 'act-C-01', clientId: clientC.id, sessionId: sessionsC[2].id, title: '边界练习作业', status: 'completed', dueRange: '下节', updatedAt: '2026-03-03T10:00:00+08:00' }
];

// ── Build source nodes from fixture data ──
function buildNodes(clients, allSessions, mats, sups, acts) {
  var nodes = [];
  var nodeMap = {};
  function addNode(opts) {
    var ref = SourceRef.create({
      clientId: opts.clientId,
      sessionId: opts.sessionId,
      anchor: { kind: opts.kind, locator: opts.locator, fragment: opts.fragment || '' },
      sourceText: opts.sourceText,
      anchorText: opts.anchorText
    });
    var node = {
      id: 'node:' + opts.clientId + ':' + opts.sessionId + ':' + opts.kind + ':' + opts.locator,
      type: opts.type,
      sourceKind: opts.kind,
      sourceObjectId: opts.objectId,
      clientId: opts.clientId,
      sessionId: opts.sessionId,
      label: opts.label,
      summary: opts.summary,
      truncated: opts.truncated || false,
      sourceRef: ref,
      isAiDraft: opts.isAiDraft || false,
      isConfirmed: !opts.isAiDraft
    };
    nodeMap[node.id] = node;
    nodes.push(node);
  }

  clients.forEach(function (client) {
    var clientSessions = allSessions.filter(function (s) { return s.clientId === client.id || s.id.indexOf(client.id.split('-').pop()) >= 0; });
    // Use sessions explicitly assigned to this client
    clientSessions = allSessions.filter(function (s) {
      return s.id.indexOf(client.id.replace('synth-client-', '').toUpperCase().substring(0, 1)) >= 0;
    });
  });

  // Quote nodes from transcripts
  allSessions.forEach(function (s) {
    if (s.transcript && s.transcript.trim()) {
      var cid = s.id.charAt(s.id.indexOf('-') + 1) === 'A' ? clientA.id : s.id.charAt(s.id.indexOf('-') + 1) === 'B' ? clientB.id : clientC.id;
      addNode({
        clientId: cid, sessionId: s.id, kind: 'transcript', locator: s.id, type: 'quote',
        objectId: s.id, label: '第' + s.sessionNumber + '节原话片段', summary: s.transcript.slice(0, 80),
        sourceText: s.transcript, anchorText: s.transcript.slice(0, 40)
      });
    }
  });

  // Observation nodes from SOAP
  allSessions.forEach(function (s) {
    if (s.soap && s.soap.subjective) {
      var cid = s.id.charAt(s.id.indexOf('-') + 1) === 'A' ? clientA.id : s.id.charAt(s.id.indexOf('-') + 1) === 'B' ? clientB.id : clientC.id;
      addNode({
        clientId: cid, sessionId: s.id, kind: 'soap', locator: s.id, type: 'observation',
        objectId: s.id, label: '第' + s.sessionNumber + '节过程观察', summary: s.soap.objective.slice(0, 80),
        sourceText: JSON.stringify(s.soap), anchorText: s.soap.assessment
      });
    }
  });

  // Record nodes from notes
  allSessions.forEach(function (s) {
    if (s.notes) {
      var cid = s.id.charAt(s.id.indexOf('-') + 1) === 'A' ? clientA.id : s.id.charAt(s.id.indexOf('-') + 1) === 'B' ? clientB.id : clientC.id;
      addNode({
        clientId: cid, sessionId: s.id, kind: 'notes', locator: s.id, type: 'record',
        objectId: s.id, label: '第' + s.sessionNumber + '节咨询记录', summary: s.notes.slice(0, 80),
        sourceText: s.notes, anchorText: s.notes.slice(0, 40)
      });
    }
  });

  // Supervision nodes
  sups.forEach(function (sup) {
    addNode({
      clientId: sup.clientId, sessionId: sup.sessionId, kind: 'supervision', locator: sup.id, type: 'supervision',
      objectId: sup.id, label: '督导：' + (sup.supervisorName || ''), summary: sup.content.slice(0, 80),
      sourceText: sup.content, anchorText: sup.content.slice(0, 40)
    });
  });

  // Plan nodes from action drafts
  acts.forEach(function (act) {
    addNode({
      clientId: act.clientId, sessionId: act.sessionId, kind: 'action', locator: act.id, type: 'plan',
      objectId: act.id, label: '后续动作：' + act.title, summary: act.title,
      sourceText: act.title, anchorText: act.title
    });
  });

  // Risk nodes (from select materials)
  mats.forEach(function (m) {
    if (m.title.indexOf('风险') >= 0) {
      addNode({
        clientId: m.clientId, sessionId: m.sessionId, kind: 'material', locator: m.id, type: 'risk',
        objectId: m.id, label: '风险记录：' + m.title, summary: m.content.slice(0, 80),
        sourceText: m.content, anchorText: m.content.slice(0, 40)
      });
    }
  });

  return nodes;
}

// ── Edges (source chain: quote → observation → record → supervision → action) ──
function buildEdges(nodes) {
  var edges = [];
  // Group by client+session
  var groups = {};
  nodes.forEach(function (n) {
    var key = n.clientId + ':' + n.sessionId;
    if (!groups[key]) groups[key] = [];
    groups[key].push(n);
  });

  Object.keys(groups).forEach(function (key) {
    var group = groups[key];
    var chain = { quote: null, observation: null, record: null, supervision: null, plan: null, risk: null };
    group.forEach(function (n) { if (chain[n.type]) chain[n.type] = n; else chain[n.type] = n; });

    var order = ['quote', 'observation', 'record', 'supervision', 'plan'];
    for (var i = 0; i < order.length - 1; i++) {
      if (chain[order[i]] && chain[order[i + 1]]) {
        edges.push({
          id: 'edge:' + chain[order[i]].id + '->' + chain[order[i + 1]].id,
          from: chain[order[i]].id,
          to: chain[order[i + 1]].id,
          relation: i === 0 ? '引用' : i === 1 ? '支持' : i === 2 ? '延续' : '产生动作',
          previewOnly: false,
          isAi: false
        });
      }
    }
  });

  // One AI preview edge (in-memory only, never persisted)
  if (nodes.length > 2) {
    edges.push({
      id: 'edge_ai_preview_001',
      from: nodes[0].id,
      to: nodes[Math.min(1, nodes.length - 1)].id,
      relation: 'AI 推论（预览）',
      previewOnly: true,
      isAi: true,
      confidence: 0.72
    });
  }

  return edges;
}

// ── All sessions combined ──
var allSessions = sessionsA.concat(sessionsB).concat(sessionsC);

// ── Assign clientId to each session ──
allSessions.forEach(function (s) {
  if (s.id.indexOf('A') >= 0 && s.id.indexOf('synth-sess-A') === 0) s.clientId = clientA.id;
  else if (s.id.indexOf('B') >= 0 && s.id.indexOf('synth-sess-B') === 0) s.clientId = clientB.id;
  else if (s.id.indexOf('C') >= 0 && s.id.indexOf('synth-sess-C') === 0) s.clientId = clientC.id;
});

var nodes = buildNodes([clientA, clientB, clientC], allSessions, materials, supervisions, actionDrafts);
var edges = buildEdges(nodes);

// ── 12 negative fixtures ──
var negativeFixtures = {
  cases: [
    { id: 'neg-01', name: 'unknown-client', input: { clientId: 'nonexistent', sessionId: 'synth-sess-A01' }, expect: 'fail-closed' },
    { id: 'neg-02', name: 'unknown-session', input: { clientId: clientA.id, sessionId: 'nonexistent' }, expect: 'fail-closed' },
    { id: 'neg-03', name: 'cross-client-material', input: { clientId: clientA.id, materialId: 'mat-B-01' }, expect: 'fail-closed' },
    { id: 'neg-04', name: 'cross-session-anchor', input: { clientId: clientA.id, sessionId: sessionsA[0].id, materialId: 'mat-A-05' }, expect: 'fail-closed' },
    { id: 'neg-05', name: 'missing-sourcerec-hash', input: { sourceRef: { clientId: clientA.id, sessionId: sessionsA[0].id, sourceContentHash: '' } }, expect: 'invalid' },
    { id: 'neg-06', name: 'malformed-hash', input: { sourceRef: { clientId: clientA.id, sessionId: sessionsA[0].id, sourceContentHash: 'NOT-A-HASH' } }, expect: 'invalid' },
    { id: 'neg-07', name: 'mismatched-anchor', input: { clientId: clientA.id, sessionId: sessionsA[0].id, anchor: { kind: 'wrong', locator: 'wrong' } }, expect: 'ambiguous' },
    { id: 'neg-08', name: 'legacy-reference', input: { sourceRef: { clientId: clientA.id, sessionId: sessionsA[0].id, schemaVersion: '' } }, expect: 'legacy-unverified' },
    { id: 'neg-09', name: 'cross-client-name-collision', input: { clientId: clientB.id, displayName: clientA.name }, expect: 'fail-closed-without-leak' },
    { id: 'neg-10', name: 'cross-client-supervision', input: { clientId: clientA.id, supervisionId: 'sup-B-01' }, expect: 'fail-closed' },
    { id: 'neg-11', name: 'cross-client-action-draft', input: { clientId: clientB.id, actionId: 'act-A-01' }, expect: 'fail-closed' },
    { id: 'neg-12', name: 'cross-client-deep-link', input: { clientId: clientC.id, sessionId: sessionsA[0].id }, expect: 'fail-closed' }
  ]
};

module.exports = {
  SourceRef: SourceRef,
  clients: [clientA, clientB, clientC],
  sessions: allSessions,
  materials: materials,
  supervisions: supervisions,
  actionDrafts: actionDrafts,
  nodes: nodes,
  edges: edges,
  negativeFixtures: negativeFixtures,
  sessionCount: allSessions.length,
  clientCount: 3,
  negativeCount: negativeFixtures.cases.length
};
