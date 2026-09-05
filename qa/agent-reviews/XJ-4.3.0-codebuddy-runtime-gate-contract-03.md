# XJ-4.3.0-codebuddy-runtime-gate-contract-03 交付报告（rework v3 / 第三次即最终返工）

task_id: XJ-4.3.0-codebuddy-runtime-gate-contract-03
owner: codebuddy（执行模型/档位：平台工具未暴露，无法验证；用户界面显示 CodeBuddy IDE + Hy3）
manager: codex
base_commit: 9971787eb6e443ab5a5c80aee118b9b43285c093
branch: release/3.6.3-mac（未切换）
rework_trigger: om_x100b6907e2540ca0dd321ead2949318（CODEX_INTAKE stage: rejected / final allowed rework）
交付时间: 2026-07-24 18:33 (UTC+8)

## 1. 三类证据严格区分（本次返工核心）

### 1.1 生产现状（全部 EXPECTED_RED，未被静态文本掩盖）

- 真实 wrapper `scripts/agent-electron-acceptance.ps1`（SHA-256 `018AE1401D66890700460FC4639881B1DA92628457F2C9F41A4127BDDC4B1102`，与门禁 KNOWN SHA 一致，G4=PASS）：
  - R1 EXPECTED_RED：无 SHA 绑定的三态运行时证据（无界 `WaitForExit()`；即使未来文本改为 `WaitForExit(5000); Kill(); exit` 也不翻绿，因为该文本会把正常退出也 Kill）；
  - R2 EXPECTED_RED：无异常退出后"目录实际缺失"的运行时证据（try/finally 清理在挂起/强杀路径不可达）；
  - R3 EXPECTED_RED：无 18 格视觉矩阵 manifest。
- v3 起 R1/R2 翻绿唯一途径：`qa/acceptance/XJ-4.3.0/runtime-evidence/wrapper-behavior-*.json` 存在、`wrapperSha256` 等于当前 wrapper SHA、三态均实际观测、`killOnlyOnTimeout===true`、清理以 `verifiedByDirectoryAbsence===true` 为准。该目录当前不存在（已验证），故生产恒红。

### 1.2 未来行为夹具已验证（隔离合成，非生产证据）

`behavior-fixture.js`：仅在 `os.tmpdir()` 建临时目录、仅起短生命周期 pwsh 子进程；未触碰 wrapper/main/真实 userData/网络；结束自删临时目录。7/7 全绿，原始行为记录：

- FIX1.normal-exit：`{"waitReturned":true,"killAttempted":false,"outcome":"normal-exit","childExitCode":0}` — Kill 未发生；
- FIX1.timeout-killed：`{"outcome":"timeout-killed","childExitCode":-1,"waitReturned":false,"killAttempted":true}` — 仅 timeout 分支 Kill，子进程退出码 -1；
- FIX1.unexpected-exit：`{"waitReturned":true,"killAttempted":false,"outcome":"unexpected-exit","childExitCode":7}` — 与 normal/timeout 明确区分；
- FIX2.abnormal-exit-cleanup：父进程 `exit 99` 跳过自身清理后，独立 watchdog（`Wait-Process $PID; Remove-Item`）实际删除临时 userData：`parentExit=99 dirRemoved=true`（磁盘目录缺失断言，非口头声明）。

同夹具负变异（保留关键字、破坏控制流，全部按要求 FAIL 被拒）：
- MUT-1 无分支 Kill：`killAttempted=true` 发生在正常退出的子进程上 → `killOnlyOnTimeout` 违约 → 拒；
- MUT-2 不可达清理：watchdog 行保留但父进程先 `exit 99` → `dirRemoved=false`（目录存活）→ 拒；
- MUT-3 删错路径：watchdog 删 `<dir>-wrong` → 真实目录存活 `dirRemoved=false` → 拒。

任何 spawn/解析错误 → HARNESS_ERROR 且整体非 0（try/catch 包裹每项，`process.exit(allPass?0:1)`）。

### 1.3 仍缺生产修复（Codex 独占，本任务未触碰）

1. 真实 wrapper：有界 wait + 三态分类 + Kill 仅限 timeout 分支；
2. 真实 wrapper：try/exit 之前生效、异常路径可达的独立清理监督；
3. 插桩验收运行产出 SHA 绑定的 `wrapper-behavior-*.json`；
4. 18 格视觉矩阵 manifest。

## 2. 命令与退出码（原始结果）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `node --check run-gate-contract.js` | 通过 | 0 |
| `node --check mutation-probes.js` | 通过 | 0 |
| `node --check behavior-fixture.js` | 通过 | 0 |
| `node run-gate-contract.js` | `MATCHED=true EXPECTED_RED=3`（8 谓词：5 green PASS，3 red 均 FAIL=期望） | 0 |
| `node mutation-probes.js` | `MUTATION_PROBES_PASS=true (11/11)` | 0 |
| `node behavior-fixture.js` | `BEHAVIOR_FIXTURE_PASS=true (7/7)` | 0 |
| `git diff --check`（allowlist 范围） | 无空白错误 | 0 |

