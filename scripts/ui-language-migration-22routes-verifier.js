'use strict';

/* XJ-5.0.0-ui-language-migration-22routes-evidence-freeze-verifier-rework-003
 *
 * Fail-closed evidence-freeze verifier, v2 (rework of the task-002 verifier).
 *
 * Root cause fixed: the task-002 verifier never compared the manifest-declared
 * SHA-256 of the JSON evidence files against disk bytes (it only parsed their
 * content), and bound screenshots by a bare `screenshot_count` number. Three
 * drifted evidence JSONs therefore still produced 53/53 PASS (P1 false-green).
 *
 * v2 rules (fail-closed):
 *   - EVERY manifest-declared artifact must exist on disk and match its
 *     SHA-256 byte-for-byte: UI sources, protected files, harness scripts,
 *     successor shims, verifier/tooling, JSON evidence, visual inputs,
 *     governance inputs, checkpoint artifacts.
 *   - Screenshots are enumerated per-file with SHA-256 plus a deterministic
 *     aggregate hash; a count-only declaration is rejected.
 *   - Closed evidence directories are membership-validated: every file on disk
 *     must be declared, every declared file must exist (post-freeze additions
 *     and deletions fail closed).
 *   - The manifest itself is cross-checked against a SHA-256 pin file when the
 *     pin exists; structural schema violations fail closed.
 *   - Parse-only checks, string matching, or count-only checks never
 *     substitute for byte binding.
 *   - The verifier performs ZERO writes anywhere.
 *
 * CLI:
 *   node scripts/ui-language-migration-22routes-verifier.js
 *       -> verify the successor (task-003) freeze bundle (default)
 *   node scripts/ui-language-migration-22routes-verifier.js --legacy-predecessor
 *       -> run the v2 engine over the task-002 manifest/bundle
 *   node scripts/ui-language-migration-22routes-verifier.js --manifest <path>
 *       -> explicit manifest override
 *   node scripts/ui-language-migration-22routes-verifier.js --json
 *       -> machine-readable output
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = 'D:/xinjing-electron';
const TASK_002 = 'XJ-5.0.0-ui-language-migration-22routes-current-baseline-rebind-002';
const TASK_003 = 'XJ-5.0.0-ui-language-migration-22routes-evidence-freeze-verifier-rework-003';
const DEFAULT_MANIFEST = path.join(ROOT, 'qa/task-scratch', TASK_003, 'final-sha-manifest.json');
const LEGACY_MANIFEST = path.join(ROOT, 'qa/task-scratch', TASK_002, 'final-sha-manifest.json');

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const legacy = args.includes('--legacy-predecessor');
let manifestPath = DEFAULT_MANIFEST;
const mi = args.indexOf('--manifest');
if (mi !== -1 && args[mi + 1]) manifestPath = args[mi + 1];
if (legacy) manifestPath = LEGACY_MANIFEST;

const results = [];
function check(id, pass, detail) { results.push({ id, pass: !!pass, detail: detail || '' }); }
function sha256Buf(buf) { return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase(); }
function sha256File(p) {
  let buf;
  try { buf = fs.readFileSync(p); } catch (e) { return null; }
  return sha256Buf(buf);
}
function norm(rel) { return path.isAbsolute(rel) ? rel : path.join(ROOT, rel); }
function relOf(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }

function walkFiles(dir, out) {
  out = out || [];
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return null; }
  for (const name of entries.sort()) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch (e) { return null; }
    if (st.isDirectory()) { if (walkFiles(p, out) === null) return null; }
    else out.push(p);
  }
  return out;
}

/* ---- manifest load + structural schema (fail-closed) ---- */
let manifest = null;
let manifestSha256 = null;
{
  const raw = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath) : null;
  check('manifest:exists', !!raw, manifestPath);
  if (raw) {
    manifestSha256 = sha256Buf(raw);
    try { manifest = JSON.parse(raw.toString('utf8')); } catch (e) { check('manifest:parses', false, e.message); }
    if (manifest) check('manifest:parses', true);
  }
}

