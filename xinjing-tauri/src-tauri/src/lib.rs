//! lib.rs — 心镜 XinJing Tauri v2 应用核心库
//!
//! 整合 license / doc_chunker / rag_index 三个子模块，
//! 实现 21+ 个 Tauri commands，对应原 Electron main.js 的 IPC handlers。

pub mod doc_chunker;
pub mod license;
pub mod rag_index;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;

use crate::rag_index::{FileEntry, RagIndex, RagIndexOpts, SearchOpts};

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/// 应用固定 userData 目录名（与 Electron 版保持兼容，位于 AppData/XinJing）
const USER_DATA_NAME: &str = "XinJing";

/// keyring 服务名
const KEYRING_SERVICE: &str = "xinjing";
/// 加密标识前缀
const ENC_PREFIX: &str = "xj-enc:";

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

/// RAG 索引的全局状态（仅持有 cancel_flag 的共享引用，不持有 RagIndex 实例）
/// 这样可以避免 async 函数中持有非 Send 的 Mutex guard
#[derive(Default)]
pub struct RagState {
    pub cancel_flag: Mutex<Option<Arc<AtomicBool>>>,
}

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

/// 返回给前端的综合授权状态（camelCase 与原 preload.js 契约对齐）
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStateResponse {
    pub mode: String,
    pub identity: String,
    pub tier: String,
    pub ai_unlocked: bool,
    pub ai_trial_active: bool,
    pub ai_trial_days_left: i64,
    pub ai_trial_days: i64,
    pub days_left: i64,
    pub activated: bool,
    pub expired: bool,
    pub expires_at: i64,
    pub trial_days: i64,
    pub version: String,
}

/// 持久化的激活信息（license.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseRecord {
    pub identity: String,
    pub tier: String,
    pub machine_code: String,
    pub activated_at: i64,
    pub expires_at: i64,
}

/// 备份配置
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackupConfig {
    #[serde(default)]
    pub locations: Vec<String>,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub email_enabled: bool,
}

/// 首次启动记录
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrialRecord {
    first_launch: i64,
}

/// 机器码记录
#[derive(Debug, Clone, Serialize, Deserialize)]
struct MachineRecord {
    code: String,
}

/// 跨重装安装标记
#[derive(Debug, Clone, Serialize, Deserialize)]
struct InstallMarker {
    mc: String,
    first_install: i64,
}

/// 用户文档元数据
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserDocMeta {
    pub rel_path: String,
    pub name: String,
    pub size: u64,
    pub mtime: u64,
    pub ext: String,
}

/// 用户文档读取选项
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReadUserDocsOpts {
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

/// 用户文档读取结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserDocsResult {
    pub items: Vec<UserDocMeta>,
    pub total: usize,
}

/// 云激活响应
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CloudVerifyResponse {
    pub ok: bool,
    #[serde(default)]
    pub identity: String,
    #[serde(default)]
    pub tier: String,
    #[serde(default)]
    pub expires_at: i64,
    #[serde(default)]
    pub error: String,
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/// 当前 Unix 时间戳（毫秒）
fn now_millis() -> i64 {
    Utc::now().timestamp_millis()
}

/// 获取应用 userData 目录（AppData/XinJing）
fn user_data_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    // app_data_dir 默认返回 .../com.xinjing.desktop，我们改用固定的 XinJing
    let parent = base.parent().unwrap_or(&base);
    parent.join(USER_DATA_NAME)
}

