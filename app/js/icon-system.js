/* XinJing v3.8 - offline Lucide icon bridge. */
(function () {
  'use strict';

  var iconScriptId = 'xj-lucide-runtime';
  var rendering = false;
  var pending = false;
  var emojiIcons = {
    '🤖': 'sparkles', '📄': 'file-text', '📝': 'clipboard-pen-line', '📅': 'calendar-days',
    '💬': 'message-circle', '🧠': 'brain-circuit', '🔍': 'search', '👥': 'users-round',
    '📋': 'clipboard-list', '💰': 'circle-dollar-sign', '💵': 'circle-dollar-sign', '🎯': 'target',
    '📂': 'folder-open', '📁': 'folder-up', '✨': 'sparkles', '👤': 'user-round', '🔒': 'lock-keyhole',
    '📖': 'book-open', '📚': 'library-big', '📤': 'arrow-up-from-line',
    '👋': 'hand', '⚙': 'settings-2', '🎤': 'mic', '💡': 'lightbulb', '🧭': 'compass', '🌱': 'sprout',
    '📊': 'chart-no-axes-column-increasing', '📈': 'trending-up', '📌': 'pin', '✅': 'circle-check', '❌': 'circle-x',
    '⚡': 'zap', '✦': 'sparkles', '↶': 'rotate-ccw', '×': 'x', '✕': 'x'
  };

  function replaceDecorativeEmoji(root) {
    if (!root || !document.createTreeWalker) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var nodes = [];
    var node;
    while ((node = walker.nextNode())) nodes.push(node);
    nodes.forEach(function (textNode) {
      var parent = textNode.parentElement;
      if (!parent || parent.closest('[data-keep-emoji], .m-avatar, .xj-msg, .rmsg, .msg, .bubble, .chat-msg')) return;
      var match = String(textNode.nodeValue || '').match(/^(\s*)(🤖|📄|📝|📅|💬|🧠|🔍|👥|📋|💰|💵|🎯|📂|📁|✨|👤|🔒|📖|📚|📤|👋|⚙|🎤|💡|🧭|🌱|📊|📈|📌|✅|❌|⚡|✦|↶|×|✕)\uFE0F?\s*/);
      if (!match || !emojiIcons[match[2]]) return;
      var icon = document.createElement('i');
      icon.setAttribute('data-lucide', emojiIcons[match[2]]);
      icon.setAttribute('aria-hidden', 'true');
      textNode.parentNode.insertBefore(icon, textNode);
      textNode.nodeValue = match[1] + String(textNode.nodeValue).slice(match[0].length);
    });
  }

  function ensureRuntime(done) {
    if (window.lucide && window.lucide.createIcons) { done(); return; }
    var existing = document.getElementById(iconScriptId);
    if (existing) {
      existing.addEventListener('load', done, { once: true });
      return;
    }
    var script = document.createElement('script');
    script.id = iconScriptId;
    script.src = 'vendor/lucide.min.js';
    script.async = false;
    script.onload = done;
    document.head.appendChild(script);
  }

  function render(scope) {
    replaceDecorativeEmoji(scope || document);
    ensureRuntime(function () {
      if (!window.lucide || !window.lucide.createIcons) return;
      rendering = true;
      try {
        window.lucide.createIcons({
          root: scope || document,
          attrs: { width: 18, height: 18, 'stroke-width': 1.7, 'aria-hidden': 'true' }
        });
      } finally {
        // 图标替换产生的 DOM 变更会在 microtask 中送达 MutationObserver；
        // 这里延迟到下一帧再解除抑制，保证这轮由渲染自身引发的变更不会
        // 再触发 scheduleRender → 无限自我喂养循环（页面假死）。
        requestAnimationFrame(function () { rendering = false; });
      }
    });
  }

  function scheduleRender(scope) {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      render(scope);
    });
  }

  function observeDynamicUi() {
    if (!window.MutationObserver || !document.body || document.body.dataset.iconObserver === '1') return;
    document.body.dataset.iconObserver = '1';
    var observer = new MutationObserver(function (mutations) {
      if (rendering) return;
      var shouldRender = mutations.some(function (mutation) {
        return mutation.type === 'characterData' || mutation.addedNodes.length > 0;
      });
      if (shouldRender) scheduleRender(document);
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  }

  window.IconSystem = { render: render, scheduleRender: scheduleRender };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { render(document); observeDynamicUi(); });
  else { render(document); observeDynamicUi(); }
})();
