/* ============================================================
   心镜 XinJing — 同步记账（从「心理咨询记账系统」导入）
   支持两种数据源：
   1) JSON：记账系统导出的 { clients, records } 结构（完整信息）
   2) CSV ：记账系统「📥 导出」按钮生成的表格（信息略少）
   映射规则：
   - 来访者：按姓名匹配，已存在则复用，否则新建（来源/单价/结算方式入备注，打「记账同步」标签）
   - 咨询记录：每条 record 按「次数(sessions)」拆成 N 节 session，date 相同
   - 去重：以 [billing:KEY] 标记写入 session.notes，已存在则跳过，可重复运行
  ============================================================ */

App.initPage({
  title: '同步记账',
  subtitle: '从记账系统导入来访者与咨询时间',
  onReady: initSync,
});

// ---------- 日期归一化 ----------
function normDate(s) {
  if (!s) return '';
  s = String(s).trim();
  const m = s.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return '';
}

// ---------- 入口：按扩展名/内容判断 JSON 或 CSV ----------
function parseInput(filename, text) {
  const t = text.trim();
  if (filename.toLowerCase().endsWith('.json') || t.startsWith('{') || t.startsWith('[')) {
    return parseJSONBilling(JSON.parse(t));
  }
  if (filename.toLowerCase().endsWith('.csv') || t.includes('来访者') || t.includes(',')) {
    return parseCSV(t);
  }
  throw new Error('无法识别文件类型，请选择 JSON 或 CSV');
}

// ---------- 解析记账系统 JSON ----------
function parseJSONBilling(data) {
  if (!data || !Array.isArray(data.clients) || !Array.isArray(data.records)) {
    throw new Error('未识别的 JSON：应为记账系统导出的 {clients, records} 结构');
  }
  const idToName = {};
  const clients = data.clients
    .map((c) => {
      const name = (c.name || '').trim();
      if (c.id) idToName[c.id] = name;
      return {
        name,
        feePerSession: Number(c.feePerSession) || 0,
        billingMode: c.billingMode === 'monthly' ? 'monthly' : 'per-session',
        status: c.status === 'paused' ? 'paused' : 'active',
        manualSessions: Number(c.manualSessions) || 0,
      };
    })
    .filter((c) => c.name);

  const records = data.records
    .map((r) => ({
      clientName: (r.clientId && idToName[r.clientId]) || '',
      date: normDate(r.date),
      sessions: Math.max(1, parseInt(r.sessions) || 1),
      feePerSession: Number(r.feePerSession) || 0,
      paid: !!r.paid,
      key: 'rec_' + (r.id || r.clientId + '_' + r.date + '_' + r.sessions),
    }))
    .filter((r) => r.clientName && r.date);

  return { format: 'json', clients, records };
}

// ---------- 解析记账系统 CSV ----------
function parseCSV(text) {
  const rows = parseCSVrows(text);
  if (rows.length < 2) throw new Error('CSV 内容为空或缺少数据行');
  const header = rows[0].map((h) => String(h || '').trim());
  const idx = {
    name: header.indexOf('来访者'),
    date: header.indexOf('日期'),
    sessions: header.indexOf('次数'),
    fee: header.indexOf('单价'),
    paid: header.indexOf('缴费状态'),
    mode: header.indexOf('结算方式'),
  };
  if (idx.name < 0 || idx.date < 0) {
    throw new Error('CSV 缺少「来访者」或「日期」列，请使用记账系统的导出功能');
  }
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
    const isMonthly = idx.mode >= 0 && /月结/.test(String(row[idx.mode] || ''));
    records.push({ clientName: name, date, sessions, feePerSession: fee, paid, key: 'csv_' + name + '_' + date + '_' + sessions });
    if (!clientsMap[name]) {
      clientsMap[name] = { name, feePerSession: fee, billingMode: isMonthly ? 'monthly' : 'per-session', status: 'active', manualSessions: 0 };
    }
  }
  const clients = Object.values(clientsMap);
  if (!clients.length) throw new Error('CSV 中未解析到任何来访者记录');
  return { format: 'csv', clients, records };
}

