/* XinJing v3.8 - offline Lucide icon bridge. */
(function () {
  'use strict';

  var iconScriptId = 'xj-lucide-runtime';
  var pending = false;
  var emojiIcons = {
    '🤖': 'sparkles', '📄': 'file-text', '📝': 'clipboard-pen-line', '📅': 'calendar-days',
    '💬': 'message-circle', '🧠': 'brain-circuit', '🔍': 'search', '👥': 'users-round',
    '📋': 'clipboard-list', '💰': 'circle-dollar-sign', '💵': 'circle-dollar-sign', '🎯': 'target',
    '📂': 'folder-open', '📁': 'folder-up', '✨': 'sparkles', '👤': 'user-round', '🔒': 'lock-keyhole',
    '📖': 'book-open', '📚': 'library-big', '📤': 'arrow-up-from-line',
    '👋': 'hand', '⚙': 'settings-2', '🎤': 'mic', '💡': 'lightbulb', '🧭': 'compass', '🌱': 'sprout'
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
      var match = String(textNode.nodeValue || '').match(/^(\s*)(🤖|📄|📝|📅|💬|🧠|🔍|👥|📋|💰|💵|🎯|📂|📁|✨|👤|🔒|📖|📚|📤|👋|⚙|🎤|💡|🧭|🌱)\s*/);
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
      window.lucide.createIcons({
        root: scope || document,
        attrs: { width: 18, height: 18, 'stroke-width': 1.7, 'aria-hidden': 'true' }
      });
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

  window.IconSystem = { render: render, scheduleRender: scheduleRender };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { render(document); });
  else render(document);
})();
