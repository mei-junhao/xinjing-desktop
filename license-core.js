/**
 * license-core.js — 心镜 XinJing 激活码核心（开发者出码 + 客户端校验共用）
 * 纯离线方案：HMAC-SHA256 签名，不依赖任何服务器。
 *
 * 码结构（base32，RFC4648，无填充）：
 *   XJ-XXXX-XXXX-...
 *   解码后明文 = identity + "\n" + sig(前32位十六进制)
 *   identity 为用户标识（邮箱/姓名），sig = HMAC-SHA256(SECRET, identity)
 */
'use strict';

const crypto = require('crypto');

// 主密钥：本文件不再硬编码任何密钥。
// 构建/运行时由 scripts/codegen-secret.js 从 .license-secret（gitignored）或环境变量 LICENSE_SECRET
// 注入到 secret.generated.js（gitignored），再在此处读取。源码仓库与 git 历史中均不含密钥字面量。
let SECRET = '';
try { SECRET = require('./secret.generated').SECRET; } catch (e) { /* 开发态可能尚未生成 */ }
if (!SECRET) { try { SECRET = require('./.license-secret').SECRET; } catch (e) { /* 本机持有 */ } }
if (!SECRET) { SECRET = process.env.LICENSE_SECRET || ''; }
if (!SECRET) {
  throw new Error('[license-core] 未找到 LICENSE_SECRET：请先运行 node scripts/codegen-secret.js，或在 .license-secret / 环境变量中提供');
}

const TRIAL_DAYS = 90;

// 付费分层（Freemium）：
//   pro    = 标准付费版（解锁 AI 助手 / 多位置备份等拓展功能）
//   custom = 定制旗舰版（在 pro 基础上叠加定制功能，如内嵌多大师对话引擎）
//   full   = 旧激活码（无 tier 前缀，祖父条款，权益等同 pro）
//   free   = 未激活（基础功能免费，AI 助手锁定）
const PAID_TIERS = ['pro', 'custom', 'full'];

// 从 identity 字符串解析 tier（'pro:xxx' / 'custom:xxx' / 'xxx'）
function parseTier(identity) {
  if (!identity) return 'free';
  const idx = identity.indexOf(':');
  if (idx === -1) return 'full'; // 旧激活码无前缀 = 完整解锁（祖父条款）
  const t = identity.slice(0, idx).toLowerCase();
  if (t === 'pro' || t === 'custom') return t;
  return 'full'; // 未知前缀按旧版完整解锁处理
}

// 拆分 tier 与真实展示标识（去掉 tier 前缀）
function splitIdentity(identity) {
  if (!identity) return { tier: 'free', identity: '' };
  const idx = identity.indexOf(':');
  if (idx === -1) return { tier: 'full', identity };
  const t = identity.slice(0, idx).toLowerCase();
  if (t === 'pro' || t === 'custom') return { tier: t, identity: identity.slice(idx + 1) };
  return { tier: 'full', identity };
}

// ---------- base32（手动实现，兼容 Electron 内置 Node 18） ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (let i = 0; i < buf.length; i++) {
    value = ((value << 8) | buf[i]) & 0xffffffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1; // 仅保留剩余低位，防止溢出
  }
  if (bits > 0) {
    out += B32[(value << (5 - bits)) & 31];
  }
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const idx = B32.indexOf(str[i]);
    if (idx === -1) continue;
    value = ((value << 5) | idx) & 0xffffffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= (1 << bits) - 1; // 仅保留剩余低位，防止溢出
  }
  return Buffer.from(out);
}

// ---------- 内部工具 ----------
function hmacHex(identity) {
  return crypto.createHmac('sha256', SECRET).update(String(identity)).digest('hex');
}

function cleanKeyInput(key) {
  let s = String(key || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (s.startsWith('XJ')) s = s.slice(2); // 去掉前缀，X/J 本身是合法 base32 字符
  return s;
}

// ---------- 对外 API ----------
function encodeKey(identity, tier) {
  let id = String(identity || '').trim().slice(0, 64);
  if (!id) throw new Error('身份标识不能为空');
  const t = (tier || '').toLowerCase();
  if (t === 'pro' || t === 'custom') id = t + ':' + id; // 把 tier 编码进 identity 前缀
  const sig = hmacHex(id).slice(0, 32);
  const raw = Buffer.from(id + '\n' + sig, 'utf8');
  const grouped = base32Encode(raw).match(/.{1,4}/g).join('-');
  return 'XJ-' + grouped;
}

function verifyKey(key) {
  try {
    const clean = cleanKeyInput(key);
    if (!clean) return { valid: false, identity: '', tier: 'free' };
    const text = base32Decode(clean).toString('utf8');
    const nl = text.indexOf('\n');
    if (nl === -1) return { valid: false, identity: '', tier: 'free' };
    const rawIdentity = text.slice(0, nl);
    const sig = text.slice(nl + 1);
    if (!rawIdentity || !sig) return { valid: false, identity: '', tier: 'free' };
    const expected = hmacHex(rawIdentity).slice(0, 32);
    const valid = sig === expected;
    const sp = splitIdentity(rawIdentity);
    return { valid, identity: sp.identity, tier: valid ? sp.tier : 'free' };
  } catch (e) {
    return { valid: false, identity: '', tier: 'free' };
  }
}

function trialStatus(firstLaunchTs, nowTs) {
  const now = nowTs || Date.now();
  const daysPassed = Math.floor((now - firstLaunchTs) / 86400000);
  const daysLeft = TRIAL_DAYS - daysPassed;
  return daysLeft > 0
    ? { state: 'active', daysLeft }
    : { state: 'expired', daysLeft: 0 };
}

function overallMode(activated, trial) {
  if (activated) return 'full';
  return trial.state === 'active' ? 'trial' : 'limited';
}

module.exports = {
  SECRET,
  TRIAL_DAYS,
  PAID_TIERS,
  encodeKey,
  verifyKey,
  trialStatus,
  overallMode,
  parseTier,
  splitIdentity
};
