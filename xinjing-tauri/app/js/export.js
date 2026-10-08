/* ============================================================
   心镜 XinJing — 导出模块
   职责：
   - 单节会话导出为 Markdown
   - 批量勾选节次打包导出
   - 全量备份（在 store.js 中已实现 exportAll）
   ============================================================ */

const Export = (() => {
  'use strict';

  function buildSingleSessionMarkdown(session) {
    const client = Store.getClient(session.clientId);
    const name = client ? client.name : '未知来访者';
    let md = `# ${name} · 第 ${session.sessionNumber} 节\n\n`;
    md += `> 日期：${session.date || '未记录'}　时间：${session.startTime || ''}-${session.endTime || ''}　时长：${session.durationMinutes || 0} 分钟\n\n`;
    md += `---\n\n`;

    if (session.transcript && session.transcript.trim()) {
      md += `## 逐字稿\n\n${session.transcript}\n\n---\n\n`;
    }
    if (session.soap && (session.soap.subjective || session.soap.objective || session.soap.assessment || session.soap.plan)) {
      md += `## SOAP 个案报告\n\n`;
      md += `**S (主观)**：\n\n${session.soap.subjective || '（未填写）'}\n\n`;
      md += `**O (客观)**：\n\n${session.soap.objective || '（未填写）'}\n\n`;
      md += `**A (评估)**：\n\n${session.soap.assessment || '（未填写）'}\n\n`;
      md += `**P (计划)**：\n\n${session.soap.plan || '（未填写）'}\n\n---\n\n`;
    }
    if (session.dap && (session.dap.data || session.dap.assessment || session.dap.plan)) {
      md += `## DAP 临床报告\n\n`;
      md += `**D (资料)**：\n\n${session.dap.data || '（未填写）'}\n\n`;
      md += `**A (评估)**：\n\n${session.dap.assessment || '（未填写）'}\n\n`;
      md += `**P (计划)**：\n\n${session.dap.plan || '（未填写）'}\n\n---\n\n`;
    }
    if (session.reflection && session.reflection.trim()) {
      md += `## 咨询师反思记录\n\n${session.reflection}\n\n---\n\n`;
    }
    if (session.summary && session.summary.trim()) {
      md += `## AI 会话总结\n\n${session.summary}\n\n---\n\n`;
    }
    md += `\n> 由心镜 XinJing 导出 · ${new Date().toLocaleString('zh-CN')}\n`;
    return md;
  }

  async function buildBatchMarkdown(sessionIds) {
    let md = `# 心镜 · 个案报告打包导出\n\n`;
    md += `> 导出时间：${new Date().toLocaleString('zh-CN')}　共 ${sessionIds.length} 节\n\n---\n\n`;

    for (const sid of sessionIds) {
      const session = await Store.getSessionFull(sid);
      if (!session) continue;
      md += buildSingleSessionMarkdown(session);
      md += `\n\n`;
    }
    return md;
  }

  async function exportBatch(sessionIds) {
    const md = await buildBatchMarkdown(sessionIds);
    const dateStr = App.formatDate(new Date(), true).replace(/-/g, '');
    App.downloadFile(`心镜报告_${dateStr}.md`, md, 'text/markdown');
  }

  return {
    buildSingleSessionMarkdown,
    buildBatchMarkdown,
    exportBatch,
  };
})();

if (typeof window !== 'undefined') {
  window.Export = Export;
}
