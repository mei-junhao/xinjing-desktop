(function () {
  'use strict';

  var versionButtons = Array.from(document.querySelectorAll('[data-version]'));
  var concepts = Array.from(document.querySelectorAll('[data-concept]'));

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons({ attrs: { 'aria-hidden': 'true' } });
    }
  }

  function showVersion(version) {
    var selected = String(version);
    versionButtons.forEach(function (button) {
      var active = button.dataset.version === selected;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    concepts.forEach(function (concept) {
      concept.classList.toggle('active', concept.dataset.concept === selected);
    });
    var url = new URL(window.location.href);
    url.searchParams.set('version', selected);
    window.history.replaceState({}, '', url);
    refreshIcons();
  }

  function activateWithin(groupSelector, itemSelector) {
    document.querySelectorAll(groupSelector).forEach(function (group) {
      group.addEventListener('click', function (event) {
        var item = event.target.closest(itemSelector);
        if (!item || !group.contains(item)) return;
        group.querySelectorAll(itemSelector).forEach(function (candidate) {
          candidate.classList.toggle('active', candidate === item);
        });
      });
    });
  }

  function toggleSelection(selector) {
    document.querySelectorAll(selector).forEach(function (item) {
      item.addEventListener('click', function () {
        item.classList.toggle('selected');
        var icon = item.querySelector('svg');
        if (icon) icon.outerHTML = '<i data-lucide="' + (item.classList.contains('selected') ? 'check' : 'plus') + '"></i>';
        refreshIcons();
      });
    });
  }

  function appendDemoMessage(form) {
    var textarea = form.querySelector('textarea');
    var text = textarea.value.trim();
    if (!text) return;
    var concept = form.closest('[data-concept]');
    var thread = concept.querySelector('[data-thread]');
    var userMessage = document.createElement('div');
    userMessage.className = 'message user-message wide-user';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    userMessage.appendChild(bubble);
    thread.appendChild(userMessage);
    textarea.value = '';
    textarea.style.height = '';
    thread.scrollTop = thread.scrollHeight;

    window.setTimeout(function () {
      var response = document.createElement('div');
      response.className = 'message master-message';
      response.innerHTML = '<span class="avatar av-w">温</span><div class="message-body"><div class="message-meta"><strong>温尼科特</strong><time>刚刚</time></div><div class="bubble"></div></div>';
      response.querySelector('.bubble').textContent = '我会先停在你刚才说的这一点上。这里似乎同时有保护关系的愿望，也有害怕失去位置的焦虑。';
      thread.appendChild(response);
      thread.scrollTop = thread.scrollHeight;
      refreshIcons();
    }, 520);
  }

  versionButtons.forEach(function (button) {
    button.addEventListener('click', function () { showVersion(button.dataset.version); });
  });

  document.querySelectorAll('[data-composer]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      appendDemoMessage(form);
    });
    var textarea = form.querySelector('textarea');
    textarea.addEventListener('input', function () {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 110) + 'px';
    });
    textarea.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
  });

  document.querySelector('[data-action="toggle-theme"]').addEventListener('click', function (event) {
    document.documentElement.classList.toggle('dark');
    var icon = event.currentTarget.querySelector('svg');
    if (icon) icon.outerHTML = '<i data-lucide="' + (document.documentElement.classList.contains('dark') ? 'sun' : 'moon') + '"></i>';
    refreshIcons();
  });

  document.querySelector('[data-action="toggle-density"]').addEventListener('click', function () {
    document.body.classList.toggle('compact');
  });

  activateWithin('.history-list', '.history-row');
  activateWithin('.rail-tabs', 'button');
  activateWithin('.source-tabs', 'button');
  activateWithin('.segmented', 'button');
  toggleSelection('.master-row');

  document.addEventListener('keydown', function (event) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    if (/^[1-4]$/.test(event.key)) showVersion(event.key);
  });

  var initial = new URL(window.location.href).searchParams.get('version');
  showVersion(/^[1-4]$/.test(initial || '') ? initial : '1');
})();
