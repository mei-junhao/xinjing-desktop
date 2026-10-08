/* SYNTHETIC FIXTURES — 全部为合成数据，不含任何真实来访者/咨询师/支付/路径信息。
 * 仅用于 SourceRef 模块的本地单测与校准，不得用于生产或真实个案。
 * 标记：synthetic=true。
 */
'use strict';

var SYNTHETIC = true;

// 合成来访者（匿名化名体系）
var CLIENTS = {
  c_anon_alpha: { id: 'c_anon_alpha', name: '化名-甲', notes: '合成示例，无真实含义' },
  c_anon_beta: { id: 'c_anon_beta', name: '化名-乙' }
};

// 合成会谈（相对定位键，无绝对路径）
var SESSIONS = {
  s_anon_001: { id: 's_anon_001', clientId: 'c_anon_alpha', sessionNumber: 1, date: '2026-01-05' },
  s_anon_002: { id: 's_anon_002', clientId: 'c_anon_beta', sessionNumber: 1, date: '2026-02-11' }
};

// 合成来源内容（中文长文本）
var SOURCE_TEXTS = {
  transcript_v1: '来访者（化名-甲）在本次会谈中表达了工作相关的焦虑。其陈述：我最近在项目汇报前总会失眠，担心被同事否定。咨询师采用共情性回应，确认了来访者的情绪体验。',
  transcript_v2_changed: '来访者（化名-甲）在后续会谈中补充了家庭层面的压力源。其陈述：除了工作，我和母亲的沟通也让我很疲惫。咨询师扩展了评估维度，纳入家庭系统因素。',
  short: '短文本示例。'
};

// 合成锚点（仅受控 locator，无绝对路径）
function anchor(locator, fragment, position) {
  return { kind: 'session', locator: locator, fragment: fragment || '', position: position || undefined };
}

module.exports = {
  SYNTHETIC: SYNTHETIC,
  CLIENTS: CLIENTS,
  SESSIONS: SESSIONS,
  SOURCE_TEXTS: SOURCE_TEXTS,
  anchor: anchor,
  // 便捷构造器：返回给 create() 的输入
  caseUnchanged: function () {
    return {
      clientId: 'c_anon_alpha', sessionId: 's_anon_001',
      anchor: anchor('session:s_anon_001', '工作相关的焦虑'),
      sourceText: SOURCE_TEXTS.transcript_v1,
      anchorText: '工作相关的焦虑'
    };
  },
  caseChangedWithAnchorKept: function () {
    // 来源内容变了，但锚点片段文本（与基线 ref 相同）仍然提供，故锚点哈希仍匹配
    return {
      clientId: 'c_anon_alpha', sessionId: 's_anon_001',
      anchor: anchor('session:s_anon_001', '工作相关的焦虑'),
      sourceText: SOURCE_TEXTS.transcript_v2_changed,
      anchorText: '工作相关的焦虑'
    };
  },
  caseSourceChangedAnchorGone: function () {
    return {
      clientId: 'c_anon_alpha', sessionId: 's_anon_001',
      anchor: anchor('session:s_anon_001', '项目汇报前总会失眠'),
      sourceText: SOURCE_TEXTS.transcript_v2_changed,
      anchorText: '项目汇报前总会失眠'
    };
  }
};
