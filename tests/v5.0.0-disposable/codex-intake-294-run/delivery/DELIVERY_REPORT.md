# Task 294 Delivery Report

## Identity

- task_id: `XJ-5.0.0-cli-reasonix-v4.4-trusted-ai-source-context-fail-closed-repair-294`
- status: delivered (isolated candidate only; NOT production-accepted)
- owner: `reasonix-cli`
- manager: `codex`
- base_commit: `9971787eb6e443ab5a5c80aee118b9b43285c093`
- active_release_train: `5.0.0/implementation/rt-5.0.0-0001`
- config_evidence_id: `reasonix-1.18.0-token-deepseek-v4-flash-0731-direct-health-20260803`
- agent_profile_id: `cli:reasonix-1.18.0-direct-run-token/deepseek-v4-flash-0731-effort-max`
- model: `token/deepseek-v4-flash-0731`（任务卡声明；平台工具未独立验证）
- effort: `max`（任务卡声明；平台工具未独立验证）
- execution_shape: `direct-cli-reasonix-isolated-candidate`
- timeout_policy: `bounded-cli-only` / `timeout_seconds: 1800` / `max_steps: 0`
- output_format: `stream-json`
- contract_id: `v4.4-ai-evaluation-fixture-v1 + v4.4-longitudinal-summary-v1 + v4.4-prompt-governance-v1 + v5.0-development-boundary-v1`
- write_lock_id: `lock-XJ-5.0.0-cli-reasonix-v4.4-trusted-ai-source-context-fail-closed-repair-294`
- production_write: `false`
- shared_contract_write: `false`
- delivery_report: `D:/xinjing-electron/docs/agent-coordination/v5.0.0/cli-coordination/runs/XJ-5.0.0-cli-reasonix-v4.4-trusted-ai-source-context-fail-closed-repair-294/workspace/delivery/DELIVERY_REPORT.md`

## 结论摘要

在全新不可变的 Task 286 候选快照上，修复了可信 AI 来源上下文的真实 fail-open：对已绑定 transcript/summary 任务的来源，清空所有 `clientId`、所有 `sessionId`、或两者同时清空时，候选真实入口现在稳定 fail-closed（`{ok:false}`，且不创建 action run）。修复点只有一个：`candidate/repo/app/js/clinical-context.js` 的 `validateSources` 准入门。未填默认客户/会谈、未把空字符串当绑定成功、未吞掉拒绝结果、未只改测试。候选仍只停留在隔离目录，未改变 5.0 百分比，未触碰生产树。

## Evidence Checklist

- [x] Input manifest and hashes before work — ALL_MATCH（12/12，会话首次执行，exit 0）
- [x] Expected-red reproduces all three missing-context cases — evidence/expected-red/（7 个观察全部 admitted=true，exit 1）
- [x] Candidate implementation and real boundary tests — clinical-context.js validateSources 修复；source-context-fail-closed-contract.js 12 断言
- [x] Positive and failure-path tests — 正向（transcript/summary build/prepare/action-run）+ 7 个缺失上下文失败路径 + 既有 3 份合同
- [x] Byte-applied reverse mutations killed — M09/M10/M11 applied=true, killed=true, exit 1
- [x] Internal adversarial review — 18/18
- [x] Artifact hashes and input hashes after work — artifact-verification.json + input-manifest-after.txt ALL_MATCH
- [x] P0-P3, residual risks and production integration gaps — 见下文

## 输入 manifest 前后验证

- 开始前（会话首次执行 `node tests/verify-input-manifest.js`，后移至 `tests/verify-input-manifest.js`）：12/12 OK，`ALL_MATCH`，exit 0。此运行证据在会话 transcript；结果与 evidence/input-manifest-after.txt 逐项一致。
- 结束后（`node workspace/tests/verify-input-manifest.js`，输出 evidence/input-manifest-after.txt）：`ALL_MATCH`，exit 0。
- `workspace/input/**` 全程未写入（写集之外，只读）。

## Expected-red（修复前）

合同 `tests/source-context-fail-closed-contract.js` 在修复前运行（真实候选入口：`ClinicalContext.validateSources` / `ClinicalContext.createActionRun` / `LongitudinalSummary.prepare` / `LongitudinalSummary.createPreviewActionRun`），输出见 `evidence/expected-red/stdout.txt`、`stderr.txt`、`exit.txt`（exit 1）。观察结果：7 个用例全部 fail-open：

