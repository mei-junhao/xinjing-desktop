# 心镜 · 5 份设计 HTML 落地评估与融合计划

**评估日期**：2026-07-13
**评估对象**：5 份设计 HTML（我出的） vs v2.1.0 实际代码（WorkBuddy/z-ai 实现的）
**目的**：逐个诊断为什么设计没有被贯彻，根因在哪，并给出融合计划

---

## 一、应用率总表

| # | 设计 HTML | 实际页面 | 应用率 | 根因关键词 |
|---|-----------|----------|--------|-----------|
| 1 | `billing-redesign.html` | `billing-shell.html` | **~85%** | 基本忠实，少数细节缺 |
| 2 | `supervision-ai-redesign.html` | `supervision.html` | **~85%** | 结构100%一致，CSS细节未跟上 |
| 3 | `consultation-record-redesign.html` | `consultations.html` | **~40%** | 布局骨架在，交互细节大量丢失 |
| 4 | `dashboard-redesign.html` | `index.html` + `dashboard.js` | **~15%** | 产品方向级差异，几乎未落 |
| 5 | `session-billing-flow.html` | `session.html` | **~5%** | 全新功能，P0-P2 范围外，零落地 |

---

## 二、逐页诊断

### 2.1 记账 (`billing-redesign.html` → `billing-shell.html`)

**应用最完整。** P0-2 将旧 iframe 记账直接替换为原生三栏，结构与设计 90% 一致。

| 设计特征 | 实际落地 | 状态 |
|----------|----------|------|
| 顶栏 6 卡（本月应收/已收/欠费 + 总应收/已收/欠费） | 完全一致，接 IndexedDB Store | 已落 |
| 左栏客户 rail（搜索 + 次结/月结 pill + 客户端卡） | 完全一致 | 已落 |
| 中栏 seg 三分段（明细/趋势/账单） | 完全一致 | 已落 |
| 明细：client-head + 统计 + 内联表单 + 会话表 + 月结表 | 完全一致 | 已落 |
| 趋势：12 月柱状图 + 来访者收入排行 | 完全一致，且接入真实数据 | 已落 |
| 账单：选来访者+选月 → 发票预览 → 导出 HTML | 完全一致 | 已落 |
| AI 记账坞（自然语言→记账） | 完全一致，落地 `billingAiSend()` | 已落 |
| 导入 modal（三 tab：旧版/腾讯会议/手动） | 完全一致 | 已落 |
| 均可拖拽调宽 | 完全一致，且存 localStorage | 已落 |
| 设计用硬编码 demo 数据 | **改进为真实 Store 数据** | 超越 |

**未落项（≤2 处小细节）：**
1. "记一笔"表单设计有 **节数** 字段，v2.1.0 缺失（`bf-date/bf-fee/bf-paid` 三字段，缺 `bf-session-num`）
2. 设计用 Vue/React 类 `:root` 硬编码令牌，v2.1.0 改用 `components.css` 令牌 — 这是正确的重构

**结论**：已充分落地，剩余系小补丁。

---

### 2.2 AI 督导 (`supervision-ai-redesign.html` → `supervision.html`)

**结构级 100% 一致。** 模板、取向、三栏布局、可拖拽坞、realsup、浮动工具栏、dock-toggle 全部存在。

| 设计特征 | 实际落地 | 状态 |
|----------|----------|------|
| 6 取向按钮（温尼科特/精分/CBT/人本/存在/通用） | 完全一致 | 已落 |
| 4 模板 chip（默认/短程/长程/自定义·locked） | 完全一致，locked 已绑引导 | 已落 |
| Word 式 contentEditable 编辑器 | 完全一致 | 已落 |
| 选区浮动格式工具栏（B/I/H/list/quote） | 完全一致 | 已落 |
| AI 坞 6 按钮（印象/深化/总结/润色/大师/真人督导） | 完全一致 | 已落 |
| realsup 展开面板 | 完全一致 | 已落 |
| 坞可拖拽调宽 + toggle 收起 | 完全一致 | 已落 |
| 草稿 localStorage 自动保存 | **v2.1.0 自己加的，设计没提** | 超越 |

**未落项（CSS 细节，≤3 处）：**

| 设计 | 实际 | 差异 |
|------|------|------|
| 编辑器内 blockquote 带 accent 左边框 + accent-soft 背景 | style.css 有 `.editor blockquote` 但和 components 类可能存在优先级冲突 | CSS 细节 |
| mark.ai 紫色标记块样式 | supervision.js 用了 `<mark class="ai">` 但对应 CSS 在 style.css 可能不完整 | CSS 细节 |
| 设计有 `--dock-w:360px` 统一变量 | v2.1.0 用 localStorage 存，初始默认不一致 | 细微不一致 |

