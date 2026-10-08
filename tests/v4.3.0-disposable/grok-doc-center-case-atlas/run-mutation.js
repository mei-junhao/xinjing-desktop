'use strict';
/**
 * XJ-4.3.0-grok-doc-center-case-atlas-reference-01 — Mutation probes
 * Deliberately mutates preview sources; contract/probes must fail.
 * Exit: 0 = ALL-KILLED | 1 = SURVIVED | 2 = HARNESS-ERROR
 */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..', '..', '..');
var PREVIEW = path.join(ROOT, 'design-previews', '4.3.0-grok-doc-center-case-atlas');
var APP_PATH = path.join(PREVIEW, 'app.js');
var CSS_PATH = path.join(PREVIEW, 'styles.css');
var FIX_PATH = path.join(PREVIEW, 'fixtures.js');
var CONTRACT = path.join(__dirname, 'run-contract.js');
var MUT_DIR = path.join(__dirname, '.mutants');

var ORIGINAL_APP = fs.readFileSync(APP_PATH, 'utf8');
var ORIGINAL_CSS = fs.readFileSync(CSS_PATH, 'utf8');
var ORIGINAL_FIX = fs.readFileSync(FIX_PATH, 'utf8');

var killed = 0;
var survived = 0;
var harnessError = 0;
var results = [];

function record(label, status, detail) {
  results.push({ label: label, status: status, detail: detail });
  if (status === 'KILLED') killed++;
  else if (status === 'SURVIVED') survived++;
  else harnessError++;
  console.log('[' + status + '] ' + label + (detail ? ' - ' + detail : ''));
}

function runNode(args) {
  try {
    var out = cp.execFileSync(process.execPath, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000
    });
    return { code: 0, stdout: out, stderr: '' };
  } catch (e) {
    return {
      code: e.status == null ? 1 : e.status,
      stdout: (e.stdout || '').toString(),
      stderr: (e.stderr || '').toString()
    };
  }
}

function withTempFiles(mutated, fn) {
  fs.mkdirSync(MUT_DIR, { recursive: true });
  var backups = {};
  Object.keys(mutated).forEach(function (filePath) {
    backups[filePath] = fs.readFileSync(filePath, 'utf8');
    fs.writeFileSync(filePath, mutated[filePath], 'utf8');
  });
  try {
    return fn();
  } finally {
    Object.keys(backups).forEach(function (filePath) {
      fs.writeFileSync(filePath, backups[filePath], 'utf8');
    });
  }
}

function expectContractFail(label, mutated) {
  // Ensure mutation actually changes something
  var changed = Object.keys(mutated).some(function (p) {
    return mutated[p] !== fs.readFileSync(p, 'utf8');
  });
  // Read current originals for comparison before write
  changed = true;
  var identical = true;
  Object.keys(mutated).forEach(function (p) {
    var cur = p === APP_PATH ? ORIGINAL_APP : p === CSS_PATH ? ORIGINAL_CSS : p === FIX_PATH ? ORIGINAL_FIX : fs.readFileSync(p, 'utf8');
    if (mutated[p] !== cur) identical = false;
  });
  if (identical) {
    record(label, 'HARNESS-ERROR', 'mutation produced identical source');
    return;
  }

  var result = withTempFiles(mutated, function () {
    return runNode([CONTRACT]);
  });

  if (result.code !== 0) {
    record(label, 'KILLED', 'contract exit ' + result.code);
  } else {
    record(label, 'SURVIVED', 'contract still passed');
  }
}

function expectProbeFail(label, mutatedFile, mutatedContent, probeBody) {
  if (mutatedContent === ORIGINAL_APP && mutatedFile === APP_PATH) {
    record(label, 'HARNESS-ERROR', 'no-op app mutation');
    return;
  }
  fs.mkdirSync(MUT_DIR, { recursive: true });
  var safe = label.replace(/[^a-zA-Z0-9_-]/g, '_');
  var tmp = path.join(MUT_DIR, safe + path.extname(mutatedFile));
  fs.writeFileSync(tmp, mutatedContent, 'utf8');
  var runner = path.join(MUT_DIR, safe + '_runner.js');
  var code = [
    "'use strict';",
    "var fs = require('fs');",
    "var src = fs.readFileSync(process.argv[2], 'utf8');",
    "try {",
    probeBody,
    "  console.log('PROBE_PASS'); process.exit(0);",
    "} catch (e) {",
    "  console.log('PROBE_FAIL: ' + e.message); process.exit(1);",
    "}"
  ].join('\n');
  fs.writeFileSync(runner, code, 'utf8');

  var baseline = runNode([runner, mutatedFile === APP_PATH ? APP_PATH : mutatedFile === CSS_PATH ? CSS_PATH : FIX_PATH]);
  // baseline should pass on original path content
  var originalPath = mutatedFile;
  baseline = runNode([runner, originalPath]);
  if (baseline.code !== 0) {
    record(label, 'HARNESS-ERROR', 'baseline failed: ' + (baseline.stdout || baseline.stderr).slice(0, 180));
    return;
  }
  var mutant = runNode([runner, tmp]);
  if (mutant.code !== 0) {
    record(label, 'KILLED', mutant.stdout.slice(0, 160));
  } else {
    record(label, 'SURVIVED', 'probe did not detect mutation');
  }
}

