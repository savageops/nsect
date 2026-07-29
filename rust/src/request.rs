use std::{collections::BTreeMap, path::PathBuf};

use headless_chrome::protocol::cdp::Network::CookieParam;
use serde::Deserialize;
use thiserror::Error;

use crate::{
    fingerprint::{SUPPORTED_FORMATS, SUPPORTED_METHODS},
    search::normalize_search_engines,
};

const DEFAULT_TIMEOUT: i64 = 30;
const DEFAULT_RENDER_WAIT: i64 = 0;
const DEFAULT_CHALLENGE_TIMEOUT: i64 = 15;
const DEFAULT_SCROLL_COUNT: i64 = 20;
const DEFAULT_SCROLL_DELAY: i64 = 800;
const DEFAULT_DELAY: i64 = 1000;
const DEFAULT_MAX_RESULTS: i64 = 10;

/// Canonical extraction strategies. `method` is a legacy alias mapped onto
/// these for backward compatibility; `strategy` is the canonical name.
pub const STRATEGIES: &[&str] = &["auto", "fast", "patient", "spa", "scroll"];

/// Map a legacy `method` value to the canonical strategy.
fn method_to_strategy(method: &str) -> &'static str {
    match method {
        "direct" => "fast",
        "wait" | "timed" => "patient",
        "spa" => "spa",
        "scroll" => "scroll",
        _ => "auto",
    }
}