**结论**：基本已落，剩余是 CSS 微调。这一页是整批设计中落地质量最高的。

---

### 2.3 咨询记录 (`consultation-record-redesign.html` → `consultations.html`)

**结构对了 60%，交互感丢了大量。**

| 设计特征 | 实际落地 | 状态 |
|----------|----------|------|
| 三栏工作区（左 rail + 中 center + resizer + 右编辑器） | 完全一致 | 已落 |
| 左栏：search + status pills（全部/咨询中/暂停/已结束）+ clist | 完全一致 | 已落 |
| 中栏：viewswitch（工作区/矩阵） | 完全一致 | 已落 |
| 中栏：client-head（name+badge+tags+stats: 节数/首访/末次/欠费） | 部分（stats 字段相近但排版不同） | 半落 |
| 中栏：subtabs（时间线/报告矩阵） | 部分（`renderCenter` 切换逻辑有但 UI 不同） | 半落 |
| 时间线节点 `.tcard` + flags | 部分（有 flags 但样式较简） | 半落 |
| **右栏 level-1：ep-head + ed-tabs（逐字稿/SOAP/DAP/反思/AI坞）** | **不存在** — v2.1.0 改为 dock-mode-switch（自由笔记/选节快编） | **架构差异** |
| 右栏 level-2：逐字稿 = Word 式 contentEditable + 浮动工具栏 | **不存在** — v2.1.0 用纯 textarea | **退化为纯文本框** |
| 右栏 level-2：SOAP/DAP 网格 textarea | 部分一致（`sess-ta` textarea 存在） | 半落 |
| 右栏 level-2：AI 坞 tab（orient-mini + ai-actions） | dockPane-free 模式有 | 已落 |
| 浮动格式工具栏（B/I/H/list/quote） | **闲置** — `#floatTb` HTML 存在但无 contentEditable 触发 | 死了 |

**这是差距最大的一页。两个架构级分歧：**

#### 分歧 A：右栏编辑器的两种思路

| | 设计 | v2.1.0 |
|---|---|---|
| **组织方式** | 5-tab 平级编辑器（逐字稿/SOAP/DAP/反思/AI坞） | 2-mode switch（自由笔记/选节快编）+ 4 sub-tabs 藏在选节快编内 |
| **逐字稿** | contentEditable Word 式编辑器 | textarea 纯文本框 |
| **AI 坞位置** | 作为编辑器第 5 个 tab，和逐字稿/SOAP 等同级 | 始终盯在坞内，选节快编模式时被 mode switch 替换 |
| **用户心智** | "我在编辑逐字稿，需要 AI 就切到 AI tab" | "我在 AI 坞里，要么写自由笔记，要么快编某节" |

设计思路：编辑器和 AI 是**并列关系**——就像 IDE 里有代码编辑器和 Copilot 面板  
v2.1.0 思路：AI 坞是**外层容器**，编辑器是坞的子模式——就像 Copilot Chat 的侧边栏

#### 分歧 B：富文本 vs 纯文本

| 设计 | v2.1.0 |
|---|---|
| 逐字稿是 contentEditable `<div>` 支持 **B/I/H/列表/引用** 格式 | 所有字段用 `<textarea>` 纯文本 |
| 选中文字弹出浮动格式工具栏（B/I/H/list/quote） | 浮动工具栏 HTML 存在但无 contentEditable 触发入口 → 闲置 |
| AI 插入结果为 `<mark class="ai">` 紫色标记块，含左边框 | AI 插入走 textContent（无格式插入） |

**根因分析**：
1. 5 份设计 HTML 作为**视觉原型**，上一任 AI 把它们当**功能参考**而非 UI spec
2. 实现时优先保功能完整（"选节快编"能保存 SOAP/DAP）+ 代码稳妥（textarea 比 contentEditable 容易维护）
3. `contentEditable` 跨页面渲染 + Store 序列化/反序列化是真实复杂度——纯 textarea 没有 HTML 注入风险
4. 我的设计没有说明"怎么把 contentEditable 内容安全存进 IndexedDB 并跨页面还原"

---

### 2.4 首页 Dashboard (`dashboard-redesign.html` → `index.html` + `dashboard.js`)

**产品方向级差异，几乎未应用。**

