# 心镜 XinJing 4.1.1 发布说明

> 发布日期：2026-07-17
> 分支：`release/3.6.3-mac`（HEAD 接续 `147025f` / 4.1.0）
> 版本跨度：4.1.0 → 4.1.1（patch bump：临床上下文安全增强 + 记账模块重写 + 数据溯源）
> 自测：`scripts/self-test.js` → 通过 271 / 失败 0（含新增 v4.1.1-1/2/3）

---

## 一、4.1.1 的定位

4.1.1 是一批已在工作树验证的补丁（"大量补丁"）的正式发布版，聚焦三件事：

1. **临床上下文统一构造与出处溯源**——五个 AI 入口（逐字稿 AI 检测 / 报告 AI 填写 / AI 督导 / 真人督导 AI 整理 / 督导记录 AI 分析）改为统一经 `ClinicalContext` 构造受控上下文，发送前显式确认来源，并基于 SHA-256 快照在「切换来访者 / 材料更新 / 输入变更 / 会谈版本变化」后**拒绝采用旧结果**（防止跨来访者串档）。
2. **记账模块重写**——`billing-shell.html`（约 770 行重写）与 `billing-calendar.js`（约 +473 行）重构月结单与统计卡；账务隔离双口径（`billableSessionsFor` / `billableSessions` 基于 `isBillableSession`）保持不变。
3. **数据可撤销与备份健壮性**——新增 `undoBatch`（按 batchId 撤销 AI 批量记账的会谈与支出）、`reconcileMaterialContext`（替换 `linkMaterialWorkspace`，切换来访者需确认）、备份导入导出同步 `masterConversations` / `expenses` / `clinicalActionRuns`。

---

## 二、核心改动

### 1. 临床上下文（新模块 `app/js/clinical-context.js` + `app/js/clinical-context-view.js`）
- 纯数据构造，不碰 DOM、不直接调 AI。
- 自实现 **标准 SHA-256**（自测 `v4.1.1-1` 以 `abc` 的已知向量 + 中文/emoji UTF-8 对齐 Node crypto 验证正确）。
- `build(task, selection, options)`：校验 client/session/material/supervision 一致性，按受控长度截断（来访者 1200 字、单会谈 1800 字、材料 12000 字、督导 8000 字、资料库概览 1200 字），绝不复制绝对路径。
- `isSnapshotCurrent(snapshot, inputText, selection)`：比对输入摘要、选择、材料/督导 `updatedAt`、会谈版本，任一变化即失效。
- `ClinicalContextView.renderSummary` / `confirmSend`：渲染来源摘要 + 发送前确认弹窗。
- 五个 AI 入口均改为：构造上下文 → 渲染摘要 → 确认发送 → 建 `clinicalActionRun` → AI 返回后校验快照 → 完成/失败/过期回写。

### 2. 临床动作溯源（`Store.clinicalActionRuns`）
- 仅存受控 ID、任务类型、来源清单（kind/id/label/chars/truncated）、快照（clientId/sessionId/materialId/selectedSessionIds/sessionVersions/inputDigest）、输出引用。
- `normalizeClinicalActionRun` 严格过滤非法来源；`isValidClinicalActionRun` 校验实体归属一致性。
- 成功动作回写材料的反向追溯 ID（`transcriptActionRunId` / `reportActionRunId` / `supervisionActionRunId` / `realSupervisionActionRunId`）。

### 3. 记账重写
- `billing-shell.html`：6 统计卡（本月应收/已收、累计应收/已收、本月支出、欠费），聚合始终基于 `billableSessions*` 隔离集合。
- `billing-calendar.js`：月历 + 月结单 UI 动态渲染（来访者选择、月份、结算模式标签、打印/存 PDF、结算、手动覆盖金额）。
- `Store.undoBatch(batchId)`：按 batchId 批量撤销 AI 记账产生的会谈与支出。

### 4. 数据层与备份
- `reconcileMaterialContext`：材料来访者切换需 `confirmClientChange`，否则返回 null，避免静默误关联。
- 备份导入导出新增 `masterConversations` / `expenses` / `clinicalActionRuns` 同步。

---

## 三、改动文件清单

| 文件 | 类别 | 说明 |
|---|---|---|
| `app/js/clinical-context.js` | 新功能 | 临床上下文统一构造 + SHA-256 快照 |
| `app/js/clinical-context-view.js` | 新功能 | 来源摘要渲染 + 发送前确认 |
| `app/index.html` | 引入 | 加载 clinical-context 两脚本 |
| `real-supervision-ai.html` `real-supervision.html` `report-writing.html` `supervision.html` `transcript.html` | 引入 | 加载 clinical-context 两脚本（顺序：store→clinical-context→view→…） |
| `app/js/store.js` | 数据层 | clinicalActionRuns / undoBatch / reconcileMaterialContext / 备份同步 |
| `app/js/transcript.js` `report-writing.js` `supervision.js` `real-supervision.js` | 集成 | 五入口接入 ClinicalContext |
| `app/billing-shell.html` | 重写 | 统计卡 + 月结（账务隔离不变） |
| `app/billing-calendar.html` `app/js/billing-calendar.js` | 重写 | 月历 + 月结单 UI |
| `scripts/self-test.js` | 自测 | 新增 v4.1.1-1/2/3 |
| `package.json` | 版本 | 4.1.0 → 4.1.1 |

---

## 四、发版闸门核对

- ✅ `node scripts/self-test.js` → 271/0
- ✅ 全量 `app/*.html` body≥1 && script≥1（22 页，无残桩）
- ✅ 改动 JS `node --check` 全过
- ✅ 账务隔离双口径 `billableSessionsFor` / `billableSessions` 仍存在且基于 `isBillableSession`
- ✅ 卡住的 Mac 验证跑 `29632803923` 已取消（防 latest-mac.yml 回退到 4.1.0）
- ✅ 独立对抗评审：见评审结论（COS 上传前确认无 P0/P1）
