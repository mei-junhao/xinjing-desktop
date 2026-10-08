'use strict';

const fs = require('fs');
const path = require('path');
const {
  ROOT, TASK, CARD_SHA, EVIDENCE, launch, navigate, clickSelector, snapshot, runRoundtable, fileRecord, sleep,
} = require('./runtime-closure-011');

const VIEWPORT = { name: '1024x700', width: 1024, height: 700 };
const COMMAND_CWD = ROOT.replace(/\\/g, '/');

function requireStage(ok, message) {
  if (!ok) throw new Error(message);
}

async function runStage(caseId, stageId, mutation, verifier) {
  const app = await launch();
  let result = null;
  let error = null;
  try {
    await navigate(app, VIEWPORT);
    if (mutation) await mutation(app.cdp);
    result = await verifier(app.cdp);
  } catch (caught) {
    error = caught.stack || caught.message;
  } finally {
    await app.close();
    await sleep(120);
  }
  const exit = app.child.exitCode === null ? 0 : app.child.exitCode;
  const command = app.command;
  const raw = {
    stdout: fileRecord(app.stdoutFile, command, COMMAND_CWD, exit),
    stderr: fileRecord(app.stderrFile, command, COMMAND_CWD, exit),
  };
  const stage = {
    case_id: caseId,
    stage: stageId,
    viewport: VIEWPORT,
    command,
    cwd: COMMAND_CWD,
    exit,
    result,
    error,
    raw,
    ok: !error && !!(result && result.ok),
  };
  const outPath = path.join(EVIDENCE, 'expected-red-' + caseId + '-' + stageId + '.json');
  fs.writeFileSync(outPath, JSON.stringify(stage, null, 2));
  return stage;
}

async function verifyLeftZero(cdp) {
  const before = await snapshot(cdp);
  await clickSelector(cdp, '#masters-collapse-left');
  const after = await snapshot(cdp);
  return { ok: after.gridTracks[0] === 0 && after.dialogue.w > before.dialogue.w, before, after };
}

async function verifyRightRestore(cdp) {
  await clickSelector(cdp, '#masters-collapse-right');
  const folded = await snapshot(cdp);
  await clickSelector(cdp, '#masters-collapse-right');
  const restored = await snapshot(cdp);
  return { ok: folded.gridTracks[2] === 0 && restored.gridTracks[2] > 0, folded, restored };
}

async function verifyFixedTrack(cdp) {
  const before = await snapshot(cdp);
  await clickSelector(cdp, '#masters-collapse-left');
  const after = await snapshot(cdp);
  return { ok: after.gridTracks[0] === 0 && after.dialogue.w > before.dialogue.w, before, after };
}

async function verifyVerticalRoundtable(cdp) {
  const result = await runRoundtable(cdp);
  const replies = result.messages.filter(item => /\bai\b/.test(item.className));
  const tops = replies.map(item => item.top);
  const strict = tops.every((top, index) => index === 0 || top > tops[index - 1]);
  return { ok: replies.length >= 6 && strict && !result.msgOverflow, result, replies: replies.length, tops, strict };
}

const MUTATIONS = [
  {
    id: 'delete-left-zero-track',
    mutate: cdp => cdp.evaluate(`(function(){var s=document.createElement('style');s.id='mut-delete-left-zero-track';s.textContent='body.masters-left-collapsed .masters-workspace{grid-template-columns:244px minmax(0,1fr) 300px !important;}';document.head.appendChild(s);})()`),
    verify: verifyLeftZero,
  },
  {
    id: 'delete-right-restore',
    mutate: cdp => cdp.evaluate(`(function(){var original=window.toggleMasterPanel;window.toggleMasterPanel=function(side){if(side==='right'&&document.body.classList.contains('masters-right-collapsed'))return;return original(side);};})()`),
    verify: verifyRightRestore,
  },
  {
    id: 'fixed-old-track',
    mutate: cdp => cdp.evaluate(`(function(){var s=document.createElement('style');s.id='mut-fixed-old-track';s.textContent='.masters-workspace,body.masters-left-collapsed .masters-workspace,body.masters-right-collapsed .masters-workspace,body.masters-left-collapsed.masters-right-collapsed .masters-workspace{grid-template-columns:244px minmax(0,1fr) 300px !important;}';document.head.appendChild(s);})()`),
    verify: verifyFixedTrack,
  },
  {
    id: 'roundtable-horizontal',
    mutate: cdp => cdp.evaluate(`(function(){var s=document.createElement('style');s.id='mut-roundtable-horizontal';s.textContent='.chat-body{flex-direction:row !important;}';document.head.appendChild(s);})()`),
    verify: verifyVerticalRoundtable,
  },
];

async function runCase(item) {
  const baseline = await runStage(item.id, 'baseline', null, item.verify);
  const mutated = await runStage(item.id, 'mutated', item.mutate, item.verify);
  const restored = await runStage(item.id, 'restored', null, item.verify);
  const expectedRed = baseline.ok && !mutated.ok && restored.ok;
  return { id: item.id, baseline, mutated, restored, expected_red: expectedRed };
}

async function main() {
  const cases = [];
  let exit = 0;
  for (const item of MUTATIONS) {
    try {
      const result = await runCase(item);
      cases.push(result);
      if (!result.expected_red) exit = 1;
      console.log(item.id, result.expected_red ? 'PASS' : 'FAIL', JSON.stringify({ baseline: result.baseline.ok, mutated: result.mutated.ok, restored: result.restored.ok }));
    } catch (error) {
      exit = 1;
      cases.push({ id: item.id, error: error.stack || error.message, expected_red: false });
      console.error(item.id, 'ERROR', error.stack || error.message);
    }
  }
  const output = { task: TASK, card_sha256: CARD_SHA, cwd: COMMAND_CWD, viewport: VIEWPORT, cases };
  const outPath = path.join(EVIDENCE, 'expected-red-011.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ output: outPath.replace(/\\/g, '/'), expected_red: cases.map(item => ({ id: item.id, ok: item.expected_red })) }, null, 2));
  process.exitCode = exit;
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
