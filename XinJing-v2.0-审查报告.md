# 心镜 v2.0 真代码全面审查报告

> **审查时间**：2026-07-13 07:48（用户回贴 v2.0 设计方案 + 3 个预览 HTML + 4 份改造计划后）
> **审查范围**：`D:\xinjing-electron\app\` 下全部 HTML / JS / CSS 真代码 vs 设计文档/预览
> **总体结论**：v2.0 已发版（2.0.0 已在 COS），骨架方向 A（多页逐页换肤）走通，但有 7 类差距需补齐，「一步到位 P4 架构」尚未达成

---

## 一、当前页面清单与导航

| 页面 | 导航项 | 现状 | 返回上层键 |
|------|--------|------|-----------|
| `index.html` | 首页 | ✅ 4 张统计卡 + 快捷操作 + 最近会谈/报告 | ❌ 无 |
| `consultations.html` | 咨询记录 | ✅ 三栏（rail+center+aidock），左栏 client 卡片 / 中栏时间线+矩阵 tab / 右栏 AI 坞 + 文档编辑器 | ❌ 无 |
| `clients.html` | 来访者 | ✅ 列表页，仅有 rail，无中栏工作区 | ❌ 无 |
| `client-detail.html` | 来访者（侧栏 `clients`） | ✅ 基本信息卡 + 会话/督导 + 成长轨迹 | ✅ 有「← 工作台」按钮（client-detail.js dynamic 注入）|
| `session.html` | （侧栏 `clients`，通过 URL 跳转）| ✅ 单会话编辑：逐字稿/SOAP/DAP/反思/督导 tab，保存 | ✅ 有「返回」按钮（`goBack()`）|
| `supervision.html` | 督导 | ✅ AI 督导三栏（顶取向/模板行 + 中大编辑区 + 右 AI 坞 + 真人督导连入 + 浮动工具栏 + 拖拽 + 收起坞按钮 + 手工记录模态保留日期） | ❌ 无 |
| `billing-shell.html` | 记账 | ⚠️ **仍是 iframe 挂载 85KB billing.html**。外壳有 topbar + 统计卡 + AI 记账坞 + 导入 modal 三 tab。但中栏是 `<iframe src="billing.html">` | ❌ 无 |
| `masters.html` | 大师对话 | ✅ 11 位大师 1v1 + 圆桌 | ❌ 无 |
| `settings.html` | 设置 | ✅ API 接入抽屉 + 免费额度进度条 + 多位置备份 + 邮箱 | ❌ 无 |
| `reports.html` | （导航已移除）| ⚠️ 文件仍存在，`reports.js` 被 `consultations.js` 复用 `Reports.renderMatrix` | — 孤儿 |
| `meetings.html`/`sync.html`/`export-billing.html` 等 | （导航已移除）| 旧的辅助入口 | — 不再使用 |

### 返回键诊断

**缺失显式返回键的页面**：`index.html`、`consultations.html`、`clients.html`、`supervision.html`、`billing-shell.html`、`masters.html`、`settings.html`（7 页）

**有返回键的页面**：`session.html`（HTML 内嵌 `goBack()` 按钮）、`client-detail.html`（JS 注入「← 工作台」）

**根因**：侧边栏导航常驻理论上可以替代，但用户明确要求「**每个界面都要有返回上一层的按键，检查每个按键是否可点击**」。需要补上 7 页的返回键。

> 建议：`app.js injectLayout` 在 `h1` 同级行尾或即将上方的 top-bar 加一个全局标准返回键，可按 `item.key !== 'dashboard'` 自动显示「← 返回首页」或更智能的「上一页」（根据 `document.referrer` 决定）。这样一次改完所有走 `App.initPage` 模式的页，不必逐页改。

---

## 二、免费试用额度展示核查

| 位置 | 现状 | 验证 |
|------|------|------|
| `settings.html` `#trial-quota-box` | ✅ HTML 容器在，`settings.js` 内 `updateTrialQuotaBox()` 读取 `AI.fetchQuota()` 并渲染「剩余 XX%」+ 重置日期 + 购买引导 | 待实机验证展示 |
| `agent-shell.js` Agent 面板 | ✅ 在重建面板中显示 badge：`🌱 免费试用 · <span id="xj-agent-quota">v4-flash</span>` + `#xj-agent-quota-pct`（右上角）和 `AI.onQuotaChange` 订阅自动刷新 | 待实机验证展示 |
| `ai.js` 引擎层 | ✅ `updateQuotaFromHeaders / fetchQuota / onQuotaChange / QUOTA_CACHE / sanitizeResult` 全套就位；启动期 `AI.fetchQuota()` 调用一次初始化缓存 | — |

