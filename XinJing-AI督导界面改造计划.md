# 心镜 AI 督导界面改造计划（通用取向版）

> 目标版本：v1.7.0（建议单独成档，先出方案 + 评审 ≥95 再动手，遵循交接铁律）
> 关联：当前「AI 督导」标签页（`supervision.html` / `supervision.js` / `supervision-core.js`）

---

## 一、问题诊断（当前界面痛点）

| # | 痛点 | 现状位置 |
|---|------|----------|
| 1 | **输入/输出占位过大** | 材料 `textarea`（min-height 170px）+ 整体印象卡 `#aiImpression` + 独立 chat `#aiChat` 三段**上下堆叠**，写长逐字稿时输入被挤到顶、AI 输出在底，来回滚动。 |
| 2 | **只有温尼科特取向** | `spv-switch` 仅 女娲版/仓颉版（均温尼科特）+ 真人督导整理，无法满足 CBT / 人本 / 存在 / 古典精神分析等取向咨询师。 |
| 3 | **无法链接大师对话** | 督导界面没有任何通往 `masters.html` 的入口/桥接。 |
| 4 | **强约束日期** | 手工记录模态 `#sv-date` 必填日期；通用 AI 督导场景不应强约束日期。 |
| 5 | **AI 功能点来点去** | 需「粘贴→点生成整体印象→看卡→点聊天→点发送」多步；AI 与编辑割裂。 |
| 6 | **不支持自定义模板** | 模板写死在 `Supervisors.buildSystemPrompt`，会员无法自定义取向模板。 |

---

## 二、目标设计

1. **取向自选 + 内置模板**
   进入先选取向：温尼科特 / 弗洛伊德精神分析 / CBT / 人本-罗杰斯 / 存在-亚隆 / 通用。
   选定后系统载入**对应督导模板（system prompt）**。会员可增删改自定义模板。

2. **Word 式大版面编辑**
   中央一个大编辑区（`contenteditable` + 选区浮动格式工具栏：粗体/斜体/标题/列表/引用），可写逐字稿也可直接写督导记录，空间充足、输入即留存（本地草稿）。

3. **AI 常驻侧坞（不点来点去）**
   右侧常驻、可收起的 AI 坞，提供一键操作：
   - 「生成整体印象」→ 直接**插入光标处**（不再是独立卡）
   - 「就选区深化」→ 以编辑器选中文本为议题追问，回复插入
   - 「总结选区 / 润色选区」
   - 「就此议题开启大师对话」→ 桥接 masters
   结果都落在文档里，无需独立 chat 页面。

4. **大师对话桥接**
   AI 坞内按钮把当前材料/议题传给 `masters.html` 并跳转（`xj:agent:openMaster` 同款 CustomEvent 桥）。

5. **去掉日期强制**
   通用 AI 督导界面不显示日期字段；仅「手工记录」模态保留日期。

6. **会员自定义模板**
   会员在设置里增删改模板；督导界面读取。非会员见升级提示。

7. **真人督导整理（realsup）融入新布局**
   原 `realsup` 模式（把真人督导录音转写稿结构化为 clientName/date/summary/keyFrags/techniques）**保留并并入**新布局，作为 AI 坞内一个独立动作「整理真人督导录音稿」，而非与取向并列的第三个切换按钮。点击后展开内联转写稿粘贴区，结构化结果插入文档。

8. **AI 坞可拖拽调宽**
   右侧 AI 坞左缘提供拖拽手柄，用户可自由调节坞宽（默认 340px，最小 260 / 最大 560），提升小屏或长文场景可用性。

---

## 三、改动清单

### 3.1 `supervision.html`（结构）
- 顶部：取向**分段控件** + 模板 chip 行（替换原 `spv-switch` 三按钮，`supervision.html:40-43`）。
- 中部：左右分栏
  - 左：**大编辑区**（取代 textarea + 整体印象卡 + chat 三段堆叠）。
  - 右：**AI 坞**（常驻，可收起）。
