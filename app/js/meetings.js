/* ============================================================
 * 心镜 · 会议同步逻辑
 * 把腾讯会议参会记录(latest_meetings.json) 转成心镜咨询会话。
 * 每位非本人的参会者 → 匹配/新建一位来访者 → 生成一节会话(billing.source='tmeet')。
 * 会话直接写入 Store（与记账共用同一份数据）。
 * ============================================================ */
const Meetings = (() => {
  'use strict';

  // 本人标识（会议创建者/主持人），不参与匹配
  const SELF_HINTS = ['mei', '梅', 'admin', '我'];

  let parsedMeetings = []; // [{subject, start_time, end_time, participants:[{user_name,duration_min}]}]
  let rows = [];           // 渲染用：{meeting, clientName, matchedClientId, skipped}

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function isSelf(name) {
    const n = (name || '').toLowerCase();
    return SELF_HINTS.some((h) => n.includes(h.toLowerCase()));
  }

  // 在现有来访者中按姓名模糊匹配
  function matchClient(name) {
    if (!name) return null;
    const clients = Store.getClients();
    const lower = name.trim().toLowerCase();
    // 精确
    let hit = clients.find((c) => (c.name || '').toLowerCase() === lower);
    if (hit) return hit;
    // 包含
    hit = clients.find((c) => (c.name || '').toLowerCase().includes(lower) || lower.includes((c.name || '').toLowerCase()));
    return hit || null;
  }

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      document.getElementById('raw-json').value = reader.result;
      parseText();
    };
    reader.readAsText(file);
  }

  function parseText() {
    const raw = document.getElementById('raw-json').value.trim();
    if (!raw) { App.showToast('请先粘贴或选择 JSON', 'warning'); return; }
    let data;
    try { data = JSON.parse(raw); }
    catch (e) { App.showToast('JSON 解析失败', 'warning'); return; }

    // 兼容不同结构：数组 或 {meetings:[...]} 或 {data:[...]}
    let list = Array.isArray(data) ? data : (data.meetings || data.data || []);
    if (!Array.isArray(list)) { App.showToast('未找到会议数组', 'warning'); return; }

    parsedMeetings = list.filter((m) => m && (m.subject || m.topic || m.title));
    rows = [];
    parsedMeetings.forEach((m, idx) => {
      const subject = m.subject || m.topic || m.title || '(无主题)';
      const parts = m.participants || [];
      // 过滤掉本人，只保留来访者
      const visitors = parts.filter((p) => !isSelf(p.user_name) && (p.user_name || '').trim());
      if (!visitors.length) {
        rows.push({ idx, subject, start_time: m.start_time, visitors: [], skipped: true, skipReason: '无来访者参会' });
        return;
      }
      visitors.forEach((p) => {
        const matched = matchClient(p.user_name);
        rows.push({
          idx,
          subject,
          start_time: m.start_time,
          visitorName: p.user_name,
          duration: p.duration_min || 0,
          matchedClientId: matched ? matched.id : '',
          skipped: false,
        });
      });
    });
    render();
  }

  function render() {
    const box = document.getElementById('meeting-list');
    if (!rows.length) {
      box.innerHTML = '<div class="empty-detail"><p>暂无可导入的会议记录</p></div>';
      return;
    }
    const clients = Store.getClients();
    const opts = (sel) =>
      `<option value="">— 新建来访者 —</option>` +
      clients.map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${App.escapeHtml(c.name || '')}</option>`).join('');

    box.innerHTML = rows
      .map((r, i) => {
        const time = fmtDate(r.start_time);
        if (r.skipped) {
          return `<div class="meeting-row" style="opacity:.6">
            <div class="meta"><div class="subj">${App.escapeHtml(r.subject)}</div>
            <div class="time">${time} · ${App.escapeHtml(r.skipReason || '')}</div></div>
          </div>`;
        }
        return `<div class="meeting-row" data-row="${i}">
          <div class="meta">
            <div class="subj">${App.escapeHtml(r.subject)}</div>
            <div class="time">${time} · 参会者：${App.escapeHtml(r.visitorName)} · ${r.duration} 分钟</div>
          </div>
          <select onchange="Meetings.setClient(${i}, this.value)">${opts(r.matchedClientId)}</select>
        </div>`;
      })
      .join('');
  }

  function setClient(rowIdx, clientId) {
    if (rows[rowIdx]) rows[rowIdx].matchedClientId = clientId;
  }

  function importSelected() {
    const toImport = rows.filter((r) => !r.skipped);
    if (!toImport.length) { App.showToast('没有可导入的记录', 'warning'); return; }

    let created = 0, visitorsCreated = 0;
    toImport.forEach((r) => {
      let clientId = r.matchedClientId;
      if (!clientId) {
        // 新建来访者
        const c = Store.createClient({ name: r.visitorName, status: 'active', billing: {} });
        clientId = c.id;
        visitorsCreated++;
      }
      const date = (r.start_time || '').slice(0, 10);
      const client = Store.getClient(clientId);
      const fee = client && client.billing ? (client.billing.feePerSession || 0) : 0;
      Store.saveSession({
        id: 'tmt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5),
        clientId: clientId,
        date: date,
        startTime: (r.start_time || '').slice(11, 16),
        endTime: (r.start_time || '').slice(11, 16),
        durationMinutes: r.duration || 0,
        sessionNumber: Store.nextSessionNumber(clientId),
        billing: { fee: fee, paid: false, source: 'tmeet', meetingSubject: r.subject },
      });
      created++;
    });

    App.showToast(`已导入 ${created} 节会话${visitorsCreated ? `（新建 ${visitorsCreated} 位来访者）` : ''}`, 'success');
    document.getElementById('raw-json').value = '';
    rows = [];
    render();
  }

  function init() {
    const fi = document.getElementById('file-input');
    if (fi) fi.addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); });
  }

  return { init, parseText, setClient, importSelected };
})();
