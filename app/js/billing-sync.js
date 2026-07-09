/* ============================================================
 * 心镜 · 记账 ↔ Store 单一真相源 翻译层（共享）
 * ------------------------------------------------------------
 * 设计：原样记账系统(billing.html)只通过 localStorage['psyc_billing_v8']
 *       读写数据。本脚本把该 key 的读写翻译成对「心镜 Store(IndexedDB)」
 *       的操作，使记账的来访者/次数与心镜的来访者/会话成为同一份数据。
 *
 * 两种用法：
 *  1) 在记账页(iframe)内加载：自动安装 localStorage 拦截桥，
 *     记账所有读写静默落到 Store —— 改一处另一处自动变。
 *  2) 在壳页(父窗口)加载：供「导入旧数据」一次性把 psyc JSON 写进 Store。
 * ============================================================ */
(function () {
  'use strict';

  var KEY = 'psyc_billing_v8';

  function clientFee(S, clientId) {
    var c = S.getClient(clientId);
    return c && c.billing ? (c.billing.feePerSession || 0) : 0;
  }

  function hasContent(s) {
    if (!s) return false;
    if (s.transcript && s.transcript.trim()) return true;
    var soap = s.soap || {};
    if (soap.subjective || soap.objective || soap.assessment || soap.plan) return true;
    var dap = s.dap || {};
    if (dap.data || dap.assessment || dap.plan) return true;
    if (s.reflection && s.reflection.trim()) return true;
    if (s.summary && s.summary.trim()) return true;
    return false;
  }

  /* ---------- Store → psyc 格式 ---------- */
  function storeToPsyc(S) {
    if (!S || !S.isHydrated || !S.isHydrated()) {
      return { clients: [], records: [], monthlyPayments: [] };
    }
    var clients = S.getClients().map(function (c) {
      return {
        id: c.id,
        name: c.name || '',
        feePerSession: (c.billing && c.billing.feePerSession) || 0,
        billingMode: (c.billing && c.billing.billingMode) || 'per-session',
        manualSessions: (c.billing && c.billing.manualSessions) || 0,
        status: c.status || 'active'
      };
    });
    var records = [];
    S.getSessions().forEach(function (s) {
      records.push({
        id: 'xj_' + s.id,
        clientId: s.clientId,
        date: s.date || '',
        sessions: 1,
        feePerSession: (s.billing && s.billing.fee) || clientFee(S, s.clientId) || 0,
        paid: !!(s.billing && s.billing.paid)
      });
    });
    var monthlyPayments = [];
    S.getClients().forEach(function (c) {
      var mps = (c.billing && c.billing.monthlyPayments) || [];
      mps.forEach(function (p) {
        monthlyPayments.push(Object.assign({}, p, { clientId: c.id }));
      });
    });
    return { clients: clients, records: records, monthlyPayments: monthlyPayments };
  }

  /* ---------- psyc → Store（幂等 upsert + 删除同步） ---------- */
  function psycToStore(S, data) {
    if (!S || !data) return;
    var clients = data.clients || [];
    var records = data.records || [];
    var monthlyPayments = data.monthlyPayments || [];

    // 1) 来访者
    clients.forEach(function (bc) {
      var client = S.getClient(bc.id);
      if (!client) {
        client = { id: bc.id, name: bc.name || '', status: bc.status || 'active', billing: {} };
        S.saveClient(client);
        client = S.getClient(bc.id);
      }
      client.name = bc.name || client.name;
      client.status = bc.status || client.status || 'active';
      client.billing = client.billing || {};
      client.billing.feePerSession =
        bc.feePerSession != null ? bc.feePerSession : (client.billing.feePerSession || 0);
      client.billing.billingMode = bc.billingMode || client.billing.billingMode || 'per-session';
      client.billing.manualSessions =
        bc.manualSessions != null ? bc.manualSessions : (client.billing.manualSessions || 0);
      S.saveClient(client);
    });

    // 2) 咨询记录 → 会话（按稳定 id 幂等）
    var referencedSids = {};
    records.forEach(function (r) {
      var sid = r.id && r.id.indexOf('xj_') === 0 ? r.id.slice(3) : r.id;
      referencedSids[sid] = true;
      var s = S.getSession(sid);
      if (!s) {
        s = {
          id: sid,
          clientId: r.clientId,
          date: r.date,
          sessionNumber: S.nextSessionNumber(r.clientId),
          billing: {},
        };
        S.saveSession(s);
      }
      s.date = r.date || s.date;
      s.clientId = r.clientId || s.clientId;
      s.billing = s.billing || {};
      s.billing.fee = r.feePerSession != null ? r.feePerSession : (s.billing.fee || 0);
      s.billing.paid = !!r.paid;
      s.billing.source = s.billing.source || 'billing';
      S.saveSession(s);
    });

    // 2b) 删除同步：账单侧已删除、且无实质内容(无逐字稿/报告)的 billing 来源会话，自动移除
    S.getSessions().forEach(function (s) {
      if (s.billing && s.billing.source === 'billing' && !referencedSids[s.id] && !hasContent(s)) {
        S.deleteSession(s.id);
      }
    });

    // 3) 月结付款
    monthlyPayments.forEach(function (p) {
      var client = S.getClient(p.clientId);
      if (client) {
        client.billing = client.billing || {};
        var list = client.billing.monthlyPayments || [];
        var idx = -1;
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === p.id) { idx = i; break; }
        }
        if (idx >= 0) list[idx] = Object.assign({}, list[idx], p);
        else list.push(p);
        client.billing.monthlyPayments = list;
        S.saveClient(client);
      }
    });
  }

  /* ---------- 在 iframe(记账页)内安装 localStorage 拦截桥 ---------- */
  function installBridge() {
    var ls = window.localStorage;
    if (!ls || typeof ls.getItem !== 'function') return;
    var _origGet = ls.getItem.bind(ls);
    var _origSet = ls.setItem.bind(ls);
    ls.getItem = function (k) {
      if (k === KEY) return JSON.stringify(window.BillingSync.storeToPsyc(window.parent.Store));
      return _origGet(k);
    };
    ls.setItem = function (k, v) {
      if (k === KEY) {
        try { window.BillingSync.psycToStore(window.parent.Store, JSON.parse(v)); } catch (e) {}
        return;
      }
      return _origSet(k, v);
    };
  }

  function ensureInstall() {
    if (window.parent && window.parent.Store) {
      installBridge();
      mirrorDarkMode();
    } else {
      setTimeout(ensureInstall, 50);
    }
  }

  // 跟随父窗口深色模式：记账 iframe 不改逻辑，仅镜像父级 <html>.dark
  function mirrorDarkMode() {
    try {
      var pDoc = window.parent.document;
      var pdocEl = pDoc && pDoc.documentElement;
      if (!pdocEl) return;
      var apply = function () {
        document.documentElement.classList.toggle('dark', pdocEl.classList.contains('dark'));
      };
      apply();
      var obs = new MutationObserver(apply);
      obs.observe(pdocEl, { attributes: true, attributeFilter: ['class'] });
    } catch (e) { /* 跨域等情况忽略 */ }
  }

  window.BillingSync = { storeToPsyc: storeToPsyc, psycToStore: psycToStore };

  // 仅在记账页(iframe，且父窗口已就绪)内自动装桥
  if (window !== window.top) {
    ensureInstall();
  }
})();
