'use strict';
/*
 * 4.3.0 OpenSquilla Production Contract Freeze — Synthesis Fixtures
 *
 * Generates deterministic synthetic data covering:
 *   - 1 client + 1 adversarial client
 *   - 54 sessions (30 minimum for prototype + extras for edge cases)
 *   - Materials with all failure states (valid, invalid, expired, quarantine, broken-link)
 *   - Supervisions, ClinicalActionRun drafts
 *   - AI edges (preview-only)
 *   - SourceRef with full 6-field contract per CodeBuddy rework-02
 *   - Source version history for stale snapshot testing
 *
 * ALL data is synthetic. No real clinical, financial or personal data.
 * Hashes computed via real crypto.createHash — never fabricated.
 */

const crypto = require('crypto');

const NORMALIZATION_VERSION = '1.0.0';
const SOURCE_VERSION = '2026-07-prod-contract';
const RECOGNIZED_STATUSES = ['valid', 'invalid', 'quarantine', 'expired'];

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function makeSourceRef(opts) {
  const content = opts.content != null ? String(opts.content) : '';
  const anchor = opts.anchor != null ? String(opts.anchor) : content;
  const ref = {
    id: opts.stableId,
    normalizationVersion: NORMALIZATION_VERSION,
    sourceVersion: opts.sourceVersion || SOURCE_VERSION,
    sourceContentHash: sha256(content),
    anchorContentHash: sha256(anchor),
    status: opts.status || 'valid',
  };
  ref._testOnly = { content: content, anchor: anchor };
  return ref;
}

// ---- Client ----
const CLIENT = {
  id: 'cli-prod-0001',
  displayName: '合成来访者·生产契约（匿名长程）',
  normalizationVersion: NORMALIZATION_VERSION,
};

const OTHER_CLIENT = {
  id: 'cli-prod-9999',
  displayName: '合成来访者·对抗（仅跨个案测试）',
  normalizationVersion: NORMALIZATION_VERSION,
};

// ---- Sessions (54 total: 30 minimum for prototype + extras for edge cases) ----
const SESSIONS = [];
for (let i = 1; i <= 54; i++) {
  const date = new Date(Date.UTC(2026, 0, 5 + (i - 1) * 7)).toISOString().slice(0, 10);
  const title = '第' + i + '节·生产契约合成会谈（匿名样本 ' + i + '/54）';
  const summary = '合成摘要：本节聚焦认知行为议题，记录情绪反应与应对策略。第 ' + i + ' 节匿名合成样本，不含真实个案信息。';
  const src = 'session-' + i + '-' + date + '-' + title;
  const sr = makeSourceRef({
    stableId: 'sr-ses-prod-0001-' + String(i).padStart(2, '0'),
    sourceVersion: SOURCE_VERSION,
    content: src,
    status: 'valid',
  });
  // Session 12: source version history for stale snapshot testing
  if (i === 12) {
    sr.sourceHistory = [
      { sourceVersion: '2026-06-10', sourceContentHash: sha256(src + ':old'), status: 'superseded' },
      { sourceVersion: sr.sourceVersion, sourceContentHash: sr.sourceContentHash, status: 'current' },
    ];
  }
  SESSIONS.push({
    id: 'ses-prod-0001-' + String(i).padStart(2, '0'),
    clientId: CLIENT.id,
    index: i,
    date: date,
    title: title,
    summary: summary,
    materialIds: [],
    supervisionRefIds: [],
    clinicalActionDraftIds: [],
    sourceRef: sr,
  });
}

// ---- Materials (8: various states) ----
function mat(id, title, resolvedContent, sourceVersion, status) {
  return {
    id: id,
    title: title,
    resolvedContent: resolvedContent,
    sourceRef: makeSourceRef({
      stableId: 'sr-' + id,
      sourceVersion: sourceVersion,
      content: resolvedContent,
      anchor: resolvedContent,
      status: status,
    }),
  };
}

