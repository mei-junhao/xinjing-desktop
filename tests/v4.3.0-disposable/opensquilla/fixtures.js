'use strict';
/**
 * XJ-4.3.0-opensquilla-case-atlas-disposable-v1 — Synthetic fixtures
 * 30 sessions across one synthetic client, multiple materials,
 * supervision records and clinical action drafts.
 * All data is synthetic. No real clinical data.
 * Not referenced by production code.
 */
module.exports = (function () {
  var CLIENT_ID = 'c_syn_001';
  var now = new Date('2026-07-23T10:00:00+08:00');

  function iso(offsetDays) {
    var d = new Date(now.getTime() + offsetDays * 86400000);
    return d.toISOString();
  }
  function dateStr(offsetDays) {
    var d = new Date(now.getTime() + offsetDays * 86400000);
    return d.toISOString().slice(0, 10);
  }

  var client = {
    id: CLIENT_ID,
    name: '林女士',
    alias: '林女士',
    status: 'active',
    billing: { feePerSession: 400, billingMode: 'per-session' },
    notes: '长程个案；主要议题：关系边界、内疚与自我价值',
    createdAt: iso(-210),
    updatedAt: iso(-1)
  };

  var materials = [];
  var sessions = [];
  var supervisions = [];
  var actionRuns = [];

  var topics = [
    '初次访谈与历史收集',
    '关系模式探索',
    '原生家庭图景',
    '边界模糊的具体情境',
    '内疚感的来源',
    '自我价值与成就焦虑',
    '移情与反移情觉察',
    '阻抗与防御机制',
    '梦的工作——反复出现的走廊',
    '分离议题与独立愿望',
    '督导反馈与方向调整',
    '边界实验的第一次尝试',
    '实验后的反应与回溯',
    '对咨询关系的讨论',
    '沉默的功能与意义',
    '身体化症状与情绪联结',
    '叙事重构——新的主线',
    '对改变速度的焦虑',
    '对结束的预感与恐惧',
    '节假日中断的影响',
    '恢复后的重新联结',
    '关键决定的酝酿',
    '决定后的复杂情感',
    '对关系历史的整合性回顾',
    '对自我价值的新叙述',
    '边界工作的巩固',
    '分离准备的开始',
    '对咨询效果的自评',
    '未来方向的展望',
    '总结与告别准备'
  ];

  for (var i = 0; i < 30; i++) {
    var sn = i + 1;
    var dayOffset = -210 + i * 7;
    var sid = 's_syn_' + String(sn).padStart(2, '0');
    var transcriptExcerpt = '第' + sn + '节会谈片段：' + topics[i] + '。来访者表达了对此议题的深入思考。';
    var soapSub = '来访者主诉：' + topics[i] + '相关的感受与体验。';
    var soapObj = '咨询师观察：情绪波动适中，会谈投入度高。';
    var soapAss = '评估：持续探索中，议题逐步深化。';
    var soapPlan = '计划：继续当前方向，关注边界与自我价值的联结。';

    var session = {
      id: sid,
      clientId: CLIENT_ID,
      sessionNumber: sn,
      date: dateStr(dayOffset),
      startTime: '09:00',
      endTime: '09:50',
      durationMinutes: 50,
      type: sn === 1 ? 'intake' : 'followup',
      status: 'completed',
      isConfirmed: true,
      billing: { fee: 400, paid: true, paidAmount: 400, source: 'synthetic' },
      transcript: transcriptExcerpt,
      notes: '本节主要工作：' + topics[i],
      soap: { subjective: soapSub, objective: soapObj, assessment: soapAss, plan: soapPlan },
      riskLevel: sn >= 15 && sn <= 18 ? 'moderate' : 'low',
      createdAt: iso(dayOffset),
      updatedAt: iso(dayOffset)
    };
    sessions.push(session);

    // Materials: 1-2 per session
    if (sn % 3 === 1 || sn % 5 === 0) {
      var mid = 'mat_syn_' + String(sn).padStart(2, '0');
      materials.push({
        id: mid,
        clientId: CLIENT_ID,
        sessionId: sid,
        title: '第' + sn + '节材料：' + topics[i] + '摘要',
        source: { name: 'synthetic-' + sn + '.txt', path: 'synthetic', size: 1024 },
        parseStatus: 'ready',
        linkStatus: 'linked',
        extractedText: '合成材料内容：' + topics[i] + '。这是一段较长的合成文本，用于验证材料画布的展示和来源链追溯。',
        artifacts: {},
        createdAt: iso(dayOffset),
        updatedAt: iso(dayOffset)
      });
    }

    // Supervisions: every 4th session
    if (sn % 4 === 0) {
      var svid = 'sv_syn_' + String(sn).padStart(2, '0');
      supervisions.push({
        id: svid,
        clientId: CLIENT_ID,
        sessionId: sid,
        supervisorName: '陈督导师',
        reportTitle: '第' + Math.floor(sn / 4) + '次督导',
        content: '督导反馈：' + topics[i] + '的讨论方向正确，建议关注来访者的防御模式与自我价值议题的深层联结。',
        conclusion: '继续当前工作方向',
        date: dateStr(dayOffset + 1),
        createdAt: iso(dayOffset + 1),
        updatedAt: iso(dayOffset + 1)
      });
    }

    // Clinical action runs: every 5th session
    if (sn % 5 === 0) {
      var arid = 'ar_syn_' + String(sn).padStart(2, '0');
      actionRuns.push({
        id: arid,
        task: 'supervision-ai',
        status: 'succeeded',
        origin: { clientId: CLIENT_ID, sessionId: sid, materialId: '', supervisionId: '' },
        sources: [{ kind: 'session', id: sid, label: '已选会谈' }],
        snapshot: {
          clientId: CLIENT_ID,
          sessionId: sid,
          materialId: '',
          supervisionId: '',
          selectedSessionIds: [sid],
          sessionVersions: {},
          materialUpdatedAt: '',
          supervisionUpdatedAt: '',
          inputDigest: 'sha256:synthetic',
          key: CLIENT_ID + '|' + sid + '|||' + sid + '|sha256:synthetic'
        },
        output: { summary: 'AI 摘要：' + topics[i] },
        completedAt: iso(dayOffset + 2),
        createdAt: iso(dayOffset),
        updatedAt: iso(dayOffset + 2)
      });
    }
  }

  // AI edge for preview-only (must be rejected by persistence adapter)
  var aiEdge = {
    id: 'edge_ai_preview_001',
    type: 'ai-inference',
    sourceNode: 'mat_syn_05',
    targetNode: 's_syn_05',
    sourceRef: null,
    label: 'AI 推断：自我价值焦虑与早期边界经验关联',
    previewOnly: true,
    confidence: 0.72
  };

  return {
    client: client,
    sessions: sessions,
    materials: materials,
    supervisions: supervisions,
    actionRuns: actionRuns,
    aiEdge: aiEdge,
    normalizationVersion: '4.3.0-disposable-v1',
    sourceVersion: 'synthetic-001'
  };
})();
