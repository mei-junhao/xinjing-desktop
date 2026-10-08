'use strict';
/*
 * 4.3.0 CodeBuddy 合成 fixture（仅测试资产，不含任何生产/真实数据）
 *
 * 本文件只生成确定性合成数据，并提供 validateFixtures() 对数据结构做契约级校验。
 * 它不是一个 ViewModel，也不是 prototype 的替代实现；它只是契约的输入与结构性断言。
 *
 * 覆盖：30 节合成会谈、一个合成 client、多份 material（含 invalid/quarantine/expired 失效态）、
 * 督导记录、ClinicalActionRun 草稿、来源版本变化与失效状态。
 *
 * 所有 hash 由 node 内置 crypto 真实计算，不伪造。
 */

const crypto = require('crypto');

const NORMALIZATION_VERSION = '1.0.0';
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
    sourceVersion: opts.sourceVersion,
    sourceContentHash: sha256(content),
    anchorContentHash: sha256(anchor),
    status: opts.status || 'valid',
  };
  // 保留原始 content/anchor 仅用于测试侧断链检测；prototype 不应依赖这些字段做事实判断。
  ref._testOnly = { content, anchor };
  return ref;
}

const CLIENT = {
  id: 'cli-synth-0001',
  displayName: '合成来访者·甲（匿名长程）',
  normalizationVersion: NORMALIZATION_VERSION,
};

// 30 节会谈，确定性生成（标题/摘要为合成中文，非真实临床材料）。
const SESSIONS = [];
const SESSION_COUNT = 30;
for (let i = 1; i <= SESSION_COUNT; i++) {
  const date = new Date(Date.UTC(2026, 0, 5 + (i - 1) * 7)).toISOString().slice(0, 10);
  const title = `第${i}节·长程咨询中的「移情与边界」议题（合成样本 ${i}/30）`;
  const summary =
    `本节聚焦合成来访者在前一周人际冲突下的情绪反应；讨论了自动思维、回避行为与家庭系统动力。` +
    `治疗师采用合成化的反映性倾听并记录可观察行为。本条为第 ${i} 节匿名合成摘要，不含真实个案信息。`;
  const src = `session-${i}-${date}-${title}`;
  const sr = makeSourceRef({
    stableId: `sr-ses-synth-0001-${String(i).padStart(2, '0')}`,
    sourceVersion: `2026-07-${String((i % 27) + 1).padStart(2, '0')}`,
    content: src,
    status: 'valid',
  });
  // 第 12 节引入来源版本变化：保留旧版本快照用于 stale snapshot 失效测试。
  if (i === 12) {
    sr.sourceHistory = [
      { sourceVersion: '2026-06-10', sourceContentHash: sha256(src + ':old'), status: 'superseded' },
      { sourceVersion: sr.sourceVersion, sourceContentHash: sr.sourceContentHash, status: 'current' },
    ];
  }
  SESSIONS.push({
    id: `ses-synth-0001-${String(i).padStart(2, '0')}`,
    clientId: CLIENT.id,
    index: i,
    date,
    title,
    summary,
    materialIds: [],
    supervisionRefIds: [],
    clinicalActionDraftIds: [],
    sourceRef: sr,
  });
}

// 多份 material，含合法态与失效态（invalid/quarantine/expired）。
// 合法材料的 anchorContentHash 必须锚定其 resolvedContent；断链材料故意不匹配。
function mat(id, title, resolvedContent, sourceVersion, status) {
  return {
    id, title, resolvedContent,
    sourceRef: makeSourceRef({ stableId: 'sr-' + id, sourceVersion, content: resolvedContent, anchor: resolvedContent, status }),
  };
}
const MATERIALS = [
  mat('mat-synth-0001', '合成依恋量表（匿名）', '依恋量表合成内容-A', '2026-07-01', 'valid'),
  mat('mat-synth-0002', '合成认知三角记录', '认知三角合成内容-B', '2026-07-02', 'valid'),
  mat('mat-synth-0003', '合成家庭图（已失效待复核）', '家庭图合成内容-C', '2026-05-30', 'invalid'),
  mat('mat-synth-0004', '合成创伤时间线（隔离）', '创伤时间线合成内容-D', '2026-04-15', 'quarantine'),
  mat('mat-synth-0005', '合成童年叙事（已过期来源）', '童年叙事合成内容-E', '2025-12-01', 'expired'),
  // 断链 material：anchorContentHash 与解析内容不匹配，用于断链失效测试。
  (function () {
    const m = mat('mat-synth-0006', '合成断链材料（锚点不匹配）', '断链合成内容-F', '2026-07-03', 'valid');
    m.sourceRef._testOnly.anchor = 'mat-0006-content-DANGLING';
    m.sourceRef.anchorContentHash = sha256('mat-0006-content-DANGLING');
    return m;
  })(),
];

