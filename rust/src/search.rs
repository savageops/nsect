use url::Url;

// Future engine candidates (backlog, not implemented yet):
// - yahoo
// - yandex
// - startpage
// - ecosia
// - qwant
// - mojeek
// - kagi
// Keep `google` as the final fallback attempt when new engines are added.
pub const SUPPORTED_SEARCH_ENGINES: &[&str] = &["duckduckgo", "bing", "brave", "google"];
pub const DEFAULT_SEARCH_ENGINES: &[&str] = &["duckduckgo", "bing", "brave", "google"];

const BLOCK_PATTERNS: &[&str] = &[
    "captcha",
    "unusual traffic",
    "not a robot",
    "automated queries",
    "verify you are human",
    "access denied",
    "temporarily blocked",
    "security check",
];

pub fn enforce_google_last(engines: Vec<String>) -> Vec<String> {
    let mut seen = Vec::new();
    for engine in engines {
        if !seen.iter().any(|existing| existing == &engine) {
            seen.push(engine);
        }
    }
    let mut without_google = seen
        .into_iter()
        .filter(|engine| engine != "google")
        .collect::<Vec<_>>();
    without_google.push("google".to_string());
    without_google
}

pub fn normalize_search_engines(value: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let engines = value.unwrap_or_else(|| {
        DEFAULT_SEARCH_ENGINES
            .iter()
            .map(|engine| (*engine).to_string())
            .collect()
    });

    if engines.is_empty() {
        return Err("'searchEngines' cannot be empty".to_string());
    }

    let normalized = engines
        .into_iter()
        .map(|engine| engine.trim().to_lowercase())
        .filter(|engine| !engine.is_empty())
        .collect::<Vec<_>>();

    if normalized.is_empty() {
        return Err("'searchEngines' cannot be empty".to_string());
    }

    for engine in &normalized {
        if !SUPPORTED_SEARCH_ENGINES
            .iter()
            .any(|candidate| candidate == engine)
        {
            return Err(format!(
                "'searchEngines' contains unsupported engine '{}'. Valid: {}",
                engine,
                SUPPORTED_SEARCH_ENGINES.join(", ")
            ));
        }
    }

    Ok(enforce_google_last(normalized))
}

pub fn build_search_url(engine: &str, query: &str, count: u32) -> Result<String, String> {
    let encoded = encode(query);
    match engine {
        "duckduckgo" => Ok(format!("https://html.duckduckgo.com/html/?q={encoded}")),
        "bing" => Ok(format!(
            "https://www.bing.com/search?q={encoded}&count={count}&setlang=en-US"
        )),
        "brave" => Ok(format!(
            "https://search.brave.com/search?q={encoded}&source=web"
        )),
        "google" => Ok(format!(
            "https://www.google.com/search?q={encoded}&num={count}&hl=en"
        )),
        _ => Err(format!("Unknown search engine '{engine}'")),
    }
}

pub fn search_engine_label(engine: &str) -> String {
    match engine {
        "duckduckgo" => "DuckDuckGo",
        "bing" => "Bing",
        "brave" => "Brave Search",
        "google" => "Google",
        _ => engine,
    }
    .to_string()
}

pub fn decode_search_result_url(engine: &str, raw_url: &str) -> String {
    let Ok(parsed) = Url::parse(raw_url) else {
        return raw_url.to_string();
    };

    if engine == "duckduckgo"
        && parsed
            .host_str()
            .unwrap_or_default()
            .ends_with("duckduckgo.com")
        && parsed.path() == "/l/"
    {
        if let Some(uddg) = parsed.query_pairs().find(|(key, _)| key == "uddg") {
            return uddg.1.to_string();
        }
    }

    if engine == "google" && parsed.path() == "/url" {
        if let Some(q) = parsed.query_pairs().find(|(key, _)| key == "q") {
            return q.1.to_string();
        }
    }

    raw_url.to_string()
}

