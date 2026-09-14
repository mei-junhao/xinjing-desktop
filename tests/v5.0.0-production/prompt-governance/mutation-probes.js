'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const governancePath = path.resolve(__dirname, '../../../app/js/prompt-governance.js');
const original = fs.readFileSync(governancePath, 'utf8');

function loadMutant(name, from, to) {
  assert.ok(original.indexOf(from) >= 0, name + ' mutation anchor must exist');
  const source = original.replace(from, to);
  const context = {
    module: { exports: {} },
    exports: {},
    globalThis: {},
    encodeURIComponent: encodeURIComponent,
    unescape: unescape,
    JSON: JSON,
    Math: Math,
    Object: Object,
    String: String,
    Array: Array,
    Error: Error,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: name + '.mutant.js' });
  return context.module.exports;
}

function definition(id, content, changeLog) {
  return {
    id: id,
    version: '4.4.0',
    task: 'test-task',
    model: 'test-model',
    author: 'test-author',
    source: 'test-source',
    changeLog: changeLog == null ? ['test change'] : changeLog,
    content: content,
  };
}

function expectKilled(name, mutant, oracle) {
  let killed = false;
  try { oracle(mutant); } catch (error) { killed = true; }
  assert.strictEqual(killed, true, name + ' mutation survived');
  console.log('killed:', name);
}

expectKilled(
  'missing-change-log-acceptance',
  loadMutant('missing-change-log-acceptance', "if (!changeLog.length) throw new Error('Prompt governance requires a non-empty changeLog');", 'if (false) throw new Error(\'mutant\');'),
  function (governance) {
    assert.throws(function () { governance.registerPrompt(definition('missing-log', 'body', [])); });
  }
);

expectKilled(
  'same-version-hash-mismatch-acceptance',
  loadMutant('same-version-hash-mismatch-acceptance', 'previous.contentHash !== normalized.contentHash', 'false'),
  function (governance) {
    governance.registerPrompt(definition('same-version', 'body one'));
    assert.throws(function () { governance.registerPrompt(definition('same-version', 'body two')); });
  }
);

expectKilled(
  'knowledge-conflict-acceptance',
  loadMutant('knowledge-conflict-acceptance', 'if (conflicts.length) return { ok: false, sources: publicSources, conflicts: conflicts, text: \'\' };', 'if (false) return { ok: false, sources: publicSources, conflicts: conflicts, text: \'\' };'),
  function (governance) {
    const result = governance.mergeKnowledgeSources([
      { id: 'master:demo', version: 'v1', kind: 'master-builtin', label: '大师内置知识', source: 'demo.md', content: 'one' },
      { id: 'master:demo', version: 'v1', kind: 'master-builtin', label: '大师内置知识', source: 'demo.md', content: 'two' },
    ]);
    assert.strictEqual(result.ok, false);
  }
);

expectKilled(
  'style-source-guard-removal',
  loadMutant('style-source-guard-removal', 'output.push(FACT_AND_SOURCE_GUARD);', "output.push('');"),
  function (governance) {
    const prompt = governance.buildPrompt(Object.assign(definition('guarded', 'template'), { template: 'template', style: 'style' }));
    assert.match(prompt, /事实与来源边界/);
  }
);

console.log('prompt-governance mutations: 4/4 killed');
