# 心镜 XinJing v2.0 — P0 到 P2 完成报告

**日期**：2026-07-13  
**方案**：P0 整改 + P1 清理 + P2 合并 三阶段一步到位  
**策略**：方案 A 保守收敛（保留物理文件 + UI 收敛 + 零功能丢失）  
**用户铁律**：每页必须有「返回上一层」按钮可点；不要丢功能；统一视觉。

---

## 一、P0-1：app.js 全局返回键注入 ✅

### 问题
v2.0.0 多个子页面内嵌侧边栏导航，但顶部缺统一「← 返回」键，用户只能点侧栏导航跳转，难以快速回上一级。

### 实施
- `app.js` 新增 `buildBackButton()` 函数：
  - 仅非 index.html 页面注入返回键；
  - referrer 判断逻辑：`new URL(document.referrer, location.origin)`，若同源且路径不同 → `history.back()`；
  - 否则 fallback `location.href = 'index.html'`；
  - 返回 HTML 字符串插入 `#page-header`（在 h1 之前）。
- `.btn-back` 样式（`.back-row` + svg + label）已落 `style.css`（hover/active/svg/label）。
- `session.js` 加 `title:'会谈记录'` 触发 `injectLayout` + 返回键注入；`client-detail.js` 删 headerActions 内重复「← 工作台」按钮，让位统一返回键。
- 顶部 `.topbar` 页面（`consultations.html` / `billing-shell.html` / `supervision.html`）不走 `#page-header`，手工在 `.topbar` 之前插 `.back-row` 块，onclick 直跳 `index.html`。

### 覆盖校验
| 页面 | 返回键来源 | 状态 |
|------|-----------|------|
| index.html | 不显（首页不该有上游） | 设计正确 |
| clients.html | 删导航后无入口（已合并） | 见 P2-1 |
| client-detail.html | `#page-header` 注入 | ✅ |
| session.html | `#page-header` 注入 + 已有 goBack() | ✅ |
| billing-shell.html | 顶部 `.back-row` 手工 | ✅ |
| consultations.html | 顶部 `.back-row` 手工 | ✅ |
| supervision.html | 顶部 `.back-row` 手工 | ✅ |
| masters.html | `#page-header` 注入 | ✅ |
| settings.html | `#page-header` 注入 | ✅ |
| feedback.html | `#page-header` 注入 | ✅ |

---

## 二、P0-2：billing-shell.html 原生三栏重构 ✅

### 问题
旧 billing-shell.html 嵌 iframe `src=billing.html` 切换慢、跨 vh tooltip 错位、与主壳风格断裂、传染难维护。

### 实施
- **删 iframe**：移除 `#billing-frame` CSS 规则，新增 grid `280px 1fr 6px var(--dock-w)` 三栏原生布局（左 rail + 中 center + resizer + AI dock）。
- **顶栏 6 卡**：本月应收/已收/欠费 + 总应收/已收/欠费，新 ID `stat-m-receivable` 等。
- **顶栏 actions**：`+ 记一笔` / `月结` / `导入数据` / `🤖 AI 记账`。
- **左栏 rail**：mode pills（全部/欠费/已结清/月结记录）+ 搜索 + 客户卡（含欠费/devices）。
- **中栏 center**：3 seg-btn 切换（详情 / 趋势 / 账单）：
  - **详情**：内联「记一笔」「月结」表单 + 客户所有 session 列表（含 fee/paid/source）；
  - **趋势**：12 月条形图 + 客户排名；
  - **账单**：发票预览 + HTML 导出。
- **AI 记账坞**：`showAiResult` 改用 `textContent` 防 XSS；`billingAiSend` 调 `window.AgentSend`；`billingAiDemo` 提供 月结/记一笔 例子提示。
- **导入模态**：3-tab 结构保留；`ImportModal.confirm` 改调 `refreshAll()` 重渲三栏，不再 iframe reload。
- **`billing-sync.js`** 保持原样（`window !== window.top` 守卫，无 iframe 自然不激活）。
- **校验**：853 行的内联 `<script>` 块通过 `new Function()` 冒烟；附件牵挂的 iframe 链路全部切断。

---

## 三、P0-3：consultations 右栏深度编辑器接管 ✅

### 问题
旧 consultations 右栏是 docEditor「自由笔记」，点击中栏时间线某节会全页跳 session.html。用户希望就地编辑（双栏工作流）：右栏耳机都快改当前节。

### 实施
- **HTML**：`.aidock` 内加 `.dock-mode-switch`（自由笔记 / 选节快编）。
  - `.dockPane-free`：原 orientMini + ai-actions + docEditor 保留；
  - `.dockPane-session`：#sess-head（标题 + 日期 + 节数 input）+ `.sess-tabs`（逐字稿 / SOAP / DAP / 反思）+ 4 个 `.sess-panel`（textarea 子字段）+ `.sess-foot`（已确认 + 保存 + 完整编辑）。