// 督导记录
const SUPERVISION = [
  { id: 'sup-synth-0001', title: '第1次个体督导（合成）', sessionId: SESSIONS[0].id, sourceRef: makeSourceRef({ stableId: 'sr-sup-0001', sourceVersion: '2026-07-10', content: 'supervision-1', status: 'valid' }) },
  { id: 'sup-synth-0002', title: '第2次团体督导（合成）', sessionId: SESSIONS[11].id, sourceRef: makeSourceRef({ stableId: 'sr-sup-0002', sourceVersion: '2026-07-20', content: 'supervision-2', status: 'valid' }) },
];

// ClinicalActionRun 草稿
const CLINICAL_ACTION_DRAFTS = [
  { clinicalActionRunId: 'car-synth-0001', sessionId: SESSIONS[4].id, status: 'draft', note: '合成临床动作草稿：布置行为实验', sourceRef: makeSourceRef({ stableId: 'sr-car-0001', sourceVersion: '2026-07-12', content: 'car-1', status: 'valid' }) },
  { clinicalActionRunId: 'car-synth-0002', sessionId: SESSIONS[17].id, status: 'draft', note: '合成临床动作草稿：复发预防计划', sourceRef: makeSourceRef({ stableId: 'sr-car-0002', sourceVersion: '2026-07-22', content: 'car-2', status: 'valid' }) },
];

// 关联：把材料/督导/草稿挂到会谈上
SESSIONS[0].materialIds.push('mat-synth-0001');
SESSIONS[0].supervisionRefIds.push('sup-synth-0001');
SESSIONS[4].clinicalActionDraftIds.push('car-synth-0001');
SESSIONS[11].materialIds.push('mat-synth-0003');
SESSIONS[11].supervisionRefIds.push('sup-synth-0002');
SESSIONS[17].clinicalActionDraftIds.push('car-synth-0002');
SESSIONS[20].materialIds.push('mat-synth-0006'); // 断链材料挂到第21节

// 对抗样本：用于失败闭包与 mutant 测试（合成，非生产数据）
const ADVERSARIAL = {
  // 缺 hash 的 sourceRef
  missingHashSourceRef: (function () {
    const r = makeSourceRef({ stableId: 'sr-bad-0001', sourceVersion: '2026-07-01', content: 'bad-1' });
    delete r.sourceContentHash;
    return r;
  })(),
  // 错 client 的会谈（clientId 与主 client 不一致）
  wrongClientSession: (function () {
    const s = JSON.parse(JSON.stringify(SESSIONS[1]));
    s.clientId = 'cli-synth-9999'; // 故意错 client
    return s;
  })(),
  // 第二合成 client，用于跨个案污染测试
  otherClient: { id: 'cli-synth-9999', displayName: '合成来访者·乙（仅对抗）', normalizationVersion: NORMALIZATION_VERSION },
};

const DATASET = {
  client: CLIENT,
  sessions: SESSIONS,
  materials: MATERIALS,
  supervision: SUPERVISION,
  clinicalActionDrafts: CLINICAL_ACTION_DRAFTS,
  adversarial: ADVERSARIAL,
  meta: {
    normalizationVersion: NORMALIZATION_VERSION,
    sessionCount: SESSION_COUNT,
    generatedBy: 'tests/v4.3.0-disposable/codebuddy/fixtures.js',
  },
};

function requireFullSourceRef(ref, where) {
  const v = [];
  if (!ref || typeof ref !== 'object') { v.push(`${where}: sourceRef 缺失`); return v; }
  for (const f of ['id', 'normalizationVersion', 'sourceVersion', 'sourceContentHash', 'anchorContentHash', 'status']) {
    if (ref[f] === undefined || ref[f] === null || ref[f] === '') v.push(`${where}: sourceRef.${f} 缺失`);
  }
  if (ref.status !== undefined && !RECOGNIZED_STATUSES.includes(ref.status)) {
    v.push(`${where}: sourceRef.status=${ref.status} 不被识别`);
  }
  return v;
}

