# Reasonix Task 294 Prompt

你是 XinJing 的隔离候选执行器。先读取 `TASK_CARD.md`、项目 `AGENTS.md`（如已在 input 中提供）和 `workspace/input/INPUT_MANIFEST.json`。第一项真实写入必须立即把 `workspace/delivery/REPORT_SKELETON.md` 复制/展开为 `workspace/delivery/DELIVERY_REPORT.md`，保留严格末行；长内容全部写报告和 evidence 文件，最终对话只返回一行短确认。

本任务不是 Task 286 的重放。Task 286 只提供问题背景；你必须使用本任务自己的输入快照、候选副本、测试、日志、哈希和报告。

目标：修复可信 AI 来源上下文真实 fail-open。用候选真实入口构造一个绑定 transcript/summary 任务，分别清空所有来源的 `clientId`、所有来源的 `sessionId`、两者同时清空；先记录修复前 expected-red，再在 `workspace/candidate/repo` 中修复，使三种输入都稳定 fail-closed。不能填默认客户/会谈，不能把空字符串当绑定成功，不能吞掉拒绝结果，不能只改测试。

只允许写 `workspace/candidate/**`、`workspace/tests/**`、`workspace/evidence/**`、`workspace/scratch/**`、`workspace/delivery/**` 和本任务运行证据。不得写 `workspace/input/**`、live project、`main.js`、`preload.js`、`ai.js`、`store.js`、商业模块、共享契约、release/ledger/lock、其他 run，不得联网、使用凭据、启动 agent、打包、签名、上传、push 或 publish。

必须真实运行：输入哈希前后验证；expected-red；正向和三种缺失字段合同；跨 client/session、未知/隔离/过期、缺 hash、错误 schema、preview-only 和人工确认边界；`node --check`；`node workspace/tests/source-context-fail-closed-contract.js`；`node workspace/tests/mutation-probes.js`；`node workspace/tests/internal-adversarial-review.js`；`node workspace/tests/verify-artifacts.js`。每个命令保存 stdout、stderr、退出码。

必须做一次字节级反向变异：放宽缺失 `clientId` 或 `sessionId` 的拒绝后，真实候选合同必须失败；变异没有改变字节、测试没有经过真实入口、PASS 文本和非零退出冲突或从 live project 偷读依赖，都必须标为 BLOCKED/FAIL。内部对抗审查要覆盖删除 await、吞 `{ok:false}`、默认上下文、只改测试、live-project 偷读和空字符串归一化。

不要声称生产接入、版本完成或百分比变化。完成后将完整报告写入：

`D:/xinjing-electron/docs/agent-coordination/v5.0.0/cli-coordination/runs/XJ-5.0.0-cli-reasonix-v4.4-trusted-ai-source-context-fail-closed-repair-294/workspace/delivery/DELIVERY_REPORT.md`

最终对话只返回：`已写入文件: <绝对报告路径> | 摘要: <短状态>`。
