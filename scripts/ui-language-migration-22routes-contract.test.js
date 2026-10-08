'use strict';

/* XJ-5.0.0-ui-language-migration-22routes-current-baseline-rebind-002
 * Narrow static UI contract/evidence suite.
 *
 * Verifies the 22 bound routes and shared CSS keep the workbench-language
 * contracts after migration. Every check is deterministic source analysis.
 * Exit code 0 = all pass, 1 = at least one failure.
 */

const fs = require('fs');
const path = require('path');

const ROOT = 'D:/xinjing-electron';
const MANIFEST = path.join(ROOT, 'docs/agent-coordination/v5.0.0/tasks/XJ-5.0.0-ui-language-migration-22routes-current-baseline-rebind-002.protected.json');

const ROUTE_PATTERNS = {
  'index.html': 'dashboard', 'chat-home.html': 'conversation', 'consult-notes.html': 'form-workspace',
  'session-calendar.html': 'browser-list', 'transcript.html': 'split-editor', 'transcript-guide.html': 'split-editor',
  'report-writing.html': 'split-editor', 'supervision.html': 'conversation', 'supervision-mindmap.html': 'canvas',
  'real-supervision.html': 'form-workspace', 'real-supervision-ai.html': 'browser-list', 'masters.html': 'conversation',
  'doc-center.html': 'browser-list', 'doc-growth.html': 'browser-list', 'knowledge.html': 'browser-list',
  'billing-shell.html': 'browser-list', 'billing-calendar.html': 'browser-list', 'settings.html': 'settings-list',
  'feedback.html': 'form-workspace', 'activation.html': 'utility-window', 'confirm-close.html': 'utility-window',
  'migrate-helper.html': 'utility-window',
};

const checks = [];
function check(id, pass, detail) { checks.push({ id, pass: !!pass, detail: detail || '' }); }

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const manifestRoutes = manifest.baseline_writable_inputs
  .filter((entry) => entry.path.startsWith('app/') && entry.path.endsWith('.html'))
  .map((entry) => path.basename(entry.path))
  .sort();

/* 1. Fixed 22-route list bound by the manifest. */
const boundRoutes = Object.keys(ROUTE_PATTERNS).sort();
check('manifest-binds-exactly-22-routes', manifestRoutes.length === 22 && JSON.stringify(manifestRoutes) === JSON.stringify(boundRoutes), `manifest=${manifestRoutes.length}`);
for (const route of boundRoutes) {
  check(`route-exists:${route}`, fs.existsSync(path.join(ROOT, 'app', route)));
}

/* 2. Every route loads xj-ui-system.css last, except routes that layer the
      workspace addendum clinical-workspaces.css after it. That addendum must
      not redefine skin token blocks. */