- 移除 AI 督导区的日期关联。
- 新增「开启大师对话」按钮（桥接 masters）。

### 3.2 `supervision.js` / `supervision-core.js`（逻辑）
- `switchSpvMode`（`supervision.js`）→ 改 `selectOrientation(orientation, templateId)`，从模板表取 system prompt。
- `Supervisors.buildSystemPrompt`（`supervisors.js`）扩展为**多取向模板表**：新增 `cbt / rogers / yalom / psychoanalysis / generic` 等条目，结构同现有温尼科特模板。
- AI 坞「生成整体印象」改为把结果**插入编辑器**（取代 `#aiImpression` 卡）；「选区讨论」用 `window.getSelection()` 文本作 user 输入，`SupervisionCore.runRound` 后把回复插入光标。
- 新增 `openMasterDialogue(context)` 桥接到 `masters.html`。
- 新增 `runRealSupParse` 接入：AI 坞「整理真人督导录音稿」展开内联转写稿粘贴区，`SupervisionCore.runRealSupParse` 结构化后插入文档（`saveRealSupRecord` 落库）。

### 3.3 `store.js`（数据）

### 3.3 `store.js`（数据）
- 新增 `supervisionTemplates` 集合（内置 + 会员自定义）；`saveTemplate / getTemplates / deleteTemplate`。
- `exportAll` / `importAll` 纳入（顺带修 S1/S2 数据丢失）。

### 3.4 会员 gate
- 自定义模板按钮对非会员置灰 + 升级提示（复用 `App.aiUnlocked()` / tier 机制）。

---

## 四、内置取向模板表（建议初版）

| key | 取向 | 模板要点（design note） |
|-----|------|------------------------|
| winnicott | 温尼科特取向 | 现有女娲/仓颉（保留） |
| psychoanalysis | 古典精神分析（弗洛伊德） | 本我/自我/超我、防御、移情、梦、重复与固着 |
| cbt | 认知行为 | 自动思维/中间信念/核心信念、认知扭曲、行为实验、苏格拉底式提问 |
| rogers | 人本-罗杰斯 | 无条件积极关注、共情、一致性、来访者中心 |
| yalom | 存在主义-亚隆 | 死亡/孤独/自由/无意义、此时此地、终极关怀 |
| generic | 通用整合 | 不绑定单一流派，结构化概念化 + 开放提问 |

每个模板 = `{ key, label, systemPrompt, builtin:true }`；会员自定义 `builtin:false`。

---

## 五、验收标准

- [ ] 选 CBT 取向 → 载入 CBT 督导模板，生成的整体印象是 CBT 框架（非温尼科特话术）。
- [ ] 大编辑区可像 Word 一样排版，选中文本出浮动工具栏。
- [ ] AI 坞一键「生成整体印象」将结果插入文档，无需跳独立 chat。
- [ ] 点「开启大师对话」跳 `masters.html` 并带当前议题上下文。
- [ ] 通用 AI 督导界面**无日期字段**；手工记录模态仍保留日期。
- [ ] 会员可在设置自定义模板；非会员见升级提示且无法保存。
- [ ] AI 坞「整理真人督导录音稿」可粘贴转写稿并结构化插入文档。
- [ ] 右侧 AI 坞可拖拽调宽（260–560px），布局不破。

---

## 六、风险与注意

- 大编辑区用 `contenteditable` 需处理粘贴纯文化（避免带入杂乱 HTML）。
- AI 坞插入位置用 `Selection` / `Range` API，注意光标回落后焦点管理。
- 多取向模板提示词需经**专业复核**（用户规则：涉及温尼科特/精神分析须注明出处、引用正式出版物）。
- 与 v2.0 UI 重构（方向 A 静谧留白）共用 `tokens.css` 令牌，勿新增硬编码颜色。