pub fn is_search_blocked(engine: &str, url: &str, title: &str, text: &str) -> bool {
    if engine == "google" && url.to_lowercase().contains("/sorry/") {
        return true;
    }

    let source = format!("{url}\n{title}\n{text}").to_lowercase();
    BLOCK_PATTERNS
        .iter()
        .any(|pattern| source.contains(pattern))
}

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forces_google_last() {
        let normalized = normalize_search_engines(Some(vec![
            "google".to_string(),
            "duckduckgo".to_string(),
            "bing".to_string(),
        ]))
        .unwrap();
        assert_eq!(normalized, vec!["duckduckgo", "bing", "google"]);
    }

    #[test]
    fn decodes_duckduckgo_redirects() {
        let decoded = decode_search_result_url(
            "duckduckgo",
            "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com",
        );
        assert_eq!(decoded, "https://example.com");
    }

    #[test]
    fn decodes_google_redirects() {
        let decoded = decode_search_result_url(
            "google",
            "https://www.google.com/url?q=https://example.com/page&sa=U",
        );
        assert_eq!(decoded, "https://example.com/page");
    }

    #[test]
    fn passthrough_for_non_redirect_urls() {
        let url = "https://example.com/direct";
        assert_eq!(decode_search_result_url("google", url), url);
        assert_eq!(decode_search_result_url("duckduckgo", url), url);
        assert_eq!(decode_search_result_url("bing", url), url);
    }

    #[test]
    fn normalize_defaults_when_none() {
        let engines = normalize_search_engines(None).unwrap();
        assert_eq!(engines, vec!["duckduckgo", "bing", "brave", "google"]);
    }

    #[test]
    fn normalize_rejects_empty() {
        assert!(normalize_search_engines(Some(vec![])).is_err());
    }

    #[test]
    fn normalize_rejects_unknown_engine() {
        let result = normalize_search_engines(Some(vec!["yahoo".to_string()]));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unsupported engine"));
    }

    #[test]
    fn normalize_lowercases_and_trims() {
        let engines = normalize_search_engines(Some(vec!["  DUCKDUCKGO  ".to_string()])).unwrap();
        // google is always appended last
        assert_eq!(engines, vec!["duckduckgo", "google"]);
    }

    #[test]
    fn normalize_deduplicates() {
        let engines = normalize_search_engines(Some(vec![
            "bing".to_string(),
            "bing".to_string(),
        ]))
        .unwrap();
        // google is forced last, so dedup'd bing + appended google
        assert_eq!(engines, vec!["bing", "google"]);
    }

    #[test]
    fn build_url_for_each_engine() {
        assert!(build_search_url("duckduckgo", "test query", 10).unwrap().contains("html.duckduckgo.com"));
        assert!(build_search_url("bing", "test", 10).unwrap().contains("bing.com"));
        assert!(build_search_url("brave", "test", 10).unwrap().contains("search.brave.com"));
        assert!(build_search_url("google", "test", 10).unwrap().contains("google.com"));
    }

    #[test]
    fn build_url_rejects_unknown_engine() {
        assert!(build_search_url("yahoo", "test", 10).is_err());
    }

    #[test]
    fn build_url_url_encodes_query() {
        let url = build_search_url("google", "rust & wasm", 5).unwrap();
        // The & should be encoded so it's not interpreted as a query param separator
        assert!(!url.contains("& wasm"));
    }

    #[test]
    fn search_engine_labels() {
        assert_eq!(search_engine_label("duckduckgo"), "DuckDuckGo");
        assert_eq!(search_engine_label("bing"), "Bing");
        assert_eq!(search_engine_label("brave"), "Brave Search");
        assert_eq!(search_engine_label("google"), "Google");
        assert_eq!(search_engine_label("unknown"), "unknown");
    }

    #[test]
    fn is_search_blocked_detects_captcha() {
        assert!(is_search_blocked("google", "https://google.com", "", "please complete the captcha"));
    }

    #[test]
    fn is_search_blocked_detects_google_sorry() {
        assert!(is_search_blocked("google", "https://google.com/sorry/index", "", ""));
    }

    #[test]
    fn is_search_blocked_detects_unusual_traffic() {
        assert!(is_search_blocked("google", "", "", "Our systems have detected unusual traffic"));
    }

    #[test]
    fn is_search_blocked_passes_clean_content() {
        assert!(!is_search_blocked("duckduckgo", "https://duckduckgo.com", "Search Results", "Normal results page content"));
    }

    #[test]
    fn is_search_blocked_case_insensitive() {
        assert!(is_search_blocked("bing", "", "", "ACCESS DENIED"));
        assert!(is_search_blocked("bing", "", "", "Security Check"));
    }

    #[test]
    fn enforce_google_last_preserves_order() {
        let result = enforce_google_last(vec!["brave".to_string(), "duckduckgo".to_string(), "google".to_string()]);
        assert_eq!(result, vec!["brave", "duckduckgo", "google"]);
    }

    #[test]
    fn enforce_google_last_deduplicates() {
        let result = enforce_google_last(vec![
            "google".to_string(),
            "google".to_string(),
            "bing".to_string(),
        ]);
        assert_eq!(result, vec!["bing", "google"]);
    }
}
