# XJ-5.0.0 Sol Max：v4.5 更新完整性、数据迁移回退与失败回滚候选 279

这是交给用户直接控制的外部 Sol Max 的全新隔离任务卡。它不是 270 的续跑，不是 277 的返工，不是 278 的替代，也不代表生产集成或发布。Codex 只创建任务卡和冻结输入，不启动、创建或代替外部 Sol。Sol 交付后仍需 Codex 独立 intake；`delivered` 不等于 `accepted`，更不等于版本完成。

## 1. 任务身份与硬边界

```yaml
task_id: XJ-5.0.0-sol-v4.5-update-integrity-rollback-candidate-279
task_state: planned-not-started
objective: 在隔离候选中补齐并证明 v4.5 Electron 更新完整性、安装版/便携版通道隔离、更新前安全快照、数据迁移失败保护、首次启动健康检查和失败回滚闭环；不得修改生产树。
owner: external-sol
manager: codex
dispatch: external-user-controlled; Codex must not start or create Sol
project_root: D:/xinjing-electron
branch_or_worktree: release/3.6.3-mac；不得切换分支，不得 reset、clean、checkout、merge、commit 或 push
base_commit: 9971787eb6e443ab5a5c80aee118b9b43285c093
source_state: 2026-08-03 dirty worktree 的只读快照；所有结论绑定 manifest，不得把 base_commit 当作快照内容
active_release_train: 5.0.0/implementation/rt-5.0.0-0001
config_evidence_id: external-sol-user-confirmed-gpt-5.6-sol-max-20260803-task279
agent_profile_id: gpt-5.6-sol-max-user-confirmed-unverified
provider: codex-platform
model: gpt-5.6-sol
reasoning: max
runtime_identity_evidence: user-confirmed; platform tool not independently verified
execution_shape: external-sol-direct-isolated-task
timeout_policy: none
timeout_seconds: null
max_iterations: 0
contract_id: v4.5-update-integrity-rollback-v1 + v5.0-development-boundary-v1
contract_sha256: 3E0AF7FBFE0F0247467C894326971032377FF0EBB1F9E132453A4ECEC290F809; 96A49B1373653763F599B21359F605DA6FA6D48E47B91CB321B9E5D7172137E9
protected_files_manifest: D:/xinjing-electron/docs/agent-coordination/v5.0.0/cli-coordination/runs/XJ-5.0.0-sol-v4.5-update-integrity-rollback-candidate-279/workspace/input/INPUT_MANIFEST.json
protected_files_manifest_sha256: 0C88E3CAC5D69097E3F9505F5D1DFA68D8F44D2CA7861DEE84572AFB6592E17A
benchmark_manifest: same as protected_files_manifest; recompute every listed path, byte count and SHA-256 before inspection and before delivery
visual_baseline: not-applicable; this task must not claim visual UI completion
run_directory: D:/xinjing-electron/docs/agent-coordination/v5.0.0/cli-coordination/runs/XJ-5.0.0-sol-v4.5-update-integrity-rollback-candidate-279
agent_delivery_report: D:/xinjing-electron/docs/agent-coordination/v5.0.0/cli-coordination/runs/XJ-5.0.0-sol-v4.5-update-integrity-rollback-candidate-279/workspace/delivery/DELIVERY_REPORT.md
codex_intake_report: D:/xinjing-electron/qa/agent-reviews/XJ-5.0.0-codex-intake-sol-v4.5-update-integrity-rollback-candidate-279.md
write_lock_id: lock-XJ-5.0.0-sol-v4.5-update-integrity-rollback-candidate-279
write_lock_mode: isolated-run-only; planned card only, no live production lock
```

### 不可改变的执行限制

1. 只能使用实际可证明的 `gpt-5.6-sol` + `max`。实际执行器、模型、推理档位和工具能力必须从运行证据确认，不能从本卡自述推断；不匹配就写 `BLOCKED` 并停止。
2. 本任务没有总墙钟超时。支持时必须使用 `--max-iterations 0`；runner、wrapper、提示词和外层 supervisor 不得设置有限总任务上限。单个测试或 Electron 子进程可以有防止永久挂死的局部安全上限，但报告必须把它与任务超时分开。
3. 第一项真实写入必须从 `workspace/delivery/REPORT_SKELETON.md` 创建 `workspace/delivery/DELIVERY_REPORT.md`，并立即保留严格末行。长代码、日志、证据和报告必须写文件，对话只返回绝对报告路径和短摘要。
4. 只使用本任务快照和本任务生成的合成 feed、合成 EXE/portable 字节、合成用户数据和合成 updater adapter。禁止真实网络、真实 COS、真实账户、真实临床材料、真实密钥、真实 token、真实支付、真实安装器和外发。
5. 只允许隔离候选写入。禁止修改 live checkout、任务账本、写锁、合同、release train、AGENTS、Git 元数据、其他 run 或远程文件。
6. 不得执行 `npm install`、`npm ci`、`npm pack`、`npm run pack`、electron-builder、签名、上传、推送、发布或远程 manifest 更新。缺依赖时如实记录环境阻塞，不用联网安装掩盖。

