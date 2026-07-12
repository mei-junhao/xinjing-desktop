# 心镜 v2.0 · UI 重构 — 技术方案（一步到位至 P4）

> 版本策略：v2.0 为重大 UI 重构 → 适用「跳号」例外。发布时把 `package.json` 设为 `2.0.0`，构建用 `XJ_NO_BUMP=1` 锁定官方版本号（合规，非日常禁用的情形）。
> 流程：本方案 → 独立代码评审 ≥95 → 实施 → 自测 → 发包（COS 上传 + 本地 git；GitHub 按 cadence 另行处理）。
> 决策基线：`XinJing-v2.0-UI重构-理解确认.md`（用户已内联拍板：策略 A / #1a / #2 手动+内置可跑 / #6 可拖动左下 / #7 侧边栏底部 / 三个小任务折叠 / 一步到位到 P4）。

---

## 一、目标与范围

采用 `心镜-记账v4-全联动演示.html` + 三个预览 HTML（`supervision-ai-redesign.html` / `consultation-record-redesign.html` / `billing-redesign.html`）的设计语言重做 XinJing，**保留真实架构与全部功能**（Electron 多页 + IndexedDB）。

> **与两份改造计划的边界（重要）**：`XinJing-咨询记录主工作区设计.md` 主张「吞并 clients/session/reports 并删源码」、`XinJing-记账界面改造计划.md` 主张「去 iframe 内联 billing.html」——**本方案均不采纳**。本方案仅借用二者的设计语言（三栏 workspace / rail / dock / 组件类），严格遵循用户已拍板决策：#1a 保留独立详情页、#4 咨询记录仅作「选择器+时间线+链接 session」、billing 85KB 原样保留（iframe 维持）。页面合并 / 去 iframe 留作后续独立版本。

