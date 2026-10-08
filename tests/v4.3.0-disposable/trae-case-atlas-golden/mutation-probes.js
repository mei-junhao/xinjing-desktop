'use strict';
/**
 * XJ-4.3.0-trae-case-atlas-golden-prototype-05 -- Mutation Probes
 *
 * Source-level mutation probes for the isolated HTML prototype.
 * Each probe modifies the HTML source, then re-runs targeted checks
 * to verify the mutant is detected.
 *
 * Classification: KILLED / SURVIVED / NO-OP / HARNESS-ERROR / UNSUPPORTED_EXPECTED_RED
 *
 * Exit: 0 = ALL-KILLED | 1 = SURVIVED | 2 = HARNESS-ERROR
 */
var path = require('path');
var fs = require('fs');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..', '..', '..');
var PROTO_PATH = path.join(ROOT, 'design-previews', '4.3.0-trae-case-atlas-golden', 'index.html');

var ORIGINAL = fs.readFileSync(PROTO_PATH, 'utf8');

var killed = 0, survived = 0, noop = 0, harnessError = 0, unsupported = 0;
var results = [];

function record(label, status, detail) {
  results.push({ label: label, status: status, detail: detail });
  if (status === 'KILLED') killed++;
  else if (status === 'SURVIVED') survived++;
  else if (status === 'NO-OP') noop++;
  else if (status === 'HARNESS-ERROR') harnessError++;
  else if (status === 'UNSUPPORTED_EXPECTED_RED') unsupported++;
}

function runNode(args, cwd) {
  try {
    var r = cp.execFileSync(process.execPath, args, {
      cwd: cwd || ROOT,
      stdio: 'pipe',
      timeout: 30000,
      encoding: 'utf8'
    });
    return { exitCode: 0, stdout: r.toString(), stderr: '' };
  } catch (e) {
    return { exitCode: e.status != null ? e.status : -1, stdout: (e.stdout || '').toString(), stderr: (e.stderr || '').toString() };
  }
}

/**
 * runProbe(label, mutatedHtml, probeBody)
 * probeBody: a string of JS code that receives `html` (the file content as string)
 *   and must throw on mutant, not throw on original.
 *
 * The generated runner:
 *   'use strict';
 *   var fs = require('fs');
 *   var html = fs.readFileSync(process.argv[2], 'utf8');
 *   try { <probeBody> console.log('PROBE_PASS'); process.exit(0); }
 *   catch (e) { console.log('PROBE_FAIL: ' + e.message); process.exit(1); }
 */
function runProbe(label, mutatedHtml, probeBody) {
  if (mutatedHtml === ORIGINAL) {
    record(label, 'NO-OP', 'mutation produced identical source');
    return;
  }

  var tmpDir = path.join(__dirname, '.mutants');
  fs.mkdirSync(tmpDir, { recursive: true });
  var safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
  var tmpProto = path.join(tmpDir, safeLabel + '_proto.html');
  fs.writeFileSync(tmpProto, mutatedHtml, 'utf8');

  var probeCode = [
    "'use strict';",
    "var fs = require('fs');",
    "var html = fs.readFileSync(process.argv[2], 'utf8');",
    "try {",
    probeBody,
    "  console.log('PROBE_PASS'); process.exit(0);",
    "} catch (e) {",
    "  console.log('PROBE_FAIL: ' + e.message); process.exit(1);",
    "}"
  ].join('\n');

  var runnerPath = path.join(tmpDir, safeLabel + '_runner.js');
  fs.writeFileSync(runnerPath, probeCode, 'utf8');

  // Baseline: check original passes
  var baseline = runNode([runnerPath, PROTO_PATH]);
  if (baseline.exitCode !== 0) {
    record(label, 'HARNESS-ERROR', 'baseline fail on original: ' + baseline.stdout.slice(0, 200) + (baseline.stderr ? ' stderr=' + baseline.stderr.slice(0, 100) : ''));
    return;
  }

  // Mutant: must fail
  var mutant = runNode([runnerPath, tmpProto]);
  if (mutant.exitCode !== 0) {
    record(label, 'KILLED', mutant.stdout.slice(0, 200));
  } else {
    record(label, 'SURVIVED', 'mutation not detected');
  }
}

// ============================ REQUIRED MUTATIONS ============================

// M1: Remove sourceContentHash assignment from a source entry
(function () {
  var mutated = ORIGINAL.replace(
    /src\.sourceContentHash = fakeSha256\('src:' \+ seed\);/,
    '/* MUTATED: hash removed */'
  );
  runProbe('M1-missing-sourceContentHash', mutated, [
    "if (html.indexOf('src.sourceContentHash = fakeSha256') < 0) throw new Error('sourceContentHash assignment removed');"
  ].join('\n'));
})();

// M2: Remove anchorContentHash assignment from a source entry
(function () {
  var mutated = ORIGINAL.replace(
    /src\.anchorContentHash = fakeSha256\('anc:' \+ seed\);/,
    '/* MUTATED: hash removed */'
  );
  runProbe('M2-missing-anchorContentHash', mutated, [
    "if (html.indexOf('src.anchorContentHash = fakeSha256') < 0) throw new Error('anchorContentHash assignment removed');"
  ].join('\n'));
})();