/// 确保 userData 目录存在
fn ensure_user_data(app: &AppHandle) -> PathBuf {
    let dir = user_data_dir(app);
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

/// ProgramData 标记路径（Windows: %ProgramData%\XinJing\.xjinstall）
fn program_data_marker_path() -> PathBuf {
    let base = std::env::var("ProgramData")
        .or_else(|_| std::env::var("ALLUSERSPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("XinJing").join(".xjinstall")
}

/// 读取首次启动时间戳，无则创建
fn ensure_trial(user_data: &PathBuf) -> i64 {
    let p = user_data.join("trial.json");
    if let Ok(s) = fs::read_to_string(&p) {
        if let Ok(r) = serde_json::from_str::<TrialRecord>(&s) {
            return r.first_launch;
        }
    }
    let ts = now_millis();
    let _ = fs::write(
        &p,
        serde_json::to_string(&TrialRecord { first_launch: ts }).unwrap_or_default(),
    );
    ts
}

/// 读取安装标记
fn read_install_marker() -> Option<InstallMarker> {
    let p = program_data_marker_path();
    let raw = fs::read_to_string(&p).ok()?;
    let decoded = base64_decode_simple(&raw)?;
    let j: InstallMarker = serde_json::from_str(&decoded).ok()?;
    if j.first_install > 0 {
        Some(j)
    } else {
        None
    }
}

/// 写入安装标记（base64 编码）
fn write_install_marker(mc: &str, first_install: i64) {
    let p = program_data_marker_path();
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let marker = InstallMarker {
        mc: mc.to_string(),
        first_install,
    };
    let json = serde_json::to_string(&marker).unwrap_or_default();
    let encoded = base64_encode_simple(&json);
    let _ = fs::write(&p, encoded);
}

/// 简单的 base64 编码（标准字母表）
fn base64_encode_simple(input: &str) -> String {
    const TABLE: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = input.as_bytes();
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((n >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(n & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// 简单的 base64 解码
fn base64_decode_simple(input: &str) -> Option<String> {
    const TABLE: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = [255u8; 256];
    for (i, c) in TABLE.iter().enumerate() {
        lookup[*c as usize] = i as u8;
    }
    let input = input.trim();
    let mut bytes = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for c in input.chars() {
        if c == '=' {
            break;
        }
        let v = lookup[c as usize];
        if v == 255 {
            continue;
        }
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buf >> bits) as u8 & 0xff);
        }
    }
    String::from_utf8(bytes).ok()
}

/// 解析真正的首次安装时间戳（跨重装稳定）
fn resolve_first_install(mc: &str, user_data: &PathBuf) -> i64 {
    let trial_ts = ensure_trial(user_data);
    let mut first_install = trial_ts;
    if let Some(marker) = read_install_marker() {
        if (marker.mc.is_empty() || marker.mc == mc) && marker.first_install < first_install {
            first_install = marker.first_install;
        }
    }
    write_install_marker(mc, first_install);
    first_install
}

/// 读取 license.json
fn read_license(user_data: &PathBuf) -> Option<LicenseRecord> {
    let p = user_data.join("license.json");
    let s = fs::read_to_string(&p).ok()?;
    let j: LicenseRecord = serde_json::from_str(&s).ok()?;
    if !j.identity.is_empty() && j.activated_at > 0 {
        Some(j)
    } else {
        None
    }
}

/// 写入 license.json
fn write_license(user_data: &PathBuf, lic: &LicenseRecord) {
    let p = user_data.join("license.json");
    let _ = fs::write(
        &p,
        serde_json::to_string_pretty(lic).unwrap_or_default(),
    );
}

/// 读取机器码（持久化在 userData/machine.json）
fn get_machine_code_internal(user_data: &PathBuf) -> String {
    let p = user_data.join("machine.json");
    if let Ok(s) = fs::read_to_string(&p) {
        if let Ok(r) = serde_json::from_str::<MachineRecord>(&s) {
            if !r.code.is_empty() {
                return r.code;
            }
        }
    }
    // 生成新机器码
    let hostname = hostname_or_default();
    let username = username_or_default();
    let homedir = homedir_or_default();
    let raw = format!("{}__{}__{}", hostname, username, homedir);
    let code = sha256_hex(&raw)[..16].to_uppercase();
    let _ = fs::write(
        &p,
        serde_json::to_string(&MachineRecord { code: code.clone() }).unwrap_or_default(),
    );
    code
}

fn hostname_or_default() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown-host".to_string())
}

fn username_or_default() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "unknown-user".to_string())
}

fn homedir_or_default() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".to_string())
}

