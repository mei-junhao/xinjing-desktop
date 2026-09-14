'use strict';
/* ============================================================
   XJ-4.2.1-codebuddy-import-integrity-contract — 合成 fixture
   synthetic=true，全部为化名/合成数据，无任何真实临床或支付数据。
   仅供 import-integrity 契约测试使用；不接入生产代码。
   ============================================================ */

const SYNTHETIC = true;

// 新导入包中携带的新 client / 新 session（导入前旧 cache 不存在）。
const NEW_CLIENT = {
  id: 'iic-c-001', name: '化名-甲', status: 'active',
  billing: { feePerSession: 300, billingMode: 'per-session' },
  createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z', firstVisitDate: '2026-07-19',
};
const NEW_SESSION = {
  id: 'iic-s-001', clientId: 'iic-c-001', sessionNumber: 1, date: '2026-07-10', type: 'individual',
  billing: { fee: 300, paid: true }, hasTranscript: true, hasSoap: false,
  createdAt: '2026-07-10T00:00:00.000Z', updatedAt: '2026-07-10T00:00:00.000Z',
};

// 合法 run：引用同一导入包内的新 client + 新 session，sources 与 origin 自洽。
const LEGAL_RUN = {
  id: 'iic-run-legal', task: 'transcript-ai-detect', status: 'succeeded',
  origin: { clientId: 'iic-c-001', sessionId: 'iic-s-001', materialId: '', supervisionId: '' },
  sources: [
    { kind: 'client', id: 'iic-c-001', label: '化名-甲', chars: 10, truncated: false },
    { kind: 'session', id: 'iic-s-001', label: '第1次', chars: 20, truncated: false },
  ],
  output: { kind: 'transcript', ref: 'iic-s-001' },
  createdAt: '2026-07-11T00:00:00.000Z', completedAt: '2026-07-11T00:01:00.000Z',
};

// 引用未知 clientId 的 run（导入包与旧 cache 都不含该 client）。
const RUN_UNKNOWN_CLIENT = {
  id: 'iic-run-badclient', task: 'report-ai-fill', status: 'succeeded',
  origin: { clientId: 'iic-c-UNKNOWN', sessionId: '', materialId: '', supervisionId: '' },
  sources: [{ kind: 'client', id: 'iic-c-UNKNOWN', label: '未知', chars: 5, truncated: false }],
  output: { kind: 'report', ref: 'r-x' },
  createdAt: '2026-07-12T00:00:00.000Z', completedAt: '',
};

// origin.clientId 合法，但 origin.sessionId 引用未知 session。
const RUN_UNKNOWN_SESSION = {
  id: 'iic-run-badsession', task: 'transcript-ai-detect', status: 'succeeded',
  origin: { clientId: 'iic-c-001', sessionId: 'iic-s-UNKNOWN', materialId: '', supervisionId: '' },
  sources: [{ kind: 'session', id: 'iic-s-UNKNOWN', label: '未知会话', chars: 8, truncated: false }],
  output: { kind: 'transcript', ref: 'iic-s-UNKNOWN' },
  createdAt: '2026-07-13T00:00:00.000Z', completedAt: '',
};

// origin 合法，但 sources 中引用未知 session。
const RUN_UNKNOWN_SOURCE = {
  id: 'iic-run-badsource', task: 'transcript-ai-detect', status: 'succeeded',
  origin: { clientId: 'iic-c-001', sessionId: 'iic-s-001', materialId: '', supervisionId: '' },
  sources: [
    { kind: 'client', id: 'iic-c-001', label: '化名-甲', chars: 10, truncated: false },
    { kind: 'session', id: 'iic-s-GHOST', label: '幽灵会话', chars: 8, truncated: false },
  ],
  output: { kind: 'transcript', ref: 'iic-s-001' },
  createdAt: '2026-07-14T00:00:00.000Z', completedAt: '',
};

// ---- Post-fix 覆盖（material / supervision 引用；malformed 隔离；quarantine 字段） ----
// 合法 run 引用的第二个 session（与 material 同属 client iic-c-001）。
const NEW_SESSION_B = {
  id: 'iic-s-002', clientId: 'iic-c-001', sessionNumber: 2, date: '2026-07-11', type: 'individual',
  billing: { fee: 300, paid: true }, hasTranscript: true, hasSoap: false,
  createdAt: '2026-07-11T00:00:00.000Z', updatedAt: '2026-07-11T00:00:00.000Z',
};
// 合法 material：client iic-c-001、session iic-s-002（均随导入包带入）。
const NEW_MATERIAL = {
  id: 'iic-m-001', clientId: 'iic-c-001', sessionId: 'iic-s-002', title: '化名-合成素材',
  source: { name: 'synthetic.txt', ext: 'txt', size: 10, modifiedAt: '2026-07-11T00:00:00.000Z' },
  extractedText: 'synthetic', parseStatus: 'ready', parseError: '',
  createdAt: '2026-07-11T00:00:00.000Z', updatedAt: '2026-07-11T00:00:00.000Z',
};
// 合法 supervision：client iic-c-001、引用 session iic-s-001。
const NEW_SUPERVISION = {
  id: 'iic-sv-001', clientId: 'iic-c-001', sessionIds: ['iic-s-001'], type: 'individual',
  supervisorName: '化名-督导师', date: '2026-07-12', content: '', conclusion: '',
  createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
};

