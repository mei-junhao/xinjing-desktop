'use strict';
/**
 * 003 测试专用 Electron main（仅隔离测试加载；不接生产 main.js）
 * 组装 pi-bridge-main + 合成 Store/会员投影 + 真实 ipcMain + BrowserWindow 加载 harness 页。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { createPiBridgeMain } = require('../../../app/js/pi/bridge/pi-bridge-main-v1.js');
const { createDurableAdapter } = require('../../../app/js/pi/bridge/pi-bridge-durable-adapter-v1.js');
const { createProjectionAdapter } = require('../../../app/js/pi/bridge/pi-bridge-projection-adapter-v1.js');

const TEST_DIR = __dirname;
const USER_DATA = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-003-el-'));
app.setPath('userData', USER_DATA);

// 合成 Store（内存）：client/session/来源 + 版本计数 + durable 保存读
const synth = {
  storeVersion: 7,
  membershipVersion: 3,
  saved: new Map(),
  savedSeq: 0,
};
const PROJ_BASE = {
  clientId: 'c_100', sessionId: 's_200',
  sourceRefs: [{ sourceId: 'src_1', sourceVersion: 2, sourceContentHash: 'sha256:' + 'b'.repeat(64), anchorContentHash: 'sha256:' + 'c'.repeat(64) }],
  storeProjectionVersion: synth.storeVersion,
  membershipProjectionVersion: synth.membershipVersion,
};
const projectionAdapter = createProjectionAdapter({
  readSourceRefs: () => PROJ_BASE.sourceRefs,
  readStoreVersion: () => synth.storeVersion,
  readMembershipVersion: () => synth.membershipVersion,
});
const durable = createDurableAdapter({
  saveRecord: async (rec) => {
    const id = 'obj_' + String(++synth.savedSeq);
    synth.saved.set(id, { snapshotHash: rec.snapshotHash, version: 1, fields: rec.fields });
    return { ok: true, savedObjectId: id, version: 1 };
  },
  readRecord: (id) => synth.saved.has(id) ? { ok: true, object: synth.saved.get(id) } : { ok: false, code: 'XJ_PI_VERIFY_FAILED' },
  audit: () => {},
});
const bridge = createPiBridgeMain({
  serverMembershipProjection: () => ({ tier: 'pro' }),
  readProjector: (tool, args) => ({ ok: true, data: { tool, args, synthetic: true } }),
  liveProjection: projectionAdapter.liveProjectionOf('c_100', 's_200'),
  durableWrite: durable.durableWrite,
  durableRead: durable.durableRead,
  eventFile: path.join(USER_DATA, 'pi-events.jsonl'),
  timeoutScanIntervalMs: 500,
});
bridge.registerIpc(ipcMain, 'xj-pi-v1');
// 测试控制通道：暴露合成投影 PROJ 基线给 harness 页（只读）
ipcMain.handle('xj-pi-test:projection', () => PROJ_BASE);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { preload: path.join(TEST_DIR, 'preload-test.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(TEST_DIR, 'harness.html'));
  win.webContents.on('did-finish-load', () => { win.show(); });
  win.on('closed', () => { bridge.stop(); app.exit(0); });
});
