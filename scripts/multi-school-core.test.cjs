'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const syndicate = require('../app/js/supervision-syndicate.js');

function loadMastersCore(ai) {
  const source = fs.readFileSync(path.join(__dirname, '../app/js/masters-core.js'), 'utf8');
  const context = {
    AI: ai,
    getMasterByKey: (key) => ({ key, name: key, systemPrompt: '合成大师系统提示' }),
    console,
    Date,
    Math,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.__MastersCore = MastersCore;', context);
  return context.__MastersCore;
}

function makeProvider(responder) {
  const calls = [];
  const provider = {
    send(messages, callback, options) {
      calls.push({ messages, options: options || {} });
      const result = responder({ messages, options: options || {}, index: calls.length });
      if (result && result.delta && options && typeof options.onDelta === 'function') {
        options.onDelta(result.delta, result.delta);
      }
      callback(result && result.value !== undefined ? result.value : result);
    },
  };
  return { provider, calls };
}

function makeStore() {
  const rows = [];
  return {
    rows,
    async saveAiSupervisionDurable(payload) {
      const value = { ...payload, id: 'synthetic-archive-' + (rows.length + 1) };
      rows.push(value);
      return { ok: true, value };
    },
  };
}

function assertMessageShape(calls) {
  assert.ok(calls.length > 0, 'provider 应至少被调用一次');
  for (const call of calls) {
    assert.equal(call.messages[0].role, 'system');
    assert.equal(call.messages[1].role, 'user');
    assert.equal(typeof call.messages[0].content, 'string');
    assert.equal(typeof call.messages[1].content, 'string');
  }
}

async function testDirectProviderSegmentationAndCallbacks() {
  const progress = [];
  const deltas = [];
  const { provider, calls } = makeProvider(({ messages }) => {
    const user = messages[1].content;
    if (user.includes('路由 JSON')) return { content: '{"schools":["sup-winnicott"]}' };
    if (user.includes('请从你的学派督导视角')) return { content: '合成学派分析', delta: '学派增量' };
    if (user.includes('请输出三段式综合督导')) return { content: '【对比表】合成对比\n【分歧点】合成分歧\n【整合建议】合成建议', delta: '综合增量' };
    return { content: '分段摘要' };
  });
  const material = '合成材料'.repeat(8001); // 32004 字，必经分段摘要
  const result = await syndicate.runMultiSchoolSupervision({
    material,
    schools: ['sup-winnicott'],
    onProgress: (event) => progress.push(event),
    onDelta: (piece, fullText, stage) => deltas.push({ piece, fullText, stage }),
  }, { provider });
  assert.equal(result.ok, true);
  assert.equal(result.summarized, true);
  assert.equal(result.totalSegments, 2);
  assertMessageShape(calls);
  assert.ok(calls.some((call) => call.messages[1].content.includes('第 1 / 2 段')));
  assert.ok(calls.some((call) => call.messages[1].content.includes('第 2 / 2 段')));
  assert.ok(progress.some((event) => event.type === 'summary'));
  assert.ok(progress.some((event) => event.type === 'route'));
  assert.ok(progress.some((event) => event.type === 'school-result'));
  assert.ok(deltas.some((event) => event.stage === 'school:sup-winnicott'));
  assert.ok(deltas.some((event) => event.stage === 'synthesis'));
}

async function testPartialSummaryStopsPipeline() {
  const stages = [];
  let summaryCalls = 0;
  const { provider, calls } = makeProvider(({ messages }) => {
    const user = messages[1].content;
    if (user.includes('第 1 / 2 段')) return { content: '第一段摘要' };
    if (user.includes('第 2 / 2 段')) {
      summaryCalls += 1;
      return { error: '合成摘要失败', errorCode: 'SYNTHETIC_SUMMARY_FAILURE' };
    }
    stages.push(user);
    return { content: '不应到达的后续阶段' };
  });
  const result = await syndicate.runMultiSchoolSupervision({
    material: '失败材料'.repeat(8001),
    schools: ['sup-winnicott'],
    onProgress: (event) => stages.push(event.type),
  }, { provider });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'PARTIAL_SUMMARY');
  assert.deepEqual(result.failedSegments, [2]);
  assert.equal(summaryCalls, 2, '失败摘要按既有重试策略调用两次');
  assert.equal(stages.includes('route'), false, '摘要失败后不应进入路由');
  assert.equal(stages.includes('school-start'), false, '摘要失败后不应调用学派');
  assert.equal(calls.length, 3, '第一段一次、失败分段两次，之后不再调用');
}