const MATERIALS = [
  mat('mat-prod-0001', '合成依恋量表（匿名）', '依恋量表合成内容-A', '2026-07-01', 'valid'),
  mat('mat-prod-0002', '合成认知三角记录', '认知三角合成内容-B', '2026-07-02', 'valid'),
  mat('mat-prod-0003', '合成家庭图（已失效待复核）', '家庭图合成内容-C', '2026-05-30', 'invalid'),
  mat('mat-prod-0004', '合成创伤时间线（隔离）', '创伤时间线合成内容-D', '2026-04-15', 'quarantine'),
  mat('mat-prod-0005', '合成童年叙事（已过期来源）', '童年叙事合成内容-E', '2025-12-01', 'expired'),
  mat('mat-prod-0006', '合成风险评估表', '风险评估合成内容-F', '2026-07-03', 'valid'),
  mat('mat-prod-0007', '合成督导反馈', '督导反馈合成内容-G', '2026-07-04', 'valid'),
  // Broken-link material: anchorContentHash does not match resolvedContent
  (function () {
    var m = mat('mat-prod-0008', '合成断链材料（锚点不匹配）', '断链合成内容-H', '2026-07-05', 'valid');
    m.sourceRef._testOnly.anchor = 'mat-0008-content-DANGLING';
    m.sourceRef.anchorContentHash = sha256('mat-0008-content-DANGLING');
    return m;
  })(),
];

// ---- Supervisions ----
const SUPERVISION = [
  {
    id: 'sup-prod-0001',
    title: '第1次个体督导（合成）',
    sessionId: SESSIONS[0].id,
    sourceRef: makeSourceRef({ stableId: 'sr-sup-prod-0001', sourceVersion: '2026-07-10', content: 'supervision-1', status: 'valid' }),
  },
  {
    id: 'sup-prod-0002',
    title: '第2次团体督导（合成）',
    sessionId: SESSIONS[11].id,
    sourceRef: makeSourceRef({ stableId: 'sr-sup-prod-0002', sourceVersion: '2026-07-20', content: 'supervision-2', status: 'valid' }),
  },
];

// ---- Clinical Action Drafts ----
const CLINICAL_ACTION_DRAFTS = [
  {
    clinicalActionRunId: 'car-prod-0001',
    sessionId: SESSIONS[4].id,
    status: 'draft',
    note: '合成临床动作草稿：布置行为实验',
    sourceRef: makeSourceRef({ stableId: 'sr-car-prod-0001', sourceVersion: '2026-07-12', content: 'car-1', status: 'valid' }),
  },
  {
    clinicalActionRunId: 'car-prod-0002',
    sessionId: SESSIONS[17].id,
    status: 'draft',
    note: '合成临床动作草稿：复发预防计划',
    sourceRef: makeSourceRef({ stableId: 'sr-car-prod-0002', sourceVersion: '2026-07-22', content: 'car-2', status: 'valid' }),
  },
];

// ---- Wire materials/supervisions/drafts to sessions ----
SESSIONS[0].materialIds.push('mat-prod-0001');
SESSIONS[0].supervisionRefIds.push('sup-prod-0001');
SESSIONS[4].clinicalActionDraftIds.push('car-prod-0001');
SESSIONS[11].materialIds.push('mat-prod-0003');
SESSIONS[11].supervisionRefIds.push('sup-prod-0002');
SESSIONS[17].clinicalActionDraftIds.push('car-prod-0002');
SESSIONS[20].materialIds.push('mat-prod-0008'); // broken-link

// ---- Adversarial samples ----
const ADVERSARIAL = {
  missingHashSourceRef: (function () {
    var r = makeSourceRef({ stableId: 'sr-bad-0001', sourceVersion: '2026-07-01', content: 'bad-1' });
    delete r.sourceContentHash;
    return r;
  })(),
  wrongClientSession: (function () {
    var s = JSON.parse(JSON.stringify(SESSIONS[1]));
    s.clientId = OTHER_CLIENT.id;
    return s;
  })(),
  otherClient: OTHER_CLIENT,
  unknownClientId: 'cli-prod-unknown-xxxx',
  unknownSessionId: 'ses-prod-unknown-xxxx',
};