## 2. 为什么现在立项

权威计划第 19.3、19.6、27.1、27.3、27.4 要求：

- Electron 升级不能造成数据迁移损失，并且必须有回退方案；
- 更新失败必须可回滚；
- unpacked、NSIS、portable、更新元数据、升级和回滚属于独立证据；
- 回滚不能通过删除用户数据完成；
- `latest.yml` / `latest-portable.yml` 的版本、文件、SHA-512、channel 必须与最终字节一致。

当前工作树已有 `main.js` 的自动更新接线和 `scripts/postbuild.js` 的元数据生成，但当前版本准备度核对仍把“升级无数据迁移回退”和“更新失败可回滚”列为 `incomplete/stale`。历史任务 196 只形成了只读缺口矩阵，并没有当前候选、真实状态机、安装版/便携版失败演练或与当前脏快照绑定的完整证据。

这张卡的目的不是重新写一个静态 updater demo，而是让外部 Sol 在独立候选中回答：

1. 下载的字节是否确实是用户确认的、正确 channel 的、元数据哈希匹配的 artifact？
2. 在替换文件或迁移 durable 数据前，是否有经过认证且可验证的安全快照？
3. 更新进程在下载失败、校验失败、迁移失败、子进程崩溃、首启健康检查失败和便携覆盖失败时，是否能明确落入失败/回滚，而不是假成功或静默丢数据？
4. NSIS 安装版和 portable 便携版是否各自只消费自己的产物和回滚策略？
5. 重启后是否能从原子 recovery marker 恢复决策，并阻止旧 pending 状态覆盖新成功状态？

本任务不改变 270 的商业主进程/Preload/AI IPC 结论。270 仍未完成，不能因 279 交付而标记完成。277 的账户 UI 和 278 的可信 AI 内核也不在本卡范围。

## 3. 冻结输入与读取顺序

输入根目录：

`D:/xinjing-electron/docs/agent-coordination/v5.0.0/cli-coordination/runs/XJ-5.0.0-sol-v4.5-update-integrity-rollback-candidate-279/workspace/input/`

清单：

`workspace/input/INPUT_MANIFEST.json`

冻结输入至少包含：

- `authority/AGENTS.md`
- `authority/development-plan.md`
- `authority/release-train.yaml`
- `authority/v5.0-development-boundary-v1.md`
- `authority/v4.5-update-integrity-rollback-contract-v1.md`
- `authority/KNOWN_GAP.md`
- `source/main.js`
- `source/preload.js`
- `source/package.json`
- `source/package-lock.json`
- `source/version.generated.js`
- `source/scripts/postbuild.js`
- `source/scripts/self-test.js`
- `source/scripts/agent-electron-acceptance.ps1`
- `source/app/js/backup-crypto.js`
- `source/tests/v5.0.0-disposable/codex-v4.5-encrypted-backup-passphrase/restore-failure-and-main-contract.js`

严格开工顺序：

1. 读取本任务卡和 `workspace/input/INPUT_MANIFEST.json`；
2. 重算清单中每个路径的存在性、字节数和 SHA-256，任何漂移立即写 `BLOCKED`，不得从 live checkout 补文件；
3. 读取 `workspace/delivery/REPORT_SKELETON.md`，第一项真实写入创建 `DELIVERY_REPORT.md` 并保留末行；
4. 读取 authority 文件，特别是任务专属契约和 `KNOWN_GAP.md`；
5. 记录实际 runner、模型、推理档位、工具能力、工作目录、网络策略和 session shape；
6. 从输入快照复制候选副本到 `workspace/candidate/repo`；输入目录保持只读；
7. 先运行 expected-red/current-state matrix，再开始候选修改；
8. 只有 Checkpoint A 全部通过才进入实现或修复。

