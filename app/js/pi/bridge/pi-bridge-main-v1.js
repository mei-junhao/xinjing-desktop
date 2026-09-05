'use strict';
/**
 * pi-bridge-main-v1.js — 主进程桥编排（XJ-5.1.0-...-003）
 * 组装 002 Supervisor/Broker + 投影/durable 适配器 + 事件持久化 + Approval timeout 生产调度；
 * 暴露版本化 IPC 白名单注册工厂（Codex 在 main.js 单行接入：registerPiBridgeIpc(ipcMain, bridge)）。
 * 本文件不 require electron（ipcMain 注入），可在 node 隔离测试。
 */
const P = require('../pi-protocol-v1.js');
const { createSupervisor } = require('../pi-supervisor-v1.js');

const BRIDGE_API_VERSION = 1;
const IPC_METHODS = Object.freeze([
  'startTask', 'contextCheck', 'plan', 'runToolStep', 'commitStep',
  'resolveApproval', 'pause', 'resume', 'cancel', 'diagnose', 'timeoutScan',
]);

/**
 * createPiBridgeMain(options)
 *   options: supervisor 全部注入项（serverMembershipProjection/readProjector/liveProjection/
 *            durableWrite/durableRead/clock）+ eventFile + timeoutScanIntervalMs + mutations
 * 返回 { api, registerIpc(ipcMain, channelPrefix), stop() }
 */
