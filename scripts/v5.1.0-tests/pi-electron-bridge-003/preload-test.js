'use strict';
/** 003 测试专用 preload：contextBridge 暴露 pi-bridge-preload-v1 白名单 API（隔离测试用） */
const { contextBridge, ipcRenderer } = require('electron');
const { createPiPreloadApi } = require('../../../app/js/pi/bridge/pi-bridge-preload-v1.js');
try {
  contextBridge.exposeInMainWorld('__PI__', createPiPreloadApi(ipcRenderer));
  contextBridge.exposeInMainWorld('__PITEST__', { projection: () => ipcRenderer.invoke('xj-pi-test:projection') });
} catch (e) { /* 测试 preload 失败由 harness 探针暴露 */ }