**一步到位覆盖**：P0 设计系统统一 + 导航 + 首页(#5) / P1 来访者换肤(#1) + 咨询记录页(#4) / P2 记账换肤(#3) / P3 成长轨迹(#2) / P4 呼吸球(#6)+暗色入口(#7)+极简收尾(#8) + 三个小任务折叠。

**铁律保证**：
- 每页仅改 DOM 结构 + 类名 + 样式，IndexedDB 数据层（`store.js`）、各页 JS 业务逻辑**原样保留或等价迁移**，不回退到 localStorage。
- 账单导出/月结/粘贴参会/批量日历/单价编辑（billing.html 真实逻辑）**全部保留**。
- 不删用户数据；不删源码文件（去重仅从导航/侧边栏移除入口，文件保留作 fallback）。

---

## 二、架构决策

- **策略 A**：保留多页，逐页换肤 + 局部功能新增。复用现有侧边栏 + 多页骨架。
- **统一设计系统**：新增 `app/css/components.css`，抽取三个预览 HTML 共用的组件类（`.topbar/.rail/.ccard/.client-head/.timeline/.matrix/.card/.actions/.seg/.aidock/.resizer/.orient/.chip/.pill/.badge/.tag/.stats/.subtabs/.editor/.soap-grid/.modal` 等），全部引用 `tokens.css` 令牌名，确保**视觉表达统一**。
- **令牌补别名**：在 `tokens.css` 的 calm 浅/暗（及 editorial）兼容层追加少量别名，使同一套 component CSS 在所有皮肤生效：`--text-secondary/--text-muted/--border-strong/--success/--warning/--danger/--radius-lg/--shadow-md/--font-serif/--font-sans/--dock-w`（`--bg/--bg-elevated/--bg-sunken/--accent/--accent-soft/--accent-hover/--accent-2/--bg-glass/--blur/--radius/--shadow-sm/--shadow-lg/--border` 已存在）。**`--dock-w:380px` 为必需**（三预览 `.ws` 用 `grid-template-columns:… var(--dock-w)`，拖动 JS 写 `root.style.setProperty('--dock-w',…)`；不声明则右栏网格列失效、布局崩）。
- **预览→components.css 类映射（统一视觉单一来源）**：下列原子类进 `components.css`，全部引用令牌名（不粘贴预览 `:root`）：`.topbar/.brand/.rail/.search/.status-pills/.pill/.clist/.ccard/.client-head/.badge/.tags/.tag/.stats/.stat/.quick/.subtabs/.st/.subpanel/.timeline/.tnode/.tcard/.flag/.matrix/.cards/.card/.actions/.seg/.seg-btn/.chart-area/.bar/.rank-row/.aidock/.dock-head/.dock-body/.ai-actions/.ai-input/.dock-actions/.orient/.chip/.floating-tb/.editor/.word/blockquote/.soap-grid/.soap-block/.save-bar/.modal-overlay/.modal/.itabs/.ipane/.hint/.empty/.viewswitch/.resizer`。**页面专有布局**（`.ws/.ep-head/.ed-tabs/.ed-body/.editor-pane/.invoice/.formline/.inline-form/.doc-note/.dock-toggle`）留在各页自身 CSS，但同样只用令牌名。
- **#8 极简**：收敛圆角/阴影——组件统一用令牌半径（calm 已为 10/8/6，平整克制），去掉「大圆角卡片堆叠 + bezel 阴影」观感，改用 1px 下边框分隔的 `.row` 风格（预览稿方向）。

---

## 三、逐条实现映射（对照确认文档 §三）

### #5 首页取代工作台（重做 `index.html` + `dashboard.js`）
- 顶部 4 统计条（本月应收/已收/待收来访者/活跃来访者）v1.4.0 已落地 → 保留，套 `.cards/.card` 组件。
- 「今日咨询」卡片：**去掉「开始咨询」按钮**。
- 「最近会谈」：复用现有 `recent-sessions` 渲染（保留）。
- 「快捷操作」改为三按钮：**AI 督导**(`supervision.html`) / **大师对话**(`masters.html`) / **检查更新**（直接调用 `window.__XJ_API__.checkForUpdates()`——`preload.js` 已暴露 `ipcRenderer.invoke('xj:check-updates')`，`dashboard.js:136` 已有调用先例；有新版主进程弹下载框，无则 toast「已是最新」，无需新增 IPC）。

### #1 来访者页换肤（#1a 保持独立详情页）（`clients.html`+`clients.js` / `client-detail.html`+`client-detail.js`）
- `clients.html` 列表换肤为 `.rail`(搜索+状态 pills: 全部/咨询中/暂停/已结束) + `.clist/.ccard`（状态圆点 + 姓名 + 末次 + 节数 + 欠费）。点击 → 跳 `client-detail.html`（保留独立页，零遮挡风险）。
- 视觉对齐**三预览 HTML 的 `.rail/.ccard` 体系**（非原始 demo 的 `.row/.avatar/.client-stats`）。
- `client-detail.html` 换肤为 `.client-head`(姓名/徽章/标签/统计) + 现有「会话记录」「督导记录」两栏（保留） + 新增「成长轨迹」区块（见 #2）。

### #2 详情页成长轨迹（AI）（`client-detail.html`+`client-detail.js`）
- 位置：详情页现「督导记录」之后新增「成长轨迹」分区。
- 数据：聚合该来访者 `sessions` + `supervisions` → 调 `AI.send` → 结构化「成长轨迹」（阶段里程碑 + 关键主题变化 + 风险/资源）。
- `analyzeGrowthTrajectory(clientId)`：结果存 `client.growthTrajectory = { generatedAt, model, summary, milestones[] }`，经 `Store.updateClient(clientId, { growthTrajectory })` 落库（IndexedDB 可重算，再次生成覆盖旧值）。
- 触发：「生成/刷新成长轨迹」按钮（需 API；内置模型也可跑，质量较低，按钮旁标注当前档位 `AI.getTier()`）。失败如实告知。
- **档位透明**：复用 v1.4.1 `AI.getTier()`，提示「高性能模型生成」或「内置模型生成（较简略）」。

### #4 新增咨询记录页（放在来访者上方）（`consultations.html` 重写桩 + 新增 `consultations.js`）
- 导航顺序：已在「来访者」之前（确认 `app.js` NAV_ITEMS 现状 `consultations` 在 `clients` 前，保持）。
- 页面：**去演示稿计时器**。左 `.rail`(来访者选择器：搜索 + 新建，复用现有新建表单布局) + 中 `.center`(选中来访者后的「咨询历史」时间线，每条显示「第 N 次咨询」取 sessions 的 `sessionNumber`) + 点击某条 → 跳 `session.html?id=...`（链接到 XinJing 会话记录，保留 session.html 功能）。
- 顶部视图切换：`工作区` | `全站报告矩阵`（见下「去重」）。「全站报告矩阵」视图**复用 `reports.js` 的矩阵渲染**（抽取对外函数 `Reports.renderMatrix(container, { onClickSession })`，不重实现）；点击单元格 → `session.html?id=...`。
- 粘贴参会/批量日历：复用 billing/client 现有入口（不重复实现）。

### #3 记账页换肤（账单功能全保留）（`billing-shell.html` + `billing.html`）
- `billing-shell.html` 换肤为预览稿：顶栏 `.cards`(本月应收/已收/欠费·总应收/已收/余额) + `.actions`(记一笔/月结/导入/AI 记账) + 三栏(左客户列表/中明细/右 AI 记账坞)。
- **`billing.html`（85KB 真实逻辑）原样保留**：若 `billing-shell` 以 iframe 载入，则给 `billing.html` 头部加 `tokens.css`+`components.css` 链接使其继承 calm 视觉（逻辑零改动）；若已内联则不破坏。
- AI 记账坞：自然语言输入 → 复用 Agent 的 `billing.add_record` / `billing.monthly_settle`（与现有 Agent 工具落库路径一致）。坞可拖拽调宽（260–560px）。
- 导入 modal（旧版记账/腾讯会议/手动 JSON）逻辑（`billing-sync.js`）保留，仅重皮肤。
- **载入方针（锁定二选一）**：`billing-shell.html` **维持 iframe 载入 `billing.html`**（不改为内联，避免迁移 85KB 高风险）；仅对 `billing-shell` 自身的顶部 chrome（`.cards/.actions` 统计卡 + 操作按钮）套 `components.css` 换肤，并给 `billing.html` 头部加 `tokens.css`+`components.css` 链接以继承暗色变量。AI 记账坞作为 billing-shell 右栏新增（collapsible），调用 Agent 的 `billing.add_record`/`monthly_settle`，属增量、不触碰 billing.html 逻辑。

### 附：AI 督导界面改造（对齐 `supervision-ai-redesign.html`）
- 顶部：取向**分段控件** + 模板 chip 行（替换原 `spv-switch` 三按钮）。
- 中部左右分栏：左=**Word 式大编辑区**（`contenteditable` + 选区浮动格式工具栏：粗体/斜体/标题/列表/引用，输入即留存本地草稿）；右=**常驻可收起 AI 坞**。
- AI 坞动作（结果插入文档光标处，非独立卡）：生成整体印象 / 就选区深化 / 总结选区 / 润色选区 / 开启大师对话（桥 `masters.html`）/ 整理真人督导录音稿（realsup 内联展开）。
- 多取向模板表：扩展 `supervisors.js`（winnicott/psychoanalysis/cbt/rogers/yalom/generic + 会员自定义）；`SupervisionCore.runRound` 后把回复插入光标。
- 通用 AI 督导界面**无日期字段**；仅「手工记录」模态保留日期。
- AI 坞左缘拖拽调宽（260–560px），布局不破。
- **逻辑保全**：`SupervisionCore`（runImpression/runRound/saveSupervision/runRealSupParse）与 `supervisors.js` 保留，仅改 DOM 绑定与插入逻辑；会员自定义模板走 `App.aiUnlocked()` 门控。

### #6 Agent Siri 呼吸球 + 可拖动 + 全屏/小屏（`agent-shell.js` + `agent.css` + `app.js`）
- 移除 `app.js` 的 `ensureAgentFab` 静态 spark 按钮；FAB 改由 `agent-shell.js` 渲染为**呼吸光晕球**（CSS `@keyframes` 缩放/透明度脉动）。
- 交互：指针拖动改位置（mousedown→move→up），位置持久化到 `localStorage`（默认落点左下角，用户可拖到任意位置）。
- 点击展开对话面板；面板支持「小屏」(右下角悬浮卡) 与「全屏」(覆盖主区) 切换按钮。

### #7 暗色入口（侧边栏底部，全局）（`app.js` + `tokens.css` 已有暗色）
- `renderSidebar` 底部 `nav-footer` 区加暗色切换（☀/🌙），toggle `document.documentElement.classList.toggle('dark')` 并持久化 `localStorage.xj_theme`。
- 复用现有 `bootstrapTheme` 引导（无闪烁）；所有页经 `tokens.css` 暗色派生即时生效。

### #8 极简收尾（全局令牌/`style.css`/`components.css`）
- 统一收敛圆角与阴影（见 §二）。预览稿 `.row` 用 1px 下边框分隔而非卡片堆叠，作为极简方向。
- 全局令牌改动影响所有页，故在首期（设计系统）做，避免逐页返工。

---

## 四、三个小任务（折叠进 v2.0 设置/API 区换肤）

1. **「有」路径接进 Agent 对话**：设置 API 抽屉的「已有 Key」流程，验证成功后引导用户试用 Agent 对话（按钮/提示）。
2. **抽屉加友好中文错误**：`settings.js` API 配置状态机增加中文错误文案（网络错误/Key 无效/超时等）。
3. **验证真实 DeepSeek key 端到端**：接入 `AI.testConnection`（v1.4.1 已存在），由用户后续提供测试 key 后实跑；代码先就绪，缺 key 时显示引导。

---

## 五、去重决策（「重复就去掉」）

| 原页面/功能 | 处理 | 功能保全 |
|---|---|---|
| `reports.html`（只读报告矩阵） | 从侧边栏导航移除（不再独立入口）；能力**折叠进** `consultations.html` 的「全站报告矩阵」视图（跨来访者矩阵 + 点击单元格跳 `session.html`）。文件保留作 fallback，**不删除**。 | 矩阵能力不丢 |
| `clients.html` / `session.html` / `client-detail.html` | **保留**（用户 #1a 要独立详情页、#4 要链接 session）。不吞并。 | 全部保留 |
| `billing.html`（85KB） | **保留**真实逻辑（iframe 载入，用户评价非常好用）。内部 85KB CSS 维持其成熟体系，**不整体重写**（高风险且非用户要求）；仅确保头部已链接 `tokens.css`+`components.css` 以继承暗色变量，并保留其已有的 `xj_theme` 自同步（已实装 `billing.html:407-417`）。 | 全部保留 |
| `reports.js` | **改造为矩阵渲染器**：保留文件，抽取对外函数 `Reports.renderMatrix(container, {onClickSession})` 供 `consultations.js` 复用；不重实现矩阵逻辑。 | 能力保留 |
| 首页「开始咨询」按钮 | **移除**（确认文档 #5 要求去）。 | 无害 |

> 删除源码文件需安全码 `82965622`，本次不去重删除任何文件，仅从导航移除入口。

---

## 六、导航与全局改动（`app.js`）
- `NAV_ITEMS`：移除 `reports` 项（能力已折叠）；其余顺序保持（首页→咨询记录→来访者→督导→记账→大师对话→设置→意见建议）。
- `renderSidebar`：底部加暗色切换按钮（#7）。
- `CMD_COMMANDS`：修正 `billing.html`→`billing-shell.html`、`reports.html`→`consultations.html`（命令面板/快捷键不指向已下架入口）。
- `ensureAgentFab`：移除（FAB 改由 agent-shell.js 渲染呼吸球）。

---

## 七、风险与缓解

| 风险 | 缓解 |
|---|---|
| 预览 HTML 的 `:root` 硬编码会覆盖 tokens | component CSS 只用令牌名，不粘贴预览 `:root` |
| billing 85KB 逻辑迁移破损 | 不迁移逻辑，仅加样式链接 + reskin shell |
| supervision 改为 Word 编辑区 + 坞，旧 `supervision.js` 逻辑丢 | 保留 `SupervisionCore`/`Supervisors`，仅改 DOM 绑定与插入逻辑；多取向模板表新增 |
| 成长轨迹内置模型质量低 | 按钮标注档位，失败如实告知；结果可重算覆盖 |
| 呼吸球拖动与面板定位冲突 | 拖动仅改 FAB 位置；面板独立 fixed 容器 |
| 暗色切换个别页硬编码色 | 全局令牌化；逐页排查残留硬编码（style.css 已收敛） |
| 去重后用户找不到报告 | consultations 页顶部「全站报告矩阵」视图 + 导航 tooltip 提示 |
| billing iframe 暗色隔离 / 跨文档依赖 | billing.html 已自同步 `localStorage.xj_theme`（billing.html:407-417），暗色随全局切换；iframe 与父页同源共享 localStorage，无需 postMessage。billing.html 内部 85KB CSS 维持原体系（已验证成熟好用），仅补 `tokens.css`+`components.css` 链接继承暗色变量；不做跨文档 DOM 依赖改造（billing-shell 经 `window.parent.App` 调用已在用，保留）。 |
| 预览 `:root` 覆盖 tokens | component CSS 只用令牌名，严禁在页面粘贴预览稿的 `:root` 块 |

---

## 八、验收标准（逐条）
- [ ] 首页 4 统计条保留、无「开始咨询」、快捷操作 3 按钮（AI 督导/大师对话/检查更新）生效。
- [ ] 来访者列表 + 详情换肤为 rail/ccard 风格，独立详情页无遮挡。
- [ ] 详情页「成长轨迹」按钮可生成并存入 IndexedDB，标注当前档位，可刷新重算。
- [ ] 咨询记录页（来访者上方）显示时间线，点节点跳 session.html；「全站报告矩阵」视图可用。
- [ ] 记账页视觉统一，账单/月结/导入/粘贴参会/批量日历/单价编辑功能不变。
- [ ] Agent 为呼吸球、可拖动（默认左下）、可全屏/小屏切换。
- [ ] 侧边栏底部暗色切换全局生效并持久化。
- [ ] 圆角/阴影收敛，视觉表达统一（components.css 单一来源）。
- [ ] 设置 API 抽屉友好错误 + 「有 Key」引导 Agent 对话；testConnection 就绪。
- [ ] reports 从导航移除但矩阵能力在 consultations 保留；无源码文件被删除。

---

## 九、改动文件清单
**新增**：`app/css/components.css`、`app/consultations.js`
**重写/改造**：`app/consultations.html`(桩→完整)、`app/index.html`+`dashboard.js`、`app/clients.html`+`clients.js`、`app/client-detail.html`+`client-detail.js`、`app/billing-shell.html`、`app/supervision.html`+`supervision.js`、`app/agent.css`、`app/js/agent-shell.js`、`app/js/app.js`、`app/js/settings.js`(API 抽屉)、`app/css/tokens.css`(别名)
**保留/改造**：`app/billing.html`(仅加样式链接，逻辑不动)、`app/session.html`+`session.js`、`app/js/store.js`、`app/js/supervision-core.js`、`app/js/supervisors.js`(扩多取向)、`app/reports.html`(保留 fallback)、`app/js/reports.js`(**改造为矩阵渲染器** `Reports.renderMatrix`，供 consultations 复用)
**发布**：`package.json`→`2.0.0`；`cnb-build.ps1` 用 `XJ_NO_BUMP=1`；COS 上传；本地 git commit。

---

## 十、发布步骤
1. `package.json` version → `2.0.0`。
2. `& scripts/cnb-build.ps1` 前设 `XJ_NO_BUMP=1`（锁定 2.0.0，不 bump）。
3. 构建产出 setup/portable + yml → 自动上传 COS（`postbuild.js` 中文名重命名 + latest-portable.yml）。
4. 本地 `git commit`（不自动 push；GitHub 按 cadence/用户指令）。
5. 桌面端 autoUpdater 拉 `latest.yml` 指向 2.0.0。
