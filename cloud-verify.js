/**
 * XinJing cloud activation transport.
 *
 * The cloud may exchange a purchase/recovery code for a signed v2 claim. This
 * module never treats cloud identity, tier or expiry fields as authoritative;
 * main.js verifies the returned claim locally before it is persisted.
 */
'use strict';

const https = require('https');
const dns = require('dns').promises;
const nodeNet = require('net');

const CLOUD_VERIFY_HOST = process.env.XJ_CLOUD_VERIFY_HOST || '';
const CLOUD_VERIFY_PATH = '/license/verify';
const TIMEOUT_MS = 12000;
const MAX_REQUEST_CODE_CHARS = 16384;
const MAX_RESPONSE_BYTES = 24 * 1024;

function configuredHost() {
  const host = String(CLOUD_VERIFY_HOST || '').trim();
  if (!host || host.length > 253 || host.includes('/') || host.includes('@') || host.includes(':')) return '';
  if (!/^[A-Za-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.')) return '';
  if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost') || host.toLowerCase().endsWith('.local')) return '';
  if (nodeNet.isIP(host)) return '';
  return host;
}

function isPrivateNetworkAddress(address) {
  const value = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (nodeNet.isIPv4(value)) {
    const parts = value.split('.').map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224;
  }
  if (nodeNet.isIPv6(value)) {
    if (value === '::1' || value === '::') return true;
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateNetworkAddress(mapped[1]);
    const first = parseInt(value.split(':')[0] || '0', 16);
    return first < 0x2000 || first > 0x3fff || /^2001:db8(?::|$)/.test(value);
  }
  return true;
}

async function resolvePublicAddresses(host) {
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => isPrivateNetworkAddress(item.address))) {
    throw new Error('cloud activation host resolved to a private address');
  }
  return addresses;
}

function extractSignedClaim(body) {
  if (!body || body.ok !== true || typeof body !== 'object' || Array.isArray(body)) return null;
  const candidate = body.signedClaim !== undefined ? body.signedClaim
    : (body.code !== undefined ? body.code : body.claim);
  if (typeof candidate === 'string') {
    const text = candidate.trim();
    return text.startsWith('XJ2-') && text.length <= MAX_REQUEST_CODE_CHARS ? text : null;
  }
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    try {
      return Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= MAX_REQUEST_CODE_CHARS ? candidate : null;
    } catch (error) {
      return null;
    }
  }
  return null;
}

async function verifyCloud(code, machineCode) {
  const host = configuredHost();
  if (!host) return { ok: false, error: '云激活尚未配置，请使用离线激活码或联系支持。' };
  if (typeof code !== 'string' || !code.trim() || code.length > MAX_REQUEST_CODE_CHARS || !String(machineCode || '').trim()) {
    return { ok: false, error: '云激活参数不完整或长度不正确。' };
  }
  let resolvedAddresses;
  try {
    resolvedAddresses = await resolvePublicAddresses(host);
  } catch (error) {
    return { ok: false, error: '云激活服务地址未通过安全校验。' };
  }
  return new Promise((resolve) => {
    const body = JSON.stringify({ code: code.trim(), machineCode: String(machineCode).trim() });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = https.request({
      hostname: host,
      port: 443,
      path: CLOUD_VERIFY_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'application/json',
        'User-Agent': 'XinJing/4.2.1 (Electron; cloud-activate-v2)',
      },
      timeout: TIMEOUT_MS,
      lookup: (_hostname, options, callback) => {
        if (options && options.all) callback(null, resolvedAddresses);
        else callback(null, resolvedAddresses[0].address, resolvedAddresses[0].family);
      },
    }, (response) => {
      let bytes = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy();
          finish({ ok: false, error: '云端响应过大，已拒绝处理。' });
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        if (response.statusCode !== 200) {
          finish({ ok: false, error: '云端校验返回异常状态：' + response.statusCode });
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const signedClaim = extractSignedClaim(parsed);
          if (!signedClaim) {
            finish({ ok: false, error: typeof parsed.error === 'string' ? parsed.error.slice(0, 300) : '云端未返回可验证的授权声明。' });
            return;
          }
          finish({ ok: true, signedClaim });
        } catch (error) {
          finish({ ok: false, error: '云端响应格式异常。' });
        }
      });
      response.on('error', () => finish({ ok: false, error: '云端响应读取失败。' }));
    });

    request.on('timeout', () => {
      request.destroy();
      finish({ ok: false, error: '云激活超时，请检查网络后重试。' });
    });
    request.on('error', (error) => finish({ ok: false, error: '云激活网络失败：' + (error.message || error.code || '未知错误') }));
    request.end(body);
  });
}

module.exports = { verifyCloud };