// 结构性契约校验。返回 { ok, violations }。
function validateFixtures(ds) {
  const violations = [];
  const d = ds || DATASET;
  if (!d.client || !d.client.id) violations.push('client.id 缺失');
  const clientId = d.client ? d.client.id : null;

  if (!Array.isArray(d.sessions)) {
    violations.push('sessions 不是数组');
  } else {
    if (d.sessions.length !== SESSION_COUNT) violations.push(`sessions 数量=${d.sessions.length}，期望 ${SESSION_COUNT}`);
    for (const s of d.sessions) {
      if (s.clientId !== clientId) violations.push(`session ${s.id}: clientId=${s.clientId} 与主 client 不一致`);
      violations.push(...requireFullSourceRef(s.sourceRef, `session ${s.id}`));
    }
  }

  for (const m of d.materials || []) {
    violations.push(...requireFullSourceRef(m.sourceRef, `material ${m.id}`));
  }

  for (const sp of d.supervision || []) violations.push(...requireFullSourceRef(sp.sourceRef, `supervision ${sp.id}`));

  for (const c of d.clinicalActionDrafts || []) {
    if (!c.clinicalActionRunId) violations.push(`clinicalActionDraft ${c.id || '?'} 缺 clinicalActionRunId`);
    if (c.status !== 'draft') violations.push(`clinicalActionDraft ${c.clinicalActionRunId}: status=${c.status} 必须为 draft`);
    violations.push(...requireFullSourceRef(c.sourceRef, `clinicalActionDraft ${c.clinicalActionRunId}`));
  }

  // 来源版本变化：至少存在一处 sourceHistory（stale snapshot 输入）
  const hasVersionChange = (d.sessions || []).some((s) => Array.isArray(s.sourceRef && s.sourceRef.sourceHistory) && s.sourceRef.sourceHistory.length > 1);
  if (!hasVersionChange) violations.push('缺少来源版本变化（sourceHistory）输入');

  // 失效态覆盖：至少存在 invalid/quarantine/expired 各一
  const statuses = new Set((d.materials || []).map((m) => m.sourceRef && m.sourceRef.status));
  for (const need of ['invalid', 'quarantine', 'expired']) {
    if (!statuses.has(need)) violations.push(`材料缺少失效态覆盖：${need}`);
  }

  return { ok: violations.length === 0, violations };
}

// 断链检测（场景级，非结构级）：返回 anchorContentHash 与解析内容不一致的 material id。
// 这是 prototype 应当拒绝的输入场景；主数据集刻意包含一个断链材料作为覆盖。
function detectBrokenLinks(ds) {
  const d = ds || DATASET;
  const broken = [];
  for (const m of d.materials || []) {
    if (m.sourceRef && m.resolvedContent !== undefined && m.sourceRef.anchorContentHash !== undefined) {
      if (m.sourceRef.anchorContentHash !== sha256(m.resolvedContent)) broken.push(m.id);
    }
  }
  return broken;
}

/*
 * toPrototypeInput(): 把合成数据集适配成 OpenSquilla prototype createViewModel(fixtures)
 * 期望的输入形状（client/sessions/materials/supervisions/actionRuns/aiEdge）。
 * 这只是输入字段适配（Checkpoint A 允许的 fixture 字段适配），不是 ViewModel、
 * 不是 adapter 替代实现，不含任何派生/校验逻辑。每次调用返回深拷贝，测试可自由变异。
 */
function toPrototypeInput() {
  // material -> session 归属：既有挂接关系优先，未挂接的确定性分配（保证每个材料有 sessionId）。
  const matSession = {};
  for (const s of SESSIONS) for (const mid of s.materialIds) matSession[mid] = s.id;
  matSession['mat-synth-0002'] = matSession['mat-synth-0002'] || SESSIONS[5].id;
  matSession['mat-synth-0004'] = matSession['mat-synth-0004'] || SESSIONS[14].id;
  matSession['mat-synth-0005'] = matSession['mat-synth-0005'] || SESSIONS[22].id;

  const input = {
    client: { id: CLIENT.id, name: CLIENT.displayName, status: 'active' },
    sessions: SESSIONS.map((s) => ({
      id: s.id,
      clientId: s.clientId,
      sessionNumber: s.index,
      date: s.date,
      notes: '本节主要工作：' + s.title,
      transcript: s.summary,
      riskLevel: s.index === 13 ? 'moderate' : s.index === 27 ? 'high' : 'low',
      soap: s.index % 10 === 0 ? { subjective: '合成主观陈述-' + s.index, assessment: '合成评估-' + s.index } : undefined,
    })),
    materials: MATERIALS.map((m) => ({
      id: m.id,
      clientId: CLIENT.id,
      sessionId: matSession[m.id],
      title: m.title,
      extractedText: m.resolvedContent,
      // 额外携带失效态与原 sourceRef 供观察（prototype 当前忽略这些字段——这是被测事实之一）
      sourceStatus: m.sourceRef.status,
      originalAnchorContentHash: m.sourceRef.anchorContentHash,
    })),
    supervisions: SUPERVISION.map((sv) => ({
      id: sv.id,
      clientId: CLIENT.id,
      sessionId: sv.sessionId,
      content: sv.title + '（合成督导内容，非真实临床材料）',
      supervisorName: '合成督导师·丙',
    })),
    actionRuns: CLINICAL_ACTION_DRAFTS.map((c) => ({
      id: c.clinicalActionRunId,
      task: c.note,
      origin: { clientId: CLIENT.id, sessionId: c.sessionId },
      output: { summary: c.note },
      status: c.status,
    })),
    aiEdge: {
      id: 'edge-ai-synth-0001',
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
  NORMALIZATION_VERSION,
  RECOGNIZED_STATUSES,
  CLIENT,
  SESSIONS,
  MATERIALS,
  SUPERVISION,
  CLINICAL_ACTION_DRAFTS,
  ADVERSARIAL,
  DATASET,
  sha256,
  makeSourceRef,
  validateFixtures,
  detectBrokenLinks,
  toPrototypeInput,
};
