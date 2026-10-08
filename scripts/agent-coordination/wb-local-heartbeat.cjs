'use strict';
/*
 * WorkBuddy 5.0 本地协作心跳（单一合并 20 分钟心跳）。
 * 只读取本地协作文件，只写自身 agents/<id>.json 与 mail/codex/ 唯一消息。
 * 不读取/执行/清理 %LOCALAPPDATA%\XinJing\agent-queue；不修改账本、写锁、任务卡、他人状态或 delivery/。
 */
const fs = require('fs');
const path = require('path');

const AGENT_ID = 'agent-workbuddy';
const COORD = 'D:/xinjing-electron/docs/agent-coordination/v5.0.0/local-coordination';
const ROOT_V5 = path.dirname(COORD);
const LEDGER = path.join(COORD, 'task-ledger.json');
const LOCKS = path.join(ROOT_V5, 'write-locks.json');
const MY_STATUS = path.join(COORD, 'agents', AGENT_ID + '.json');
const MY_MAIL = path.join(COORD, 'mail', AGENT_ID);
const CODEX_MAIL = path.join(COORD, 'mail', 'codex');
// 心跳日志（与脚本同目录），每次 cycle 追加时间戳，便于排查是否存活/崩溃
const HB_LOG = 'D:/xinjing-electron/scripts/agent-coordination/wb-local-heartbeat.log';
function hbLog(s) { try { fs.appendFileSync(HB_LOG, s + '\n'); } catch (e) {} }

function nowISO() {
  const d = new Date();
  const offMin = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offMin * 60000);
  return local.toISOString().replace('Z', '+08:00');
}
function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function listJSON(dir) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.')); }
  catch (e) { return []; }
}
function writeAtomic(p, obj) {
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}
function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
}
function uniqueName(kind, suffix) {
  return `local-${AGENT_ID}-${stamp()}-${kind}${suffix ? '-' + suffix : ''}.json`;
}

function scanCodexReceived(grantId) {
  return listJSON(CODEX_MAIL).some(f => {
    const m = readJSON(path.join(CODEX_MAIL, f), null);
    return m && m.kind === 'received' && m.from === AGENT_ID && m.grant_id === grantId;
  });
}

