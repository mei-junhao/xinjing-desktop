'use strict';

/*
 * UX audit fixtures. These tests intentionally use only in-memory synthetic data.
 * They must never hydrate Store, open IndexedDB, or read a user's knowledge folder.
 */
const assert = require('assert');
const fs = require('fs');
const { classifyError, safeFailureResult } = require('../app/js/ai.js');

function checkAiErrors() {
  const cases = [
    [{ message: 'Failed to fetch' }, 'network'],
    [{ message: 'HTTP 401: invalid token', status: 401 }, 'auth'],
    [{ message: 'HTTP 429: too many requests', status: 429 }, 'rate_limit'],
    [{ message: 'HTTP 404: endpoint not found', status: 404 }, 'provider_http'],
    [{ message: 'HTTP 503: upstream unavailable', status: 503 }, 'provider_http'],
    [{ code: 'TRIAL_RATE_LIMIT', message: '额度已用完' }, 'rate_limit'],
    [{ code: 'ABORT_ERR', message: '已取消生成' }, 'aborted'],
  ];
  cases.forEach(([error, expected]) => assert.strictEqual(classifyError(error), expected));
  const sensitive = 'https://provider.invalid/v1?key=secret-api-key material:合成材料';
  [
    safeFailureResult({ message: sensitive }),
    safeFailureResult({ message: sensitive, status: 500 }, { partial: true, partialContent: '合成片段' }),
    safeFailureResult({ code: 'ABORT_ERR', message: sensitive }),
    safeFailureResult({ code: 'TRIAL_RATE_LIMIT', message: sensitive }),
    safeFailureResult({ message: sensitive }, { fallbackFailed: true, fallbackCode: 'network' }),
  ].forEach((result) => {
    assert.ok(!JSON.stringify(result).includes(sensitive), '失败结果不得包含原始错误');
    assert.ok(!JSON.stringify(result).includes('secret-api-key'), '失败结果不得包含密钥');
  });
  const partialResult = safeFailureResult({ message: sensitive, status: 500 }, { partial: true, partialContent: '合成片段' });
  assert.strictEqual(partialResult.partialContent, '合成片段', '流式失败应保留已生成的安全片段');
  assert.strictEqual(classifyError({ name: 'AbortError', message: sensitive }), 'aborted', 'AbortError名称必须归为取消');
  assert.strictEqual(classifyError({ message: 'HTTP 500: upstream unavailable', status: 500 }), 'provider_http');
  const aiSource = fs.readFileSync(require.resolve('../app/js/ai.js'), 'utf8');
  assert.ok(!/if \(e && e\.code === 'TRIAL_RATE_LIMIT'\) return \{ error: e\.message/.test(aiSource), '限流错误不得直接回传代理原文');
  assert.ok(!/error:\s*e(?:2)?\.message/.test(aiSource), '生成、流式和兜底失败不得直接回传异常原文');
  assert.ok(!/degradedReason:[^\n]*e\.message/.test(aiSource), '降级提示不得包含异常原文');
  assert.ok(/errorCode:\s*classifyError\(e\)/.test(aiSource), '普通和流式失败必须带安全错误分类');
  assert.ok(/errorCode:\s*'builtin_fallback_failed'/.test(aiSource), '兜底失败必须使用固定分类');
  assert.ok(/error:\s*'连接失败，请检查配置、网络或服务状态'/.test(aiSource), '连接测试必须使用固定安全文案');
  assert.ok(/errorCode === 'aborted'/.test(aiSource) && /error: '已取消生成'/.test(aiSource), '取消生成必须使用固定安全文案');
  console.log('PASS --check-ai-errors: 7 类合成错误均可归类，未暴露原始敏感信息');
}

function checkBillingReconciliation() {
  const clients = [{ id: 'fixture-client-1', name: '合成来访者' }];
  const sessions = [
    { id: 'session-clinical', clientId: clients[0].id, date: '2026-07-01', billing: null },
    { id: 'session-billable', clientId: clients[0].id, date: '2026-07-02', billing: { fee: 500, source: 'manual', paid: true } },
    { id: 'session-free', clientId: clients[0].id, date: '2026-07-03', billing: { fee: 0, source: 'tmeet', paid: false } },
  ];
  const imports = [{ id: 'import-fixture-1', clientId: clients[0].id, count: 2, source: 'legacy-import' }];
  const isBillable = (session) => !!(session.billing && typeof session.billing === 'object');
  const billable = sessions.filter(isBillable);
  const trace = billable.map((session) => ({
    sessionId: session.id,
    clientId: session.clientId,
    source: session.billing.source,
  }));
  assert.deepStrictEqual(billable.map(s => s.id), ['session-billable', 'session-free']);
  assert.strictEqual(sessions.filter(s => s.clientId === clients[0].id).length, 3);
  assert.strictEqual(billable.length, 2);
  assert.strictEqual(imports[0].count, 2);
  assert.deepStrictEqual(trace, [
    { sessionId: 'session-billable', clientId: clients[0].id, source: 'manual' },
    { sessionId: 'session-free', clientId: clients[0].id, source: 'tmeet' },
  ]);
  assert.strictEqual(JSON.stringify(trace), JSON.stringify(billable.map((session) => ({
    sessionId: session.id, clientId: session.clientId, source: session.billing.source,
  }))));
  const billingSource = fs.readFileSync(require.resolve('../app/billing-shell.html'), 'utf8');
  assert.ok(/function billableSessionsFor\(clientId\)/.test(billingSource), '生产账务必须存在客户会谈聚合入口');
  assert.ok(/Store\.getSessionsByClient\(clientId\)\.filter/.test(billingSource), '生产账务必须按客户会谈聚合');
  assert.ok(/Store\.isBillableSession\(s\)/.test(billingSource), '生产账务必须使用统一可计费判定');
  assert.notStrictEqual(imports[0].source, 'clinical-session');
  console.log('PASS --check-billing-reconciliation: 客户总会谈、可计费会谈、导入批次可按来源与 ID 对账');
}

function checkNavLabels() {
  const appSource = fs.readFileSync(require.resolve('../app/js/app.js'), 'utf8');
  const docSource = fs.readFileSync(require.resolve('../app/doc-center.html'), 'utf8');
  assert.ok(/key: 'clients', label: '来访者档案'/.test(appSource), '侧栏必须使用来访者档案标签');
  assert.ok(/<h2>来访者档案<\/h2>/.test(docSource), '档案页标题必须与入口一致');
  assert.ok(/href: 'doc-center\.html'/.test(appSource), '来访者档案路由保持兼容');
  console.log('PASS --check-nav-labels: 入口文案、页面标题和旧路由一致');
}

function checkTranscriptContext() {
  const source = fs.readFileSync(require.resolve('../app/js/transcript.js'), 'utf8');
  const html = fs.readFileSync(require.resolve('../app/transcript.html'), 'utf8');
  assert.ok(/currentSessionId = new URLSearchParams\(location\.search\)\.get\('sessionId'\)/.test(source), '逐字稿必须支持显式 sessionId');
  assert.ok(/id="tp-session"/.test(html) && /onchange="loadSession\(\)"/.test(html), '逐字稿必须提供会谈选择器');
  assert.ok(/Store\.getSession\(currentSessionId\)/.test(source), '保存前必须按显式 sessionId 读取会谈');
  assert.ok(/deepLinkedSession = currentSessionId && Store\.getSession\(currentSessionId\)/.test(source), 'URL会谈必须反推所属来访者');
  assert.ok(/session\.clientId !== currentClientId/.test(source), '保存前必须校验会谈归属来访者');
  assert.ok(!/sessions\[0\]/.test(source), '不得使用排序后的第一条会谈作为保存目标');
  assert.ok(/已保存：.*session\.sessionNumber/.test(source), '成功提示必须包含会谈节次');
  console.log('PASS --check-transcript-context: 保存目标和成功反馈均有精确会谈上下文');
}

function checkSupervisionMaterials() {
  const storeSource = fs.readFileSync(require.resolve('../app/js/store.js'), 'utf8');
  const supervisionSource = fs.readFileSync(require.resolve('../app/js/supervision.js'), 'utf8');
  assert.ok(/function getMaterialWorkspacesForSession\(clientId, sessionId\)/.test(storeSource), 'Store缺少按会谈只读材料派生查询');
  assert.ok(/item\.clientId === clientId && item\.sessionId === sessionId/.test(storeSource), '材料派生查询必须同时校验来访者和会谈');
  assert.ok(/已关联材料/.test(supervisionSource) && /getMaterialWorkspacesForSession/.test(supervisionSource), '督导历史未显示关联材料');
  assert.ok(/材料来源/.test(supervisionSource) && /m\.text/.test(supervisionSource), '载入会谈时未纳入材料来源和文本');
  const client = { id: 'fixture-client' };
  const session = { id: 'fixture-session', clientId: client.id };
  const materials = [
    { id: 'mat-linked', clientId: client.id, sessionId: session.id, title: '合成访谈材料', extractedText: '合成文本' },
    { id: 'mat-other-session', clientId: client.id, sessionId: 'other-session', title: '不应载入' },
    { id: 'mat-other-client', clientId: 'other-client', sessionId: session.id, title: '不应载入' },
  ];
  const derived = materials.filter((m) => m.clientId === client.id && m.sessionId === session.id);
  assert.deepStrictEqual(derived.map((m) => m.id), ['mat-linked']);
  assert.strictEqual(derived[0].extractedText, '合成文本');
  console.log('PASS --check-supervision-materials: 督导历史按来访者/会谈显示并载入关联材料');
}

function checkKnowledgeMeta() {
  const mainSource = fs.readFileSync(require.resolve('../main.js'), 'utf8');
  const knowledgeSource = fs.readFileSync(require.resolve('../app/js/knowledge.js'), 'utf8');
  assert.ok(/knowledge-meta-v1\.json/.test(mainSource), '分类必须使用独立 sidecar');
  assert.ok(/schemaVersion: KNOWLEDGE_META_SCHEMA/.test(mainSource), 'sidecar必须固定schema版本');
  assert.ok(/\.tmp-.*Date\.now\(\)/.test(mainSource) && /fs\.promises\.rename\(tmp, target\)/.test(mainSource), 'sidecar必须临时文件原子替换');
  assert.ok(/corrupt-.*Date\.now\(\)/.test(mainSource), '坏JSON必须隔离而不是覆盖');
  assert.ok(/corrupt-quarantine-failed/.test(mainSource), '隔离失败必须阻止写入并返回可诊断错误');
  assert.ok(/Array\.isArray\(data\.entries\)/.test(mainSource), 'sidecar entries数组必须拒绝');
  assert.ok(/typeof override\.category === 'string'/.test(mainSource), 'sidecar分类字段必须校验类型');
  assert.ok(/readOnly.*unknown-schema/.test(mainSource), '未知schema必须只读');
  assert.ok(/override\.contentHash === contentHash/.test(mainSource) && !/!override\.contentHash \|\| override\.contentHash === contentHash/.test(mainSource), '内容指纹缺失或变化必须使旧覆盖失效');
  assert.ok(/fmCat \|\| \(validOverride && validOverride\.category\) \|\| dirCat/.test(mainSource), '分类优先级必须为frontmatter、本地覆盖、目录');
  assert.ok(/readKnowledgeMeta/.test(knowledgeSource) && /writeKnowledgeMeta/.test(knowledgeSource), '资料库必须提供分类读写入口');
  assert.ok(/categorySource === 'uncategorized'/.test(knowledgeSource) && !/categorySource === 'uncategorized' \|\| f\.categorySource === 'local'/.test(knowledgeSource), '整理未分类不得覆盖已有本地分类');
  const fixture = [
    { path: 'a.md', category: 'frontmatter', hash: 'h1', fm: '伦理', dir: '', override: '旧' },
    { path: 'clinical/b.md', category: 'directory', hash: 'h2', fm: '', dir: 'clinical', override: '旧' },
    { path: 'c.md', category: 'local', hash: 'h3', fm: '', dir: '', override: { category: '技术', contentHash: 'h3' } },
    { path: 'moved.md', category: 'orphan', hash: 'new', fm: '', dir: '', override: { category: '旧', contentHash: 'old' } },
  ];
  assert.deepStrictEqual(fixture.map(function (f) {
    return f.fm || f.dir || (f.override && f.override.contentHash === f.hash ? f.override.category : '') || '未分类';
  }), ['伦理', 'clinical', '技术', '未分类']);
  assert.deepStrictEqual(['root/a.md', 'other/a.md'].map(function (key) { return key; }), ['root/a.md', 'other/a.md']);
  console.log('PASS --check-knowledge-meta: sidecar边界、优先级、指纹失效和纯合成fixture通过');
}

function checkEmptyStates() {
  const masters = fs.readFileSync(require.resolve('../app/js/masters.js'), 'utf8');
  const onboarding = fs.readFileSync(require.resolve('../app/js/onboarding.js'), 'utf8');
  assert.ok(/focusMasterPicker/.test(masters) && /选择大师/.test(masters), '大师空态必须有直接选择大师主操作');
  assert.ok(/first\.focus\(\)/.test(masters), '大师空态主操作必须提供键盘焦点');
  assert.ok(/key: 'profile'.*optional: true/.test(onboarding), '执业画像必须是可选任务');
  assert.ok(/不影响手工工作/.test(onboarding), '执业画像不得成为临床工作流门槛');
  assert.ok(/requiredTasks = tasks\.filter\(function \(t\) \{ return !t\.optional; \}\)/.test(onboarding), '可选任务不得计入完成门槛');
  assert.ok(/allDone = doneN === requiredTasks\.length/.test(onboarding), '自动收起只由必做任务决定');
  console.log('PASS --check-empty-states: 大师空态主操作和可选执业画像引导通过');
}

const checks = {
  '--check-ai-errors': checkAiErrors,
  '--check-billing-reconciliation': checkBillingReconciliation,
  '--check-nav-labels': checkNavLabels,
  '--check-transcript-context': checkTranscriptContext,
  '--check-supervision-materials': checkSupervisionMaterials,
  '--check-knowledge-meta': checkKnowledgeMeta,
  '--check-empty-states': checkEmptyStates,
};
const command = process.argv[2];
if (!checks[command]) {
  console.error('用法: node scripts/ux-audit-fixtures.js --check-ai-errors|--check-billing-reconciliation|--check-nav-labels|--check-transcript-context|--check-supervision-materials|--check-knowledge-meta|--check-empty-states');
  process.exitCode = 2;
} else {
  checks[command]();
}
