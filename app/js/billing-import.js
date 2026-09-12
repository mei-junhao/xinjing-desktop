/* ============================================================
   心镜 XinJing — 记账导入模块（JSON/CSV → Store 幂等导入，单一实现）
   宿主：billing-shell.html（「导入数据」弹窗 · 记账 Tab）
        sync.html（独立「同步记账」页）
   2026-09-12 由 billing-shell.html 内联脚本抽取为独立模块，
   避免两份导入实现漂移；抽取同时保留本次「去重作用域」修复：
   去重键 [billing:KEY] 全库比对 + 全库不可读时 fail-closed（见函数内注释）。

   DOM 契约（宿主页面必须提供以下 id 元素）：
     #billing-input    <textarea>  JSON / CSV 粘贴区
     #billing-file     <input type="file"> 文件选择
     #billing-preview  <div>       预览容器
     #billing-result   <div>       结果提示
   依赖全局：Store（js/store.js）、App（js/app.js，escapeHtml 等）
   ============================================================ */

  const BillingImport = (() => {
    let parsed = null;
    function reset() { parsed = null; }
    function setResult(msg, color) {
      const el = document.getElementById('billing-result');
      el.textContent = msg;
      el.style.color = color || 'var(--muted)';
    }
    function normDate(s) {
      if (!s) return '';
      s = String(s).trim();
      const m = s.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
      if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
      const d = new Date(s);
      return isNaN(d) ? '' : d.toISOString().slice(0, 10);
    }
    function parseCSVrows(text) {
      text = text.replace(/^﻿/, '');
      const rows = []; let row = [], field = '', inQ = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQ) {
          if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
          else field += ch;
        } else {
          if (ch === '"') inQ = true;
          else if (ch === ',') { row.push(field); field = ''; }
          else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
          else if (ch === '\r') {}
          else field += ch;
        }
      }
      if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
      return rows;
    }
    function parseInput(text) {
      text = text.trim();
      if (text.startsWith('{') || text.startsWith('[')) {
        return parseJSON(JSON.parse(text));
      }
      if (text.includes('来访者') || text.includes(',')) {
        return parseCSV(text);
      }
      throw new Error('无法识别格式，请粘贴 JSON 或 CSV');
    }
    function parseJSON(data) {
      if (!Array.isArray(data.clients) || !Array.isArray(data.records)) {
        throw new Error('JSON 应为 { clients, records, monthlyPayments } 结构');
      }
      const idToName = {};
      const clients = data.clients.map(c => {
        const name = (c.name || '').trim();
        if (c.id) idToName[c.id] = name;
        return { name, feePerSession: Number(c.feePerSession) || 0, billingMode: c.billingMode === 'monthly' ? 'monthly' : 'per-session', status: c.status === 'paused' ? 'paused' : 'active', manualSessions: Number(c.manualSessions) || 0 };
      }).filter(c => c.name);
      const records = data.records.map(r => ({
        clientName: (r.clientId && idToName[r.clientId]) || '',
        date: normDate(r.date),
        sessions: Math.max(1, parseInt(r.sessions) || 1),
        feePerSession: Number(r.feePerSession) || 0,
        paid: !!r.paid,
        billingMode: r.billingMode || 'per-session',
        key: 'rec_' + (r.id || (r.clientId + '_' + r.date + '_' + r.sessions))
      })).filter(r => r.clientName && r.date);
      return { format: 'json', clients, records, raw: data };
    }
    function parseCSV(text) {
      const rows = parseCSVrows(text);
      if (rows.length < 2) throw new Error('CSV 内容为空或缺少数据行');
      const header = rows[0].map(h => String(h || '').trim());
      const idx = {
        name: header.indexOf('来访者'),
        date: header.indexOf('日期'),
        sessions: header.indexOf('次数'),
        fee: header.indexOf('单价'),
        paid: header.indexOf('缴费状态'),
        mode: header.indexOf('结算方式')
      };
      if (idx.name < 0 || idx.date < 0) throw new Error('CSV 缺少「来访者」或「日期」列');
      const clientsMap = {};
      const records = [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const name = String(row[idx.name] || '').trim();
        if (!name) continue;
        const date = normDate(row[idx.date]);
        if (!date) continue;
        const sessions = Math.max(1, parseInt(row[idx.sessions] || '1') || 1);
        const fee = Number(row[idx.fee] || 0) || 0;
        const paid = idx.paid >= 0 ? /已缴/.test(String(row[idx.paid] || '')) : false;
        var isMonthly = false;
        if (idx.mode >= 0 && /月结/.test(String(row[idx.mode] || ''))) isMonthly = true;
        if (idx.mode >= 0 && /预付费|预付/.test(String(row[idx.mode] || ''))) isMonthly = false;
        // If no mode column, check if client name suggests monthly
        var clientMode = isMonthly ? 'monthly' : 'per-session';
        records.push({ clientName: name, date, sessions, feePerSession: fee, paid, billingMode: clientMode, key: 'csv_' + name + '_' + date + '_' + sessions });
        if (!clientsMap[name]) {
          clientsMap[name] = { name, feePerSession: fee, billingMode: clientMode, status: 'active', manualSessions: 0 };
        }
      }
      const clients = Object.values(clientsMap);
      if (!clients.length) throw new Error('CSV 中未解析到任何来访者记录');
      return { format: 'csv', clients, records };
    }
    function importSessionKey(batchKey, index) {
      return String(batchKey || '') + '#' + (index + 1);
    }
    // 全库会谈查询：去重键 [billing:KEY] 源自记账系统的记录 id，是**业务唯一键**，
    // 跨来访者同样唯一。若只在单个 clientId 名下查重，一旦来访者对象被替换
    // （改名导致姓名匹配失败、换库、删除后重建），新 id 名下「一条没有」，
    // 整批记录会被再次写入，造成静默的批量重复
    // （实测后果：同一批业务事实被写入 4 套来访者 id，遗留上万条孤儿记录）。
    // 故去重必须在全库范围比对，而不是限制在某个来访者名下。
    function allSessions() {
      try {
        // fail-closed：Store 不可用 / 返回空值时一律返回 null，由调用方拒绝写入；
        // 严禁把异常态退化成「空库」——那会让去重检查在降级时放行重复导入。
        if (typeof Store.getSessions !== 'function') return null;
        var list = Store.getSessions();
        if (!list || !Array.isArray(list)) return null;
        return list;
      } catch (e) {
        // fail-closed：查不到全库状态时不写入，避免因降级而重复导入
        return null;
      }
    }
    // 兼容旧版：此前同一批多节记录共享 key，只能按数量占位；
    // 新版每一节使用独立 key，保证重试与跨库合并不会压缩多节账单。
    function importedSessionCount(sessions, batchKey) {
      if (!sessions) return 0; // 全库查询失败（null）→ 视为 0，交由调用方 fail-closed 处理
      var key = String(batchKey || '');
      if (!key) return 0;
      return (sessions || []).filter(function (s) {
        var b = s && s.billing;
        var importKey = b && b.importKey != null ? String(b.importKey) : '';
        return (b && String(b.importBatchKey || '') === key) ||
          importKey === key || importKey.indexOf(key + '#') === 0 ||
          String(s && s.notes || '').indexOf('[billing:' + key + ']') >= 0;
      }).length;
    }
    function missingImportSessionKeys(sessions, record) {
      var batchKey = String(record.key || '');
      if (!batchKey) return [];
      var all = sessions || [];
      var exact = new Set(all.map(function (s) { return String(s && s.billing && s.billing.importKey || ''); }).filter(Boolean));
      var legacySlots = all.filter(function (s) {
        var b = s && s.billing;
        var importKey = b && b.importKey != null ? String(b.importKey) : '';
        return importKey === batchKey || String(s && s.notes || '').indexOf('[billing:' + batchKey + ']') >= 0;
      }).length;
      var missing = [];
      for (var i = 0; i < (record.sessions || 0); i++) {
        var key = importSessionKey(batchKey, i);
        if (exact.has(key)) continue;
        if (legacySlots > 0) { legacySlots--; continue; }
        missing.push(key);
      }
      return missing;
    }
    function computePlan(p) {
      const nameToId = {};
      Store.getClients().forEach(c => { nameToId[c.name.trim()] = c.id; });
      const byClient = {};
      p.clients.forEach(c => { const n = c.name.trim(); byClient[n] = byClient[n] || { newCount: 0, skipCount: 0, fee: c.feePerSession, billingMode: c.billingMode, status: c.status, manualSessions: c.manualSessions }; });
      // 去重在全库范围比对（见 allSessions 注释）。全库查询失败时 fail-closed：
      // 视为「无法确认去重状态」，不承诺任何写入，避免盲目重复导入。
      const pool = allSessions();
      if (pool === null) {
        return { nameToId, byClient, newClientCount: 0, newSessionCount: 0, skipCount: 0, blocked: 'dedup-unavailable' };
      }
      p.records.forEach(r => {
        const n = (r.clientName || '').trim();
        byClient[n] = byClient[n] || { newCount: 0, skipCount: 0, dupCount: 0 };
        // 不以「该来访者是否已存在」为前提：即使来访者尚未创建，
        // 全库也可能已有同批次记录（重复导入的典型情形）。
        const already = Math.min(r.sessions, importedSessionCount(pool, r.key));
        byClient[n].newCount += Math.max(0, r.sessions - already);
        byClient[n].skipCount += already;
      });
      let newClientCount = 0, newSessionCount = 0, skipCount = 0;
      Object.keys(byClient).forEach(n => {
        if (!nameToId[n]) newClientCount++;
        newSessionCount += byClient[n].newCount;
        skipCount += byClient[n].skipCount;
      });
      return { nameToId, byClient, newClientCount, newSessionCount, skipCount };
    }
    function renderPreview(p) {
      const plan = computePlan(p);
      // 去重状态不可用时明确告知，不呈现「全部新增」的乐观假象
      if (plan.blocked === 'dedup-unavailable') {
        // 清掉上一次解析遗留的预览表，避免旧预览与「已暂停」提示并存造成误读
        document.getElementById('billing-preview').innerHTML = '';
        setResult('暂时无法读取已有记录，为避免重复导入，已暂停本次导入。请稍后重试。', 'var(--accent)');
        return;
      }
      let rows = '';
      Object.keys(plan.byClient).forEach(name => {
        const info = plan.byClient[name];
        const isNew = !plan.nameToId[name];
        const cls = isNew ? 'new' : 'skip';
        rows += `<tr><td class="${cls}">${App.escapeHtml(name)}</td><td><span class="tag ${cls}">${isNew ? '新增' : '已有'}</span></td><td>${info.newCount}</td><td>${info.skipCount}</td></tr>`;
      });
      document.getElementById('billing-preview').innerHTML = `
        <div class="preview-card">
          <div class="preview-pills">
            <span class="pill add"><b>${plan.newClientCount}</b>新增来访者</span>
            <span class="pill add"><b>${plan.newSessionCount}</b>新增节次</span>
            <span class="pill skip"><b>${plan.skipCount}</b>跳过(已存在)</span>
            <span class="pill"><b>${p.clients.length}</b>总来访者</span>
            <span class="pill"><b>${p.records.length}</b>总记录</span>
          </div>
          <div style="max-height:200px;overflow-y:auto">
            <table class="preview-table"><thead><tr><th>来访者</th><th>状态</th><th>新增节次</th><th>跳过节次</th></tr></thead><tbody>${rows}</tbody></table>
          </div>
        </div>`;
      setResult(plan.newSessionCount > 0 ? '预览就绪，点「确认导入」写入。' : '全部记录已存在，无需重复导入。', 'var(--text)');
    }
    function parseText() {
      const text = document.getElementById('billing-input').value;
      if (!text.trim()) { setResult('请先粘贴或选择文件', 'var(--accent)'); return; }
      try { parsed = parseInput(text); renderPreview(parsed); }
      catch (e) { setResult('解析失败：' + e.message, 'var(--accent)'); parsed = null; }
    }
    function parseFile() {
      const f = document.getElementById('billing-file').files[0];
      if (!f) { setResult('请先选择文件', 'var(--accent)'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        document.getElementById('billing-input').value = reader.result;
        parseText();
      };
      reader.readAsText(f);
    }
    async function doImport() {
      if (!parsed) { setResult('请先解析数据', 'var(--accent)'); return false; }
      const plan = computePlan(parsed);
      // 去重状态不可用：不写入（fail-closed）
      if (plan.blocked === 'dedup-unavailable') {
        setResult('暂时无法读取已有记录，为避免重复导入，已暂停本次导入。请稍后重试。', 'var(--accent)');
        return false;
      }
      if (plan.newSessionCount === 0 && plan.newClientCount === 0) {
        setResult('全部已存在，无需导入', 'var(--text)'); return false;
      }
      const nameToId = plan.nameToId;
      const nextClients = Store.getClients().slice();
      const nextSessions = Store.getSessions().slice();
      const nextExpenses = Store.getExpenses().slice();
      // 1) 来访者
      parsed.clients.forEach(c => {
        const name = c.name.trim();
        if (!nameToId[name]) {
          const created = {
            id: 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
            name: c.name, status: c.status || 'active', tags: ['记账同步'],
            billing: { feePerSession: c.feePerSession || 0, billingMode: c.billingMode || 'per-session', manualSessions: c.manualSessions || 0 },
            notes: ['来源：旧版记账导入', '单价 ¥' + (c.feePerSession || 0), c.billingMode === 'monthly' ? '月结' : '次结', c.manualSessions ? '手动次数 ' + c.manualSessions : ''].filter(Boolean).join('｜'),
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
          };
          nextClients.push(created);
          nameToId[name] = created.id;
        } else {
          const ec = Store.getClient(nameToId[name]);
          if (ec && (!ec.billing || !ec.billing.feePerSession) && c.feePerSession) {
            const nextClient = nextClients.find(function (item) { return item.id === ec.id; });
            if (nextClient) Object.assign(nextClient, { billing: Object.assign({}, ec.billing, { feePerSession: c.feePerSession, billingMode: ec.billing?.billingMode || c.billingMode || 'per-session', manualSessions: ec.billing?.manualSessions || c.manualSessions || 0 }), updatedAt: new Date().toISOString() });
          }
        }
      });
      // 2) 按来访者分组，组内按日期排序后再分配节次号
      var byClient = {};
      parsed.records.forEach(function(r) {
        var n = (r.clientName || '').trim();
        if (!byClient[n]) byClient[n] = [];
        byClient[n].push(r);
      });
      var added = 0;
      var skippedElsewhere = 0;
      var skippedHere = 0;
      // 全库会谈快照：去重依据（见 allSessions 注释）。全库不可读时不写入（fail-closed）。
      var dedupPool = allSessions();
      if (dedupPool === null) {
        setResult('暂时无法读取已有记录，为避免重复导入，已暂停本次导入。请稍后重试。', 'var(--accent)');
        return false;
      }
      Object.keys(byClient).forEach(function(name) {
        var cid = nameToId[name.trim()];
        if (!cid) return;
        // 按日期升序排列
        var recs = byClient[name].sort(function(a, b) { return (a.date || '').localeCompare(b.date || ''); });
        // 获取该来访者已有的最大节次数（节次号分配仍按该来访者名下计数）
        var existingSessions = Store.getSessionsByClient(cid);
        var maxExistingNo = 0;
        existingSessions.forEach(function(s) { if (s.sessionNumber > maxExistingNo) maxExistingNo = s.sessionNumber; });
        var sessionNo = maxExistingNo + 1;
        recs.forEach(function(r) {
          // 继承 client 的 billingMode
          var clientObj = Store.getClient(cid);
          var recordMode = r.billingMode || (clientObj && clientObj.billing && clientObj.billing.billingMode) || 'per-session';
          // 关键：以全库会谈作为去重依据，而非该来访者名下的会谈。
          // 否则来访者被替换（改名/换库/重建）时，同批次记录会被整批重复写入。
          var missingKeys = missingImportSessionKeys(dedupPool, r);
          // 已存在节次去向细分：全库已存在但不在本次写入范围的节 = r.sessions - missingKeys.length。
          // 需区分「本名下已有」（扩量补录的常见情形）与「其他来访者名下已有」
          // （来访者被替换后的典型情形），提示归因才准确，避免用户误解数据去向。
          // 匹配谓词与 importedSessionCount 保持同款，保证口径一致。
          var existingTotal = r.sessions - missingKeys.length;
          if (existingTotal > 0) {
            var hereCount = 0;
            dedupPool.forEach(function (s) {
              var b = s && s.billing;
              var ik = b && b.importKey != null ? String(b.importKey) : '';
              var isBatch = (b && String(b.importBatchKey || '') === r.key) ||
                ik === r.key || ik.indexOf(r.key + '#') === 0 ||
                String(s && s.notes || '').indexOf('[billing:' + r.key + ']') >= 0;
              if (isBatch && s.clientId === cid) hereCount++;
            });
            var here = Math.min(hereCount, existingTotal);
            skippedHere += here;
            skippedElsewhere += existingTotal - here;
          }
          missingKeys.forEach(function(importKey) {
            nextSessions.push({
              id: 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
              clientId: cid, sessionNumber: sessionNo, date: r.date, durationMinutes: 0, type: 'individual',
              billing: { fee: r.feePerSession || 0, paid: !!r.paid, source: 'billing', billingMode: recordMode, importKey: importKey, importBatchKey: r.key || null },
              notes: ['来源：旧版记账导入', r.feePerSession ? '单价 ¥' + r.feePerSession : '', '方式：' + ((recordMode === 'monthly') ? '月结' : (recordMode === 'prepaid' ? '预付费' : '次结')), r.paid !== undefined ? (r.paid ? '已缴' : '未缴') : '', '[billing:' + importKey + ']'].filter(Boolean).join('｜'),
              createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
            });
            sessionNo++;
            added++;
          });
        });
      });
      var savedImport = await Store.saveBillingBatchDurable({ clients: nextClients, sessions: nextSessions, expenses: nextExpenses });
      if (!savedImport || !savedImport.ok) { setResult('导入失败：原有数据未改变，请恢复存储后重试', 'var(--accent)'); return false; }
      if (skippedElsewhere > 0 && skippedHere > 0) {
        setResult(`导入完成：新增节次 ${added}。另有 ${skippedElsewhere} 节已存在于其他来访者名下、${skippedHere} 节已在本名下存在，均未重复写入。`, 'var(--text)');
      } else if (skippedElsewhere > 0) {
        // 明确告知跳过原因，避免用户误以为数据丢失
        setResult(`导入完成：新增节次 ${added}。另有 ${skippedElsewhere} 节已存在于其他来访者名下，未重复写入。`, 'var(--text)');
      } else if (skippedHere > 0) {
        setResult(`导入完成：新增节次 ${added}，另有 ${skippedHere} 节已在本名下存在，未重复写入。`, 'var(--text)');
      } else {
        setResult(`导入完成：新增节次 ${added}，跳过 ${plan.skipCount}（已存在）`, 'var(--green, #6E7E62)');
      }
      return true;
    }
    return { parseText, parseFile, doImport, reset };
  })();
