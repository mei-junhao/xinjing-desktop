'use strict';

// 004 运行时使用生产 preload：它必须在 sandbox 下工作；此文件只在测试页
// 提供一个最小的 getState/version 兼容桥，Pi 白名单仍来自 production preload。
const { contextBridge, ipcRenderer } = require('electron');
const PI_METHODS = Object.freeze([
  'startTask', 'contextCheck', 'plan', 'runToolStep', 'commitStep',
  'resolveApproval', 'pause', 'resume', 'cancel', 'diagnose', 'timeoutScan',
]);
const PI_CHANNEL = 'xj-pi-v1:invoke';
const REQUEST_CHANNEL = 'xj:pi:renderer-request';
const REPLY_CHANNEL = 'xj:pi:renderer-reply';
const PUBLISH_CHANNEL = 'xj:pi:publish-state';

const piApi = { __xjPiBridgeVersion: 1 };
PI_METHODS.forEach((method) => {
  piApi[method] = (...args) => ipcRenderer.invoke(PI_CHANNEL, { method, args });
});
const piTransport = Object.freeze({
  onRequest: (cb) => {
    if (typeof cb !== 'function') return null;
    const handler = (_event, request) => {
      if (!request || typeof request !== 'object') return;
      cb({ requestId: String(request.requestId || ''), kind: String(request.kind || ''), payload: request.payload });
    };
    ipcRenderer.on(REQUEST_CHANNEL, handler);
    return () => ipcRenderer.removeListener(REQUEST_CHANNEL, handler);
  },
  reply: (requestId, response) => { ipcRenderer.send(REPLY_CHANNEL, { requestId, response }); return true; },
  publishState: (state) => { ipcRenderer.send(PUBLISH_CHANNEL, state); return true; },
});

contextBridge.exposeInMainWorld('__PI__', Object.freeze(piApi));
contextBridge.exposeInMainWorld('__XJ_API__', Object.freeze({
  getState: () => ipcRenderer.invoke('xj:getState'),
  getVersion: () => ipcRenderer.invoke('xj:getVersion'),
  piTransport,
}));