/// 计算 SHA256 哈希并返回 64 字符十六进制字符串
fn sha256_hex(data: &str) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(data.as_bytes());
    let result = hasher.finalize();
    let mut s = String::with_capacity(64);
    for b in result {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// 计算综合授权状态
fn compute_state(app: &AppHandle) -> LicenseStateResponse {
    let user_data = ensure_user_data(app);
    let trial_first_launch = ensure_trial(&user_data);
    let now = now_millis();
    let (trial_state, days_left) = license::trial_status(trial_first_launch, now);

    let lic = read_license(&user_data);
    let activated_raw = lic
        .as_ref()
        .map(|l| !l.identity.is_empty() && l.activated_at > 0)
        .unwrap_or(false);
    let expired = lic
        .as_ref()
        .map(|l| l.expires_at != 0 && now > l.expires_at)
        .unwrap_or(false);
    let activated = activated_raw && !expired;

    let tier = lic
        .as_ref()
        .map(|l| l.tier.clone())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| if activated { "full".to_string() } else { "free".to_string() });
    // 试用期用户默认旗舰权限（custom），确保试用期间可体验全部功能
    let effective_tier = if !activated && days_left > 0 {
        "custom".to_string()
    } else {
        tier
    };

    let mc = get_machine_code_internal(&user_data);
    let first_install = resolve_first_install(&mc, &user_data);
    let (ai_trial_active, ai_trial_days_left) = license::ai_trial_status(first_install, now);
    let ai_unlocked = activated || ai_trial_active;

    let version = app
        .package_info()
        .version
        .to_string();

    LicenseStateResponse {
        mode: license::overall_mode(activated, trial_state).to_string(),
        identity: lic
            .as_ref()
            .map(|l| l.identity.clone())
            .unwrap_or_default(),
        tier: effective_tier,
        ai_unlocked,
        ai_trial_active,
        ai_trial_days_left,
        ai_trial_days: license::AI_TRIAL_DAYS,
        days_left,
        activated,
        expired,
        expires_at: lic.as_ref().map(|l| l.expires_at).unwrap_or(0),
        trial_days: license::TRIAL_DAYS,
        version,
    }
}

