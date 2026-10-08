# 心镜 XinJing 桌面版 — 项目日志

> 每次项目修改都在此增量更新（更新日志保持倒序，最新在上）。
> 发布铁律见 `XinJing-工作交接文档.md`；版本化生产闸门走 xinjing-release-gate。

## 当前进度
- 当前里程碑：**v1.6.0**（Agent 数据感知能力大幅增强）+ v1.6.2 退化循环修复
- 已发布包版本：**1.6.2**（COS 自动更新通道，构建时由 bump-version.js 自 1.6.1 patch-bump）
- 上次 GitHub push：v1.5.3（`chore/cos-sync` 分支，第 4 版 cadence 时点）；本版未 push（距上次仅 2 版）
- 测试基线：127 通过 / 0 失败（`scripts/self-test.js`）

## 更新日志

### v1.6.0 / 包 1.6.1 — 2026-07-12
**主题**：大幅增强 Agent 数据感知能力（用户痛点：连高性能模型后问"跟我工作最长时间的来访是谁"答不出——根因是 Agent 无读取业务数据的工具，数据全在 IndexedDB 未暴露）。

- **共享聚合核心（4 纯函数）**：`aggregateClient` / `aggregateAll` / `computeInsight` / `computeFollowups`，全部只读 `Store` getter、无 DOM、null 安全；未来成长轨迹 #2 直接复用。
- **5 个新只读工具**（kind:`read`，不弹确认）：`client.query`（默认按 tenure 降序、≤20 行）/ `session.query`（≤30）/ `supervision.query`（≤20）/ `stats.overview`（算 longestClient/busiestClient/activeThisMonth）/ `client.insight`（近3月趋势 + riskFlags）。
- **层 3 主动提示**：`billing.add_record` / `billing.monthly_settle` / `supervision.start` 成功后附 `data.followups`；`agent-core.runRound` 第 4 参 `onEvent` 推送 → `agent-shell.renderFollowupCard` 渲染轻量「💡 跟进提示」卡（非确认卡、不阻断）。
- **B1 截断修复**：`agent-core` 新增 `READ_RESULT_MAX=20000`，read 工具按该上限截断（写工具仍 `TOOL_RESULT_MAX=4000`），避免大返回被截成半截 JSON。
- **系统提示规则 9**：涉及「谁/几次/多久/欠费/最久」等事实问题必须先调查询工具，严禁凭记忆编造。
- **自测**：新增 T40-T44（聚合字段/降序/null 安全、overview 计算、工具名消毒、followups、大返回不被截断），全量 **125 通过**。
- **独立代码评审**：96/100（≥95 可发版），无 P0/P1。发版前落地 3 处 P2：① `activeThisMonth` 消除 N+1 且改为「任一当月会谈即活跃」；② `fee_anomaly` 放宽为任一免费会谈即提示（含纯免费客户）；③ 工具名消毒/截断/注入防御复核通过。
- **发布**：本地提交；COS 上传 1.6.1；GitHub 不 push（未达 4 版 cadence）。

### v1.6.2 — 2026-07-13
**主题**：修复 Agent 退化循环（用户实测：问"谁跟我工作最久"时 Agent 连发 `stats.overview` 8 次撞 MAX_STEPS 上限放弃、全程不回答）。

- **根因**：数据返回正确（`stats.overview` 含 `longestClient`），是 DeepSeek 在「系统提示强约束必须先查工具」下的 function-calling 退化循环——拿到结果后仍反复发同一工具调用、始终不产出最终文字。
- **编排器防护（`agent-core.runRound`）**：
  - `ANSWER_NUDGE`：拿到首个工具结果后，后续每轮注入 system 提示「优先用已有数据回答、不要重复调同一工具」；
  - 退化检测：每步算 `singleKey`（仅 1 工具调用时取该 key）；连续 2 次调用同一工具即 `repeatCount>=2` → 判定退化 → 调 `forceTextAnswer(trimmed)` 用 `tool_choice:'none'` 强制模型只回文字（ai.js 仅在 `options.tools` 非空时才注入 `tool_choice`，故 tools 必须保留）；
  - 不同工具交错 / 单步多工具不误触发；强制回答仅在非空时返回，空串则继续循环交 MAX_STEPS 兜底。
- **系统提示规则 10**：查到数据后一次文字回复即可，同一查询工具连调两次即视已获取足够信息。
- **自测**：新增 T45（退化循环：mock 连发 3 次 → 第 2 次强制收敛、返回含"张三"文字、calls≤4、forced===true）/ T46（正常查一次即答：calls===2、含"李四"、forced!==true）；全量 **127 通过**。
- **独立代码评审**：97/100（≥95 可发版），无 P0/P1。采纳 1 处 P2：强制回答空串时不再给用户空回复。
- **发布**：本地提交；COS 上传 1.6.2；GitHub 不 push（距上次备份仅 2 版，未达 4 版 cadence）。

### v1.5.3 — 2026-07-11
- 发送边界 tool 配对铁壁：归一化 tool_calls id + 发送前清洗未应答 tool_call/孤儿 tool，彻底消除 Agent 工具调用的 HTTP 400（Messages with role 'tool' must be a response to a preceding message with 'tool_calls' id）。

### v1.5.2 — 2026-07-11
- 修复 Agent 多轮截断导致 tool 消息孤儿（HTTP 400）：`trimToWindow` 以 assistant(tool_calls)+其 tool 结果为原子单元整组保留/丢弃。

### v1.5.1 — 2026-07-11
- 修复 Agent 工具名含点号触发 DeepSeek HTTP 400：`wireName` 消毒为下划线 + wire↔internal 映射。
- DeepSeek 预设仅保留 v4-flash / v4-pro，弃用模型清除 + 迁移 OLD 列表。

### v1.5.0 — 2026-07-11
- P0 UI 重构：设计令牌收敛、导航重构、首页快捷操作、检查更新桥接、咨询记录占位页。

## 待办（顺延）
- v2.0 P1–P4：来访者/详情/记账页换肤（#1/#3）、咨询记录页完整（#4）、成长轨迹（#2，复用本版聚合核心）、Agent Siri 呼吸球+拖动+全屏（#6）、暗色切换入口（#7）、极简收尾（#8）。
