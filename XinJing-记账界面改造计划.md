# 心镜 · 记账界面改造计划（吞并 iframe 旧记账系统）

> 目标版本：v1.9.0（建议单独成档，先方案 + 评审 ≥95 再动手）
> 改造对象：`billing-shell.html`（iframe 壳）+ `billing.html`（85KB 旧独立系统）+ `billing-sync.js`（导入桥）
> 设计语言：方向 A 静谧留白，与「咨询记录主工作区」「AI 督导通用取向版」同族

---

## 一、现状问题

| # | 痛点 | 位置 |
|---|------|------|
| 1 | **iframe 外挂割裂** | `billing-shell.html:104` 用 `<iframe src="billing.html">` 加载 85KB 独立旧系统，不共享主应用 `tokens.css` 设计令牌（壳里甚至写死 `background:#f0f4f9`，非 calm 色），主题/字号/间距与主应用不一致，且有白屏/刷新成本。 |
| 2 | **上下文断裂** | 咨询师在「咨询记录」里写完某次会谈，要切到记账 iframe 再录费用；两处数据虽同源（Store）但 UI 不互通。 |
| 3 | **记账动作藏得深** | 记一笔/月结藏在旧系统内部，不顺手；与 v1.6 Agent 的 `billing.add_record` / `billing.monthly_settle` 工具**没有前端统一入口**。 |
| 4 | **导入样式旧** | 三 Tab 导入（旧版记账/腾讯会议/手动 JSON）逻辑可用，但样式未纳入 calm 体系。 |

---

## 二、目标

把记账从「iframe 外挂」改为**主应用内的一档工作区**，与咨询记录同族：

- 顶部总览卡 + 顺手操作（记一笔 / 月结 / 导入 / AI 记账）
- 左栏客户记账列表、中栏单客户明细、右栏 AI 自然语言记账坞
- 复用 v1.6 Agent 的 `billing.add_record` / `billing.monthly_settle` 工具作为「AI 记账」入口
- 导入 modal 重皮肤，逻辑（`billing-sync.js`）保留

---

## 三、新布局（三栏，与咨询记录一致）

```
┌──────────────────────────────────────────────────────────────┐
│ 顶栏：记账 │ 总览卡(本月应收/已收/欠费 · 总应收/已收/余额) │ [记一笔][月结][导入][AI 记账] │
├──────────────┬────────────────────────────────┬──────────────┤
│ 左栏 客户记账 │ 中栏 客户明细                    │ 右栏 AI 记账坞 │
│ · 搜索        │ 资料头(名/模式/应收/已收/欠费)   │ 自然语言输入   │
│ · 模式筛选    │ 记录时间线表(日期/节/费/收/类型) │ → agent 工具   │
│  次结/月结    │ 月结记录                         │ 可拖拽调宽     │
│ · 客户卡      │ [记一笔][月结] 内联表单          │               │
└──────────────┴────────────────────────────────┴──────────────┘
```

### 3.1 顶部总览卡
- `aggregateAll` 已有：本月活跃、应收、已收、余额；按客户 `aggregateClient` 得应收/已收/欠费。
- 卡片：本月应收 / 本月已收 / 本月欠费（红）/ 总应收 / 总已收 / 总余额。

### 3.2 左栏 · 客户记账列表
- 搜索（姓名）+ 模式筛选 pill（全部 / 次结 / 月结）。
- 客户卡：姓名、模式徽章（次结/月结）、应收、已收、欠费（红）、本月收款。点击 → 中栏。

### 3.3 中栏 · 客户明细
- 资料头：姓名、模式、单价、应收/已收/欠费、本月。
- 记录时间线表：日期、第几节、费用、已收、类型（次结/月结/会议）。
- 月结记录区：列出 `client.billing.monthlyPayments`。
- 内联「记一笔」表单（客户默认当前、日期、费用、节数、已收？、类型）；「月结」表单（月份、金额）。提交调用 `Store.createSession` / `Store.updateClient`（与 Agent `billing.add_record` / `monthly_settle` 落库路径一致，复用 Agent 的 tag 去重惯例 `[billing:clientId:date:fee]`）。

### 3.4 右栏 · AI 记账坞（复用 Agent）
- 自然语言输入框：「帮张明记 4 月 10 号会谈 300 块次结没付」→ 调 `AgentCore.runRound` + `billing.add_record` / `monthly_settle`。
- 取向/模板无关（记账不需督导取向），但复用可拖拽坞组件与确认卡。
- 结果回写中栏（刷新当前客户明细）。

### 3.5 导入 modal（重皮肤，逻辑保留）
- 三 Tab：旧版记账（JSON/CSV）、腾讯会议、手动 JSON —— 逻辑来自 `billing-sync.js` / `BillingImport` / `MeetingsImport`，仅改样式接入 calm。

---

## 四、数据模型映射（Store 现有字段，无需改结构）

- 来访者 `clients`：`billing{feePerSession, billingMode, monthlyPayments[]}`
- 会谈 `sessions`：`billing{fee, paid, source}`, `notes` 含 `[billing:...]` tag
- 聚合：`aggregateClient` / `aggregateAll`（store.js 已有，直接复用）

---

## 五、改动清单

| 文件 | 动作 |
|------|------|
| 重写 `billing-shell.html` | 去掉 iframe，改为内联三栏工作区 + AI 记账坞 + 导入 modal |
| 删除/下架 `billing.html` | 旧 85KB 独立系统不再作为 iframe 加载（逻辑中可保留作参考） |
| `billing-sync.js` | 保留为导入桥（旧版记账/腾讯会议/手动 JSON → Store） |
| `agent-tools.js` | 已有 `billing.add_record`/`monthly_settle`，前端 AI 记账坞直接复用 |
| `store.js` | 无需改结构 |
| `app.js` 导航 | 侧边栏「记账」指向新 `billing-shell.html` |

---

## 六、验收标准

- [ ] 记账不再用 iframe，整体视觉与咨询记录/督导同族（calm 令牌、无写死旧色）。
- [ ] 顶部总览卡显示本月/总应收已收欠费余额，数字与 Store 一致。
- [ ] 左栏按模式筛选客户；点击客户中栏显示其记录时间线与月结。
- [ ] 「记一笔」「月结」内联表单提交后中栏实时刷新，落库路径与 Agent 工具一致。
- [ ] 右栏 AI 记账坞自然语言输入可记账/月结，结果回写中栏；坞可拖拽调宽。
- [ ] 导入三 Tab 重皮肤且功能不变（旧版记账/腾讯会议/手动 JSON）。
- [ ] 在咨询记录里写的会谈，切到记账能直接看到对应费用记录（数据互通）。
