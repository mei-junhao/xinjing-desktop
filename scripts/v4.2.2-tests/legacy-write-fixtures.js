'use strict';
/**
 * legacy-write-fixtures.js — XinJing v4.2.2 遗留写入迁移契约合成 fixture
 * 全部数据均为合成标记 synthetic=true，不含真实姓名/会谈/密钥/外发请求。
 * 仅供 legacy-write-contract.js 使用，不得被生产代码引用。
 */
module.exports = (function () {
  // ---- 合成来访者 ----
  var clients = [
    { id: 'c_syn_01', name: '合成来访者甲', status: 'active', billing: { feePerSession: 300, billingMode: 'per-session' }, tags: ['synthetic'] },
    { id: 'c_syn_02', name: '合成来访者乙', status: 'active', billing: { feePerSession: 500, billingMode: 'per-session' }, tags: ['synthetic'] },
  ];

  // ---- 合成会谈 ----
  var sessions = [
    { id: 's_syn_01', clientId: 'c_syn_01', sessionNumber: 1, date: '2026-07-21', hasTranscript: false, hasSoap: false, billing: { fee: 300, paid: false, source: 'synthetic' } },
    { id: 's_syn_02', clientId: 'c_syn_01', sessionNumber: 2, date: '2026-07-20', hasTranscript: true, hasSoap: false, billing: { fee: 300, paid: true, source: 'synthetic' } },
  ];

  // ---- 合成材料工作区 ----
  var materials = [
    { id: 'mw_syn_01', title: '合成材料-心理评估', source: { name: 'synthetic.md' }, parseStatus: 'ready', parseError: '', extractedText: '合成文本内容', clientId: '', sessionId: '', linkStatus: 'unlinked' },
  ];

  // ---- 合成设置/API 配置 ----
  var settings = {
    apiConfig: {
      provider: 'synthetic',
      baseUrl: 'https://synthetic.example.com/v1',
      apiKey: 'xj-enc:SYNTHETIC_ENCRYPTED_KEY_PLACEHOLDER',
      model: 'synthetic-model',
      verified: true,
    },
    backup: { folder: 'D:\\synthetic_backup', email: '' },
    backupLastTime: '2026-07-20T10:00:00.000Z',
    profile: { displayName: '合成咨询师' },
  };

  // ---- 合成督导 ----
  var supervisions = [
    { id: 'sv_syn_01', clientId: 'c_syn_01', sessionId: 's_syn_01', date: '2026-07-21', content: '合成督导内容', conclusion: '', type: 'individual' },
  ];

  // ---- 合成 master conversation ----
  var masterConv = {
    id: 'mc_syn_01',
    masterKey: 'freud',
    title: '合成学派对话',
    messages: [{ role: 'user', content: '合成问题' }, { role: 'assistant', content: '合成回复' }],
    settings: { includeUserDocs: false },
    updatedAt: '2026-07-21T00:00:00.000Z',
  };

  // ---- 合成支出 ----
  var expenses = [
    { id: 'exp_syn_01', category: 'personal', date: '2026-07-21', amount: 200, description: '合成个人体验', clientId: '', batchId: '', createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z' },
  ];

  // ---- 合成 supervisor identity ----
  var supervisorIdentities = [
    { id: 'si_syn_01', name: '合成督导师', prompt: '你是合成督导师', builtin: false },
  ];

  // ---- 故障注入 mock Store ----
  // 模拟 IDB 不可用或写入失败，用于验证 durable 失败路径
  function createFailingStore(realStore, failMode) {
    failMode = failMode || 'idb-fail';
    var failError = { ok: false, error: { code: 'XJ_IDB_UNAVAILABLE', message: 'IndexedDB persistence failed (synthetic)' } };
    var proxy = {
      _failMode: failMode,
      _realStore: realStore,
      getClients: function () { return realStore.getClients(); },
      getClient: function (id) { return realStore.getClient(id); },
      getSessions: function () { return realStore.getSessions(); },
      getSessionsByClient: function (cid) { return realStore.getSessionsByClient(cid); },
      getSession: function (id) { return realStore.getSession(id); },
      getMaterialWorkspaces: function () { return realStore.getMaterialWorkspaces ? realStore.getMaterialWorkspaces() : []; },
      getMaterialWorkspace: function (id) { return realStore.getMaterialWorkspace ? realStore.getMaterialWorkspace(id) : null; },
      getSettings: function () { return realStore.getSettings(); },
      getSupervisions: function () { return realStore.getSupervisions ? realStore.getSupervisions() : []; },
      getSupervisionsByClient: function (cid) { return realStore.getSupervisionsByClient ? realStore.getSupervisionsByClient(cid) : []; },
      getExpenses: function () { return realStore.getExpenses ? realStore.getExpenses() : []; },
      getMasterConversations: function () { return realStore.getMasterConversations ? realStore.getMasterConversations() : []; },
    };
    // durable 方法全部返回失败
    proxy.createClientDurable = async function () { return failError; };
    proxy.updateClientDurable = async function () { return failError; };
    proxy.saveSessionDurable = async function () { return failError; };
    proxy.saveSessionsDurable = async function () { return failError; };
    proxy.createSessionDurable = async function () { return failError; };
    proxy.updateSessionFull = async function () { return failError; };
    proxy.saveBillingBatchDurable = async function () { return failError; };
    proxy.deleteSessionsDurable = async function () { return failError; };
    proxy.deleteSessionDurable = async function () { return failError; };
    proxy.saveSupervisionDurable = async function () { return failError; };
    proxy.createSupervisionDurable = async function () { return failError; };
    proxy.updateSupervisionDurable = async function () { return failError; };
    proxy.saveAiSupervisionDurable = async function () { return failError; };
    proxy.saveMasterConversationDurable = async function () { return failError; };
    proxy.deleteMasterConversationDurable = async function () { return failError; };
    proxy.createExpenseDurable = async function () { return failError; };
    proxy.updateExpenseDurable = async function () { return failError; };
    proxy.deleteExpenseDurable = async function () { return failError; };
    proxy.saveSettingsDurable = async function () { return failError; };
    proxy.clearBillingDataDurable = async function () { return failError; };
    // legacy 方法保持原样（fire-and-forget 不返回 ok 状态）
    proxy.saveClient = function (c) { return realStore.saveClient(c); };
    proxy.createClient = function (d) { return realStore.createClient(d); };
    proxy.updateClient = function (id, p) { return realStore.updateClient(id, p); };
    proxy.saveSession = function (s) { return realStore.saveSession(s); };
    proxy.createSession = function (d) { return realStore.createSession(d); };
    proxy.saveSettings = function (p) { return realStore.saveSettings(p); };
    proxy.createMaterialWorkspace = function (d) { return realStore.createMaterialWorkspace(d); };
    proxy.updateMaterialWorkspace = function (id, p) { return realStore.updateMaterialWorkspace(id, p); };
    proxy.deleteMaterialWorkspace = function (id) { return realStore.deleteMaterialWorkspace(id); };
    proxy.createSupervisorIdentity = function (d) { return realStore.createSupervisorIdentity(d); };
    proxy.updateSupervisorIdentity = function (d) { return realStore.updateSupervisorIdentity(d); };
    proxy.deleteSupervisorIdentity = function (id) { return realStore.deleteSupervisorIdentity(id); };
    proxy.saveMasterConversation = function (c) { return realStore.saveMasterConversation(c); };
    proxy.createExpense = function (d) { return realStore.createExpense(d); };
    proxy.updateExpense = function (id, p) { return realStore.updateExpense(id, p); };
    proxy.deleteExpense = function (id) { return realStore.deleteExpense(id); };
    proxy.persist = function (key) { if (realStore.persist) realStore.persist(key); };
    return proxy;
  }

  return {
    synthetic: true,
    clients: clients,
    sessions: sessions,
    materials: materials,
    settings: settings,
    supervisions: supervisions,
    masterConv: masterConv,
    expenses: expenses,
    supervisorIdentities: supervisorIdentities,
    createFailingStore: createFailingStore,
  };
})();
