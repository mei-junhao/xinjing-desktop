# SourceRef 模块交付报告 — XJ-4.2.1-codebuddy-calibration

> 角色：XinJing v4.2.1 纯领域模块工程师（独立 SourceRef 模块，不接入页面/Store）。
> 本任务**仅实现并测试独立模块**，未做生产代码审计、未触碰受保护文件、未使用真实数据。

## 1. task_id
`XJ-4.2.1-codebuddy-calibration`

## 2. 当前基线 commit
`a0de48f78c186ebf1347b88af5a6ff5aa3407276`
（注：本次只在 `app/js/source-ref.js` 与 `tests/v4.2.1-source-ref/**` 写入，尚未提交；rollback 仅回退本任务本地提交。）

## 3. fixture / 证据目录
- `app/js/source-ref.js`（实现，allowlist）
- `tests/v4.2.1-source-ref/fixtures-synthetic.js`（合成 fixture，synthetic=true）
- `tests/v4.2.1-source-ref/run-tests.js`（合成单测，纯 Node，无依赖）
- `tests/v4.2.1-source-ref/_sha256.log`（证据哈希清单）
- `tests/v4.2.1-source-ref/DELIVERY.md`（本报告）

## 4. 使用的数据生成规则
- 全部 fixture 标记为 `synthetic=true`；来访者用化名（化名-甲/乙），无任何真实姓名、路径、支付或临床个案。
- SourceRef id 由确定性字段派生：`sr:sha256(<schemaVersion|clientId|sessionId|anchor.kind|anchor.locator|anchor.fragment|normalizationVersion|sourceVersion|sourceContentHash|anchorContentHash>)`，幂等。
- 哈希使用项目既有风格的无依赖 SHA-256（`clinical-context.js` 的 `digest` 同算法），输出 `sha256:<hex>`。
- anchor.locator 仅接受受控相对键（如 `session:s_anon_001`）；绝对路径 / URL / `..` 遍历一律拒绝，永不进入 SourceRef。

## 5. 路由或功能覆盖数量
- 功能覆盖：`SourceRef.create` `verify` `migrateLegacy` `containsAbsolutePath` `normalizeAnchor` `sha256`（6 个 API）。
- 状态覆盖：**unchanged / changed / missing / ambiguous / legacy-unverified** 五态全部实现并测通；额外含关键规则 `warning` candidate。
- 合成单测：**39/39 通过**（`node tests/v4.2.1-source-ref/run-tests.js`）。
- 验收命令：`node --check app/js/source-ref.js` → `ACCEPTANCE_OK`。

## 6. 发现的问题及文件/行号
本子任务范围为独立模块实现，未对生产代码做全量审计；范围内**未发现 P0/P1**。仅记录一处实现内自检：
- 初版 fixture `caseChangedWithAnchorKept` 的 anchor 文本与基线 `ref` 不一致，导致锚点哈希不匹配、关键规则用例误判为 `changed`。已在 fixture 内对齐锚点文本后通过（见证据日志第 35-39 行）。属测试数据修正，非生产缺陷。

## 7. 每条问题的复现/实际/预期/级别
- 问题：关键规则用例（来源变、锚点仍匹配→应为 warning）初测得到 `changed`。
  - 复现：`verify(ref, caseChangedWithAnchorKept())`。
  - 实际：`status=changed`。
  - 预期：`status=warning, verified=false, candidate=true`。
  - 根因：fixture 锚点文本与基线 `ref` 不同，锚点哈希不匹配。
  - 级别：P3（测试数据问题，非模块缺陷）；已修复并复测通过。

## 8. 视觉矩阵完成情况
不适用。本任务为无 UI 的纯逻辑模块，不涉及视觉验收 / 视口 / Light-Dark 矩阵。

## 9. 未完成矩阵
- 路由清单、权益矩阵、ARIA/键盘、视口矩阵、Clinical/Theatre/Observatory 矩阵等：属“证据/盘点”角色范围，本 SourceRef 子任务未执行，不在此交付内。
- 真实数据对接、页面集成：按 contract 明确禁止接入，留待后续集成阶段。

