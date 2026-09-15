'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@larksuite/cli/bin/lark-cli.exe';
const PROFILE = 'cli_REDACTED_PLACEHOLDER';
const CHAT = 'oc_43df90b527f79eacd24451f8a23cedb4';
const TASK = 'XJ-5.1.0-pi-workbench-candidate-049-no-context-independent-review-050';
const CARD = 'D:/xinjing-electron/docs/agent-coordination/v5.1.0/tasks/XJ-5.1.0-pi-workbench-candidate-049-no-context-independent-review-050.md';
const CARD_SHA = 'E399BDE337DD6CCE121F9E7AF25E69D923E85C9F75209CB537CA2382EA6D7B4C';
const OUT = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.0-pi-workbench-candidate-049-no-context-independent-review-050/feishu-dispatch-outbox.json';

function run(args, timeout = 45000) {
  const r = spawnSync(CLI, ['--profile', PROFILE, ...args], { encoding: 'utf8', shell: false, windowsHide: true, timeout });
  return { status: r.status, error: r.error ? String(r.error.message || r.error) : '', stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}
function parse(raw) { try { return JSON.parse(String(raw || '').trim()); } catch (_) { return null; } }
function resolve(name, identity) {
  const r = run(['im', '+chat-members-list', '--chat-id', CHAT, '--as', identity, '--format', 'json', '--page-all']);
  const b = parse(r.stdout);
  const xs = [].concat(b?.data?.bots || [], b?.data?.users || []).filter((x) => String(x.name || '').toLowerCase() === name.toLowerCase());
  if (xs.length !== 1) throw new Error(`${name}/${identity} resolution count=${xs.length}; stderr=${r.stderr}`);
  const x = xs[0];
  return { identity, member_id: String(x.member_id || x.open_id || ''), app_id: String(x.app_id || ''), name: String(x.name || '') };
}
function idOf(x) { return typeof x?.id === 'string' ? x.id : (x?.id && (x.id.open_id || x.id.user_id || x.id.app_id)); }
function readback(messageId, hermes, codex) {
  const r = run(['im', '+chat-messages-list', '--chat-id', CHAT, '--as', 'user', '--format', 'json', '--page-size', '100', '--order', 'desc']);
  const b = parse(r.stdout);
  const m = (b?.data?.messages || []).find((x) => String(x.message_id || '') === String(messageId || '')) || null;
  const mentions = Array.isArray(m?.mentions) ? m.mentions : [];
  const has = (t) => mentions.some((x) => (idOf(x) === t.member_id || idOf(x) === t.app_id) && String(x?.name || '').toLowerCase() === t.name.toLowerCase());
  return { found: !!m, chat_id: m?.chat_id || null, mentions, hermes_confirmed: has(hermes), codex_confirmed: has(codex), confirmed: !!(m && has(hermes) && has(codex)) };
}
function buildText(hermes, codex) {
  return [
    `<at user_id="${hermes.member_id}">Hermes</at>`,
    `<at user_id="${codex.member_id}">Codex</at>`,
    '@Hermes @Codex',
    'Hermes、Codex',
    '',
    '【050 派发：candidate-049 无上下文独立复核】',
    `task_id: ${TASK}`,
    '状态：granted → running（Hermes Computer Use / 只读独立复核）。',
    `卡 SHA-256：${CARD_SHA}`,
    `任务卡：${CARD}`,
    '复核对象：D:/xinjing-electron/qa/package-candidates/5.1.0/pi-workbench-049/；候选 manifest/files/aggregate 只作待复算提示，不得直接采信。',
    '硬边界：禁止读取 049 交付报告、049 intake、049 scratch/evidence、048 及更早报告/intake、飞书历史消息和本对话 transcript；禁止写 candidate-049、共享生产文件、远程、签名、上传、发布。',
    '必须本轮真实复跑：17 文件 SHA/bytes+aggregate、临时 userData 默认拒网 Electron Workbench、sourceRefs/ClinicalContext、approval、durable/verify、暂停/继续/取消、会员 fail-closed、坏 replay/重启 replay、18-cell 视觉矩阵、至少 8 项 expected-red；每项绑定 command/cwd/start/end/exit/raw stdout/raw stderr/SHA/bytes。',
    '先自审再交付；报告必须列内部对抗审查与 confirmed/stale/false/incomplete/out-of-scope 分类，末行使用绝对 DELIVERY_REPORT。',
    '下一步：请 Hermes 回报 received → running → delivered/blocked；完成后由 Codex intake，未通过前不得开启发布闸门。',
  ].join('\n');
}

const attempts = [];
let confirmed = false;
for (let attempt = 1; attempt <= 3 && !confirmed; attempt += 1) {
  let hermes; let codex;
  try {
    const hu = resolve('Hermes', 'user');
    const hb = resolve('Hermes', 'bot');
    if (!hu.member_id || !hb.member_id || hu.member_id !== hb.member_id || hu.app_id !== hb.app_id) throw new Error('Hermes user/bot identity mismatch');
    hermes = hu;
    codex = resolve('codex', 'user');
  } catch (e) {
    attempts.push({ attempt, stage: 'resolve', error: String(e.message || e) });
    continue;
  }
  const sent = run(['im', '+messages-send', '--chat-id', CHAT, '--text', buildText(hermes, codex), '--as', 'bot', '--format', 'json', '--idempotency-key', `xj510-050-dispatch-${attempt}-20260824`]);
  const body = parse(sent.stdout);
  const messageId = body?.data?.message_id || body?.message_id || null;
  const rb = messageId ? readback(messageId, hermes, codex) : { found: false, mentions: [], hermes_confirmed: false, codex_confirmed: false, confirmed: false };
  attempts.push({ attempt, hermes, codex, send: { status: sent.status, stderr: sent.stderr }, message_id: messageId, readback: rb });
  confirmed = rb.confirmed === true;
}
const out = { task_id: TASK, chat_id: CHAT, confirmed, attempts, sent_at: new Date().toISOString() };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ task_id: TASK, confirmed, attempts: attempts.map((x) => ({ attempt: x.attempt, message_id: x.message_id, readback: x.readback && { found: x.readback.found, hermes_confirmed: x.readback.hermes_confirmed, codex_confirmed: x.readback.codex_confirmed, mentions: x.readback.mentions } })) }, null, 2));
process.exitCode = confirmed ? 0 : 9;
