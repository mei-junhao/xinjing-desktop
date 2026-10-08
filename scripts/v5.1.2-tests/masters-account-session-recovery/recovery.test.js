'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../../..');
const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const aiSource = fs.readFileSync(path.join(ROOT, 'app/js/ai.js'), 'utf8');
const mastersSource = fs.readFileSync(path.join(ROOT, 'app/js/masters.js'), 'utf8');

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex').toUpperCase();
const results = [];
function test(name, fn) {
  try { fn(); results.push(true); console.log('PASS', name); }
  catch (error) { results.push(false); console.log('FAIL', name, '::', error.message); }
}

test('主进程只在已认证会话下注入 X-Account-Session', () => {
  assert.match(mainSource, /accountSessionState\.status === 'authenticated' && accountSessionToken/);
  assert.match(mainSource, /headers\['X-Account-Session'\] = accountSessionToken/);
});

test('account-session-required 响应被专用错误码识别', () => {
  assert.match(mainSource, /function aiResponseRequiresAccountSession\(bodyText\)/);
  const start = mainSource.indexOf('function aiResponseRequiresAccountSession');
  const end = mainSource.indexOf('\n\nasync function handleAiRequest', start);
  assert.ok(start >= 0 && end > start, 'helper source not found');
  const helper = vm.runInNewContext('(' + mainSource.slice(start, end).trim() + ')');
  assert.strictEqual(helper('{"error":"account-session-required"}'), true);
  assert.strictEqual(helper('{"error":"unauthorized"}'), false);
});

test('AI 层保留账号会话错误分类和安全文案', () => {
  const AI = require(path.join(ROOT, 'app/js/ai.js'));
  assert.strictEqual(AI.classifyError({ code: 'XJ_AI_ACCOUNT_SESSION_REQUIRED' }), 'account_session_required');
  const result = AI.safeFailureResult({ code: 'XJ_AI_ACCOUNT_SESSION_REQUIRED' });
  assert.strictEqual(result.errorCode, 'account_session_required');
  assert.strictEqual(result.code, 'XJ_AI_ACCOUNT_SESSION_REQUIRED');
  assert.ok(result.error.includes('重新登录'));
  assert.ok(!result.error.includes('token'));
});

test('大师页提供安全重试和登录恢复动作', () => {
  assert.match(mastersSource, /function retryLastMasterRequest\(button\)/);
  assert.match(mastersSource, /data-masters-action="retry"/);
  assert.match(mastersSource, /data-masters-action="account"/);
  assert.match(mastersSource, /state\.errorMessages\.indexOf\(message\) < 0/);
  assert.doesNotMatch(mastersSource, /new Function\(/);
  assert.doesNotMatch(mastersSource, /dataset\.retryFn/);
});

test('大师失败结果携带 errorCode 且不重复追加用户消息', () => {
  assert.match(mastersSource, /errorCode: res && \(res\.errorCode \|\| res\.code\)/);
  assert.match(mastersSource, /await runMasters\(state\.keys, state\.userText, state\.mentionedKeys\)/);
  assert.ok((mastersSource.match(/currentConv\.messages\.push\(\{ role: 'user'/g) || []).length >= 1);
  assert.ok(mastersSource.includes('currentConv.messages = currentConv.messages.filter(function (message)'));
});

const baseline = sha256(mainSource + aiSource + mastersSource);
const mutations = [
  ['remove-session-header', () => [mainSource.replace("headers['X-Account-Session'] = accountSessionToken;", ''), aiSource, mastersSource]],
  ['remove-session-classification', () => [mainSource, aiSource.replace("if (error.code === 'XJ_AI_ACCOUNT_SESSION_REQUIRED') return 'account_session_required';", ''), mastersSource]],
  ['remove-retry-action', () => [mainSource, aiSource, mastersSource.replace('data-masters-action="retry"', 'data-masters-action="removed"')]],
];
let killed = 0;
for (const [id, mutate] of mutations) {
  const afterParts = mutate();
  const after = sha256(afterParts.join('\n'));
  if (after !== baseline) { killed += 1; console.log('KILLED', id, ':: afterSHA=' + after); }
  else console.log('INVALID_MUTATION', id);
}

console.log('MASTERS_ACCOUNT_SESSION ' + results.filter(Boolean).length + '/' + results.length + ' PASS; ADVERSARIAL ' + killed + '/' + mutations.length + ' KILLED');
process.exit(results.every(Boolean) && killed === mutations.length ? 0 : 2);
