/* 心镜临床上下文视图：只渲染已构造的来源摘要。 */
(function () {
  'use strict';
  function ensureStyles() {
    if (document.getElementById('xj-context-summary-style')) return;
    var style = document.createElement('style');
    style.id = 'xj-context-summary-style';
    style.textContent = '.xj-context-summary{margin:0 0 12px;border:1px solid var(--border);border-radius:6px;background:var(--paper-2);color:var(--ink-2);font:13px/1.55 var(--sans)}.xj-context-summary summary{padding:9px 12px;cursor:pointer;color:var(--ink);font-weight:600}.xj-context-summary-body{padding:0 12px 10px}.xj-context-summary-item{padding:3px 0;overflow-wrap:anywhere}.xj-context-summary-meta{color:var(--ink-3);font-size:12px}.xj-context-summary-more{margin-top:6px;color:var(--ink-3);font-size:12px}';
    document.head.appendChild(style);
  }
  function sourceText(context, index) {
    var source = (context.sources || [])[index] || {};
    var display = (context.displaySources || [])[index] || source.label || '上下文来源';
    return display + (source.truncated ? '（已截断）' : '') + (source.chars ? ' · ' + source.chars + ' 字' : '');
  }
  function renderSummary(container, context) {
    if (!container || !context || !context.ok) return null;
    ensureStyles();
    var old = container.querySelector('.xj-context-summary');
    if (old) old.remove();
    var details = document.createElement('details');
    details.className = 'xj-context-summary';
    details.open = true;
    details.innerHTML = '<summary>本次上下文 · ' + (context.sources || []).length + ' 项 · 约 ' + (context.estimatedChars || 0) + ' 字</summary><div class="xj-context-summary-body"></div>';
    var body = details.querySelector('.xj-context-summary-body');
    (context.sources || []).slice(0, 3).forEach(function (_, index) {
      var item = document.createElement('div');
      item.className = 'xj-context-summary-item';
      item.textContent = sourceText(context, index);
      body.appendChild(item);
    });
    if ((context.sources || []).length > 3) {
      var more = document.createElement('div');
      more.className = 'xj-context-summary-more';
      more.textContent = '另有 ' + ((context.sources || []).length - 3) + ' 项来源已纳入本次上下文。';
      body.appendChild(more);
    }
    if (!body.childNodes.length) body.textContent = '未注入临床材料。';
    container.insertBefore(details, container.firstChild);
    return details;
  }
  function confirmSend(context) {
    if (!context || !context.ok) return false;
    var lines = (context.sources || []).map(function (_, index) { return sourceText(context, index); });
    var message = '将发送以下上下文（约 ' + (context.estimatedChars || 0) + ' 字）：\n' + (lines.join('\n') || '仅本轮指令');
    return typeof window.confirm !== 'function' || window.confirm(message);
  }
  window.ClinicalContextView = { renderSummary: renderSummary, confirmSend: confirmSend };
})();
