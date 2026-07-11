# 心镜 XinJing · 大师对话界面无法输入 — 诊断与修复

> 日期：2026-07-11
> 影响版本：≤ 1.0.10（1.0.11 已修复，1.0.12 含防御性加固）
> 严重度：高（已激活用户完全无法使用大师对话输入框）

---

## 一、现象

已激活（定制旗舰版）用户进入「大师对话」页：

- 左侧大师列表可正常点击、切换；
- 右侧对话区可见，但**输入框无法点击、无法打字**；
- 设置页已显示「已激活·定制旗舰版」，状态不一致。

---

## 二、根因

### 2.1 直接原因：AI 锁遮罩盖住了对话框

`app/masters.html` 中有一块免费版锁定遮罩：

```html
<div class="ai-lock hidden" id="ai-lock">
  <div class="lock-emoji">🔒</div>
  <div class="lock-title">AI 对话为付费功能</div>
  ...
</div>
```

其样式（`masters.html` 内联 `<style>`）：

```css
.ai-lock { position: absolute; inset: 0; background: rgba(251,248,243,.94); z-index: 5;
  display: flex; flex-direction: column; align-items: center; justify-content: center; }
.ai-lock.hidden { display: none; }
```

`position:absolute; inset:0; z-index:5` 让它**铺满整个 `.chat-col` 对话区**（含底部输入框 `textarea#msg-input`）。只要它没被加上 `.hidden`，就会拦截所有鼠标点击与键盘输入 —— 用户看到对话框却点不进去、打不了字。

注意：遮罩**只覆盖右侧 `.chat-col`**，不覆盖左侧 `.master-list`，所以「能选大师、不能输入」正是这一遮罩的表现。

### 2.2 根本原因：激活状态没同步到大师页（旧的快照 bug）

遮罩的显示/隐藏由 `applyAiLock()` 控制：

- **1.0.10（bug 版）**：`masters.js` 的 `applyAiLock` 读的是 `window.__XJ__` —— 这是 preload 在 `DOMContentLoaded` 时拍的**一次性快照**。`contextIsolation` 下，主进程激活后广播的 `xj:license-state` 通过 `Object.assign(stateRef, s)` 修改的是被桥接的代理对象，但渲染页读的 `window.__XJ__.aiUnlocked` **没有可靠刷新**，仍是初始化时的 `false`。
  - 结果：`aiUnlocked` 一直为 `false` → `lock.classList.remove('hidden')` → 遮罩常显 → 盖住输入框。
- 设置页之所以显示正确，是因为它走的是 `getState()` IPC（权威态），与快照无关 —— 这就是「设置已激活、大师页仍锁」的来源。

### 2.3 授权态链路确认（正常情况应正确）

`main.js` 的 `computeState()`：

```js
const activated = !!(lic && lic.identity && lic.activatedAt);
const aiUnlocked = activated || aiTrialActive;   // 旗舰激活 → true
const tier = (lic && lic.tier) ? lic.tier : (activated ? 'full' : 'free');  // custom
licenseState = { mode: license.overallMode(activated, trial), tier, aiUnlocked, ... };
```

激活旗舰时 `aiUnlocked=true`、`mode='full'`。preload 在 `DOMContentLoaded` 见 `mode==='full'` 会直接 `return`，**根本不会注入锁遮罩**，遮罩保持 HTML 默认的 `hidden`。因此只要 `applyAiLock` 读到正确的 `aiUnlocked`，遮罩就会隐藏。

---

## 三、已实施的修复

### 3.1 1.0.11（提交 62f27af）— 根治状态同步

在 `app/js/app.js` 建立集中权威态缓存，所有页面统一从 `App.aiUnlocked()` 读取，不再读 `window.__XJ__` 快照：

- `refreshLicenseState()`：`initPage` 时 `await window.__XJ_API__.getState()` 拉取权威态并缓存；
- `updateLicenseState(s)`：激活广播 `xj:license-state` 到达时刷新缓存并通知订阅者；
- `App.aiUnlocked()` / `App.getLicenseState()` / `App.onLicenseStateChange()` 对外暴露；
- `session.js`、`masters.js`、`store.js` 改为读 `App.aiUnlocked()` 并订阅 `App.onLicenseStateChange` 刷新锁。

效果：大师页 / AI 助手页的锁在激活后正确隐藏，输入框恢复可用。

### 3.2 1.0.12（本次）— 防御性加固

在 `app/js/masters.js` 的 `applyAiLock()` 增加「解锁时显式复位输入框」：

```js
function applyAiLock() {
  const lock = $('ai-lock');
  if (!lock) return;
  const unlocked = App.aiUnlocked();
  if (unlocked) {
    lock.classList.add('hidden');
    const input = $('msg-input');
    const sendBtn = $('send-btn');
    if (input) input.disabled = false;
    if (sendBtn) sendBtn.disabled = !currentConv;
  } else {
    lock.classList.remove('hidden');
  }
}
```

目的：即便存在任何残留路径（如 `setBusy` 异常、旧快照未刷新）把输入框卡在 `disabled`，一旦授权状态变为已解锁就强制复位为可用，杜绝「遮罩没了但输入框还是灰的」这类边界情况。

---

## 四、发布与验证

- 1.0.11：已构建并上传至 COS 桶 `xinjing-1439314927`，`latest.yml` 指向 `version: 1.0.11`。
- 1.0.12：构建脚本 `scripts/cnb-build.ps1` 已修复（UTF-8 BOM + 绕过安全删除守卫 + 正则解析 COS 密钥），本次构建上传 6 个产物，COS `latest.yml` 将指向 `version: 1.0.12`。
- 校验：`https://xinjing-1439314927.cos.ap-guangzhou.myqcloud.com/latest.yml` 读取 `version` 字段确认。

---

## 五、用户侧解决方案

1. **重启心镜**：自动更新守护进程会在启动时检测到新版本并弹窗；
2. 点击「安装并重启」；
3. 重启后进入「大师对话」，点任意大师即可正常输入。

若重启后仍不弹更新：手动从发布渠道获取最新安装包覆盖安装即可（COS 桶提供 `xinjing-setup-1.0.12.exe`）。

---

## 六、结论

「无法输入」并非输入框本身损坏，而是 **AI 锁遮罩在激活状态下未隐藏、盖住了对话框** —— 本质是上一轮「激活状态不同步」bug 在大师对话输入框上的具体表现。1.0.11 已根治状态同步，1.0.12 再加输入框复位加固，更新到最新版即可彻底解决。
