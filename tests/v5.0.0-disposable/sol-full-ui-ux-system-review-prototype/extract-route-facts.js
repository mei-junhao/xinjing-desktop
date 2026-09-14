'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = 'D:/xinjing-electron';
const MANIFEST_PATH = path.join(
  ROOT,
  'docs/agent-coordination/v5.0.0/cli-coordination/runs',
  'XJ-5.0.0-sol-v5-full-ui-ux-system-review-prototype-282',
  'workspace/input/INPUT_MANIFEST.json'
);
const OUTPUT = path.join(
  ROOT,
  'docs/agent-coordination/v5.0.0/cli-coordination/runs',
  'XJ-5.0.0-sol-v5-full-ui-ux-system-review-prototype-282',
  'workspace/evidence/production-route-facts.json'
);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
function matches(source, pattern, group) {
  return unique([...source.matchAll(pattern)].map((item) => item[group]));
}
function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
function text(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[^;]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const htmlFiles = manifest.files
  .map((item) => item.path)
  .filter((filePath) => /\/app\/[^/]+\.html$/i.test(filePath));

const routes = htmlFiles.map((filePath) => {
  const source = fs.readFileSync(filePath, 'utf8');
  const title = matches(source, /<title[^>]*>([\s\S]*?)<\/title>/gi, 1).map(text);
  const headings = matches(source, /<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi, 1).map(text);
  const buttons = matches(source, /<button[^>]*>([\s\S]*?)<\/button>/gi, 1).map(text);
  const scripts = matches(source, /<script[^>]+src=["']([^"']+)["'][^>]*>/gi, 1);
  const styles = matches(source, /<link[^>]+href=["']([^"']+\.css(?:\?[^"']*)?)["'][^>]*>/gi, 1);
  const featureKeys = unique([
    ...matches(source, /(?:canUse|featureGate)\s*\(\s*["']([^"']+)["']/gi, 1),
    ...matches(source, /data-feature=["']([^"']+)["']/gi, 1)
  ]);
  const states = {
    loading: /loading|加载中|正在处理|skeleton/i.test(source),
    empty: /empty|空状态|暂无|还没有/i.test(source),
    error: /error|失败|重试|异常/i.test(source),
    offline: /offline|离线|本地优先/i.test(source),
    stale: /stale|过期|失效|quarantin/i.test(source),
    focus: /focus-visible|tabindex|aria-/i.test(source),
    narrow: /@media\s*\(max-width|narrow|drawer/i.test(source)
  };
  return {
    route: path.basename(filePath, '.html'),
    path: filePath,
    bytes: fs.statSync(filePath).size,
    sha256: sha256(filePath),
    title,
    headings: headings.slice(0, 18),
    buttons: buttons.slice(0, 30),
    scripts,
    styles,
    featureKeys,
    states
  };
}).sort((left, right) => left.route.localeCompare(right.route, 'en'));

fs.writeFileSync(OUTPUT, JSON.stringify({
  task_id: 'XJ-5.0.0-sol-v5-full-ui-ux-system-review-prototype-282',
  generated_at: new Date().toISOString(),
  route_count: routes.length,
  routes
}, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ output: OUTPUT, routeCount: routes.length }));
