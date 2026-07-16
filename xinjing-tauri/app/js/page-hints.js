/* ============================================================
 * 心镜 XinJing — 页面动态提示（v3.4.0）
 *
 * 根据当前页面和 Store 数据生成上下文相关的提示，
 * 供小镜面板展示。
 * ============================================================ */
'use strict';

const PageHints = (() => {

  function getHints(pagePath) {
    var hints = [];
    try {
      if (typeof Store === 'undefined') return hints;
      var sessions = Store.getSessions();
      var clients = Store.getClients();
      var today = new Date().toISOString().slice(0, 10);

      // 全局提示
      var pendingReports = sessions.filter(function (s) { return s.hasTranscript && !s.hasSoap && !s.hasDap; }).length;
      if (pendingReports > 0) hints.push('📋 ' + pendingReports + ' 份逐字稿待整理为报告');

      var owing = clients.filter(function (c) {
        return Store.getSessionsByClient(c.id).some(function (s) { return s.billing && s.billing.fee > 0 && !s.billing.paid; });
      });
      if (owing.length > 0) hints.push('💰 ' + owing.length + ' 位来访者有欠费');

      // 页面特定提示
      var fn = (pagePath || '').split('/').pop() || '';

      if (fn === 'consult-notes.html' || fn === 'transcript.html') {
        var todayS = sessions.filter(function (s) { return s.date === today; });
        if (todayS.length === 0) hints.push('今天还没有记录咨询，要开始吗？');
      }

      if (fn === 'billing-shell.html') {
        var ym = today.slice(0, 7);
        var monthInc = sessions.filter(function (s) { return s.date && s.date.slice(0, 7) === ym && s.billing && s.billing.fee > 0; }).reduce(function (s, x) { return s + (x.billing.fee || 0); }, 0);
        hints.push('本月收入 ¥' + monthInc.toLocaleString());
      }

      if (fn === 'supervision.html') {
        var sups = Store.getSupervisions ? Store.getSupervisions() : [];
        hints.push('已有 ' + sups.length + ' 条督导记录');
      }

      if (fn === 'doc-center.html') {
        hints.push('共 ' + clients.length + ' 位来访者 · ' + sessions.length + ' 次会谈');
      }
    } catch (e) { /* ignore */ }
    return hints.slice(0, 5);
  }

  if (typeof window !== 'undefined') {
    window.PageHints = { getHints: getHints };
  }
  return { getHints: getHints };
})();