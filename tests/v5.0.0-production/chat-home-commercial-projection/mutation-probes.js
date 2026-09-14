'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CHAT_HOME, runSuite } = require('./run-contract');

const original = fs.readFileSync(CHAT_HOME, 'utf8');

async function expectMutationCaught(name, mutate) {
  let caught = false;
  try {
    await runSuite(mutate(original));
  } catch (error) {
    caught = true;
    console.log(`${name}: caught (${error.message})`);
  }
  assert.equal(caught, true, `${name} must be caught by the contract suite`);
}

async function main() {
  await expectMutationCaught('remove-assistant-role-guard', source => source.replace(
    "if (role === 'assistant') {",
    'if (true) {'
  ));
  await expectMutationCaught('accept-unsafe-numeric-values', source => source.replace(
    "return Number.isSafeInteger(value) && value >= 0;",
    'return true;'
  ));
  await expectMutationCaught('drop-restore-projection', source => source.replace(
    'renderMsg(m.role, m.content, m.commercial);',
    'renderMsg(m.role, m.content);'
  ));
  await expectMutationCaught('bypass-canonical-allowlist', source => source.replace(
    'const normalized = XJEntitlements.normalizeCommercialProjection(value);',
    'const normalized = value;'
  ));
  console.log('chat-home commercial projection mutation probes: 4/4 caught');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
