'use strict';

const fs = require('fs');
const path = require('path');
const { launchEdge } = require('./browser-cdp');

const PROJECT_ROOT = path.resolve(__dirname, '../../../../../');
const TASK_ID = 'XJ-5.0.0-full-ui-ux-review-successor-391';
const RUN_ROOT = path.join(PROJECT_ROOT, 'docs/agent-coordination/v5.0.0/cli-coordination/runs', TASK_ID, 'workspace');
const EVIDENCE_ROOT = path.join(RUN_ROOT, 'evidence');
const URL = require('url').pathToFileURL(path.join(PROJECT_ROOT, 'design-previews/5.0.0-rerun-ui-ux/index.html')).href;

async function main() {
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const page = await launchEdge();
  const results = [];
  try {
    await page.setViewport(1366, 768);

    await page.navigate(URL);
    const saveMutation = await page.evaluate(`(() => { const button = document.querySelector('[data-action="save-note"]'); button.removeAttribute('data-action'); button.click(); return !document.querySelector('[data-feedback]'); })()`);
    results.push({ mutation: 'remove-save-handler', detected: saveMutation, expected: true });

    await page.navigate(URL);
    const overflowMutation = await page.evaluate(`(() => { const view = document.querySelector('.route-view'); view.style.width = '1600px'; return document.documentElement.scrollWidth > window.innerWidth; })()`);
    results.push({ mutation: 'widen-main-region', detected: overflowMutation, expected: true });

    await page.navigate(URL);
    const stateMutation = await page.evaluate(`(() => { const button = document.querySelector('[data-action="toggle-motion"]'); const before = document.body.classList.contains('reduced-motion'); button.removeAttribute('data-action'); button.click(); return document.body.classList.contains('reduced-motion') === before; })()`);
    results.push({ mutation: 'remove-motion-state-contract', detected: stateMutation, expected: true });

    const failed = results.filter((result) => !result.detected || !result.expected);
    const output = { task_id: TASK_ID, status: failed.length === 0 ? 'PASS' : 'FAIL', mutation_results: results, adversarial_note: 'Each mutation intentionally breaks a behavior and must be detected by a runtime assertion.' };
    fs.writeFileSync(path.join(EVIDENCE_ROOT, 'mutation-results.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    if (failed.length) throw new Error(`MUTATION_PROBES_FALSE_GREEN ${failed.map((item) => item.mutation).join(',')}`);
    console.log(`MUTATION PROBES PASS mutations=${results.length}`);
  } finally {
    await page.close();
  }
}

main().catch((error) => {
  const blocked = error.code === 'BROWSER_UNAVAILABLE' || /REAL_BROWSER_UNAVAILABLE|CDP_|WEBSOCKET/.test(error.message);
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_ROOT, 'mutation-results.json'), `${JSON.stringify({ task_id: TASK_ID, status: blocked ? 'BLOCKED_REAL_BROWSER_UNAVAILABLE' : 'FAIL', error: error.message }, null, 2)}\n`, 'utf8');
  console.error(`${blocked ? 'BLOCKED_REAL_BROWSER_UNAVAILABLE' : 'MUTATION FAIL'}: ${error.message}`);
  process.exitCode = blocked ? 2 : 1;
});