/// 广播授权状态变化
fn emit_license_state(app: &AppHandle) {
    let state = compute_state(app);
    let _ = app.emit("license-state", state);
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

/// 返回授权综合状态
#[tauri::command]
fn get_state(app: AppHandle) -> Result<LicenseStateResponse, String> {
    Ok(compute_state(&app))
}

/// 本地激活码校验
#[tauri::command]
fn activate(app: AppHandle, code: String) -> Result<LicenseStateResponse, String> {
    let user_data = ensure_user_data(&app);
    let mc = get_machine_code_internal(&user_data);
    let result = license::verify_key(&code, &mc);
    if !result.valid {
        return Err("激活码无效或机器码不匹配".to_string());
    }
    if result.expired {
        return Err("激活码已过期".to_string());
    }
    let now = now_millis();
    let lic = LicenseRecord {
        identity: result.identity.clone(),
        tier: result.tier.clone(),
        machine_code: mc,
        activated_at: now,
        expires_at: result.expires_at,
    };
    write_license(&user_data, &lic);
    let state = compute_state(&app);
    let _ = app.emit("license-state", state.clone());
    Ok(state)
}

/// 云激活校验
#[tauri::command]
async fn cloud_activate(app: AppHandle, code: String) -> Result<LicenseStateResponse, String> {
    let user_data = ensure_user_data(&app);
    let mc = get_machine_code_internal(&user_data);

    let host = std::env::var("XJ_CLOUD_VERIFY_HOST").unwrap_or_default();
    if host.is_empty() {
        return Err("云激活未配置：开发者尚未部署云端校验端点。请改用本地激活码激活。".to_string());
    }
    if code.is_empty() || mc.is_empty() {
        return Err("云激活参数缺失：需同时提供激活码与机器码。".to_string());
    }

    let url = format!("https://{}/license/verify", host);
    let body = serde_json::json!({ "code": code, "machineCode": mc });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败：{}", e))?;
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("User-Agent", "XinJing/1.0 (Tauri; cloud-activate)")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("云激活网络失败：{}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("云端校验返回异常状态：{}", status));
    }
    let j: CloudVerifyResponse = serde_json::from_str(&text)
        .map_err(|e| format!("云端响应格式异常：{}", e))?;

    if !j.ok {
        return Err(j.error);
    }
    let lic = LicenseRecord {
        identity: j.identity.clone(),
        tier: j.tier.clone(),
        machine_code: mc,
        activated_at: now_millis(),
        expires_at: j.expires_at,
    };
    write_license(&user_data, &lic);
    let state = compute_state(&app);
    let _ = app.emit("license-state", state.clone());
    Ok(state)
}

/// 获取机器码
#[tauri::command]
fn get_machine_code(app: AppHandle) -> Result<String, String> {
    let user_data = ensure_user_data(&app);
    Ok(get_machine_code_internal(&user_data))
}

/// 加密敏感数据（使用 keyring 替代 Electron safeStorage）
/// 存储策略：将明文存入 keyring，返回 "xj-enc:" + 摘要作为引用 key
#[tauri::command]
fn encrypt_secret(plain: String) -> Result<String, String> {
    if plain.is_empty() || !is_keyring_available() {
        // keyring 不可用时降级返回原文
        return Ok(plain);
    }
    let key = sha256_hex(&plain)[..32].to_string();
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key)
        .map_err(|e| format!("keyring 创建失败：{}", e))?;
    entry
        .set_password(&plain)
        .map_err(|e| format!("keyring 写入失败：{}", e))?;
    Ok(format!("{}{}", ENC_PREFIX, key))
}

/// 解密敏感数据
#[tauri::command]
fn decrypt_secret(stored: String) -> Result<String, String> {
    if stored.is_empty() || !stored.starts_with(ENC_PREFIX) {
        return Ok(stored);
    }
    if !is_keyring_available() {
        return Ok(String::new());
    }
    let key = &stored[ENC_PREFIX.len()..];
    let entry = keyring::Entry::new(KEYRING_SERVICE, key)
        .map_err(|e| format!("keyring 创建失败：{}", e))?;
    match entry.get_password() {
        Ok(p) => Ok(p),
        Err(e) => {
            log::warn!("[decrypt] keyring 读取失败：{}", e);
            Ok(String::new())
        }
    }
}

/// keyring 是否可用（Linux 无 libsecret 时会失败）
fn is_keyring_available() -> bool {
    // Windows DPAPI / macOS Keychain 总是可用
    // 简化处理：始终尝试，失败时降级
    cfg!(any(target_os = "windows", target_os = "macos"))
}

/// 保存备份配置
#[tauri::command]
fn save_backup_config(app: AppHandle, cfg: BackupConfig) -> Result<(), String> {
    let user_data = ensure_user_data(&app);
    let p = user_data.join("backup-config.json");
    let s = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    fs::write(&p, s).map_err(|e| e.to_string())
}

/// 选择备份文件夹
#[tauri::command]
async fn select_backup_folder(app: AppHandle) -> Result<Option<String>, String> {
    let folder = app
        .dialog()
        .file()
        .set_title("选择备份目录")
        .blocking_pick_folder();
    Ok(folder.map(|p| p.to_string()))
}

/// 选择用户文档目录
#[tauri::command]
async fn select_user_doc_folder(app: AppHandle) -> Result<Option<String>, String> {
    let folder = app
        .dialog()
        .file()
        .set_title("选择用户资料目录")
        .blocking_pick_folder();
    if let Some(ref p) = folder {
        let user_data = ensure_user_data(&app);
        let p_str = p.to_string();
        let _ = fs::write(
            user_data.join("user-doc-folder.json"),
            serde_json::json!({ "folder": p_str }).to_string(),
        );
    }
    Ok(folder.map(|p| p.to_string()))
}

