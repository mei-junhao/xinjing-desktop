'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.join(__dirname, '..', '..', '..', 'app', 'js', 'masters-core.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function load(sourceText) {
  const context = { console, Promise, String, Object, Array, Date, Math, Set, window: {}, getMasterByKey: (key) => ({ key, name: key }) };
  vm.createContext(context);
  vm.runInContext(sourceText + '\n;globalThis.__mastersCore = MastersCore;', context, { filename: 'masters-core.js' });
  return context.__mastersCore;
}

function expectKilled(id, mutantSource, assertion) {
  const mutant = load(mutantSource);
  const survived = assertion(mutant);
  console.log('[' + (survived ? 'FAIL' : 'PASS') + '] ' + id + ': ' + (survived ? 'mutation survived' : 'mutation killed'));
  return !survived;
}

const results = [];
results.push(expectKilled(
  'X1',
  source.replace("const importedContext = String(conv && conv.importedContext || '').trim().slice(0, MAX_IMPORTED_CONTEXT_CHARS);", "const importedContext = '';"),
  (core) => core.buildMessages({ messages: [], importedContext: '历史内容' }, { systemPrompt: 'system' }, '继续').some((message) => message.role === 'user' && message.content.includes('历史内容'))
));
results.push(expectKilled(
  'X2',
  source.replace("return 'user';", "return 'assistant';"),
  (core) => core.parseImportedHistory('咨询师：合成问题', 'winnicott').messages[0].role === 'user'
));
results.push(expectKilled(
  'X3',
  source.replace('slice(-MAX_IMPORT_MESSAGES)', 'slice(0, MAX_IMPORT_MESSAGES)'),
  (core) => {
    const sourceText = Array.from({ length: core.MAX_IMPORT_MESSAGES + 1 }, (_, index) => '咨询师：第' + index).join('\n');
    const parsed = core.parseImportedHistory(sourceText, 'winnicott');
    return parsed.messages[parsed.messages.length - 1].content === '第' + core.MAX_IMPORT_MESSAGES;
  }
));

const passed = results.filter(Boolean).length;
console.log('Killed: ' + passed + ' | Survived: ' + (results.length - passed));
process.exit(passed === results.length ? 0 : 1);
