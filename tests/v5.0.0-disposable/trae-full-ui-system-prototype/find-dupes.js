const fs = require('fs');
const c = fs.readFileSync('d:/xinjing-electron/design-previews/5.0.0-trae-full-ui-system-prototype/app.js','utf8');
const lines = c.split('\n');
const routeDefs = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/routes\s*(\[|\.)\s*['"]?([a-z-]+)['"]?\]?\s*=\s*(?:async\s+)?function/);
  if (m) routeDefs.push({ line: i+1, name: m[2], text: lines[i].trim().substring(0, 80) });
}
console.log('All route definitions:');
const counts = {};
for (const r of routeDefs) {
  console.log(`  L${r.line}: ${r.name}`);
  counts[r.name] = (counts[r.name] || 0) + 1;
}
console.log('\nDuplicates:');
for (const [name, count] of Object.entries(counts)) {
  if (count > 1) console.log(`  ${name}: ${count} definitions`);
}
