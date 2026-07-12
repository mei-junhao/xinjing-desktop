/**
 * cloud-verify.js — 心镜 XinJing 云激活校验（主进程模块）
 *
 * 与本地激活（license-core.js HMAC-SHA256 离线验签）并行的第二条通道：
 *   本地激活：客户端持 SECRET，verifyKey 离线验签，无需联网。
 *   云激活：SECRET 只在云端 Cloudflare Worker，客户端 POST {code, machineCode} 过去，
 *           云端用同一 SECRET 验签后返回 {ok, identity, tier, expiresAt}。
 *
 * 两者写同一份 license.json、复用同一个 computeState() + xj:license-state 广播，
 * 下游 App.aiUnlocked() / preload onLicenseState / 各页锁盖无需感知激活来源。
 *
 * 云激活码与本地激活码复用同一 encodeKey(identity, tier, machineCode, expiresAt)
 * （license-core.js L110）——云端用同一 SECRET 验签，编码格式完全一致。
 */
'use strict';

const https = require('https');

// 云端校验端点（Cloudflare Worker，验签逻辑在云端，SECRET 不入 app）。
// 开发者部署后在此填入实际 Worker 域名；占位符在未配置时返回明确错误。
const CLOUD_VERIFY_HOST = process.env.XJ_CLOUD_VERIFY_HOST || '';  // 例如 'xinjing-license.example.workers.dev'
const CLOUD_VERIFY_PATH = '/license/verify';
const TIMEOUT_MS = 12000;

/**
 * verifyCloud(code, machineCode) — POST 云端端点校验
 * @param {string} code - 云激活码（与本地激活码格式一致，encodeKey 产）
 * @param {string} machineCode - 本机机器码（main.js getMachineCode 产）
 * @returns {Promise<{ok:boolean, identity?:string, tier?:string, expiresAt?:number, error?:string}>}
 */
function verifyCloud(code, machineCode) {
  return new Promise((resolve) => {
    if (!CLOUD_VERIFY_HOST) {
      resolve({ ok: false, error: '云激活未配置：开发者尚未部署云端校验端点。请改用本地激活码激活，或联系开发者。' });
      return;
    }
    if (!code || !machineCode) {
      resolve({ ok: false, error: '云激活参数缺失：需同时提供激活码与机器码。' });
      return;
    }

    const body = JSON.stringify({ code, machineCode });
    const opts = {
      hostname: CLOUD_VERIFY_HOST,
      port: 443,
      path: CLOUD_VERIFY_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'XinJing/1.3 (Electron; cloud-activate)'
      },
      timeout: TIMEOUT_MS
    };

    const req = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve({ ok: false, error: '云端校验返回异常状态：' + res.statusCode });
          return;
        }
        try {
          const j = JSON.parse(buf);
          if (j && j.ok === true && j.identity) {
            resolve({
              ok: true,
              identity: String(j.identity),
              tier: String(j.tier || 'full'),
              expiresAt: Number(j.expiresAt) || 0
            });
          } else {
            resolve({ ok: false, error: (j && j.error) || '云端校验未通过' });
          }
        } catch (e) {
          resolve({ ok: false, error: '云端响应格式异常：' + e.message });
        }
      });
    });

    req.on('timeout', () => {
      try { req.destroy(); } catch (e) {}
      resolve({ ok: false, error: '云激活超时：请检查网络后重试，或改用本地激活码。' });
    });
    req.on('error', (err) => {
      resolve({ ok: false, error: '云激活网络失败：' + (err.message || err.code || '未知错误') });
    });
    req.write(body);
    req.end();
  });
}

module.exports = { verifyCloud };