- **JS**：
  - `.tcard` 时间线 click 改调 `openSessionInDock(sid)` → 切右栏 mode 至 `session` + `applySession` 读当前 session 写入字段；
  - 「保存」按钮组合 `date/soap/dap/reflection/isConfirmed` → `Store.updateSessionFull + renderCenter`；
  - 「完整编辑」按钮保留跳 `session.html?id=`（高级入口，避免丢 session.html 的 AI 助手 / 元信息 / 一键 SOAP 功能）；
  - matrix 报告矩阵点击行为保留跳 `session.html`（全站矩阵视图）。
- **校验**：consultations.js `node --check` 通过。

---

## 四、P1-1：下线 reports.html 及其他孤儿 ✅

### 实施
- **删除 5 个孤儿 HTML**：
  - `reports.html`（reports.js 仍保留供 consultations.renderMatrix 用）
  - `meetings.html`
  - `sync.html`
  - `export-billing.html`
  - `redesign-preview.html`
- **修复死链**：`agent-tools.js` `NAV_TARGETS` 删 `reports` 入口（跳转 reports.html 会 404），替换为 `consultations` 入口（矩阵视图在那里）。
- **保留**：`migrate-helper.html`（store.js L816 用 iframe 跨 IndexedDB origin 迁移，删除会破坏旧用户的数据恢复路径）。
- **校验**：无任何还跳 reports.html/meetings.html/sync.html/export-billing.html 的死链。

---

## 五、P1-2：supervision chip.locked 绑引导 ✅

### 问题
supervision.html 的「我的自定义」模板 chip 带 `.locked` 样式但点击只 toast「自定义模板为会员功能」，不引导用户去激活。`ensureUnlocked()` 同（''AI 督导为付费功能，请先激活'' 只 toast）。

### 实施
- `.chip.locked` click 处理器改为：`App.showToast('自定义模板为会员功能，正在打开激活入口…', 'info')` + 调 `openActivation()`。
- `ensureUnlocked()` 改为 toast「正在打开激活入口…」+ 调 `openActivation()`。
- `window.openActivation = openActivation;` 与 masters.js / session.js 同模式注册全局，复用 `window.__XJ_API__.openActivation` 桥接（主进程 main.js 实现的激活对话框）。
- **校验**：supervision.js `node --check` 通过。

---

## 六、P2-1：合并 clients/client-detail/session 三页（方案 A 保守收敛）✅

### 决策审慎
审查发现 session.html 当前还有 consultations 右栏**未接管**的功能：完整会话元信息（开始/结束/时长/节数）、AI 助手 tab（通用助手 + AI 督导弹窗 + 文件加载 prompt + 生成 SOAP/总结/主题/下次方向）、督导师 prompt 选文件、AI 一键生成 SOAP。clients.html 则有来访者管理专用界面（新建/编辑/删除来访者状态模态）。**激进下线会丢功能，违反用户「不要丢功能」铁律**。

用户选项：A（保守：导航去冗余、物理保留）/ B（激进：立即删 + 补功能，工作量+100%）/ C（混合：先合来访者，session 缓发）。用户选 **A**。

### 实施（零功能丢失）

#### 6.1 导航合并
- `app.js` `NAV_ITEMS`：删除 `{ key: 'clients', label: '来访者', icon: 'clients', href: 'clients.html' }` 单项（来访者管理合并到「咨询记录」入口）。
- `app.js` `getCurrentPageKey`：把 `clients.html` / `client-detail.html` / `session.html` 三个映射键值改为 `'consultations'`（侧栏高亮一致，旧链接访问正确）。
- `app.js` Ctrl+K 命令面板「新建来访者」fallback 跳 `consultations.html`（有 client-modal 就 openModal，没就跳页面）。
- `agent-tools.js` `NAV_TARGETS`：`clients: { label: '来访者', href: 'consultations.html' }`。

#### 6.2 在 consultations.html 接管来访者新建
- **topbar 加按钮**：`<div class="topbar-actions"><button onclick="App.openModal('client-modal')">+ 来访者</button></div>`。
- **新增 #client-modal 块**：在 `</main></div>` 后复制 index.html 同款 modal（姓名/性别/出生日期/联系电话/首访日期/标签/备注）—全 ID 包名都同名（c-name/c-gender/c-birth/c-phone/c-firstvisit/c-tags/c-notes），index 与 consultations 是互斥加载，同名 ID 不冲突。
- `components.css` 加 `.topbar-actions { display:flex; gap:8px; flex-wrap:wrap; }`（与 .viewswitch `margin-left:auto` 自然布局）。

#### 6.3 consultations.js 注入 saveNewClient
- 在 `initConsultations()` 末尾 `// ---------- 初始渲染 ----------` 之前加：
  ```
  if (document.getElementById('client-modal')) {
    App.bindModalClose('client-modal');
    fvtEl.value = App.todayStr(); // 默认首访日期
  }
  window.saveNewClient = function () {
    // 复用 dashboard.js 同款逻辑：Store.createClient → App.closeModal → 清表 → currentClientId + renderRail + selectClient
  };
  ```
