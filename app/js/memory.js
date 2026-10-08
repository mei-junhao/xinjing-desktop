/* ============================================================
 * 心镜 XinJing — 记忆系统（v3.3.0）
 *
 * 职责：
 * - 记录用户活动（咨询保存、督导完成、笔记保存、大师对话等）
 * - 在 AI system prompt 中注入近期记忆上下文
 * - 管理用户画像（称呼、执业取向等）
 *
 * 数据存储：复用 Store 的 KV 机制（idbPut/get），不新建 objectStore
 * - key: 'activities' → 活动数组（近 30 天，最多 50 条滚动）
 * - key: 'user_memory_profile' → 用户画像对象
 *
 * 容错：Store 未注入时降级到 localStorage
 * ============================================================ */
'use strict';

const Memory = (() => {
  const MAX_ACTIVITIES = 50;
  const WINDOW_DAYS = 30;

  let _activities = [];
  let _profile = { name: '', orientation: '', createdAt: '' };
  let _hydrated = false;

  // ---------- 持久化 ----------
  async function hydrate() {
    if (_hydrated) return;
    _hydrated = true;
    try {
      if (typeof Store !== 'undefined' && Store._get) {
        _activities = (await Store._get('activities')) || [];
        _profile = (await Store._get('user_memory_profile')) || _profile;
      }
    } catch (e) {
      // 降级 localStorage
      try {
        _activities = JSON.parse(localStorage.getItem('xj_activities') || '[]');
        _profile = JSON.parse(localStorage.getItem('xj_profile') || '{}');
      } catch (e2) { /* 空状态 */ }
    }
  }

  async function persistActivities() {
    try {
      if (typeof Store !== 'undefined' && Store._put) {
        await Store._put('activities', _activities);
      } else {
        localStorage.setItem('xj_activities', JSON.stringify(_activities));
      }
    } catch (e) { /* 静默失败 */ }
  }

  async function persistProfile() {
    try {
      if (typeof Store !== 'undefined' && Store._put) {
        await Store._put('user_memory_profile', _profile);
      } else {
        localStorage.setItem('xj_profile', JSON.stringify(_profile));
      }
    } catch (e) { /* 静默失败 */ }
  }

  // ---------- 公开 API ----------

  // 记录一条活动
  async function record(type, data) {
    await hydrate();
    var entry = {
      type: type,
      summary: (data && data.summary) || '',
      relatedClientId: (data && data.relatedClientId) || '',
      ts: Date.now(),
      date: new Date().toISOString().slice(0, 10)
    };
    _activities.unshift(entry);
    // 滚动窗口：保留最近 WINDOW_DAYS 天、最多 MAX_ACTIVITIES 条
    var cutoff = Date.now() - WINDOW_DAYS * 86400000;
    _activities = _activities.filter(function (a) { return a.ts >= cutoff; });
    if (_activities.length > MAX_ACTIVITIES) _activities = _activities.slice(0, MAX_ACTIVITIES);
    await persistActivities();
  }

  // 查询近期活动
  async function queryRecent(limit) {
    await hydrate();
    limit = limit || 10;
    return _activities.slice(0, limit);
  }

  // 构建 AI 上下文（同步接口，供 PersonaPreamble.build 调用）
  function buildContext(limit) {
    // 同步读取内存缓存（hydrate 是异步的，但 PersonaPreamble 可能在页面加载后才调）
    // 如果 _activities 为空（尚未 hydrate），返回空字符串
    limit = limit || 3;
    if (!_activities.length) return '';
    var items = _activities.slice(0, limit);
    return items.map(function (a) {
      return '- ' + (a.summary || a.type);
    }).join('\n');
  }

  // 用户画像
  function getProfile() {
    return _profile;
  }

  async function setProfile(updates) {
    await hydrate();
    if (!updates) return;
    if (updates.name) _profile.name = updates.name;
    if (updates.orientation) _profile.orientation = updates.orientation;
    if (!_profile.createdAt) _profile.createdAt = new Date().toISOString();
    await persistProfile();
  }

  // 同步初始化（页面加载时立即调用，不阻塞）
  function init() {
    hydrate();
  }

  return {
    record: record,
    queryRecent: queryRecent,
    buildContext: buildContext,
    getProfile: getProfile,
    setProfile: setProfile,
    init: init
  };
})();

if (typeof window !== 'undefined') {
  window.Memory = Memory;
}
