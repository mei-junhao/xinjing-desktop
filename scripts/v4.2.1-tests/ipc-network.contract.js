#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeNet = require('net');
const { TextDecoder: NodeTextDecoder } = require('util');

const ROOT = path.join(__dirname, '..', '..');
const PATHS = {
  main: path.join(ROOT, 'main.js'),
  preload: path.join(ROOT, 'preload.js'),
  ai: path.join(ROOT, 'app', 'js', 'ai.js'),
  settings: path.join(ROOT, 'app', 'js', 'settings.js'),
  agentTools: path.join(ROOT, 'app', 'js', 'agent-tools.js'),
  closePreload: path.join(ROOT, 'confirm-close-preload.js'),
};
const SRC = Object.fromEntries(Object.entries(PATHS).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]));
const SHA = Object.fromEntries(Object.entries(SRC).map(([key, source]) => [key, crypto.createHash('sha256').update(source).digest('hex')]));

let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push({ name, ok: true });
  } catch (error) {
    failed++;
    results.push({ name, ok: false, error: error && error.message ? error.message : String(error) });
  }
}

function headerBag(values) {
  const normalized = {};
  Object.keys(values || {}).forEach((key) => { normalized[key.toLowerCase()] = String(values[key]); });
  return { get: (name) => normalized[String(name || '').toLowerCase()] || null };
}

function mockResponse(options) {
  options = options || {};
  const chunks = options.chunks || null;
  let index = 0;
  return {
    ok: options.ok !== false && Number(options.status || 200) >= 200 && Number(options.status || 200) < 300,
    status: Number(options.status || 200),
    headers: headerBag(options.headers || { 'content-type': 'application/json' }),
    body: chunks ? {
      getReader: () => ({
        read: async () => index < chunks.length ? { done: false, value: chunks[index++] } : { done: true },
        cancel: async () => {},
      }),
    } : null,
    text: async () => String(options.text || ''),
  };
}

function buildHarness() {
  const begin = SRC.main.indexOf('function encryptSecret');
  const end = SRC.main.indexOf("app.setName('XinJing')");
  assert.ok(begin >= 0 && end > begin, '无法从 main.js 提取真实 NetworkBroker 边界');
  const state = {
    calls: [],
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetch: async (url, options) => {
      state.calls.push({ url, options });
      return mockResponse({
        text: JSON.stringify({ choices: [{ message: { content: 'synthetic-ok' } }] }),
      });
    },
  };
  const context = vm.createContext({
    AbortController,
    Buffer,
    URL,
    NodeTextDecoder,
    nodeNet,
    console,
    setTimeout,
    clearTimeout,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(String(value), 'utf8'),
      decryptString: (value) => Buffer.from(value).toString('utf8'),
    },
    electronNet: { fetch: (url, options) => state.fetch(url, options) },
    dns: { lookup: (host, options) => state.lookup(host, options) },
    APP_PROXY_KEY: 'synthetic-proxy-key',
    getMachineCode: () => 'synthetic-machine',
    PORT: 4317,
  });
  const expose = `\n;globalThis.__broker = {
    encryptSecret, decryptSecret, isPrivateNetworkAddress, validateAiDestination,
    fetchAiWithRedirects, readAiResponse, normalizeAiRequestPayload,
    handleAiRequest, activeAiRequests
  };`;
  vm.runInContext(SRC.main.slice(begin, end) + expose, context, { filename: PATHS.main });
  return { api: context.__broker, state };
}

