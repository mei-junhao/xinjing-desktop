'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = 'D:\\xinjing-electron';
const MATRIX = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'capability-parity', 'capability-parity-matrix.md');
const REQUIRED = [
  'clinical workbench', 'schedule', 'client records', 'session notes', 'transcript',
  'reports', 'AI supervision', 'human supervision', 'masters', 'materials/library',
  'SourceRef and ClinicalContext', 'billing', 'backup/export/print', 'settings/activation',
  'visual languages', 'durable-save and context-safety', 'entitlements', 'controlled AI failure/cancellation',
];
const VALID_STATUSES = new Set(['CONFIRMED', 'INFERRED', 'MISSING']);

function parseMatrix(content) {
  const errors = [];
  const lines = String(content || '').split(/\r?\n/);
  const rows = [];
  let inMatrix = false;
  let inSummary = false;
  const summary = {};

  for (const line of lines) {
    if (line === '## Capability Parity Matrix') { inMatrix = true; inSummary = false; continue; }
    if (line === '## Summary') { inMatrix = false; inSummary = true; continue; }
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (inMatrix && /^\d+$/.test(cells[0] || '')) rows.push(cells);
    if (inSummary && ['CONFIRMED', 'INFERRED', 'MISSING', 'TOTAL'].includes(cells[0])) {
      summary[cells[0]] = Number(cells[1]);
    }
  }

  if (rows.length !== REQUIRED.length) errors.push(`expected exactly ${REQUIRED.length} numbered rows, found ${rows.length}`);
  const capabilities = rows.map(row => row[1]);
  REQUIRED.forEach(capability => {
    const count = capabilities.filter(value => value === capability).length;
    if (count !== 1) errors.push(`capability ${capability} appears ${count} times in its row`);
  });
  rows.forEach((row, index) => {
    if (row.length !== 6) errors.push(`row ${index + 1} has ${row.length} columns, expected 6`);
    if (Number(row[0]) !== index + 1) errors.push(`row order is invalid at ${row[0] || 'empty'}`);
    if (!VALID_STATUSES.has(row[3])) errors.push(`row ${row[0] || index + 1} has invalid status ${row[3] || 'empty'}`);
  });

  const citations = rows.flatMap(row => (row[2].match(/`([^`]+)`/g) || []).map(value => value.slice(1, -1)));
  if (!citations.length) errors.push('matrix has no source citations');
  citations.forEach(citation => {
    if (path.isAbsolute(citation) || citation.includes('..')) {
      errors.push(`citation escapes repository root: ${citation}`);
      return;
    }
    const resolved = path.resolve(ROOT, citation);
    if (!resolved.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      errors.push(`citation does not resolve to a repository file: ${citation}`);
    }
  });

  const counts = { CONFIRMED: 0, INFERRED: 0, MISSING: 0 };
  rows.forEach(row => { if (VALID_STATUSES.has(row[3])) counts[row[3]] += 1; });
  ['CONFIRMED', 'INFERRED', 'MISSING'].forEach(status => {
    if (summary[status] !== counts[status]) errors.push(`summary ${status}=${summary[status]} does not match ${counts[status]}`);
  });
  if (summary.TOTAL !== rows.length) errors.push(`summary TOTAL=${summary.TOTAL} does not match ${rows.length}`);
  return { errors, rows, counts, summary };
}

function runSelfTest() {
  const original = fs.readFileSync(MATRIX, 'utf8');
  const mutations = [
    ['remove required row', original.replace(/^\| 1 \|.*\r?\n/m, '')],
    ['invalid status', original.replace('| CONFIRMED |', '| UNKNOWN |')],
    ['missing cited source', original.replace('app/index.html', 'app/not-a-real-source.js')],
    ['cluster only outside its row', original.replace('| 1 | clinical workbench |', '| 1 | removed capability |') + '\nclinical workbench'],
    ['wrong missing summary', original.replace('| MISSING | 0 |', '| MISSING | 1 |')],
  ];
  const survivors = mutations.filter(([, content]) => parseMatrix(content).errors.length === 0).map(([label]) => label);
  if (survivors.length) throw new Error(`mutation survivors: ${survivors.join(', ')}`);
  console.log(`mutation probes: ${mutations.length}/${mutations.length} killed`);
}

function main() {
  const result = parseMatrix(fs.readFileSync(MATRIX, 'utf8'));
  result.errors.forEach(error => console.error(`[FAIL] ${error}`));
  if (process.argv.includes('--self-test')) runSelfTest();
  if (result.errors.length) process.exitCode = 1;
  else console.log(`parity matrix: PASS (${result.rows.length} rows; ${result.counts.CONFIRMED} confirmed, ${result.counts.INFERRED} inferred, ${result.counts.MISSING} missing)`);
}

if (require.main === module) main();
module.exports = { parseMatrix };