/// 获取用户文档目录
#[tauri::command]
fn get_user_doc_folder(app: AppHandle) -> Result<Option<String>, String> {
    let user_data = ensure_user_data(&app);
    let p = user_data.join("user-doc-folder.json");
    if let Ok(s) = fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            if let Some(folder) = v.get("folder").and_then(|f| f.as_str()) {
                return Ok(Some(folder.to_string()));
            }
        }
    }
    Ok(None)
}

/// 读取用户文档元数据列表
#[tauri::command]
fn read_user_doc_meta(app: AppHandle) -> Result<Vec<UserDocMeta>, String> {
    let folder = get_user_doc_folder(app.clone())?.ok_or("未设置用户文档目录")?;
    let root = PathBuf::from(&folder);
    let mut items = Vec::new();
    collect_doc_meta(&root, &root, &mut items)?;
    items.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    Ok(items)
}

/// 递归收集文档元数据
fn collect_doc_meta(
    root: &PathBuf,
    current: &PathBuf,
    items: &mut Vec<UserDocMeta>,
) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            collect_doc_meta(root, &path, items)?;
            continue;
        }
        if !is_doc_file(&name) {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or(name.clone());
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        items.push(UserDocMeta {
            rel_path: rel,
            name,
            size: meta.len(),
            mtime,
            ext,
        });
    }
    Ok(())
}

/// 判断是否为支持的文档文件
fn is_doc_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    const EXTS: &[&str] = &[
        ".md", ".markdown", ".txt", ".pdf", ".docx", ".doc", ".rtf",
    ];
    EXTS.iter().any(|e| lower.ends_with(e))
}

/// 批量读取用户文档
#[tauri::command]
fn read_user_docs(
    app: AppHandle,
    opts: Option<ReadUserDocsOpts>,
) -> Result<UserDocsResult, String> {
    let mut all = read_user_doc_meta(app)?;
    let total = all.len();
    let opts = opts.unwrap_or_default();
    if let Some(offset) = opts.offset {
        if offset >= all.len() {
            all.clear();
        } else {
            all = all.split_off(offset);
        }
    }
    if let Some(limit) = opts.limit {
        all.truncate(limit);
    }
    Ok(UserDocsResult { items: all, total })
}

/// 读取单个用户文档内容
#[tauri::command]
fn read_user_doc_file(app: AppHandle, rel_path: String) -> Result<String, String> {
    let folder = get_user_doc_folder(app)?.ok_or("未设置用户文档目录")?;
    // 防止路径穿越
    let root = PathBuf::from(&folder);
    let target = root.join(&rel_path);
    let canonical = target.canonicalize().map_err(|e| e.to_string())?;
    let root_canonical = root.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&root_canonical) {
        return Err("非法路径访问".to_string());
    }
    fs::read_to_string(&canonical).map_err(|e| e.to_string())
}

/// 关键词搜索用户文档
#[tauri::command]
fn search_user_docs(
    app: AppHandle,
    query: String,
    max: Option<usize>,
) -> Result<Vec<UserDocMeta>, String> {
    let mut all = read_user_doc_meta(app)?;
    if query.is_empty() {
        if let Some(m) = max {
            all.truncate(m);
        }
        return Ok(all);
    }
    let q = query.to_lowercase();
    all.retain(|m| {
        m.name.to_lowercase().contains(&q) || m.rel_path.to_lowercase().contains(&q)
    });
    if let Some(m) = max {
        all.truncate(m);
    }
    Ok(all)
}

/// 打开外部链接
#[tauri::command]
async fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    app.shell()
        .open(url, None)
        .map_err(|e| e.to_string())
}

