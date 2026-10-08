'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../../..');
const governancePath = path.join(root, 'app/js/prompt-governance.js');
const supervisorsPath = path.join(root, 'app/js/supervisors.js');
const mastersCorePath = path.join(root, 'app/js/masters-core.js');
const agentCorePath = path.join(root, 'app/js/agent-core.js');
const supervisionCorePath = path.join(root, 'app/js/supervision-core.js');

function freshGovernance() {
  delete require.cache[require.resolve(governancePath)];
  delete global.PromptGovernance;
  return require(governancePath);
}

function definition(id, content) {
  return {
    id: id,
    version: '4.4.0',
    task: 'test-task',
    model: 'test-model',
    author: 'test-author',
    source: 'test-source',
    changeLog: ['test change'],
    content: content,
  };
}

function loadMastersCore(governance) {
  const source = fs.readFileSync(mastersCorePath, 'utf8') + '\nthis.__mastersCore = MastersCore;';
  const context = {
    PromptGovernance: governance,
    PromptsBuiltin: { STYLE_CONSTRAINTS: 'STYLE_LAYER' },
    Knowledge: { byTemp: function () { return 'MASTER_KNOWLEDGE'; } },
    window: { UserDocs: { getContextBlock: function () { return 'USER_LIBRARY'; } } },
    console: console,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: mastersCorePath });
  return context.__mastersCore;
}

function loadSupervisionCore(governance) {
  const source = fs.readFileSync(supervisionCorePath, 'utf8') + '\nthis.__supervisionCore = SupervisionCore;';
  const context = { PromptGovernance: governance, console: console, window: {} };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: supervisionCorePath });
  return context.__supervisionCore;
}

