# 心镜 XinJing 4.0.3 发布说明

> 发布日期：2026-07-17
> 分支：`release/3.6.3-mac`（HEAD 接续 `a3ded25` / 4.0.1）
> 版本跨度：4.0.1 → 4.0.3（跳过独立 4.0.2 发版，将预 bump 4.0.2 的改动整体并入 4.0.3）
> 自测：`scripts/self-test.js` → 通过 265 / 失败 0

---

## 一、本次核心改动

### 1. 活跃来访者上下文（跨页稳定选人）`app/js/app.js` + 8 个页面
新增 `App.setActiveClientId() / App.getActiveClientId()`（localStorage key `xj_active_client_id`）：
- 在任一临床页选择来访者后，跳转/深链/刷新均自动恢复所选来访者，不再每次从头选。
- 接入页：咨询记录 `consult-notes.js`、文档中心 `doc-center.js`、大师 `masters.js`、真人督导 `real-supervision.js`、撰写报告 `report-writing.js`、AI 督导 `supervision.js`、逐字稿 `transcript.js`、设置 `settings.js`、记账 `billing-shell.js`（深链 `clientId` 支持 `getActiveClientId()` 回退）。
- 文档中心 `doc-center.js` 改为 `App.initPage` 包裹，水合后重绘来访者下拉与文档区，消除首屏空白。

### 2. 仪表盘快捷入口拖拽整理 `app/js/dashboard.js` + `app/index.html` + `app/css/style.css`
- 新增「整理快捷方式」`#manage-quick-tools` 与「恢复默认」`#reset-quick-tools` 按钮 + 编辑提示 `#quick-tools-edit-hint`。
- `bindQuickTools()` 支持 HTML5 drag 拖拽排序，布局持久化至 `xj_quick_tools_layout_v1`，带 `isValidQuickLayout` 校验与一键 reset。
- 快捷模块加 `data-quick-key`（consult-notes/supervision/masters/billing/knowledge/calendar/transcript/report-writing/real_supervision/doc-center/settings），容器 `#quick-modules` / `#more-modules` 加 `data-quick-zone`，运行时防回归已纳入自测。

### 3. 侧栏可折叠分组 `app/js/app.js`
- `renderSidebar()` 重构：用 `currentPath = location.pathname.split('/').pop()` 比对当前页。
- 新增 `renderDisclosure(key,label,icon,entries)` 折叠组，分组为：工作区 / 临床材料（折叠）/ 督导空间（折叠）/ 专业资源 / 执业管理。
- 折叠状态持久化至 `xj_sidebar_group_<key>`，`.nav-group-toggle` 点击写入 localStorage。

### 4. 退出确认框放大 + 响应式（Issue #351）`app/confirm-close.html` + `main.js`
- 独立窗 `closeConfirmWin` 尺寸 **360×300 → 456×378**，`backgroundColor:'#f7f6f2'`。
- 样式从 `--xj-*` 改回旧 calm 令牌（`--sans/--bg/--ink/--paper-2/--hair/--accent`），引入 `css/tokens.css`。
- 主按钮 `.quit` 改为暖色实色 `#147d70`，与主 UI 统一；`body` 加 `padding:18px; overflow:auto` + `@media (max-width:420px)` 响应式，防截断。

### 5. 账单重构（Issue #352 / #353 / #354）`app/billing-shell.html`
- **#352 行内编辑**：收入明细表加 `data-field="sessionNumber"/fee` 与 `.editable-paid` 单元格，点击经 `Store.updateSessionFull` 保存，复用既有 `handleBillingEdit`/`updateBilling` 逻辑。
- **#353 按月结账单页**：`showMonthlyBill(month, clientId)` 重写（按来访者+月份汇总，调用 `billableSessionsFor`）；新增 `openMonthlyInvoicePicker(preClientId)`（选来访者+月份 modal）替代旧 `showLegacyMonthlyBill`；旧 `settleMonth`/`toggleSettleForm`/`billingToggleSettleForm` 全部改调 `openMonthlyInvoicePicker`。
- **#354 记账三入口修复**：
  - **AI 记账写库修复**（前轮 gap）：`aiBookkeep` 重写 → AI 解析 JSON → `pendingAiBilling` 暂存 → `confirmAiBilling()` 循环 `Store.createSession` 写入每节咨询（含 `billing:{fee,paid,source:'agent'}`）。旧 `aiBookkeep` 改名 `legacyAiBookkeep` 仅留兼容。
  - 补「账单数据」导入 Tab + 重写 `openImport` 判空。
  - AI dock 改浮动固定定位（`position:fixed;right:24px;bottom:24px`），`toggleAiDock` 用 `dock.dataset.open` 状态机。

