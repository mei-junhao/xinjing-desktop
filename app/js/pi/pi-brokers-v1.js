'use strict';
/**
 * pi-brokers-v1.js — Read / Clinical / Supervision / Command 四 Broker 结构化边界 + 会员闸门
 * （Approval Broker 独立实现于 pi-approval-v1.js）
 * 会员只信 serverMembershipProjection 注入（服务器权威投影）；未知/抛错 → fail-closed。
 */
const P = require('./pi-protocol-v1.js');

/**
 * createBrokers({ serverMembershipProjection, readProjector, commandHash, approvalBroker, eventLog })
 *   serverMembershipProjection: () => {tier}|null
 *   readProjector: (tool, args, clinicalContext) => {ok:true, data}|{ok:false,...}（只读投影，注入）
 *   commandHash: (value) => string（哈希函数注入，默认 sha256）
 */
function createBrokers(options) {
  const opts = options || {};
  const getMembership = typeof opts.serverMembershipProjection === 'function' ? opts.serverMembershipProjection : () => null;
  const readProjector = typeof opts.readProjector === 'function' ? opts.readProjector : () => P.fail('XJ_PI_UNKNOWN_TOOL', 'read projector not wired');
  const commandHash = typeof opts.commandHash === 'function' ? opts.commandHash
    : (v) => 'sha256:' + require('crypto').createHash('sha256').update(String(v)).digest('hex');
  const approvalBroker = opts.approvalBroker || null;
  const eventLog = opts.eventLog || null;
  const mutations = opts.mutations || {}; // 仅测试：命名变异开关

  function membershipTier() {
    let proj = null;
    try { proj = getMembership(); } catch (e) { proj = null; }
    if (mutations.forgeMembershipFallback && (!proj || !P.PERMISSION_MATRIX['read.client.summary'][proj.tier])) {
      proj = { tier: 'flagship' }; // 变异开关：本地伪造会员
    }
    if (!proj || !P.PERMISSION_MATRIX['read.client.summary'][proj.tier]) return P.fail('XJ_PI_MEMBERSHIP_UNKNOWN');
    return { ok: true, tier: proj.tier };
  }

  function gateMembership(tool) {
    const mem = membershipTier();
    if (P.isFail(mem)) return mem;
    const rule = P.PERMISSION_MATRIX[tool];
    if (!rule) return P.fail('XJ_PI_UNKNOWN_TOOL');
    if (!mutations.forgeMembershipFallback && !rule[mem.tier]) return P.fail('XJ_PI_MEMBERSHIP_UNKNOWN', 'tier denied');
    return mem;
  }

  /** Read Broker：只读；context 逐字段绑定；无 snapshotHash 的临床读取拒绝 */
  function read(task, call) {
    const spec = P.TOOL_REGISTRY[call.tool];
    if (!spec || spec.broker !== 'Read') return P.fail('XJ_PI_UNKNOWN_TOOL');
    const mem = gateMembership(call.tool);
    if (P.isFail(mem)) return mem;
    const args = call.args || {};
    if (!P.hasOnlyKeys(args, spec.argKeys)) return P.fail('XJ_PI_UNKNOWN_FIELD', 'tool args');
    if (!mutations.ignoreContextBinding) {
      if (args.clientId !== undefined && args.clientId !== task.clinicalContext.clientId) return P.fail('XJ_PI_CLIENT_SESSION_MISMATCH');
      if (args.sessionId !== undefined && args.sessionId !== task.clinicalContext.sessionId) return P.fail('XJ_PI_CLIENT_SESSION_MISMATCH');
    }
    if (!P.isSha256(task.clinicalContext.snapshotHash)) return P.fail('XJ_PI_SNAPSHOT_MISMATCH');
    return readProjector(call.tool, args, task.clinicalContext);
  }

  /** Supervision Broker：督导草稿追加（只产草稿，不写正式临床记录） */
  function supervision(task, call) {
    const spec = P.TOOL_REGISTRY[call.tool];
    if (!spec || spec.broker !== 'Supervision') return P.fail('XJ_PI_UNKNOWN_TOOL');
    const mem = gateMembership(call.tool);
    if (P.isFail(mem)) return mem;
    const args = call.args || {};
    if (!P.hasOnlyKeys(args, spec.argKeys) || typeof args.noteText !== 'string' || !args.noteText) return P.fail('XJ_PI_UNKNOWN_FIELD');
    if (!P.isSha256(task.clinicalContext.snapshotHash)) return P.fail('XJ_PI_SNAPSHOT_MISMATCH');
    return { ok: true, broker: 'Supervision', draft: { taskId: task.taskId, noteText: args.noteText, snapshotHash: task.clinicalContext.snapshotHash } };
  }

  /** Command Broker：command.hash / command.navigate（D2：v1 无参） */
  function command(task, call) {
    const spec = P.TOOL_REGISTRY[call.tool];
    if (!spec || spec.broker !== 'Command') return P.fail('XJ_PI_UNKNOWN_TOOL');
    const mem = gateMembership(call.tool);
    if (P.isFail(mem)) return mem;
    const args = call.args || {};
    if (!P.hasOnlyKeys(args, spec.argKeys)) return P.fail('XJ_PI_UNKNOWN_FIELD');
    if (call.tool === 'command.navigate' && Object.keys(args).length) return P.fail('XJ_PI_UNKNOWN_FIELD', 'navigate is argless in v1');
    if (call.tool === 'command.hash') return { ok: true, hash: commandHash(args.value) };
    return { ok: true, broker: 'Command', tool: call.tool };
  }

  /** 工具分派总入口（供 Supervisor TOOL_LOOP 调用；clinical 类走 clinical-run 流水线，由 Supervisor 编排） */
  function dispatch(task, call) {
    if (!call || typeof call !== 'object' || !P.hasOnlyKeys(call, ['callId', 'tool', 'args'])) return P.fail('XJ_PI_UNKNOWN_FIELD');
    if (!P.TOOL_REGISTRY[call.tool]) {
      if (mutations.legacyWriterFallback) return { ok: true, via: 'legacy-writer', warning: 'MUTATION' }; // 变异开关 M8：未映射旧 writer 回退
      if (mutations.allowUnknownTool) return { ok: true, via: 'mutation-unknown-tool' }; // 变异开关 M9：未知工具放行
      return P.fail('XJ_PI_UNKNOWN_TOOL');
    }
    const spec = P.TOOL_REGISTRY[call.tool];
    if (spec.broker === 'Read') return read(task, call);
    if (spec.broker === 'Supervision') return supervision(task, call);
    if (spec.broker === 'Command') return command(task, call);
    return P.fail('XJ_PI_UNKNOWN_TOOL', 'clinical tools must go through clinical run pipeline');
  }

  return Object.freeze({ membershipTier, gateMembership, read, supervision, command, dispatch });
}

module.exports = { createBrokers };