function trustedEvent() {
  const sent = [];
  return {
    sent,
    senderFrame: { url: 'http://127.0.0.1:4317/settings.html' },
    sender: {
      id: 7,
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
}

function chatPayload(overrides) {
  const base = {
    requestId: 'ai_contract_0001',
    kind: 'chat',
    config: {
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'xj-enc:' + Buffer.from('synthetic-byok', 'utf8').toString('base64'),
      model: 'synthetic-model',
      isTrial: false,
    },
    body: {
      model: 'synthetic-model',
      messages: [{ role: 'user', content: 'synthetic ping' }],
      temperature: 0.3,
      max_tokens: 16,
    },
    streaming: false,
  };
  return Object.assign(base, overrides || {});
}

function buildRendererHarness(apiConfig, requestHandler) {
  const calls = [];
  const listeners = [];
  const cancelled = [];
  const bridge = {
    aiRequest: async (payload) => {
      calls.push(payload);
      return requestHandler(payload, (requestId, chunk) => {
        listeners.slice().forEach((listener) => listener({ requestId, chunk }));
      });
    },
    cancelAiRequest: (requestId) => { cancelled.push(requestId); },
    onAiChunk: (listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
  const context = vm.createContext({
    AbortController,
    Buffer,
    URL,
    console,
    setTimeout,
    clearTimeout,
    Store: { getSettings: () => ({ apiConfig: apiConfig || {} }) },
    module: { exports: {} },
  });
  context.window = context;
  context.__XJ_API__ = bridge;
  vm.runInContext(SRC.ai, context, { filename: PATHS.ai });
  return { AI: context.AI, bridge, calls, cancelled };
}

async function staticContract() {
  await test('S1 BrowserWindow 全部显式启用安全 webPreferences', () => {
    const blocks = Array.from(SRC.main.matchAll(/new BrowserWindow\(\{([\s\S]*?)\n\s*\}\);/g)).map((match) => match[1]);
    assert.strictEqual(blocks.length, 3, 'BrowserWindow 数量变化后必须更新安全矩阵');
    blocks.forEach((block, index) => {
      assert.match(block, /contextIsolation:\s*true/, 'window ' + index + ' 缺 contextIsolation:true');
      assert.match(block, /nodeIntegration:\s*false/, 'window ' + index + ' 缺 nodeIntegration:false');
      assert.match(block, /sandbox:\s*true/, 'window ' + index + ' 缺 sandbox:true');
      assert.match(block, /webSecurity:\s*true/, 'window ' + index + ' 缺 webSecurity:true');
    });
    assert.match(SRC.main, /AGENT_ACCEPTANCE_CLOSE_DIALOG/, '隔离验收缺关闭确认窗的显式测试开关');
  });

  await test('S2 preload 不暴露明文密钥或通用网络能力', () => {
    assert.doesNotMatch(SRC.preload, /decryptSecret|appProxyKey/);
    assert.doesNotMatch(SRC.preload, /\bfetch\s*\(/);
    assert.doesNotMatch(SRC.preload, /require\(['"]\.\//, 'sandbox preload 不得 require 本地模块');
    assert.match(SRC.preload, /aiRequest:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('xj:aiRequest'/);
  });

  await test('S3 AI 与设置渲染层零外部 fetch、零解密', () => {
    assert.doesNotMatch(SRC.ai, /\bfetch\s*\(|decryptSecret|appProxyKey|getProxyKey/);
    assert.doesNotMatch(SRC.settings, /\bfetch\s*\(|decryptSecret|appProxyKey/);
    assert.match(SRC.ai, /requestAiBroker/);
    assert.match(SRC.settings, /AI\.testConnection\(cfg\)/);
    assert.match(SRC.settings, /密钥已保存；输入新密钥可替换/);
  });

  await test('S4 IPC 三方向生产者与消费者成对存在', () => {
    const channels = (source, pattern) => Array.from(source.matchAll(pattern)).map((match) => match[1]);
    const unique = (items) => Array.from(new Set(items)).sort();
    const mainHandle = unique(channels(SRC.main, /ipcMain\.handle\(['"]([^'"]+)/g));
    const preloadInvoke = unique(channels(SRC.preload, /ipcRenderer\.invoke\(['"]([^'"]+)/g));
    const mainOn = unique(channels(SRC.main, /ipcMain\.on\(['"]([^'"]+)/g));
    const preloadSend = unique(
      channels(SRC.preload, /ipcRenderer\.send\(['"]([^'"]+)/g)
        .concat(channels(SRC.closePreload, /ipcRenderer\.send\(['"]([^'"]+)/g))
    );
    const mainSend = unique(channels(SRC.main, /(?:webContents|sender)\.send\(['"]([^'"]+)/g));
    const preloadOn = unique(channels(SRC.preload, /ipcRenderer\.on\(['"]([^'"]+)/g));
    assert.deepStrictEqual(mainHandle, preloadInvoke, 'invoke/handle channel inventory mismatch');
    assert.deepStrictEqual(mainOn, preloadSend, 'renderer send/main on channel inventory mismatch');
    assert.deepStrictEqual(mainSend, preloadOn, 'main send/renderer on channel inventory mismatch');
    assert.doesNotMatch(SRC.preload + SRC.closePreload, /ipcRenderer\.(?:invoke|send|on)\((?!['"])/, 'preload 不得接受动态 channel 名');
    assert.match(SRC.main, /ipcMain\.handle\('xj:aiRequest',\s*handleAiRequest\)/);
    assert.match(SRC.preload, /ipcRenderer\.invoke\('xj:aiRequest'/);
    assert.match(SRC.main, /ipcMain\.on\('xj:aiCancel'/);
    assert.match(SRC.preload, /ipcRenderer\.send\('xj:aiCancel'/);
    assert.match(SRC.main, /event\.sender\.send\('xj:ai-chunk'/);
    assert.match(SRC.preload, /ipcRenderer\.on\('xj:ai-chunk'/);
    assert.match(SRC.main, /ipcMain\.on\('xj:closeDecision',[\s\S]*?isTrustedRendererEvent\(ev\)[\s\S]*?\['cancel', 'stay', 'quit'\]\.includes\(action\)/);
  });

  await test('S5 设置页加密失败必须阻止明文持久化', () => {
    assert.match(SRC.main, /if \(!safeStorage\.isEncryptionAvailable\(\)\) return ''/);
    assert.match(SRC.settings, /!encrypted\.startsWith\('xj-enc:'\)/);
    assert.doesNotMatch(SRC.settings, /降级明文/);
  });

  await test('S6 Agent API 配置不得明文降级或重复加密已有密文', () => {
    const encryptAndSave = SRC.agentTools.slice(
      SRC.agentTools.indexOf('async function encryptAndSave'),
      SRC.agentTools.indexOf('// 多轮：密钥还没收齐')
    );
    assert.match(encryptAndSave, /!String\(toSave\.apiKey\)\.startsWith\('xj-enc:'\)/);
    assert.match(encryptAndSave, /XJ_SECRET_ENCRYPTION_UNAVAILABLE/);
    assert.match(encryptAndSave, /XJ_SECRET_ENCRYPTION_FAILED/);
    assert.doesNotMatch(encryptAndSave, /降级明文/);
  });

  await test('S7 Agent API 验证能力缺失时必须 fail closed', () => {
    const configureApi = SRC.agentTools.slice(
      SRC.agentTools.indexOf('async function configureApi'),
      SRC.agentTools.indexOf('// 工具 6：navigate_to')
    );
    assert.match(configureApi, /AI connection test is unavailable/);
    assert.doesNotMatch(configureApi, /AI\.testConnection\([\s\S]*?:\s*\{\s*ok:\s*true\s*\}/);
  });
}

async function dynamicContract() {
  await test('D1 非可信 sender 在网络前被拒绝', async () => {
    const harness = buildHarness();
    const event = trustedEvent();
    event.senderFrame.url = 'https://attacker.example/settings.html';
    const result = await harness.api.handleAiRequest(event, chatPayload());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'XJ_IPC_SENDER_DENIED');
    assert.strictEqual(harness.state.calls.length, 0);
  });

  await test('D2 未知字段与 envelope/body 不一致均 fail closed', async () => {
    const harness = buildHarness();
    const unknown = chatPayload({ unexpected: true });
    const r1 = await harness.api.handleAiRequest(trustedEvent(), unknown);
    assert.strictEqual(r1.error.code, 'XJ_AI_REQUEST_INVALID');
    const mismatch = chatPayload();
    mismatch.body.model = 'different-model';
    const r2 = await harness.api.handleAiRequest(trustedEvent(), mismatch);
    assert.strictEqual(r2.error.code, 'XJ_AI_REQUEST_INVALID');
    const queryEndpoint = chatPayload();
    queryEndpoint.config.baseUrl = 'https://api.example.test/v1?redirect=https://127.0.0.1';
    const r3 = await harness.api.handleAiRequest(trustedEvent(), queryEndpoint);
    assert.strictEqual(r3.error.code, 'XJ_AI_REQUEST_INVALID');
    const controlKey = chatPayload();
    controlKey.config.apiKey = 'bad\r\nheader';
    const r4 = await harness.api.handleAiRequest(trustedEvent(), controlKey);
    assert.strictEqual(r4.error.code, 'XJ_AI_REQUEST_INVALID');
    assert.strictEqual(harness.state.calls.length, 0);
  });

  await test('D3 HTTP、URL 凭据、loopback/private/link-local IPv4/IPv6 全部拒绝', async () => {
    const harness = buildHarness();
    const blocked = [
      'http://api.example.test/v1',
      'https://user:pass@api.example.test/v1',
      'https://127.0.0.1/v1',
      'https://10.0.0.1/v1',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/v1',
      'https://[fc00::1]/v1',
      'https://[fe80::1]/v1',
      'https://[::ffff:7f00:1]/v1',
    ];
    for (const url of blocked) {
      await assert.rejects(() => harness.api.validateAiDestination(url));
    }
  });

  await test('D4 DNS 解析到私网时拒绝且不发起请求', async () => {
    const harness = buildHarness();
    harness.state.lookup = async () => [{ address: '192.168.10.4', family: 4 }];
    await assert.rejects(() => harness.api.validateAiDestination('https://api.example.test/v1'), /private address/);
    assert.strictEqual(harness.state.calls.length, 0);
  });

  await test('D5 重定向到私网在第二次 fetch 前被拒绝', async () => {
    const harness = buildHarness();
    harness.state.fetch = async (url, options) => {
      harness.state.calls.push({ url, options });
      return mockResponse({ status: 302, ok: false, headers: { location: 'https://127.0.0.1/internal' } });
    };
    const result = await harness.api.handleAiRequest(trustedEvent(), chatPayload());
    assert.strictEqual(result.error.code, 'XJ_AI_NETWORK_FAILED');
    assert.strictEqual(harness.state.calls.length, 1);
  });

  await test('D6 BYOK 只在主进程解密并写入 Authorization，响应不回传密钥', async () => {
    const harness = buildHarness();
    const result = await harness.api.handleAiRequest(trustedEvent(), chatPayload());
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(harness.state.calls.length, 1);
    assert.strictEqual(harness.state.calls[0].options.headers.Authorization, 'Bearer synthetic-byok');
    assert.ok(!JSON.stringify(result).includes('synthetic-byok'));
  });

  await test('D7 超过响应上限时 reader 被拒绝', async () => {
    const harness = buildHarness();
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1, 65);
    await assert.rejects(
      () => harness.api.readAiResponse(mockResponse({ chunks: [oversized] })),
      /size limit/
    );
  });

  await test('D8 取消只中止匹配 requestId 的活动请求', async () => {
    const harness = buildHarness();
    harness.state.fetch = (url, options) => {
      harness.state.calls.push({ url, options });
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('synthetic abort');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    };
    const payload = chatPayload({ requestId: 'ai_contract_cancel' });
    const pending = harness.api.handleAiRequest(trustedEvent(), payload);
    await new Promise((resolve) => setImmediate(resolve));
    const active = harness.api.activeAiRequests.get(payload.requestId);
    assert.ok(active, '请求未进入 activeAiRequests');
    active.controller.abort();
    const result = await pending;
    assert.strictEqual(result.error.code, 'ABORT_ERR');
    assert.strictEqual(harness.api.activeAiRequests.has(payload.requestId), false);
  });

  await test('D9 SSE 仅经 main webContents.send 推送且最终响应不复制正文', async () => {
    const harness = buildHarness();
    harness.state.fetch = async (url, options) => {
      harness.state.calls.push({ url, options });
      return mockResponse({
        headers: { 'content-type': 'text/event-stream' },
        chunks: [
          Buffer.from('data: {"choices":[{"delta":{"content":"A"}}]}\n\n'),
          Buffer.from('data: [DONE]\n\n'),
        ],
      });
    };
    const event = trustedEvent();
    const payload = chatPayload({ requestId: 'ai_contract_stream', streaming: true });
    payload.body.stream = true;
    const result = await harness.api.handleAiRequest(event, payload);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.bodyText, '');
    assert.ok(event.sent.length >= 1);
    assert.ok(event.sent.every((entry) => entry.channel === 'xj:ai-chunk' && entry.payload.requestId === payload.requestId));
  });

  await test('D10 供应商 HTTP 错误正文不得越过主进程', async () => {
    const harness = buildHarness();
    harness.state.fetch = async (url, options) => {
      harness.state.calls.push({ url, options });
      return mockResponse({
        status: 401,
        ok: false,
        text: 'provider raw secret diagnostic must not cross IPC',
      });
    };
    const result = await harness.api.handleAiRequest(trustedEvent(), chatPayload());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'XJ_AI_AUTH_FAILED');
    assert.strictEqual(result.bodyText, '');
    assert.ok(!JSON.stringify(result).includes('provider raw secret diagnostic'));
  });

  await test('D11 渲染层工具不兼容时仅重试一次且移除 tools', async () => {
    const harness = buildRendererHarness(
      { baseUrl: 'https://api.example.test/v1', apiKey: 'xj-enc:synthetic', modelPreference: 'synthetic-model', verified: true },
      async (payload) => {
        if (payload.kind === 'quota') return { ok: false, status: 503, headers: {}, bodyText: '' };
        if (payload.body.tools) return { ok: false, status: 400, headers: {}, bodyText: '', error: { code: 'XJ_AI_TOOLS_UNSUPPORTED', message: 'safe' } };
        return { ok: true, status: 200, headers: { 'content-type': 'application/json' }, bodyText: JSON.stringify({ choices: [{ message: { content: 'retry-ok' } }] }) };
      }
    );
    const result = await new Promise((resolve) => harness.AI.send(
      [{ role: 'user', content: 'synthetic' }],
      resolve,
      { tools: [{ type: 'function', function: { name: 'synthetic_tool' } }], tool_choice: 'auto' }
    ));
    const chatCalls = harness.calls.filter((call) => call.kind === 'chat');
    assert.strictEqual(result.content, 'retry-ok');
    assert.strictEqual(chatCalls.length, 2);
    assert.ok(Array.isArray(chatCalls[0].body.tools));
    assert.strictEqual(chatCalls[1].body.tools, undefined);
  });

  await test('D12 渲染层按 requestId 消费 SSE 并保留流式正文', async () => {
    const deltas = [];
    const harness = buildRendererHarness(
      { baseUrl: 'https://api.example.test/v1', apiKey: 'xj-enc:synthetic', modelPreference: 'synthetic-model', verified: true },
      async (payload, emit) => {
        if (payload.kind === 'quota') return { ok: false, status: 503, headers: {}, bodyText: '' };
        emit('ai_unrelated_0001', 'data: {"choices":[{"delta":{"content":"X"}}]}\n\n');
        emit(payload.requestId, 'data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
        emit(payload.requestId, 'data: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DONE]\n\n');
        return { ok: true, status: 200, headers: { 'content-type': 'text/event-stream' }, bodyText: '' };
      }
    );
    const result = await new Promise((resolve) => harness.AI.send(
      [{ role: 'user', content: 'synthetic' }],
      resolve,
      { onDelta: (piece, full) => deltas.push({ piece, full }) }
    ));
    assert.strictEqual(result.content, 'AB');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(deltas)), [{ piece: 'A', full: 'A' }, { piece: 'B', full: 'AB' }]);
  });

  await test('D13 AbortSignal 经 cancel IPC 传递并保留已接收片段', async () => {
    let finishRequest = null;
    let activeRequestId = '';
    const harness = buildRendererHarness(
      { baseUrl: 'https://api.example.test/v1', apiKey: 'xj-enc:synthetic', modelPreference: 'synthetic-model', verified: true },
      (payload, emit) => {
        if (payload.kind === 'quota') return Promise.resolve({ ok: false, status: 503, headers: {}, bodyText: '' });
        activeRequestId = payload.requestId;
        emit(payload.requestId, 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        return new Promise((resolve) => { finishRequest = resolve; });
      }
    );
    harness.bridge.cancelAiRequest = (requestId) => {
      harness.cancelled.push(requestId);
      if (finishRequest) finishRequest({ ok: false, error: { code: 'ABORT_ERR', message: 'AI request was cancelled' } });
    };
    const controller = new AbortController();
    const pending = new Promise((resolve) => harness.AI.send(
      [{ role: 'user', content: 'synthetic' }],
      resolve,
      { signal: controller.signal, onDelta: () => {} }
    ));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const result = await pending;
    assert.strictEqual(harness.cancelled[0], activeRequestId);
    assert.strictEqual(result.interrupted, true);
    assert.strictEqual(result.partialContent, 'partial');
  });
}

(async () => {
  console.log('=== XJ-4.2.1 IPC/network broker contract ===');
  await staticContract();
  await dynamicContract();
  console.log('----------------------------------------');
  results.forEach((result) => {
    console.log((result.ok ? '[PASS] ' : '[FAIL] ') + result.name);
    if (!result.ok) console.log('       ' + result.error);
  });
  console.log('----------------------------------------');
  console.log('Passed: ' + passed + ' | Failed: ' + failed);
  Object.keys(SHA).forEach((key) => console.log(key + '_sha256: ' + SHA[key]));
  console.log('注：仅验证 IPC/network v1 契约，不宣称 release-ready。');
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error('[CONTRACT-BROKEN]', error && error.stack ? error.stack : error);
  process.exit(2);
});