不得读取其他 run 作为当前输入替代。历史证据只能通过本卡和 `KNOWN_GAP.md` 提供的摘要使用。

## 4. 候选写入范围

### 允许写入

只允许写入本任务 run 目录：

- `workspace/candidate/repo/main.js`，只允许更新相关责任区；不得顺手改动商业、AI、临床、IPC、Store、权益或窗口安全逻辑；
- `workspace/candidate/repo/preload.js`，只有为了更新检查结果的最小类型化桥接才可改；不需要时保持字节不变；
- `workspace/candidate/repo/scripts/postbuild.js`，只允许与更新 artifact metadata 一致性相关的最小候选变更；不执行真实构建；
- `workspace/candidate/repo/update/**`，可新增任务专属的 feed validator、transaction journal、rollback/recovery adapter；
- `workspace/tests/**`；
- `workspace/evidence/**`；
- `workspace/scratch/**`；
- `workspace/delivery/DELIVERY_REPORT.md`；
- run 根目录的 stdout、stderr、transcript、usage、machine-result 和 wrapper 元数据。

### 禁止写入

- live `D:/xinjing-electron` 下任何文件；
- `workspace/input/**`、任务卡、任务账本、写锁、合同、release train、AGENTS 和其他 run；
- `package.json`、`package-lock.json`、`version.generated.js` 的候选修改；
- `store.js`、`entitlements.js`、商业账户、余额、价格、计费、AI、ClinicalContext、XJSUP、recipient-grant、授权、支付、订单和用户临床对象；
- 真实更新源、COS、真实 EXE、真实安装器、真实凭据、真实账户、真实网络、真实临床数据；
- 生产包、签名、上传、推送、发布、远程 manifest 和版本生命周期状态。

候选只能从输入快照复制。候选变更必须同时列出修改前失败证据、最小行为变化、修改后正向/负向证据、文件 hash 以及为什么没有扩大契约。

## 5. 必须完成的工作包

### A. Feed metadata 和 artifact 完整性

通过真实候选更新入口和合成 loopback feed，验证安装版与 portable 版 metadata：

- 版本、channel、artifact path/url、文件大小、SHA-512、release date 和必要字段有明确 schema；
- `latest.yml` 与 `latest-portable.yml` 不可互换；artifact 文件名不能通过 `..`、绝对路径、UNC 路径或 URL scheme 越界；
- metadata 宣称的 bytes、size 和 SHA-512 必须与实际 synthetic artifact 完全一致；
- 空字段、重复 files、多个候选、未知 channel、错误版本、错误 hash、错误 size、非法 base64、非有限 size、过期/回退版本和混合 channel 必须 fail-closed；
- feed 不可达、HTTP 4xx/5xx、响应过大、解析失败和 artifact 缺失不得进入 install；
- 不能用源码字符串匹配代替实际 parser/validator 行为。

如果当前工程没有 YAML 解析依赖，不得联网安装；应选择不引入依赖的、边界明确的解析方式，或如实将该候选能力标为 blocked，并记录为何不能安全解析。

### B. Update transaction 状态机和原子 recovery marker

在候选内实现或补齐最小状态机，至少区分：

`discovered -> awaiting-confirmation -> downloading -> verified -> backup-created -> staged -> restarting -> health-check -> committed`

失败结果至少包括：

`feed-unavailable`、`metadata-invalid`、`artifact-mismatch`、`channel-mismatch`、`download-failed`、`backup-failed`、`migration-failed`、`replacement-failed`、`health-check-failed`、`stale-pending`、`rollback-failed`。

要求：

- 未经用户确认不能下载或安装；检查、下载、安装和回滚必须是可区分的异步结果；
- 非法跳转、重复提交、旧事件覆盖新事件、缺 operation id、跨 channel 恢复和未知状态都 fail-closed；
- journal/marker 只保存版本、channel、artifact hash、operation id、状态、时间和稳定错误码，不保存临床正文、提示词、API key、token、完整路径或 provider body；
- journal/marker 使用任务候选内的原子写入策略，测试中必须注入写半截、rename 失败、读取损坏和并发旧写；
- `committed` 必须发生在首启健康检查和必要数据迁移确认之后；
- crash/restart 后的 recovery 必须是幂等的，不能把已提交版本回退成 pending，也不能把未验证版本标成 committed。

### C. 更新前安全快照、迁移保护与数据不丢

使用冻结的 `backup-crypto.js` 或任务内合成 safety adapter，不接触真实数据，证明：

