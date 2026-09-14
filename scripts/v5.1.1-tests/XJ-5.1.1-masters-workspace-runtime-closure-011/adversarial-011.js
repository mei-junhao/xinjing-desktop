'use strict';

const fs = require('fs');
const path = require('path');
const {
  TASK, ROOT, EVIDENCE, launch, navigate, snapshot,
} = require('./runtime-closure-011');

const VIEWPORT = { name: '1024x700', width: 1024, height: 700 };
const mastersPath = path.join(ROOT, 'app', 'js', 'masters.js');
const cssPath = path.join(ROOT, 'app', 'css', 'masters-clinical.css');
const runtimePath = path.join(__dirname, 'runtime-closure-011.js');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function unsafeDurableSaveLines(source) {
  return source.split(/\r?\n/).filter(line => {
    if (!line.includes('saveConversationOrWarn(') || line.includes('async function saveConversationOrWarn')) return false;
    return !/\bawait\s+saveConversationOrWarn\s*\(/.test(line);
  });
}

async function probeHiddenOnly() {
  const app = await launch();
  try {
    await navigate(app, VIEWPORT);
    await app.cdp.evaluate("document.getElementById('master-source-panel').classList.add('collapsed')");
    const state = await snapshot(app.cdp);
    return {
      attack: 'only-hide-panel',
      attempted: true,
      caught: state.gridTracks[0] !== 0,
      observed_grid: state.grid,
      observed_left_width: state.left && state.left.w,
    };
  } finally {
    await app.close();
  }
}

function auditEvidence() {
  const runtime = readJson(path.join(EVIDENCE, 'runtime-closure-011.json'));
  const screenshotMismatches = runtime.results.filter(item => {
    const image = fs.readFileSync(item.screenshot.path);
    const actual = require('./runtime-closure-011').sha256(image);
    return actual !== item.screenshot.sha256;
  });
  const first = runtime.results[0].screenshot;
  const fakeHashMismatch = require('./runtime-closure-011').sha256(fs.readFileSync(first.path)) !== '0'.repeat(64);
  return {
    attack: 'fake-screenshot-sha',
    attempted: true,
    caught: screenshotMismatches.length === 0 && fakeHashMismatch,
    real_mismatches: screenshotMismatches.length,
    fake_hash_rejected: fakeHashMismatch,
  };
}

async function main() {
  const masters = fs.readFileSync(mastersPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  const runtimeSource = fs.readFileSync(runtimePath, 'utf8');
  const expectedRed = readJson(path.join(EVIDENCE, 'expected-red-011.json'));
  const results = [];

  const deletedAwait = masters.replace(
    'if (!await saveConversationOrWarn(currentConv)) return;',
    'if (!saveConversationOrWarn(currentConv)) return;',
  );
  results.push({
    attack: 'delete-await',
    attempted: true,
    caught: unsafeDurableSaveLines(deletedAwait).length > 0,
    unsafe_lines: unsafeDurableSaveLines(deletedAwait).length,
  });

  results.push(await probeHiddenOnly());

  const restoreCase = expectedRed.cases.find(item => item.id === 'delete-right-restore');
  results.push({
    attack: 'restore-still-zero-track',
    attempted: true,
    caught: !!(restoreCase && restoreCase.baseline.ok && !restoreCase.mutated.ok && restoreCase.restored.ok),
    baseline: !!(restoreCase && restoreCase.baseline.ok),
    mutated: !!(restoreCase && restoreCase.mutated.ok),
    restored: !!(restoreCase && restoreCase.restored.ok),
  });

  const horizontalCase = expectedRed.cases.find(item => item.id === 'roundtable-horizontal');
  results.push({
    attack: 'horizontal-flex',
    attempted: true,
    caught: !!(horizontalCase && horizontalCase.baseline.ok && !horizontalCase.mutated.ok && horizontalCase.restored.ok),
    baseline: !!(horizontalCase && horizontalCase.baseline.ok),
    mutated: !!(horizontalCase && horizontalCase.mutated.ok),
    restored: !!(horizontalCase && horizontalCase.restored.ok),
  });

  results.push(auditEvidence());

  const trustedDispatchCount = (runtimeSource.match(/Input\.dispatchMouseEvent/g) || []).length;
  const domClickInHarness = /\.click\s*\(/.test(runtimeSource);
  results.push({
    attack: 'skip-trusted-click',
    attempted: true,
    caught: trustedDispatchCount >= 3 && !domClickInHarness,
    trusted_dispatch_calls: trustedDispatchCount,
    dom_click_in_harness: domClickInHarness,
    note: '直接 DOM click 不计入正式验收；正式入口必须经过 CDP mousePressed/mouseReleased。',
  });

  const output = {
    task: TASK,
    viewport: VIEWPORT,
    attacks: results,
    all_caught: results.every(item => item.caught),
  };
  const outPath = path.join(EVIDENCE, 'adversarial-011.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ output: outPath.replace(/\\/g, '/'), all_caught: output.all_caught }, null, 2));
  process.exitCode = output.all_caught ? 0 : 1;
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
