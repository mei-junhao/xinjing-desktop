//! RAG 向量索引模块
//!
//! 从 Node.js rag-index.js 迁移而来。
//! 负责文档分块、向量化、增量索引与语义检索。
//!
//! 核心流程：
//! 1. 通过 doc_chunker 的 chunk_document 对文件内容分块
//! 2. 调用代理服务器的 embedding API (BAAI/bge-m3) 获取向量
//! 3. 向量存储为 JSON 文件 (rag-vectors.json)，索引元数据存为 rag-index.json
//! 4. 增量更新：基于 mtime 和 size 判断文件是否变更
//! 5. 搜索：cosine 相似度排序 + 可选 rerank (BAAI/bge-reranker-v2-m3)

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::time::sleep;

use super::doc_chunker::chunk_document;

/// 嵌入模型名称
const EMBED_MODEL: &str = "BAAI/bge-m3";
/// 重排模型名称
const RERANK_MODEL: &str = "BAAI/bge-reranker-v2-m3";
/// 单批 embedding 最大数量
const EMBED_BATCH_SIZE: usize = 32;
/// 批次之间的间隔（毫秒）
const EMBED_BATCH_DELAY: u64 = 200;
/// 最大重试次数
const MAX_RETRIES: usize = 3;
/// HTTP 请求超时（秒）
const HTTP_TIMEOUT_SECS: u64 = 30;

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/// RAG 模块错误类型
#[derive(Debug)]
pub enum RagError {
    /// HTTP 请求层错误（网络、超时等）
    Http(String),
    /// API 返回异常（状态码非 2xx 或数据格式不对）
    Api(String),
    /// IO 错误
    Io(std::io::Error),
    /// JSON 序列化/反序列化错误
    Json(serde_json::Error),
    /// 任务被取消
    Canceled,
}

impl fmt::Display for RagError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RagError::Http(msg) => write!(f, "HTTP 错误: {}", msg),
            RagError::Api(msg) => write!(f, "API 错误: {}", msg),
            RagError::Io(e) => write!(f, "IO 错误: {}", e),
            RagError::Json(e) => write!(f, "JSON 错误: {}", e),
            RagError::Canceled => write!(f, "任务已取消"),
        }
    }
}

impl std::error::Error for RagError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            RagError::Io(e) => Some(e),
            RagError::Json(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for RagError {
    fn from(e: std::io::Error) -> Self {
        RagError::Io(e)
    }
}

impl From<serde_json::Error> for RagError {
    fn from(e: serde_json::Error) -> Self {
        RagError::Json(e)
    }
}

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

/// 进度回调类型
pub type ProgressCb = Arc<dyn Fn(ProgressMsg) + Send + Sync>;

/// 构造 RagIndex 所需的选项
pub struct RagIndexOpts {
    /// 用户数据目录，向量与索引文件存放于此
    pub user_data_dir: PathBuf,
    /// 代理服务器主机名（默认 xinjingchat.online）
    pub proxy_host: Option<String>,
    /// 代理服务密钥（APP_PROXY_KEY）
    pub proxy_key: String,
    /// 机器标识
    pub machine_id: Option<String>,
}

/// 待索引的文件条目
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// 相对路径（作为索引 key）
    pub rel_path: String,
    /// 绝对路径（用于读取文件内容）
    pub abs_path: PathBuf,
    /// 文件修改时间（Unix 毫秒）
    pub mtime: u64,
    /// 文件大小（字节）
    pub size: u64,
}

/// 单个分块的元数据
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChunkMeta {
    pub id: usize,
    pub heading: String,
    pub tokens: usize,
    pub text: String,
}

/// 单个文件的元数据
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileMeta {
    pub mtime: u64,
    pub size: u64,
    pub chunks: Vec<ChunkMeta>,
}

/// 索引文件整体结构
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexData {
    pub version: u32,
    pub embedding_model: String,
    pub folder: String,
    pub last_indexed: u64,
    pub files: HashMap<String, FileMeta>,
}

impl Default for IndexData {
    fn default() -> Self {
        IndexData {
            version: 1,
            embedding_model: EMBED_MODEL.to_string(),
            folder: String::new(),
            last_indexed: 0,
            files: HashMap::new(),
        }
    }
}

/// 进度消息（通过回调发出）
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressMsg {
    pub current: usize,
    pub total: usize,
    pub file_name: String,
    pub stage: String,
}