**结论**：免费额度展示代码齐备，未发现缺失。建议在实机启动后查看确认 UI 显示效果。

---

## 三、真代码 vs 预览 HTML 视觉差距

### 3.1 `supervision.html` vs `supervision-ai-redesign.html`
- ✅ **骨架对齐**：topbar(品牌+取向分段) + tpl-row 模板行 + 三栏 ws + editor-wrapper + floating-tb + aidock + realsup + dock-toggle + doc-note
- ✅ **JS 实现**：`supervision.js` 注册 btnImpression/btnDeepen/btnPolish/btnMaster/btnRealSup，`getSelection() + insertNode(mark)` 真正把 AI 输出插入编辑器光标处
- ✅ **大师桥接**：通过 `window.__XJ_API__.openMaster(ctx)` 主进程桥（有 fallback 跳 masters.html）
- ✅ **拖拽调宽**：260–560px clamp + `--dock-w` CSS 变量
- ⚠️ **重 recomomend 的细节**：预览里 `realsup button` 是紧凑分段（chip 内 `primary` 样式）的「整理真人督导录音稿」，仿真代码与预览布局基本一致但可做小的间距/字号精调
- ⚠️ **Membership gate**：`spv-switch` 三按钮 → 取向+模板 chip 后，「我的自定义」chip `locked` 仅在预览展示文字提示，真代码 `supervision.js` 是否绑了 `alert` 引导会员升级需核查（预览版用 `alert`）

### 3.2 `consultations.html` vs `consultation-record-redesign.html`
- ✅ **基本三栏对齐**：左 rail(client list) + 中 center(matrix/timeline tabs) + 右 aidock(orientation mini + 动作 + 文档编辑器)
- ⚠️ **缺真实现**：预览的「时间线卡片点击 → 右栏切换为逐字稿/SOAP/DAP/反思 tab 编辑器」**未实现**。真代码 consultations.js 的 tcard 点击是 `location.href = 'session.html?id=' + sid`——**跳旧 session.html 编辑器**，右栏的 `#docEditor` 是常驻一段、不随选中会话变化
- ⚠️ **预览缺失**：floading-tb 浮动工具栏（虽然 floating-tb HTML 在页面上，但绑的 `#word` element 只在 docEditor 当前一段，无 tab 切换所以只能格式化整体文档）
- ⚠️ **结论**：真代码是「半过渡态」——左栏/中栏/右栏 UI 已对齐，但功能仍是「点会话跳走，不写入右栏编辑器」，与设计文档「单元格点击直达右栏对应 tab 编辑」目标**未达成**

### 3.3 `billing-shell.html` vs `billing-redesign.html`
- ❌ **最大差距**：真代码仍是 `<iframe id="billing-frame" src="about:blank">` → JS 异步设 `src='billing.html'` 把 85KB 独立 page 嵌入
- ❌ 与设计 billing-redesign.html 预览对齐目标：
  - ❌ 缺左栏客户记账列表（搜索/模式筛选/客户卡片）
  - ❌ 缺中栏「明细/趋势/账单」三段切换 + 内联「记一笔」「月结」表单 + 月度柱状趋势图 + 来访者收入排行 + 月度账单生成器
  - ❌ 缺顶部 6 张统计卡（本月应收/已收/欠费 + 总应收/已收/欠费），真代码只有 4 张（应收/已收/余额/本月节次）
  - ❌ 右栏 AI 记账坞已在 shell 里存在但用 `AgentSend(text)` 转发，非预览里的「自然语言窗口确认→写入 Store」
  - ❌ iframe 与 shell 的 `tokens.css`/`components.css` 仍割裂：`billing.html` 是 85KB 旧系统（虽已加 `tokens.css` 链接但仍是旧设计），`billing-shell` 的外壳风格与旧 iframe 视觉不一致