| 用例 | 入口 | admitted | reason | runCreated |
|---|---|---|---|---|
| transcript/all-sources-clientId-cleared | validateSources/createActionRun | true | null | true |
| transcript/all-sources-sessionId-cleared | validateSources/createActionRun | true | null | true |
| transcript/all-sources-clientId-and-sessionId-cleared | validateSources/createActionRun | true | null | true |
| transcript/all-sources-clientId-whitespace | validateSources | true | null | - |
| summary/all-sources-clientId-cleared | validateSources/createPreviewActionRun | true | null | true |
| summary/all-sources-sessionId-cleared | validateSources/createPreviewActionRun | true | null | true |
| summary/all-sources-clientId-and-sessionId-cleared | validateSources/createPreviewActionRun | true | null | true |

即：修复前，清空来源上下文既通过准入又创建了 action run —— 这就是要修的真实 fail-open（不是源码字符串检查）。

## 根因与修复

根因（`candidate/repo/app/js/clinical-context.js` `validateSources`，原 119-120 行）：

```js
if (origin.clientId && text(source.clientId) && text(source.clientId) !== text(origin.clientId)) return { ok: false, reason: 'source-client-mismatch', index: index };
if (origin.sessionId && text(source.sessionId) && text(source.sessionId) !== text(origin.sessionId)) return { ok: false, reason: 'source-session-mismatch', index: index };
```

守卫条件要求「source 字段非空才检查一致性」，因此来源缺失 `clientId`/`sessionId` 时检查被整体跳过 → fail-open。这与 `source-ref.js` 已冻结的契约（`normalizeRecord`：`if (!clientId || !sessionId) return null;`，注释「任一为空即拒绝」）不一致——准入门没有执行同样的契约。

修复（同一函数内，缺失检查置于一致性检查之前）：

```js
// 来源上下文契约（fail-closed）：每条准入来源必须同时携带 clientId 与 sessionId，
// 与 source-ref.js 的冻结契约一致（任一为空即拒绝）。不得用默认客户/会谈、
// 空字符串归一化或捕获异常后放行来绕过；origin 已绑定时还必须与 origin 一致。
if (!text(source.clientId)) return { ok: false, reason: 'source-client-missing', index: index };
if (!text(source.sessionId)) return { ok: false, reason: 'source-session-missing', index: index };
if (origin.clientId && text(source.clientId) !== text(origin.clientId)) return { ok: false, reason: 'source-client-mismatch', index: index };
if (origin.sessionId && text(source.sessionId) !== text(origin.sessionId)) return { ok: false, reason: 'source-session-mismatch', index: index };
```

行为语义：任一来源缺 `clientId` → `source-client-missing`；任一来源缺 `sessionId` → `source-session-missing`；与已绑定 origin 不一致仍走原有 `-mismatch` 拒绝。`build`/`createActionRun`/`LongitudinalSummary.prepare`/`createPreviewActionRun` 都经由此门传播 `{ok:false}`（不吞拒绝、不填默认值）。全量 diff 见 `evidence/candidate-diff.txt`：仅 `app/js/clinical-context.js` 变更，其余 5 个候选文件与输入逐字节一致。

## 修复后行为（正向 + 三种缺失字段 + 跨上下文）

`node workspace/tests/source-context-fail-closed-contract.js`（输出 evidence/contract-post-fix.txt）：exit 0，assert phase `pass=12, fail=0`。

- 正向：transcript build ok:true、validateSources ok:true、createActionRun 创建 run；summary prepare ok:true、createPreviewActionRun 创建 run。
- 三种缺失字段 × transcript/summary 两入口：7 个观察全部 `admitted=false`、`runCreated=false`，reason 为 `source-client-missing` / `source-session-missing`（白空格 clientId 也按缺失拒绝，无 trim-and-continue 归一化）。
- 既有边界保留（未回归）：跨 client（source-client-mismatch）、未知来源 kind、隔离/不可准入 status、缺 hash、错误 output schema、preview-only 拒绝 durable-save、异步 await 等待 —— 由 trusted-ai-provenance-governance-contract.js（22 pass）、longitudinal-summary-candidate-contract.js（15 pass）、prompt-governance-candidate-contract.js（11 pass）三者全部 exit 0 证明。