/// 索引状态信息
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusInfo {
    pub ok: bool,
    pub folder: String,
    pub last_indexed: u64,
    pub file_count: usize,
    pub chunk_count: usize,
    pub embedding_model: String,
}

/// 构建索引的结果
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildResult {
    pub ok: bool,
    pub canceled: bool,
    pub total: usize,
    pub processed: usize,
}

/// 搜索选项
#[derive(Clone, Debug, Default)]
pub struct SearchOpts {
    /// 返回前 K 条结果，默认 20
    pub top_k: Option<usize>,
    /// 服务层级，"custom" 时启用 rerank
    pub tier: Option<String>,
}

/// 单条搜索结果
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultItem {
    pub rel_path: String,
    pub chunk_id: usize,
    pub heading: String,
    pub score: f64,
    pub text: String,
    /// rerank 分数（仅启用 rerank 时存在）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rerank_score: Option<f64>,
}

/// 搜索结果
#[derive(Clone, Debug, Serialize)]
pub struct SearchResult {
    pub ok: bool,
    pub results: Vec<SearchResultItem>,
}

/// 重排结果
#[derive(Clone, Debug, Serialize)]
pub struct RerankResult {
    pub index: usize,
    pub score: f64,
}

// ---------------------------------------------------------------------------
// API 响应结构（内部使用）
// ---------------------------------------------------------------------------

/// embedding 接口响应
#[derive(Debug, Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingItem>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingItem {
    embedding: Vec<f64>,
}

/// rerank 接口响应
#[derive(Debug, Deserialize)]
struct RerankResponse {
    results: Vec<RerankItem>,
}

#[derive(Debug, Deserialize)]
struct RerankItem {
    index: usize,
    relevance_score: f64,
}

// ---------------------------------------------------------------------------
// RagIndex 主体
// ---------------------------------------------------------------------------

/// RAG 向量索引
pub struct RagIndex {
    /// 用户数据目录
    pub user_data_dir: PathBuf,
    /// 代理服务器主机名
    pub proxy_host: String,
    /// 代理密钥
    pub proxy_key: String,
    /// 机器标识
    pub machine_id: String,
    /// 向量文件路径 (rag-vectors.json)
    pub vector_file: PathBuf,
    /// 索引文件路径 (rag-index.json)
    pub index_file: PathBuf,
    /// 取消标志
    pub cancel_flag: Arc<AtomicBool>,
    /// HTTP 客户端（内部使用）
    client: reqwest::Client,
}

impl RagIndex {
    /// 创建新的 RagIndex 实例
    pub fn new(opts: RagIndexOpts) -> Result<Self, RagError> {
        let proxy_host = opts
            .proxy_host
            .unwrap_or_else(|| "xinjingchat.online".to_string());
        let machine_id = opts.machine_id.unwrap_or_else(|| "unknown".to_string());
        let vector_file = opts.user_data_dir.join("rag-vectors.json");
        let index_file = opts.user_data_dir.join("rag-index.json");

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
            .build()
            .map_err(|e| RagError::Http(e.to_string()))?;

        Ok(RagIndex {
            user_data_dir: opts.user_data_dir,
            proxy_host,
            proxy_key: opts.proxy_key,
            machine_id,
            vector_file,
            index_file,
            cancel_flag: Arc::new(AtomicBool::new(false)),
            client,
        })
    }

    /// 生成分块标识：relPath#idx
    fn chunk_id(rel_path: &str, idx: usize) -> String {
        format!("{}#{}", rel_path, idx)
    }

    /// 发送进度回调
    fn emit_progress(
        progress_cb: &Option<ProgressCb>,
        current: usize,
        total: usize,
        file_name: &str,
        stage: &str,
    ) {
        if let Some(cb) = progress_cb {
            cb(ProgressMsg {
                current,
                total,
                file_name: file_name.to_string(),
                stage: stage.to_string(),
            });
        }
    }

    /// 从磁盘加载索引，文件不存在或解析失败时返回默认值
    fn load_index(&self) -> IndexData {
        match std::fs::read(&self.index_file) {
            Ok(bytes) => serde_json::from_slice::<IndexData>(&bytes).unwrap_or_default(),
            Err(_) => IndexData::default(),
        }
    }