// Baseline contract must pass first
(function () {
  var base = runNode([CONTRACT]);
  if (base.code !== 0) {
    console.error('Baseline contract failed; aborting mutations');
    console.error(base.stdout);
    console.error(base.stderr);
    process.exit(2);
  }
  console.log('Baseline contract: PASS');
})();

// M1: remove a segment handler (material refresh)
expectContractFail('M1-remove-material-handler', (function () {
  var mutated = {};
  mutated[APP_PATH] = ORIGINAL_APP
    .replace(/\bbtnRefreshMaterials\b/g, 'btnNoRefresh')
    .replace(/data-action="refresh-materials"/g, 'data-action="noop-materials"');
  return mutated;
})());

// M2: neutralize source-health warning copy for blocked nodes
expectContractFail('M2-neutralize-source-health', (function () {
  var mutated = {};
  mutated[APP_PATH] = ORIGINAL_APP
    .replace(/受限来源：仅保留定位，不展示正文。/g, '材料摘要可用。')
    .replace(/受限来源：不进入可用来源正文。/g, '材料摘要可用。')
    .replace(/function isBlockedStatus\(status\) \{\s*return status === 'stale' \|\| status === 'invalid' \|\| status === 'quarantined';\s*\}/,
      "function isBlockedStatus(status) { return false; /* MUTATED neutral */ }");
  return mutated;
})());

// M3: make Observatory accent identical to Clinical
expectContractFail('M3-observatory-equals-clinical', (function () {
  var mutated = {};
  // Force observatory --accent to clinical value
  var css = ORIGINAL_CSS.replace(
    /\[data-skin="observatory"\]\s*\{[\s\S]*?--accent:\s*[^;]+;/,
    function (block) {
      return block.replace(/--accent:\s*[^;]+;/, '--accent: #1f7a6b;');
    }
  );
  mutated[CSS_PATH] = css;
  return mutated;
})());

// M4: delete focus restoration
expectContractFail('M4-delete-focus-restoration', (function () {
  var mutated = {};
  mutated[APP_PATH] = ORIGINAL_APP
    .replace(/lastFocusEl/g, 'lastFocusElRemoved')
    .replace(/\.focus\(/g, '.blur(');
  return mutated;
})());

// M5: remove long Chinese clamp
expectContractFail('M5-remove-long-chinese-clamp', (function () {
  var mutated = {};
  mutated[CSS_PATH] = ORIGINAL_CSS
    .replace(/-webkit-line-clamp:\s*2;/g, '/* clamp removed */')
    .replace(/line-clamp:\s*2;/g, '/* clamp removed */');
  return mutated;
})());

// M6: remove reduced-motion handling
expectContractFail('M6-remove-reduced-motion', (function () {
  var mutated = {};
  mutated[CSS_PATH] = ORIGINAL_CSS.replace(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/m, '/* reduced-motion removed */');
  return mutated;
})());

// M7: stale/quarantined fixture becomes usable node
expectContractFail('M7-stale-quarantine-usable', (function () {
  var mutated = {};
  mutated[FIX_PATH] = ORIGINAL_FIX.replace(
    /function usableNodes\(list\) \{\s*return list\.filter\(function \(n\) \{\s*return n\.sourceStatus === 'verified' \|\| n\.sourceStatus === 'unverified';\s*\}\);/,
    "function usableNodes(list) { return list.filter(function (n) { return true; /* MUTATED: all usable */ });"
  );
  return mutated;
})());

// Direct probe: missing sourceContentHash assignment path in fixtures generation
expectProbeFail(
  'M8-missing-sourceContentHash-field',
  FIX_PATH,
  ORIGINAL_FIX.replace(/sourceContentHash: partial\.sourceContentHash \|\| shaLike\('src:' \+ id\),/, '/* hash removed */'),
  [
    "if (src.indexOf('sourceContentHash') < 0) throw new Error('sourceContentHash removed');",
    "if (src.indexOf(\"sourceContentHash: partial.sourceContentHash || shaLike('src:' + id)\") < 0) throw new Error('sourceContentHash assignment mutated');"
  ].join('\n')
);

console.log('');
console.log('Mutation summary: killed=' + killed + ' survived=' + survived + ' harnessError=' + harnessError);
results.forEach(function (r) {
  console.log('- ' + r.label + ': ' + r.status);
});

if (harnessError > 0) process.exit(2);
if (survived > 0) process.exit(1);
console.log('MUTATION_OK');
process.exit(0);
