//! 文档分块模块
//!
//! 从 Node.js 版 doc-chunker.js 迁移而来。
//! 负责将长篇 Markdown 文档按标题、段落切分为适合向量检索的小块，
//! 并在相邻块之间添加重叠文本以保持上下文连贯。

/// 分块结果
#[derive(Debug, Clone)]
pub struct Chunk {
    /// 块的唯一编号（从 0 开始递增）
    pub id: usize,
    /// 该块所属的 Markdown 标题文本（不含 # 前缀）
    pub heading: String,
    /// 块的正文内容
    pub text: String,
    /// 估算的 token 数
    pub tokens: usize,
}

/// 分块参数
#[derive(Debug, Clone, Copy)]
pub struct ChunkOpts {
    /// 单块最大字符数
    pub max_chunk_size: usize,
    /// 单块最小字符数（小于此值的块会与相邻块合并）
    pub min_chunk_size: usize,
    /// 相邻块之间的重叠字符数
    pub overlap: usize,
}

impl Default for ChunkOpts {
    fn default() -> Self {
        // 与 Node.js 版 DEFAULT_OPTS 保持一致
        ChunkOpts {
            max_chunk_size: 1500,
            min_chunk_size: 200,
            overlap: 150,
        }
    }
}

/// 估算文本的 token 数：向上取整(字符数 / 1.5)
pub fn estimate_tokens(text: &str) -> usize {
    let len = text.chars().count();
    (len as f64 / 1.5).ceil() as usize
}

/// 返回字符串的字符数（等价于 JavaScript string.length 对 BMP 字符的行为）
fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// 判断一行是否为 Markdown 标题（#{1,6} + 空白 + 内容）。
/// 若是，返回标题文本（已 trim）；否则返回 None。
fn parse_heading(line: &str) -> Option<String> {
    // 统计行首 # 的数量，最多识别 6 个
    let mut hash_count = 0usize;
    for ch in line.chars() {
        if ch == '#' && hash_count < 6 {
            hash_count += 1;
        } else {
            break;
        }
    }
    if hash_count == 0 {
        return None;
    }
    // # 之后必须紧跟至少一个空白字符，再跟标题内容
    let rest = &line[hash_count..]; // # 为 ASCII，按字节切片安全
    let content = rest.trim_start_matches(|c: char| c.is_whitespace());
    if content.len() == rest.len() {
        // 没有前导空白被移除，说明 # 后无空白，不构成合法标题
        return None;
    }
    if content.is_empty() {
        return None;
    }
    Some(content.trim().to_string())
}

/// 按 Markdown 标题（#{1,6}）将文档拆分为多个小节。
/// 返回 (标题, 正文) 列表，标题为空字符串表示文档开头的无标题部分。
/// 正文为空的段落会被过滤掉。
pub fn split_by_headings(text: &str) -> Vec<(String, String)> {
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut current_heading = String::new();
    let mut current_lines: Vec<String> = Vec::new();

    for line in text.split('\n') {
        if let Some(heading) = parse_heading(line) {
            // 遇到新标题：先保存当前累积的内容
            if !current_lines.is_empty() || !current_heading.is_empty() {
                let body = current_lines.join("\n").trim().to_string();
                sections.push((current_heading.clone(), body));
            }
            current_heading = heading;
            current_lines.clear();
        } else {
            current_lines.push(line.to_string());
        }
    }

    // 保存最后一段
    if !current_lines.is_empty() || !current_heading.is_empty() {
        let body = current_lines.join("\n").trim().to_string();
        sections.push((current_heading.clone(), body));
    }

    // 过滤掉正文为空的小节
    sections
        .into_iter()
        .filter(|(_, body)| !body.is_empty())
        .collect()
}

/// 将文本按空行分段，并合并到不超过 max_size 的块中。
/// 单个段落超过 max_size 时按 max_size 硬切分（按字符切分，避免截断多字节字符）。
pub fn split_paragraphs_into_chunks(text: &str, max_size: usize) -> Vec<String> {
    // 按空行（含纯空白行）拆分为段落，等价于 JS 的 text.split(/\n\s*\n/)
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    for line in text.split('\n') {
        if line.trim().is_empty() {
            if !current.is_empty() {
                paragraphs.push(current.join("\n").trim().to_string());
                current.clear();
            }
        } else {
            current.push(line.to_string());
        }
    }
    if !current.is_empty() {
        paragraphs.push(current.join("\n").trim().to_string());
    }
    // 过滤空段落
    paragraphs.retain(|p| !p.is_empty());

    if paragraphs.is_empty() {
        return Vec::new();
    }

    let mut chunks: Vec<String> = Vec::new();
    let mut buf = String::new();

    for p in paragraphs {
        let p_len = char_len(&p);
        let buf_len = char_len(&buf);
        // 当前缓冲区 + 新段落 + 分隔符(\n\n 共 2 字符) 不超过上限则合并
        if buf_len + p_len + 2 <= max_size {
            if !buf.is_empty() {
                buf.push_str("\n\n");
            }
            buf.push_str(&p);
        } else {
            // 放不下：先保存缓冲区
            if !buf.is_empty() {
                chunks.push(buf.clone());
                buf.clear();
            }
            if p_len > max_size {
                // 段落本身超长，按 max_size 硬切分
                let chars: Vec<char> = p.chars().collect();
                let mut i = 0;
                while i < chars.len() {
                    let end = (i + max_size).min(chars.len());
                    let chunk: String = chars[i..end].iter().collect();
                    chunks.push(chunk);
                    i += max_size;
                }
                buf.clear();
            } else {
                buf = p;
            }
        }
    }

    if !buf.is_empty() {
        chunks.push(buf);
    }
    chunks
}

