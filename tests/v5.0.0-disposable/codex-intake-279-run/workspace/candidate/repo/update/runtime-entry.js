'use strict';

function registerUpdateIntegrityIpc(options) {
  const opts = options || {};
  if (!opts.ipcMain || typeof opts.ipcMain.handle !== 'function' || typeof opts.createCoordinator !== 'function' || typeof opts.inputFactory !== 'function') {
    throw new TypeError('invalid update runtime entry');
  }
  opts.ipcMain.handle('xj:update-integrity:run', async (_event, request) => {
    const input = opts.inputFactory(request || {});
    const coordinator = opts.createCoordinator(input.channel);
    return coordinator.run(input);
  });
  opts.ipcMain.handle('xj:update-integrity:recover', async (_event, marker) => {
    if (!marker || !['nsis', 'portable'].includes(marker.channel)) return { ok: false, errorCode: 'channel-mismatch' };
    try {
      const coordinator = opts.createCoordinator(marker.channel);
      const recovered = coordinator.recover(marker);
      return { ok: true, state: recovered.state, operationId: recovered.operationId, version: recovered.version, channel: recovered.channel };
    } catch (error) {
      return { ok: false, errorCode: error && error.code ? error.code : 'stale-pending' };
    }
  });
}

module.exports = { registerUpdateIntegrityIpc };
