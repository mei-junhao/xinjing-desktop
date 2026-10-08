'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(name) {
  const prefix = '--' + name + '=';
  const hit = process.argv.find((value) => value.indexOf(prefix) === 0);
  return hit ? hit.slice(prefix.length) : '';
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

const runPath = path.resolve(arg('run'));
const scenario = arg('scenario');
const errors = [];
let run;
try {
  run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
} catch (error) {
  errors.push('run unreadable: ' + error.message);
}

if (!run || run.ok !== true) errors.push('run not PASS');
if (scenario && (!run || run.scenario !== scenario)) errors.push('scenario binding');
if (!run || !run.url || !run.url.endsWith('/supervision.html')) errors.push('supervision URL');

const runtime = run && run.runtime;
if (!runtime) errors.push('runtime evidence missing');
if (runtime) {
  if (!Array.isArray(runtime.clickLog) || !runtime.clickLog.some((entry) => entry.selector === '#sup-report-upload-trigger')) errors.push('real upload trigger click');
  if (!Array.isArray(runtime.clickLog) || !runtime.clickLog.some((entry) => entry.selector === '#sup-report-file' && entry.action === 'setFileInputFiles')) errors.push('real file selection');
  if (!Array.isArray(runtime.pageErrors) || runtime.pageErrors.length) errors.push('page errors');
  if (!Array.isArray(runtime.unexpectedConsoleErrors) || runtime.unexpectedConsoleErrors.length) errors.push('unexpected console errors');
  if (runtime.reducedMotion !== true) errors.push('reduced motion');
  if (!runtime.scroll || !runtime.client || runtime.scroll.width !== runtime.client.width) errors.push('final horizontal overflow');
  const traces = Array.isArray(runtime.trace) ? runtime.trace.map((entry) => entry.state) : [];
  if (traces[0] !== 'idle') errors.push('state sequence start');
  if (run.scenario === 'success') {
    if (!traces.some((state) => state === 'uploading' || state === 'progress') || !traces.includes('success')) errors.push('success state sequence');
    if (!run.after || run.after.state !== 'success') errors.push('success final state');
  }
  if (run.scenario === 'retry') {
    const failureIndex = traces.indexOf('failure');
    const successIndex = traces.lastIndexOf('success');
    if (failureIndex < 0 || successIndex <= failureIndex || !traces.slice(0, failureIndex).some((state) => state === 'uploading' || state === 'progress')) errors.push('retry state sequence');
    if (!run.failed || run.failed.state !== 'failure' || !run.after || run.after.state !== 'success') errors.push('retry final states');
  }
  if (run.scenario === 'cancel') {
    if (!traces.some((state) => state === 'uploading' || state === 'progress') || !traces.includes('cancel') || traces[traces.length - 1] !== 'idle') errors.push('cancel state sequence');
    if (!run.after || run.after.state !== 'idle' || traces.includes('success')) errors.push('cancel final state');
  }
  const expectedViewports = ['1024x700', '1366x768', '1920x1080'];
  const seenViewports = new Set();
  for (const evidence of (runtime.viewportEvidence || [])) {
    const viewportKey = evidence.viewport && (evidence.viewport.width + 'x' + evidence.viewport.height);
    if (!viewportKey) { errors.push('viewport shape'); continue; }
    seenViewports.add(viewportKey);
    if (evidence.scrollWidth > evidence.clientWidth) errors.push('viewport horizontal overflow ' + viewportKey);
    const screenshot = evidence.screenshot;
    if (!screenshot || !path.isAbsolute(screenshot.path) || !fs.existsSync(screenshot.path)) {
      errors.push('screenshot missing ' + viewportKey);
      continue;
    }
    const runDir = path.dirname(runPath) + path.sep;
    if (!path.resolve(screenshot.path).startsWith(runDir)) errors.push('screenshot outside run dir ' + viewportKey);
    const bytes = fs.readFileSync(screenshot.path);
    if (bytes.length !== screenshot.bytes) errors.push('screenshot bytes ' + viewportKey);
    if (sha256(bytes) !== screenshot.sha256) errors.push('screenshot sha256 ' + viewportKey);
  }
  for (const viewportKey of expectedViewports) if (!seenViewports.has(viewportKey)) errors.push('missing viewport ' + viewportKey);
}

if (errors.length) {
  process.stderr.write(JSON.stringify({ ok: false, run: runPath, scenario, errors }) + '\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ ok: true, verdict: 'PASS', run: runPath, scenario }) + '\n');