| 设计特征 | 实际落地 | 状态 |
|----------|----------|------|
| 4 卡财务摘要（本月应收/已收/待收/待收来访者） | 4 卡（本月应收/已收/待收来访者/活跃来访者），缺"本月待收"金额卡 | 部分 |
| "今日待记" panel（客户端 + 记一笔/月结按钮） | **不存在** | 失踪 |
| 月度收入趋势柱状图 | **不存在** | 失踪 |
| "待收来访者" panel（排行 + 欠费金额 + 智能提醒） | **不存在** | 失踪 |
| "快捷操作"是 AI 督导/大师对话/检查更新 | "快捷操作"仍为 AI 督导/大师对话/检查更新 | 一致 |
| 最近会谈 + 最近报告两栏 | 最近会谈 + 最近报告两栏 | 一致 |

**根因分析——这是最大的 gap：**

1. **产品定位分歧**：设计将首页定义为"客户经理财务仪表盘"（首屏回答"钱在哪"），而 v2.1.0 首页仍是"临床工作台"（展示最近会谈+报告）。这是**产品哲学级别的差异**，不是 CSS 问题。

2. **数据层缺失**：设计需要的 3 个数据能力 v2.1.0 Store 不直接提供：
   - "今日待记" = 今天做了咨询但 billing 未标记 paid 的 session → 需要 `Store.getTodayUnbilledSessions()`
   - "月度收入趋势" = 12 个月已收金额 time series → 需要 `Store.getMonthlyIncomeTrend()`
   - "待收来访者排行" = 按欠费排序的 client list → 需要 `Store.getClientsByOweDesc()`
   
   billing-shell.html 内联实现了这些计算，但 dashboard.js 里没有复用。

3. **P0-P2 优先级未覆盖**：dashboard 不在 P0-P2 范围里。P0-2 只做了 billing-shell 的重构。

4. **设计是静态 demo**：硬编码了 `¥3,200 / ¥2,600 / ¥600` 等数字和 `['林小满','陈默','赵雪']` 来访者，真实实现需要完整的数据管道。

---

### 2.5 会话计费闭环 (`session-billing-flow.html` → `session.html`)

**零落地。这是一个从未进入开发队列的全新功能。**

| 设计特征 | 实际落地 | 状态 |
|----------|----------|------|
| 咨询计时器 | **不存在** | 失踪 |
| 写完 SOAP 自动弹出计费卡 | **不存在** | 失踪 |
| 计费卡：日期/次数/单价/备注 + 已收/未收 toggle + 稍后/确认按钮 | **不存在** | 失踪 |
| 流程步骤可视化（①计时→②SOAP→③弹计费→④结清） | **不存在** | 失踪 |

**根因分析**：
1. 该设计解决的是"记账流程割裂"——这是我在客户经理视角产品意见中提出的 P0-1 问题，但设计产出晚于 v2.0 开发启动
2. session.html 的"退休"是交接文档明确的**短期待办**，但前任 AI 把它留给了下一任
3. 实现这页需要：
   - 新建计时器组件（或接入 `performance.now()` 计时状态机）
   - session.html 内挂 billing 表单注入逻辑
   - Store 层跨页状态同步（timer 状态、billing 草稿）
   - 这个复杂度超出了 P0-P2 的"结构修复"范畴

---

## 三、共性根因

### 3.1 设计 HTML 与 App 架构的根本错位

| 设计 HTML | 心镜 App |
|-----------|----------|
| 独立 HTML 文件，`<link>` 引 tokens.css/style.css | 多页架构，通过 `App.initPage()` 注入 sidebar + page-header |
| 自建 `:root {}` 硬编码令牌 | 复用 `components.css` 令牌，不重复定义 `:root` |
| 内联 `<script>` 操作 DOM | 独立 JS 文件通过 `App.initPage({onReady})` 门控 |
| 硬编码 demo 数据 | IndexedDB `Store.hydrate()` → 内存缓存 → `Store.getXxx()` API |
| 无路由，单页自洽 | 多页跳转（`location.href`），需考虑导航一致性和返回键 |
| CSS 自由发挥 | 必须服从 `style.css` + `components.css` 的类名约定 |

### 3.2 设计文档与需求文档的错位

上一任 AI 收到的任务清单是 P0-P2 的结构修正，不是视觉翻新：
- P0-1：全局返回键 ← **纯功能**
- P0-2：billing-shell 去 iframe ← **重构，恰好和我的设计方向一致**
- P0-3：consultations 右栏编辑器 ← **功能接管，不是 UI 翻新**
- P1-1：删孤儿页面 ← **清理**
- P1-2：supervision locked 绑引导 ← **Bug fix**
- P2-1：合并三页导航 ← **信息架构**

