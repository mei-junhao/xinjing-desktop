'use strict';
/**
 * XJ-4.3.0 Grok Document Center Case Atlas — synthetic fixtures only.
 * No real clinical data. No network. No Store/IPC.
 */
(function (root) {
  var CLIENT_ID = 'syn-client-430-c01';
  var SESSION_A = 'syn-session-430-s01';
  var SESSION_B = 'syn-session-430-s02';

  function shaLike(seed) {
    var h = 0x811c9dc5;
    var s = String(seed);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    var hex = (h >>> 0).toString(16).padStart(8, '0');
    return (hex + hex + hex + hex).slice(0, 64);
  }

  function node(partial) {
    var id = partial.id;
    return {
      id: id,
      kind: partial.kind,
      clientId: CLIENT_ID,
      sessionId: partial.sessionId || null,
      occurredAt: partial.occurredAt,
      title: partial.title,
      summary: partial.summary,
      sourceStatus: partial.sourceStatus || 'verified',
      aiDraft: !!partial.aiDraft,
      stableId: partial.stableId || id,
      normalizationVersion: partial.normalizationVersion || 'norm-v1',
      sourceVersion: partial.sourceVersion || '1',
      /* hash removed */
      anchorContentHash: partial.anchorContentHash || shaLike('anc:' + id),
      ownership: partial.ownership || '来访者材料归属',
      relationHint: partial.relationHint || 'belongs-to'
    };
  }

  var materials = [
    node({
      id: 'mat-01',
      kind: 'session',
      sessionId: SESSION_A,
      occurredAt: '2026-07-10T09:00:00+08:00',
      title: '会谈记录 · 第 12 次',
      summary: '合成摘要：讨论睡眠节律与家庭沟通边界，无真实临床内容。',
      sourceStatus: 'verified'
    }),
    node({
      id: 'mat-02',
      kind: 'material',
      sessionId: SESSION_A,
      occurredAt: '2026-07-10T10:15:00+08:00',
      title: '来访者自述摘录',
      summary: '合成摘录：关于工作压力的短段落，仅用于界面演示。',
      sourceStatus: 'verified'
    }),
    node({
      id: 'mat-03',
      kind: 'material',
      sessionId: SESSION_A,
      occurredAt: '2026-07-10T10:40:00+08:00',
      title: '评估量表草稿（AI）',
      summary: 'AI 草稿：量表条目归类建议，尚未人工确认。',
      sourceStatus: 'unverified',
      aiDraft: true
    }),
    node({
      id: 'mat-04',
      kind: 'supervision',
      sessionId: SESSION_A,
      occurredAt: '2026-07-11T14:00:00+08:00',
      title: '督导记录 · 边界讨论',
      summary: '合成督导笔记：关注治疗联盟与作业可行性。',
      sourceStatus: 'verified'
    }),
    node({
      id: 'mat-05',
      kind: 'session',
      sessionId: SESSION_B,
      occurredAt: '2026-07-17T09:00:00+08:00',
      title: '会谈记录 · 第 13 次',
      summary: '合成摘要：回顾上周作业，调整下次目标。',
      sourceStatus: 'verified'
    }),
    node({
      id: 'mat-06',
      kind: 'material',
      sessionId: SESSION_B,
      occurredAt: '2026-07-17T09:45:00+08:00',
      title: '长中文材料标题示例：关于家庭互动模式与睡眠节律调整计划的阶段性整理说明文档',
      summary: '用于验收长中文截断与窄窗布局，内容为合成占位。',
      sourceStatus: 'verified'
    }),
    node({
      id: 'mat-07',
      kind: 'material',
      sessionId: SESSION_B,
      occurredAt: '2026-07-17T11:00:00+08:00',
      title: '过期来源 · 旧版本笔记',
      summary: '该材料源版本已过期，正文不在可用节点中展示。',
      sourceStatus: 'stale',
      sourceVersion: '3',
      normalizationVersion: 'norm-v0'
    }),
    node({
      id: 'mat-08',
      kind: 'material',
      sessionId: SESSION_B,
      occurredAt: '2026-07-18T08:30:00+08:00',
      title: '无效来源 · 校验失败',
      summary: '来源哈希校验失败，仅保留定位信息。',
      sourceStatus: 'invalid'
    }),
    node({
      id: 'mat-09',
      kind: 'material',
      sessionId: SESSION_B,
      occurredAt: '2026-07-18T16:20:00+08:00',
      title: '隔离来源 · 待复核',
      summary: '材料进入 quarantine，禁止作为可用节点进入图谱。',
      sourceStatus: 'quarantined'
    }),
    node({
      id: 'mat-10',
      kind: 'action-run',
      sessionId: SESSION_B,
      occurredAt: '2026-07-18T17:00:00+08:00',
      title: '临床动作草稿 · 总结提纲',
      summary: 'AI 动作运行草稿，不可自动写入正式对象。',
      sourceStatus: 'unverified',
      aiDraft: true
    })
  ];

  var edges = [
    { id: 'e-01', from: 'mat-02', to: 'mat-01', relation: 'belongs-to' },
    { id: 'e-02', from: 'mat-03', to: 'mat-01', relation: 'source-of' },
    { id: 'e-03', from: 'mat-04', to: 'mat-01', relation: 'follow-up-of' },
    { id: 'e-04', from: 'mat-06', to: 'mat-05', relation: 'belongs-to' },
    { id: 'e-05', from: 'mat-10', to: 'mat-05', relation: 'source-of' },
    { id: 'e-06', from: 'mat-05', to: 'mat-01', relation: 'follow-up-of' }
  ];

  var rejected = [
    { kind: 'material', reason: 'stale', stableId: 'mat-07' },
    { kind: 'material', reason: 'invalid', stableId: 'mat-08' },
    { kind: 'material', reason: 'quarantined', stableId: 'mat-09' }
  ];

  var scenarioCatalog = {
    ready: { id: 'ready', label: '正常就绪', description: '已选来访者，材料与图谱可浏览。' },
    loading: { id: 'loading', label: '加载中', description: '保留布局骨架，等待合成投影。' },
    empty: { id: 'empty', label: '空态', description: '已选来访者但尚无材料。' },
    error: { id: 'error', label: '错误', description: '投影加载失败，可安全重试。' },
    'no-client': { id: 'no-client', label: '无来访者', description: '缺少 clientId 深链上下文。' }
  };

  function usableNodes(list) {
    return list.filter(function (n) {
      return n.sourceStatus === 'verified' || n.sourceStatus === 'unverified';
    });
  }

  function buildModel(scenarioId) {
    var scenario = scenarioCatalog[scenarioId] || scenarioCatalog.ready;
    if (scenarioId === 'loading') {
      return {
        version: 'case-space-v1-preview',
        clientId: CLIENT_ID,
        clientLabel: '合成来访者甲',
        scenario: scenario,
        nodes: [],
        edges: [],
        rejected: [],
        counts: { sessions: 0, materials: 0, supervisions: 0, actionRuns: 0, rejected: 0 },
        sourceStatus: 'unverified',
        loading: true,
        error: null
      };
    }
    if (scenarioId === 'empty') {
      return {
        version: 'case-space-v1-preview',
        clientId: CLIENT_ID,
        clientLabel: '合成来访者甲',
        scenario: scenario,
        nodes: [],
        edges: [],
        rejected: [],
        counts: { sessions: 0, materials: 0, supervisions: 0, actionRuns: 0, rejected: 0 },
        sourceStatus: 'unverified',
        loading: false,
        error: null
      };
    }
    if (scenarioId === 'error') {
      return {
        version: 'case-space-v1-preview',
        clientId: CLIENT_ID,
        clientLabel: '合成来访者甲',
        scenario: scenario,
        nodes: [],
        edges: [],
        rejected: [],
        counts: { sessions: 0, materials: 0, supervisions: 0, actionRuns: 0, rejected: 0 },
        sourceStatus: 'unverified',
        loading: false,
        error: { code: 'projection-failed', message: '无法加载个案投影。可重试或返回材料列表。' }
      };
    }
    if (scenarioId === 'no-client') {
      return {
        version: 'case-space-v1-preview',
        clientId: null,
        clientLabel: null,
        scenario: scenario,
        nodes: [],
        edges: [],
        rejected: [],
        counts: { sessions: 0, materials: 0, supervisions: 0, actionRuns: 0, rejected: 0 },
        sourceStatus: 'unverified',
        loading: false,
        error: null
      };
    }

    var sessions = materials.filter(function (n) { return n.kind === 'session'; }).length;
    var mats = materials.filter(function (n) { return n.kind === 'material'; }).length;
    var sups = materials.filter(function (n) { return n.kind === 'supervision'; }).length;
    var runs = materials.filter(function (n) { return n.kind === 'action-run'; }).length;

    return {
      version: 'case-space-v1-preview',
      clientId: CLIENT_ID,
      clientLabel: '合成来访者甲',
      scenario: scenario,
      nodes: materials.slice(),
      edges: edges.slice(),
      rejected: rejected.slice(),
      counts: {
        sessions: sessions,
        materials: mats,
        supervisions: sups,
        actionRuns: runs,
        rejected: rejected.length
      },
      sourceStatus: 'unverified',
      loading: false,
      error: null,
      usable: usableNodes(materials)
    };
  }

  var api = {
    CLIENT_ID: CLIENT_ID,
    SESSION_A: SESSION_A,
    SESSION_B: SESSION_B,
    materials: materials,
    edges: edges,
    rejected: rejected,
    scenarioCatalog: scenarioCatalog,
    buildModel: buildModel,
    usableNodes: usableNodes,
    shaLike: shaLike,
    STATUS_LABELS: {
      verified: '已核验',
      unverified: '未核验',
      stale: '版本过期',
      invalid: '不可用',
      quarantined: '已隔离'
    },
    KIND_LABELS: {
      session: '会谈',
      material: '材料',
      supervision: '督导',
      'action-run': '动作运行'
    },
    RELATION_LABELS: {
      'belongs-to': '归属',
      'source-of': '来源',
      'follow-up-of': '后续'
    }
  };

  root.GrokDocCenterFixtures = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : global);
