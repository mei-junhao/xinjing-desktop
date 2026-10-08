'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const DEFAULT_EVIDENCE = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-ui-functional-closure-visual-matrix-codex-subagent-successor-005', 'evidence');
const EVIDENCE = path.resolve((process.argv.find((x) => x.startsWith('--evidence=')) || '').slice(11) || DEFAULT_EVIDENCE);
const MATRIX = path.join(EVIDENCE, 'matrix.json');
const HISTORICAL = /(?:004|006|007|011|012|018|historical|legacy)/i;
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex').toUpperCase(); }
function fail(errors, message) { errors.push(message); }
function inside(file, root) { const rel = path.relative(path.resolve(root), path.resolve(file)); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); }
const errors = [];
let matrix = null;
try { matrix = JSON.parse(fs.readFileSync(MATRIX, 'utf8')); } catch (e) { fail(errors, 'matrix.json unreadable'); }
if (matrix) {
  if (matrix.task_id !== 'XJ-5.1.1-ui-functional-closure-visual-matrix-codex-subagent-successor-005') fail(errors, 'task_id mismatch');
  if (!matrix.matrix || matrix.matrix.count !== 18 || matrix.matrix.pass !== 18 || matrix.matrix.allPass !== true) fail(errors, 'matrix summary mismatch');
  if (!Array.isArray(matrix.cells) || matrix.cells.length !== 18) fail(errors, 'cells must contain exactly 18 entries');
  const ids = new Set();
  const combos = new Set();
  for (const cell of (matrix.cells || [])) {
    if (!cell || cell.schemaVersion !== 'v1-nested-fields') { fail(errors, 'cell schemaVersion missing'); continue; }
    for (const key of ['cellId','viewport','skin','mode','pageLabel','operationTrace','routes','overflow','errors','reducedMotion','keyboardFocus','longChinese','screenshots','pass']) if (!(key in cell)) fail(errors, `${cell.cellId || 'cell'} missing ${key}`);
    if (ids.has(cell.cellId)) fail(errors, `duplicate cell ${cell.cellId}`); ids.add(cell.cellId);
    const vp = cell.viewport || {}; const combo = `${vp.width}x${vp.height}-${cell.skin}-${cell.mode}`; combos.add(combo);
    if (!([1024,1366,1920].includes(vp.width) && [700,768,1080].includes(vp.height) && ['clinical','theatre','observatory'].includes(cell.skin) && ['light','dark'].includes(cell.mode))) fail(errors, `invalid combo ${combo}`);
    if (!Array.isArray(cell.operationTrace) || cell.operationTrace.length < 5) fail(errors, `${cell.cellId} operationTrace incomplete`);
    if (!cell.overflow || cell.overflow.horizontal?.hasHorizontalOverflow !== false || cell.overflow.vertical?.hasVerticalOverflow !== false) fail(errors, `${cell.cellId} overflow gate failed`);
    if (!cell.errors || cell.errors.page !== 0 || cell.errors.console !== 0) fail(errors, `${cell.cellId} errors non-zero`);
    if (!cell.reducedMotion || cell.reducedMotion.mqMatches !== true || cell.reducedMotion.animationCount !== 0) fail(errors, `${cell.cellId} reducedMotion failed`);
    if (!cell.keyboardFocus || cell.keyboardFocus.hasFocus !== true || cell.keyboardFocus.focusVisible !== true) fail(errors, `${cell.cellId} keyboard focus failed`);
    if (!cell.longChinese || cell.longChinese.wrapped !== true || cell.longChinese.pageOverflow !== false) fail(errors, `${cell.cellId} long Chinese failed`);
    if (cell.pass !== true) fail(errors, `${cell.cellId} pass flag false`);
    if (!Array.isArray(cell.routes) || cell.routes.length !== 5) fail(errors, `${cell.cellId} route coverage incomplete`);
    if (!Array.isArray(cell.screenshots) || cell.screenshots.length !== 5) fail(errors, `${cell.cellId} screenshot list incomplete`);
    for (const route of (cell.routes || [])) {
      const shot = route.screenshot || {}; const file = path.resolve(String(shot.path || ''));
      if (!inside(file, EVIDENCE) || HISTORICAL.test(file) || !fs.existsSync(file)) { fail(errors, `${cell.cellId}/${route.route} screenshot containment/missing`); continue; }
      let b; try { b = fs.readFileSync(file); } catch (e) { fail(errors, `${cell.cellId}/${route.route} screenshot unreadable`); continue; }
      if (shot.sha256 !== sha256(b) || shot.bytes !== b.length) fail(errors, `${cell.cellId}/${route.route} screenshot digest mismatch`);
      if (!route.metrics || route.metrics.viewport.width !== vp.width || route.metrics.viewport.height !== vp.height) fail(errors, `${cell.cellId}/${route.route} viewport mismatch`);
      if (route.metrics.overflow.horizontal.hasHorizontalOverflow || route.metrics.overflow.vertical.hasVerticalOverflow) fail(errors, `${cell.cellId}/${route.route} route overflow`);
      if (!route.longChinese || route.longChinese.wrapped !== true || route.longChinese.pageOverflow !== false) fail(errors, `${cell.cellId}/${route.route} route long Chinese failed`);
    }
  }
  if (combos.size !== 18) fail(errors, `matrix combos=${combos.size}, expected 18`);
}
const out = { task_id: 'XJ-5.1.1-ui-functional-closure-visual-matrix-codex-subagent-successor-005', evidence_dir: EVIDENCE, checked_at: new Date().toISOString(), errorCount: errors.length, verdict: errors.length ? 'FAIL' : 'PASS', errors };
fs.writeFileSync(path.join(EVIDENCE, 'verifier-result.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ verdict: out.verdict, errorCount: out.errorCount, evidence: EVIDENCE }, null, 2));
process.exitCode = errors.length ? 1 : 0;