## 验收命令原始结果

（均在 run 根目录以 `node workspace/tests/...` 形式执行；stdout/stderr/退出码已存档）

| 命令 | exit | 结果 | 证据 |
|---|---|---|---|
| `node workspace/tests/source-context-fail-closed-contract.js` | 0 | pass=12 fail=0 | evidence/contract-post-fix.txt |
| `node workspace/tests/mutation-probes.js` | 0 | total=11 killed=11 survived=0 | evidence/mutation-probes.txt |
| `node workspace/tests/internal-adversarial-review.js` | 0 | pass=18 fail=0 | evidence/internal-adversarial.txt |
| `node workspace/tests/verify-artifacts.js` | 0 | artifacts=6, tests=6, failed=0, pass=true | evidence/verify-artifacts.txt + artifact-verification.json |
| `node --check` 六个候选 JS | 0 | 全部通过 | evidence/node-check-commands.txt + artifact-verification.json syntaxExitCode=0 |

## 字节级反向变异（关键变异）

`mutation-probes.js` 对**临时副本**（`fs.cpSync(CANDIDATE, tmpRoot)`，非工作候选、非 live project）做字节替换（`fs.writeFileSync` 整文件重写，`beforeHash !== afterHash` 确认已应用），再以 `XJ_CANDIDATE_ROOT=tmpRoot` 运行真实合同：

- M09 `source-client-missing-relaxed`：`if (!text(source.clientId)) ...` → `if (false && ...)`：applied=true, killed=true, exit 1 —— 合同失败（reason 退化为 source-client-mismatch，缺失断言被触发）。
- M10 `source-session-missing-relaxed`：同型放宽 sessionId：applied=true, killed=true, exit 1。
- M11 `source-context-guard-fully-reverted`：两条缺失守卫同时放宽：applied=true, killed=true, exit 1。
- 既有 M01-M08 全部仍被杀死（含 M02 跨客户、M05 缺 hash、M07 删 await、M08 live-project 偷读探测）。

结论：放宽缺失 clientId/sessionId 拒绝的字节变异必然被真实候选合同杀死；变异未应用、测试跳过或假绿均判 BLOCKED 的情况未出现。

## 内部对抗审查

章节见 `evidence/internal-adversarial.txt`（18/18 pass）。主动尝试的攻击与原始结果：

| 攻击 | 探针 | 原始结果 |
|---|---|---|
| 只改测试不改真实入口 | A13 字节级回退真实入口守卫 → 跑合同 | 合同失败（exit 非 0）→ 证明修复在真实入口 |
| 删除 `await` | A14 删 longitudinal-summary 投影 await → 跑 summary 合同；M07 同型 | 合同失败（projection 未就绪）→ 被杀死 |
| 吞掉 `{ok:false}` | A15 拒绝后仍调用 createActionRun | 返回 null，不吞拒绝、不建 run |
| 默认上下文恢复 | A16 origin 有效时清空 source.sessionId | 仍拒绝 `source-session-missing`，不从 origin 回填默认会谈 |
| 空字符串归一化后继续 | A17 白空格 clientId；合同 whitespace 用例 | 按缺失拒绝，不归一化放行 |
| live-project 偷读 | A12/A18 扫描 + M08 边界扫描 | 合同/变异/对抗文件均无 `D:/xinjing-electron/app` 引用；候选根必须在 workspace 内 |
| PASS 文本与非零退出码冲突 | A18 解析合同 stdout assert JSON 与 exit code 一致性 | exit 0 且 fail=0，一致；无假绿 |

未覆盖项与主动否决的 PASS：

- 未覆盖：真实 Electron/renderer + 隔离 userData harness 行为（冻结输入中没有该 harness）。`verify-artifacts.js` 如实输出 `runtimeEvidence: { status: 'BLOCKED', reason: '...' }`，未用静态证据或源码字符串替换冒充实机证据 —— 该 BLOCKED 标记被保留而非改绿。
- 主动否决的 PASS：任何基于源码字符串匹配的「修复证明」；任何把 runtimeEvidence BLOCKED 改写成 PASS 的做法；任何跳过 M09/M10 变异或让变异落在非真实入口的通过。

## 候选 diff 与哈希

候选根：`workspace/candidate/repo`（evidence/candidate-manifest.json、artifact-verification.json）：

