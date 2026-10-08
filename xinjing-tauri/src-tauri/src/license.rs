//! license.rs — 心镜 XinJing 激活码核心（Rust 版，从 Node.js license-core.js 迁移）
//!
//! 纯离线方案：HMAC-SHA256 签名，不依赖任何服务器。
//!
//! 码结构（base32，RFC4648，无填充）：
//!   XJ-XXXX-XXXX-...
//!   解码后明文 = identity + "\n" + sig(前32位十六进制)
//!   - 旧格式（无机器码绑定，终身）：identity \n sig
//!   - 新格式（机器码绑定 + 有效期）：identity \n machineCode \n expiresAt \n sig
//!
//! sig = HMAC-SHA256(SECRET, identity).hex().slice(0, 32)
//! 机器码绑定：sig = HMAC-SHA256(SECRET, id + "|" + mc + "|" + expiresAt).hex().slice(0, 32)

use base32::Alphabet;
use hmac::{Hmac, Mac};
use sha2::Sha256;

/// 基础试用天数
pub const TRIAL_DAYS: i64 = 90;
/// AI 助手 / AI 督导 免费试用天数
/// 与 90 天基础试用相互独立：0~60 天 AI 免费 + 基础可用；60 天后 AI 锁定；90 天后基础受限。
pub const AI_TRIAL_DAYS: i64 = 60;
/// 一天的毫秒数（86400000）
const DAY_MS: i64 = 86_400_000;

/// 付费分层（Freemium）：
///   pro    = 标准付费版（解锁 AI 助手 / 多位置备份等拓展功能）
///   custom = 定制旗舰版（在 pro 基础上叠加定制功能）
///   full   = 旧激活码（无 tier 前缀，祖父条款，权益等同 pro）
///   free   = 未激活（基础功能免费，AI 助手锁定）
pub const PAID_TIERS: &[&str] = &["pro", "custom", "full"];

type HmacSha256 = Hmac<Sha256>;

// ---------------------------------------------------------------------------
// 结构体定义
// ---------------------------------------------------------------------------

/// 激活码校验结果
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VerifyResult {
    /// 是否有效（签名正确 + 机器码匹配）
    pub valid: bool,
    /// 用户标识（去掉 tier 前缀后的展示标识）
    pub identity: String,
    /// 付费层级：free / full / pro / custom
    pub tier: String,
    /// 码内嵌入的机器码
    pub machine_code: String,
    /// 机器码是否匹配（码内为空视为匹配）
    pub machine_match: bool,
    /// 过期时间戳（毫秒，0 = 终身）
    pub expires_at: i64,
    /// 是否已过期
    pub expired: bool,
}

/// 校验失败时返回的空结果（与 JS 端 empty 对象保持一致）
impl Default for VerifyResult {
    fn default() -> Self {
        VerifyResult {
            valid: false,
            identity: String::new(),
            tier: "free".to_string(),
            machine_code: String::new(),
            machine_match: true,
            expires_at: 0,
            expired: false,
        }
    }
}

/// 许可证综合状态（结合校验结果与试用状态计算得出）
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct LicenseState {
    /// 当前模式：full / trial / limited
    pub mode: String,
    /// 基础试用剩余天数
    pub days_left: i64,
    /// 用户标识
    pub identity: String,
    /// 付费层级
    pub tier: String,
    /// AI 功能是否解锁（激活且 tier 为付费层，或 AI 试用有效期内）
    pub ai_unlocked: bool,
    /// AI 试用是否激活
    pub ai_trial_active: bool,
    /// AI 试用剩余天数
    pub ai_trial_days_left: i64,
    /// AI 试用总天数
    pub ai_trial_days: i64,
    /// 激活码是否已过期
    pub expired: bool,
    /// 过期时间戳（毫秒，0 = 终身）
    pub expires_at: i64,
}

// ---------------------------------------------------------------------------
// 内部工具函数
// ---------------------------------------------------------------------------