// ---- Dataset ----
const DATASET = {
  client: CLIENT,
  sessions: SESSIONS,
  materials: MATERIALS,
  supervision: SUPERVISION,
  clinicalActionDrafts: CLINICAL_ACTION_DRAFTS,
  adversarial: ADVERSARIAL,
  meta: {
    normalizationVersion: NORMALIZATION_VERSION,
    sessionCount: SESSIONS.length,
    materialCount: MATERIALS.length,
    generatedBy: 'tests/v4.3.0-disposable/opensquilla-production-contract/fixtures.js',
  },
};

// ---- Structural validation ----
function requireFullSourceRef(ref, where) {
  var v = [];
  if (!ref || typeof ref !== 'object') {
    v.push(where + ': sourceRef missing');
    return v;
  }
  ['id', 'normalizationVersion', 'sourceVersion', 'sourceContentHash', 'anchorContentHash', 'status'].forEach(function (f) {
    if (ref[f] === undefined || ref[f] === null || ref[f] === '') {
      v.push(where + ': sourceRef.' + f + ' missing');
    }
  });
  if (ref.status !== undefined && RECOGNIZED_STATUSES.indexOf(ref.status) < 0) {
    v.push(where + ': sourceRef.status=' + ref.status + ' not recognized');
  }
  return v;
}

function validateFixtures(ds) {
  var violations = [];
  var d = ds || DATASET;
  if (!d.client || !d.client.id) violations.push('client.id missing');
  var clientId = d.client ? d.client.id : null;

  if (!Array.isArray(d.sessions)) {
    violations.push('sessions is not array');
  } else {
    if (d.sessions.length < 30) violations.push('sessions count=' + d.sessions.length + ', expect >= 30');
    for (var i = 0; i < d.sessions.length; i++) {
      var s = d.sessions[i];
      if (clientId && s.clientId !== clientId) {
        violations.push('session ' + s.id + ': clientId=' + s.clientId + ' mismatch with main client ' + clientId);
      }
      violations = violations.concat(requireFullSourceRef(s.sourceRef, 'session ' + s.id));
    }
  }

  (d.materials || []).forEach(function (m) {
    violations = violations.concat(requireFullSourceRef(m.sourceRef, 'material ' + m.id));
  });

  (d.supervision || []).forEach(function (sp) {
    violations = violations.concat(requireFullSourceRef(sp.sourceRef, 'supervision ' + sp.id));
  });

  (d.clinicalActionDrafts || []).forEach(function (c) {
    if (!c.clinicalActionRunId) violations.push('clinicalActionDraft missing clinicalActionRunId');
    if (c.status !== 'draft') violations.push('clinicalActionDraft ' + c.clinicalActionRunId + ': status=' + c.status + ' must be draft');
    violations = violations.concat(requireFullSourceRef(c.sourceRef, 'clinicalActionDraft ' + c.clinicalActionRunId));
  });

  // Source version history coverage
  var hasVersionChange = (d.sessions || []).some(function (s) {
    return Array.isArray(s.sourceRef && s.sourceRef.sourceHistory) && s.sourceRef.sourceHistory.length > 1;
  });
  if (!hasVersionChange) violations.push('no sourceHistory coverage (stale snapshot input missing)');

  // Failure state coverage
  var statuses = {};
  (d.materials || []).forEach(function (m) {
    if (m.sourceRef && m.sourceRef.status) statuses[m.sourceRef.status] = true;
  });
  ['invalid', 'quarantine', 'expired'].forEach(function (need) {
    if (!statuses[need]) violations.push('coverage missing: ' + need);
  });

  return { ok: violations.length === 0, violations: violations };
}