## 3. 变异探针（11 项）

正向：B（合法 SHA 绑定运行时证据 → R1/R2 红转绿；语义正确的最小修复=合法证据本身）。
负向（均保持红）：N0 静态文本全关键字但无运行时证据（即被拒收的假绿路径）；N1 Kill 出现在 timeout 分支外；N1b 缺失 unexpected-exit 态；N2 清理无目录缺失验证；N3 证据绑定 stale SHA。
承重/防伪：A 合成替身 G4=FAIL；C 移除 R1/R2/R3 断言各自产生假绿（断言必要）；D 篡改 KNOWN SHA 被检出；E 17 格/placeholder 拒绝、18 格接受；F 挂起子进程不算完成。

## 4. 内部对抗审查

- 攻击 1：用"文本顺序正确"的 wrapper（`WaitForExit(5000); Kill(); exit` + 末尾 Start-Job 清理）喂给门禁且无证据 → R1/R2 保持红（N0 探针固化此攻击）；
- 攻击 2：伪造运行时证据但绑定错误 SHA / 缺态 / 无分支 Kill / 无目录验证 → N3/N1b/N1/N2 全部拒绝；
- 攻击 3：夹具层面保留关键字破坏控制流（MUT-1/2/3）→ 以真实子进程行为与磁盘目录状态为准全部 FAIL；
- 攻击 4：把夹具结论冒充生产证据 → 夹具输出显式标注 `appliesToProductionWrapper:false`，且门禁只认 `qa/acceptance/XJ-4.3.0/runtime-evidence/` 中 SHA 绑定 JSON，夹具不写入该目录；
- 攻击 5：删除 await/异步等待问题 → 全部子进程用 `spawnSync` 同步等待，结果 JSON 落盘后读取，无假等待；
- 主动否决的 PASS：v2 版 R1/R2 静态语义检查曾判 PASS 的路径，本版全部改判 EXPECTED_RED；
- 未覆盖项/残余风险：夹具在本机 pwsh 7 环境验证，其他 PowerShell 版本未测；`Wait-Process` watchdog 在系统极端负载下删除延迟可能超 15s 轮询窗（此时 FIX2 会 FAIL 而非假绿，方向安全）；真实 Electron 行为仍未执行（按卡与 CodeX 指令保持 BLOCKED/EXPECTED_RED，不冒充运行时证明）。

## 5. Checkpoint

- A：真实 wrapper 只读检查 + SHA 复算一致（G4=PASS）；真实 Electron 调用维持 BLOCKED（安全无法无风险执行），以 EXPECTED_RED 记录，不作 PASS；
- B：expected-red 矩阵与未来生产验收谓词（含证据 JSON 契约）已发布于契约文档 v3；缺屏截/挂起子进程/stale 证据均不能翻绿（E/F/N3 探针）；
- C：聚焦重跑全部命令（见第 2 节），产物 SHA-256 见第 6 节。

## 6. 产物 SHA-256（最终写入后复算）

| 产物 | SHA-256 |
| --- | --- |
| tests/v4.3.0-disposable/codebuddy-runtime-gate/run-gate-contract.js | DAF931861231247D6F398FB2BC7C1846686E333E174C9290DBCC774EF816275B |
| tests/v4.3.0-disposable/codebuddy-runtime-gate/mutation-probes.js | E6D4636CF6F6F96AC03CC42929A742B277FEFF3B367E97247F378DD6E3F9F32B |
| tests/v4.3.0-disposable/codebuddy-runtime-gate/behavior-fixture.js | 1693DA1FBE5E290088F603D021A92BCA93B5D0C677591D794D24009240B7DB98 |
| docs/agent-coordination/v4.3.0/contracts/codebuddy-electron-runtime-gate.md | BE6615F878CB65A5FC63778CBFD1E3AC9D651F46FD8D3877690370AB102F49AD |
| qa/agent-reviews/XJ-4.3.0-codebuddy-runtime-gate-contract-03.md | 本文件；SHA 于写入后另行在交付消息中给出 |

## 7. P0-P3 与评分

- P0：0（生产 P0 缺口以 EXPECTED_RED 精确固化，未被掩盖）；P1：0（v2 静态假绿路径已由 N0 探针永久拒绝）；P2：0（产物 SHA 已列全；真实 wrapper 行为明确标 BLOCKED/EXPECTED_RED）；P3：1（夹具轮询窗口常量 15s/5s 为经验值，已注明方向安全）。
- 自评分：94/100（受最弱证据约束：真实 Electron 行为未执行，仅夹具级行为证据；不足 95，不声称 release-ready）。
- 授权状态：test-only；未 commit/push/upload/sign/publish。

DELIVERY_REPORT: D:\xinjing-electron\qa\agent-reviews\XJ-4.3.0-codebuddy-runtime-gate-contract-03.md
