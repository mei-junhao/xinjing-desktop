'use strict';
/**
 * better-auth-adapter.js — 自定义 Better Auth 数据库适配器，后端为 SqliteStore(node:sqlite)。
 * Better Auth 的 createAdapterFactory 来自 ESM 包，此处用动态 import 加载；
 * 返回的 adapter factory 是同步函数，可直接传给 betterAuth({ database })。
 * 读路径：全表水合到内存后用与官方 memory-adapter 等价的小写不敏感 where/join 语义过滤
 *         （本地回环认证服务数据量极小，正确性优先于大表扫描优化）。
 * 写路径：逐行写穿到 SQLite；多语句事务走 store.withTransaction（崩溃安全）。
 */
const { normalizeSessionTokenForQuery } = require('./auth-sqlite');
let _factoryPromise = null;
function loadFactory() {
  if (!_factoryPromise) {
    _factoryPromise = import('@better-auth/core/db/adapter').then((m) => m.createAdapterFactory);
  }
  return _factoryPromise;
}

function insensitiveCompare(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}
function insensitiveIn(recordVal, values) {
  if (typeof recordVal !== 'string') return values.includes(recordVal);
  return values.some((v) => typeof v === 'string' && recordVal.toLowerCase() === v.toLowerCase());
}
function insensitiveNotIn(recordVal, values) { return !insensitiveIn(recordVal, values); }
function insensitiveContains(recordVal, value) {
  if (typeof recordVal !== 'string' || typeof value !== 'string') return false;
  return recordVal.toLowerCase().includes(value.toLowerCase());
}
function insensitiveStartsWith(recordVal, value) {
  if (typeof recordVal !== 'string' || typeof value !== 'string') return false;
  return recordVal.toLowerCase().startsWith(value.toLowerCase());
}
function insensitiveEndsWith(recordVal, value) {
  if (typeof recordVal !== 'string' || typeof value !== 'string') return false;
  return recordVal.toLowerCase().endsWith(value.toLowerCase());
}