function detectBrokenLinks(ds) {
  var d = ds || DATASET;
  var broken = [];
  (d.materials || []).forEach(function (m) {
    if (m.sourceRef && m.resolvedContent !== undefined && m.sourceRef.anchorContentHash !== undefined) {
      if (m.sourceRef.anchorContentHash !== sha256(m.resolvedContent)) broken.push(m.id);
    }
  });
  return broken;
}

// ---- Prototype input adapter (field mapping only, no derivation/validation logic) ----
function toPrototypeInput() {
  var matSession = {};
  SESSIONS.forEach(function (s) {
    s.materialIds.forEach(function (mid) { matSession[mid] = s.id; });
  });
  matSession['mat-prod-0002'] = matSession['mat-prod-0002'] || SESSIONS[5].id;
  matSession['mat-prod-0004'] = matSession['mat-prod-0004'] || SESSIONS[14].id;
  matSession['mat-prod-0005'] = matSession['mat-prod-0005'] || SESSIONS[22].id;
  matSession['mat-prod-0006'] = matSession['mat-prod-0006'] || SESSIONS[28].id;
  matSession['mat-prod-0007'] = matSession['mat-prod-0007'] || SESSIONS[35].id;

  var input = {
    client: { id: CLIENT.id, name: CLIENT.displayName, status: 'active' },
    sessions: SESSIONS.map(function (s) {
      return {
        id: s.id,
        clientId: s.clientId,
        sessionNumber: s.index,
        date: s.date,
        notes: '本节主要工作：' + s.title,
        transcript: s.summary,
        riskLevel: s.index === 13 ? 'moderate' : s.index === 27 ? 'high' : 'low',
        soap: s.index % 10 === 0 ? { subjective: '合成主观-' + s.index, assessment: '合成评估-' + s.index } : undefined,
      };
    }),
    materials: MATERIALS.map(function (m) {
      return {
        id: m.id,
        clientId: CLIENT.id,
        sessionId: matSession[m.id],
        title: m.title,
        extractedText: m.resolvedContent,
        sourceStatus: m.sourceRef.status,
        originalAnchorContentHash: m.sourceRef.anchorContentHash,
      };
    }),
    supervisions: SUPERVISION.map(function (sv) {
      return {
        id: sv.id,
        clientId: CLIENT.id,
        sessionId: sv.sessionId,
        content: sv.title + '（合成督导内容）',
        supervisorName: '合成督导师·丙',
      };
    }),
    actionRuns: CLINICAL_ACTION_DRAFTS.map(function (c) {
      return {
        id: c.clinicalActionRunId,
        task: c.note,
        origin: { clientId: CLIENT.id, sessionId: c.sessionId },
        output: { summary: c.note },
        status: c.status,
      };
    }),
    aiEdge: {
      id: 'edge-ai-prod-0001',
      type: 'ai-inference',
      sourceNode: 'n_001',
      targetNode: 'n_002',
      label: 'AI 推断（合成预览）',
      confidence: 0.42,
    },
  };
  return JSON.parse(JSON.stringify(input));
}

module.exports = {
  NORMALIZATION_VERSION: NORMALIZATION_VERSION,
  SOURCE_VERSION: SOURCE_VERSION,
  RECOGNIZED_STATUSES: RECOGNIZED_STATUSES,
  CLIENT: CLIENT,
  OTHER_CLIENT: OTHER_CLIENT,
  SESSIONS: SESSIONS,
  MATERIALS: MATERIALS,
  SUPERVISION: SUPERVISION,
  CLINICAL_ACTION_DRAFTS: CLINICAL_ACTION_DRAFTS,
  ADVERSARIAL: ADVERSARIAL,
  DATASET: DATASET,
  sha256: sha256,
  makeSourceRef: makeSourceRef,
  validateFixtures: validateFixtures,
  detectBrokenLinks: detectBrokenLinks,
  toPrototypeInput: toPrototypeInput,
};
