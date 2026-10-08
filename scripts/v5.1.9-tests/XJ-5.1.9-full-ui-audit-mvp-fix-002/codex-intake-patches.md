# Codex 独占文件最小补丁说明 — XJ-5.1.9-full-ui-audit-mvp-fix-002

执行 agent 依卡不直接写入 Codex 独占文件。以下三项补丁说明 + 验收建议供 Codex intake 后串行接入。
（执行 agent 已核对：Z7 本地镜像半边在当前工作树已实现并由本轮绿向验收覆盖；Z12/Z14 在当前树未实现。）

---

## P-1（对应 Z12）Window 菜单 Minimize/Close 中文标签

- 文件：`main.js`（菜单模板，当前约 :2461-2462）
- 现状：`{ role: 'minimize' },{ role: 'close' }` 使用 Electron role 默认英文标签，中文界面中英混杂（审计 XJ519-Z12 实测 1/1）。
- 最小补丁：

```js
{ role: 'minimize', label: '最小化窗口' },
{ role: 'close', label: '关闭窗口' }
```

- 验收建议：真实启动应用 → 打开 Window 菜单 → 断言三项均为中文（最大化窗口/最小化窗口/关闭窗口）且角色行为不变（最小化/关闭实测生效）。

---

## P-2（对应 Z14）acceptance/probe 模式账号 API 默认拒网（fail-closed）

- 文件：`main.js`（`resolveAccountApiBase()`，当前约 :643-656；`accountNodeRequest` 同链路）
- 现状：acceptance 模式的拒网只覆盖渲染层 unifiedRequestGate（session webRequest）；账号链路走 node http/https，绕过该闸门。审计事故已证实：临时实例注册请求直达生产域（XJ519-Z14）。
- 最小补丁（在 `resolveAccountApiBase()` 开头插入）：

```js
function resolveAccountApiBase() {
  const override = String(process.env.XJ_ACCOUNT_API_BASE || '').trim();
  // XJ519-Z14：验收/探针模式下账号 node 通道默认 fail-closed——
  // 仅放行显式配置的回环 override（127.0.0.1/::1/localhost + http），
  // 其余（含默认生产基址）一律禁用，使拒网覆盖全通道。
  if (process.env.XJ_AGENT_ACCEPTANCE === '1' || process.env.XJ463_HEALTH_PROBE === '1') {
    if (!override) return '';
    try {
      const parsed = new URL(override);
      const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === 'localhost';
      if (parsed.protocol === 'http:' && loopback) return override.replace(/\/+$/, '');
    } catch (e) { /* fallthrough */ }
    return '';
  }
  // ……以下保持现有实现不变……
}
```

- 配套硬ening（可选但建议）：`accountNodeRequest` 内对 `XJ_AGENT_ACCEPTANCE=1` 且目标非回环时直接 reject（防御纵深）。
- 验收建议：acceptance 模式下不设 override → 注册/登录请求必须在 main 侧被拒（networkAttempted=false 全通道）；设回环 override → 仅回环可达。本轮验收已在回环 override 下运行（证据：acceptance-results.json Z14 项），补丁落地后需补「无 override → 全拒」用例。

---

## P-3（对应 Z7 服务器权威半边）主力模型选择的服务器账号偏好回显

- 文件：`app/js/settings.js`、`app/js/store.js`（+ main.js 账号 API 需要的必要 IPC，按 P-2 边界）
- 现状（本轮已核对）：本地镜像半边已实现——模型选择器（app.js）经 `Store.saveSettingsDurable({ aiModelSelection })` 持久化，刷新/重启后以 durable 值回显（本轮绿向验收 Z7 PASS）。缺失的是**服务器权威**半边：账号偏好未上服务器、登录/换机后无权威值回显。
- 最小补丁（契约建议）：
  1. main.js 账号 API（既有 `/account/model-catalog` 通道旁）增加两个最小端点或合并进现有投影：
     - `GET /account/model-preference` → `{ ok, modelId, catalogRevision, updatedAt }`（无偏好时 `modelId: null`）
     - `PUT /account/model-preference`（body: `{ modelId, catalogRevision }`，服务端校验 modelId ∈ catalog）
  2. app.js 模型选择器保存成功后 best-effort 上报（失败不阻塞本地镜像，UI 不回滚）：
     `window.__XJ_API__.commercial.saveModelPreference?.(modelId, catalog.catalogRevision)`
  3. 回显规则（服务器权威）：登录成功 / 会话恢复 / 打开选择器时拉取一次；当服务器返回非空 modelId 且与本地镜像不一致时，以服务器值覆写本地镜像（`Store.saveSettingsDurable({ aiModelSelection })`）并 `dispatchEvent('xj:model-selection-changed')`；请求失败时保持本地镜像（不阻塞 UI）。
- 验收建议：两实例（A 切 Flash → B 登录同账号）回显 Flash；服务器不可达时本地镜像不受影响；计费模型（getTrialModel/getNonAgentConfig().model）与回显值一致。

---

## 执行 agent 本轮已覆盖的对应工作

- Z7 本地镜像：真实 Electron 验收（切换 → durable 保存 → 刷新回显 → 与计费模型一致）PASS，证据见 `acceptance-results.json`。
- Z14 回环半边：验收环境以 `XJ_ACCOUNT_API_BASE=http://127.0.0.1:<port>` 运行，账号 node 通道仅达回环 mock（Z14 PASS，生产域零触达）。
- Z12：当前树未实现，未做行为断言（不伪称 PASS）。
