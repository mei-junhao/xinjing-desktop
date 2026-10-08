'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('XJ279', Object.freeze({
  runUpdate: (request) => ipcRenderer.invoke('xj:update-integrity:run', request),
  recoverUpdate: (marker) => ipcRenderer.invoke('xj:update-integrity:recover', marker),
  finish: (result) => ipcRenderer.send('xj279:harness-result', result),
}));