/// 合并过小的块：若块长度小于 min_size，则与相邻块用 \n\n 拼接。
pub fn merge_small_chunks(chunks: &[String], min_size: usize) -> Vec<String> {
    if chunks.len() <= 1 {
        return chunks.to_vec();
    }

    let mut result: Vec<String> = Vec::new();
    let mut buf = String::new();

    for c in chunks {
        if buf.is_empty() {
            buf = c.clone();
        } else if char_len(&buf) < min_size {
            // 当前缓冲区太小，继续拼接
            buf.push_str("\n\n");
            buf.push_str(c);
        } else {
            // 缓冲区已足够大，输出并开始新块
            result.push(buf.clone());
            buf = c.clone();
        }
    }

    if !buf.is_empty() {
        if !result.is_empty() && char_len(&buf) < min_size {
            // 末尾块太小，合并到上一个块
            let last = result.last_mut().unwrap();
            last.push_str("\n\n");
            last.push_str(&buf);
        } else {
            result.push(buf);
        }
    }

    result
}

/// 在相邻块之间添加重叠文本，增强上下文连贯性。
/// 每个块会从上一块末尾取若干字符作为前缀，从下一块开头取若干字符作为后缀。
/// 实际重叠量 = min(overlap, 当前块长度的 30%)。
pub fn add_overlap(chunk_texts: &[String], overlap: usize) -> Vec<String> {
    if chunk_texts.len() <= 1 || overlap == 0 {
        return chunk_texts.to_vec();
    }

    let n = chunk_texts.len();
    let mut result: Vec<String> = Vec::with_capacity(n);

    for i in 0..n {
        let text = &chunk_texts[i];
        let text_len = char_len(text);
        // 实际重叠量不超过当前块长度的 30%
        let actual_overlap = overlap.min((text_len as f64 * 0.3).floor() as usize);

        if actual_overlap == 0 {
            result.push(text.clone());
            continue;
        }

        // 从上一块末尾取 actual_overlap 个字符作为前缀
        let left: String = if i > 0 {
            let prev = &chunk_texts[i - 1];
            let prev_chars: Vec<char> = prev.chars().collect();
            let prev_len = prev_chars.len();
            let start = prev_len.saturating_sub(actual_overlap);
            prev_chars[start..].iter().collect()
        } else {
            String::new()
        };

        // 从下一块开头取 actual_overlap 个字符作为后缀
        let right: String = if i < n - 1 {
            let next = &chunk_texts[i + 1];
            let next_chars: Vec<char> = next.chars().collect();
            let end = actual_overlap.min(next_chars.len());
            next_chars[..end].iter().collect()
        } else {
            String::new()
        };

        let mut combined = String::with_capacity(left.len() + text.len() + right.len());
        combined.push_str(&left);
        combined.push_str(text);
        combined.push_str(&right);
        result.push(combined);
    }

    result
}

/// 将文档分块。
///
/// 流程：
/// 1. 按标题拆分为小节
/// 2. 每个小节按段落进一步切分到 max_chunk_size 以内
/// 3. 合并过小的块（小于 min_chunk_size）
/// 4. 相邻块添加 overlap 重叠
/// 5. 为每个块分配递增 id 并估算 token 数
pub fn chunk_document(text: &str, opts: Option<ChunkOpts>) -> Vec<Chunk> {
    let o = opts.unwrap_or_default();
    let text = text.trim();

    if text.is_empty() {
        return Vec::new();
    }

    let mut sections = split_by_headings(text);
    // 若按标题拆分后为空（如文档仅含标题无正文），则将整篇作为无标题小节
    if sections.is_empty() {
        sections.push((String::new(), text.to_string()));
    }

    let mut all_chunks: Vec<Chunk> = Vec::new();

    for (heading, sec_text) in &sections {
        let mut section_chunks: Vec<String> = if char_len(sec_text) <= o.max_chunk_size {
            vec![sec_text.clone()]
        } else {
            let mut sc = split_paragraphs_into_chunks(sec_text, o.max_chunk_size);
            sc = merge_small_chunks(&sc, o.min_chunk_size);
            sc
        };

        section_chunks = add_overlap(&section_chunks, o.overlap);

        for t in &section_chunks {
            all_chunks.push(Chunk {
                id: 0, // 下方统一赋值
                heading: heading.clone(),
                text: t.clone(),
                tokens: estimate_tokens(t),
            });
        }
    }

    // 统一分配递增 id
    for (idx, chunk) in all_chunks.iter_mut().enumerate() {
        chunk.id = idx;
    }

    all_chunks
}
