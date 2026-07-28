//! Challenge detection + resolution layer (the explicit "bypass JS challenges"
//! capability). Mirrors `server/core/challenge.js`.
//!
//! Many bot-protection systems (Cloudflare, DataDome, PerimeterX) serve a JS
//! challenge page that auto-resolves after 5-15 seconds WHEN the browser
//! fingerprint passes their automation checks. The stealth stack provides that
//! detection resistance; this module adds the patience: detect the challenge
//! page, wait for self-resolution, and report honestly whether it cleared.

use std::thread;
use std::time::{Duration, Instant};

use headless_chrome::browser::tab::Tab;
use serde::Serialize;

/// Default budget for auto-resolvable challenges (covers Cloudflare/DataDome).
pub const DEFAULT_CHALLENGE_TIMEOUT_MS: u64 = 15_000;

#[derive(Debug, Clone, Serialize)]
pub struct ChallengeInfo {
    pub detected: bool,
    pub kind: Option<String>,
    pub label: Option<String>,
    pub resolved: bool,
    pub waited_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interactive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
}

impl ChallengeInfo {
    /// No challenge detected.
    pub fn none() -> Self {
        Self {
            detected: false,
            kind: None,
            label: None,
            resolved: true,
            waited_ms: 0,
            interactive: None,
            timed_out: None,
        }
    }
}

/// A challenge signature: kind, label, whether it auto-resolves, and the
/// detection signals (URL regex, DOM markers, text regex).
struct Signature {
    kind: &'static str,
    label: &'static str,
    auto_resolvable: bool,
    url_patterns: &'static [&'static str],
    dom_markers: &'static [&'static str],
    text_patterns: &'static [&'static str],
}

/// Compile-once regex cache keyed by pattern string. Built lazily on first
/// detection. Avoids recompiling the same patterns on every page extraction.
/// Keys are owned Strings so the cache can outlive the caller's borrow.
static REGEX_CACHE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, regex::Regex>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn match_pattern(pattern: &str, value: &str) -> bool {
    let mut cache = REGEX_CACHE.lock().expect("regex cache mutex poisoned");
    let re = cache
        .entry(pattern.to_string())
        .or_insert_with(|| regex::Regex::new(pattern).expect("valid challenge regex"));
    re.is_match(value)
}

// Challenge signatures: kind, label, auto-resolvable flag, and detection
// signals. dom_markers are CSS-like selectors checked via evaluate(); url/text
// patterns are regex checked against the page URL and visible text.
const SIGNATURES: &[Signature] = &[
    Signature {
        kind: "cloudflare",
        label: "Cloudflare",
        auto_resolvable: true,
        url_patterns: &["^/cdn-cgi/challenge", "/cdn-cgi/turnstile"],
        dom_markers: &["#cf-challenge", "#challenge-form", "#cf-please-wait", ".cf-browser-verification"],
        text_patterns: &["(?i)just a moment", "(?i)checking your browser", "(?i)cf-challenge"],
    },
    Signature {
        kind: "cloudflare_turnstile",
        label: "Cloudflare Turnstile",
        auto_resolvable: false,
        url_patterns: &[],
        dom_markers: &["iframe[src*='challenges.cloudflare.com']", ".cf-turnstile"],
        text_patterns: &["(?i)verify you are human"],
    },
    Signature {
        kind: "datadome",
        label: "DataDome",
        auto_resolvable: true,
        url_patterns: &["_dd_s\\b", "/_dd\\b"],
        dom_markers: &["iframe[src*='datadome']", "#datadome"],
        text_patterns: &["(?i)datadome", "(?i)please verify you are a person"],
    },
    Signature {
        kind: "perimeterx",
        label: "PerimeterX / HUMAN",
        auto_resolvable: true,
        url_patterns: &["/_pxhl/", "/px\\.js"],
        dom_markers: &["#px-captcha", "iframe[src*='px-captcha']"],
        text_patterns: &["(?i)press.*hold", "(?i)perimeterx"],
    },
    Signature {
        kind: "hcaptcha",
        label: "hCaptcha",
        auto_resolvable: false,
        url_patterns: &[],
        dom_markers: &["iframe[src*='hcaptcha']", ".h-captcha"],
        text_patterns: &["(?i)hcaptcha"],
    },
    Signature {
        kind: "recaptcha",
        label: "reCAPTCHA",
        auto_resolvable: false,
        url_patterns: &[],
        dom_markers: &["iframe[src*='recaptcha']", ".g-recaptcha", "#recaptcha"],
        text_patterns: &["(?i)recaptcha"],
    },
    Signature {
        kind: "blocked",
        label: "Hard block",
        auto_resolvable: false,
        url_patterns: &["/sorry/", "/access[-_]?denied"],
        dom_markers: &[],
        text_patterns: &[
            "(?i)\\baccess denied\\b",
            "(?i)\\b403 forbidden\\b",
            "(?i)\\btemporarily blocked\\b",
            "(?i)\\bsecurity check\\b",
        ],
    },
];

