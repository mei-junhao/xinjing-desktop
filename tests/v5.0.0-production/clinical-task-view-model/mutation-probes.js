'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const modulePath = path.join(__dirname, '..', '..', '..', 'app', 'js', 'clinical-task-view-model.js');
const runner = path.join(__dirname, 'run-contract.js');
const source = fs.readFileSync(modulePath, 'utf8');
const tmp = [];
function probe(id, mutate) {
  const p = path.join(__dirname, 'mutated-' + id + '.js'); fs.writeFileSync(p, mutate(source), 'utf8'); tmp.push(p);
  const r = cp.spawnSync(process.execPath, [runner], { env: Object.assign({}, process.env, { TASK_VM_MODULE: p }), encoding: 'utf8' });
  const killed = r.status !== 0; console.log((killed ? '[KILLED] ' : '[SURVIVED] ') + id); return killed;
}
const results = [
  probe('cross-client-gate', s => s.replace("if (task.clientId !== clientId)", "if (false)")),
  probe('draft-auto-open', s => s.replace("if (normalized.value.status !== STATUSES.AI_DRAFT) return result(false, null, 'not-ai-draft');", "if (false) return result(false, null, 'not-ai-draft');")),
  probe('body-gate', s => s.replace("if (!input || typeof input !== 'object' || hasBodyKey(input))", "if (!input || typeof input !== 'object' || false && hasBodyKey(input))")),
  probe('tier-terminal', s => s.replace("if (options.includeTerminal === true) terminal.push(task);", "terminal.push(task);")),
  probe('source-ref-stripping', s => s.replace("sourceRefs: refs,", "sourceRefs: [],"))
];
tmp.forEach(p => { try { fs.unlinkSync(p); } catch (_) {} });
console.log('clinical-task mutations: ' + results.filter(Boolean).length + '/' + results.length + ' killed');
process.exit(results.every(Boolean) ? 0 : 1);