function createPiBridgeMain(options) {
  const opts = options || {};
  const mutations = opts.mutations || {};
  const timeoutScanIntervalMs = Number.isFinite(opts.timeoutScanIntervalMs) && opts.timeoutScanIntervalMs > 0
    ? opts.timeoutScanIntervalMs : 15000;

  const supervisor = createSupervisor(opts);
  const eventFile = typeof opts.eventFile === 'string' ? opts.eventFile : null;
  let eventStore = null;
  if (eventFile) {
    const { createEventStore } = require('./pi-bridge-event-store-v1.js');
    eventStore = createEventStore({ file: eventFile, mutations });
  }

  // Approval timeout 生产调度：不依赖页面轮询；unref 定时器 + 手动 scan 入口
  let scanTimer = null;
  function timeoutScan() {
    const timedOut = supervisor.approvalBroker.checkTimeouts();
    for (const apr of timedOut) {
      // D3：timeout → 任务 paused（与 resolveApproval 同路径；此处由调度触发）
      if (mutations.skipTimeoutScheduling === true) continue; // 变异开关：调度空转（仅测试）
      try {
        const d = supervisor.diagnose(apr.taskId);
        if (d && d.ok === true && d.task.status === 'awaiting_confirmation') {
          supervisor.pause(apr.taskId, 'approval-timeout-scan');
        }
      } catch (e) { /* 诊断失败不影响扫描 */ }
    }
    return { ok: true, scanned: timedOut.length };
  }
  function startScheduler() {
    if (scanTimer || mutations.skipTimeoutScheduling === true) return;
    scanTimer = setInterval(timeoutScan, timeoutScanIntervalMs);
    if (scanTimer.unref) scanTimer.unref();
  }
  function stop() { if (scanTimer) { clearInterval(scanTimer); scanTimer = null; } }

  // 事件审计镜像：supervisor 的关键生命周期事件同步写入持久 store（单写者队列）
  function mirrorEvent(taskId, type, payload, actor) {
    if (!eventStore) return Promise.resolve({ ok: true, mirrored: false });
    return eventStore.append(taskId, type, payload, actor);
  }

  // supervisor 事件镜像钩子：包装 api 方法（进入前后镜像关键事件由 supervisor 内部 eventLog 驱动；
  // 此处镜像 task.* 级事件到持久层——commitStep/cancel/pause/resume/resolve 后各镜像一次）
  const baseApi = {
    startTask: supervisor.startTask,
    contextCheck: supervisor.contextCheck,
    plan: supervisor.plan,
    runToolStep: supervisor.runToolStep,
    commitStep: supervisor.commitStep,
    resolveApproval: supervisor.resolveApproval,
    pause: supervisor.pause,
    resume: supervisor.resume,
    cancel: supervisor.cancel,
    diagnose: supervisor.diagnose,
  };
  const api = {};
  for (const name of Object.keys(baseApi)) {
    const fn = baseApi[name];
    api[name] = function passthrough(...args) { return fn.apply(supervisor, args); };
  }
  // 持久镜像：仅关键生命周期事件（语义与 v1 事件表一致），成功/awaiting 状态分别入账
  api.commitStep = async function (taskId, target, fields) {
    const r = await supervisor.commitStep(taskId, target, fields);
    if (eventStore) {
      if (r && r.ok === true && r.run) await mirrorEvent(taskId, 'task.committed', { savedObjectIds: [r.savedObjectId || 'receiptless'] }, 'bridge');
      else if (r && r.ok === false && r.awaiting) await mirrorEvent(taskId, 'approval.requested', { pendingApprovalId: r.pendingApprovalId }, 'bridge');
    }
    return r;
  };
  api.cancel = async function (taskId, reason) {
    const r = await supervisor.cancel(taskId, reason);
    if (eventStore && r && r.ok === true) await mirrorEvent(taskId, 'task.cancelled', { reason: reason || 'user' }, 'user');
    return r;
  };
  api.pause = async function (taskId, reason) {
    const r = await supervisor.pause(taskId, reason);
    if (eventStore && r && r.ok === true) await mirrorEvent(taskId, 'task.paused', { reason: reason || 'user' }, 'user');
    return r;
  };
  api.resume = async function (taskId) {
    const r = await supervisor.resume(taskId);
    if (eventStore && r && r.ok === true) await mirrorEvent(taskId, 'task.resumed', {}, 'user');
    return r;
  };
  api.timeoutScan = timeoutScan;
  api.replayEvents = eventStore ? () => eventStore.replayAll() : () => ({ ok: true, count: 0, note: 'no event file' });
  api.eventCount = eventStore ? (taskId) => eventStore.count(taskId) : () => 0;

  /** IPC 白名单注册：仅版本化前缀 + 枚举方法；未知方法/未知前缀 fail-closed（renderer 不得任意 invoke） */
  function registerIpc(ipcMain, channelPrefix) {
    if (!ipcMain || typeof ipcMain.handle !== 'function') throw new Error('ipcMain required');
    const prefix = String(channelPrefix || 'xj-pi-v' + BRIDGE_API_VERSION);
    if (!mutations.allowUnknownRoute) {
      ipcMain.handle(prefix + ':invoke', async (event, payload) => {
        const method = payload && payload.method;
        if (!IPC_METHODS.includes(method)) return P.fail('XJ_PI_UNKNOWN_EVENT', 'unknown bridge method: ' + String(method).slice(0, 40));
        if (!event || !event.sender || typeof event.sender.id !== 'number') return P.fail('XJ_PI_UNKNOWN_EVENT', 'untrusted sender');
        if (typeof api[method] !== 'function') return P.fail('XJ_PI_UNKNOWN_EVENT', 'method not wired');
        try { return await api[method].apply(null, payload.args || []); }
        catch (e) { return P.fail('XJ_PI_UNKNOWN_EVENT', 'bridge method threw'); }
      });
    } else {
      // 变异开关：任意方法直通（绕过白名单 = 仅测试可观察）
      ipcMain.handle(prefix + ':invoke', async (_event, payload) => {
        const method = payload && payload.method;
        const target = method ? api[method] || supervisor[method] : null;
        if (typeof target !== 'function') return P.fail('XJ_PI_UNKNOWN_EVENT', 'no such method');
        return target.apply(null, (payload && payload.args) || []);
      });
    }
    return { ok: true, prefix, methods: IPC_METHODS.slice() };
  }

  startScheduler();
  return Object.freeze({ api, registerIpc, stop, version: BRIDGE_API_VERSION, supervisor });
}

module.exports = { createPiBridgeMain, IPC_METHODS, BRIDGE_API_VERSION };