- 更新前安全快照先完成并通过完整性验证，再允许 durable migration 或 exe replacement；
- 快照失败、口令/密钥错误、认证失败、payload hash mismatch、目标目录不可写时，当前安装和当前合成数据保持不变；
- migration 失败时回到上一稳定数据版本，不能通过删除数据库、清空集合或吞掉错误实现“回滚”；
- 新版本无法读取旧数据时必须停止提交并保留旧版本可恢复路径；
- 恢复报告只包含合成对象计数、版本、hash 和稳定错误码，不把正文写入 report/log/DOM。

### D. NSIS 与 portable 双通道更新/回滚

用 synthetic installer/portable adapter 进行真实状态调用，覆盖：

- NSIS：下载确认、旧版本保持、覆盖安装失败、安装后首次启动失败、回滚到上一稳定安装包；
- portable：当前 exe 解锁等待、临时新 exe、旧 exe 保留、替换失败、重启失败、旧进程未退出和回滚；
- 安装版不可消费 portable artifact，portable 不可消费 setup artifact；
- 两个 channel 的 metadata、artifact hash、版本和回滚目标始终一致；
- 旧进程、子进程和 helper 失败时，不得留下会在下次启动盲目覆盖的无限 retry 脚本；
- 不执行真实 `cmd.exe` 覆盖、真实安装器或真实更新源；若生成 Windows helper 文本，只能在临时合成目录中作为数据验证，并证明路径和参数没有越界。

### E. 真实入口和证据闭环

优先使用候选副本的真实 Electron/Chromium 入口、明确临时 userData、合成 adapter 和默认拒绝外网的 wrapper。至少验证：

1. `xj:check-updates` 或候选等价更新入口的真实调用链；
2. 用户确认前不下载、确认后才进入 download；
3. update available/not available/error/downloaded 的异步反馈顺序；
4. 关闭、重启和首启健康检查的实际状态；
5. 失败后旧数据与旧版本 marker 的保留；
6. 控制台无未处理异常、无 secrets/tokens/临床正文和无真实网络成功请求。

Electron、Chromium 或安全 acceptance wrapper 不可用时，必须保留准确环境错误并将对应 gate 标为 `BLOCKED`，不能用静态检查冒充真实运行。

## 6. 必须执行的任务本地命令

在 `workspace/tests/` 创建并运行，保留 stdout、stderr 和退出码：

```text
node workspace/tests/run-feed-integrity-contract.js
node workspace/tests/run-update-state-machine.js
node workspace/tests/run-backup-migration-protection.js
node workspace/tests/run-nsis-portable-parity.js
node workspace/tests/run-electron-update-runtime.js
node workspace/tests/mutation-probes.js
node workspace/tests/internal-adversarial-review.js
node workspace/tests/verify-artifacts.js
```

另行对每个候选 JavaScript 执行 `node --check`。不得执行构建、打包、签名、上传或真实 installer。若某个命令因环境不可用而不能执行，必须把原始输出、退出码、环境身份和影响范围写入报告。

## 7. Expected-red、反向变异与内部对抗审查

候选修改前先运行 expected-red/current-state matrix，不能因为现有 self-test 绿色就跳过。之后每一项变异都必须在全新的临时候选副本中先证明字节发生变化，再执行真实入口行为测试。至少击杀以下变异：

1. 接受错误 channel 或把 `latest.yml` 当作 `latest-portable.yml`；
2. 忽略 artifact size 或 SHA-512；
3. 接受 `..`、绝对、UNC 或带 scheme 的 artifact path；
4. 把旧版本、混合版本、空版本或未知版本标成可更新；
5. 在用户确认前开始下载或安装；
6. 下载失败后继续进入 verified/staged；
7. 删除 `await`，在 backup/migration/health 尚未完成时反馈成功；
8. 使用旧缓存或旧 metadata 覆盖新 update operation；
9. 把 backup failure 当成可忽略告警；
10. migration failure 后清空或删除用户数据来伪造回滚；
11. 首启 health check 失败仍提交新版本；
12. portable 消费 setup artifact，或 NSIS 消费 portable artifact；
13. 替换失败后删除旧 exe/旧版本 marker；
14. 损坏 journal/recovery marker 被解析为 committed；
15. 同一 operation id 被重复执行成两次替换或两次迁移；
16. 将 raw path、prompt、token、credential、clinical body 或 provider body 写入 marker/log/report；
17. 用真实 COS/网络响应或历史截图替代合成输入；
18. 用 mini handler、字符串扫描、mock page 或旧 artifact hash 冒充真实候选入口；
19. 让 Free 手动数据流程因更新失败而不可用；
20. 把 rollback-failed 伪装为 success，或对非幂等 replacement 无限重试。