if (manifest) {
  const asText = JSON.stringify(manifest);
  /* LEASE exclusion is structural: no bound artifact path may point at LEASE.json (prose notes are not bindings). */
  const allBoundPaths = [];
  for (const key of Object.keys(manifest)) {
    const v = manifest[key];
    if (Array.isArray(v)) for (const e of v) { if (e && typeof e.path === 'string') allBoundPaths.push(e.path); }
    if (v && Array.isArray(v.files)) for (const e of v.files) { if (e && typeof e.path === 'string') allBoundPaths.push(e.path); }
  }
  const leaseBound = allBoundPaths.filter(p => path.basename(p.split('/').join(path.sep)).toUpperCase() === 'LEASE.JSON');
  check('manifest:no-lease-bound', leaseBound.length === 0, 'LEASE must be excluded from the freeze manifest');
  check('manifest:no-placeholders', !/placeholder|TODO|TBD|<sha/i.test(asText));

  /* pin cross-check: freezes the manifest bytes themselves */
  const pinPath = path.join(path.dirname(manifestPath), 'manifest-sha256.pin');
  if (fs.existsSync(pinPath)) {
    const pin = fs.readFileSync(pinPath, 'utf8').trim().toUpperCase();
    check('manifest:pin-match', pin === manifestSha256, manifestSha256);
  }

  const requiredTopLevel = ['task_id', 'generated_at', 'ui_sources', 'protected_files', 'harness_scripts', 'evidence_files', 'screenshots'];
  for (const key of requiredTopLevel) {
    check('manifest:section:' + key, manifest[key] !== undefined && manifest[key] !== null, 'missing section fails closed');
  }

  /* ---- per-file byte binding ---- */
  function verifyEntryList(sectionName, entries, shaKey) {
    if (!Array.isArray(entries)) { check(sectionName + ':is-array', false); return; }
    if (entries.length === 0) { check(sectionName + ':non-empty', false, 'empty declaration fails closed'); return; }
    check(sectionName + ':non-empty', true, String(entries.length));
    let drift = 0;
    const seen = new Set();
    for (const entry of entries) {
      const rel = entry && entry.path;
      const expected = entry && entry[shaKey];
      if (!rel || typeof expected !== 'string') { check(sectionName + ':entry-shape:' + JSON.stringify(entry).slice(0, 60), false); drift++; continue; }
      if (seen.has(rel)) { check(sectionName + ':duplicate:' + rel, false); drift++; continue; }
      seen.add(rel);
      const abs = norm(rel);
      const actual = sha256File(abs);
      if (actual === null) { check('byte-bind:' + rel, false, 'MISSING-OR-UNREADABLE'); drift++; continue; }
      if (actual !== expected.toUpperCase()) { check('byte-bind:' + rel, false, actual + ' != ' + expected.toUpperCase()); drift++; continue; }
      if (typeof entry.size === 'number') {
        const size = fs.statSync(abs).size;
        if (size !== entry.size) { check('byte-bind-size:' + rel, false, size + ' != ' + entry.size); drift++; continue; }
      }
      check('byte-bind:' + rel, true);
    }
    check(sectionName + ':all-bytes-match', drift === 0, drift + ' drifted of ' + entries.length);
  }

  verifyEntryList('ui_sources', manifest.ui_sources, 'final_sha256');
  verifyEntryList('protected_files', manifest.protected_files, 'sha256');
  verifyEntryList('harness_scripts', manifest.harness_scripts, 'sha256');
  for (const extra of ['successor_harness_shims', 'verifier_tooling', 'visual_inputs', 'governance_inputs', 'checkpoint_artifacts', 'evidence_files']) {
    if (manifest[extra] !== undefined) verifyEntryList(extra, manifest[extra], 'sha256');
  }
  if (manifest.evidence_files === undefined) check('evidence_files:is-array', false);

  /* ---- screenshots: per-file SHA + deterministic aggregate + membership closure ---- */
  const shots = manifest.screenshots;
  if (shots && Array.isArray(shots.files)) {
    check('screenshots:per-file-bound', shots.files.length > 0, String(shots.files.length));
    if (typeof shots.declared_count === 'number') {
      check('screenshots:count-matches-files', shots.declared_count === shots.files.length, shots.declared_count + ' vs ' + shots.files.length);
    }
    verifyEntryList('screenshots', shots.files, 'sha256');
    if (typeof shots.aggregate_sha256 === 'string' && shots.aggregate_algorithm === 'sha256(sorted path\\0sha256\\0size\\n)') {
      const lines = shots.files.slice().map(f => f.path.split(path.sep).join('/') + '\u0000' + String(f.sha256).toUpperCase() + '\u0000' + String(f.size));
      lines.sort();
      const agg = sha256Buf(Buffer.from(lines.join('\n') + '\n', 'utf8'));
      check('screenshots:aggregate-match', agg === shots.aggregate_sha256.toUpperCase(), agg);
    } else {
      check('screenshots:aggregate-declared', false, 'aggregate hash with explicit algorithm is required; count-only is insufficient');
    }
  } else {
    check('screenshots:per-file-bound', false, 'screenshot_count alone is insufficient; per-file SHA-256 enumeration is required');
  }

  /* ---- closed-directory membership validation ---- */
  if (manifest.evidence_dir_closed === true && Array.isArray(manifest.closed_dirs)) {
    check('evidence-dir:closed-declared', true, manifest.closed_dirs.join(', '));
    const declaredByDir = new Map();
    for (const entry of [].concat(manifest.evidence_files || [], (shots && shots.files) || [])) {
      const abs = norm(entry.path);
      const dir = path.dirname(abs);
      if (!declaredByDir.has(dir)) declaredByDir.set(dir, new Set());
      declaredByDir.get(dir).add(abs);
    }
    for (const dirRel of manifest.closed_dirs) {
      const dirAbs = norm(dirRel);
      const onDisk = walkFiles(dirAbs);
      if (onDisk === null) { check('closure:' + dirRel, false, 'directory missing or unreadable'); continue; }
      let bad = 0;
      for (const p of onDisk) {
        let covered = false;
        for (const [d, set] of declaredByDir) {
          if ((d === dirAbs || d.startsWith(dirAbs + path.sep)) && set.has(p)) { covered = true; break; }
        }
        if (!covered) { check('closure-undeclared:' + relOf(p), false, 'artifact present but not declared by the frozen manifest'); bad++; }
      }
      for (const [d, set] of declaredByDir) {
        if (!(d === dirAbs || d.startsWith(dirAbs + path.sep))) continue;
        for (const abs of set) { if (!fs.existsSync(abs)) { check('closure-declared-missing:' + relOf(abs), false); bad++; } }
      }
      check('closure:' + dirRel, bad === 0, onDisk.length + ' files on disk');
    }
  } else {
    check('evidence-dir:closed-declared', false, 'the freeze manifest must declare evidence_dir_closed and closed_dirs');
  }

  /* ---- semantic compatibility checks (content of the byte-bound evidence JSONs) ---- */
  const evByBase = {};
  for (const entry of manifest.evidence_files || []) evByBase[path.basename(entry.path)] = norm(entry.path);
  if (evByBase['electron-acceptance.json']) {
    try {
      const acceptance = JSON.parse(fs.readFileSync(evByBase['electron-acceptance.json'], 'utf8'));
      check('evidence-acceptance-pass', acceptance.pass === true);
      check('evidence-22-routes-ok', (acceptance.routes || []).filter(r => r.ok).length === 22);
      check('evidence-18-cells-pass', (acceptance.matrix || []).length === 18 && (acceptance.matrix || []).every(c => c.pass));
      check('evidence-zero-render-errors', (acceptance.page_exceptions || []).length === 0 && (acceptance.console_errors || []).length === 0);
    } catch (e) { check('evidence-acceptance-pass', false, e.message); }
  }
  if (evByBase['route-matrix-result.json']) {
    try {
      const contract = JSON.parse(fs.readFileSync(evByBase['route-matrix-result.json'], 'utf8'));
      check('evidence-contract-pass', contract.failed === 0, (contract.total - contract.failed) + '/' + contract.total);
    } catch (e) { check('evidence-contract-pass', false, e.message); }
  }
  if (evByBase['mutation-result.json']) {
    try {
      const mutation = JSON.parse(fs.readFileSync(evByBase['mutation-result.json'], 'utf8'));
      check('evidence-mutations-all-killed', mutation.pass === true && (mutation.mutations || []).length === 6 && mutation.mutations.every(m => m.killed));
      check('evidence-mutation-no-drift', (mutation.restore_drift || []).length === 0);
    } catch (e) { check('evidence-mutations-all-killed', false, e.message); }
  }

  /* ---- governance input bindings ---- */
  if (Array.isArray(manifest.governance_inputs)) {
    for (const g of manifest.governance_inputs) {
      if (g.id === 'task_card' && g.sha256) check('governance:task-card-sha', sha256File(norm(g.path)) === g.sha256.toUpperCase());
      if (g.id === 'benchmark_manifest' && g.sha256) check('governance:benchmark-manifest-sha', sha256File(norm(g.path)) === g.sha256.toUpperCase());
    }
  }
}

const failed = results.filter(r => !r.pass);
const pass = failed.length === 0;
if (wantJson) {
  console.log(JSON.stringify({ verifier: 'ui-language-migration-22routes-verifier/v2', manifest: manifestPath, manifest_sha256: manifestSha256, result: pass ? 'PASS' : 'FAIL', total: results.length, failed: failed.length, failures: failed }, null, 1));
} else {
  console.log('verifier/v2: ' + (results.length - failed.length) + '/' + results.length + ' checks passed -> ' + (pass ? 'PASS' : 'FAIL'));
  console.log('manifest: ' + manifestPath);
  console.log('manifest_sha256: ' + manifestSha256);
  for (const f of failed) console.log('FAIL', f.id, f.detail);
}
process.exit(pass ? 0 : 1);