---

## 四、重复功能诊断

### 4.1 来访者/会话/咨询记录三页重叠
- **现状**：`clients.html`(列表) + `client-detail.html`(详情+成长轨迹) + `session.html`(单会话编辑器) + `consultations.html`(设计目标「吞并三页」但真代码未接管)
- **真带功能**：全部业务逻辑所在
- **未吞并**：consultations.html 中栏点击会话 → 跳 session.html → 编辑完点「返回」跳 index.html（**不是回 consultations**），定位混乱
- **建议**：按设计文档把 `session.html` 的逐字稿/SOAP/DAP/反思编辑器嵌入 consultations.html 右栏；`client-detail.html` 的成长轨迹迁 consultations 中栏（或保留 detail 作为深度卷宗页，从 consultations 中栏头像双击进入）

### 4.2 reports.html/reports.js 孤儿
- 导航已下线但仍存在 → 把 `Reports.renderMatrix` 提取为 components.css 里可复用的 `Reports.renderMatrix(host, opts)`，删除 `reports.html` 文件（`reports.js` 保留给 consultations.js 用）

### 4.3 billing.html 85KB 旧 iframe vs 3 栏重构
- 既然 billing-redesign.html 预览展示三栏工作区，且新 shell 已用 tokens.css，建议**删 iframe，按预览 native 重写 billing 页**：左栏客户列表（按 mode 筛选）、中栏「明细/趋势/账单」tab、右栏 AI 记账坞（用 store.js + AgentCore）+ 顶部 6 卡。85KB 的 `billing.html` 退役保留作参考（不再 import）

### 4.4 masters.html vs supervision 桥接入口
- 未发现简单重复，只检查桥接路径：supervision.js 已用 `window.__XJ_API__.openMaster(ctx)` 走主进程 preload 桥

---

## 五、对照设计方案「P4 架构一步到位」落点审核

`XinJing-v2.0-技术方案.md` 中 P4 决策的 8 点：

| 决策 | 设计目标 | 真代码状态 |
|------|---------|------------|
| #1 防遮挡 | 1a 保持独立详情页（点击中心 → client-detail） | ✅ 三栏中心点击→跳 detail，与设计一致 |
| #2 成长轨迹 | 手动按钮触发 + 内置模型也能跑，结果存 IndexedDB | ✅ client-detail.html 有 `#growth-btn` + `#growth-trajectory` |
| #3 督导页面 UI | 通用取向 + 大编辑区 + AI 坞常驻 + realsup | ✅ supervision.html + supervision.js 已落地 |
| #4 记账改造 | 吞并 iframe 为三栏工作区 + AI 记账坞 + 导入 modal 重皮肤 | ❌ **仍是 iframe，未达成** |
| #5 首页 dashboard | 4 张统计卡 + 快捷 + 最近会谈/报告 | ✅ 已落地 |
| #6 Agent 球 | 可拖动 + 默认左下 + 全屏/小屏切换 | ✅ agent-shell.js 呼吸球 + localStorage 位置持久化 + 全屏/小屏 |
| #7 暗色入口 | 侧栏底部「☀/🌙」+ localStorage | ✅ `#xj-theme-toggle` 已在 app.js |
| 「三个小任务」settings | API 抽屉折叠 + 切内置模型 + 自定义端点 | ✅ settings.js 已实现 |

**未达成**：#4 记账重构（最大缺口），以及 #1 的「咨询记录中栏点击会话直接进入右栏编辑器」的体验流（真代码中跳旧 session.html，没真正「吞并」）

---

## 六、用户要求清单逐项结果