// ---------- CSV 行解析（支持引号转义与 BOM） ----------
function parseCSVrows(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// ---------- 计算导入计划（预览与执行共用） ----------
function computePlan(parsed) {
  const existingClients = Store.getClients();
  const nameToId = {};
  existingClients.forEach((c) => { nameToId[c.name.trim()] = c.id; });

  const byClient = {};
  parsed.clients.forEach((c) => {
    const name = c.name.trim();
    byClient[name] = byClient[name] || {
      newCount: 0, skipCount: 0,
      fee: c.feePerSession, billingMode: c.billingMode, status: c.status, manualSessions: c.manualSessions,
    };
  });

  parsed.records.forEach((r) => {
    const name = (r.clientName || '').trim();
    byClient[name] = byClient[name] || { newCount: 0, skipCount: 0 };
    const cid = nameToId[name];
    let already = 0;
    if (cid) {
      already = Store.getSessionsByClient(cid).filter((s) => (s.notes || '').includes('[billing:' + r.key + ']')).length;
    }
    const need = Math.max(0, r.sessions - already);
    byClient[name].newCount += need;
    byClient[name].skipCount += already;
  });

  let newClientCount = 0, newSessionCount = 0, skipCount = 0;
  Object.keys(byClient).forEach((name) => {
    if (!nameToId[name]) newClientCount++;
    newSessionCount += byClient[name].newCount;
    skipCount += byClient[name].skipCount;
  });
  return { nameToId, byClient, newClientCount, newSessionCount, skipCount };
}

// ---------- 渲染预览 ----------
function renderPreview(parsed) {
  const plan = computePlan(parsed);
  document.getElementById('previewCard').style.display = 'block';

  document.getElementById('previewSummary').innerHTML = `
    <span class="pill"><b>${plan.newClientCount}</b>新增来访者</span>
    <span class="pill"><b>${plan.newSessionCount}</b>新增节次</span>
    <span class="pill"><b>${plan.skipCount}</b>跳过(已存在)</span>
    <span class="pill"><b>${parsed.clients.length}</b>总来访者</span>
    <span class="pill"><b>${parsed.records.length}</b>总记录</span>`;

  let rows = '';
  Object.keys(plan.byClient).forEach((name) => {
    const info = plan.byClient[name];
    const isNew = !plan.nameToId[name];
    const cls = isNew ? 'new' : 'skip';
    rows += `<tr>
      <td class="${cls}">${App.escapeHtml(name)}</td>
      <td><span class="tag ${cls}">${isNew ? '新增' : '已有'}</span></td>
      <td>${info.newCount}</td>
      <td>${info.skipCount}</td>
    </tr>`;
  });
  document.getElementById('previewTableWrap').innerHTML = `
    <table class="preview-table">
      <thead><tr><th>来访者</th><th>状态</th><th>新增节次</th><th>跳过节次</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  document.getElementById('previewNote').textContent =
    plan.newSessionCount > 0
      ? '点击「确认导入」将写入以上数据。导入后可到来宾者详情页补充时长、逐字稿与各类报告。'
      : '全部记录已存在于心镜中，无需重复导入。';

  document.getElementById('importBtn').style.display =
    plan.newClientCount > 0 || plan.newSessionCount > 0 ? 'inline-block' : 'none';

  window.__xjParsed = parsed;
}

// ---------- 执行导入 ----------
async function doImport(parsed) {
  const plan = computePlan(parsed);
  const nameToId = plan.nameToId;
  const createdClients = [];
  const errors = [];

  // 1. 确保来访者存在（含计费信息：单价/结算方式/手动次数）
  parsed.clients.forEach((c) => {
    const name = c.name.trim();
    if (!nameToId[name]) {
      try {
        const created = Store.createClient({
          name: c.name,
          status: c.status || 'active',
          tags: ['记账同步'],
          billing: {
            feePerSession: c.feePerSession || 0,
            billingMode: c.billingMode || 'per-session',
            manualSessions: c.manualSessions || 0,
          },
          notes: [
            '来源：记账系统同步',
            '单价 ¥' + (c.feePerSession || 0),
            c.billingMode === 'monthly' ? '月结' : '次结',
            c.manualSessions ? '手动次数 ' + c.manualSessions : '',
          ].filter(Boolean).join('｜'),
        });
        nameToId[name] = created.id;
        createdClients.push(created);
      } catch (e) {
        // 受限模式达上限等：捕获后跳过该来访者，避免整批导入崩溃（UI-5）
        errors.push(`来访者「${name}」未导入：${e.message}`);
      }
    } else {
      // 已存在：若缺计费信息则按导入值补全（不覆盖已有单价）
      const ec = Store.getClient(nameToId[name]);
      if (ec && (!ec.billing || !ec.billing.feePerSession) && c.feePerSession) {
        Store.updateClient(ec.id, {
          billing: Object.assign({}, ec.billing, {
            feePerSession: c.feePerSession,
            billingMode: ec.billing && ec.billing.billingMode ? ec.billing.billingMode : (c.billingMode || 'per-session'),
            manualSessions: ec.billing && ec.billing.manualSessions ? ec.billing.manualSessions : (c.manualSessions || 0),
          }),
        });
      }
    }
  });

  // 2. 导入咨询节次（按记录去重）
  let added = 0;
  const sessionTasks = [];
  parsed.records.forEach((r) => {
    const name = (r.clientName || '').trim();
    const cid = nameToId[name];
    if (!cid) return;
    const existing = Store.getSessionsByClient(cid);
    const already = existing.filter((s) => (s.notes || '').includes('[billing:' + r.key + ']')).length;
    const need = Math.max(0, r.sessions - already);
    let nextNo = Store.nextSessionNumber(cid);
    for (let i = 0; i < need; i++) {
      sessionTasks.push(
        Store.createSession({
          clientId: cid,
          sessionNumber: nextNo++,
          date: r.date,
          durationMinutes: 0,
          type: 'individual',
          billing: {
            fee: r.feePerSession || 0,
            paid: !!r.paid,
          },
          notes: [
            '来源：记账系统同步',
            r.feePerSession ? '单价 ¥' + r.feePerSession : '',
            r.paid !== undefined ? (r.paid ? '已缴' : '未缴') : '',
            '[billing:' + r.key + ']',
          ].filter(Boolean).join('｜'),
        }).then(function () { added++; })
          .catch(function (e) { errors.push(`节次导入失败：${e.message}`); })
      );
    }
  });
  await Promise.all(sessionTasks);

  if (errors.length) {
    // 部分受限/失败：提示首条并标注数量，不掩盖成功部分
    App.showToast(`导入完成（${errors.length} 条受限）：${errors[0]}`, 'warning');
  } else {
    App.showToast(`导入完成：新增 ${createdClients.length} 位来访者、${added} 节咨询`, 'success');
  }
  renderPreview(parsed); // 重新计算，此时应全部为「跳过」
}

// ---------- 初始化 ----------
function initSync() {
  const fileInput = document.getElementById('fileInput');
  const parseBtn = document.getElementById('parseBtn');
  const importBtn = document.getElementById('importBtn');

  parseBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) { App.showToast('请先选择文件', 'warning'); return; }
    try {
      const text = await file.text();
      const parsed = parseInput(file.name, text);
      renderPreview(parsed);
    } catch (e) {
      console.error(e);
      App.showToast('解析失败：' + e.message, 'warning');
      document.getElementById('previewCard').style.display = 'none';
    }
  });

  importBtn.addEventListener('click', () => {
    const parsed = window.__xjParsed;
    if (!parsed) return;
    const plan = computePlan(parsed);
    App.confirmDialog(
      `确认导入？将新增 ${plan.newClientCount} 位来访者、${plan.newSessionCount} 节咨询，跳过 ${plan.skipCount} 节已存在记录。`,
      () => doImport(parsed)
    );
  });
}
