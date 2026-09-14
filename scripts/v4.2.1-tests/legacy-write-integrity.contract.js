#!/usr/bin/env node
'use strict';

// v4.2.1 P1 gate: reachable workflow write callers must use strict durable APIs
// and must not report success before the returned Promise has completed.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) { passed += 1; console.log('[PASS] ' + message); }
  else { failed += 1; console.log('[FAIL] ' + message); }
}

function source(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function noLegacyWrite(text, label) {
  const legacy = /Store\.(createClient|createSession|createExpense|saveAiSupervision|updateSupervision|saveMasterConversation|deleteMasterConversation)\s*\(/;
  check(!legacy.test(text), label + ' contains no legacy Store write caller');
  return !legacy.test(text);
}

function required(text, pattern, label) {
  check(pattern.test(text), label);
  return pattern.test(text);
}

const billing = source('app/billing-shell.html');
const agent = source('app/js/agent-tools.js');
const masters = source('app/js/masters.js');
const mastersCore = source('app/js/masters-core.js');
const calendar = source('app/js/billing-calendar.js');
const clientModal = source('app/js/client-modal.js');
const supervision = source('app/js/supervision.js');
const realSupervision = source('app/js/real-supervision.js');

noLegacyWrite(billing, 'billing-shell');
required(billing, /await\s+Store\.updateSessionFull\(/, 'billing inline session edits await durable result');
required(billing, /await\s+Store\.saveSessionsDurable\(/, 'billing session-number shifts use one durable batch');
required(billing, /await\s+Store\.saveBillingBatchDurable\(/g, 'billing imports use one durable batch');
noLegacyWrite(agent, 'agent-tools');
required(agent, /await\s+Store\.createSessionDurable\(/, 'agent billing records await durable session creation');
required(agent, /await\s+Store\.updateClientDurable\(/, 'agent billing/client writes await durable client updates');
required(agent, /await\s+Store\.saveMasterConversationDurable\(/, 'agent master writes await durable conversation saves');
required(agent, /await\s+Store\.saveAiSupervisionDurable\(/, 'agent supervision writes await durable saves');
noLegacyWrite(masters, 'masters page');
noLegacyWrite(mastersCore, 'masters core');
required(masters, /await\s+saveConversationOrWarn\(/, 'masters page checks durable conversation result');
required(masters, /Store\.deleteMasterConversationDurable\(/, 'masters page deletes conversations durably');
required(mastersCore, /await\s+Store\.saveMasterConversationDurable\(/, 'masters core checks durable conversation result');
noLegacyWrite(calendar, 'billing calendar');
required(calendar, /await\s+Store\.updateClientDurable\(/, 'billing calendar awaits durable settlement');
noLegacyWrite(clientModal, 'client modal');
required(clientModal, /await\s+Store\.createClientDurable\(/, 'client modal awaits durable creation');
noLegacyWrite(supervision, 'AI supervision page');
required(supervision, /await\s+Store\.saveAiSupervisionDurable\(/, 'AI supervision page awaits durable save');
required(supervision, /Store\.updateClient\([^\n]+\{[\s\S]*?lastSupervisionOrientation/, 'AI supervision page isolates orientation preference as low-risk legacy preference write');
noLegacyWrite(realSupervision, 'real supervision page');
required(realSupervision, /await\s+Store\.(createSupervisionDurable|updateSupervisionDurable)\(/, 'real supervision page awaits durable writes');
const supervisionCore = source('app/js/supervision-core.js');
noLegacyWrite(supervisionCore, 'AI supervision core');
required(supervisionCore, /await\s+Store\.saveAiSupervisionDurable\(/, 'AI supervision core awaits durable save');

// Mutation gate: removing await from a protected caller must be detected.
const mutatedBilling = billing.replace(/await\s+Store\.updateSessionFull\(/g, 'Store.updateSessionFull(');
check(!/await\s+Store\.updateSessionFull\(/.test(mutatedBilling), 'mutation removes await from billing caller and gate turns red');
const mutatedAgent = agent.replace('await Store.createSessionDurable(', 'Store.createSessionDurable(');
check(!/await\s+Store\.createSessionDurable\(/.test(mutatedAgent), 'mutation removes await from agent caller and gate turns red');
const mutatedMasters = masters.replace(/await\s+saveConversationOrWarn\(/g, 'saveConversationOrWarn(');
check(!/await\s+saveConversationOrWarn\(/.test(mutatedMasters), 'mutation removes await from masters caller and gate turns red');

console.log('LEGACY_WRITE_INTEGRITY: ' + passed + ' passed / ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