我的 5 份设计 HTML 本质是**视觉与交互重设计**，上一任 AI 是**功能修正和代码清理**，两者不在一层。

### 3.3 contentEditable vs textarea 的技术债务

这是整批设计中最大的技术分歧。contentEditable 提供 Word 式编辑体验但代价巨大：
- 跨浏览器行为不一致
- HTML 反序列化有 XSS 风险（需要 DOMPurify 或白名单净化）
- Store 存 HTML 后跨页面还原需要信任沙箱
- Electron `contextIsolation: true` 下 `<script>` 注入受限更多

v2.1.0 选择 textarea 是保守但务实的工程决策。

---

## 四、融合计划（分三期）

### 第一期：速赢补丁（1-2 天，低风险）

这些是"设计有、实际缺、不难加"的项。

#### 1A. 记账页补"节数"字段
| 位置 | 操作 |
|------|------|
| `billing-shell.html` 内联脚本 `addRecord()` | 在 `bf-date/bf-fee/bf-paid` 之外加 `bf-session-num`，调用 `Store.createSession({sessionNumber})` 时传入 |

#### 1B. 首页加"待收来访者"金额卡
| 位置 | 操作 |
|------|------|
| `index.html` `#stat-grid` | 加第 5 卡 `<div class="card owe"><b id="stat-pending-amount">¥0</b><span>本月待收</span></div>` |
| `dashboard.js` `renderStats()` | 加 `stat-pending-amount` 渲染逻辑（monthlyReceivable - monthlyReceived）|

#### 1C. 首页加"本月欠费"高亮
| 位置 | 操作 |
|------|------|
| `dashboard.js` `renderStats()` | 已存的 `stat-pending-clients` 显示人数，追加显示欠费总金额 |

#### 1D. consultations 右栏逐字稿加浮动工具栏
| 位置 | 操作 |
|------|------|
| `consultations.js` | 当 dock-mode=session 且 active tab=transcript 时，给 `#sess-transcript` 绑定选区事件 + 弹出 floatTb（B/I 用 markdown `**` `_` 包裹替代 HTML 格式） |

---

### 第二期：中等重构（1 周，需验证）

#### 2A. 首页收入趋势图

| 步骤 | 内容 |
|------|------|
| 1 | 在 `dashboard.js` 加 `renderIncomeTrend()` 函数，复用 billing-shell 同款 chart-area 逻辑（近 12 月已收柱状图） |
| 2 | `index.html` 两栏下方加 `<div id="income-trend-panel">` panel |
| 3 | 样式复用 `components.css` 的 `.chart-area` `.bar` `.b-lbl` 类（billing-shell 已定义在 `<style>` 块，需移到 `components.css`） |

#### 2B. 首页"今日待记"panel

| 步骤 | 内容 |
|------|------|
| 1 | `Store` 加 `getTodayUnbilledSessions()`：过滤 `date === today && billing.fee > 0 && !billing.paid` |
| 2 | `dashboard.js` 加 `renderTodayBilling()` 渲染待记账列表 |
| 3 | `index.html` 加 panel，每个 item 含来访者名 + session# + fee + "记一笔"按钮 |
| 4 | "记一笔"按钮跳 `billing-shell.html` 并预选该来访者（URL hash `#client=xxx`） |

#### 2C. consultations 右栏交互对齐设计

| 步骤 | 内容 |
|------|------|
| 1 | 重构右栏为 `ep-head` + 5-tab（逐字稿/SOAP/DAP/反思/AI坞），废弃 dock-mode-switch 模式 |
| 2 | 逐字稿 tab 改 contentEditable `<div class="word">`（复用 supervision.html 同款编辑器） |
| 3 | AI 坞作为第 5 个 tab（orient-mini + ai-actions 挪进来），dockPane-free 作为"自由笔记"保留为左侧独立 panel |
| 4 | contentEditable → Store 保存时用 `innerHTML`，读取时用 `innerHTML` 还原，加 `App.sanitizeHtml()` 白名单净化 |
| 5 | 浮动工具栏绑定到 `.word` contentEditable |

**关键决策点**：这一步涉及架构变更，需先和用户讨论是用 contentEditable 还是保持 textarea。建议先让用户试用 supervision.html 的 Word 式编辑体验，再决定咨询记录的逐字稿要不要同款。

