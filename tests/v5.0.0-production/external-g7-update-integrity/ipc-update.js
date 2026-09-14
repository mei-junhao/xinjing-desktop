'use strict';
// ipc-update.js — typed IPC allowlist tests (decision 2.5 / contract §12):
// unknown methods, fields, states, channels, strategies rejected; typed status
// mapping; no paths/updater objects in renderer payloads.
const { Suite } = require('./_testkit');
const ipc = require('../../../app/update/ipc-update');
const s = new Suite('ipc-update');

// unknown method
let r = '';
try { ipc.validateRequest('xj:check-updates', {}); } catch (e) { r = e.code; }
s.ok('unknown method rejected', r === 'unknown-method:xj:check-updates', r);

r = '';
try { ipc.validateRequest('xj:update:delete-everything', {}); } catch (e) { r = e.code; }
s.ok('unknown update method rejected', r === 'unknown-method:xj:update:delete-everything', r);

// unknown field
r = '';
try { ipc.validateRequest('xj:update:check', { channel: 'stable', strategy: 'installer', installNow: true }); } catch (e) { r = e.code; }
s.ok('unknown field rejected', r === 'unknown-field:installNow', r);

// missing required field
r = '';
try { ipc.validateRequest('xj:update:check', { strategy: 'installer' }); } catch (e) { r = e.code; }
s.ok('missing required field rejected', r === 'missing-field:channel', r);

// unknown channel / strategy / state
r = '';
try { ipc.validateRequest('xj:update:check', { channel: 'latest', strategy: 'installer' }); } catch (e) { r = e.code; }
s.ok('unknown channel rejected', r === 'unknown-channel:latest', r);

r = '';
try { ipc.validateRequest('xj:update:check', { channel: 'stable', strategy: 'nsis' }); } catch (e) { r = e.code; }
s.ok('unknown strategy rejected', r === 'unknown-strategy:nsis', r);

r = '';
try { ipc.validateState('commited'); } catch (e) { r = e.code; }
s.ok('unknown state rejected', r === 'unknown-state:commited', r);

// bad operationId / decision
r = '';
try { ipc.validateRequest('xj:update:confirm', { operationId: '../x', decision: 'now' }); } catch (e) { r = e.code; }
s.ok('bad operationId rejected', r === 'bad-operationId', r);

r = '';
try { ipc.validateRequest('xj:update:confirm', { operationId: 'op-1', decision: 'maybe' }); } catch (e) { r = e.code; }
s.ok('bad decision rejected', r === 'bad-decision', r);

// typed status: no paths/updater objects; bounded fields
const status = ipc.typedStatus({ state: 'health-check', operationId: 'op-1', version: '4.3.0', channel: 'stable', strategy: 'portable', progress: 50, errorCode: 'x' });
s.ok('typed status maps state', status.state === 'health-check' && status.committed === false);
s.ok('typed status bounded fields', typeof status.version === 'string' && !('path' in status) && !('updater' in status) && status.progress === 50);

const committed = ipc.typedStatus({ state: 'committed', operationId: 'op-1', version: '4.3.0', channel: 'stable', strategy: 'installer' });
s.ok('committed only via committed state', committed.committed === true && committed.state === 'committed');

// unknown internal state -> rejected
r = '';
try { ipc.typedStatus({ state: 'happy-ending' }); } catch (e) { r = e.code; }
s.ok('unknown internal state rejected', r === 'unknown-state:happy-ending', r);

// coordinator states map to UI states
s.ok('coordinator mapping complete', Object.keys(ipc.COORDINATOR_TO_UI).length === 11 && ipc.COORDINATOR_TO_UI['awaiting-confirmation'] === 'awaiting-confirmation' && ipc.COORDINATOR_TO_UI.committed === 'committed');

// guarded handler converts throws to typed failure
const guarded = ipc.guarded('xj:update:check', async () => { throw new Error('boom'); });
guarded({}, { channel: 'stable', strategy: 'installer' }).then((res) => {
  s.ok('guarded handler typed failure', res.ok === false && res.state === 'failed' && res.errorCode && !String(res.detail).includes('api_key'));
  console.log('IPC_STATUS=' + (s.fail === 0 ? 'PASS' : 'FAIL'));
  process.exit(s.finish() ? 0 : 1);
}).catch((e) => { console.error(e); process.exit(1); });