| # | 用户要求 | 结果 |
|---|----------|------|
| 1 | 检查 v2.0 有什么问题 | ⚠️ 找到 7 类问题：(a) 7 个页面缺返回上层键；(b) billing-shell 仍 iframe，未按预览 native 三栏重构；(c) consultations.html 与设计文档未达成「右栏深度编辑器」联动，会话编辑仍在 session.html；(d) billing.html 85KB 旧系统未 retire；(e) reports.html 文件孤儿未删除；(f) clients/client-detail/session 三页未合并；(g) supervision.html `chip.locked` 自定义提示是否绑定 alert 待核查 |
| 2 | 每个界面都要有返回上一层的按键 | ❌ 缺 7 页：index、consultations、clients、supervision、billing-shell、masters、settings。建议方案：`app.js injectLayout` 统一加全局返回键（智能 referrer 决定返回目标，含「返回首页」为 fallback） |
| 3 | 检查每个按键是否可点击 | ⚠️ 仅核查 HTML 静态状态：session/client-detail 的返回键已绑定 onclick；其他缺失。其余按钮因数量多建议独立自测脚本覆盖 |
| 4 | 确认免费额度展示生效 | ✅ 代码齐备（settings 的 trial-quota-box + Agent 呼吸球 pct badge + AI.fetchQuota 启动期拉一次）。建议实机验证 UI 效果 |
| 5 | 「一步到位 P4 架构」 | ❌ 未达成。差距集中在：(#4 记账改造未做，(#1 咨询记录右栏深度编辑器联动未做。其余 P4 决策已落地 |
| 6 | 不要丢功能 | ⚠️ 当前合并方案下，原生 billing-shell iframe 仍保留 85KB 旧 billing.html，功能没丢；consultations.html 跳 session.html 也没丢编辑功能。如直接按预览重构 billing，**必须把旧 billing.html 的「单价可编辑、月结内联、改记录内联弹层」**迁到重写代码 |
| 7 | 重复功能去掉 | ⚠️ 重复项清单见 §4。下线 reports.html、合并 clients/client-detail/session 为 consultations 三栏，是去重的核心动作。在重构前需仔细比对，避免重复删功能的「一起丢」副作用（如成长轨迹目前只在 client-detail.js 实现，不能因删 client-detail.html 就丢这个能力） |
| 8 | 视觉表达统一 | ⚠️ 当前 `tokens.css` + `components.css` 骨架已统一，但 **billing.html iframe 内是另一套设计**（85KB 独立样式嵌套），与外壳视觉割裂。重构后才能做到 visual coherence |

---

## 七、推荐下一步动作（按优先级）

### P0（必要，否则 P4「一步到位」不成立）
1. **billing-shell 重写为 native 三栏工作区**：参考 `billing-redesign.html` 预览，把 iframe 退役（保留 billing.html 文件做参考但不再 import）
2. **consultations.html 右栏深度编辑器接管**：把 session.html 的逐字稿/SOAP/DAP/反思编辑器内嵌进 consultations 右栏，点会话不再跳走——这是 P4 #1「吞并」的核心
3. **app.js 全局返回键注入**：一次性覆盖 7 个缺键页面

### P1（必要，体验统一）
4. 下线 reports.html（reports.js 保留 utility）
5. supervision.html `chip.locked` 绑 alert 引导升级（如未绑）
6. 自由实机验证免费额度 UI 显示、悬浮按钮、暗色 toggle

### P2（清理）
7. 退役 sync.html / meetings.html / export-billing.html，会话导入入口已并入 billing-shell 的导入 modal
8. clients.html 退役或改为 detail-only 入口（列表功能在 consultations 已覆盖）

---

## 八、风险提示

- **重构 billing 必须严格保留**：单价可编辑（旧系统 `billing.html` 有 inline 编辑）、月结内联表单、改记录内联弹层、CSV 导入解析、腾讯会议导入匹配
- **重构 consultations 右栏必须保留**：`session.js` 的 saveSession + confirmed toggle + nextSessionNumber + 自定义节数 + 督导关联 + 删除会谈
- **跨页跳转链改 in-page 时**：尤其 dashboard.js 里 `qa-supervise / qa-masters / qa-update` 链接目标保持有效
- **Agent 呼吸球拖动位置 localStorage**：与全局返回键不冲突（键在 top-bar 内不会与浮窗 FAB 重叠）

---

**审查人**：CodeBuddy 模型检查  
**审查产物**：本报告文件 `XinJing-v2.0-审查报告.md`
