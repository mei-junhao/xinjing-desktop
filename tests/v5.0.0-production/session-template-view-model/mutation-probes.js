'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const modulePath = path.join(__dirname, '..', '..', '..', 'app', 'js', 'session-template-view-model.js');
const runner = path.join(__dirname, 'run-contract.js');
const source = fs.readFileSync(modulePath, 'utf8'); const tmp = [];
function probe(id, mutate) { const p = path.join(__dirname, 'mutated-' + id + '.js'); fs.writeFileSync(p, mutate(source), 'utf8'); tmp.push(p); const r = cp.spawnSync(process.execPath, [runner], { env: Object.assign({}, process.env, { TEMPLATE_VM_MODULE: p }), encoding: 'utf8' }); const killed = r.status !== 0; console.log((killed ? '[KILLED] ' : '[SURVIVED] ') + id); return killed; }
const results = [
  probe('tier-fail-open', s => s.replace("if (!current) return fail('unknown-tier');", "if (!current) current = 'Flagship';")),
  probe('full-upgrade', s => s.replace("if (value === 'Full') return 'Pro';", "if (value === 'Full') return 'Flagship';")),
  probe('unknown-template-allow', s => s.replace("return item ? freeze({ ok: true, template: item }) : fail('template-unavailable');", "return item ? freeze({ ok: true, template: item }) : freeze({ ok: true, template: TEMPLATES[0] });")),
  probe('empty-draft-allow', s => s.replace("if (!entries.length) return fail('template-empty');", "if (!entries.length) entries = [''];"))
];
tmp.forEach(p => { try { fs.unlinkSync(p); } catch (_) {} });
console.log('session-template mutations: ' + results.filter(Boolean).length + '/' + results.length + ' killed');
process.exit(results.every(Boolean) ? 0 : 1);
