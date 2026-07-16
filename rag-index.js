'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { chunkDocument } = require('./doc-chunker.js');

const EMBED_MODEL = 'BAAI/bge-m3';
const RERANK_MODEL = 'BAAI/bge-reranker-v2-m3';
const EMBED_BATCH_SIZE = 32;
const EMBED_BATCH_DELAY = 200;
const MAX_RETRIES = 3;

function _postJson(host, apiPath, apiKey, payload, machineId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const hdrs = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
      Accept: 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (machineId) hdrs['X-Machine-Id'] = machineId;
    const req = https.request(
      { hostname: host, path: apiPath, method: 'POST', headers: hdrs, timeout: 30000 },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(buf);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(j);
            } else {
              reject(Object.assign(new Error('API ' + res.statusCode), { status: res.statusCode, detail: j }));
            }
          } catch (e) {
            reject(Object.assign(new Error('Parse error: ' + buf.slice(0, 200)), { status: res.statusCode }));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

async function _withRetry(fn, retries = MAX_RETRIES) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (e.status && (e.status >= 500 || e.status === 429)) {
        const delay = e.status === 429
          ? Math.min(5000, 1000 * Math.pow(2, i))
          : 500 * Math.pow(2, i);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function _cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

class RagIndex {
  constructor(opts) {
    this.userDataDir = opts.userDataDir;
    this.proxyHost = opts.proxyHost || 'xinjingchat.online';
    this.proxyKey = opts.proxyKey || '';
    this.machineId = opts.machineId || 'unknown';
    this.vectorFile = path.join(this.userDataDir, 'rag-vectors.json');
    this.indexFile = path.join(this.userDataDir, 'rag-index.json');
    this._index = null;
    this._vectors = null;
    this._cancelFlag = false;
    this._progressCb = null;
  }

  _loadIndex() {
    if (this._index) return this._index;
    try {
      this._index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
    } catch (e) {
      this._index = {
        version: 1,
        embeddingModel: EMBED_MODEL,
        folder: '',
        lastIndexed: 0,
        files: {},
      };
    }
    return this._index;
  }

  _saveIndex() {
    try { fs.writeFileSync(this.indexFile, JSON.stringify(this._index, null, 2)); }
    catch (e) { console.error('[rag] save index failed', e.message); }
  }

  _loadVectors() {
    if (this._vectors) return this._vectors;
    try {
      this._vectors = JSON.parse(fs.readFileSync(this.vectorFile, 'utf8'));
    } catch (e) {
      this._vectors = {};
    }
    return this._vectors;
  }

  _saveVectors() {
    try { fs.writeFileSync(this.vectorFile, JSON.stringify(this._vectors)); }
    catch (e) { console.error('[rag] save vectors failed', e.message); }
  }

  _chunkId(relPath, idx) { return relPath + '#' + idx; }

  getStatus() {
    const idx = this._loadIndex();
    let fileCount = 0, chunkCount = 0;
    for (const rp in idx.files) {
      fileCount++;
      chunkCount += (idx.files[rp].chunks || []).length;
    }
    return {
      ok: true,
      folder: idx.folder,
      lastIndexed: idx.lastIndexed,
      fileCount,
      chunkCount,
      embeddingModel: idx.embeddingModel,
    };
  }

  cancel() { this._cancelFlag = true; }

  onProgress(cb) { this._progressCb = cb; }

  _emitProgress(current, total, fileName, stage) {
    if (this._progressCb) {
      try { this._progressCb({ current, total, fileName, stage: stage || 'indexing' }); } catch (e) {}
    }
  }

  async _fetchEmbeddings(texts) {
    const res = await _withRetry(() =>
      _postJson(this.proxyHost, '/v1/embeddings', this.proxyKey, {
        model: EMBED_MODEL,
        input: texts,
      }, this.machineId)
    );
    if (!res.data || !Array.isArray(res.data)) throw new Error('Bad embedding response');
    return res.data.map(d => d.embedding);
  }

  async _fetchRerank(query, documents, topN) {
    const res = await _withRetry(() =>
      _postJson(this.proxyHost, '/v1/rerank', this.proxyKey, {
        model: RERANK_MODEL,
        query,
        documents,
        top_n: topN,
        return_documents: false,
      }, this.machineId)
    );
    if (!res.results || !Array.isArray(res.results)) throw new Error('Bad rerank response');
    return res.results.map(r => ({ index: r.index, score: r.relevance_score }));
  }

  async buildIndex(entries) {
    this._cancelFlag = false;
    const idx = this._loadIndex();
    const vecs = this._loadVectors();
    const total = entries.length;
    let processed = 0;

    const oldRelPaths = new Set(Object.keys(idx.files));
    const newRelPaths = new Set(entries.map(e => e.relPath));

    for (const rp of oldRelPaths) {
      if (!newRelPaths.has(rp)) {
        const oldChunks = idx.files[rp].chunks || [];
        for (const c of oldChunks) {
          delete vecs[this._chunkId(rp, c.id)];
        }
        delete idx.files[rp];
      }
    }

    const toProcess = [];
    for (const ent of entries) {
      const old = idx.files[ent.relPath];
      if (!old || old.mtime !== ent.mtime || old.size !== ent.size) {
        toProcess.push(ent);
      }
    }

    const embedBatch = [];
    const chunkMetaBatch = [];

    for (const ent of toProcess) {
      if (this._cancelFlag) break;

      let text;
      try { text = await fs.promises.readFile(ent.absPath, 'utf8'); }
      catch (e) { processed++; this._emitProgress(processed, total, ent.relPath, 'read-error'); continue; }

      const oldChunks = (idx.files[ent.relPath] && idx.files[ent.relPath].chunks) || [];
      for (const c of oldChunks) {
        delete vecs[this._chunkId(ent.relPath, c.id)];
      }

      const chunks = chunkDocument(text);
      const cleanChunks = chunks.map(c => ({
        id: c.id,
        heading: c.heading,
        tokens: c.tokens,
        text: c.text,
      }));

      for (const c of cleanChunks) {
        embedBatch.push(c.text);
        chunkMetaBatch.push({ relPath: ent.relPath, chunk: c });
      }

      idx.files[ent.relPath] = {
        mtime: ent.mtime,
        size: ent.size,
        chunks: cleanChunks.map(c => ({ id: c.id, heading: c.heading, tokens: c.tokens, text: c.text })),
      };

      processed++;
      this._emitProgress(processed, total, ent.relPath, 'embedding');

      if (embedBatch.length >= EMBED_BATCH_SIZE) {
        const embeddings = await this._fetchEmbeddings(embedBatch);
        for (let i = 0; i < chunkMetaBatch.length; i++) {
          const { relPath, chunk } = chunkMetaBatch[i];
          vecs[this._chunkId(relPath, chunk.id)] = embeddings[i];
        }
        embedBatch.length = 0;
        chunkMetaBatch.length = 0;
        await new Promise(r => setTimeout(r, EMBED_BATCH_DELAY));
      }

      await new Promise(r => setImmediate(r));
    }

    if (embedBatch.length > 0 && !this._cancelFlag) {
      const embeddings = await this._fetchEmbeddings(embedBatch);
      for (let i = 0; i < chunkMetaBatch.length; i++) {
        const { relPath, chunk } = chunkMetaBatch[i];
        vecs[this._chunkId(relPath, chunk.id)] = embeddings[i];
      }
    }

    if (!this._cancelFlag) {
      idx.lastIndexed = Date.now();
      idx.embeddingModel = EMBED_MODEL;
      if (entries.length > 0) idx.folder = entries[0].absPath.replace(/[\\/][^\\/]+$/, '');
      this._saveIndex();
      this._saveVectors();
    }

    return { ok: !this._cancelFlag, canceled: this._cancelFlag, total, processed };
  }

  async search(query, opts) {
    opts = opts || {};
    const topK = opts.topK || 20;
    const tier = opts.tier || 'pro';
    const idx = this._loadIndex();
    const vecs = this._loadVectors();

    const chunkKeys = Object.keys(vecs);
    if (chunkKeys.length === 0) return { ok: true, results: [] };

    const qEmb = await this._fetchEmbeddings([query]);
    const qv = qEmb[0];

    const scored = [];
    for (const key of chunkKeys) {
      const v = vecs[key];
      if (!v) continue;
      const sim = _cosineSim(qv, v);
      scored.push({ key, score: sim });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, topK);

    const results = top.map(s => {
      const [relPath, chunkIdStr] = s.key.split('#');
      const chunkId = parseInt(chunkIdStr, 10);
      const fileInfo = idx.files[relPath];
      const chunk = fileInfo && fileInfo.chunks ? fileInfo.chunks.find(c => c.id === chunkId) : null;
      return {
        relPath,
        chunkId,
        heading: chunk ? chunk.heading : '',
        score: s.score,
        text: chunk ? chunk.text : '',
      };
    });

    let finalResults = results;
    if (tier === 'custom' && results.length > 0) {
      try {
        const docTexts = results.map(r => r.text);
        const rerankRes = await this._fetchRerank(query, docTexts, Math.min(5, results.length));
        const reranked = rerankRes
          .sort((a, b) => b.score - a.score)
          .map(r => ({ ...results[r.index], rerankScore: r.score, score: r.score }));
        finalResults = reranked;
      } catch (e) {
        console.warn('[rag] rerank failed, fallback to vector score', e.message);
      }
    }

    return { ok: true, results: finalResults };
  }
}

module.exports = RagIndex;