#[derive(Debug, Clone, Copy)]
pub struct EngineNormalizationOptions {
    pub allow_file_output: bool,
    pub allow_headful: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum StringListInput {
    One(String),
    Many(Vec<String>),
}

impl StringListInput {
    fn into_vec(self) -> Vec<String> {
        match self {
            Self::One(value) => value
                .split(',')
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .map(str::to_string)
                .collect(),
            Self::Many(values) => values,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum HeadersInput {
    Json(BTreeMap<String, String>),
    String(String),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum CookiesInput {
    Json(Vec<CookieParam>),
    String(String),
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct EngineRequestInput {
    pub url: Option<String>,
    pub google: Option<String>,
    pub query: Option<String>,
    pub strategy: Option<String>,
    pub method: Option<String>,
    pub format: Option<String>,
    pub verbose: Option<bool>,
    pub selector: Option<String>,
    pub timeout: Option<i64>,
    #[serde(rename = "renderWait", alias = "render_wait")]
    pub render_wait: Option<i64>,
    #[serde(rename = "challengeTimeout", alias = "challenge_timeout")]
    pub challenge_timeout: Option<i64>,
    #[serde(rename = "bypassChallenges", alias = "bypass_challenges")]
    pub bypass_challenges: Option<bool>,
    #[serde(rename = "scrollCount", alias = "scroll_count")]
    pub scroll_count: Option<i64>,
    #[serde(rename = "scrollDelay", alias = "scroll_delay")]
    pub scroll_delay: Option<i64>,
    pub delay: Option<i64>,
    #[serde(rename = "maxResults", alias = "max_results", alias = "googleCount", alias = "google_count")]
    pub max_results: Option<i64>,
    #[serde(rename = "searchEngines", alias = "search_engines")]
    pub search_engines: Option<StringListInput>,
    pub engines: Option<StringListInput>,
    pub proxy: Option<String>,
    pub cookies: Option<CookiesInput>,
    pub headers: Option<HeadersInput>,
    #[serde(rename = "listLinks", alias = "list-links")]
    pub list_links: Option<bool>,
    #[serde(rename = "screenshotPath")]
    pub screenshot_path: Option<String>,
    pub screenshot: Option<String>,
    #[serde(rename = "pdfPath")]
    pub pdf_path: Option<String>,
    pub pdf: Option<String>,
    pub headless: Option<bool>,
    #[serde(rename = "no-headless")]
    pub no_headless: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct NormalizedEngineRequest {
    pub url: Option<String>,
    pub query: Option<String>,
    /// Canonical extraction strategy (auto/fast/patient/spa/scroll).
    pub strategy: String,
    /// Legacy alias of strategy, kept for output compatibility.
    pub method: String,
    pub format: String,
    pub verbose: bool,
    pub selector: Option<String>,
    pub timeout: u64,
    pub render_wait: u64,
    pub challenge_timeout: u64,
    pub bypass_challenges: bool,
    pub scroll_count: u32,
    pub scroll_delay: u64,
    pub delay: u64,
    pub max_results: u32,
    pub search_engines: Vec<String>,
    pub proxy: Option<String>,
    pub cookies: Vec<CookieParam>,
    pub headers: BTreeMap<String, String>,
    pub list_links: bool,
    pub screenshot_path: Option<PathBuf>,
    pub pdf_path: Option<PathBuf>,
    pub headless: bool,
    /// Optional solver config (threaded from AppState.config, not from HTTP input).
    /// When None or disabled, interactive challenges fail honestly.
    pub solver_config: Option<crate::config::SolverConfig>,
}

#[derive(Debug, Error, Clone)]
#[error("{message}")]
pub struct RequestValidationError {
    pub message: String,
    pub field: String,
}

pub fn normalize_engine_request(
    input: EngineRequestInput,
    options: EngineNormalizationOptions,
) -> Result<NormalizedEngineRequest, RequestValidationError> {
    let url = optional_string(input.url);
    let google = optional_string(input.google);
    let query = optional_string(input.query);

    if google.is_some() && query.is_some() && google != query {
        return Err(validation_error(
            "When both 'google' and 'query' are provided, they must match",
            "query",
        ));
    }

    let search_query = query.or(google);
    if url.is_none() && search_query.is_none() {
        return Err(validation_error(
            "Either --url or --google/--query is required.",
            "url",
        ));
    }

    if let Some(target_url) = url.as_deref() {
        assert_absolute_url(target_url)?;
    }

    let method_value = input.method.clone();
    let strategy = normalize_strategy(input.strategy, input.method)?;
    let selector = optional_string(input.selector);
    // Legacy `method=wait` without a selector is still a validation error.
    if search_query.is_none()
        && method_value.as_deref() == Some("wait")
        && selector.is_none()
    {
        return Err(validation_error(
            "method='wait' requires a non-empty 'selector'",
            "selector",
        ));
    }

    let search_engines = normalize_search_engines(
        input
            .search_engines
            .or(input.engines)
            .map(StringListInput::into_vec),
    )
    .map_err(|message| validation_error(&message, "searchEngines"))?;

    let screenshot_path = ensure_file_output_allowed(
        optional_string(input.screenshot_path).or(optional_string(input.screenshot)),
        "screenshot",
        options.allow_file_output,
    )?;
    let pdf_path = ensure_file_output_allowed(
        optional_string(input.pdf_path).or(optional_string(input.pdf)),
        "pdf",
        options.allow_file_output,
    )?;

    let requested_headless = if input.no_headless.unwrap_or(false) {
        false
    } else {
        input.headless.unwrap_or(true)
    };

    Ok(NormalizedEngineRequest {
        url,
        query: search_query.clone(),
        strategy: strategy.to_string(),
        method: strategy.to_string(),
        format: normalize_format(input.format)?,
        verbose: input.verbose.unwrap_or(false),
        selector,
        timeout: to_integer(input.timeout, "timeout", 1, 180, DEFAULT_TIMEOUT)? as u64,
        render_wait: to_integer(
            input.render_wait,
            "renderWait",
            0,
            120,
            DEFAULT_RENDER_WAIT,
        )? as u64,
        challenge_timeout: to_integer(
            input.challenge_timeout,
            "challengeTimeout",
            0,
            120,
            DEFAULT_CHALLENGE_TIMEOUT,
        )? as u64,
        bypass_challenges: input.bypass_challenges.unwrap_or(false),
        scroll_count: to_integer(
            input.scroll_count,
            "scrollCount",
            1,
            500,
            DEFAULT_SCROLL_COUNT,
        )? as u32,
        scroll_delay: to_integer(
            input.scroll_delay,
            "scrollDelay",
            50,
            10_000,
            DEFAULT_SCROLL_DELAY,
        )? as u64,
        delay: to_integer(input.delay, "delay", 0, 30_000, DEFAULT_DELAY)? as u64,
        max_results: to_integer(
            input.max_results,
            "maxResults",
            1,
            50,
            DEFAULT_MAX_RESULTS,
        )? as u32,
        search_engines,
        proxy: optional_string(input.proxy),
        cookies: parse_cookies(input.cookies)?,
        headers: parse_headers(input.headers)?,
        list_links: input.list_links.unwrap_or(false),
        screenshot_path: screenshot_path.map(PathBuf::from),
        pdf_path: pdf_path.map(PathBuf::from),
        headless: if options.allow_headful {
            requested_headless
        } else {
            true
        },
        solver_config: None,
    })
}

pub fn request_validation_to_http(error: &RequestValidationError) -> (u16, serde_json::Value) {
    (
        400,
        serde_json::json!({
            "error": error.message,
            "code": "VALIDATION_ERROR",
            "field": error.field,
        }),
    )
}

fn parse_headers(
    input: Option<HeadersInput>,
) -> Result<BTreeMap<String, String>, RequestValidationError> {
    let Some(headers) = input else {
        return Ok(BTreeMap::new());
    };

    match headers {
        HeadersInput::Json(value) => Ok(value),
        HeadersInput::String(value) => serde_json::from_str::<BTreeMap<String, String>>(&value)
            .map_err(|_| {
                validation_error(
                    "'headers' must be valid JSON when provided as a string",
                    "headers",
                )
            }),
    }
}

fn parse_cookies(input: Option<CookiesInput>) -> Result<Vec<CookieParam>, RequestValidationError> {
    let Some(cookies) = input else {
        return Ok(Vec::new());
    };

    match cookies {
        CookiesInput::Json(value) => Ok(value),
        CookiesInput::String(value) => {
            serde_json::from_str::<Vec<CookieParam>>(&value).map_err(|_| {
                validation_error(
                    "'cookies' must be valid JSON when provided as a string",
                    "cookies",
                )
            })
        }
    }
}

/// Normalize the extraction strategy. Accepts the canonical `strategy` field
/// or the legacy `method` field (mapped to its strategy equivalent). Collapses
/// the old 5-method decision tree into one concept with a smart `auto` default.
fn normalize_strategy(
    strategy_value: Option<String>,
    method_value: Option<String>,
) -> Result<&'static str, RequestValidationError> {
    if let Some(strategy) = optional_string(strategy_value) {
        if STRATEGIES.iter().any(|candidate| *candidate == strategy.as_str()) {
            // SAFETY: matched against STRATEGIES, so leak the static slice.
            return Ok(STRATEGIES
                .iter()
                .copied()
                .find(|candidate| *candidate == strategy.as_str())
                .unwrap_or("auto"));
        }
        return Err(validation_error(
            &format!("Unknown strategy. Valid: {}", STRATEGIES.join(", ")),
            "strategy",
        ));
    }

    if let Some(method) = optional_string(method_value) {
        if SUPPORTED_METHODS
            .iter()
            .any(|candidate| *candidate == method.as_str())
        {
            return Ok(method_to_strategy(&method));
        }
        return Err(validation_error(
            &format!("Unknown method. Valid: {}", SUPPORTED_METHODS.join(", ")),
            "method",
        ));
    }

    Ok("auto")
}

fn normalize_format(value: Option<String>) -> Result<String, RequestValidationError> {
    let format = optional_string(value).unwrap_or_else(|| "text".to_string());
    if SUPPORTED_FORMATS
        .iter()
        .any(|candidate| candidate == &format.as_str())
    {
        Ok(format)
    } else {
        Err(validation_error(
            &format!("Unknown format. Valid: {}", SUPPORTED_FORMATS.join(", ")),
            "format",
        ))
    }
}

fn ensure_file_output_allowed(
    value: Option<String>,
    field: &str,
    allow_file_output: bool,
) -> Result<Option<String>, RequestValidationError> {
    if value.is_some() && !allow_file_output {
        return Err(validation_error(
            &format!("'{field}' is only supported for local CLI usage"),
            field,
        ));
    }
    Ok(value)
}

fn to_integer(
    value: Option<i64>,
    field: &str,
    min: i64,
    max: i64,
    default_value: i64,
) -> Result<i64, RequestValidationError> {
    let numeric = value.unwrap_or(default_value);
    if numeric < min || numeric > max {
        return Err(validation_error(
            &format!("'{field}' must be between {min} and {max}"),
            field,
        ));
    }
    Ok(numeric)
}

fn optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn assert_absolute_url(value: &str) -> Result<(), RequestValidationError> {
    let parsed = url::Url::parse(value)
        .map_err(|_| validation_error("'url' must be a valid absolute URL", "url"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(validation_error(
            "'url' must use http:// or https://",
            "url",
        ));
    }
    Ok(())
}

fn validation_error(message: &str, field: &str) -> RequestValidationError {
    RequestValidationError {
        message: message.to_string(),
        field: field.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_defaults_for_url_requests() {
        let normalized = normalize_engine_request(
            EngineRequestInput {
                url: Some("https://example.com".to_string()),
                ..EngineRequestInput::default()
            },
            EngineNormalizationOptions {
                allow_file_output: false,
                allow_headful: false,
            },
        )
        .unwrap();

        assert_eq!(normalized.url.as_deref(), Some("https://example.com"));
        assert_eq!(normalized.strategy, "auto");
        assert_eq!(normalized.method, "auto");
        assert_eq!(normalized.format, "text");
        assert_eq!(normalized.timeout, 30);
        assert_eq!(normalized.render_wait, 0);
        assert_eq!(normalized.challenge_timeout, 15);
        assert_eq!(normalized.max_results, 10);
        assert_eq!(
            normalized.search_engines,
            vec!["duckduckgo", "bing", "brave", "google"]
        );
    }

    #[test]
    fn supports_google_only_requests() {
        let normalized = normalize_engine_request(
            EngineRequestInput {
                google: Some("site:example.com crawler".to_string()),
                max_results: Some(5),
                ..EngineRequestInput::default()
            },
            EngineNormalizationOptions {
                allow_file_output: false,
                allow_headful: false,
            },
        )
        .unwrap();

        assert_eq!(
            normalized.query.as_deref(),
            Some("site:example.com crawler")
        );
        assert_eq!(normalized.max_results, 5);
    }

    #[test]
    fn throws_when_wait_selector_missing() {
        let error = normalize_engine_request(
            EngineRequestInput {
                url: Some("https://example.com".to_string()),
                method: Some("wait".to_string()),
                ..EngineRequestInput::default()
            },
            EngineNormalizationOptions {
                allow_file_output: false,
                allow_headful: false,
            },
        )
        .unwrap_err();
        assert!(error.message.contains("selector"));
    }
}
