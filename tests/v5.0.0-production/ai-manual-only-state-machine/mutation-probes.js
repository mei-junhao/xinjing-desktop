'use strict';

const assert = require('assert');
const fs = require('fs');
const { assertManualOnly, assertPrimaryReady, assertPartialDoesNotReplay, AI_SOURCE_PATH } = require('./run-contract');

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
  const source = fs.readFileSync(AI_SOURCE_PATH, 'utf8');
  const manualOnly = "return safeFailureResult(e, { transportState: 'manual-only' });";
  const partialManualOnly = "return safeFailureResult(e, { partial: e.partial, partialContent: e.partialContent, transportState: 'manual-only' });";
  const primaryReady = "transportState: 'primary-ready',";
  assert.ok(source.includes(manualOnly), 'manual-only return marker missing');
  assert.ok(source.includes(partialManualOnly), 'partial manual-only return marker missing');
  assert.ok(source.includes(primaryReady), 'primary-ready marker missing');

  const replayMutant = source.replace(manualOnly,
    "return callDirect(BUILTIN_MODEL, messages, options).then(function (message) { return { content: message.content || '', tier: BUILTIN_MODEL.label, transportState: 'primary-ready' }; });");
  await expectKilled('alternate-provider-replay', () => assertManualOnly(replayMutant));

  const wrongFailureStateMutant = source.replace(manualOnly, "return safeFailureResult(e, { transportState: 'primary-ready' });");
  await expectKilled('manual-only-state-replaced', () => assertManualOnly(wrongFailureStateMutant));

  const wrongSuccessStateMutant = source.replace(primaryReady, "transportState: 'manual-only',");
  await expectKilled('primary-ready-state-replaced', () => assertPrimaryReady(wrongSuccessStateMutant));

  const partialReplayMutant = source.replace(partialManualOnly,
    "return callDirect(BUILTIN_MODEL, messages, options).then(function (message) { return { content: message.content || '', tier: BUILTIN_MODEL.label, transportState: 'primary-ready' }; });");
  await expectKilled('partial-stream-alternate-provider-replay', () => assertPartialDoesNotReplay(partialReplayMutant));
}

main().catch((error) => {
  console.error('FAIL ai-manual-only-mutations:', error && error.stack || error);
  process.exitCode = 1;
});