async function testMastersCorePathAndLengthBoundary() {
  const callbacks = [];
  const ai = {
    send(messages, callback, options) {
      assert.equal(messages[0].role, 'system');
      assert.equal(messages[1].role, 'user');
      if (options && typeof options.onDelta === 'function') options.onDelta('大师增量', '大师增量');
      callback({ content: messages[1].content.includes('请从你的学派督导视角') ? '大师学派分析' : '【对比表】大师综合' });
    },
  };
  const mastersCore = loadMastersCore(ai);
  const result = await syndicate.runMultiSchoolSupervision({
    material: '短合成材料',
    schools: ['sup-winnicott'],
    onProgress: (event) => callbacks.push({ type: event.type }),
    onDelta: (piece, fullText, stage) => callbacks.push({ type: 'delta', piece, fullText, stage }),
  }, { mastersCore });
  assert.equal(result.ok, true);
  assert.ok(callbacks.some((event) => event.type === 'delta' && event.stage === 'school:sup-winnicott'));
  assert.ok(callbacks.some((event) => event.type === 'delta' && event.stage === 'synthesis'));

  const boundaryProvider = makeProvider(({ messages }) => {
    const user = messages[1].content;
    if (user.includes('路由 JSON')) return { content: '{"schools":["sup-winnicott"]}' };
    if (user.includes('第 ') && user.includes(' / ') && user.includes('段')) return { content: '边界摘要' };
    if (user.includes('请从你的学派督导视角')) return { content: '边界学派分析' };
    if (user.includes('请输出三段式综合督导')) return { content: '边界综合' };
    return { content: '边界摘要' };
  });
  const accepted = await syndicate.runMultiSchoolSupervision({
    material: '长'.repeat(240000),
    schools: ['sup-winnicott'],
  }, { provider: boundaryProvider.provider });
  assert.equal(accepted.ok, true, '240000 字应在上限内接受');
  const rejected = await syndicate.runMultiSchoolSupervision({
    material: '长'.repeat(240001),
    schools: ['sup-winnicott'],
  }, { provider: boundaryProvider.provider });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.errorCode, 'MATERIAL_TOO_LONG', '240001 字应明确拒绝');
}

async function testRunAndArchiveForcesOptions() {
  const store = makeStore();
  const { provider } = makeProvider(({ messages }) => {
    const user = messages[1].content;
    if (user.includes('请从你的学派督导视角')) return { content: '归档学派分析' };
    if (user.includes('请输出三段式综合督导')) return { content: '归档综合' };
    return { content: '不应需要摘要' };
  });
  const result = await syndicate.runAndArchive({
    material: '归档合成材料',
    schools: ['sup-winnicott'],
    options: { autoSave: false, requireArchive: false },
  }, { store, provider });
  assert.equal(result.ok, true);
  assert.equal(result.archive.ok, true, 'request.options 不得覆盖 runAndArchive 的强制归档');
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].mode, 'multi-school');
}

async function main() {
  await testDirectProviderSegmentationAndCallbacks();
  await testPartialSummaryStopsPipeline();
  await testMastersCorePathAndLengthBoundary();
  await testRunAndArchiveForcesOptions();
  console.log('PASS: 多学派核心 provider/MastersCore 双路径、分段结构、摘要失败短路、回调、长度边界及强制归档');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
