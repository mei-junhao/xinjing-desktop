'use strict';
// 关闭确认窗专用 preload：仅暴露一个安全的「抉择」通道给页面
const { contextBridge, ipcRenderer } = require('electron');

// action: 'cancel'(取消退出，主窗口保持打开) | 'stay'(后台常驻) | 'quit'(完全退出)
const api = {
  decide: (action) => ipcRenderer.send('xj:closeDecision', action)
};

try {
  contextBridge.exposeInMainWorld('__XJ_CLOSE__', api);
  console.log('[XJ-CLOSE] bridge __XJ_CLOSE__ exposed');
} catch (e) {
  console.error('[XJ-CLOSE] exposeInMainWorld FAILED:', (e && e.message) || e);
}