### 6. 大师输入区修复 `app/masters.html` + `app/js/masters.js`
- 修复 `chat-composer` 被静态 `display:none` 隐藏的问题，渲染时 `composer.style.display='flex'`，input placeholder 修正。

### 7. 版本一致性
- `package.json` / `package-lock.json` → `4.0.3`；`version.generated.js` 由 `scripts/codegen-version.js` 构建期同步。
- `app/js/settings.js` 回退版本 `'4.0.3'`；`app/settings.html` 静态 `v4.0.3` 双处回退。

---

## 二、改动文件清单（21 个修改 + 本文档）

| 文件 | 类别 | 说明 |
|---|---|---|
| `app/js/app.js` | 核心 | 活跃来访者上下文 + 侧栏折叠组重构 |
| `app/js/dashboard.js` | 功能 | 快捷入口拖拽整理 + 持久化 |
| `app/index.html` | 结构 | 快捷入口整理/恢复按钮 + data-quick-key |
| `app/css/style.css` | 样式 | 快捷入口相关样式 |
| `app/confirm-close.html` | 修复 | 退出框放大 + 响应式 + calm 令牌 |
| `main.js` | 修复 | closeConfirmWin 456×378 |
| `app/billing-shell.html` | 功能/修复 | 行内编辑 + 月结账单页 + AI记账写库 + 三入口 |
| `app/js/consult-notes.js` | 上下文 | 接入 setActiveClientId |
| `app/js/doc-center.js` | 上下文 | App.initPage 包裹 + 上下文恢复 |
| `app/js/masters.js` | 修复 | 输入区显示 + 上下文 |
| `app/js/real-supervision.js` | 上下文 | 接入 setActiveClientId |
| `app/js/report-writing.js` | 上下文 | 接入 setActiveClientId |
| `app/js/supervision.js` | 上下文 | 接入 setActiveClientId |
| `app/js/transcript.js` | 上下文 | 接入 setActiveClientId |
| `app/js/settings.js` | 版本 | 回退版本 4.0.3 |
| `app/masters.html` | 修复 | 输入区静态显示 |
| `app/settings.html` | 版本 | 静态 v4.0.3 回退 |
| `app/css/masters-clinical.css` | 样式 | 小改 |
| `scripts/self-test.js` | 自测 | 新增 v4.0.3-1 / v4.0.3-2 断言 |
| `package.json` | 版本 | 4.0.3 |
| `package-lock.json` | 版本 | 4.0.3 |

---

## 三、发布验证

- **语法**：11 个 modified JS 文件 `node --check` 全部通过。
- **自测**：`scripts/self-test.js` → 通过 265 / 失败 0（含 `v4.0.3-1` 文档中心/大师输入框/快捷入口运行时防回归、`v4.0.3-2` 版本与预览基准一致）。
- **依赖核查**：`billAddDays`(882)、`Store.nextSessionNumber`(456 导出)、`billableSessionsFor`(529)、`App.todayStr`(648 导出) 均存在；`showLegacyMonthlyBill` / `legacyAiBookkeep` 仅为重命名保留，无悬空调用。
- **构建**：`XJ_NO_BUMP=1` 跑 `scripts/cnb-build.ps1`（锁版 4.0.3）。
- **上线**：验证 COS `latest.yml` / `latest-portable.yml` 版本 = 4.0.3 且资产 HTTP 200。
- **Mac**：`git tag -a v4.0.3` + 用 `~/.ssh/id_ed25519_xinjing` 推 `release/3.6.3-mac` 分支与 tag 触发 `build-mac.yml`。

---

## 四、Issue 闭环确认

| Issue | 内容 | 状态 |
|---|---|---|
| #351 | 退出确认框窗高 + 暖色实色主按钮 + 响应式 | ✅ 已修（4.0.3） |
| #352 | 账单节次/费用/已收行内可编辑 | ✅ 已修（4.0.3） |
| #353 | 月结生成精美月度账单页 | ✅ 已修（4.0.3） |
| #354 | 记账三入口修复（含 AI 记账写库） | ✅ 已修（4.0.3） |

---

## 五、已知遗留

- 用户级偏好/跨项目习惯维持现状，无新增。
- Mac 首次安装仍需手动绕过 Gatekeeper（用户决策：不买 Apple Developer），更新包由 app 自下载通常无需再绕过。
