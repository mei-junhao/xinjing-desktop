'use strict';

const path = require('node:path');
const vm = require('node:vm');

function loadRouterFromSource(serverSource, sourcePath) {
  if (typeof serverSource !== 'string' || !serverSource.trim()) {
    throw new TypeError('serverSource must be a non-empty string');
  }

  let httpsRouter = null;
  const syntheticListeners = [];
  const syntheticWrites = [];
  const makeServer = (kind) => ({
    listen(...args) {
      syntheticListeners.push({ kind, port: args[0], host: args[1] });
      const callback = args[args.length - 1];
      if (typeof callback === 'function') callback();
      return this;
    },
  });
  const fakeFs = {
    existsSync() { return true; },
    mkdirSync() {},
    readFileSync(filePath) {
      if (/quota\.json$/i.test(String(filePath))) return '{}';
      return Buffer.from('synthetic-certificate');
    },
    writeFileSync(filePath, data) {
      syntheticWrites.push({ filePath: String(filePath), bytes: Buffer.byteLength(String(data)) });
    },
  };
  const fakeRequire = (moduleName) => {
    if (moduleName === 'dotenv') return { config() {} };
    if (moduleName === 'fs') return fakeFs;
    if (moduleName === 'path') return path;
    if (moduleName === 'https') {
      return {
        createServer(_options, handler) {
          httpsRouter = handler;
          return makeServer('https');
        },
        request() { throw new Error('synthetic router test must not call an upstream'); },
      };
    }
    if (moduleName === 'http') {
      return {
        createServer() { return makeServer('http'); },
      };
    }
    throw new Error(`unexpected module in synthetic router host: ${moduleName}`);
  };
  const context = {
    Buffer,
    URL,
    console: { error() {}, log() {} },
    process: {
      env: {
        DEEPSEEK_UPSTREAM_URL: 'https://proxy.invalid/v1/chat/completions',
        QUOTA_BUDGET_YUAN: '5',
      },
    },
    require: fakeRequire,
    __filename: sourcePath,
    __dirname: path.dirname(sourcePath),
  };

  vm.runInNewContext(serverSource, context, { filename: sourcePath, displayErrors: true });
  if (typeof httpsRouter !== 'function') {
    throw new Error('the exact server source did not register an HTTPS router');
  }

  function invoke(method, requestUrl) {
    let statusCode = null;
    let ended = false;
    let body = '';
    const headers = {};
    const res = {
      setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
      writeHead(status, nextHeaders) {
        statusCode = status;
        if (nextHeaders) {
          for (const [name, value] of Object.entries(nextHeaders)) {
            headers[name.toLowerCase()] = value;
          }
        }
      },
      end(chunk = '') {
        ended = true;
        body += String(chunk);
      },
    };
    httpsRouter({ method, url: requestUrl, headers: {} }, res);
    if (!ended) throw new Error(`router did not finish ${method} ${requestUrl}`);
    return { statusCode, headers, body, writes: syntheticWrites.slice() };
  }

  return { invoke, syntheticListeners };
}

module.exports = { loadRouterFromSource };