for (const route of boundRoutes) {
  const source = read('app/' + route);
  const links = [...source.matchAll(/<link[^>]+href="(css\/[a-z-]+\.css)"/g)].map((m) => m[1]);
  const last = links[links.length - 1];
  const systemIndex = links.indexOf('css/xj-ui-system.css');
  const trailing = links.slice(systemIndex + 1);
  const trailingAllowed = trailing.every((l) => l === 'css/clinical-workspaces.css');
  check(`ui-system-last:${route}`, links.length > 0 && systemIndex !== -1 && (last === 'css/xj-ui-system.css' || trailingAllowed), links.join(','));
}
const workspacesCss = read('app/css/clinical-workspaces.css');
check('workspace-addendum-does-not-redefine-skins', !/\[data-skin=/.test(workspacesCss) && !/--xj-canvas:/.test(workspacesCss));

/* 3. Page-pattern markers follow the information architecture. */
for (const route of boundRoutes) {
  const source = read('app/' + route);
  const m = source.match(/<body[^>]*data-xj-pattern="([a-z-]+)"/);
  check(`pattern-marker:${route}`, !!m && m[1] === ROUTE_PATTERNS[route], m ? m[1] : 'missing');
}

/* 4. Skin token architecture: clinical default + token-driven theatre/observatory, light+dark. */
const uiSystem = read('app/css/xj-ui-system.css').replace(/\r\n/g, '\n');
for (const selector of [':root,\n[data-skin="clinical"]', '[data-skin="clinical"].dark', '[data-skin="theatre"]', '[data-skin="theatre"].dark', '[data-skin="observatory"]:not(.dark)', '[data-skin="observatory"].dark']) {
  check(`skin-block:${selector.replace(/\s+/g, ' ')}`, uiSystem.includes(selector));
}
function skinTokens(selectorRegex) {
  const m = uiSystem.match(selectorRegex);
  if (!m) return null;
  const block = uiSystem.slice(m.index, uiSystem.indexOf('}', m.index));
  const canvas = (block.match(/--xj-canvas:\s*([^;]+);/) || [])[1];
  const accent = (block.match(/--xj-accent:\s*([^;]+);/) || [])[1];
  return { canvas: (canvas || '').trim(), accent: (accent || '').trim() };
}
const clinical = skinTokens(/\[data-skin="clinical"\][^{]*\{[^}]*--xj-canvas/s) || skinTokens(/:root,\s*\n\[data-skin="clinical"\]\s*\{/);
const theatre = skinTokens(/\[data-skin="theatre"\]\s*\{/);
const observatory = skinTokens(/\[data-skin="observatory"\]:not\(\.dark\)\s*\{/);
check('skins-do-not-collapse', !!(clinical && theatre && observatory
  && clinical.canvas && theatre.canvas && observatory.canvas
  && clinical.canvas !== theatre.canvas && clinical.canvas !== observatory.canvas && theatre.canvas !== observatory.canvas
  && clinical.accent !== theatre.accent && clinical.accent !== observatory.accent), JSON.stringify({ clinical, theatre, observatory }));

/* 5. Legacy token alias fallbacks survive inside every skin block (old components keep working). */
const aliasRequired = ['--paper:', '--bg:', '--ink:', '--border:', '--accent:'];
for (const alias of aliasRequired) {
  check(`legacy-alias:${alias}`, uiSystem.includes(alias));
}

/* 6. Reduced motion + focus visibility + overflow guards exist in shared CSS. */
check('reduced-motion-block', /@media \(prefers-reduced-motion: reduce\)/.test(uiSystem) && /animation-duration: \.01ms !important/.test(uiSystem));
check('focus-visible-rules', /:focus-visible/.test(uiSystem) && /outline: 2px solid var\(--xj-focus/.test(uiSystem));
check('no-horizontal-page-overflow-guard', /html, body \{ overflow-x: hidden; \}/.test(uiSystem));
check('long-text-wrap-guard', /overflow-wrap: break-word;/.test(uiSystem));
check('serif-not-in-workbench-headings', /h1, h2, h3, h4, h5, h6 \{ font-family: var\(--sans\)/.test(uiSystem));
check('decorative-grain-disabled', /body::before \{ display: none; \}/.test(uiSystem));

/* 7. No emoji UI icons, no lavender residue, no decorative entrance animations in the bound routes. */
const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
for (const route of boundRoutes) {
  const source = read('app/' + route);
  check(`no-emoji-icons:${route}`, !emojiRe.test(source));
}
for (const route of boundRoutes) {
  const source = read('app/' + route);
  check(`no-lavender-residue:${route}`, !/139,\s*147,\s*199/.test(source));
}
for (const route of boundRoutes) {
  const source = read('app/' + route);
  check(`no-4.2-entrance-animation:${route}`, !/fadeUp/.test(source));
}

/* 8. Reported primary action: 记一笔 keeps a real handler chain. */
const billingShell = read('app/billing-shell.html');
check('billing-primary-button-present', /id="bf-add-record"[^>]*data-billing-action="add-record"/.test(billingShell) || /data-billing-action="add-record"[^>]*id="bf-add-record"/.test(billingShell));
check('billing-primary-handler-bound', /bindBillingPrimaryActions/.test(billingShell) && /getElementById\('bf-add-record'\)/.test(billingShell) && /addEventListener\('click'/.test(billingShell));
check('billing-primary-opens-modal', /function openAddModal\(/.test(billingShell) && /bf-modal-overlay/.test(billingShell));
check('billing-route-feature-gated-in-app-js', /billing-calendar/.test(read('app/js/app.js')));

/* 9. Settings exposes exactly the three production skins. */
const settings = read('app/settings.html');
const skinButtons = [...settings.matchAll(/data-skin-name="([a-z]+)"/g)].map((m) => m[1]).sort();
check('settings-three-production-skins', JSON.stringify(skinButtons) === JSON.stringify(['clinical', 'observatory', 'theatre']), skinButtons.join(','));
const settingsJs = read('app/js/settings.js');
check('settings-skin-gate-premium', /premium-skins/.test(settingsJs));

/* 10. JS hooks referenced by app/js remain present where required. */
const indexSource = read('app/index.html');
for (const id of ['hero-stats', 'week-schedule', 'today-schedule', 'quick-modules', 'more-modules', 'recent-sessions', 'todo-list', 'start-next-session']) {
  check(`index-hook:${id}`, indexSource.includes(`id="${id}"`));
}
check('dashboard-js-binds-start-next', /start-next-session/.test(read('app/js/dashboard.js')));

/* 11. No route deletion / no marketing landing composition. */
check('no-marketing-hero-copy', !boundRoutes.some((route) => /class="[^"]*landing-hero/.test(read('app/' + route))));

const failed = checks.filter((c) => !c.pass);
const out = { task_id: 'XJ-5.0.0-ui-language-migration-22routes-current-baseline-rebind-002', timestamp: new Date().toISOString(), total: checks.length, failed: failed.length, checks };
fs.writeFileSync(path.join(ROOT, 'qa/task-scratch/XJ-5.0.0-ui-language-migration-22routes-current-baseline-rebind-002/evidence/route-matrix-result.json'), JSON.stringify(out, null, 1));
console.log(`contract checks: ${checks.length - failed.length}/${checks.length} passed`);
for (const failure of failed) console.log('FAIL', failure.id, failure.detail);
process.exit(failed.length ? 1 : 0);
