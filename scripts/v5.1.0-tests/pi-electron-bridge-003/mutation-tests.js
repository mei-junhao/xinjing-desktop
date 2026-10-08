'use strict';
/**
 * XJ-5.1.0-...-003 — 桥层反向变异测试（14 项，全部必须 KILLED）
 * 判定：KILLED = 基线阻断 + 变异后违反可观察 双断言。
 * 1 swallowOkFalse / 2 bypassDurableChannel(替换 durable API) / 3 allowBypassPreload(绕过 preload) /
 * 4 forgeMembershipFallback / 5 ignoreContextBinding / 6 legacyWriterFallback(旧 writer 回退) /
 * 7 concurrentSeq(seq 并发冲突) / 8 skipReplayValidation(重启读旧/坏日志) / 9 bypassApprovalTimeout(timeout 后 approve) /
 * 10 writeAfterCancelAllowed(取消后写入) / 11a ipcWhitelistRemoved(未知 route：constructor 直通) /
 * 11b allowUnknownTool(未知 tool) / 12 skipPersist(重启丢日志) / 13 skipTimeoutScheduling(调度空转)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPiBridgeMain } = require('../../../app/js/pi/bridge/pi-bridge-main-v1.js');
const { createPiPreloadApi } = require('../../../app/js/pi/bridge/pi-bridge-preload-v1.js');
const { createEventStore } = require('../../../app/js/pi/bridge/pi-bridge-event-store-v1.js');
const { createDurableAdapter } = require('../../../app/js/pi/bridge/pi-bridge-durable-adapter-v1.js');

const PROJ = {
  clientId: 'c_100', sessionId: 's_200', storeProjectionVersion: 7, membershipProjectionVersion: 3,
  sourceRefs: [{ sourceId: 'src_1', sourceVersion: 2, sourceContentHash: 'sha256:' + 'b'.repeat(64), anchorContentHash: 'sha256:' + 'c'.repeat(64) }],
};
const TGT = { kind: 'session', clientId: 'c_100', sessionId: 's_200' };
const isFail = (r) => r && r.ok === false;
const TMP = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-003-mut-'));
let fileN = 0;

function mkBridge(over, mut) {
  const store = new Map();
  let n = 0;
  let saveCalls = 0;
  const durable = createDurableAdapter({
    saveRecord: (over && over.saveRecord) || ((rec) => { saveCalls++; const id = 'obj_' + String(++n); store.set(id, { snapshotHash: rec.snapshotHash, version: 1 }); return Promise.resolve({ ok: true, savedObjectId: id, version: 1 }); }),
    readRecord: (id) => store.has(id) ? { ok: true, object: store.get(id) } : { ok: false, code: 'XJ_PI_VERIFY_FAILED' },
    mutations: (over && over.adapterMutations) || {},
  });
  const bridge = createPiBridgeMain(Object.assign({
    serverMembershipProjection: (over && over.serverMembershipProjection) || (() => ({ tier: 'pro' })),
    readProjector: (tool, args) => ({ ok: true, data: { tool, args } }),
    liveProjection: () => PROJ,
    durableWrite: durable.durableWrite,
    durableRead: durable.durableRead,
    eventFile: path.join(TMP, 'ev-' + String(++fileN) + '.jsonl'),
    timeoutScanIntervalMs: 80,
    mutations: mut || {},
  }, over));
  return { bridge, getSaves: () => saveCalls };
}
async function approvedCommit(bridge, taskId, over) {
  bridge.api.startTask({ taskId, mode: 'commit', projection: PROJ });
  const c1 = await bridge.api.commitStep(taskId, TGT, {});
  if (isFail(c1) && c1.awaiting) {
    bridge.api.resolveApproval(c1.pendingApprovalId, 'approved', 'local-user');
    return bridge.api.commitStep(taskId, TGT, {});
  }
  return c1;
}

let killed = 0, survived = 0;
function verdict(name, ok, detail) {
  console.log((ok ? 'KILLED ' : 'SURVIVED ') + name + (detail ? ' :: ' + detail : ''));
  if (ok) killed++; else survived++;
}

const probes = [
  ['M1-swallow-ok-false', { swallowOkFalse: true }, async (mut) => {
    const { bridge } = mkBridge({ saveRecord: () => Promise.resolve({ ok: false, code: 'XJ_PI_SNAPSHOT_MISMATCH' }), adapterMutations: mut }, mut);
    const r = await approvedCommit(bridge, 'xj_task_g1');
    bridge.stop();
    return r.ok === true; // durable 失败被吞成成功（adapter 伪回执 + supervisor 跳 verify 同开关）
  }],
  ['M2-replace-durable-api', { bypassDurableChannel: true }, async (mut) => {
    const { bridge, getSaves } = mkBridge(null, null);
    // adapter 开关经 adapterMutations
    const store2 = new Map(); let n2 = 0;
    const durable2 = createDurableAdapter({
      saveRecord: (rec) => { const id = 'o' + (++n2); store2.set(id, { snapshotHash: rec.snapshotHash, version: 1 }); return Promise.resolve({ ok: true, savedObjectId: id, version: 1 }); },
      readRecord: (id) => store2.has(id) ? { ok: true, object: store2.get(id) } : { ok: false, code: 'XJ_PI_VERIFY_FAILED' },
      mutations: mut,
    });
    const bridge2 = createPiBridgeMain({
      serverMembershipProjection: () => ({ tier: 'pro' }),
      readProjector: (t, a) => ({ ok: true, data: { t, a } }),
      liveProjection: () => PROJ,
      durableWrite: durable2.durableWrite, durableRead: durable2.durableRead,
      eventFile: path.join(TMP, 'ev-b2.jsonl'), timeoutScanIntervalMs: 1000,
    });
    const r = await approvedCommit(bridge2, 'xj_task_g2');
    const saves = n2;
    bridge2.stop(); bridge.stop();
    return r.ok === true && saves === 0; // 成功但 durable API 零调用 = 平行写入口
  }],
  ['M3-bypass-preload', { allowBypassPreload: true }, async (mut) => {
    const fake = { invoke: () => Promise.resolve({ ok: true }) };
    const api = createPiPreloadApi(fake, { mutations: mut });
    return api.__raw !== undefined; // 原始 invoke 通道暴露
  }],
  ['M4-forged-membership', { forgeMembershipFallback: true }, async (mut) => {
    const { bridge } = mkBridge({ serverMembershipProjection: () => null }, mut);
    bridge.api.startTask({ taskId: 'xj_task_g4', mode: 'observe', projection: PROJ });
    const r = bridge.api.runToolStep('xj_task_g4', { tool: 'read.task.cards', args: {} });
    bridge.stop();
    return r.ok === true;
  }],
  ['M5-cross-clinical-context', { ignoreContextBinding: true }, async (mut) => {
    const { bridge } = mkBridge(null, mut);
    bridge.api.startTask({ taskId: 'xj_task_g5', mode: 'observe', projection: PROJ });
    const r = bridge.api.runToolStep('xj_task_g5', { tool: 'read.client.summary', args: { clientId: 'c_INTRUDER' } });
    bridge.stop();
    return r.ok === true;
  }],
  ['M6-legacy-writer-fallback', { legacyWriterFallback: true }, async (mut) => {
    const { bridge } = mkBridge(null, mut);
    bridge.api.startTask({ taskId: 'xj_task_g6', mode: 'observe', projection: PROJ });
    const r = bridge.api.runToolStep('xj_task_g6', { legacyTool: 'client.update', args: {} });
    bridge.stop();
    return r.ok === true;
  }],
  ['M7-seq-concurrent-conflict', { concurrentSeq: true }, async (mut) => {
    const es = createEventStore({ file: path.join(TMP, 'ev-m7.jsonl'), mutations: mut });
    await Promise.all([
      es.append('xj_task_g7', 'task.created', {}),
      es.append('xj_task_g7', 'plan.updated', {}),
      es.append('xj_task_g7', 'tool.call.requested', {}),
      es.append('xj_task_g7', 'tool.call.result', {}),
    ]);
    const seqs = es.of('xj_task_g7').map((e) => e.seq);
    return seqs.length !== new Set(seqs).size; // 出现重复 seq
  }],
  ['M8-restart-read-old-log', { skipReplayValidation: true }, async (mut) => {
    const seq8 = String(++fileN);
    const file = path.join(TMP, 'ev-m12-' + seq8 + '.jsonl'); // TMP 内唯一文件（同 M12 命名族）
    fs.writeFileSync(file, '{corrupt-bad-line\n', 'utf8');
    const es = createEventStore({ file, mutations: mut });
    const r = es.replayAll();
    return r.ok === true; // 坏行存在时仍 ok（静默跳过）= 重启不 fail-closed
  }],
  ['M9-timeout-then-approve', { bypassApprovalTimeout: true }, async (mut) => {
    let now = 1_000_000;
    const { bridge } = mkBridge({ clock: () => now }, mut);
    bridge.api.startTask({ taskId: 'xj_task_g9', mode: 'commit', projection: PROJ });
    const c1 = await bridge.api.commitStep('xj_task_g9', TGT, {});
    now += 5 * 60 * 1000 + 1;
    const r = bridge.api.resolveApproval(c1.pendingApprovalId, 'approved', 'local-user');
    bridge.stop();
    return r.ok === true; // 过期批准被接受
  }],
  ['M10-write-after-cancel', { writeAfterCancelAllowed: true }, async (mut) => {
    const { bridge } = mkBridge(null, mut);
    bridge.api.startTask({ taskId: 'xj_task_g10', mode: 'commit', projection: PROJ });
    bridge.api.cancel('xj_task_g10');
    const r = bridge.api.runToolStep('xj_task_g10', { tool: 'read.task.cards', args: {} });
    bridge.stop();
    return r.ok === true;
  }],
  ['M11a-ipc-whitelist-removed', { allowUnknownRoute: true }, async (mut) => {
    const { bridge } = mkBridge(null, mut);
    const handlers = {};
    bridge.registerIpc({ handle: (ch, fn) => { handlers[ch] = fn; } }, 'xj-pi-mut');
    const r = await handlers['xj-pi-mut:invoke']({ sender: { id: 1 } }, { method: 'constructor', args: [] });
    bridge.stop();
    return !(isFail(r)); // 非白名单"方法"被直通执行
  }],
  ['M11b-unknown-tool', { allowUnknownTool: true }, async (mut) => {
    const { bridge } = mkBridge(null, mut);
    bridge.api.startTask({ taskId: 'xj_task_g11', mode: 'observe', projection: PROJ });
    const r = bridge.api.runToolStep('xj_task_g11', { tool: 'shell.exec', args: {} });
    bridge.stop();
    return r.ok === true;
  }],
  ['M12-skip-persist-restart-loss', { skipPersist: true }, async (mut) => {
    const file = path.join(TMP, 'ev-m12-' + String(++fileN) + '.jsonl');
    const es = createEventStore({ file, mutations: mut });
    await es.append('xj_task_g12', 'task.created', {});
    const es2 = createEventStore({ file }); // 重启（无变异）
    const r = es2.replayAll();
    return r.ok === true && r.count === 0; // 日志丢失（重启后 0 事件）
  }],
  ['M13-skip-timeout-scheduling', { skipTimeoutScheduling: true }, async (mut) => {
    let now = 1_000_000;
    const { bridge } = mkBridge({ clock: () => now, timeoutScanIntervalMs: 60 }, mut);
    bridge.api.startTask({ taskId: 'xj_task_g13', mode: 'commit', projection: PROJ });
    const c1 = await bridge.api.commitStep('xj_task_g13', TGT, {});
    now += 5 * 60 * 1000 + 1;
    await new Promise((res) => setTimeout(res, 200)); // 等调度周期
    const st = bridge.api.diagnose('xj_task_g13').task.status;
    bridge.stop();
    return st === 'awaiting_confirmation'; // 无人把超时任务转 paused（调度空转）
  }],
];

(async () => {
  for (const [name, mut, probe] of probes) {
    let base = false, mutated = false;
    try { base = await probe({}); } catch (e) { base = 'ERR:' + e.message; }
    try { mutated = await probe(mut); } catch (e) { mutated = 'ERR:' + e.message; }
    verdict(name, base === false && mutated === true, 'baseline=' + base + ' mutated=' + mutated);
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log('SUMMARY bridge-mutation killed=' + killed + ' survived=' + survived);
  process.exit(survived === 0 ? 0 : 1);
})();
