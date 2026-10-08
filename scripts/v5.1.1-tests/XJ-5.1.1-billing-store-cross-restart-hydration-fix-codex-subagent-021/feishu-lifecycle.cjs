#!/usr/bin/env node
'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const CLI_NODE = 'C:/Program Files/nodejs/node.exe';
const CLI_RUNNER = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@larksuite/cli/scripts/run.js';
const PROFILE = 'cli_REDACTED_PLACEHOLDER';
const CHAT_ID = 'oc_43df90b527f79eacd24451f8a23cedb4';
const TASK_ID = 'XJ-5.1.1-billing-store-cross-restart-hydration-fix-codex-subagent-021';

async function cli(args) {
  const result = await execFileAsync(CLI_NODE, [CLI_RUNNER, '--profile', PROFILE, ...args], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    cwd: 'D:/xinjing-electron',
  });
  return result.stdout;
}

function parseJson(output) {
  const trimmed = String(output || '').trim();
  try { return JSON.parse(trimmed); } catch (_) {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
    throw new Error('CLI output was not JSON');
  }
}

async function resolveHermes(as) {
  const output = await cli([
    'im', '+chat-members-list', '--chat-id', CHAT_ID, '--as', as, '--json',
  ]);
  const data = parseJson(output).data || {};
  const matches = [];
  for (const bucket of ['users', 'bots']) {
    for (const member of Array.isArray(data[bucket]) ? data[bucket] : []) {
      if (member && member.name === 'Hermes') matches.push({
        member_id: member.member_id,
        app_id: member.app_id || null,
        bucket,
      });
    }
  }
  if (matches.length !== 1 || !matches[0].member_id) {
    throw new Error(`Hermes resolution expected exactly one member, got ${matches.length}`);
  }
  return matches[0];
}

function findMessageId(value) {
  const data = value && value.data ? value.data : value;
  const candidates = [
    data && data.message_id,
    data && data.messageId,
    data && data.item && data.item.message_id,
    data && data.message && data.message.message_id,
  ];
  return candidates.find(Boolean) || null;
}

async function main() {
  const state = process.argv[2] || 'received';
  const summary = process.argv.slice(3).join(' ') || 'Codex subagent lifecycle update';
  const userHermes = await resolveHermes('user');
  const botHermes = await resolveHermes('bot');
  if (userHermes.member_id !== botHermes.member_id || userHermes.app_id !== botHermes.app_id) {
    throw new Error(`Hermes identity mismatch between user/bot lookup: ${JSON.stringify({ userHermes, botHermes })}`);
  }
  const hermes = userHermes;
  const now = new Date().toISOString();
  const idempotencyKey = `xj511-021-${state}-${Date.now()}`.slice(0, 50);
  const text = [
    `[STATUS] ${state}`,
    `task_id: ${TASK_ID}`,
    `time_utc: ${now}`,
    'owner: Codex-subagent; acceptance_owner: Codex; independent_reviewer: Hermes',
    `card_sha256: 4CC23B2D24796D603475E84CB37729CAC27B7C48B70E26482B62261C03D6287B`,
    `<at user_id="${hermes.member_id}">Hermes</at> @Hermes Hermes ${summary}`,
  ].join('\n');
  const sendOutput = await cli([
    'im', '+messages-send', '--chat-id', CHAT_ID, '--as', 'user', '--text', text,
    '--idempotency-key', idempotencyKey, '--json',
  ]);
  const sendJson = parseJson(sendOutput);
  const messageId = findMessageId(sendJson);
  if (!messageId) throw new Error(`Send returned no message id: ${JSON.stringify(sendJson)}`);
  const readOutput = await cli([
    'im', '+messages-mget', '--as', 'user', '--message-ids', messageId, '--json',
  ]);
  const readJson = parseJson(readOutput);
  const raw = JSON.stringify(readJson);
  const mentionConfirmed = raw.includes(hermes.member_id) || (hermes.app_id && raw.includes(hermes.app_id));
  const result = {
    task_id: TASK_ID,
    state,
    chat_id: CHAT_ID,
    message_id: messageId,
    hermes_member_id: hermes.member_id,
    hermes_app_id: hermes.app_id,
    mention_forms: ['structured-at', 'visible-@Hermes', 'role-name-Hermes'],
    idempotency_key: idempotencyKey,
    mention_confirmed: mentionConfirmed,
    sent: sendJson,
    readback: readJson,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!mentionConfirmed) process.exitCode = 3;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
