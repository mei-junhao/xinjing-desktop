# XJ-5.2.0-AGENT-CONTRACT-001 交付报告

- task_id: XJ-5.2.0-AGENT-CONTRACT-001
- contract_id: xj-5.2.0-clinical-agent-task-contract-v1
- agent_profile_id: gpt-6.1-sol-low（按任务卡提供；平台独立模型回执无法验证）
- 状态: delivered（最小返工已完成），未修改受保护文件，未提交/推送/合并/发布

## Codex intake 返工

- 在原 allowlist 内增强 `validate`/`validateSources`：`context.snapshotStale === true`、`context.stale === true` 或 `context.snapshot.stale === true` 均 fail-closed，稳定返回 `stale-snapshot`。
- 当未提供 `context.clientId` 时，来源中多个非空且互不相同的 `clientId` 返回 `cross-client-source-mismatch`；提供 `context.clientId` 时继续执行精确匹配。
- 未扩展 task/effect 设计，未接入 agent-core、clinical-context、store 或 UI。

## 实际产物

- `app/js/clinical-agent-tasks.js`：无依赖 UMD 模块，冻结八类 effect、六个监督任务注册项；提供 `getTask`、`listTaskIds`、`validate`、`validateSources`、`project` 纯函数。
- `tests/v5.2.0/clinical-agent-tasks.contract.test.cjs`：Node VM 隔离加载，覆盖正向、未知任务/effect、缺失来源、跨来访者来源、过期快照、非法输出处置、效果不匹配、冻结/无临床正文投影。

## 验收命令与结果

1. `node --test tests/v5.2.0/clinical-agent-tasks.contract.test.cjs`：PASS（1 test，0 fail；含三种上下文 stale 负向测试及无 context.clientId 的 clientId 一致/不一致测试）。
2. `node --check app/js/clinical-agent-tasks.js`：PASS。
3. `git diff --check -- app/js/clinical-agent-tasks.js tests/v5.2.0/clinical-agent-tasks.contract.test.cjs docs/agent-coordination/v5.2.0/tasks/XJ-5.2.0-AGENT-CONTRACT-001.md`：PASS。
4. `Get-FileHash ... -Algorithm SHA256`：全部与任务卡 protected_file_hashes 一致：
   - `app/js/agent-core.js`: `00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2`
   - `app/js/clinical-context.js`: `09536023837266F2D560CE8D2500A6EA6BE0A25C53F97CC1C781EB46A23C1B64`
   - `app/js/store.js`: `00473C3984B95429BE2E82AAD3C61369A2A1C2459CACA7C77CF84A66277504A7`
   - `app/js/agent-tools.js`: `FBD7BBF2BCA95BA025420998AB96511BB517725028ECD2FA9998A7C80A644D2B`
   - `package.json`: `B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72`
   - `package-lock.json`: `FDB8D11766CE697211B6C21AEE91E488ECD8E12FEAFF725C568D62906156CB03`

## 差异与范围核对

只新增任务卡 allowlist 中的三个文件；未改动现有测试、运行时、数据模型、依赖或发布文件。工作树中其他未提交改动来自任务前状态，未触碰。

## 内部对抗审查

- 尝试未知 task/effect、非法 output disposition、缺失 required source、source kind 越权、重复 source、跨 client/session、stale marker、effect mismatch：均按稳定 reason fail-closed。
- 尝试通过 `confirmed: true` 绕过边界：契约仍只允许 preview/draft；durable-write 不属于任何首批任务 effect。
- 尝试修改公开 `TASKS` 注册表：冻结对象保持原定义；测试随后重新读取并验证 `session-review` 身份不变。
- 尝试把临床正文放入 projection：projection 仅返回 task/effect/risk/source requirements/output sections/confirmation boundary/previewFirst，无正文。
- 返工对抗：分别删除三种 stale 标记之一、把 stale 标记置于空来源请求、删除 `context.clientId`、混入第二个 clientId；测试确认 stale 或跨 client 均 fail-closed，单一 clientId 正向通过。
- 首次测试曾因 Node VM 跨 realm 数组的 `deepStrictEqual` 产生测试假失败，已仅修正测试断言为宿主 realm `Array.from`；生产模块未因该问题改动。
- 未覆盖项：未启动 Electron、未访问网络、未使用真实临床数据；这些均被任务卡明确禁止且不是本模块的验收范围。

## Stop conditions

未触发任何 stop condition；未需要修改受保护/共享运行时文件或 durable API。

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-CONTRACT-001.md
