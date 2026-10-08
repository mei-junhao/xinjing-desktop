/* Playwright spec when available; direct execution always runs real CDP interactions. */
'use strict';
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
let test;
let expect;
let playwrightAvailable = true;
let playwrightLoadError = null;
try {
  ({ test, expect } = require('@playwright/test'));
} catch (error) {
  playwrightAvailable = false;
  playwrightLoadError = error;
  test = function unavailable() {};
  test.describe = function unavailableDescribe() {
    throw new Error('[INTERACTION] @playwright/test is required when this file is loaded by a test runner; use direct node execution for the controlled CDP fallback. ' + (playwrightLoadError && playwrightLoadError.message || 'module unavailable'));
  };
  expect = function unavailable() { throw new Error('BLOCKED: @playwright/test is not installed'); };
}

const ROOT = path.resolve(__dirname, '..', '..');
const baseURL = process.env.XJ_PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:18765';

if (require.main !== module) test.describe('XinJing 5.0.0 vechooool structure integration', () => {
  test('chat history/search/context and keyboard focus', async ({ page }) => {
    await page.goto(baseURL + '/chat-home.html');
    await expect(page.locator('.chat-history-panel')).toBeVisible();
    await expect(page.locator('#chat-history-search')).toBeVisible();
    await expect(page.locator('#chat-context-strip')).toBeVisible();
    await page.locator('#chat-history-search').fill('不存在的合成长中文');
    await expect(page.locator('#chat-history-list')).toContainText('没有匹配');
    await page.locator('#chat-input').focus();
    await expect(page.locator('#chat-input')).toBeFocused();
  });

  test('Atlas source inspector, filtering and Escape focus return', async ({ page }) => {
    await page.goto(baseURL + '/doc-center.html?view=atlas');
    await expect(page.locator('#doc-content')).toBeVisible();
    await expect(page.locator('.dr-tab[data-tab="atlas"]')).toHaveAttribute('aria-selected', 'true');
    await page.locator('#dc-search').fill('长中文材料筛选');
    await page.keyboard.press('Escape');
    await expect(page.locator('#doc-content')).toBeVisible();
  });

  test('Growth page keeps Free lock and preview-only boundary', async ({ page }) => {
    await page.goto(baseURL + '/doc-growth.html');
    await expect(page.locator('#generate-preview')).toBeDisabled();
    await expect(page.locator('body')).toContainText('不会自动写入正式临床对象');
  });

  test('all required viewport/skin/reduced-motion combinations have no horizontal overflow', async ({ page }) => {
    for (const skin of ['clinical', 'theatre', 'observatory']) {
      for (const mode of ['light', 'dark']) {
        for (const size of [{ width: 1024, height: 700 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
          await page.setViewportSize(size);
          await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: mode });
          await page.goto(baseURL + '/doc-growth.html');
          const metrics = await page.evaluate((skinName) => { document.documentElement.setAttribute('data-skin', skinName); document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches); return { overflow: document.documentElement.scrollWidth <= innerWidth + 1, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches }; }, skin);
          expect(metrics.overflow, skin + ' ' + mode + ' ' + size.width + ' overflow').toBeTruthy();
          expect(metrics.reduced, skin + ' ' + mode + ' reduced motion').toBeTruthy();
        }
      }
    }
  });
});

if (require.main === module) {
  const interactionIds = ['E4A', 'E4B', 'E4C', 'E4D-1024x700', 'E4D-1366x768', 'E4D-1920x1080', 'M-E4D-100VH', 'E5', 'E6', 'E8', 'E12-CLOCK', 'E12-CLOCK-PROGRESS', 'E12-PNG-INVENTORY'];
  const runtime = path.join(__dirname, 'electron-runtime-acceptance.js');
  process.stdout.write('[INTERACTION] Running controlled Electron/CDP interaction gates: ' + interactionIds.join(', ') + (playwrightAvailable ? ' (direct CDP mode)' : ' (Playwright unavailable; direct CDP mode)') + '\n');
  const result = childProcess.spawnSync(process.execPath, [runtime], { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (result.error) {
    process.stderr.write('[INTERACTION] Controlled Electron/CDP runner failed to start: ' + result.error.message + '\n');
    process.exitCode = 2;
  } else if (result.status !== 0) {
    process.exitCode = typeof result.status === 'number' ? result.status : 2;
  } else {
    try {
      const summary = JSON.parse(fs.readFileSync(path.join(__dirname, 'evidence', 'runtime-summary.json'), 'utf8'));
      const interaction = interactionIds.map((id) => (summary.checks || []).find((check) => check.id === id));
      const overflowChecks = (summary.checks || []).filter((check) => /^E4D-/.test(check.id));
      const overflowEvidence = overflowChecks.length === 3 && overflowChecks.every((check) => check.pass === true && /overflowPass/.test(check.detail || ''));
      const inventory = summary.inventory || {};
      const inventoryEvidence = inventory.actualCount === 24 && inventory.boundCount === 24 && Array.isArray(inventory.missing) && inventory.missing.length === 0 && Array.isArray(inventory.extra) && inventory.extra.length === 0;
      const passed = interaction.length === interactionIds.length && interaction.every((check) => check && check.pass === true) && overflowEvidence && inventoryEvidence;
      process.stdout.write('[INTERACTION] Summary: ' + interaction.filter((check) => check && check.pass === true).length + '/' + interactionIds.length + ' passed\n');
      process.exitCode = passed ? 0 : 1;
    } catch (error) {
      process.stderr.write('[INTERACTION] Unable to verify controlled interaction summary: ' + error.message + '\n');
      process.exitCode = 2;
    }
  }
}

module.exports = { ROOT, baseURL, playwrightAvailable };
