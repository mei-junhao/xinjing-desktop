'use strict';

const assert = require('assert');
const fs = require('fs');
const {
  AGENT_CORE_SOURCE_PATH,
  assertKindRequiresConfirmation,
  assertMissingConfirmationFailsClosed,
} = require('./run-contract');

async function expectKilled(label, run) {
  let killed = false;
  try {
    await run();
  } catch (_) {
    killed = true;
  }
  assert.ok(killed, label + ' mutation survived');
  console.log('KILLED', label);
}

async function main() {
  const source = fs.readFileSync(AGENT_CORE_SOURCE_PATH, 'utf8');
  const marker = "if (tool.kind !== 'read') {";
  assert.ok(source.includes(marker), 'default-deny confirmation marker missing');

  const legacyWriteOnly = source.replace(marker, "if (tool.kind === 'write') {");
  await expectKilled('restore-write-only-confirmation', function () {
    return assertKindRequiresConfirmation(legacyWriteOnly, 'config');
  });

  const bypassAll = source.replace(marker, 'if (false) {');
  await expectKilled('bypass-non-read-confirmation', function () {
    return assertMissingConfirmationFailsClosed(bypassAll, 'write-light');
  });
}

main().catch((error) => {
  console.error('FAIL agent-tool-confirmation-mutations:', error && error.stack || error);
  process.exitCode = 1;
});
