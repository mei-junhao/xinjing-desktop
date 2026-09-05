/* 心镜 v3.1.0 — 文档中心（方案E：双栏+Tab分类+成长洞察） */
(function () {
  'use strict';
  var currentClientId = null;
  var currentTab = 'material';
  var searchQuery = '';
  var atlasState = {
    clientId: '', model: null, status: 'idle', requestId: 0, controller: null,
    selectedNodeId: '', selectedSessionId: '', sourceDrawerOpen: false, returnFocusId: ''
  };

  function atlasText(value) { return value == null ? '' : String(value); }

  function isNarrowAtlasLayout() {
    return typeof window !== 'undefined' && window.innerWidth < 1520;
  }

  function stopAtlasRequest() {
    if (atlasState.controller && typeof atlasState.controller.abort === 'function') atlasState.controller.abort();
    atlasState.controller = null;
  }

  function resetAtlasState() {
    stopAtlasRequest();
    atlasState.clientId = currentClientId || '';
    atlasState.model = null;
    atlasState.status = 'idle';
    atlasState.selectedNodeId = '';
    atlasState.selectedSessionId = '';
    atlasState.sourceDrawerOpen = false;
    atlasState.returnFocusId = '';
  }

  function syncDocCenterUrl() {
    try {
      if (!window.history || typeof window.history.replaceState !== 'function') return;
      var params = new URLSearchParams(window.location.search || '');
      if (currentClientId) params.set('clientId', currentClientId);
      else params.delete('clientId');
      if (currentTab === 'atlas') params.set('view', 'atlas');
      else if (params.get('view') === 'atlas') params.delete('view');
      var query = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (query ? '?' + query : '') + (window.location.hash || ''));
    } catch (e) {}
  }

  function growthTrajectoryUrl() {
    return 'doc-growth.html?clientId=' + encodeURIComponent(currentClientId || '');
  }

  function syncGrowthLink() {
    var growthLink = document.getElementById('dc-growth-link');
    if (growthLink) growthLink.setAttribute('href', growthTrajectoryUrl());
  }

  function openGrowthTrajectory() {
    window.location.href = growthTrajectoryUrl();
  }

  function renderClientList() {
    var box = document.getElementById('client-list');
    var clients = Store.getClients().filter(function (c) { return c.status !== 'ended'; });
    box.innerHTML = clients.map(function (c) {
      var sessions = Store.getSessionsByClient(c.id) || [];
      var supervisions = (Store.getSupervisionsByClient ? Store.getSupervisionsByClient(c.id) : []) || [];
      var count = sessions.length + supervisions.length;
      return '<div class="dl-item' + (c.id === currentClientId ? ' active' : '') + '" role="button" tabindex="0" data-client-id="' + App.escapeHtml(c.id) + '">' +
        '<div class="dl-avatar">' + App.escapeHtml(c.name ? c.name[0] : '?') + '</div>' +
        '<div class="dl-info"><div class="dl-name">' + App.escapeHtml(c.name) + '</div><div class="dl-count">' + count + ' 份文档</div></div></div>';
    }).join('');
    renderClientSelect();
  }

  // 顶部下拉：与左栏来访者列表保持同步
  function renderClientSelect() {
    var sel = document.getElementById('dc-client-select');
    if (!sel) return;
    var clients = Store.getClients().filter(function (c) { return c.status !== 'ended'; });
    sel.innerHTML = '<option value="">手动选择来访者…</option>' + clients.map(function (c) {
      return '<option value="' + App.escapeHtml(c.id) + '">' + App.escapeHtml(c.name) + '</option>';
    }).join('');
    sel.value = currentClientId || '';
  }

  window.selectClient = function (clientId) {
    if (currentClientId !== clientId) resetAtlasState();
    currentClientId = clientId;
    if (currentClientId && App.setActiveClientId) App.setActiveClientId(currentClientId);
    syncGrowthLink();
    syncDocCenterUrl();
    renderClientList();
    renderDocs();
  };

  // 顶部下拉手动选择来访者：切换当前来访者并同步左栏高亮
  window.onClientSelect = function (id) {
    if (!id) return;
    selectClient(id);
  };

  window.switchDocTab = function (tab) {
    if (tab === 'trajectory') {
      openGrowthTrajectory();
      return;
    }
    if (currentTab === 'atlas' && tab !== 'atlas') stopAtlasRequest();
    currentTab = tab;
    document.querySelectorAll('.dr-tab').forEach(function (t) {
      var active = t.dataset.tab === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
    });
    syncDocCenterUrl();
    renderDocs();
  };

  window.filterDocs = function () {
    searchQuery = document.getElementById('dc-search').value.trim().toLowerCase();
    renderDocs();
  };

  function renderDocs() {
    var box = document.getElementById('doc-content');
    box.classList.toggle('atlas-content', currentTab === 'atlas');
    if (!currentClientId) {
      if (currentTab === 'atlas') {
        renderAtlasNoClient(box);
      } else {
        box.innerHTML = '<div class="empty-state"><span class="big">' + App.svgIcon('folder-open') + '</span>选择左侧来访者查看文档</div>';
      }
      if (window.IconSystem) window.IconSystem.render(box);
      return;
    }
    var client = Store.getClient(currentClientId);
    if (!client) { box.innerHTML = '<div class="empty-state">来访者不存在</div>'; return; }

    if (currentTab === 'atlas') {
      renderAtlas(box, client);
      return;
    }
    if (currentTab === 'timeline') {
      renderTimeline(box, client);
      return;
    }

    var sessions = Store.getSessionsForPicker(currentClientId).sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    var supervisions = (Store.getSupervisionsByClient ? Store.getSupervisionsByClient(currentClientId) : []) || [];
    var docs = [];
    var materialIds = Object.create(null);

    sessions.forEach(function (s) {
      if ((currentTab === 'material' || currentTab === 'all') && Store.getMaterialWorkspacesForSession) {
        (Store.getMaterialWorkspacesForSession(currentClientId, s.id) || []).forEach(function (summary) {
          var material = Store.getMaterialWorkspace ? Store.getMaterialWorkspace(summary.id) : summary;
          if (!material || material.clientId !== currentClientId || material.sessionId !== s.id || materialIds[material.id]) return;
          materialIds[material.id] = true;
          var parseStatus = material.parseStatus === 'ready' ? '已解析' : (material.parseStatus === 'parsing' ? '解析中' : '解析失败');
          var materialPreview = material.parseStatus === 'ready' ? material.extractedText : (material.parseError || '材料尚未完成解析');
          docs.push({ type: 'material', title: material.title || (material.source && material.source.name) || '未命名材料', date: material.updatedAt || material.createdAt || s.date, preview: materialPreview ? String(materialPreview).slice(0, 120) : '', id: material.id, sessionId: s.id, parseStatus: parseStatus, canOpen: material.parseStatus === 'ready' });
        });
      }
      if (currentTab === 'all' || currentTab === 'transcript') {
        if (s.transcript && s.transcript.trim()) {
          docs.push({ type: 'transcript', title: '第' + (s.sessionNumber || '?') + '节 逐字稿', date: s.date, preview: s.transcript.slice(0, 120), id: s.id, sessionNumber: s.sessionNumber });
        }
      }
      if (currentTab === 'all' || currentTab === 'report') {
        if (s.soap && (s.soap.subjective || s.soap.objective || s.soap.assessment || s.soap.plan)) {
          var soapText = [s.soap.subjective, s.soap.objective, s.soap.assessment, s.soap.plan].filter(Boolean).join(' / ');
          docs.push({ type: 'report', title: '第' + (s.sessionNumber || '?') + '节 咨询记录', date: s.date, preview: soapText.slice(0, 120), id: s.id });
        }
      }
    });

    supervisions.forEach(function (sv) {
      if (currentTab === 'all' || currentTab === 'supervision') {
        var content = sv.content || sv.conclusion || '';
        docs.push({ type: 'supervision', title: (sv.reportTitle || '督导记录') + ' · ' + (sv.supervisorName || ''), date: sv.date, preview: content.slice(0, 120), id: sv.id });
      }
    });

    // 搜索过滤
    if (searchQuery) {
      docs = docs.filter(function (d) {
        return d.title.toLowerCase().indexOf(searchQuery) >= 0 || d.preview.toLowerCase().indexOf(searchQuery) >= 0;
      });
    }

    // 按日期排序
    docs.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });

    if (!docs.length) {
      box.innerHTML = '<div class="empty-state"><span class="big"><i data-lucide="inbox" aria-hidden="true"></i></span>暂无文档' + (searchQuery ? ' 匹配搜索条件' : '') + '</div>';
      if (window.IconSystem) window.IconSystem.render(box);
      return;
    }

    var icons = { material: 'file-check-2', transcript: 'file-text', report: 'clipboard-pen-line', supervision: 'brain-circuit' };
    var tags = { material: '材料', transcript: '逐字稿', report: '咨询记录', supervision: '督导' };

    box.innerHTML = docs.map(function (d) {
      return '<div class="doc-card" role="button" tabindex="0" data-doc-action="open-doc" data-doc-type="' + App.escapeHtml(d.type) + '" data-doc-id="' + App.escapeHtml(d.id) + '">' +
        '<div class="dc-icon">' + App.svgIcon(icons[d.type] || 'file-text') + '</div>' +
        '<div class="dc-body">' +
        '<div class="dc-title">' + App.escapeHtml(d.title) + '</div>' +
        '<div class="dc-meta">' + App.formatDate(d.date) + ' <span class="tag">' + (tags[d.type] || d.type) + '</span>' + (d.parseStatus ? ' <span class="tag">' + App.escapeHtml(d.parseStatus) + '</span>' : '') + '</div>' +
        (d.preview ? '<div class="dc-preview">' + App.escapeHtml(d.preview) + '…</div>' : '') +
        '</div></div>';
    }).join('');

    // 成长洞察只由专属页处理；文档中心不再构造第二条 AI 调用链。
    box.innerHTML += '<div style="text-align:center;padding:8px"><button type="button" class="back" data-doc-action="open-growth">' + App.svgIcon('chart-no-axes-combined') + '查看 ' + App.escapeHtml(client.name) + ' 的 AI 成长洞察</button></div>';
    if (window.IconSystem) window.IconSystem.render(box);
  }

  function renderAtlasNoClient(box) {
    box.innerHTML = '<section class="atlas-empty"><div><h3>尚未选择来访者</h3><p>个案图谱只显示已关联且通过来源校验的材料。先选择一位来访者，再查看其可追溯材料。</p><button type="button" class="atlas-primary" data-doc-action="focus-client-select">选择来访者</button></div></section>';
  }

  function atlasAdmittedNodes(model, clientId) {
    return ((model && model.nodes) || []).filter(function (node) {
      return node && node.kind === 'material' && node.clientId === clientId &&
        node.sourceStatus === 'verified' && node.sourceRef && node.sourceRef.id;
    });
  }

  function atlasMaterialMeta(node) {
    if (!node || !node.id || node.clientId !== currentClientId || !node.sourceRef || !Store.getMaterialWorkspace) return null;
    var locator = atlasText(node.sourceRef.anchor && node.sourceRef.anchor.locator);
    var materialId = locator.indexOf('material:') === 0 ? locator.slice('material:'.length) : '';
    if (!materialId) return null;
    var material = Store.getMaterialWorkspace(materialId);
    if (!material || material.clientId !== currentClientId || material.sessionId !== node.sessionId || material.parseStatus !== 'ready') return null;
    var source = material.source || {};
    return {
      nodeId: node.id,
      materialId: material.id,
      sessionId: material.sessionId,
      title: atlasText(material.title || source.name || '未命名材料'),
      kind: source.ext ? atlasText(source.ext).toUpperCase() + ' 材料' : '已验证材料',
      updatedAt: material.updatedAt || material.createdAt || '',
      sourceId: atlasText(node.sourceRef.id),
      locator: locator,
      anchorKind: atlasText(node.sourceRef.anchor && node.sourceRef.anchor.kind)
    };
  }

  function atlasSessionRows(clientId) {
    return (Store.getSessionsByClient(clientId) || []).slice().sort(function (a, b) {
      return (b.date || '').localeCompare(a.date || '');
    }).map(function (session) {
      return {
        id: atlasText(session.id),
        label: '第' + (session.sessionNumber || '?') + '节',
        detail: App.formatDate(session.date || '') || '未记录日期'
      };
    });
  }

  function atlasCurrentNode(nodes) {
    return nodes.find(function (node) { return node.id === atlasState.selectedNodeId; }) || null;
  }

  function atlasNodeMarkup(meta, selected) {
    return '<button type="button" class="atlas-node' + (selected ? ' selected' : '') + '" id="atlas-node-' + App.escapeHtml(meta.nodeId) + '" data-atlas-action="select-node" data-atlas-node-id="' + App.escapeHtml(meta.nodeId) + '" aria-pressed="' + String(!!selected) + '">' +
      '<span class="atlas-node-type">' + App.svgIcon('file-check-2') + App.escapeHtml(meta.kind) + '</span>' +
      '<h4>' + App.escapeHtml(meta.title) + '</h4>' +
      '<footer><span>' + App.escapeHtml(meta.locator || '来源定位可用') + '</span><span>已验证</span></footer></button>';
  }

  function atlasSourceMarkup(meta, client) {
    if (!meta) {
      return '<div class="atlas-source-empty">选择一份已验证材料后，这里会显示它的来源定位和现有打开命令。图谱不会在这里生成或保存临床推论。</div>';
    }
    var session = Store.getSession ? Store.getSession(meta.sessionId) : null;
    var sessionLabel = session ? '第' + (session.sessionNumber || '?') + '节 · ' + (App.formatDate(session.date || '') || '未记录日期') : '会谈信息不可用';
    return '<div class="atlas-lineage">' +
      '<div class="atlas-lineage-step"><strong>原始来源</strong><span>' + App.escapeHtml(meta.title) + '</span></div>' +
      '<div class="atlas-lineage-step"><strong>关联会谈</strong><span>' + App.escapeHtml(sessionLabel) + '</span></div>' +
      '<div class="atlas-lineage-step"><strong>验证定位</strong><span>' + App.escapeHtml(meta.anchorKind || 'material:text') + ' · ' + App.escapeHtml(meta.locator || meta.sourceId) + '</span></div>' +
      '</div><p class="atlas-source-note">当前图谱只显示已确认的来源链，不把同现关系写成临床因果，也不保存 AI 推论。</p>' +
      '<button type="button" class="atlas-primary" data-atlas-action="open-source">打开当前来源</button>';
  }

  function syncAtlasDrawerAccessibility(box) {
    if (!box) return;
    var narrow = isNarrowAtlasLayout();
    var drawer = box.querySelector('.atlas-source');
    if (drawer) {
      var drawerBlocked = narrow && !atlasState.sourceDrawerOpen;
      drawer.inert = drawerBlocked;
      drawer.setAttribute('aria-hidden', String(drawerBlocked));
    }
    box.querySelectorAll('.atlas-tool-rail, .atlas-sessions, .atlas-main').forEach(function (surface) {
      var backgroundBlocked = narrow && atlasState.sourceDrawerOpen;
      surface.inert = backgroundBlocked;
      surface.setAttribute('aria-hidden', String(backgroundBlocked));
    });
  }

  function renderAtlasContent(box, client, nodes) {
    var sessions = atlasSessionRows(currentClientId);
    var nodeIds = nodes.map(function (node) { return node.id; });
    if (atlasState.selectedNodeId && nodeIds.indexOf(atlasState.selectedNodeId) < 0) atlasState.selectedNodeId = '';
    var visibleNodes = atlasState.selectedSessionId ? nodes.filter(function (node) {
      return node.sessionId === atlasState.selectedSessionId;
    }) : nodes.slice();
    var selectedHidden = !!atlasState.selectedNodeId && !visibleNodes.some(function (node) { return node.id === atlasState.selectedNodeId; });
    if (!atlasState.selectedNodeId && visibleNodes.length) atlasState.selectedNodeId = visibleNodes[0].id;
    var selectedNode = atlasCurrentNode(nodes);
    var selectedMeta = atlasMaterialMeta(selectedNode);
    var counts = {};
    nodes.forEach(function (node) { counts[node.sessionId] = (counts[node.sessionId] || 0) + 1; });

    var sessionsHtml = '<aside class="atlas-sessions" aria-label="会谈时间线"><h3 class="atlas-section-title">会谈时间线 <span class="atlas-count">' + sessions.length + ' 节</span></h3>';
    sessionsHtml += '<button type="button" class="atlas-session' + (!atlasState.selectedSessionId ? ' active' : '') + '" data-atlas-action="select-session" data-atlas-session-id=""><b>全部会谈</b><small>' + nodes.length + ' 份已验证材料</small></button>';
    sessionsHtml += sessions.map(function (session) {
      var active = session.id === atlasState.selectedSessionId;
      return '<button type="button" class="atlas-session' + (active ? ' active' : '') + '" aria-pressed="' + String(active) + '" data-atlas-action="select-session" data-atlas-session-id="' + App.escapeHtml(session.id) + '"><b>' + App.escapeHtml(session.label) + '</b><small>' + App.escapeHtml(session.detail) + ' · ' + (counts[session.id] || 0) + ' 份材料</small></button>';
    }).join('') + '</aside>';
    var compactSession = '<label class="atlas-compact-session"><span>会谈</span><select aria-label="筛选会谈" data-atlas-session-select><option value="">全部会谈</option>' + sessions.map(function (session) {
      return '<option value="' + App.escapeHtml(session.id) + '"' + (session.id === atlasState.selectedSessionId ? ' selected' : '') + '>' + App.escapeHtml(session.label) + '</option>';
    }).join('') + '</select></label>';

    var cards = visibleNodes.map(function (node) {
      var meta = atlasMaterialMeta(node);
      return meta ? atlasNodeMarkup(meta, node.id === atlasState.selectedNodeId) : '';
    }).join('');
    if (!visibleNodes.length) {
      cards = '<div class="atlas-inline-notice">' + (atlasState.selectedSessionId ? '本节会谈没有通过来源校验的材料。切换会谈不会修改任何材料关联。' : '当前来访者还没有通过来源校验的材料。可到材料视图完成关联与解析后再返回此处。') + '</div>';
    }
    if (selectedHidden) cards += '<div class="atlas-inline-notice">当前材料已被筛选隐藏。图谱保留当前选择，不会自动切换到其他材料。</div>';

    var sourceOpen = atlasState.sourceDrawerOpen ? ' drawer-open' : '';
    var drawerIsHidden = !atlasState.sourceDrawerOpen && isNarrowAtlasLayout();
    var toolRail = '<aside class="atlas-tool-rail" aria-label="图谱工具">' +
      '<span class="atlas-tool-current" title="选择材料" aria-label="当前工具：选择材料">' + App.svgIcon('mouse-pointer-2') + '</span>' +
      '<button type="button" title="显示全部会谈" aria-label="显示全部会谈" data-atlas-action="select-session" data-atlas-session-id="">' + App.svgIcon('maximize-2') + '</button>' +
      '<span class="atlas-tool-separator"></span>' +
      '<button type="button" title="重新校验来源" aria-label="重新校验来源" data-atlas-action="refresh">' + App.svgIcon('refresh-cw') + '</button>' +
      '</aside>';
    box.innerHTML = '<div class="atlas-shell">' + toolRail + sessionsHtml +
      '<section class="atlas-main" aria-label="材料画布"><header class="atlas-toolbar"><div><h3>材料画布</h3><span class="atlas-status">仅显示已通过来源校验的只读材料</span></div><span class="atlas-spacer"></span>' + compactSession + '<button type="button" class="atlas-primary"' + (selectedMeta ? '' : ' disabled title="请先选择已验证材料"') + ' data-atlas-action="open-source">打开当前来源</button></header><div class="atlas-board">' + cards + '</div></section>' +
      '<div class="atlas-drawer-scrim' + (atlasState.sourceDrawerOpen ? ' visible' : '') + '" data-atlas-action="close-drawer" aria-hidden="true"></div>' +
      '<aside class="atlas-source' + sourceOpen + '" aria-label="来源检查器" aria-hidden="' + String(drawerIsHidden) + '"' + (drawerIsHidden ? ' inert' : '') + '><header class="atlas-source-header"><div><small>只读投影</small><h3>来源检查器</h3></div><button type="button" class="atlas-drawer-close" id="atlas-source-close" data-atlas-action="close-drawer">关闭</button></header>' + atlasSourceMarkup(selectedMeta, client) + '</aside></div>';
    if (window.IconSystem) window.IconSystem.render(box);
    syncAtlasDrawerAccessibility(box);
  }

  function renderAtlas(box, client) {
    if (atlasState.status === 'ready' && atlasState.clientId === currentClientId && atlasState.model) {
      renderAtlasContent(box, client, atlasAdmittedNodes(atlasState.model, currentClientId));
      return;
    }
    if (!window.CaseSpaceViewModel || typeof window.CaseSpaceViewModel.refresh !== 'function') {
      box.innerHTML = '<section class="atlas-empty"><div><h3>图谱投影不可用</h3><p>来源校验模块尚未就绪，已停止显示材料，避免呈现未验证来源。</p></div></section>';
      return;
    }
    stopAtlasRequest();
    atlasState.status = 'loading';
    atlasState.clientId = currentClientId;
    var requestId = ++atlasState.requestId;
    atlasState.controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    box.innerHTML = '<section class="atlas-empty"><div><h3>正在校验材料来源</h3><p>图谱只在来源投影完成后显示，不会回退到未验证材料。</p></div></section>';
    var options = { currentContext: { clientId: currentClientId } };
    if (atlasState.controller) options.signal = atlasState.controller.signal;
    Promise.resolve(window.CaseSpaceViewModel.refresh(currentClientId, options)).then(function (result) {
      if (requestId !== atlasState.requestId || currentTab !== 'atlas' || currentClientId !== atlasState.clientId) return;
      if (!result || !result.ok || !result.model) {
        atlasState.status = 'error';
        box.innerHTML = '<section class="atlas-empty"><div><h3>图谱未能安全加载</h3><p>当前来源投影无效或已经过期。请重新选择来访者后再试。</p></div></section>';
        return;
      }
      atlasState.model = result.model;
      atlasState.status = 'ready';
      renderAtlasContent(box, client, atlasAdmittedNodes(result.model, currentClientId));
    }).catch(function () {
      if (requestId !== atlasState.requestId || currentTab !== 'atlas') return;
      atlasState.status = 'error';
      box.innerHTML = '<section class="atlas-empty"><div><h3>图谱未能安全加载</h3><p>读取来源投影时出现异常，未显示任何可能过期的材料。</p></div></section>';
    });
  }

  window.focusAtlasClientSelect = function () {
    var select = document.getElementById('dc-client-select');
    if (select && typeof select.focus === 'function') select.focus();
  };

  window.refreshAtlasProjection = function () {
    stopAtlasRequest();
    atlasState.status = 'idle';
    atlasState.model = null;
    atlasState.selectedNodeId = '';
    var box = document.getElementById('doc-content');
    var client = currentClientId && Store.getClient(currentClientId);
    if (box && client && currentTab === 'atlas') renderAtlas(box, client);
  };

  window.selectAtlasSession = function (sessionId) {
    atlasState.selectedSessionId = atlasText(sessionId);
    var box = document.getElementById('doc-content');
    var client = Store.getClient(currentClientId);
    if (box && client && atlasState.model) renderAtlasContent(box, client, atlasAdmittedNodes(atlasState.model, currentClientId));
  };

  window.selectAtlasNode = function (nodeId) {
    var nodes = atlasAdmittedNodes(atlasState.model, currentClientId);
    var node = nodes.find(function (candidate) { return candidate.id === nodeId; });
    if (!node || !atlasMaterialMeta(node)) return;
    atlasState.selectedNodeId = nodeId;
    atlasState.returnFocusId = 'atlas-node-' + nodeId;
    if (isNarrowAtlasLayout()) atlasState.sourceDrawerOpen = true;
    var box = document.getElementById('doc-content');
    var client = Store.getClient(currentClientId);
    if (box && client) renderAtlasContent(box, client, nodes);
    if (atlasState.sourceDrawerOpen) setTimeout(function () {
      var close = document.getElementById('atlas-source-close');
      if (close && typeof close.focus === 'function') close.focus();
    }, 0);
  };

  window.closeAtlasDrawer = function () {
    if (!atlasState.sourceDrawerOpen) return;
    atlasState.sourceDrawerOpen = false;
    var box = document.getElementById('doc-content');
    var client = Store.getClient(currentClientId);
    if (box && client && atlasState.model) renderAtlasContent(box, client, atlasAdmittedNodes(atlasState.model, currentClientId));
    var focusId = atlasState.returnFocusId;
    setTimeout(function () {
      var trigger = focusId && document.getElementById(focusId);
      if (trigger && typeof trigger.focus === 'function') trigger.focus();
    }, 0);
  };

  window.openAtlasSource = function () {
    var node = atlasCurrentNode(atlasAdmittedNodes(atlasState.model, currentClientId));
    var meta = atlasMaterialMeta(node);
    if (!meta || !Store.getMaterialWorkspace) return;
    var material = Store.getMaterialWorkspace(meta.materialId);
    if (!material || material.clientId !== currentClientId || material.sessionId !== meta.sessionId || material.parseStatus !== 'ready') {
      if (App.showToast) App.showToast('来源已变化，请重新打开图谱', 'warning');
      return;
    }
    window.location.href = 'transcript.html?clientId=' + encodeURIComponent(currentClientId) + '&sessionId=' + encodeURIComponent(meta.sessionId) + '&materialId=' + encodeURIComponent(meta.materialId);
  };

  function handleAtlasEscape(event) {
    if (event && event.key === 'Escape' && atlasState.sourceDrawerOpen) {
      event.preventDefault();
      window.closeAtlasDrawer();
    }
  }

  function hasClinicalNote(session) {
    var soap = session.soap || {};
    var dap = session.dap || {};
    return !!(
      String(session.notes || session.reflection || session.summary || '').trim() ||
      String(soap.subjective || soap.objective || soap.assessment || soap.plan || '').trim() ||
      String(dap.data || dap.assessment || dap.plan || '').trim()
    );
  }

  function timelineButton(label, target, value) {
    return '<button type="button" data-timeline-target="' + App.escapeHtml(target) + '" data-timeline-value="' + App.escapeHtml(String(value || '')) + '">' + App.escapeHtml(label) + '</button>';
  }

  function renderTimeline(box, client) {
    var today = new Date().toISOString().slice(0, 10);
    var sessions = Store.getSessionsByClient(currentClientId).slice();
    var seen = {};
    sessions = sessions.filter(function (s) { if (!s.id || seen[s.id]) return false; seen[s.id] = true; return true; });
    var supervisions = Store.getSupervisionsByClient ? Store.getSupervisionsByClient(currentClientId) : [];
    var futureSessions = sessions.filter(function (s) { return s.date && s.date >= today; })
      .sort(function (a, b) { return ((a.date || '') + (a.startTime || '')).localeCompare((b.date || '') + (b.startTime || '')); });
    var pendingNotes = sessions.filter(function (s) { return s.date && s.date <= today && !hasClinicalNote(s); })
      .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    var unpaidSessions = sessions.filter(function (s) {
      return Store.isBillableSession && Store.isBillableSession(s) && !(s.billing || {}).paid;
    }).sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    var payments = ((client.billing && client.billing.monthlyPayments) || []).slice();
    var html = '<div class="trajectory"><div class="tj-head"><span class="tj-title">' + App.svgIcon('clock-3') + App.escapeHtml(client.name) + ' 的个案时间线</span><span class="tj-badge">只读聚合</span></div>';
    html += '<div class="timeline-summary">';
    html += '<div class="summary-block"><h3>下一次会谈</h3>';
    if (futureSessions.length) {
      html += futureSessions.slice(0, 3).map(function (s) {
        return '<div class="summary-item">第' + App.escapeHtml(String(s.sessionNumber || '?')) + '节 · ' + App.escapeHtml(App.formatDate(s.date)) + (s.startTime ? ' ' + App.escapeHtml(s.startTime) : '') +
          '<div class="timeline-actions">' + timelineButton('开始记录', 'notes', s.id) + timelineButton('查看日历', 'calendar', s.date) + '</div></div>';
      }).join('');
    } else {
      html += '<div class="summary-item">尚未安排下一次会谈<div class="timeline-actions">' + timelineButton('安排会谈', 'calendar', today) + '</div></div>';
    }
    html += '</div>';
    html += '<div class="summary-block"><h3>待完成事项</h3>';
    var pending = [];
    pendingNotes.slice(0, 3).forEach(function (s) { pending.push({ label: '补充第' + (s.sessionNumber || '?') + '节记录', target: 'notes', value: s.id }); });
    unpaidSessions.slice(0, 3).forEach(function (s) { pending.push({ label: '核对第' + (s.sessionNumber || '?') + '节收款', target: 'billing', value: currentClientId }); });
    if (pending.length) {
      html += pending.map(function (item) { return '<div class="summary-item">' + App.escapeHtml(item.label) + '<div class="timeline-actions">' + timelineButton('处理', item.target, item.value) + '</div></div>'; }).join('');
    } else {
      html += '<div class="summary-item">暂无待完成事项</div>';
    }
    html += '</div></div>';

    var events = [];
    sessions.filter(function (s) { return !s.date || s.date < today; }).forEach(function (s) {
      var details = [];
      if (hasClinicalNote(s)) details.push('已记录');
      else details.push('待补记录');
      if (s.transcript && s.transcript.trim()) details.push('含逐字稿');
      if (Store.isBillableSession && Store.isBillableSession(s)) details.push((s.billing || {}).paid ? '已收款' : '待收款');
      events.push({ date: s.date || s.createdAt || '', tag: '会谈', title: '第' + (s.sessionNumber || '?') + '节会谈', text: details.join(' · '), target: 'notes', value: s.id });
    });
    payments.forEach(function (payment) {
      if (!payment || !payment.month) return;
      events.push({ date: payment.month + '-01', tag: '月结', title: payment.month + ' 月结', text: '已记录 ¥' + Number(payment.amount || 0).toLocaleString(), target: 'billing', value: currentClientId });
    });
    supervisions.forEach(function (supervision) {
      var content = String(supervision.summary || supervision.conclusion || supervision.content || '').trim();
      events.push({ date: supervision.date || supervision.createdAt || '', tag: '督导', title: supervision.reportTitle || '督导记录', text: content ? content.slice(0, 100) : '督导材料已保存', target: 'supervision', value: supervision.sessionId || ((supervision.sessionIds || [])[0]) || '' });
    });
    events.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    html += '<div class="tj-head" style="margin-top:8px"><span class="tj-title">历史事件</span></div>';
    if (!events.length) {
      html += '<div class="empty-state" style="padding:20px">暂无历史事件</div>';
    } else {
      events.forEach(function (event) {
        html += '<div class="tj-item"><div class="tj-date">' + App.escapeHtml(App.formatDate(event.date)) + '</div><div class="tj-text"><b>' + App.escapeHtml(event.title) + '</b><br>' + App.escapeHtml(event.text) + '<div class="timeline-actions">' + timelineButton('查看详情', event.target, event.value) + '</div></div><span class="tj-tag">' + App.escapeHtml(event.tag) + '</span></div>';
      });
    }
    box.innerHTML = html + '</div>';
  }

  window.openTimelineTarget = function (target, value) {
    var clientId = encodeURIComponent(currentClientId || '');
    if (target === 'notes') location.href = 'consult-notes.html?clientId=' + clientId + '&sessionId=' + encodeURIComponent(value || '') + '&mode=quick';
    else if (target === 'billing') location.href = 'billing-shell.html?clientId=' + clientId;
    else if (target === 'supervision') location.href = 'supervision.html?clientId=' + clientId + (value ? '&sessionId=' + encodeURIComponent(value) : '');
    else if (target === 'calendar') location.href = 'session-calendar.html?date=' + encodeURIComponent(value || '');
  };

  window.openDoc = function (type, id) {
    var clientId = currentClientId || '';
    if (!clientId) return;
    if (type === 'transcript' || type === 'report') {
      var session = Store.getSession ? Store.getSession(id) : null;
      if (!session || session.clientId !== clientId) {
        if (App.showToast) App.showToast('会谈不属于当前来访者，已阻止打开', 'warning');
        return;
      }
      location.href = 'consult-notes.html?clientId=' + encodeURIComponent(clientId) + '&sessionId=' + encodeURIComponent(id) + '&mode=quick';
    } else if (type === 'material') {
      var material = Store.getMaterialWorkspace ? Store.getMaterialWorkspace(id) : null;
      if (!material || material.clientId !== clientId || !material.sessionId || (Store.getSession && (!Store.getSession(material.sessionId) || Store.getSession(material.sessionId).clientId !== clientId))) {
        if (App.showToast) App.showToast('材料归属无法核对，已阻止打开', 'warning');
        return;
      }
      if (material.parseStatus !== 'ready' || !String(material.extractedText || '').trim()) {
        if (App.showToast) App.showToast(material.parseError || '材料尚未完成解析，暂时无法打开', 'warning');
        return;
      }
      location.href = 'transcript.html?clientId=' + encodeURIComponent(clientId) + '&sessionId=' + encodeURIComponent(material.sessionId) + '&materialId=' + encodeURIComponent(material.id);
    } else if (type === 'supervision') {
      var supervision = Store.getSupervision ? Store.getSupervision(id) : null;
      if (!supervision || supervision.clientId !== clientId) {
        if (App.showToast) App.showToast('督导记录不属于当前来访者，已阻止打开', 'warning');
        return;
      }
      location.href = 'real-supervision.html?id=' + encodeURIComponent(id || '') + '&clientId=' + encodeURIComponent(clientId);
    }
  };

  function activateClientControl(control) {
    if (!control) return;
    window.selectClient(control.getAttribute('data-client-id') || '');
  }

  function handleDocContentAction(control) {
    if (!control) return;
    var docAction = control.getAttribute('data-doc-action');
    if (docAction === 'open-doc') {
      window.openDoc(control.getAttribute('data-doc-type') || '', control.getAttribute('data-doc-id') || '');
      return;
    }
    if (docAction === 'open-growth') {
      openGrowthTrajectory();
      return;
    }
    if (docAction === 'focus-client-select') {
      window.focusAtlasClientSelect();
      return;
    }
    var atlasAction = control.getAttribute('data-atlas-action');
    if (atlasAction === 'select-node') window.selectAtlasNode(control.getAttribute('data-atlas-node-id') || '');
    else if (atlasAction === 'select-session') window.selectAtlasSession(control.getAttribute('data-atlas-session-id') || '');
    else if (atlasAction === 'refresh') window.refreshAtlasProjection();
    else if (atlasAction === 'open-source') window.openAtlasSource();
    else if (atlasAction === 'close-drawer') window.closeAtlasDrawer();
    else if (control.hasAttribute('data-timeline-target')) window.openTimelineTarget(control.getAttribute('data-timeline-target') || '', control.getAttribute('data-timeline-value') || '');
  }

  function bindDocCenterEvents() {
    var clientList = document.getElementById('client-list');
    if (clientList) {
      clientList.addEventListener('click', function (event) {
        activateClientControl(event.target.closest('[data-client-id]'));
      });
      clientList.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        var control = event.target.closest('[data-client-id]');
        if (!control) return;
        event.preventDefault();
        activateClientControl(control);
      });
    }

    var search = document.getElementById('dc-search');
    if (search) search.addEventListener('input', window.filterDocs);
    var clientSelect = document.getElementById('dc-client-select');
    if (clientSelect) clientSelect.addEventListener('change', function (event) { window.onClientSelect(event.target.value); });
    var tabs = document.getElementById('doc-tabs');
    if (tabs) tabs.addEventListener('click', function (event) {
      var tab = event.target.closest('[data-tab]');
      if (tab) window.switchDocTab(tab.getAttribute('data-tab') || 'all');
    });

    var content = document.getElementById('doc-content');
    if (content) {
      content.addEventListener('click', function (event) {
        handleDocContentAction(event.target.closest('[data-doc-action], [data-atlas-action], [data-timeline-target]'));
      });
      content.addEventListener('change', function (event) {
        if (event.target && event.target.hasAttribute('data-atlas-session-select')) window.selectAtlasSession(event.target.value || '');
      });
      content.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        var control = event.target.closest('.doc-card[role="button"]');
        if (!control) return;
        event.preventDefault();
        handleDocContentAction(control);
      });
    }
  }

  App.initPage({
    title: '文档中心',
    onReady: function () {
      try {
        var params = new URLSearchParams(location.search);
        var initialClientId = params.get('clientId') || (App.getActiveClientId && App.getActiveClientId());
        if (initialClientId && Store.getClient(initialClientId)) currentClientId = initialClientId;
        if (params.get('view') === 'atlas') currentTab = 'atlas';
      } catch (e) {}
      document.querySelectorAll('.dr-tab').forEach(function (tab) {
        var active = tab.dataset.tab === currentTab;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
      });
      bindDocCenterEvents();
      document.addEventListener('keydown', handleAtlasEscape);
      syncGrowthLink();
      renderClientList();
      renderDocs();
      // P0#3 修复：动态设置 AI 成长洞察链接的锁标记
      var growthLink = document.getElementById('dc-growth-link');
      if (growthLink && typeof App !== 'undefined' && typeof App.lockBadge === 'function') {
        var badge = App.lockBadge('ai-growth');
        if (badge) growthLink.innerHTML = '<i data-lucide="chart-no-axes-combined"></i>AI 成长洞察 ' + badge;
        if (window.IconSystem) window.IconSystem.render(growthLink);
      }
      if (currentClientId && App.setActiveClientId) App.setActiveClientId(currentClientId);
    }
  });
})();