function run() {
  const governance = freshGovernance();
  const expectedAbc = crypto.createHash('sha256').update('abc', 'utf8').digest('hex');
  assert.strictEqual(governance.sha256('abc'), expectedAbc, 'SHA-256 must match the platform implementation');
  assert.strictEqual(governance.sha256('中文'), crypto.createHash('sha256').update('中文', 'utf8').digest('hex'), 'SHA-256 must be UTF-8 stable');

  const registered = governance.registerPrompt(definition('test.system', 'stable template'));
  ['id', 'version', 'task', 'model', 'author', 'source', 'changeLog', 'contentHash'].forEach(function (field) {
    assert.ok(registered[field], 'manifest must retain ' + field);
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(registered, 'content'), false, 'manifest must not retain raw prompt text');
  assert.throws(function () {
    governance.registerPrompt(definition('test.system', 'changed template without a version bump'));
  }, /version bump/, 'same-version template changes must be rejected');

  const deduped = governance.mergeKnowledgeSources([
    { id: 'master:demo', version: 'v1', kind: 'master-builtin', label: '大师内置知识', source: 'demo.md', content: 'master facts' },
    { id: 'master:demo', version: 'v1', kind: 'master-builtin', label: '大师内置知识', source: 'demo.md', content: 'master facts' },
    { id: 'active-context', version: 'runtime-v1', kind: 'user-library', label: '我的资料库', source: 'UserDocs.getContextBlock', content: 'user notes' },
  ]);
  assert.strictEqual(deduped.ok, true, 'identical sources must be deduplicated');
  assert.strictEqual(deduped.sources.length, 2, 'deduplicated merge must retain two distinct source labels');
  assert.match(deduped.text, /大师内置知识/);
  assert.match(deduped.text, /我的资料库/);

  const conflicted = governance.mergeKnowledgeSources([
    { id: 'master:demo', version: 'v1', kind: 'master-builtin', label: '大师内置知识', source: 'demo.md', content: 'old body' },
    { id: 'master:demo', version: 'v1', kind: 'master-builtin', label: '大师内置知识', source: 'demo.md', content: 'changed body' },
  ]);
  assert.strictEqual(conflicted.ok, false, 'same id/version with a different hash must fail closed');
  assert.strictEqual(conflicted.text, '', 'conflicted knowledge must not enter the prompt');

  const styled = governance.buildPrompt(Object.assign(definition('styled.system', 'TEMPLATE'), { template: 'TEMPLATE', style: 'STYLE_LAYER', settings: { promptGovernance: { writingStyleEnabled: true } } }));
  const unstyled = governance.buildPrompt(Object.assign(definition('unstyled.system', 'TEMPLATE'), { template: 'TEMPLATE', style: 'STYLE_LAYER', settings: { promptGovernance: { writingStyleEnabled: false } } }));
  assert.match(styled, /STYLE_LAYER/, 'enabled writing style must be included');
  assert.doesNotMatch(unstyled, /STYLE_LAYER/, 'disabled writing style must be excluded');
  assert.match(styled, new RegExp(governance.FACT_AND_SOURCE_GUARD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(styled.lastIndexOf(governance.FACT_AND_SOURCE_GUARD) > styled.lastIndexOf('STYLE_LAYER'), 'source guard must remain after the optional style layer');

  const masterManifest = governance.createMasterKnowledgeManifest({ key: 'demo', knowledgeFile: 'masters/knowledge/demo.md' }, 'master facts');
  assert.strictEqual(masterManifest.contentHash, governance.sha256('master facts'));

  global.Store = { getSettings: function () { return { promptGovernance: { writingStyleEnabled: false } }; } };
  global.window = global;
  global.PromptsBuiltin = {
    getCangjiePrompt: function () { return 'CANGJIE'; },
    getNvwaPrompt: function () { return 'NVWA'; },
    getWinnicottPrompt: function () { return 'WINNICOTT'; },
    STYLE_CONSTRAINTS: 'STYLE_LAYER',
    WINNICOTT_PERSONA_GUARD: 'PERSONA_GUARD',
  };
  delete require.cache[require.resolve(supervisorsPath)];
  require(supervisorsPath);
  const supervisionPrompt = global.Supervisors.buildSystemPrompt('builtin-freud');
  assert.doesNotMatch(supervisionPrompt, /STYLE_LAYER/, 'supervision must honor the persisted disabled style setting');
  assert.match(supervisionPrompt, /事实与来源边界/, 'supervision prompt must keep the final source guard');

  const mastersCore = loadMastersCore(governance);
  const oneToOne = mastersCore.buildOneToOneSystemPrompt({ summary: '' }, {
    key: 'demo',
    name: 'Demo',
    systemPrompt: 'MASTER_TEMPLATE',
    knowledgeFile: 'masters/knowledge/demo.md',
  }, { includeUserDocs: true });
  assert.doesNotMatch(oneToOne, /STYLE_LAYER/, 'master prompt must honor the persisted disabled style setting');
  assert.match(oneToOne, /大师内置知识/);
  assert.match(oneToOne, /我的资料库/);
  const guarded = mastersCore.buildMessages({ messages: [], importedContext: '' }, {
    key: 'demo', name: 'Demo', systemPrompt: 'MASTER_TEMPLATE', knowledgeFile: 'masters/knowledge/demo.md',
  }, 'test', { systemPrompt: oneToOne })[0].content;
  assert.match(guarded, /事实与来源边界/, 'master request path must append the source guard');

  delete require.cache[require.resolve(agentCorePath)];
  const agentCore = require(agentCorePath);
  agentCore.buildSystemPrompt();
  assert.ok(governance.getPromptManifest().some(function (item) { return item.id === 'agent-core.system'; }), 'agent system prompt must register a manifest entry');

  const supervisionCore = loadSupervisionCore(governance);
  assert.match(supervisionCore.buildRealSupPrompt(), /事实与来源边界/, 'real-supervision parsing must retain the final source guard');
  assert.ok(governance.getPromptManifest().some(function (item) { return item.id === 'supervision.real-supervision-parse.system'; }), 'real-supervision system prompt must register a manifest entry');
  assert.match(fs.readFileSync(mastersCorePath, 'utf8'), /masters\.conversation-summary\.system/, 'master summary system prompt must be versioned');
  assert.match(fs.readFileSync(path.join(root, 'app/js/xinjing-chat.js'), 'utf8'), /xiaojing\.chat\.system/, 'chat system prompt must be versioned');
  assert.match(fs.readFileSync(path.join(root, 'app/js/xiaojing-panel.js'), 'utf8'), /xiaojing\.panel\.system/, 'panel system prompt must be versioned');

  const manifest = governance.getPromptManifest();
  assert.ok(manifest.some(function (item) { return item.id === 'supervision.system.builtin-freud'; }), 'supervision prompt must register a manifest entry');
  assert.ok(manifest.some(function (item) { return item.id === 'masters.system.demo'; }), 'master prompt must register a manifest entry');
  console.log('prompt-governance contract: PASS');
}

run();