    /// 保存索引到磁盘
    fn save_index(&self, idx: &IndexData) {
        match serde_json::to_string_pretty(idx) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&self.index_file, json) {
                    log::error!("[rag] 保存索引失败: {}", e);
                }
            }
            Err(e) => log::error!("[rag] 序列化索引失败: {}", e),
        }
    }

    /// 从磁盘加载向量，文件不存在或解析失败时返回空表
    fn load_vectors(&self) -> HashMap<String, Vec<f64>> {
        match std::fs::read(&self.vector_file) {
            Ok(bytes) => {
                serde_json::from_slice::<HashMap<String, Vec<f64>>>(&bytes).unwrap_or_default()
            }
            Err(_) => HashMap::new(),
        }
    }

    /// 保存向量到磁盘
    fn save_vectors(&self, vecs: &HashMap<String, Vec<f64>>) {
        match serde_json::to_string(vecs) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&self.vector_file, json) {
                    log::error!("[rag] 保存向量失败: {}", e);
                }
            }
            Err(e) => log::error!("[rag] 序列化向量失败: {}", e),
        }
    }

    /// 获取当前索引状态
    pub fn get_status(&self) -> StatusInfo {
        let idx = self.load_index();
        let mut file_count = 0usize;
        let mut chunk_count = 0usize;
        for meta in idx.files.values() {
            file_count += 1;
            chunk_count += meta.chunks.len();
        }
        StatusInfo {
            ok: true,
            folder: idx.folder,
            last_indexed: idx.last_indexed,
            file_count,
            chunk_count,
            embedding_model: idx.embedding_model,
        }
    }

    /// 取消正在进行的索引构建
    pub fn cancel(&self) {
        self.cancel_flag.store(true, Ordering::SeqCst);
    }

    /// 向代理服务器发送 POST 请求（对 5xx 错误自动重试）
    async fn post_json<T: for<'de> Deserialize<'de>>(
        &self,
        api_path: &str,
        payload: &serde_json::Value,
    ) -> Result<T, RagError> {
        let url = format!("https://{}{}", self.proxy_host, api_path);
        let mut last_err: Option<RagError> = None;

        for attempt in 0..MAX_RETRIES {
            let resp = self
                .client
                .post(&url)
                .header("Authorization", format!("Bearer {}", self.proxy_key))
                .header("X-Machine-Id", &self.machine_id)
                .header("Accept", "application/json")
                .json(payload)
                .send()
                .await;

            match resp {
                Ok(r) => {
                    let status = r.status();
                    if status.is_success() {
                        let parsed = r
                            .json::<T>()
                            .await
                            .map_err(|e| RagError::Api(e.to_string()))?;
                        return Ok(parsed);
                    } else {
                        let status_code = status.as_u16();
                        let body = r.text().await.unwrap_or_default();
                        let preview: String = body.chars().take(200).collect();
                        let msg = format!("API {} : {}", status_code, preview);
                        // 仅 5xx 错误重试，4xx 直接返回
                        if status_code >= 500 && attempt + 1 < MAX_RETRIES {
                            last_err = Some(RagError::Api(msg));
                            sleep(Duration::from_millis(500 * 2u64.pow(attempt as u32))).await;
                            continue;
                        }
                        return Err(RagError::Api(msg));
                    }
                }
                // 网络错误不重试，直接返回
                Err(e) => return Err(RagError::Http(e.to_string())),
            }
        }

        Err(last_err.unwrap_or_else(|| RagError::Http("重试次数耗尽".to_string())))
    }

    /// 批量获取 embedding 向量
    ///
    /// 调用代理服务器 /v1/embeddings 接口，返回与输入文本等长的向量列表。
    pub async fn fetch_embeddings(&self, texts: &[String]) -> Result<Vec<Vec<f64>>, RagError> {
        let payload = serde_json::json!({
            "model": EMBED_MODEL,
            "input": texts,
        });
        let res: EmbeddingResponse = self.post_json("/v1/embeddings", &payload).await?;
        if res.data.is_empty() {
            return Err(RagError::Api("embedding 响应为空".to_string()));
        }
        Ok(res.data.into_iter().map(|d| d.embedding).collect())
    }

    /// 获取 rerank 结果
    ///
    /// 调用代理服务器 /v1/rerank 接口，对文档按与 query 的相关性重排序。
    pub async fn fetch_rerank(
        &self,
        query: &str,
        documents: &[String],
        top_n: usize,
    ) -> Result<Vec<RerankResult>, RagError> {
        let payload = serde_json::json!({
            "model": RERANK_MODEL,
            "query": query,
            "documents": documents,
            "top_n": top_n,
            "return_documents": false,
        });
        let res: RerankResponse = self.post_json("/v1/rerank", &payload).await?;
        Ok(res
            .results
            .into_iter()
            .map(|r| RerankResult {
                index: r.index,
                score: r.relevance_score,
            })
            .collect())
    }

    /// 构建索引（增量更新）
    ///
    /// 1. 删除不再存在的文件及其向量
    /// 2. 对新增或变更（mtime/size 不同）的文件分块并批量向量化
    /// 3. 批次大小 32，批次间隔 200ms
    /// 4. 支持通过 cancel() 取消
    pub async fn build_index(
        &self,
        entries: Vec<FileEntry>,
        progress_cb: Option<ProgressCb>,
    ) -> Result<BuildResult, RagError> {
        // 重置取消标志
        self.cancel_flag.store(false, Ordering::SeqCst);
        let mut idx = self.load_index();
        let mut vecs = self.load_vectors();
        let total = entries.len();
        let mut processed: usize = 0;

        // 收集新路径集合
        let new_rel_paths: HashSet<&str> =
            entries.iter().map(|e| e.rel_path.as_str()).collect();

        // 删除不再存在的文件及其向量
        let removed: Vec<String> = idx
            .files
            .keys()
            .filter(|rp| !new_rel_paths.contains(rp.as_str()))
            .cloned()
            .collect();
        for rp in &removed {
            if let Some(meta) = idx.files.get(rp) {
                for c in &meta.chunks {
                    vecs.remove(&Self::chunk_id(rp, c.id));
                }
            }
            idx.files.remove(rp);
        }

        // 找出需要处理的文件（新增或 mtime/size 变化）
        let to_process: Vec<&FileEntry> = entries
            .iter()
            .filter(|ent| match idx.files.get(&ent.rel_path) {
                Some(old) => old.mtime != ent.mtime || old.size != ent.size,
                None => true,
            })
            .collect();

        // 批量 embedding 缓冲
        let mut embed_batch: Vec<String> = Vec::new();
        let mut chunk_meta_batch: Vec<(String, ChunkMeta)> = Vec::new();

        for ent in to_process {
            // 检查取消标志
            if self.cancel_flag.load(Ordering::SeqCst) {
                break;
            }

            // 读取文件内容（失败则跳过，标记 read-error）
            let text = match fs::read_to_string(&ent.abs_path).await {
                Ok(t) => t,
                Err(_) => {
                    processed += 1;
                    Self::emit_progress(
                        &progress_cb,
                        processed,
                        total,
                        &ent.rel_path,
                        "read-error",
                    );
                    continue;
                }
            };

            // 删除该文件旧的分块向量
            if let Some(old_meta) = idx.files.get(&ent.rel_path) {
                for c in &old_meta.chunks {
                    vecs.remove(&Self::chunk_id(&ent.rel_path, c.id));
                }
            }

            // 分块
            let chunks = chunk_document(&text, None);
            let clean_chunks: Vec<ChunkMeta> = chunks
                .into_iter()
                .map(|c| ChunkMeta {
                    id: c.id,
                    heading: c.heading,
                    tokens: c.tokens,
                    text: c.text,
                })
                .collect();

            // 加入 embedding 批次
            for c in &clean_chunks {
                embed_batch.push(c.text.clone());
                chunk_meta_batch.push((ent.rel_path.clone(), c.clone()));
            }

            // 更新索引元数据
            idx.files.insert(
                ent.rel_path.clone(),
                FileMeta {
                    mtime: ent.mtime,
                    size: ent.size,
                    chunks: clean_chunks,
                },
            );

            processed += 1;
            Self::emit_progress(&progress_cb, processed, total, &ent.rel_path, "embedding");

            // 批次满了就请求 embedding
            if embed_batch.len() >= EMBED_BATCH_SIZE {
                let embeddings = self.fetch_embeddings(&embed_batch).await?;
                for (i, (rel_path, chunk)) in chunk_meta_batch.iter().enumerate() {
                    if let Some(emb) = embeddings.get(i) {
                        vecs.insert(Self::chunk_id(rel_path, chunk.id), emb.clone());
                    }
                }
                embed_batch.clear();
                chunk_meta_batch.clear();
                sleep(Duration::from_millis(EMBED_BATCH_DELAY)).await;
            }

            // 让出执行权，避免长时间阻塞
            tokio::task::yield_now().await;
        }

        // 处理剩余批次
        if !embed_batch.is_empty() && !self.cancel_flag.load(Ordering::SeqCst) {
            let embeddings = self.fetch_embeddings(&embed_batch).await?;
            for (i, (rel_path, chunk)) in chunk_meta_batch.iter().enumerate() {
                if let Some(emb) = embeddings.get(i) {
                    vecs.insert(Self::chunk_id(rel_path, chunk.id), emb.clone());
                }
            }
        }

        let canceled = self.cancel_flag.load(Ordering::SeqCst);
        if !canceled {
            idx.last_indexed = now_millis();
            idx.embedding_model = EMBED_MODEL.to_string();
            // folder 取第一个条目所在目录
            if let Some(first) = entries.first() {
                if let Some(parent) = first.abs_path.parent() {
                    idx.folder = parent.to_string_lossy().to_string();
                }
            }
            self.save_index(&idx);
            self.save_vectors(&vecs);
        }

        Ok(BuildResult {
            ok: !canceled,
            canceled,
            total,
            processed,
        })
    }

    /// 语义搜索
    ///
    /// 1. 对 query 获取 embedding
    /// 2. 与所有分块向量计算 cosine 相似度，取 topK
    /// 3. tier == "custom" 时调用 rerank 重排
    pub async fn search(
        &self,
        query: &str,
        opts: SearchOpts,
    ) -> Result<SearchResult, RagError> {
        let top_k = opts.top_k.unwrap_or(20);
        let tier = opts.tier.unwrap_or_else(|| "pro".to_string());

        let idx = self.load_index();
        let vecs = self.load_vectors();

        if vecs.is_empty() {
            return Ok(SearchResult {
                ok: true,
                results: vec![],
            });
        }

        // 获取查询向量
        let q_emb = self.fetch_embeddings(&[query.to_string()]).await?;
        let qv = match q_emb.first() {
            Some(v) => v,
            None => {
                return Ok(SearchResult {
                    ok: true,
                    results: vec![],
                });
            }
        };

        // 计算相似度并排序（降序）
        let mut scored: Vec<(String, f64)> = vecs
            .iter()
            .map(|(key, v)| (key.clone(), cosine_sim(qv, v)))
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(top_k);

        // 组装结果
        let mut results: Vec<SearchResultItem> = Vec::with_capacity(scored.len());
        for (key, score) in &scored {
            // key 格式为 relPath#chunkId
            let (rel_path, chunk_id_str) = match key.split_once('#') {
                Some((rp, cid)) => (rp, cid),
                None => continue,
            };
            let chunk_id: usize = match chunk_id_str.parse() {
                Ok(n) => n,
                Err(_) => continue,
            };
            let chunk = idx
                .files
                .get(rel_path)
                .and_then(|f| f.chunks.iter().find(|c| c.id == chunk_id));
            results.push(SearchResultItem {
                rel_path: rel_path.to_string(),
                chunk_id,
                heading: chunk.map(|c| c.heading.clone()).unwrap_or_default(),
                score: *score,
                text: chunk.map(|c| c.text.clone()).unwrap_or_default(),
                rerank_score: None,
            });
        }

        // custom 层级启用 rerank
        if tier == "custom" && !results.is_empty() {
            let doc_texts: Vec<String> = results.iter().map(|r| r.text.clone()).collect();
            let top_n = results.len().min(5);
            match self.fetch_rerank(query, &doc_texts, top_n).await {
                Ok(rerank_res) => {
                    let mut sorted = rerank_res;
                    sorted.sort_by(|a, b| {
                        b.score
                            .partial_cmp(&a.score)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    });
                    let mut reranked: Vec<SearchResultItem> = Vec::new();
                    for r in &sorted {
                        if let Some(item) = results.get(r.index) {
                            let mut item = item.clone();
                            item.rerank_score = Some(r.score);
                            item.score = r.score;
                            reranked.push(item);
                        }
                    }
                    results = reranked;
                }
                Err(e) => {
                    // rerank 失败时回退到向量分数
                    log::warn!("[rag] rerank 失败，回退到向量分数: {}", e);
                }
            }
        }

        Ok(SearchResult {
            ok: true,
            results,
        })
    }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/// 计算两个向量的余弦相似度
pub fn cosine_sim(a: &[f64], b: &[f64]) -> f64 {
    let mut dot = 0.0_f64;
    let mut na = 0.0_f64;
    let mut nb = 0.0_f64;
    let len = a.len().min(b.len());
    for i in 0..len {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// 获取当前 Unix 时间戳（毫秒）
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
