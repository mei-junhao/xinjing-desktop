# XJ-4.3.0 CodeBuddy Electron Runtime Gate Contract (rework v3)

task_id: XJ-4.3.0-codebuddy-runtime-gate-contract-03
contract_id: XJ-4.3.0-electron-runtime-gate-v1
base_commit: 9971787eb6e443ab5a5c80aee118b9b43285c093
wrapper_sha256: 018AE1401D66890700460FC4639881B1DA92628457F2C9F41A4127BDDC4B1102
status: rework v3（运行时证据制；静态文本永不作为运行时证明）

## 0. 三类证据的严格区分（CodeX 第三次返工要求）

| 证据类 | 含义 | 当前状态 |
| --- | --- | --- |
| 生产现状 | 真实 wrapper（`scripts/agent-electron-acceptance.ps1`）的实际行为 | R1/R2/R3 全部 **EXPECTED_RED**：无界 `WaitForExit()`、清理仅在 try/finally、无 18 格视觉门禁 |
| 未来行为夹具已验证 | 隔离合成 PowerShell 夹具已用真实子进程验证未来谓词语义可实现、可测量 | FIX-1 三态分类、FIX-2 异常退出实际删除临时 userData：**已验证**（7/7，含 3 个负变异被拒绝） |
| 仍缺生产修复 | 把夹具语义移植进真实 wrapper，并产出绑定 wrapper SHA 的运行时证据 | **缺失**。Codex 独占生产文件，本任务不得触碰 |

## 1. 门禁语义（v3 核心变更）

R1/R2 从"语义化静态检查"升级为**运行时证据制**：

- 静态源码文本（任何关键字、任何顺序）**一律不能**翻绿 R1/R2。理由（即 CodeX 指出的两个假绿）：
  - `WaitForExit(5000); Kill(); exit` 文本顺序正确，但会把正常退出的子进程也 Kill，且不证明 wait 结果被检查、不证明三种结果被分类；
  - 追加在脚本末尾的 Start-Job 清理在真实执行路径上不可达（wrapper 在 try 内 `exit`）。
- R1/R2 翻绿的唯一途径：`qa/acceptance/XJ-4.3.0/runtime-evidence/wrapper-behavior-*.json` 存在，且：
  - `wrapperSha256` 等于当前真实 wrapper 的 SHA-256（stale 证据被拒）；
  - R1：`r1.outcomes` 三态（normal-exit / timeout-killed / unexpected-exit）均为实际观测 `true`，且 `killOnlyOnTimeout === true`；
  - R2：`abnormalExitCleanupVerified === true` 且 `verifiedByDirectoryAbsence === true`（以目录不存在为准，不接受口头断言）。
- 此证据只能由未来 Codex 拥有的插桩生产运行产出。今天不存在 → 生产现状恒为 EXPECTED_RED。

## 2. 谓词矩阵

| ID | 类型 | 谓词 | 生产现状 |
| --- | --- | --- | --- |
| G4 | green | wrapper SHA-256 与已知真实 wrapper 一致（合成替身被拒） | PASS |
| G1 | green | main.js 网络默认拒绝（loopback only） | PASS |
| G2 | green | CDP 仅 loopback 且仅 port>0 时启用 | PASS |
| G3 | green | userData 强制在系统 temp 内 | PASS |
| R1 | red | 三态运行时证据 + Kill 仅限 timeout 分支（SHA 绑定） | EXPECTED_RED（无证据） |
| R2 | red | 异常退出后临时 userData 以目录缺失为证被实际删除（SHA 绑定） | EXPECTED_RED（无证据） |
| R3 | red | 18 格视觉矩阵 manifest（逐格证据、无 placeholder） | EXPECTED_RED（无 manifest） |
| M1 | green | 元规则：17 格 / placeholder / 非 18 格一律拒绝 | PASS |

## 3. 隔离行为夹具（behavior-fixture.js）

完全隔离：仅在 `os.tmpdir()` 下建临时目录、仅起短生命周期 `pwsh` 子进程；不触碰真实 wrapper、main.js、真实 userData、网络。

正向（必须全绿，证据 = 子进程退出码 + 结果 JSON + 目录存在性断言）：
- FIX1.normal-exit：子进程 exit 0 → `normal-exit`，未尝试 Kill；
- FIX1.timeout-killed：有界 wait 超时 → 仅此分支 Kill，子进程退出码非 0；
- FIX1.unexpected-exit：子进程 exit 7 → `unexpected-exit`，未尝试 Kill；
- FIX2.abnormal-exit-cleanup：父进程 exit 99（跳过自身清理）后，独立 watchdog（`Wait-Process` + `Remove-Item`）实际删除夹具临时 userData（磁盘上目录消失）。

负变异（保留关键字、破坏控制流，必须 FAIL）：
- MUT-1 无分支 Kill：`.Kill(` 保留但不受 timeout 分支约束 → 正常退出的子进程也被 Kill → `killOnlyOnTimeout` 违约被拒；
- MUT-2 不可达清理：watchdog 注册行保留但父进程在到达前 exit 99 → 目录存活 → 被拒；
- MUT-3 删错路径：watchdog 删除 `<dir>-wrong` → 真实目录存活 → 被拒。

任何 spawn/解析/进程错误 → HARNESS_ERROR 且整体非 0 退出。

夹具结论仅属"未来行为夹具已验证"类，**不是**生产 wrapper 证据，禁止写入 runtime-evidence 目录冒充生产证据。

## 4. 变异探针（mutation-probes.js，11 项）

- B（正向）：绑定当前 wrapper SHA 的合法运行时证据 → R1/R2 红转绿（语义正确的最小"修复"就是合法证据本身）；
- N0（负向）：全部关键字齐备的**静态文本**且无运行时证据 → R1/R2 必须保持红（即 CodeX 拒收的假绿路径）；
- N1：证据记录 Kill 发生在 timeout 分支之外 → 拒；
- N1b：证据缺失三态之一 → 拒；
- N2：清理声明成功但无目录缺失验证 → 拒；
- N3：证据绑定的 wrapper SHA 与当前不符（stale）→ 拒；
- A/C/D/E/F：合成替身检测、断言承重性、旧 SHA 替换检测、视觉格拒绝、挂起子进程不算完成。

## 5. 仍缺的生产修复（Codex 独占，本任务不得实施）

1. 真实 wrapper 引入有界 wait + 三态分类，Kill 仅限 timeout 分支；
2. 真实 wrapper 注册在 try/exit 之前就生效的独立清理监督（异常/强杀路径可达）；
3. 插桩验收运行产出绑定 wrapper SHA 的 `wrapper-behavior-*.json` 运行时证据；
4. 18 格视觉矩阵 manifest 及逐格证据。

以上任一完成前，R1/R2/R3 在生产上必须保持 EXPECTED_RED；门禁保证这一点不可被静态文本绕过。
