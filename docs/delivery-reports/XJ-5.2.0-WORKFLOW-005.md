# XJ-5.2.0-WORKFLOW-005 交付报告

## 结果

已在 allowlist 内新增并返修受控 session-review 工作流：路由、metadata-only admission、显式确认、真实 AgentRun 状态机、注入式 draft executor、freshness 二次检查和 draft-ready。失败/stale/取消均转移 AgentRun 到对应终态；公开对象不含内部运行对象。无 Store、ClinicalContext、AI、网络、文件系统或持久化调用。

## 文件与验收

- app/js/clinical-agent-workflow.js
- tests/v5.2.0/clinical-agent-workflow.contract.test.cjs
- docs/delivery-reports/XJ-5.2.0-WORKFLOW-005.md
- 聚焦合同测试：exit 0，9/9 PASS（新增旧句柄失效与重复执行测试）
- 001-005 全量合同回归：exit 0，24/24 PASS
- 全部 node --check：exit 0
- git diff --check：exit 0
- 保护文件 SHA-256：exit 0，全部与任务卡一致

## 覆盖与失败历史

覆盖正向生命周期、未知/歧义任务、缺失身份/source、stale、确认门、取消、executor failure、malformed draft、执行前后 freshness、无持久化 spy 和敏感字段泄漏。此前 intake 拒绝原因是失败路径未调用 Runs.transition 且 projection 泄漏内部运行对象。本轮新增 WeakMap 内部状态与统一 failure transition，并移除公开运行对象；修复后全部通过。

## P0-P3 与范围

P0=0，P1=0，P2=0，P3=0。仅修改 allowlist 三文件；未提交、合并、推送、发布；未接触真实临床数据、网络、Electron、UI、Store、ClinicalContext、AI 或持久化。

## 内部对抗审查

- 删除显式确认门：confirmation false 与 executor 未调用断言失败。
- 删除 freshness 二次检查：stale-after 场景失败。
- 注入持久化函数：无持久化调用入口，spy 保持 0。
- 去掉 await：异步 executor 结果无法提前形成 draft-ready。
- 替换 router/bridge/run：依赖缺失 fail closed；默认入口真实调用 AgentRun create/transition。
- 让 projection 携带 body/content/prompt/rawText/modelInput：敏感字段测试失败，当前实现不会泄漏。
- 删除失败 transition：注入式状态轨迹断言失败，当前实现覆盖 stale/failed/cancelled。
- 删除确认门或二次 freshness：注入式行为测试失败。
- 伪造 running/cancel 状态：WeakMap membership 测试失败，adapter/executor 调用次数保持 0。
- 重放旧 confirmed/prepared 句柄：旧 key 已删除，第二次 execute/confirm 稳定失败且不调用 adapter；终态新句柄 cancel 仍幂等。

剩余风险：真实 ClinicalContext/supervision-core adapter 不在本任务范围，须由后续 ADAPTER-006 提供并独立验收。

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-WORKFLOW-005.md