## 10. 证据文件 SHA-256
```
68848b247f06418bdb72882b88689f365c5c059af42a0cb151602f81cb47793c  app/js/source-ref.js
e69c6d35d4c1dc94fa5420e5000f0506987196f3d1b392dca920b36df0e7f7ad  tests/v4.2.1-source-ref/fixtures-synthetic.js
6b24d120ce37e7d5ca487d862cb4a1a3f2b42936d6072c1ac842c9afd868071b  tests/v4.2.1-source-ref/run-tests.js
```
（来源：`tests/v4.2.1-source-ref/_sha256.log`，由 Node `crypto` 计算。）

## 11. 自评分
**98 / 100**（≥95，达标）。
- 满足 benchmark `contracts/v4.2.1-source-ref.json` 全部 requirements 与 acceptance 项。
- 五态 + 关键规则全部覆盖并通过合成单测。
- 零绝对路径、零生产代码改动、零真实数据、纯无副作用实现。
- 扣分项：尚未提交（本地未 commit，依据授权“仅允许本地改码与本地提交”待 Codex 决定提交时机）。

## 12. P0-P3
- P0：无。
- P1：无。
- P2：无。
- P3：测试 fixture 锚点文本对齐（已在本次内修复，见第 7 项）。

## 13. 是否建议 Codex 进入下一步
**建议进入下一步。** 本模块已完成、可单测、通过验收，且未触碰任何受保护文件或真实数据，符合 `write_lock_id: lock-XJ-4.2.1-codebuddy-source-ref` 与 `write_allowlist` 约束。下一步可由 Codex 决定是否本地提交，并安排后续将 `SourceRef` 接入 `clinical-context.js` 等调用方（不在本任务范围）。

---

## API 说明（contract 要求回传）
- `SourceRef.create({clientId, sessionId, anchor, sourceText, anchorText?, sourceContentHash?, anchorContentHash?, capturedAt?})` → 返回带 `id/clientId/sessionId/anchor/normalizationVersion/sourceVersion/sourceContentHash/anchorContentHash/capturedAt` 的 SourceRef 对象。任何必填缺失或 locator 含绝对路径/遍历则抛错。
- `SourceRef.verify(ref, current)` → `{status, verified, ...}`：
  - `unchanged`：来源与锚点哈希均匹配 → `verified:true`。
  - `changed`：来源内容哈希变更且锚点不再匹配 → `verified:false`。
  - `warning`：**来源内容已变但锚点仍匹配** → `verified:false, warning:true, candidate:true`（关键规则，绝不标记 verified）。
  - `missing`：`current` 为空/缺失。
  - `ambiguous`：clientId / sessionId / anchor.locator 任一不一致。
  - `legacy-unverified`：`ref` 缺 `schemaVersion` 或 `sourceContentHash`。
- `SourceRef.migrateLegacy(raw)` → 旧引用补算哈希并标记为 `legacy-unverified`，绝不声称 `verified`。
- `SourceRef.containsAbsolutePath(value)` / `SourceRef.normalizeAnchor(anchor)` → 只读校准工具。
- 导出方式：浏览器挂 `window.SourceRef`；Node 主进程 `require` 同文件得 `module.exports`；无新增依赖。

## 合成测试结果
`node tests/v4.2.1-source-ref/run-tests.js` → **通过 39 / 失败 0**，其中含关键规则用例 `status=warning, verified=false, candidate=true`。

## 限制
- 不访问 DOM / Store / App / IPC / 文件系统 / 网络；纯函数，可在渲染进程与主进程共用。
- 不修改 `clinical-context.js` 或任意调用方；调用方需自行对接。
- 锚点哈希仅基于提供的 `anchorText`（或定位位置抽取），调用方须保证 `anchorText` 与展示锚点一致。
- 本模块只负责“来源可追溯与变更预警”，不负责权限、计费或 UI 呈现。

## 集成建议
- 由调用方在生成临床上下文（如 `ClinicalContext.build`）时调用 `SourceRef.create` 附加到 sources，存储 `sourceContentHash/anchorContentHash` 以备后续 `verify`。
- 在材料/会谈被编辑后，用新内容调用 `SourceRef.verify`；结果为 `warning`/`changed` 时向用户呈现“来源可能已变”提示，**不得将 `warning` 当作 verified 引用**。
- legacy 数据通过 `migrateLegacy` 统一迁移，迁移对象不参与 `verified` 判定。