内部对抗审查必须单列章节，列出每次攻击、原始结果、未覆盖项、主动否决的 PASS、剩余风险和为何没有扩大范围。任何关键变异存活、异步未等待、数据被删除、旧结果覆盖新结果、真实入口未执行或报告 hash 不一致时，结论必须是 `FAIL` 或 `BLOCKED`，不得用分数抵消。

## 8. Checkpoints、停止与回滚

### Checkpoint A

报告已创建；manifest、task card、task-local contract、输入数量和 hash、真实执行器/模型/档位、候选范围、网络策略和停止条件全部记录。任何不匹配先停。

### Checkpoint B

报告分别列出 feed 校验、状态机、快照/迁移、NSIS/portable、真实 Electron 和失败路径的 confirmed/incomplete/blocked 证据。不得把静态检查或旧证据写成 runtime PASS。

### Checkpoint C

交付前重算输入 manifest、候选文件、测试、日志、证据和报告 hash，检查 allowlist、越界写入、网络拒绝、异步等待和反向变异。每项声明分类为 `confirmed`、`stale`、`false`、`incomplete`、`blocked` 或 `out-of-scope`。

立即停止：输入漂移、未知写入、270/277/278 范围扩张、商业/AI/XJSUP/临床契约变化、真实网络或数据、需要新架构决定、候选/live 混淆、关键变异存活、无法证明真实入口或需要不可逆操作。

回滚只能清理未验收的任务候选或 scratch；不得触碰 live checkout、输入快照、历史失败证据、任务账本或其他 run。失败身份不得重放；需要再做必须新建任务、manifest、run 和报告路径。

## 9. 交付报告必须包含

- 实际 runner、执行器、provider/model/reasoning、session shape、工具能力、工作目录和网络策略；
- task card、输入 manifest、task-local contract、候选、测试、日志和报告的 SHA-256；
- 输入快照与候选实际差异、allowlist、保护文件和越界检查；
- `update check -> user confirmation -> feed metadata -> artifact bytes -> backup -> migration -> stage -> restart -> health -> commit/rollback` 的真实调用链；
- NSIS/portable 双通道、错误状态、恢复 marker、旧版本和数据快照证据；
- 所有命令、工作目录、退出码和原始 stdout/stderr 路径；
- expected-red、20 项反向变异和内部对抗审查；
- P0-P3、受最弱证据约束的评分、残余风险和 Codex 下一步；
- 明确列出未执行的真实网络、打包、签名、上传、发布和生产集成；
- 绝不声称 270 已完成，绝不声称 5.0 release-ready、publish-authorized 或 released。

最终报告最后一行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/agent-coordination/v5.0.0/cli-coordination/runs/XJ-5.0.0-sol-v4.5-update-integrity-rollback-candidate-279/workspace/delivery/DELIVERY_REPORT.md

## 10. 可直接复制给外部 Sol 的执行提示

你是用户直接控制的外部 Sol Max，执行 XinJing 5.0 Task 279。先读完整任务卡和 `workspace/input/INPUT_MANIFEST.json`，不要读取其他 run，不要把 live checkout 当作输入替代。第一项真实写入必须从 `REPORT_SKELETON.md` 创建 `DELIVERY_REPORT.md` 并立即保留严格末行；长内容全部写文件，对话只返回绝对报告路径和短摘要。

严格使用 `gpt-5.6-sol` + `max`；实际身份无法确认或不匹配立即 `BLOCKED`。本任务没有总超时，使用 `--max-iterations 0`，不得设置有限总任务上限。只写本任务 run 的 allowlist 候选、测试、证据、scratch 和报告。先校验 manifest，再复制候选，再跑 expected-red，再做最小修改。

完成前必须执行 feed integrity、update state machine、backup/migration protection、NSIS/portable parity、真实 Electron runtime（可用时）、反向变异、内部对抗审查和 artifact verification。任何真实网络、真实数据、真实安装器、打包、签名、上传、推送、发布、270/277/278 范围扩张或共享契约决策都必须写成 `BLOCKED`，不得伪造 PASS。先自审再交付，报告必须有 P0-P3、最弱证据评分、残余风险和下一步，最后一行严格使用本卡规定的 `DELIVERY_REPORT` 路径。