#### 2D. 首页"待收来访者"排行 panel

| 步骤 | 内容 |
|------|------|
| 1 | 在 `dashboard.js` 加 `renderAccountsReceivable()`，复用 billing-shell 的 `clientAgg()` 逻辑 |
| 2 | `index.html` 加 panel，排行列表 + 欠费金额 + "发送账单"按钮跳 billing-shell 账单 tab |

---

### 第三期：新功能（2-4 周，需设计方案确认）

#### 3A. 会话计费闭环 (`session-billing-flow.html`)

| 步骤 | 内容 |
|------|------|
| 1 | `session.html` 加内嵌计时器组件（`#session-timer`），start/pause/stop，接 `performance.now()` |
| 2 | 计时结束或"保存"按钮触发 → 自动弹出 billing card（悬浮 panel 在 save-bar 上方） |
| 3 | billing card 表单：日期(自动填今天)/次数(自动填1)/单价(读 client.billing.feePerSession)/备注/已收toggle |
| 4 | "确认结算" → `Store.createSession({billing:{fee,paid,source:'session'}})` + `App.showToast` |
| 5 | 流程步骤可视化条（①计时→②SOAP→③弹计费→④结清），已完成的标亮 |
| 6 | 确认结算后通知 billing-shell 刷新（通过 `window.dispatchEvent(new CustomEvent('xj:billing-changed'))`） |

#### 3B. session.html 退休（交接文档短期待办 #1）

| 步骤 | 内容 |
|------|------|
| 1 | 在 consultations 右栏补齐 session.html 独有的 5-8 项功能（见交接文档 §七.1）|
| 2 | 补齐后删除 session.html 物理文件，更新所有 `session.html?id=` 跳转 |
| 3 | 详见交接文档该节 |

---

## 五、设计 HTML 的技术债务清单

以下是 5 份设计 HTML 与 App 架构不兼容的具体问题，融合时需逐一解决：

| # | 问题 | 涉及文件 | 修正方案 |
|---|------|----------|----------|
| 1 | 所有设计 HTML 自建 `:root {}` 令牌块 | 全部 5 份 | 删除自建 `:root`，改用 `components.css` 的 CSS 变量（`--bg`/`--border`/`--accent` 等已在 tokens.css 定义） |
| 2 | 设计 HTML 无 sidebar / page-header 注入 | 全部 5 份 | 融合进 App 多页架构时用 `App.renderSidebar()` + `App.initPage()` |
| 3 | 硬编码 demo 数据 | 全部 5 份 | 替换为 `Store.getXxx()` 调用 + 空状态处理 |
| 4 | 内联 `<script>` 操作 DOM | 全部 5 份 | 迁移到独立 JS 文件，用 `App.initPage({onReady})` 门控 |
| 5 | CSS 类名与 `components.css` 冲突 | billing/supervision/consultation | 审计是否有 `.card`/`.btn`/`.tag` 等重名类，统一用 components.css 定义 |
| 6 | contentEditable HTML 存储安全 | supervision/consultation | 实现 `App.sanitizeHtml()` 白名单净化（保留 B/I/H3/UL/BLOCKQUOTE，删 script/onerror/iframe） |
| 7 | 浮动工具栏 `document.execCommand` 已废弃 | supervision/consultation | 替换为现代 API 或保留 execCommand 加 try-catch（Chromium 内仍可用但控制台 warn） |

---

## 六、建议的执行顺序

```
第一期（本周末前）：
  1A → 1B → 1C → 1D
  （4 个小补丁，零风险，纯增量）

第二期（下周）：
  2A → 2B → 2D → 【讨论 2C 的 contentEditable vs textarea 决策】→ 2C 或 2C-alt
  
第三期（下下周起）：
  3A → 3B（session.html 退休）
```

每个阶段的改动都独立可发布（bump patch version），不互相阻塞。

---

## 七、需要用户决策的关键问题

1. **contentEditable vs textarea**：咨询记录的逐字稿编辑，用 Word 式富文本（contendEditable）还是保持纯文本 textarea？前者体验更好但增加维护复杂度（HTML 净化、跨页还原），后者简单可靠。建议先在 supervision 页实际使用 Word 式编辑 1 周，再决定。
2. **首页定位**：倾向于"客户经理财务仪表盘"还是"临床工作台+财务入口"？前者需要把收入趋势、今日待记、待收排行提升到首屏。
3. **session-billing-flow 优先级**：是否现在启动计时器+计费闭环，还是等 session.html 退休时一并处理？