function buildAdapter(store, createAdapterFactory) {
  let lazyOptions = null;
  const buildFactory = () => createAdapterFactory({
    config: {
      adapterId: 'xinjing-sqlite',
      adapterName: 'XinJing SQLite (node:sqlite)',
      usePlural: false,
      supportsDates: false,
      supportsBooleans: false,
      supportsJSON: false,
      supportsArrays: false,
      debugLogs: false,
      transaction: async (cb) => store.withTransaction(() => cb(buildFactory()(lazyOptions))),
    },
    adapter: ({ getFieldName, getDefaultFieldName, options, getModelName }) => {
      function tableOf(model) {
        const name = getModelName(model);
        const rows = store.rows(name);
        if (!rows) throw new Error('Model ' + name + ' not found');
        return rows;
      }

      function applySort(records, sortBy) {
        if (!sortBy) return records;
        return records.sort((a, b) => {
          const aV = a[sortBy.field]; const bV = b[sortBy.field];
          let c = 0;
          if (aV == null && bV == null) c = 0;
          else if (aV == null) c = -1;
          else if (bV == null) c = 1;
          else if (typeof aV === 'string' && typeof bV === 'string') c = aV.localeCompare(bV);
          else if (aV instanceof Date && bV instanceof Date) c = aV.getTime() - bV.getTime();
          else if (typeof aV === 'number' && typeof bV === 'number') c = aV - bV;
          else if (typeof aV === 'boolean' && typeof bV === 'boolean') c = (aV === bV) ? 0 : (aV ? 1 : -1);
          else c = String(aV).localeCompare(String(bV));
          return sortBy.direction === 'asc' ? c : -c;
        });
      }

      function evalClause(record, clause) {
        const { field, value, operator, mode = 'sensitive' } = clause;
        const isInsensitive = mode === 'insensitive' && (typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string')));
        switch (operator) {
          case 'in': if (!Array.isArray(value)) throw new Error('Value must be an array'); return isInsensitive ? insensitiveIn(record[field], value) : value.includes(record[field]);
          case 'not_in': if (!Array.isArray(value)) throw new Error('Value must be an array'); return isInsensitive ? insensitiveNotIn(record[field], value) : !value.includes(record[field]);
          case 'contains': return isInsensitive ? insensitiveContains(record[field], value) : (record[field] && record[field].includes ? record[field].includes(value) : false);
          case 'starts_with': return isInsensitive ? insensitiveStartsWith(record[field], value) : String(record[field] || '').startsWith(value);
          case 'ends_with': return isInsensitive ? insensitiveEndsWith(record[field], value) : String(record[field] || '').endsWith(value);
          case 'ne': return isInsensitive ? !insensitiveCompare(record[field], value) : record[field] !== value;
          case 'gt': return value != null && Boolean(record[field] > value);
          case 'gte': return value != null && Boolean(record[field] >= value);
          case 'lt': return value != null && Boolean(record[field] < value);
          case 'lte': return value != null && Boolean(record[field] <= value);
          default:
            if (isInsensitive) return insensitiveCompare(record[field], value);
            if (value === null) return record[field] == null;
            return record[field] === value;
        }
      }

      function convertWhereClause(where, model, join, select) {
          const modelName = getModelName(model);
          const normalizedWhere = Array.isArray(where) ? where.map((clause) => {
            if (!clause || modelName !== 'session' || clause.field !== 'token') return clause;
            if (Array.isArray(clause.value)) {
              return Object.assign({}, clause, { value: clause.value.map((v) => normalizeSessionTokenForQuery(v)) });
            }
            if (typeof clause.value === 'string' && clause.value) {
              return Object.assign({}, clause, { value: normalizeSessionTokenForQuery(clause.value) || clause.value });
            }
            return clause;
          }) : where;
        let records = tableOf(model).filter((record) => {
          if (!normalizedWhere || normalizedWhere.length === 0) return true;
          let result = evalClause(record, normalizedWhere[0]);
          for (const clause of normalizedWhere) {
            const cr = evalClause(record, clause);
            result = (clause.connector === 'OR') ? (result || cr) : (result && cr);
          }
          return result;
        });
        if (select && select.length > 0) {
          records = records.map((record) => {
            const out = {};
            for (const key of Object.keys(record)) {
              const defaultName = getDefaultFieldName({ model, field: key });
              if (select.includes(defaultName)) out[key] = record[key];
            }
            return out;
          });
        }
        if (!join) return records;
        const grouped = new Map();
        for (const baseRecord of records) {
          const baseId = String(baseRecord.id);
          if (!grouped.has(baseId)) {
            const nested = { ...baseRecord };
            for (const [joinModel, joinAttr] of Object.entries(join)) {
              const joinModelName = getModelName(joinModel);
              if (joinAttr.relation === 'one-to-one') nested[joinModelName] = null;
              else nested[joinModelName] = [];
            }
            grouped.set(baseId, nested);
          }
          const nestedEntry = grouped.get(baseId);
          for (const [joinModel, joinAttr] of Object.entries(join)) {
            const joinModelName = getModelName(joinModel);
            const joinTable = tableOf(joinModel);
            const matching = joinTable.filter((jr) => jr[joinAttr.on.to] === baseRecord[joinAttr.on.from]);
            if (joinAttr.relation === 'one-to-one') nestedEntry[joinModelName] = matching[0] || null;
            else {
              const limit = joinAttr.limit ?? 100;
              let count = 0;
              for (const mr of matching) {
                if (count >= limit) break;
                if (!(nestedEntry[joinModelName].some((x) => x.id === mr.id))) { nestedEntry[joinModelName].push(mr); count++; }
              }
            }
          }
        }
        return Array.from(grouped.values());
      }

      return {
        create: async ({ model, data }) => {
          const name = getModelName(model);
          store.insert(name, { ...data });
          return data;
        },
        findOne: async ({ model, where, select, join }) => {
          const res = convertWhereClause(where, model, join, select);
          return res[0] || null;
        },
        findMany: async ({ model, where, sortBy, limit, select, offset, join }) => {
          const res = convertWhereClause(where || [], model, join, select);
          let list = applySort(res, sortBy);
          if (offset !== undefined) list = list.slice(offset);
          if (limit !== undefined) list = list.slice(0, limit);
          return list || [];
        },
        count: async ({ model, where }) => {
          if (where) return convertWhereClause(where, model).length;
          return tableOf(model).length;
        },
        update: async ({ model, where, update }) => {
          if (where.length === 0) return null;
          const name = getModelName(model);
          const res = convertWhereClause(where, model);
          for (const record of res) store.update(name, record.id, update);
          return res[0] ? { ...res[0], ...update } : null;
        },
        delete: async ({ model, where }) => {
          if (where.length === 0) return;
          const name = getModelName(model);
          const res = convertWhereClause(where, model);
          for (const record of res) store.remove(name, record.id);
        },
        deleteMany: async ({ model, where }) => {
          const name = getModelName(model);
          const res = convertWhereClause(where, model);
          let count = 0;
          for (const record of res) { store.remove(name, record.id); count++; }
          return count;
        },
        consumeOne: async ({ model, where }) => {
          const name = getModelName(model);
          const target = convertWhereClause(where, model)[0];
          if (!target) return null;
          store.remove(name, target.id);
          return target;
        },
        incrementOne: async ({ model, where, increment, set }) => {
          const name = getModelName(model);
          const target = convertWhereClause(where, model)[0];
          if (!target) return null;
          const patch = {};
          for (const [field, delta] of Object.entries(increment)) patch[field] = (typeof target[field] === 'number' ? target[field] : 0) + delta;
          if (set) Object.assign(patch, set);
          return store.update(name, target.id, patch);
        },
        updateMany: async ({ model, where, update }) => {
          const name = getModelName(model);
          const res = convertWhereClause(where, model);
          for (const record of res) store.update(name, record.id, update);
          return res.length;
        },
      };
    },
  });
  const factory = buildFactory();
  return (options) => { lazyOptions = options; return factory(options); };
}

async function createSqliteAdapter(store) {
  const createAdapterFactory = await loadFactory();
  return buildAdapter(store, createAdapterFactory);
}

module.exports = { createSqliteAdapter };