// 合法 run：引用同一导入包内 client + session + 合法 material + 合法 supervision（全部自洽）。
const LEGAL_RUN_MS = {
  id: 'iic-run-ms', task: 'transcript-ai-detect', status: 'succeeded',
  origin: { clientId: 'iic-c-001', sessionId: 'iic-s-002', materialId: 'iic-m-001', supervisionId: 'iic-sv-001' },
  sources: [
    { kind: 'client', id: 'iic-c-001', label: '化名-甲', chars: 10, truncated: false },
    { kind: 'session', id: 'iic-s-002', label: '第2次', chars: 20, truncated: false },
    { kind: 'material', id: 'iic-m-001', label: '化名-合成素材', chars: 30, truncated: false },
    { kind: 'supervision', id: 'iic-sv-001', label: '化名-督导师', chars: 15, truncated: false },
  ],
  output: { kind: 'transcript', ref: 'iic-s-002' },
  createdAt: '2026-07-13T00:00:00.000Z', completedAt: '2026-07-13T00:01:00.000Z',
};

// 引用未知 materialId（导入包不含该 material）。
const RUN_UNKNOWN_MATERIAL = {
  id: 'iic-run-badmaterial', task: 'transcript-ai-detect', status: 'succeeded',
  origin: { clientId: 'iic-c-001', sessionId: 'iic-s-001', materialId: 'iic-m-GHOST', supervisionId: '' },
  sources: [{ kind: 'client', id: 'iic-c-001', label: '化名-甲', chars: 10, truncated: false }],
  output: { kind: 'transcript', ref: 'iic-s-001' },
  createdAt: '2026-07-13T00:00:00.000Z', completedAt: '',
};

// 引用已知但错配的 materialId：material iic-m-001 绑定 session iic-s-002，
// 而 run 的 origin.sessionId 为 iic-s-001 → 校验判 unknown-or-mismatched-material。
const RUN_MISMATCH_MATERIAL = {
  id: 'iic-run-mismatchmaterial', task: 'transcript-ai-detect', status: 'succeeded',
  origin: { clientId: 'iic-c-001', sessionId: 'iic-s-001', materialId: 'iic-m-001', supervisionId: '' },
  sources: [
    { kind: 'client', id: 'iic-c-001', label: '化名-甲', chars: 10, truncated: false },
    { kind: 'session', id: 'iic-s-001', label: '第1次', chars: 20, truncated: false },
    { kind: 'material', id: 'iic-m-001', label: '化名-合成素材', chars: 30, truncated: false },
  ],
  output: { kind: 'transcript', ref: 'iic-s-001' },
  createdAt: '2026-07-13T00:00:00.000Z', completedAt: '',
};

// 引用未知 supervisionId（导入包不含该 supervision）。
const RUN_UNKNOWN_SUPERVISION = {
  id: 'iic-run-badsupervision', task: 'transcript-ai-detect', status: 'succeeded',
  origin: { clientId: 'iic-c-001', sessionId: 'iic-s-001', materialId: '', supervisionId: 'iic-sv-GHOST' },
  sources: [{ kind: 'client', id: 'iic-c-001', label: '化名-甲', chars: 10, truncated: false }],
  output: { kind: 'transcript', ref: 'iic-s-001' },
  createdAt: '2026-07-13T00:00:00.000Z', completedAt: '',
};

// origin 合法但 sources 引用未知 material。
const RUN_UNKNOWN_MATERIAL_SOURCE = {
  id: 'iic-run-badmatsource', task: 'transcript-ai-detect', status: 'succeeded',
  origin: { clientId: 'iic-c-001', sessionId: 'iic-s-001', materialId: '', supervisionId: '' },
  sources: [
    { kind: 'client', id: 'iic-c-001', label: '化名-甲', chars: 10, truncated: false },
    { kind: 'material', id: 'iic-m-GHOST', label: '幽灵素材', chars: 8, truncated: false },
  ],
  output: { kind: 'transcript', ref: 'iic-s-001' },
  createdAt: '2026-07-14T00:00:00.000Z', completedAt: '',
};

