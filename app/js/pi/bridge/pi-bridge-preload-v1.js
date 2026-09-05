'use strict';
/**
 * pi-bridge-preload-v1.js — preload 侧安全 API 形状（XJ-5.1.0-...-003）
 * 供 Codex 在 preload.js 一行接入：createPiPreloadApi(ipcRenderer)。
 * renderer 只见白名单方法名 + invoke 封装；永不暴露 ipcRenderer 原始对象/生产写 API。
 */
const P = require('../pi-protocol-v1.js');

const PRELOAD_METHODS = Object.freeze([
  'startTask', 'contextCheck', 'plan', 'runToolStep', 'commitStep',
  'resolveApproval', 'pause', 'resume', 'cancel', 'diagnose', 'timeoutScan',
]);
const CHANNEL = 'xj-pi-v1:invoke';

/**
 * createPiPreloadApi(ipcRenderer, options)
 *   options.mutations.allowBypassPreload：变异开关——返回原始 invoke 通道（仅测试可观察）
 */
function createPiPreloadApi(ipcRenderer, options) {
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') throw new Error('ipcRenderer required');
  const mutations = (options && options.mutations) || {};
  const api = { __xjPiBridgeVersion: 1 };
  for (const method of PRELOAD_METHODS) {
    api[method] = (...args) => ipcRenderer.invoke(CHANNEL, { method, args });
  }
  if (mutations.allowBypassPreload) {
    api.__raw = { invoke: (channel, payload) => ipcRenderer.invoke(channel, payload) }; // 变异开关：绕过 preload 白名单
  }
  return Object.freeze(api);
}

module.exports = { createPiPreloadApi, PRELOAD_METHODS, CHANNEL };