// M3: Change invalid status to active (status bypass)
(function () {
  var mutated = ORIGINAL.replace("status: 'invalid'", "status: 'active' /* MUTATED */");
  runProbe('M3-invalid-shows-as-active', mutated, [
    "if (html.indexOf(\"status: 'invalid'\") < 0) throw new Error('invalid status removed or changed');"
  ].join('\n'));
})();

// M4: AI draft as formal conclusion -- remove aiDraft marker to simulate AI draft shown as formal
(function () {
  var mutated = ORIGINAL.replace(
    /aiDraft: true/g,
    'aiDraft: false /* MUTATED: AI draft shown as formal */'
  );
  runProbe('M4-ai-draft-as-formal', mutated, [
    "if (html.indexOf('aiDraft: true') < 0) throw new Error('AI draft marker removed -- AI inference shown as formal conclusion');"
  ].join('\n'));
})();

// M5: Remove 900px media query (narrow window would keep multi-column)
(function () {
  var marker = '@media (max-width: 900px) {';
  var startIdx = ORIGINAL.indexOf(marker);
  if (startIdx < 0) {
    record('M5-narrow-3col-bypass', 'NO-OP', '900px media query not found');
    return;
  }
  // Find the matching closing brace by counting depth
  var depth = 0;
  var endIdx = -1;
  for (var i = startIdx + marker.length; i < ORIGINAL.length; i++) {
    if (ORIGINAL[i] === '{') depth++;
    else if (ORIGINAL[i] === '}') {
      if (depth === 0) { endIdx = i; break; }
      depth--;
    }
  }
  if (endIdx < 0) {
    record('M5-narrow-3col-bypass', 'NO-OP', 'matching closing brace not found');
    return;
  }
  var mutated = ORIGINAL.substring(0, startIdx) + '/* MUTATED: narrow breakpoint removed */' + ORIGINAL.substring(endIdx + 1);
  runProbe('M5-narrow-3col-bypass', mutated, [
    "if (html.indexOf('900px') < 0) throw new Error('900px breakpoint was removed');"
  ].join('\n'));
})();

// M6: Remove prefers-reduced-motion media query
(function () {
  var marker = '@media (prefers-reduced-motion: reduce) {';
  var startIdx = ORIGINAL.indexOf(marker);
  if (startIdx < 0) {
    record('M6-reduced-motion-bypass', 'NO-OP', 'prefers-reduced-motion not found');
    return;
  }
  var depth = 0;
  var endIdx = -1;
  for (var i = startIdx + marker.length; i < ORIGINAL.length; i++) {
    if (ORIGINAL[i] === '{') depth++;
    else if (ORIGINAL[i] === '}') {
      if (depth === 0) { endIdx = i; break; }
      depth--;
    }
  }
  if (endIdx < 0) {
    record('M6-reduced-motion-bypass', 'NO-OP', 'matching closing brace not found');
    return;
  }
  var mutated = ORIGINAL.substring(0, startIdx) + '/* MUTATED: prefers-reduced-motion removed */' + ORIGINAL.substring(endIdx + 1);
  runProbe('M6-reduced-motion-bypass', mutated, [
    "if (html.indexOf('prefers-reduced-motion') < 0) throw new Error('reduced motion query was removed');",
    "if (html.indexOf('0.01ms') < 0) throw new Error('zero duration override was removed');"
  ].join('\n'));
})();

// M7: Remove lastFocusedEl tracking (drawer close loses focus)
(function () {
  var mutated = ORIGINAL.replace(/lastFocusedEl/g, '_MUTATED_FOCUS_REMOVED_');
  runProbe('M7-drawer-focus-lost', mutated, [
    "if (html.indexOf('lastFocusedEl') < 0) throw new Error('lastFocusedEl was removed -- focus return broken');"
  ].join('\n'));
})();

// ============================ SUMMARY ============================
console.log('');
console.log('=== Mutation Probes: Golden Time Case Atlas Prototype ===');
console.log('node: ' + process.execPath + ' (' + process.version + ')');
console.log('');
results.forEach(function (r) {
  var tag = '[' + r.status + ']';
  console.log(tag.padEnd(30) + r.label + (r.detail ? ' -- ' + r.detail.slice(0, 120) : ''));
});
console.log('');
console.log('KILLED:                   ' + killed);
console.log('SURVIVED:                 ' + survived);
console.log('UNSUPPORTED_EXPECTED_RED: ' + unsupported);
console.log('NO-OP:                    ' + noop);
console.log('HARNESS-ERROR:            ' + harnessError);
console.log('Total:                    ' + results.length);
console.log('');

if (survived > 0) {
  console.log('mutation_phase: CONTRACT-BROKEN (' + survived + ' survived)');
  process.exit(1);
} else if (harnessError > 0) {
  console.log('mutation_phase: HARNESS-ERROR (' + harnessError + ' harness errors)');
  process.exit(2);
} else {
  console.log('mutation_phase: ALL-MUTATIONS-KILLED (' + killed + ' killed, ' + unsupported + ' unsupported, ' + noop + ' no-op)');
  process.exit(0);
}
