(function () {
  'use strict';

  var refreshSequence = 0;
  var initialized = false;

  function element(id) {
    return typeof document !== 'undefined' ? document.getElementById(id) : null;
  }

  function safeMinor(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every(function (key) { return allowed.indexOf(key) !== -1; });
  }

  function formatYuan(minor) {
    return '¥' + (minor / 100).toFixed(2);
  }

  function setStatus(message, state) {
    var status = element('commercial-status');
    if (!status) return;
    status.textContent = message;
    status.setAttribute('data-state', state || 'info');
  }

  function clearChildren(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function renderBalance(value) {
    var target = element('commercial-balance-value');
    if (!target) return;
    var amount = target.querySelector('strong');
    var detail = target.querySelector('span');
    if (!amount || !detail) return;
    amount.textContent = formatYuan(value.remainingBalanceMinor);
    detail.textContent = value.availableBalanceMinor === null
      ? '服务端余额'
      : '可用 ' + formatYuan(value.availableBalanceMinor);
  }

  function renderBalanceError() {
    var target = element('commercial-balance-value');
    if (!target) return;
    var amount = target.querySelector('strong');
    var detail = target.querySelector('span');
    if (amount) amount.textContent = '暂不可用';
    if (detail) detail.textContent = '余额读取失败';
  }

  function formatRate(value, currency, fxRate) {
    var amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return '不可用';
    if (currency === 'USD') amount *= Number(fxRate) || 7;
    return '¥' + amount.toFixed(2);
  }

  function renderCatalog(catalog) {
    var target = element('commercial-price-list');
    if (!target) return;
    clearChildren(target);
    if (catalog && catalog.kind === 'server') {
      if (!catalog.models.length) {
        var serverEmpty = document.createElement('div');
        serverEmpty.className = 'commercial-price-item';
        serverEmpty.textContent = '当前没有可展示的模型价格';
        target.appendChild(serverEmpty);
        return;
      }
      catalog.models.slice().sort(function (left, right) {
        return left.displayName < right.displayName ? -1 : left.displayName > right.displayName ? 1 : 0;
      }).forEach(function (entry) {
        var row = document.createElement('div');
        row.className = 'commercial-price-item' + (entry.active ? '' : ' inactive');
        row.setAttribute('role', 'listitem');

        var model = document.createElement('span');
        model.className = 'name';
        model.textContent = entry.displayName;
        row.appendChild(model);

        var state = document.createElement('span');
        state.className = 'state';
        state.textContent = entry.active ? '可用' : '已停用';
        row.appendChild(state);

        var price = document.createElement('span');
        price.className = 'price';
        if (entry.fallbackOnly || (entry.inputPrice === 0 && entry.outputPrice === 0)) {
          price.textContent = '免费兜底';
        } else {
          price.textContent = '入 ' + formatRate(entry.inputPrice, entry.currency, catalog.fxRateUsdToCny)
            + ' / 出 ' + formatRate(entry.outputPrice, entry.currency, catalog.fxRateUsdToCny)
            + ' / 百万 token';
        }
        row.appendChild(price);
        target.appendChild(row);
      });
      return;
    }
    var names = Object.keys(catalog).sort(function (left, right) {
      return left < right ? -1 : left > right ? 1 : 0;
    });
    if (!names.length) {
      var empty = document.createElement('div');
      empty.className = 'commercial-price-item';
      empty.textContent = '当前没有可展示的模型价格';
      target.appendChild(empty);
      return;
    }
    names.forEach(function (name) {
      var entry = catalog[name];
      var row = document.createElement('div');
      row.className = 'commercial-price-item' + (entry.active ? '' : ' inactive');
      row.setAttribute('role', 'listitem');

      var model = document.createElement('span');
      model.className = 'name';
      model.textContent = name;
      row.appendChild(model);

      var state = document.createElement('span');
      state.className = 'state';
      state.textContent = entry.active ? '可用' : '已停用';
      row.appendChild(state);

      var price = document.createElement('span');
      price.className = 'price';
      price.textContent = formatYuan(entry.priceMinor) + ' / 次';
      row.appendChild(price);
      target.appendChild(row);
    });
  }

  function renderCatalogError() {
    var target = element('commercial-price-list');
    if (!target) return;
    clearChildren(target);
    var row = document.createElement('div');
    row.className = 'commercial-price-item';
    row.textContent = '模型价格暂不可用，请稍后刷新';
    target.appendChild(row);
  }

  function normalizeBalance(result) {
    var value = result && result.ok === true ? result.value : null;
    if (!value || value.source !== 'server' || value.currency !== 'CNY') return null;
    if (!hasOnlyKeys(value, ['source', 'currency', 'remainingBalanceMinor', 'availableBalanceMinor', 'serverRevision', 'fetchedAt'])) return null;
    if (!safeMinor(value.remainingBalanceMinor)) return null;
    if (value.availableBalanceMinor !== null && !safeMinor(value.availableBalanceMinor)) return null;
    if (value.availableBalanceMinor !== null && value.availableBalanceMinor > value.remainingBalanceMinor) return null;
    if (value.serverRevision !== null && !safeMinor(value.serverRevision)) return null;
    if (typeof value.fetchedAt !== 'string' || Number.isNaN(Date.parse(value.fetchedAt))) return null;
    return {
      remainingBalanceMinor: value.remainingBalanceMinor,
      availableBalanceMinor: value.availableBalanceMinor,
      serverRevision: value.serverRevision,
      fetchedAt: value.fetchedAt,
    };
  }

  // XJ519-Z13：设置页价格提示必须与全局模型选择器（app.js normalizeModelCatalog）同源同判。
  // 服务器目录条目缺少 currency / fallbackOnly 等扩展字段时不得整目录判废——
  // 否则选择器正常显示价格而设置页报「模型价格暂不可用」，两处来源矛盾。
  function normalizeCatalogLenient(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (!Array.isArray(value.models) || !value.models.length) return null;
    if (value.catalogRevision == null || value.catalogRevision === '') return null;
    var lenientModels = [];
    var valid = true;
    value.models.forEach(function (entry) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(String(entry.modelId || ''))
        || !Number.isFinite(Number(entry.inputPrice)) || Number(entry.inputPrice) < 0
        || !Number.isFinite(Number(entry.outputPrice)) || Number(entry.outputPrice) < 0) {
        valid = false;
        return;
      }
      lenientModels.push({
        modelId: String(entry.modelId),
        displayName: typeof entry.displayName === 'string' && entry.displayName ? entry.displayName : String(entry.modelId),
        provider: typeof entry.provider === 'string' ? entry.provider : '',
        inputPrice: Number(entry.inputPrice),
        outputPrice: Number(entry.outputPrice),
        currency: typeof entry.currency === 'string' && entry.currency ? entry.currency : 'CNY',
        active: entry.active !== false,
        fallbackOnly: entry.fallbackOnly === true,
        catalogRevision: String(entry.catalogRevision != null && entry.catalogRevision !== '' ? entry.catalogRevision : value.catalogRevision),
      });
    });
    if (!valid) return null;
    return {
      kind: 'server',
      catalogRevision: String(value.catalogRevision),
      settlementCurrency: typeof value.settlementCurrency === 'string' ? value.settlementCurrency : 'CNY',
      fxRateUsdToCny: Number.isFinite(Number(value.fxRateUsdToCny)) ? Number(value.fxRateUsdToCny) : 7,
      models: lenientModels,
    };
  }

  function normalizeCatalog(result) {
    var value = result && result.ok === true ? result.value : null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (Array.isArray(value.models) && typeof value.catalogRevision === 'string' && value.catalogRevision) {
      var models = [];
      var validServerCatalog = true;
      value.models.forEach(function (entry) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)
          || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(String(entry.modelId || ''))
          || typeof entry.displayName !== 'string' || !entry.displayName
          || typeof entry.provider !== 'string'
          || !Number.isFinite(Number(entry.inputPrice)) || Number(entry.inputPrice) < 0
          || !Number.isFinite(Number(entry.outputPrice)) || Number(entry.outputPrice) < 0
          || typeof entry.currency !== 'string' || !entry.currency
          || typeof entry.catalogRevision !== 'string' || !entry.catalogRevision
          || typeof entry.fallbackOnly !== 'boolean') {
          validServerCatalog = false;
          return;
        }
        models.push({
          modelId: entry.modelId,
          displayName: entry.displayName,
          provider: entry.provider,
          inputPrice: Number(entry.inputPrice),
          outputPrice: Number(entry.outputPrice),
          currency: entry.currency,
          active: entry.active !== false,
          fallbackOnly: entry.fallbackOnly,
          catalogRevision: entry.catalogRevision,
        });
      });
      if (validServerCatalog) {
        return {
          kind: 'server',
          catalogRevision: value.catalogRevision,
          settlementCurrency: typeof value.settlementCurrency === 'string' ? value.settlementCurrency : 'CNY',
          fxRateUsdToCny: Number.isFinite(Number(value.fxRateUsdToCny)) ? Number(value.fxRateUsdToCny) : 7,
          models: models,
        };
      }
      // XJ519-Z13：严格校验未过时，按模型选择器同等宽容度重试——同一价格来源不允许两处判定不一致。
      return normalizeCatalogLenient(value);
    }
    var normalized = {};
    var valid = true;
    Object.keys(value).forEach(function (name) {
      var entry = value[name];
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(name)
        || !entry || typeof entry !== 'object' || Array.isArray(entry)
        || !hasOnlyKeys(entry, ['priceMinor', 'active', 'catalogRevision'])
        || !safeMinor(entry.priceMinor) || typeof entry.active !== 'boolean'
        || !Number.isSafeInteger(entry.catalogRevision) || entry.catalogRevision < 0) {
        valid = false;
        return;
      }
      normalized[name] = {
        priceMinor: entry.priceMinor,
        active: entry.active,
        catalogRevision: entry.catalogRevision,
      };
    });
    return valid ? normalized : null;
  }

  function setRefreshing(refreshing) {
    var button = element('commercial-refresh-btn');
    if (button) button.disabled = refreshing;
  }

  function readSafely(read) {
    try {
      return Promise.resolve(read({})).catch(function () { return { ok: false }; });
    } catch (_) {
      return Promise.resolve({ ok: false });
    }
  }

  async function refresh() {
    var sequence = ++refreshSequence;
    setRefreshing(true);
    setStatus('正在读取账户信息…', 'loading');
    var commercial = typeof window !== 'undefined' && window.__XJ_API__ && window.__XJ_API__.commercial;
    if (!commercial || typeof commercial.getAccountBalance !== 'function' || typeof commercial.getServerModelCatalog !== 'function') {
      if (sequence !== refreshSequence) return;
      renderBalanceError();
      renderCatalogError();
      setStatus('商业账户服务暂不可用，请稍后重试', 'error');
      setRefreshing(false);
      return;
    }

    var results = await Promise.all([
      readSafely(commercial.getAccountBalance),
      readSafely(commercial.getServerModelCatalog),
    ]);
    if (sequence !== refreshSequence) return;
    var balance = normalizeBalance(results[0]);
    var catalog = normalizeCatalog(results[1]);
    if (balance) renderBalance(balance); else renderBalanceError();
    if (catalog) renderCatalog(catalog); else renderCatalogError();
    if (balance && catalog) setStatus('已更新 · 余额和模型价格均来自服务端目录', 'success');
    else if (balance) setStatus('余额已更新；模型价格暂不可用', 'error');
    else if (catalog) setStatus('模型价格已更新；余额暂不可用', 'error');
    else setStatus('账户信息暂不可用，请稍后重试', 'error');
    setRefreshing(false);
  }

  function init() {
    if (initialized || !element('commercial-account-group')) return;
    initialized = true;
    var button = element('commercial-refresh-btn');
    if (button) button.addEventListener('click', refresh);
    refresh();
  }

  if (typeof window !== 'undefined') {
    window.XJCommercialAccountPanel = Object.freeze({ refresh: refresh });
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
  // 单测出口（node）：Z13 价格同源判定的契约测试使用；浏览器路径不受影响。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizeCatalog: normalizeCatalog, normalizeCatalogLenient: normalizeCatalogLenient };
  }
})();
