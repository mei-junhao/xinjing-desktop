'use strict';
/**
 * pi-bridge-projection-adapter-v1.js — D1 投影适配器（XJ-5.1.0-...-003）
 * 从注入的只读访问器构造 ClinicalContext 限定投影与 liveProjection；
 * 投影版本变化由调用方（Codex 接线 Store/会员权威投影）驱动；本适配器不读真实数据、不开写口。
 */
const P = require('../pi-protocol-v1.js');

/**
 * createProjectionAdapter({ readSourceRefs, readStoreVersion, readMembershipVersion })
 *   readSourceRefs: (clientId, sessionId) => [{sourceId, sourceVersion, sourceContentHash, anchorContentHash}]
 *   readStoreVersion: () => int；readMembershipVersion: () => int
 */
function createProjectionAdapter(options) {
  const opts = options || {};
  if (typeof opts.readSourceRefs !== 'function') throw new Error('readSourceRefs accessor required');
  if (typeof opts.readStoreVersion !== 'function') throw new Error('readStoreVersion accessor required');
  if (typeof opts.readMembershipVersion !== 'function') throw new Error('readMembershipVersion accessor required');

  /** 生成 D1 投影（失败 fail-closed 返回 null） */
  function project(clientId, sessionId) {
    if (typeof clientId !== 'string' || !clientId || typeof sessionId !== 'string' || !sessionId) return null;
    let sourceRefs = null;
    let storeVersion = null;
    let membershipVersion = null;
    try {
      sourceRefs = opts.readSourceRefs(clientId, sessionId) || [];
      storeVersion = opts.readStoreVersion();
      membershipVersion = opts.readMembershipVersion();
    } catch (e) { return null; }
    if (!Number.isSafeInteger(storeVersion) || !Number.isSafeInteger(membershipVersion)) return null;
    if (!Array.isArray(sourceRefs)) return null;
    const proj = {
      clientId, sessionId,
      sourceRefs: sourceRefs.map((r) => ({
        sourceId: String(r.sourceId), sourceVersion: r.sourceVersion,
        sourceContentHash: r.sourceContentHash, anchorContentHash: r.anchorContentHash,
      })),
      storeProjectionVersion: storeVersion,
      membershipProjectionVersion: membershipVersion,
    };
    if (P.computeSnapshotHash(proj) === null) return null; // 结构校验复用协议层
    return proj;
  }

  /** liveProjection 工厂（供 supervisor contextCheck 在线比对；漂移由 supervisor 判 SNAPSHOT_MISMATCH） */
  function liveProjectionOf(clientId, sessionId) {
    return () => project(clientId, sessionId);
  }

  return Object.freeze({ project, liveProjectionOf });
}

module.exports = { createProjectionAdapter };
