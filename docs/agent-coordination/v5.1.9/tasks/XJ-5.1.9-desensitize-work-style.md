# XJ-5.1.9-desensitize-work-style · 文档脱敏（Work 界面视觉复刻）

> **已立项**：版本 5.1.9（用户已签发，2026-09-05）；base_commit 参考 9971787（切卡时重取）。
> **范围裁决（用户已定）**：① 复刻目标 = **Work 界面脱敏的视觉效果**（结果页逐组件还原）；② 脱敏**引擎源码参照刚落地的 pii-sanitizer MVP**（不整体移植 LegaleWork Python 引擎）；③ **合规审查线移除**。
> **参考稿**：`qa/task-scratch/ui-align-legalework/desensitize-result-mockup.html`（CSS 逐条取自 LegaleWork v0.3.26 desensitize_result.html 实测，数据为 xj519fx 合成材料）。

- `task_id`: `XJ-5.1.9-desensitize-work-style`
- `write_lock_id`: `lock-XJ-5.1.9-desensitize-work-style`（立项时分配）
- `delivery_report`: `D:/xinjing-electron/qa/agent-reviews/XJ-5.1.9-desensitize-work-style.md`

## 单一关键结果

咨询记录/逐字稿页新增「生成脱敏文档」：基于 pii-sanitizer MVP 检测层 + Work 式「保留格式打码」策略处理本地文档，结果页**逐组件复刻 Work 脱敏结果视觉**（黑白编辑风、侧栏导航+导出区、hero+三指标、命中类型 chips、五列明细表、注意事项、三态页），四项产物（脱敏结果文件/报告 JSON/报告 Markdown/原文件留存说明）真实可下载；不删除不弱化任何现有功能。

## 实现规格

### A. 引擎（pii-sanitizer MVP 扩展，出站管线零改动）

- **复用**：`pii-sanitizer.js` 的 REGEX_RULES 检测（9 类，含本轮强化的座机/微信号）与 span 去重（最长优先）——同一份规则、两条管线并存，出站占位符模式 `[[TYPE_N]]` 保持原样不动。
- **新增「文档遮蔽模式」**（新增 api 或 sibling 模块，二选一由实现者定）：replacement 生成器按 Work 策略移植——手机前3后4 `139****5678`、邮箱 `zh***@domain`、证件前3后4、银行卡前6后4、IP `x.***.***.y`、地址→「住所地：某地址」、出生→`****年**月**日`。
- **法律主体代称**：人名保留姓+「某」（张三丰→张某某，基于 MVP 的 PERSON_NAME 上下文规则扩展）；机构稳定代称 + 全称/简称归并（identity_key）。
- **产物**：脱敏结果文本、report JSON（`summary.total_findings/entity_counts/findings[type,locator,replacement,preview,score]/warnings`）、report Markdown、原文件留存说明——结构对齐 Work `formatTaskResult` 的可下载清单。

### B. 结果页 UI（逐组件复刻，mockup 为验收基准）

- 新页面 `app/desensitize-result.html`：按 mockup 还原——264px 侧栏（心镜 branding + 明暗切换 + 锚点导航 + 导出区 4 链接 + 返回工作台）、hero 卡（eyebrow「数据脱敏处理完成」+ 文档名 34px/720 + 抽样复核提示）、三指标卡（命中总数 36px / 输入类型 / 处理策略「格式打码」）、命中类型 entity-chip 网格（28px 数字）、处理明细表（类型徽章四档纸感色/位置/替换为/预览/置信度，上限 500 条）、注意事项 notice-block、底部黑色 download-toast。
- **三态**：处理中（旋转图标 state-page）/ 失败（⚠️ + 重新提交）/ 完成（结果页）——与 Work 模板一致。
- **视觉正交声明**：本页为黑白编辑风（#111 accent + 纸感语义色），独立于 aligned/clinical 等皮肤（Work 主界面 Apple 蓝、脱敏页黑白编辑风，做法相同）；明暗双态按 Work 模板完整实现。
- **入口**：consult-notes 页工具区「生成脱敏文档」按钮（现有功能零改动，纯新增）；处理后产物经既有下载/导出惯例（App.exportWordDoc/downloadFile）落盘。
- MVP 流程为**同步处理 + loading 态**；Work 的异步 task 轮询模式记录为后续演进（大文件场景）。

## 写集（执行 agent）

- `app/js/pii-sanitizer.js`（新增文档遮蔽模式 api；出站占位符模式行为零变化）
- `app/desensitize-result.html`（新增，mockup 转正）
- `app/js/consult-notes.js` 或其工具区（新增入口按钮 + 流程接线；既有功能零删改）
- 产物落盘所需的最小主进程/下载桥接（如需，仅走既有 IPC 惯例，不扩大接口——越界即 blocked 交 Codex intake）
- `scripts/redaction-engine.test.js` 或 `scripts/v5.1.9-tests/XJ-desensitize-work-style/**`（fixture + 变异）
- 本卡 scratch 与交付报告

## 禁止事项

- 合规审查线（条款缺口/整改包/跨境审查/证据清单/法规映射）不做。
- 不得改出站占位符管线的行为（`node scripts/pii-sanitizer.test.js` 基线必须原样通过）。
- 不得使用真实临床材料；测试全部合成（xj519fx 前缀）。
- 不删除/弱化任何现有功能；consult-notes 仅新增入口。

## 验收契约

1. **视觉对照**：结果页与 mockup 逐组件核对（侧栏/hero/三指标/chips/明细表/注意事项/toast），明暗双态；对照 LegaleWork 实机截图复核。
2. **遮蔽正确性**：合成 fixture（会谈记录，含 9 类实体 + 全称简称混用 + 法条引用）→ 明细表逐条断言替换格式；同一主体代称稳定；法条不误脱敏（白名单随引擎带入，如适用）。
3. **产物真实性**：四项导出真实落盘且内容完整（JSON 字段对齐 spec；Markdown 可读；留存说明存在）。
4. **三态**：处理中/失败（拒网或非法输入注入）/完成 三态真实可达且展示正确。
5. **出站基线**：`node scripts/pii-sanitizer.test.js` 5/5 原样通过；AI 出站链路行为零变化。
6. **expected-red 变异 ≥4**：删除遮蔽替换器（输出残留原文=检出）、破坏代称稳定性、删除命中统计（指标卡归零=检出）、移除入口按钮（功能不可达=检出）。
7. `node --check` 全部改动 JS；`git diff --check`=0；逐文件 SHA 入报告；allowlist/保护文件零漂移。

## 停止条件

产物落盘需要新的主进程 IPC/接口（保护文件）且无既有惯例可复用 → `blocked` 交 Codex intake；consult-notes 接线引发任何既有功能回归 → 立即回退该项并上报。
