'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const modulePath = process.env.TEMPLATE_VM_MODULE || path.join(__dirname, '..', '..', '..', 'app', 'js', 'session-template-view-model.js');
const source = fs.readFileSync(modulePath, 'utf8');
const context = { module: { exports: {} }, exports: {}, globalThis: {}, Object, Array, String, Boolean, Number, Error };
vm.createContext(context); vm.runInContext(source, context, { filename: modulePath });
const VM = context.module.exports;
function check(label, fn) { try { fn(); console.log('[PASS] ' + label); } catch (e) { console.log('[FAIL] ' + label + ': ' + e.message); throw e; } }
check('Free sees only manual template', function () { const r = VM.list({ tier: 'Free', context: 'individual' }); assert.strictEqual(r.templates.length, 1); assert.strictEqual(r.templates[0].tier, 'Free'); });
check('Pro sees Free and Pro', function () { assert.strictEqual(VM.list({ tier: 'Pro', context: 'individual' }).templates.length, 2); });
check('Full normalizes to Pro', function () { assert.strictEqual(VM.list({ tier: 'Full', context: 'individual' }).templates.length, 2); });
check('Flagship and context filter work', function () { const r = VM.select('flagship-session-v1', { tier: 'Flagship', context: 'supervision' }); assert.strictEqual(r.ok, true); });
check('unknown tier and unavailable template fail closed', function () { assert.strictEqual(VM.list({ tier: 'Unknown' }).code, 'unknown-tier'); assert.strictEqual(VM.select('flagship-session-v1', { tier: 'Free' }).code, 'template-unavailable'); });
check('apply returns frozen ephemeral draft', function () { const t = VM.select('manual-session-v1', { tier: 'Free' }).template; const r = VM.apply(t, 'session-1'); assert.strictEqual(r.ok, true); assert(Object.isFrozen(r.draft)); assert.strictEqual(r.draft.sessionId, 'session-1'); });
check('invalid session and empty template fail closed', function () { const t = VM.select('manual-session-v1', { tier: 'Free' }).template; assert.strictEqual(VM.apply(t, '').code, 'session-required'); assert.strictEqual(VM.apply({ id: 'x', entries: [] }, 's').code, 'template-empty'); });
console.log('session-template-view-model: PASS');