/// 检查更新
#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<bool, String> {
    // 通过 tauri-plugin-updater 检查
    // 实际更新检查在前端通过 @tauri-apps/plugin-updater 完成
    // 这里返回 true 表示可以触发检查
    let _ = app;
    Ok(true)
}

/// 打开激活窗口
#[tauri::command]
fn open_activation(app: AppHandle) -> Result<(), String> {
    // 创建激活窗口或切换到激活页
    // 简化：通过事件通知前端打开激活对话框
    let _ = app.emit("open-activation", ());
    Ok(())
}

/// 关闭确认对话框动作
#[tauri::command]
fn close_decision(app: AppHandle, action: String) -> Result<(), String> {
    let _ = app.emit("close-decision", action);
    Ok(())
}

/// 通知旧端口迁移完成
#[tauri::command]
fn notify_migrate_done(_app: AppHandle, ports: Vec<String>) -> Result<(), String> {
    log::info!("[migrate] 旧端口迁移完成：{:?}", ports);
    Ok(())
}

/// 激活完成通知
#[tauri::command]
fn activation_done(app: AppHandle) -> Result<(), String> {
    emit_license_state(&app);
    Ok(())
}

/// 获取应用代理密钥
/// Tauri 版通过环境变量注入，不依赖 secret.generated.js
#[tauri::command]
fn get_app_proxy_key() -> Result<String, String> {
    Ok(std::env::var("APP_PROXY_KEY").unwrap_or_default())
}

// ---------------------------------------------------------------------------
// RAG 相关 Commands
// ---------------------------------------------------------------------------

/// 创建 RagIndex 实例（每次新建，内部会加载索引文件）
fn create_rag_index(app: &AppHandle) -> Result<RagIndex, String> {
    let user_data = ensure_user_data(app);
    let proxy_key = std::env::var("APP_PROXY_KEY").unwrap_or_default();
    let mc = get_machine_code_internal(&user_data);
    RagIndex::new(RagIndexOpts {
        user_data_dir: user_data,
        proxy_host: None,
        proxy_key,
        machine_id: Some(mc),
    })
    .map_err(|e| e.to_string())
}

/// 构建 RAG 索引
#[tauri::command]
async fn rag_build_index(
    app: AppHandle,
    state: State<'_, RagState>,
    entries: Vec<FileEntry>,
) -> Result<serde_json::Value, String> {
    let rag = create_rag_index(&app)?;

    // 把 cancel_flag 共享到全局状态（短锁，不跨 await）
    {
        let mut guard = state.cancel_flag.lock().map_err(|e| e.to_string())?;
        *guard = Some(rag.cancel_flag.clone());
    }

    let progress_app = app.clone();
    let progress_cb: rag_index::ProgressCb = Arc::new(move |msg| {
        let _ = progress_app.emit("rag-progress", msg);
    });

    // 直接调用，不持有任何锁
    let result = rag
        .build_index(entries, Some(progress_cb))
        .await
        .map_err(|e| e.to_string())?;

    serde_json::to_value(result).map_err(|e| e.to_string())
}

