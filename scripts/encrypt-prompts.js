// 加密大师提示词文件为 .bin（AES-256-CBC，密钥由机器码派生）
// 用法：node scripts/encrypt-prompts.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const SRC_DIR = path.join(__dirname, '..', 'app', 'masters', 'knowledge');
const DST_DIR = path.join(__dirname, '..', 'app', 'masters', 'prompts');

function getMachineCode() {
  let sn = '';
  try {
    const cp = require('child_process');
    const out = cp.execSync('wmic baseboard get serialnumber', { encoding: 'utf8' });
    sn = out.split('\n')[1] ? out.split('\n')[1].trim() : '';
  } catch (e) {}
  if (!sn || sn.length < 4) sn = os.hostname() + '-fallback';
  return os.hostname() + '-' + sn;
}

const key = crypto.createHash('sha256').update(getMachineCode()).digest();

function encryptText(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let enc = cipher.update(text, 'utf8');
  enc = Buffer.concat([enc, cipher.final()]);
  return Buffer.concat([iv, enc]);
}

const masterKeys = [
  'winnicott', 'freud', 'jung', 'klein', 'kohut', 'rogers',
  'bion', 'beck', 'sue-johnson', 'yalom', 'adler', 'lacan',
];

let ok = 0, fail = 0;
fs.mkdirSync(DST_DIR, { recursive: true });
for (const key of masterKeys) {
  const src = path.join(SRC_DIR, key + '-perspective.md');
  const dst = path.join(DST_DIR, key + '.bin');
  if (!fs.existsSync(src)) { console.log('  SKIP (not found):', key); continue; }
  try {
    let text = fs.readFileSync(src, 'utf8');
    text = text.replace(/^---\n[\s\S]*?\n---\s*\n/, '').trim();
    const enc = encryptText(text);
    fs.writeFileSync(dst, enc);
    console.log('  OK:', key, '(' + text.length + ' chars, ' + enc.length + ' bytes)');
    ok++;
  } catch (e) {
    console.log('  FAIL:', key, e.message);
    fail++;
  }
}
console.log('\n完成：' + ok + ' 成功，' + fail + ' 失败');
console.log('密钥（sha256 机器码）：' + key.toString('hex').slice(0, 16) + '...');