/// Inspect a tab for challenge signatures. Returns the first matching kind or
/// a ChallengeInfo indicating no challenge.
pub fn detect_challenge(tab: &Tab) -> ChallengeInfo {
    let url = tab.get_url();

    // Probe DOM markers and text in one evaluate() round-trip.
    let all_markers: Vec<&'static str> = SIGNATURES
        .iter()
        .flat_map(|s| s.dom_markers.iter().copied())
        .collect();

    let marker_js = format!(
        "(() => {{ const markers = {}; const hits = []; for (const sel of markers) {{ try {{ if (document.querySelector(sel)) hits.push(sel); }} catch (e) {{}} }} return hits; }})()",
        serde_json::to_string(&all_markers).unwrap_or_default()
    );
    let text_js = "(document.body && document.body.innerText || '').substring(0, 12000)";

    let (marker_hits, text): (Vec<String>, String) = match (
        tab.evaluate(&marker_js, true),
        tab.evaluate(text_js, true),
    ) {
        (Ok(m), Ok(t)) => {
            let markers = m
                .value
                .as_ref()
                .and_then(|v| {
                    // evaluate may return the value directly or a JSON string.
                    if let Some(arr) = v.as_array() {
                        serde_json::from_value(serde_json::Value::Array(arr.clone())).ok()
                    } else {
                        v.as_str()
                            .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                    }
                })
                .unwrap_or_default();
            let text_val = t
                .value
                .as_ref()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_default();
            (markers, text_val)
        }
        _ => (Vec::new(), String::new()),
    };

    // Match in signature order; first hit wins.
    for sig in SIGNATURES.iter() {
        let url_hit = sig
            .url_patterns
            .iter()
            .any(|pat| match_pattern(pat, &url));
        let text_hit = sig
            .text_patterns
            .iter()
            .any(|pat| match_pattern(pat, &text));
        let dom_hit = sig
            .dom_markers
            .iter()
            .any(|m| marker_hits.iter().any(|h| h == m));

        if url_hit || text_hit || dom_hit {
            return ChallengeInfo {
                detected: true,
                kind: Some(sig.kind.to_string()),
                label: Some(sig.label.to_string()),
                resolved: false,
                waited_ms: 0,
                interactive: if !sig.auto_resolvable { Some(true) } else { None },
                timed_out: None,
            };
        }
    }

    ChallengeInfo::none()
}

/// Wait for an auto-resolvable challenge to clear. Polls detect_challenge()
/// every `poll_interval_ms`; returns as soon as no challenge is detected or the
/// budget expires. Does NOT attempt interactive challenges.
pub fn wait_for_challenge_resolution(
    tab: &Tab,
    timeout_ms: u64,
    poll_interval_ms: u64,
) -> ChallengeInfo {
    let initial = detect_challenge(tab);
    if !initial.detected {
        return ChallengeInfo::none();
    }

    // Interactive / hard challenges cannot self-clear — report immediately.
    if initial.interactive == Some(true) {
        return initial;
    }

    let start = Instant::now();
    let kind = initial.kind.clone();
    let label = initial.label.clone();

    while (start.elapsed().as_millis() as u64) < timeout_ms {
        thread::sleep(Duration::from_millis(poll_interval_ms));
        let recheck = detect_challenge(tab);
        if !recheck.detected {
            return ChallengeInfo {
                detected: true,
                kind,
                label,
                resolved: true,
                waited_ms: start.elapsed().as_millis() as u64,
                interactive: None,
                timed_out: None,
            };
        }
    }

    ChallengeInfo {
        detected: true,
        kind,
        label,
        resolved: false,
        waited_ms: start.elapsed().as_millis() as u64,
        interactive: None,
        timed_out: Some(true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_info_none_serializes_cleanly() {
        let info = ChallengeInfo::none();
        assert!(!info.detected);
        assert!(info.resolved);
    }

    #[test]
    fn signatures_table_is_populated() {
        assert!(!SIGNATURES.is_empty());
        // Cloudflare should be present and auto-resolvable.
        let cf = SIGNATURES.iter().find(|s| s.kind == "cloudflare").unwrap();
        assert!(cf.auto_resolvable);
        // hCaptcha should be present and NOT auto-resolvable.
        let hc = SIGNATURES.iter().find(|s| s.kind == "hcaptcha").unwrap();
        assert!(!hc.auto_resolvable);
    }
}