/// RAG 搜索
#[tauri::command]
async fn rag_search(
    app: AppHandle,
    query: String,
    top_k: Option<usize>,
    tier: Option<String>,
) -> Result<serde_json::Value, String> {
    let rag = create_rag_index(&app)?;
    let opts = SearchOpts { top_k, tier };
    let result = rag.search(&query, opts).await.map_err(|e| e.to_string())?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

/// 获取 RAG 索引状态
#[tauri::command]
fn rag_status(app: AppHandle) -> Result<serde_json::Value, String> {
    let rag = create_rag_index(&app)?;
    let status = rag.get_status();
    serde_json::to_value(status).map_err(|e| e.to_string())
}

/// 取消 RAG 索引构建
#[tauri::command]
fn rag_cancel(state: State<'_, RagState>) -> Result<(), String> {
    let guard = state.cancel_flag.lock().map_err(|e| e.to_string())?;
    if let Some(flag) = guard.as_ref() {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 应用入口
// ---------------------------------------------------------------------------

/// 迁移旧 userData 目录数据（与 Electron 版兼容）
fn migrate_legacy_user_data(app: &AppHandle) {
    let canon = ensure_user_data(app);
    let canon_idb = canon.join("IndexedDB");
    let canon_has_data = canon_idb.exists()
        && fs::read_dir(&canon_idb)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false);

    if canon_has_data {
        return;
    }

    // 候选旧目录
    let candidates = [
        "xinjing",
        "XinJingDesktop",
        "xinjing-desktop",
        "xinjing-app",
        "XinJingApp",
        "xinjing-electron",
    ];
    let app_data_base = canon
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    let mut best: Option<PathBuf> = None;
    let mut best_size = 0usize;
    for c in &candidates {
        let p = app_data_base.join(c);
        if p == canon || !p.exists() {
            continue;
        }
        let idb = p.join("IndexedDB");
        if !idb.exists() {
            continue;
        }
        let size = fs::read_dir(&idb).map(|d| d.count()).unwrap_or(0);
        if size > best_size {
            best_size = size;
            best = Some(p);
        }
    }

    if let Some(src) = best {
        // 合并用户数据相关条目
        let items = ["IndexedDB", "Local Storage", "license.json", "machine.json", "trial.json"];
        for f in &items {
            let src_path = src.join(f);
            if !src_path.exists() {
                continue;
            }
            let dst_path = canon.join(f);
            if dst_path.exists() {
                continue;
            }
            let _ = copy_recursive(&src_path, &dst_path);
        }
        let _ = fs::write(
            canon.join("data-migrated.json"),
            format!(
                "{{\"from\":\"{}\",\"at\":\"{}\"}}",
                src.to_string_lossy(),
                Utc::now().to_rfc3339()
            ),
        );
        log::info!("[userData] 已从旧目录恢复数据: {}", src.display());
    }
}

/// 递归复制
fn copy_recursive(src: &PathBuf, dst: &PathBuf) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst)?;
    }
    Ok(())
}

/// 检查数据异常（本机曾有使用记录但标准目录 IndexedDB 为空）
fn check_data_anomaly(app: &AppHandle) {
    let canon = ensure_user_data(app);
    let canon_idb = canon.join("IndexedDB");
    let has_idb = canon_idb.exists()
        && fs::read_dir(&canon_idb)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false);
    let prior_use = canon.join("machine.json").exists()
        || canon.join("trial.json").exists()
        || canon.join("license.json").exists();
    let migrated = canon.join("data-migrated.json").exists();
    let flag = canon.join("data-anomaly.json");
    if prior_use && !has_idb && !migrated {
        let msg = format!(
            "{{\"at\":\"{}\",\"msg\":\"本机曾有使用记录但历史数据目录为空，可能数据丢失或落在其他目录\"}}",
            Utc::now().to_rfc3339()
        );
        let _ = fs::write(&flag, msg);
    } else if flag.exists() {
        let _ = fs::remove_file(&flag);
    }
}

/// Tauri 应用主入口（供 main.rs 调用）
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_secs()
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .manage(RagState::default())
        .setup(|app| {
            log::info!("[XinJing] 启动 Tauri v2 版本");

            // 迁移旧数据
            migrate_legacy_user_data(&app.handle());

            // 数据异常检测
            check_data_anomaly(&app.handle());

            // 启动时广播一次授权状态
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                emit_license_state(&app_handle);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            activate,
            cloud_activate,
            get_machine_code,
            encrypt_secret,
            decrypt_secret,
            save_backup_config,
            select_backup_folder,
            select_user_doc_folder,
            get_user_doc_folder,
            read_user_docs,
            read_user_doc_meta,
            read_user_doc_file,
            search_user_docs,
            open_external,
            check_for_updates,
            open_activation,
            close_decision,
            notify_migrate_done,
            activation_done,
            get_app_proxy_key,
            rag_build_index,
            rag_search,
            rag_status,
            rag_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
