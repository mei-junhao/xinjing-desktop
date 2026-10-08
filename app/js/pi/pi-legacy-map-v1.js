'use strict';
/**
 * pi-legacy-map-v1.js — AgentCore 兼容映射（裁决 D4）
 * 仅 client.query / session.query 映射为只读新工具；navigate_to 留待 command.navigate.v2；
 * 其余一律 XJ_PI_LEGACY_TOOL_UNMAPPED，绝不回退旧 AgentCore writer。
 */
const P = require('./pi-protocol-v1.js');

/** mapLegacyTool(oldTool) -> {ok:true, tool, argTransform} | {ok:false, code:'XJ_PI_LEGACY_TOOL_UNMAPPED'} */
function mapLegacyTool(oldTool, mutations) {
  if (mutations && mutations.legacyWriterFallback && !P.LEGACY_TOOL_MAP[oldTool]) {
    return { ok: true, tool: oldTool, via: 'legacy-writer', warning: 'MUTATION' }; // 变异开关：未映射旧工具回退旧 writer
  }
  const entry = P.LEGACY_TOOL_MAP[oldTool];
  if (!entry) return P.fail('XJ_PI_LEGACY_TOOL_UNMAPPED', 'no safe mapping for legacy tool: ' + String(oldTool).slice(0, 64));
  return { ok: true, tool: entry.tool };
}

const KNOWN_UNMAPPED_EXAMPLES = Object.freeze([
  'billing.query', 'client.update', 'supervision.run', 'masters.chat', 'agent.configure_api', 'stats.report', 'client.insight', 'userdocs.search',
]);

module.exports = { mapLegacyTool, KNOWN_UNMAPPED_EXAMPLES };