function main() {
  const result = {
    agent_id: AGENT_ID,
    health: 'online',
    current_task_id: null,
    task_status: 'idle',
    grants_pending: 0,
    actions: []
  };

  const ledger = readJSON(LEDGER, null);
  const locks = readJSON(LOCKS, null);
  if (!ledger) { result.health = 'unknown'; result.note = 'task-ledger.json unreadable'; }

  // 我的收件箱：确保存在（供 Codex 投递 grant）
  try { if (!fs.existsSync(MY_MAIL)) fs.mkdirSync(MY_MAIL, { recursive: true }); } catch (e) {}

  let status = readJSON(MY_STATUS, null) || {
    schema_version: 1,
    agent_id: AGENT_ID,
    display_name: 'WorkBuddy',
    session_id: 'unknown',
    model: 'unknown',
    model_verification: 'unknown',
    health: 'online',
    current_task_id: null,
    task_status: 'idle',
    summary: '已按 5.0 本地协作协议接入；当前暂无任务。',
    updated_at: nowISO()
  };

  // 收集 addressed to me 的 grant/rework，并按 grant_id 只保留最新一条。
  const messagesByGrant = new Map();
  listJSON(MY_MAIL)
    .map(f => readJSON(path.join(MY_MAIL, f), null))
    .filter(m => m && (m.kind === 'grant' || m.kind === 'rework') && m.to === AGENT_ID && m.grant_id)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    .forEach(m => messagesByGrant.set(m.grant_id, m));
  const grants = Array.from(messagesByGrant.values());

  const activeGrants = [];
  for (const g of grants) {
    const gId = g.grant_id;
    const t = (ledger && ledger.tasks || []).find(t => t.task_id === g.task_id);
    const lock = (locks && locks.locks || []).find(lock => lock.lock_id === (t && t.write_lock_id));
    const auth = t && t.lease ? t.lease.authorization : 'unknown';
    const received = scanCodexReceived(gId);
    const deadline = g.received_deadline_at ? Date.parse(g.received_deadline_at) : 0;
    const expiredBeforeReceipt = !received && deadline && Date.now() > deadline;
    // 'queued' 是 CodeX 新派发（尚未认领）的合法状态，必须纳入白名单——
    // 否则新 grant 会被 continue 跳过、无法在 60 分钟窗口内自动回 received，
    // 最终过期被撤销（见 2026-07-27 audit-13 事故：grant 到达时 state=queued，
    // 心跳白名单缺 'queued' 导致漏认领，21:39 窗口过期被 revoke 并转交 codebuddy audit-14）。
    const validState = t && ['granted', 'received', 'running', 'rework', 'active', 'queued'].includes(t.state);
    const validLock = lock && lock.state === 'active' && lock.owner === AGENT_ID;
    if (auth !== 'active' || expiredBeforeReceipt || !validState || !validLock || t.owner !== AGENT_ID) continue;

    activeGrants.push({ message: g, task: t, received });
    if (!received) {
      // 自动回 received（满足 60 分钟确认窗）
      status.current_task_id = g.task_id;
      status.task_status = 'received';
      status.health = 'online';
      status.summary = `收到 grant ${gId}，已读取任务卡与写锁，准备执行首个真实检查。`;
      const recv = {
        schema_version: 1,
        message_id: `local-${AGENT_ID}-${stamp()}-received`,
        from: AGENT_ID,
        to: 'codex',
        task_id: g.task_id,
        kind: 'received',
        summary: `收到 grant ${gId}。已读取任务卡与写锁，准备执行首个真实检查。`,
        evidence_paths: [`agents/${AGENT_ID}.json`],
        created_at: nowISO(),
        grant_id: gId
      };
      writeAtomic(path.join(CODEX_MAIL, uniqueName('received')), recv);
      result.actions.push({ type: 'received', grant_id: gId, task_id: g.task_id });
    }
  }

  if (activeGrants.length > 0) {
    const current = activeGrants[activeGrants.length - 1];
    status.health = 'online';
    status.current_task_id = current.task.task_id;
    if (current.received && status.current_task_id !== current.task.task_id) status.task_status = 'received';
    if (current.task.state === 'rework') {
      status.task_status = 'received';
      status.summary = `返工任务 ${current.task.task_id} 授权有效，已读取最新返工要求，等待执行并重新交付。`;
    } else if (!['received', 'running', 'delivered'].includes(status.task_status)) {
      status.task_status = 'received';
      status.summary = `任务 ${current.task.task_id} 授权有效且已确认，等待继续执行。`;
    }
  } else {
    status.current_task_id = null;
    status.task_status = 'idle';
    status.summary = '已按 5.0 本地协作协议接入；飞书通道已停用，改走本地文件协作。当前无 owner=' + AGENT_ID + ' 的合法任务，暂无任务。';
  }

  status.updated_at = nowISO();
  writeAtomic(MY_STATUS, status);
  result.current_task_id = status.current_task_id;
  result.task_status = status.task_status;
  result.grants_pending = activeGrants.length;

  // 单跑/守护共用：每次 cycle 留时间戳轨迹，便于从日志确认存活（含计划任务触发）
  hbLog('[' + new Date().toISOString() + '] cycle ok health=' + status.health +
    ' task=' + (status.current_task_id || 'none') + ' grants=' + activeGrants.length +
    ' actions=' + result.actions.length);

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

const LOOP = process.argv.includes('--loop');
if (LOOP) {
  // 单一合并 20 分钟本地心跳守护：仅此一个计时器，不轮询飞书、不另建第二计时器。
  // 关键修复：cycle 必须包 try/catch——任一周期的瞬时异常（如收件箱并发写入导致的
  // JSON 解析失败）都不得令整个守护进程静默崩溃。
  hbLog('[' + new Date().toISOString() + '] heartbeat loop START (pid=' + process.pid + ')');
  function cycle() {
    try {
      main();
    } catch (e) {
      hbLog('[' + new Date().toISOString() + '] CYCLE ERROR: ' + (e && e.stack ? e.stack : String(e)));
    }
  }
  cycle();
  setInterval(cycle, 20 * 60 * 1000);
} else {
  try { main(); } catch (e) {
    process.stdout.write(JSON.stringify({ agent_id: AGENT_ID, health: 'unknown', error: String(e && e.message || e) }, null, 2) + '\n');
    process.exit(0);
  }
}