/// 从环境变量读取主密钥
fn secret() -> String {
    std::env::var("LICENSE_SECRET").unwrap_or_default()
}

/// 计算 HMAC-SHA256 并返回完整十六进制字符串（64 字符）
fn hmac_hex(data: &str) -> String {
    let secret = secret();
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC 接受任意长度密钥，不会失败");
    mac.update(data.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// 清理激活码输入：转大写 → 仅保留 base32 字符（A-Z, 2-7）→ 去掉 "XJ" 前缀
/// X/J 本身是合法 base32 字符，故先整体过滤再去前缀
fn clean_key_input(key: &str) -> String {
    let filtered: String = key
        .to_uppercase()
        .chars()
        .filter(|c| matches!(c, 'A'..='Z' | '2'..='7'))
        .collect();
    if let Some(stripped) = filtered.strip_prefix("XJ") {
        stripped.to_string()
    } else {
        filtered
    }
}

/// 将 base32 字符串按每 4 个字符一组，用 '-' 连接
fn group_by_4(s: &str) -> String {
    let mut result = String::with_capacity(s.len() + s.len() / 4);
    for (i, c) in s.chars().enumerate() {
        if i > 0 && i % 4 == 0 {
            result.push('-');
        }
        result.push(c);
    }
    result
}

/// base32 编码（RFC4648，无填充）
fn base32_encode(data: &[u8]) -> String {
    base32::encode(Alphabet::Rfc4648 { padding: false }, data)
}

/// base32 解码（RFC4648，无填充，输入需为大写纯 base32 字符）
fn base32_decode(text: &str) -> Option<Vec<u8>> {
    base32::decode(Alphabet::Rfc4648 { padding: false }, text)
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/// 从 identity 字符串解析 tier
/// - 空 → "free"
/// - 无 ':' 前缀 → "full"（旧激活码无前缀 = 完整解锁，祖父条款）
/// - "pro:" / "custom:" 前缀（大小写不敏感）→ 对应 tier
/// - 未知前缀 → "full"
pub fn parse_tier(identity: &str) -> &'static str {
    if identity.is_empty() {
        return "free";
    }
    match identity.find(':') {
        None => "full",
        Some(idx) => {
            let t = &identity[..idx];
            if t.eq_ignore_ascii_case("pro") {
                "pro"
            } else if t.eq_ignore_ascii_case("custom") {
                "custom"
            } else {
                "full" // 未知前缀按旧版完整解锁处理
            }
        }
    }
}

/// 拆分 tier 与真实展示标识（去掉 tier 前缀）
/// 返回 (tier, identity)
/// - 空 → ("free", "")
/// - 无 ':' → ("full", identity)
/// - "pro:" / "custom:" 前缀 → (前缀, 去前缀后的 identity)
/// - 未知前缀 → ("full", identity)
pub fn split_identity(identity: &str) -> (&'static str, String) {
    if identity.is_empty() {
        return ("free", String::new());
    }
    match identity.find(':') {
        None => ("full", identity.to_string()),
        Some(idx) => {
            let t = &identity[..idx];
            if t.eq_ignore_ascii_case("pro") {
                ("pro", identity[idx + 1..].to_string())
            } else if t.eq_ignore_ascii_case("custom") {
                ("custom", identity[idx + 1..].to_string())
            } else {
                ("full", identity.to_string())
            }
        }
    }
}

/// 编码激活码
///
/// - `identity`: 用户标识（邮箱/姓名），自动截断至 64 字符
/// - `tier`: 付费层级 "pro" / "custom"（其他值视为旧完整版，不编码前缀）
/// - `machine_code`: 机器码，为空 → 旧格式（终身，向后兼容）
/// - `expires_at`: 过期时间戳（毫秒），0 或负数 = 终身
///
/// 返回格式：XJ-XXXX-XXXX-...
pub fn encode_key(identity: &str, tier: &str, machine_code: &str, expires_at: i64) -> String {
    // 截断 identity 至 64 字符
    let id: String = identity.trim().chars().take(64).collect();
    if id.is_empty() {
        panic!("身份标识不能为空");
    }

    // 将 tier 编码进 identity 前缀
    let t = tier.to_lowercase();
    let id_with_tier = if t == "pro" || t == "custom" {
        format!("{}:{}", t, id)
    } else {
        id
    };

    let mc = machine_code.trim();
    let exp = if expires_at > 0 { expires_at } else { 0 }; // 0 = 终身

    let raw = if mc.is_empty() {
        // 旧格式（无机器码绑定），终身，保持向后兼容
        // sig = HMAC-SHA256(SECRET, identity).hex().slice(0, 32)
        let sig = &hmac_hex(&id_with_tier)[..32];
        format!("{}\n{}", id_with_tier, sig)
    } else {
        // 机器码绑定格式（含有效期）
        // sig = HMAC-SHA256(SECRET, id + "|" + mc + "|" + expiresAt).hex().slice(0, 32)
        let sig_input = format!("{}|{}|{}", id_with_tier, mc, exp);
        let sig = &hmac_hex(&sig_input)[..32];
        format!("{}\n{}\n{}\n{}", id_with_tier, mc, exp, sig)
    };

    // base32 编码后按每 4 字符分组，加 "XJ-" 前缀
    let encoded = base32_encode(raw.as_bytes());
    format!("XJ-{}", group_by_4(&encoded))
}

/// 校验激活码
///
/// - `key`: 激活码字符串（XJ-XXXX-XXXX-...）
/// - `machine_code`: 当前机器码（用于绑定校验，码内机器码为空则不校验）
///
/// 返回 VerifyResult，任何异常均返回默认空结果（valid=false）
pub fn verify_key(key: &str, machine_code: &str) -> VerifyResult {
    let empty = VerifyResult::default();

    // 1. 清理输入
    let clean = clean_key_input(key);
    if clean.is_empty() {
        return empty;
    }

    // 2. base32 解码
    let decoded = match base32_decode(&clean) {
        Some(d) => d,
        None => return empty,
    };

    // 3. UTF-8 解码
    let text = match String::from_utf8(decoded) {
        Ok(s) => s,
        Err(_) => return empty,
    };

    // 4. 按换行符拆分
    let parts: Vec<&str> = text.split('\n').collect();
    let raw_identity = parts[0];
    if raw_identity.is_empty() {
        return empty;
    }
    // 至少需要 identity + sig 两段
    if parts.len() < 2 {
        return empty;
    }

    // 5. 根据段数判定格式，提取机器码、有效期、签名
    //    parts.len() >= 4: 新格式 id \n mc \n expiresAt \n sig
    //    parts.len() == 3: 旧机器码格式（无有效期，终身）id \n mc \n sig
    //    parts.len() == 2: 旧无机器码格式（终身）id \n sig
    let embedded_mc: &str = if parts.len() >= 3 { parts[1] } else { "" };
    let (expires_at, sig) = if parts.len() >= 4 {
        let exp: i64 = parts[2].parse().unwrap_or(0);
        (exp, parts[3])
    } else if parts.len() == 3 {
        (0, parts[2])
    } else {
        (0, parts[1])
    };

    if sig.is_empty() {
        return empty;
    }

    // 6. 验证签名（不同格式使用不同的 HMAC 输入）
    let valid_sig = if parts.len() >= 4 {
        let sig_input = format!("{}|{}|{}", raw_identity, embedded_mc, expires_at);
        sig == &hmac_hex(&sig_input)[..32]
    } else if parts.len() == 3 {
        let sig_input = format!("{}|{}", raw_identity, embedded_mc);
        sig == &hmac_hex(&sig_input)[..32]
    } else {
        sig == &hmac_hex(raw_identity)[..32]
    };

    // 7. 机器码匹配校验（码内为空视为匹配）
    let current_mc = machine_code.trim();
    let machine_match = embedded_mc.is_empty() || embedded_mc == current_mc;

    // 8. 有效期检查
    let now = chrono::Utc::now().timestamp_millis();
    let expired = expires_at != 0 && now > expires_at;

    // 9. 组装结果
    let valid = valid_sig && machine_match;
    let (tier, identity) = split_identity(raw_identity);

    VerifyResult {
        valid,
        identity,
        tier: if valid_sig { tier.to_string() } else { "free".to_string() },
        machine_code: embedded_mc.to_string(),
        machine_match,
        expires_at,
        expired,
    }
}

/// 计算基础试用状态
///
/// - `first_launch_ts`: 首次启动时间戳（毫秒）
/// - `now_ts`: 当前时间戳（毫秒）
///
/// 返回 (状态, 剩余天数)：状态为 "active" 或 "expired"
pub fn trial_status(first_launch_ts: i64, now_ts: i64) -> (&'static str, i64) {
    // 使用 div_euclid 等价于 Math.floor（处理负数时也向下取整）
    let days_passed = (now_ts - first_launch_ts).div_euclid(DAY_MS);
    let days_left = TRIAL_DAYS - days_passed;
    if days_left > 0 {
        ("active", days_left)
    } else {
        ("expired", 0)
    }
}

/// 计算 AI 免费试用状态
///
/// 基于真正的首次安装时间（跨重装稳定）
///
/// - `first_install_ts`: 首次安装时间戳（毫秒）
/// - `now_ts`: 当前时间戳（毫秒）
///
/// 返回 (是否激活, 剩余天数)
pub fn ai_trial_status(first_install_ts: i64, now_ts: i64) -> (bool, i64) {
    let days_passed = (now_ts - first_install_ts).div_euclid(DAY_MS);
    let days_left = AI_TRIAL_DAYS - days_passed;
    if days_left > 0 {
        (true, days_left)
    } else {
        (false, 0)
    }
}

/// 计算整体运行模式
///
/// - `activated`: 是否已激活（激活码校验通过）
/// - `trial_state`: 试用状态字符串（"active" / "expired"）
///
/// 返回 "full" / "trial" / "limited"
pub fn overall_mode(activated: bool, trial_state: &str) -> &'static str {
    if activated {
        "full"
    } else if trial_state == "active" {
        "trial"
    } else {
        "limited"
    }
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 旧格式（无机器码绑定，终身）编解码往返测试
    #[test]
    fn test_encode_decode_legacy() {
        let key = encode_key("test@example.com", "", "", 0);
        assert!(key.starts_with("XJ-"));
        let result = verify_key(&key, "");
        assert!(result.valid);
        assert_eq!(result.identity, "test@example.com");
        assert_eq!(result.tier, "full");
        assert_eq!(result.machine_code, "");
        assert!(result.machine_match);
        assert_eq!(result.expires_at, 0);
        assert!(!result.expired);
    }

    /// 新格式（机器码绑定 + 有效期）编解码往返测试
    #[test]
    fn test_encode_decode_bound() {
        let mc = "MACHINE-1234";
        let exp = chrono::Utc::now().timestamp_millis() + 365 * DAY_MS; // 一年后
        let key = encode_key("user@example.com", "pro", mc, exp);
        let result = verify_key(&key, mc);
        assert!(result.valid);
        assert_eq!(result.identity, "user@example.com");
        assert_eq!(result.tier, "pro");
        assert_eq!(result.machine_code, mc);
        assert!(result.machine_match);
        assert_eq!(result.expires_at, exp);
        assert!(!result.expired);
    }

    /// 机器码不匹配应返回 valid=false
    #[test]
    fn test_machine_mismatch() {
        let mc = "CORRECT-MC";
        let key = encode_key("user@example.com", "pro", mc, 0);
        let result = verify_key(&key, "WRONG-MC");
        assert!(!result.valid);
        assert!(!result.machine_match);
    }

    /// 过期检查
    #[test]
    fn test_expired() {
        let mc = "MC-EXPIRED";
        let past = 1_000_000; // 1970 年的时间戳，必然过期
        let key = encode_key("user@example.com", "pro", mc, past);
        let result = verify_key(&key, mc);
        assert!(result.valid); // 签名和机器码都对
        assert!(result.expired); // 但已过期
    }

    /// tier 解析
    #[test]
    fn test_parse_tier() {
        assert_eq!(parse_tier(""), "free");
        assert_eq!(parse_tier("plain@email.com"), "full");
        assert_eq!(parse_tier("pro:user@email.com"), "pro");
        assert_eq!(parse_tier("custom:clinic@x.com"), "custom");
        assert_eq!(parse_tier("unknown:user"), "full");
        assert_eq!(parse_tier("PRO:upper"), "pro"); // 大小写不敏感
    }

    /// identity 拆分
    #[test]
    fn test_split_identity() {
        assert_eq!(split_identity(""), ("free", "".to_string()));
        assert_eq!(split_identity("plain"), ("full", "plain".to_string()));
        assert_eq!(split_identity("pro:user"), ("pro", "user".to_string()));
        assert_eq!(
            split_identity("custom:clinic"),
            ("custom", "clinic".to_string())
        );
        assert_eq!(
            split_identity("unknown:user"),
            ("full", "unknown:user".to_string())
        );
    }

    /// 试用状态
    #[test]
    fn test_trial_status() {
        let now = 10_000_000_000_000; // 固定时间点
        // 刚启动：90 天剩余
        assert_eq!(trial_status(now, now), ("active", 90));
        // 30 天后：60 天剩余
        assert_eq!(trial_status(now, now + 30 * DAY_MS), ("active", 60));
        // 90 天后：过期
        assert_eq!(trial_status(now, now + 90 * DAY_MS), ("expired", 0));
        // 100 天后：过期
        assert_eq!(trial_status(now, now + 100 * DAY_MS), ("expired", 0));
    }

    /// AI 试用状态
    #[test]
    fn test_ai_trial_status() {
        let now = 10_000_000_000_000;
        assert_eq!(ai_trial_status(now, now), (true, 60));
        assert_eq!(ai_trial_status(now, now + 59 * DAY_MS), (true, 1));
        assert_eq!(ai_trial_status(now, now + 60 * DAY_MS), (false, 0));
        assert_eq!(ai_trial_status(now, now + 100 * DAY_MS), (false, 0));
    }

    /// 整体模式
    #[test]
    fn test_overall_mode() {
        assert_eq!(overall_mode(true, "active"), "full");
        assert_eq!(overall_mode(true, "expired"), "full");
        assert_eq!(overall_mode(false, "active"), "trial");
        assert_eq!(overall_mode(false, "expired"), "limited");
    }

    /// 篡改的激活码应校验失败
    #[test]
    fn test_tampered_key() {
        let key = encode_key("test@example.com", "", "", 0);
        // 修改 "XJ-" 之后的第一个数据字符（修改末尾字符可能不影响解码结果，
        // 因为 base32 最后一个字符可能包含未使用的填充位）
        let mut chars: Vec<char> = key.chars().collect();
        assert!(chars.len() > 4, "key too short for tamper test");
        let target = 3; // "XJ-" 之后的第一个字符
        chars[target] = if chars[target] == 'A' { 'B' } else { 'A' };
        let tampered: String = chars.into_iter().collect();
        let result = verify_key(&tampered, "");
        assert!(!result.valid);
    }

    /// 旧格式码无机器码绑定，任何机器码都应通过
    #[test]
    fn test_legacy_any_machine() {
        let key = encode_key("legacy@user.com", "", "", 0);
        let result = verify_key(&key, "ANY-MACHINE-CODE");
        assert!(result.valid);
        assert!(result.machine_match);
    }
}
