'use strict';
// probe-preload.js — preload for the XJ463 health probe window.
// contextIsolation ON, sandbox ON: the probe page never sees ipcRenderer,
// require or process. Only the frozen typed surface below is exposed.

const { contextBridge, ipcRenderer } = require('electron');

const REPORT_CHANNEL = 'xj463:probe:report';
const PING_CHANNEL = 'xj463:probe:ping';
const WORKFLOW_CHANNEL = 'xj463:probe:workflow';
const START_CHANNEL = 'xj463:probe:start';

contextBridge.exposeInMainWorld('__XJ_PROBE__', Object.freeze({
  ping: (correlationId) => ipcRenderer.invoke(PING_CHANNEL, { correlationId: String(correlationId || '') }),
  report: (report) => { ipcRenderer.send(REPORT_CHANNEL, report || {}); },
  runWorkflow: (payload) => ipcRenderer.invoke(WORKFLOW_CHANNEL, { payload: String(payload || '') }),
  onStart: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.once(START_CHANNEL, (_event, data) => { try { cb(data || {}); } catch (_) {} });
  }
}));