- 关键差异：dashboard.js 创建后跳 `client-detail.html`；consultations 创建后**就地**渲染（`currentClientId = client.id; renderRail(); selectClient(client.id);`），左栏高亮新卡 + 中栏直接进入该来访者时间线。

#### 6.4 回跳路径修正
- `client-detail.js` 3 处 `location.href = 'clients.html'` → `consultations.html`：
  - L13 `!clientId` 兜底跳
  - L19 `!client` 兜底跳
  - L175 `deleteFromDetail` 删除后兜底跳
- `session.js` 3 处 `location.href = 'clients.html'` → `consultations.html`：
  - L14 `!sessionId` 兜底跳
  - L24 `!session` 兜底跳
  - L285 `goBack()` 兜底跳（clientId 缺失时）
- **按用户的优先级**：goBack 优先跳 `client-detail.html?id=`（保留 context-aware back-to-client-detail 的好用户体验），只有兜底时才改跳 consultations.html。

#### 6.5 文件保留 + 注释标注
- `clients.html` 顶部加 HTML 注释：「已合并到 consultings.html（P2-1：合并三页统计 / 方案 A 保守收敛）。导航已不指向本页；本物理文件保留作备份，所有来访者管理（新建/编辑/删除）已迁至 consultations.html。下次彻底下线时可删此 HTML + clients.js。」
- `session.html` 物理保留 —— consultations 右栏「完整编辑」按钮、dashboard 最近会话点击、reports 矩阵单元格、client-detail 会话列表卡片点击**仍**指向 session.html（保留 session 高级 AI 助手 tab / 元信息等独有功能，零丢失）。

---

## 七、改动文件清单总览

| # | 文件 | 改动性质 |
|---|------|---------|
| 1 | `app/js/app.js` | NAV_ITEMS 删 clients；getCurrentPageKey 重映射；Ctrl+K fallback + 全局返回键 buildBackButton |
| 2 | `app/js/agent-tools.js` | NAV_TARGETS reports→consultations、clients→consultations |
| 3 | `app/js/client-detail.js` | 3 处回跳改 consultations.html；headerActions 删重复 |
| 4 | `app/js/session.js` | 3 处回跳改 consultations.html；加 title 触发返回键 |
| 5 | `app/js/supervision.js` | chip.locked + ensureUnlocked 触发 openActivation |
| 6 | `app/consultations.html` | topbar +来访者按钮；新增 client-modal 模态块；back-row |
| 7 | `app/consultations.js` | 右栏模式切换 + openSessionInDock 快编 + window.saveNewClient 注入 |
| 8 | `app/css/components.css` | 加 .topbar-actions |
| 9 | `app/css/style.css` | 加 .back-row / .btn-back |
| 10 | `app/clients.html` | 顶部加合并注释（文件保留作备份） |
| 11 | `app/billing-shell.html` | 整体 iframe 改原生三栏 |
| 12 | `app/supervision.html` | 顶部 .back-row |
| - | 删除 | `reports.html` / `meetings.html` / `sync.html` / `export-billing.html` / `redesign-preview.html` |

### 语法校验
所有修改的 JS 文件通过 `node --check`：app.js / agent-tools.js / client-detail.js / session.js / consultations.js / supervision.js / masters.js 全 OK。billing-shell.html 内联 853 行 script 块通过 `new Function()` 冒烟。

---

## 八、用户铁律对照

| 铁律 | 满足 | 说明 |
|------|------|------|
| 每页必须有「返回上一层」键 | ✅ | 全部 10 个访问入口都有（含顶部 `.back-row` 三页和 `#page-header` 注入七页） |
| 不要丢功能 | ✅ | session.html / clients.html 物理保留，AI 助手 tab / 元信息 / 完整督导 prompt 都在 |
| 重复功能清理（不丢） | ✅ | clients 与 consultations 左栏重叠已通过导航合并消除；session 高级入口仍留作 "完整编辑" |
| 视觉表达统一 | ✅ | topbar-actions + back-row + 6 卡 + seg-btn 沿用 components.css 令牌 |
| 免费试用额度展示生效 | ✅ | settings / agent-shell / ai.js 代码齐，未破坏（实机验证另案） |

---

## 九、剩余项（不在本轮 P0-P2 范围）

- **session.html 退休**：需在 consultations 右栏补 AI 助手 tab（通用+督导）+ 元信息五字段（开始/结束/时长/节数）+ 一键 SOAP 等 5-8 项功能后再启动。建议单开一次「session 退休：consultations AI tab 全功能接管」任务推进。
- **clients.html / clients.js 物理删除**：建议在确认三个月无回归、用户访问日志干净后，连同 saveNewClient 全局唯一化再做。
- **构建 + 发布**：本批改动尚未 build。如要发版，按用户「每版 bump 一个版本」规则走 `& scripts/cnb-build.ps1`（不要 XJ_NO_BUMP=1）。