| 文件 | bytes | sha256 | 相对输入 |
|---|---|---|---|
| app/js/clinical-context.js | 21980 | D0FDF476BA0CD0AF665A95B2CE474C20BE0333216F006C9D57EE1D6E46143F99 | 变更（唯一） |
| app/js/clinical-task-validators.js | 3298 | A1ED569334817E134E69F84468FA9212567DA40A744B3A58141C4E80A247CFA0 | 未变 |
| app/js/source-ref.js | 13874 | 7F8B8CCC6ECB53FA357CF16AEC11DBA3B7C0DBB9770DAA7255F69B60762613A5 | 未变 |
| app/js/prompt-governance.js | 10517 | DFFE9DB4E195962CE27401201C7701D680090E42EB56774140B7B7B3E7BBBC9C | 未变 |
| app/js/longitudinal-summary.js | 11311 | B21FC9FFA65C8482049A7FEC5F6642BEF7437156229E168C7BBE5B265ACBDEAA | 未变 |
| app/js/agent-core.js | 26246 | 23987D23F4C6C60A909E2875349E8210CDF75B0ADED489B06AF311174A7C78C5 | 未变 |

测试写入（workspace/tests/**，写集内）：新增 `source-context-fail-closed-contract.js`；扩展 `mutation-probes.js`（M09/M10/M11 + sourceContext 合同）、`internal-adversarial-review.js`（A12 扩展 + A13-A18）、`verify-artifacts.js`（测试清单加入新合同）。输入快照中的原测试文件保持不变（input/ 未动）。

## P0-P3

- P0：0。候选边界内不存在未修复的 fail-open；三种必需缺失上下文输入全部 fail-closed。
- P1：0。关键变异（放宽缺失 clientId/sessionId 拒绝）全部被真实合同杀死；无假绿路径。
- P2：1。真实 Electron/renderer + 隔离 userData 实机证据缺失（冻结输入无该 harness），`runtimeEvidence` 如实 BLOCKED。属候选运行环境的证据缺口，不是候选缺陷；不应以静态证据替代。
- P3：2。
  1. `validateSources` 是共享准入门，任何绕过它的调用方（如直接 `Store.createClinicalActionRun`）不在候选覆盖内 —— 生产接线需保持所有 AI 绑定路径经由此门。
  2. 仅绑定 supervisionId（origin.sessionId 为空）的督导类任务的 supervision 来源 sessionId 可能为空，现在会被 `source-session-missing` 拒绝。这是安全方向的收紧，且与 source-ref.js 冻结契约（clientId+sessionId 必填）一致，但可能影响生产中的 supervision-only 绑定流程，需 Codex 接线评审确认无合法 session-less 来源路径。

## 残余风险与生产集成缺口

- 候选仅存在于隔离目录 `workspace/candidate/**`；未合入生产树，未触碰 `main.js`、`preload.js`、`ai.js`、`store.js`、商业模块、共享契约、release train、账本、锁或其他 run。
- 未联网、未使用凭据、未启动 agent、未打包/签名/上传/push/publish。
- 代理交付 ≠ accepted：Codex 需独立复跑 `node workspace/tests/source-context-fail-closed-contract.js`、`mutation-probes.js`、`internal-adversarial-review.js`、`verify-artifacts.js` 与 `node --check`，重算哈希（上表与 evidence/candidate-manifest.json），审查 evidence/candidate-diff.txt 后决定是否接纳。
- 5.0 百分比无任何变化；不声称生产接入或版本完成。
- 实机缺口：无真实 Electron 用户数据隔离 harness（冻结输入不含）；视觉矩阵/键盘焦点等 UI 验收不适用（隔离的可信 AI 边界候选，`visual_baseline: not-applicable`）。

## 报告与证据清单

证据目录 `workspace/evidence/`：expected-red/（stdout、stderr、exit）、contract-post-fix.txt、mutation-probes.txt、internal-adversarial.txt、verify-artifacts.txt、artifact-verification.json、candidate-manifest.json、candidate-diff.txt、input-manifest-after.txt、node-check-commands.txt。

DELIVERY_REPORT: D:/xinjing-electron/docs/agent-coordination/v5.0.0/cli-coordination/runs/XJ-5.0.0-cli-reasonix-v4.4-trusted-ai-source-context-fail-closed-repair-294/workspace/delivery/DELIVERY_REPORT.md