// 无法 normalize 的 malformed：task 不在 ACTION_TASKS 内 → normalize 返回 null。
const RUN_BAD_TASK = {
  id: 'iic-run-badtask', task: 'definitely-not-a-real-task', status: 'succeeded',
  origin: { clientId: 'iic-c-001', sessionId: 'iic-s-001' }, sources: [],
  createdAt: '2026-07-14T00:00:00.000Z', completedAt: '',
};
// 无法 normalize 的 malformed：非对象值（字符串）。
const RUN_BAD_SHAPE = 'garbage-not-an-object';

// quarantine 字段断言用例（均为 normalized 无效或无法 normalize 的 run）。
const RUN_Q_UNKNOWN_CLIENT = {
  id: 'iic-run-q-uc', task: 'transcript-ai-detect', status: 'succeeded',
  origin: { clientId: 'iic-c-UNKNOWN', sessionId: '' }, sources: [{ kind: 'client', id: 'iic-c-UNKNOWN', label: '未知', chars: 5, truncated: false }],
  createdAt: '2026-07-15T00:00:00.000Z', completedAt: '',
};
const RUN_Q_UNKNOWN_SESSION = {
  id: 'iic-run-q-us', task: 'transcript-ai-detect', status: 'succeeded',
  origin: { clientId: 'iic-c-001', sessionId: 'iic-s-GHOST' }, sources: [{ kind: 'session', id: 'iic-s-GHOST', label: '幽灵', chars: 5, truncated: false }],
  createdAt: '2026-07-16T00:00:00.000Z', completedAt: '',
};
const RUN_Q_UNKNOWN_MATERIAL = {
  id: 'iic-run-q-um', task: 'transcript-ai-detect', status: 'succeeded',
  origin: { clientId: 'iic-c-001', sessionId: 'iic-s-001', materialId: 'iic-m-GHOST' }, sources: [{ kind: 'client', id: 'iic-c-001', label: '甲', chars: 5, truncated: false }],
  createdAt: '2026-07-17T00:00:00.000Z', completedAt: '',
};
const RUN_Q_BAD_TASK = {
  id: 'iic-run-q-bt', task: 'no-such-task', status: 'succeeded',
  origin: { clientId: 'iic-c-001', sessionId: 'iic-s-001' }, sources: [{ kind: 'client', id: 'iic-c-001', label: '甲', chars: 5, truncated: false }],
  createdAt: '2026-07-18T00:00:00.000Z', completedAt: '',
};

const EMPTY_EXPORT = {
  version: '2.0.0', exportedAt: '2026-07-19T00:00:00.000Z',
  clients: [], sessions: [], supervisions: [], supervisorIdentities: [],
  masterConversations: [], expenses: [], materialWorkspaces: [], clinicalActionRuns: [],
  settings: { apiConfig: {}, version: '1.0.0' },
};

function clone(v) { return JSON.parse(JSON.stringify(v)); }

// 组装导入包：可选注入 clients/sessions/runs。
function buildPackage(opts) {
  opts = opts || {};
  const pkg = clone(EMPTY_EXPORT);
  if (opts.clients) pkg.clients = clone(opts.clients);
  if (opts.sessions) pkg.sessions = clone(opts.sessions);
  if (opts.materialWorkspaces) pkg.materialWorkspaces = clone(opts.materialWorkspaces);
  if (opts.supervisions) pkg.supervisions = clone(opts.supervisions);
  if (opts.clinicalActionRuns) pkg.clinicalActionRuns = clone(opts.clinicalActionRuns);
  return pkg;
}

module.exports = {
  SYNTHETIC,
  NEW_CLIENT, NEW_SESSION, NEW_SESSION_B, NEW_MATERIAL, NEW_SUPERVISION,
  LEGAL_RUN, RUN_UNKNOWN_CLIENT, RUN_UNKNOWN_SESSION, RUN_UNKNOWN_SOURCE,
  LEGAL_RUN_MS, RUN_UNKNOWN_MATERIAL, RUN_MISMATCH_MATERIAL, RUN_UNKNOWN_SUPERVISION, RUN_UNKNOWN_MATERIAL_SOURCE,
  RUN_BAD_TASK, RUN_BAD_SHAPE,
  RUN_Q_UNKNOWN_CLIENT, RUN_Q_UNKNOWN_SESSION, RUN_Q_UNKNOWN_MATERIAL, RUN_Q_BAD_TASK,
  EMPTY_EXPORT,
  clone, buildPackage,
};
