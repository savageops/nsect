use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};

use anyhow::{Result, anyhow};
use regex::Regex;
use reqwest::{
    Client,
    header::{ACCEPT_LANGUAGE, CONTENT_TYPE, HeaderMap, HeaderValue, USER_AGENT},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{process::Command, time::timeout};

// Compiled-once transcript regexes. Previously recompiled on every request
// (point 8); caching them in LazyLock eliminates per-call compilation cost.
static LANG_RE: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"^[a-z]{2,3}(-[a-z0-9]{2,8})?$").expect("language regex"));
static HEX_ENTITY_RE: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"&#x([a-fA-F0-9]+);").expect("hex entity regex"));
static DEC_ENTITY_RE: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"&#([0-9]+);").expect("dec entity regex"));
static INNERTUBE_KEY_RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r#""INNERTUBE_API_KEY":"([^"]+)""#).expect("innertube key regex")
});
static INNERTUBE_VERSION_RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r#""INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)""#)
        .expect("innertube version regex")
});
static XML_TEXT_RE: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r#"(?is)<text\b([^>]*)>(.*?)</text>"#).expect("xml transcript regex"));
static XML_START_RE: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r#"start="([^"]+)""#).expect("xml start regex"));
static XML_DURATION_RE: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r#"dur="([^"]+)""#).expect("xml duration regex"));
static STRIP_HTML_RE: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"(?is)<[^>]+>").expect("strip html regex"));
use url::Url;

use crate::AppState;

const DEFAULT_TIMEOUT_SECONDS: u64 = 20;

/// Process-level circuit breaker for dead third-party instances (mirrors JS).
/// When an Invidious/Piped instance fails, it's marked down for 5 minutes so
/// subsequent requests skip it instead of burning a full timeout per dead host.
const INSTANCE_COOLDOWN_SECS: u64 = 300; // 5 minutes
static DOWN_INSTANCES: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn is_instance_down(url: &str) -> bool {
    let map = DOWN_INSTANCES.lock().expect("down instances mutex poisoned");
    if let Some(&expiry) = map.get(url) {
        if Instant::now() < expiry {
            return true;
        }
    }
    false
}

fn mark_instance_down(url: &str) {
    let mut map = DOWN_INSTANCES.lock().expect("down instances mutex poisoned");
    map.insert(url.to_string(), Instant::now() + Duration::from_secs(INSTANCE_COOLDOWN_SECS));
}
const MIN_TIMEOUT_SECONDS: u64 = 5;
const MAX_TIMEOUT_SECONDS: u64 = 120;
const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

pub const YOUTUBE_TRANSCRIPT_METHODS: [&str; 5] = [
    "nsect_native",
    "nsect_signal",
    "invidious",
    "piped",
    "yt_dlp",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum StringListInput {
    Single(String),
    Many(Vec<String>),
}

#[derive(Debug, Clone, Deserialize)]
pub struct TranscriptInput {
    pub url: Option<String>,
    #[serde(rename = "videoId", alias = "video_id")]
    pub video_id: Option<String>,
    #[serde(alias = "lang")]
    pub language: Option<String>,
    pub methods: Option<StringListInput>,
    pub format: Option<String>,
    #[serde(rename = "includeSegments", alias = "include_segments")]
    pub include_segments: Option<bool>,
    #[serde(
        rename = "includeAutoCaptions",
        alias = "include_auto_captions",
        default
    )]
    pub include_auto_captions: Option<bool>,
    #[serde(alias = "timeoutSeconds", alias = "timeout_seconds")]
    pub timeout: Option<u64>,
}

#[derive(Debug, Clone)]
struct TranscriptRequest {
    url: String,
    video_id: String,
    language: String,
    methods: Vec<String>,
    format: String,
    include_segments: bool,
    include_auto_captions: bool,
    timeout_seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptValidationError {
    pub message: String,
    pub field: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptAttempt {
    pub method: String,
    pub status: String,
    pub reason: String,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u128,
    #[serde(rename = "segmentCount", skip_serializing_if = "Option::is_none")]
    pub segment_count: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptMeta {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "videoId")]
    pub video_id: String,
    pub url: String,
    pub language: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(rename = "autoGenerated", skip_serializing_if = "Option::is_none")]
    pub auto_generated: Option<bool>,
    #[serde(rename = "segmentCount", skip_serializing_if = "Option::is_none")]
    pub segment_count: Option<usize>,
    pub attempts: Vec<TranscriptAttempt>,
    pub elapsed: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptResponse {
    pub success: bool,
    pub output: Option<String>,
    #[serde(rename = "errorCode", skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub meta: TranscriptMeta,
}

#[derive(Debug, Clone, Serialize)]
struct TranscriptPayload {
    #[serde(rename = "videoId")]
    video_id: String,
    url: String,
    language: String,
    method: String,
    source: Option<String>,
    #[serde(rename = "autoGenerated")]
    auto_generated: bool,
    #[serde(rename = "segmentCount")]
    segment_count: usize,
    transcript: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    segments: Option<Vec<TranscriptSegment>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptSegment {
    pub text: String,
    pub start: Option<f64>,
    pub duration: Option<f64>,
}

#[derive(Debug, Clone)]
struct Track {
    language_code: String,
    url: String,
    is_auto_generated: bool,
}

#[derive(Debug, Clone)]
struct AdapterOutput {
    segments: Vec<TranscriptSegment>,
    language: String,
    is_auto_generated: bool,
    source: Option<String>,
}

#[derive(Debug)]
struct HttpTextResponse {
    ok: bool,
    status: u16,
    content_type: String,
    body: String,
}

struct TranscriptContext {
    state: Arc<AppState>,
    headers: HeaderMap,
    timeout: Duration,
    cache: HashMap<String, String>,
}

impl TranscriptValidationError {
    fn new(message: impl Into<String>, field: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            field: field.into(),
        }
    }
}

pub fn parse_youtube_video_id(value: Option<&str>) -> Option<String> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }

    if is_youtube_video_id(raw) {
        return Some(raw.to_string());
    }

    let parsed = Url::parse(raw).ok()?;

    if parsed
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("youtu.be"))
    {
        let candidate = parsed
            .path_segments()
            .and_then(|segments| segments.filter(|part| !part.is_empty()).next())?;
        return is_youtube_video_id(candidate).then(|| candidate.to_string());
    }

    if let Some(candidate) = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "v").then(|| value.into_owned()))
    {
        if is_youtube_video_id(&candidate) {
            return Some(candidate);
        }
    }

    let path_parts = parsed
        .path_segments()
        .map(|segments| segments.collect::<Vec<_>>())
        .unwrap_or_default();
    for (index, part) in path_parts.iter().enumerate() {
        if (*part == "embed" || *part == "shorts")
            && path_parts
                .get(index + 1)
                .is_some_and(|candidate| is_youtube_video_id(candidate))
        {
            return path_parts
                .get(index + 1)
                .map(|candidate| (*candidate).to_string());
        }
    }

    None
}

pub async fn fetch_youtube_transcript(
    input: TranscriptInput,
    state: Arc<AppState>,
) -> Result<TranscriptResponse, TranscriptValidationError> {
    let request = normalize_transcript_request(input)?;
    let started_at = Instant::now();
    let mut context = build_context(state, request.timeout_seconds)?;
    let mut attempts = Vec::new();

    for method in &request.methods {
        let method_started_at = Instant::now();
        let outcome = match method.as_str() {
            "nsect_native" => run_nsect_native_method(&request, &mut context).await,
            "nsect_signal" => run_nsect_signal_method(&request, &mut context).await,
            "invidious" => run_invidious_method(&request, &mut context).await,
            "piped" => run_piped_method(&request, &mut context).await,
            "yt_dlp" => run_yt_dlp_method(&request, &mut context).await,
            _ => Err(anyhow!("adapter_not_available")),
        };

        match outcome {
            Ok(result) => {
                let segments = normalize_segments(result.segments);
                if segments.is_empty() {
                    attempts.push(TranscriptAttempt {
                        method: method.clone(),
                        status: "error".to_string(),
                        reason: "adapter returned empty transcript segments".to_string(),
                        elapsed_ms: method_started_at.elapsed().as_millis(),
                        segment_count: None,
                    });
                    continue;
                }

                let transcript = segments_to_text(&segments);
                let payload = TranscriptPayload {
                    video_id: request.video_id.clone(),
                    url: request.url.clone(),
                    language: result.language.clone(),
                    method: method.clone(),
                    source: result.source.clone(),
                    auto_generated: result.is_auto_generated,
                    segment_count: segments.len(),
                    transcript,
                    segments: request.include_segments.then_some(segments.clone()),
                };

                attempts.push(TranscriptAttempt {
                    method: method.clone(),
                    status: "ok".to_string(),
                    reason: "ok".to_string(),
                    elapsed_ms: method_started_at.elapsed().as_millis(),
                    segment_count: Some(segments.len()),
                });

                return Ok(TranscriptResponse {
                    success: true,
                    output: Some(format_transcript_output(&request.format, &payload)),
                    error_code: None,
                    error: None,
                    meta: TranscriptMeta {
                        kind: "youtube_transcript".to_string(),
                        video_id: request.video_id.clone(),
                        url: request.url.clone(),
                        language: result.language,
                        method: Some(method.clone()),
                        source: result.source,
                        auto_generated: Some(result.is_auto_generated),
                        segment_count: Some(segments.len()),
                        attempts,
                        elapsed: format_elapsed(started_at.elapsed()),
                    },
                });
            }
            Err(error) => {
                attempts.push(TranscriptAttempt {
                    method: method.clone(),
                    status: "error".to_string(),
                    reason: error.to_string(),
                    elapsed_ms: method_started_at.elapsed().as_millis(),
                    segment_count: None,
                });
            }
        }
    }

    Ok(TranscriptResponse {
        success: false,
        output: None,
        error_code: Some("TRANSCRIPT_UNAVAILABLE".to_string()),
        error: Some("Unable to fetch transcript from all configured adapters.".to_string()),
        meta: TranscriptMeta {
            kind: "youtube_transcript".to_string(),
            video_id: request.video_id.clone(),
            url: request.url.clone(),
            language: request.language.clone(),
            method: None,
            source: None,
            auto_generated: None,
            segment_count: None,
            attempts,
            elapsed: format_elapsed(started_at.elapsed()),
        },
    })
}

fn normalize_transcript_request(
    input: TranscriptInput,
) -> Result<TranscriptRequest, TranscriptValidationError> {
    let url = normalize_url(input.url.as_deref())?;
    let direct_video_id = normalize_optional_string(input.video_id.as_deref());
    let derived_video_id = parse_youtube_video_id(direct_video_id.as_deref().or(url.as_deref()));
    let video_id = derived_video_id.ok_or_else(|| {
        TranscriptValidationError::new("A valid 'videoId' or YouTube 'url' is required", "videoId")
    })?;

    let language = normalize_language(input.language.as_deref())?;
    let methods = normalize_methods(input.methods)?;
    let format = normalize_format(input.format.as_deref())?;
    let timeout_seconds = normalize_timeout(input.timeout)?;

    Ok(TranscriptRequest {
        url: url.unwrap_or_else(|| format!("https://www.youtube.com/watch?v={video_id}")),
        video_id,
        language,
        methods,
        format,
        include_segments: input.include_segments.unwrap_or(false),
        include_auto_captions: input.include_auto_captions.unwrap_or(true),
        timeout_seconds,
    })
}

fn normalize_optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_url(value: Option<&str>) -> Result<Option<String>, TranscriptValidationError> {
    let Some(url) = normalize_optional_string(value) else {
        return Ok(None);
    };

    let parsed = Url::parse(&url)
        .map_err(|_| TranscriptValidationError::new("'url' must be a valid absolute URL", "url"))?;

    match parsed.scheme() {
        "http" | "https" => Ok(Some(url)),
        _ => Err(TranscriptValidationError::new(
            "'url' must be http:// or https://",
            "url",
        )),
    }
}

fn normalize_language(value: Option<&str>) -> Result<String, TranscriptValidationError> {
    let language = normalize_optional_string(value)
        .unwrap_or_else(|| "en".to_string())
        .to_lowercase();
    if !LANG_RE.is_match(&language) {
        return Err(TranscriptValidationError::new(
            "'language' must be an IETF language tag like en or en-US",
            "language",
        ));
    }
    Ok(language)
}

fn normalize_methods(
    value: Option<StringListInput>,
) -> Result<Vec<String>, TranscriptValidationError> {
    let Some(value) = value else {
        return Ok(YOUTUBE_TRANSCRIPT_METHODS
            .iter()
            .map(|method| (*method).to_string())
            .collect());
    };

    let raw = match value {
        StringListInput::Single(value) => value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>(),
        StringListInput::Many(values) => values
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>(),
    };

    if raw.is_empty() {
        return Err(TranscriptValidationError::new(
            "'methods' cannot be empty",
            "methods",
        ));
    }

    let mut unique = Vec::new();
    for method in raw {
        let normalized = method.to_lowercase();
        if !YOUTUBE_TRANSCRIPT_METHODS.contains(&normalized.as_str()) {
            return Err(TranscriptValidationError::new(
                format!(
                    "'methods' contains unsupported adapter '{normalized}'. Valid: {}",
                    YOUTUBE_TRANSCRIPT_METHODS.join(", ")
                ),
                "methods",
            ));
        }
        if !unique.contains(&normalized) {
            unique.push(normalized);
        }
    }

    Ok(unique)
}

fn normalize_format(value: Option<&str>) -> Result<String, TranscriptValidationError> {
    let format = normalize_optional_string(value)
        .unwrap_or_else(|| "text".to_string())
        .to_lowercase();
    match format.as_str() {
        "text" | "json" | "markdown" => Ok(format),
        _ => Err(TranscriptValidationError::new(
            "'format' must be one of: text, json, markdown",
            "format",
        )),
    }
}

fn normalize_timeout(value: Option<u64>) -> Result<u64, TranscriptValidationError> {
    let timeout = value.unwrap_or(DEFAULT_TIMEOUT_SECONDS);
    if !(MIN_TIMEOUT_SECONDS..=MAX_TIMEOUT_SECONDS).contains(&timeout) {
        return Err(TranscriptValidationError::new(
            format!("'timeout' must be between {MIN_TIMEOUT_SECONDS} and {MAX_TIMEOUT_SECONDS}"),
            "timeout",
        ));
    }
    Ok(timeout)
}

fn build_context(
    state: Arc<AppState>,
    timeout_seconds: u64,
) -> Result<TranscriptContext, TranscriptValidationError> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
    headers.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_USER_AGENT));
    let timeout = Duration::from_secs(timeout_seconds);
    Ok(TranscriptContext {
        state,
        headers,
        timeout,
        cache: HashMap::new(),
    })
}

fn is_youtube_video_id(value: &str) -> bool {
    value.len() == 11
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn normalize_segments(segments: Vec<TranscriptSegment>) -> Vec<TranscriptSegment> {
    segments
        .into_iter()
        .filter_map(|segment| {
            let text = normalize_segment_text(&segment.text);
            (!text.is_empty()).then_some(TranscriptSegment {
                text,
                start: segment.start,
                duration: segment.duration,
            })
        })
        .collect()
}

fn normalize_segment_text(input: &str) -> String {
    decode_entities(input)
        .replace('\r', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn decode_entities(input: &str) -> String {
    let with_hex = HEX_ENTITY_RE.replace_all(input, |captures: &regex::Captures<'_>| {
        let value = u32::from_str_radix(&captures[1], 16)
            .ok()
            .and_then(char::from_u32)
            .unwrap_or('?');
        value.to_string()
    });
    let with_numbers = DEC_ENTITY_RE.replace_all(&with_hex, |captures: &regex::Captures<'_>| {
        let value = captures[1]
            .parse::<u32>()
            .ok()
            .and_then(char::from_u32)
            .unwrap_or('?');
        value.to_string()
    });

    with_numbers
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn segments_to_text(segments: &[TranscriptSegment]) -> String {
    segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn format_transcript_output(format: &str, payload: &TranscriptPayload) -> String {
    match format {
        "json" => serde_json::to_string_pretty(payload).unwrap_or_else(|_| "{}".to_string()),
        "markdown" => [
            format!("# Transcript: {}", payload.video_id),
            String::new(),
            format!("- Language: {}", payload.language),
            format!("- Method: {}", payload.method),
            format!("- Segments: {}", payload.segment_count),
            String::new(),
            payload.transcript.clone(),
        ]
        .join("\n"),
        _ => payload.transcript.clone(),
    }
}

fn format_elapsed(duration: Duration) -> String {
    format!("{:.2}", duration.as_secs_f64())
}

async fn run_nsect_native_method(
    request: &TranscriptRequest,
    context: &mut TranscriptContext,
) -> Result<AdapterOutput> {
    let watch_html = get_watch_page(context, &request.video_id).await?;
    let payload = extract_player_response_from_watch_page(&watch_html)
        .ok_or_else(|| anyhow!("Could not parse ytInitialPlayerResponse"))?;
    let track = pick_track(
        extract_caption_tracks(&payload),
        &request.language,
        request.include_auto_captions,
    )
    .ok_or_else(|| anyhow!("No caption track found in YouTube watch payload"))?;

    let segments =
        pick_and_parse_transcript_candidates(build_caption_fetch_urls(&track.url), context).await?;

    Ok(AdapterOutput {
        segments,
        language: if track.language_code.is_empty() {
            request.language.clone()
        } else {
            track.language_code
        },
        is_auto_generated: track.is_auto_generated,
        source: Some("youtube/watch".to_string()),
    })
}

async fn run_nsect_signal_method(
    request: &TranscriptRequest,
    context: &mut TranscriptContext,
) -> Result<AdapterOutput> {
    let watch_html = get_watch_page(context, &request.video_id).await?;
    let (api_key, client_version) = extract_innertube_config(&watch_html)
        .ok_or_else(|| anyhow!("INNERTUBE config not found on watch page"))?;

    let endpoint = format!(
        "https://www.youtube.com/youtubei/v1/player?key={}",
        urlencoding(&api_key)
    );
    let response = fetch_json_post(
        &context.state.http,
        &endpoint,
        &context.headers,
        context.timeout,
        serde_json::json!({
            "videoId": request.video_id,
            "context": {
                "client": {
                    "clientName": "WEB",
                    "clientVersion": client_version,
                    "hl": "en"
                }
            }
        }),
    )
    .await?;

    if !response.ok {
        return Err(anyhow!(
            "InnerTube player request failed with HTTP {}",
            response.status
        ));
    }

    let payload: Value = serde_json::from_str(&response.body)
        .map_err(|error| anyhow!("Invalid JSON response from youtubei player: {error}"))?;
    let track = pick_track(
        extract_caption_tracks(&payload),
        &request.language,
        request.include_auto_captions,
    )
    .ok_or_else(|| anyhow!("No caption track found in InnerTube player payload"))?;

    let segments =
        pick_and_parse_transcript_candidates(build_caption_fetch_urls(&track.url), context).await?;

    Ok(AdapterOutput {
        segments,
        language: if track.language_code.is_empty() {
            request.language.clone()
        } else {
            track.language_code
        },
        is_auto_generated: track.is_auto_generated,
        source: Some("youtubei/player".to_string()),
    })
}

async fn run_invidious_method(
    request: &TranscriptRequest,
    context: &mut TranscriptContext,
) -> Result<AdapterOutput> {
    let mut last_error = None;

    for instance in &context.state.config.invidious_instances {
        if is_instance_down(instance) {
            continue;
        }
        let endpoint = format!(
            "{}/api/v1/captions/{}",
            instance.trim_end_matches('/'),
            request.video_id
        );
        match fetch_text(
            &context.state.http,
            &endpoint,
            &context.headers,
            context.timeout,
        )
        .await
        {
            Ok(response) if response.ok => {
                let payload: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
                let track = pick_track(
                    map_external_tracks(&payload),
                    &request.language,
                    request.include_auto_captions,
                )
                .ok_or_else(|| anyhow!("No caption entries found"));

                match track {
                    Ok(track) => {
                        let Some(url) = resolve_absolute_url(instance, &track.url) else {
                            last_error =
                                Some(anyhow!("Caption URL missing from Invidious payload"));
                            continue;
                        };
                        let segments = pick_and_parse_transcript_candidates(
                            build_caption_fetch_urls(&url),
                            context,
                        )
                        .await?;
                        return Ok(AdapterOutput {
                            segments,
                            language: if track.language_code.is_empty() {
                                request.language.clone()
                            } else {
                                track.language_code
                            },
                            is_auto_generated: track.is_auto_generated,
                            source: Some(instance.clone()),
                        });
                    }
                    Err(error) => {
                        last_error = Some(error);
                    }
                }
            }
            Ok(response) => {
                last_error = Some(anyhow!("HTTP {} from {}", response.status, instance));
            }
            Err(error) => {
                last_error = Some(error);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow!("All Invidious instances failed or on cooldown")))
}

async fn run_piped_method(
    request: &TranscriptRequest,
    context: &mut TranscriptContext,
) -> Result<AdapterOutput> {
    let mut last_error = None;

    for instance in &context.state.config.piped_instances {
        if is_instance_down(instance) {
            continue;
        }
        let endpoint = format!(
            "{}/streams/{}",
            instance.trim_end_matches('/'),
            request.video_id
        );
        match fetch_text(
            &context.state.http,
            &endpoint,
            &context.headers,
            context.timeout,
        )
        .await
        {
            Ok(response) if response.ok => {
                let payload: Value = serde_json::from_str(&response.body).map_err(|error| {
                    anyhow!("Invalid JSON response from Piped {}: {error}", instance)
                })?;
                let track = pick_track(
                    map_external_tracks(&payload),
                    &request.language,
                    request.include_auto_captions,
                )
                .ok_or_else(|| anyhow!("No subtitle entries found in Piped payload"));

                match track {
                    Ok(track) => {
                        let Some(url) = resolve_absolute_url(instance, &track.url) else {
                            last_error = Some(anyhow!("Subtitle URL missing from Piped payload"));
                            continue;
                        };
                        let segments = pick_and_parse_transcript_candidates(
                            build_caption_fetch_urls(&url),
                            context,
                        )
                        .await?;
                        return Ok(AdapterOutput {
                            segments,
                            language: if track.language_code.is_empty() {
                                request.language.clone()
                            } else {
                                track.language_code
                            },
                            is_auto_generated: track.is_auto_generated,
                            source: Some(instance.clone()),
                        });
                    }
                    Err(error) => {
                        last_error = Some(error);
                    }
                }
            }
            Ok(response) => {
                mark_instance_down(instance);
                last_error = Some(anyhow!("HTTP {} from {}", response.status, instance));
            }
            Err(error) => {
                mark_instance_down(instance);
                last_error = Some(error);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow!("All Piped instances failed or on cooldown")))
}

async fn run_yt_dlp_method(
    request: &TranscriptRequest,
    context: &mut TranscriptContext,
) -> Result<AdapterOutput> {
    let mut payload = None;
    let mut last_error = None;

    for command_name in &context.state.config.yt_dlp_commands {
        let child = Command::new(command_name)
            .arg("--skip-download")
            .arg("--dump-single-json")
            .arg("--no-warnings")
            .arg(&request.url)
            .output();

        match timeout(context.timeout, child).await {
            Ok(Ok(output)) if output.status.success() => {
                let stdout = String::from_utf8(output.stdout)
                    .map_err(|error| anyhow!("yt-dlp produced invalid UTF-8: {error}"))?;
                let json: Value = serde_json::from_str(&stdout)
                    .map_err(|error| anyhow!("yt-dlp JSON invalid: {error}"))?;
                payload = Some(json);
                break;
            }
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let message = if stderr.is_empty() {
                    format!("command exited with status {}", output.status)
                } else {
                    stderr
                };
                last_error = Some(anyhow!("{message}"));
            }
            Ok(Err(error)) => {
                last_error = Some(anyhow!("{error}"));
            }
            Err(_) => {
                last_error = Some(anyhow!("timed out"));
            }
        }
    }

    let payload = payload.ok_or_else(|| {
        anyhow!(
            "yt-dlp unavailable ({})",
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "missing binary or command failed".to_string())
        )
    })?;

    let track = pick_track(
        collect_ytdlp_tracks(&payload),
        &request.language,
        request.include_auto_captions,
    )
    .ok_or_else(|| anyhow!("yt-dlp returned no usable subtitle URLs"))?;

    let segments =
        pick_and_parse_transcript_candidates(build_caption_fetch_urls(&track.url), context).await?;

    Ok(AdapterOutput {
        segments,
        language: if track.language_code.is_empty() {
            request.language.clone()
        } else {
            track.language_code
        },
        is_auto_generated: track.is_auto_generated,
        source: Some("yt-dlp".to_string()),
    })
}

async fn get_watch_page(context: &mut TranscriptContext, video_id: &str) -> Result<String> {
    let cache_key = format!("watch:{video_id}");
    if let Some(cached) = context.cache.get(&cache_key) {
        return Ok(cached.clone());
    }

    let watch_url = format!("https://www.youtube.com/watch?v={video_id}&hl=en");
    let response = fetch_text(
        &context.state.http,
        &watch_url,
        &context.headers,
        context.timeout,
    )
    .await?;
    if !response.ok {
        return Err(anyhow!(
            "Watch page request failed with HTTP {}",
            response.status
        ));
    }

    context.cache.insert(cache_key, response.body.clone());
    Ok(response.body)
}

async fn pick_and_parse_transcript_candidates(
    candidates: Vec<String>,
    context: &TranscriptContext,
) -> Result<Vec<TranscriptSegment>> {
    let mut errors = Vec::new();

    for candidate in candidates {
        match fetch_text(
            &context.state.http,
            &candidate,
            &context.headers,
            context.timeout,
        )
        .await
        {
            Ok(response) if response.ok => {
                match parse_transcript_by_format(&response.body, &response.content_type, &candidate)
                {
                    Ok(segments) if !segments.is_empty() => return Ok(segments),
                    Ok(_) => errors.push(format!("No segments parsed @ {candidate}")),
                    Err(error) => errors.push(error.to_string()),
                }
            }
            Ok(response) => errors.push(format!("HTTP {} @ {candidate}", response.status)),
            Err(error) => errors.push(error.to_string()),
        }
    }

    Err(anyhow!(
        "{}",
        errors
            .into_iter()
            .next()
            .unwrap_or_else(|| "No transcript payload candidates succeeded".to_string())
    ))
}

fn extract_player_response_from_watch_page(html: &str) -> Option<Value> {
    for marker in ["ytInitialPlayerResponse =", "var ytInitialPlayerResponse ="] {
        let json = extract_json_object(html, marker)?;
        if let Ok(payload) = serde_json::from_str::<Value>(&json) {
            return Some(payload);
        }
    }
    None
}

fn extract_innertube_config(html: &str) -> Option<(String, String)> {
    let api_key = INNERTUBE_KEY_RE.captures(html)?.get(1)?.as_str().to_string();
    let client_version = INNERTUBE_VERSION_RE
        .captures(html)
        .and_then(|caps| caps.get(1).map(|value| value.as_str().to_string()))
        .unwrap_or_else(|| "2.20240101.00.00".to_string());
    Some((api_key, client_version))
}

fn extract_json_object(source: &str, marker: &str) -> Option<String> {
    let marker_index = source.find(marker)?;
    let start = source[marker_index + marker.len()..].find('{')? + marker_index + marker.len();
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (index, ch) in source[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        if ch == '"' {
            in_string = true;
            continue;
        }
        if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                let end = start + index + ch.len_utf8();
                return Some(source[start..end].to_string());
            }
        }
    }

    None
}

fn extract_caption_tracks(payload: &Value) -> Vec<Track> {
    payload["captions"]["playerCaptionsTracklistRenderer"]["captionTracks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(track_from_value)
        .collect()
}

fn map_external_tracks(payload: &Value) -> Vec<Track> {
    if let Some(array) = payload.as_array() {
        return array.iter().filter_map(track_from_value).collect();
    }
    for key in ["captions", "subtitleStreams", "subtitles"] {
        if let Some(array) = payload.get(key).and_then(|value| value.as_array()) {
            return array.iter().filter_map(track_from_value).collect();
        }
    }
    if payload.get("url").is_some() || payload.get("baseUrl").is_some() {
        return track_from_value(payload).into_iter().collect();
    }
    Vec::new()
}

fn collect_ytdlp_tracks(payload: &Value) -> Vec<Track> {
    let mut tracks = Vec::new();
    push_ytdlp_tracks(payload.get("subtitles"), false, &mut tracks);
    push_ytdlp_tracks(payload.get("automatic_captions"), true, &mut tracks);
    tracks
}

fn push_ytdlp_tracks(pool: Option<&Value>, auto_generated: bool, tracks: &mut Vec<Track>) {
    let Some(object) = pool.and_then(|value| value.as_object()) else {
        return;
    };

    for (language_code, entries) in object {
        let Some(entries) = entries.as_array() else {
            continue;
        };
        for entry in entries {
            let Some(url) = first_string(entry, &["url"]) else {
                continue;
            };
            tracks.push(Track {
                language_code: language_code.to_lowercase(),
                url,
                is_auto_generated: auto_generated,
            });
        }
    }
}

fn track_from_value(value: &Value) -> Option<Track> {
    let url = first_string(value, &["baseUrl", "url"])?;
    let language_code = first_string(value, &["languageCode", "language_code", "code", "lang"])
        .unwrap_or_default()
        .to_lowercase();
    let is_auto_generated = value
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "asr")
        || value
            .get("autoGenerated")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || value.get("auto").and_then(Value::as_bool).unwrap_or(false);

    Some(Track {
        language_code,
        url,
        is_auto_generated,
    })
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn pick_track(tracks: Vec<Track>, language: &str, include_auto_captions: bool) -> Option<Track> {
    let lang = language.to_lowercase();
    let lang_base = lang.split('-').next().unwrap_or(language).to_string();
    let normalized = tracks
        .into_iter()
        .filter(|track| !track.url.trim().is_empty())
        .collect::<Vec<_>>();

    let auto_candidate = if include_auto_captions {
        normalized
            .iter()
            .find(|track| track.is_auto_generated && track.language_code == lang)
            .cloned()
            .or_else(|| {
                normalized
                    .iter()
                    .find(|track| {
                        track.is_auto_generated && track.language_code.starts_with(&lang_base)
                    })
                    .cloned()
            })
    } else {
        None
    };

    normalized
        .iter()
        .find(|track| !track.is_auto_generated && track.language_code == lang)
        .cloned()
        .or_else(|| {
            normalized
                .iter()
                .find(|track| {
                    !track.is_auto_generated && track.language_code.starts_with(&lang_base)
                })
                .cloned()
        })
        .or(auto_candidate)
        .or_else(|| {
            normalized
                .iter()
                .find(|track| !track.is_auto_generated)
                .cloned()
        })
        .or_else(|| normalized.first().cloned())
}

fn build_caption_fetch_urls(track_url: &str) -> Vec<String> {
    if track_url.contains("fmt=") {
        return vec![track_url.to_string()];
    }
    let separator = if track_url.contains('?') { '&' } else { '?' };
    vec![
        format!("{track_url}{separator}fmt=json3"),
        track_url.to_string(),
    ]
}

fn resolve_absolute_url(base_url: &str, maybe_relative: &str) -> Option<String> {
    Url::parse(maybe_relative)
        .map(|url| url.to_string())
        .or_else(|_| {
            Url::parse(base_url)
                .and_then(|base| base.join(maybe_relative).map(|url| url.to_string()))
        })
        .ok()
}

fn parse_transcript_by_format(
    body: &str,
    content_type: &str,
    source_url: &str,
) -> Result<Vec<TranscriptSegment>> {
    let lower_type = content_type.to_lowercase();
    let lower_url = source_url.to_lowercase();

    if lower_type.contains("application/json")
        || lower_url.contains("fmt=json3")
        || lower_url.ends_with(".json3")
    {
        return parse_json3_transcript(body);
    }
    if lower_type.contains("text/vtt") || lower_url.ends_with(".vtt") {
        return Ok(parse_vtt_transcript(body));
    }
    if lower_url.ends_with(".srt") {
        return Ok(parse_srt_transcript(body));
    }
    if body.contains("<text") && body.contains("</text>") {
        return Ok(parse_xml_transcript(body));
    }
    if body.contains("-->") {
        return Ok(parse_vtt_transcript(body));
    }

    Ok(normalize_segments(vec![TranscriptSegment {
        text: body.to_string(),
        start: None,
        duration: None,
    }]))
}

fn parse_json3_transcript(body: &str) -> Result<Vec<TranscriptSegment>> {
    let payload: Value = serde_json::from_str(body)?;
    let mut segments = Vec::new();

    for event in payload
        .get("events")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(parts) = event.get("segs").and_then(Value::as_array) else {
            continue;
        };
        let text = parts
            .iter()
            .filter_map(|part| part.get("utf8").and_then(Value::as_str))
            .collect::<String>();
        if text.trim().is_empty() {
            continue;
        }

        let start = event
            .get("tStartMs")
            .and_then(Value::as_f64)
            .map(|value| value / 1000.0)
            .or_else(|| {
                event
                    .get("tStartMs")
                    .and_then(Value::as_i64)
                    .map(|value| value as f64 / 1000.0)
            });
        let duration = event
            .get("dDurationMs")
            .and_then(Value::as_f64)
            .map(|value| value / 1000.0)
            .or_else(|| {
                event
                    .get("dDurationMs")
                    .and_then(Value::as_i64)
                    .map(|value| value as f64 / 1000.0)
            });

        segments.push(TranscriptSegment {
            text,
            start,
            duration,
        });
    }

    Ok(normalize_segments(segments))
}

fn parse_xml_transcript(body: &str) -> Vec<TranscriptSegment> {
    let mut segments = Vec::new();
    for capture in XML_TEXT_RE.captures_iter(body) {
        let attrs = capture
            .get(1)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let text = capture
            .get(2)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let start = XML_START_RE
            .captures(attrs)
            .and_then(|caps| caps.get(1))
            .and_then(|value| value.as_str().parse::<f64>().ok());
        let duration = XML_DURATION_RE
            .captures(attrs)
            .and_then(|caps| caps.get(1))
            .and_then(|value| value.as_str().parse::<f64>().ok());

        segments.push(TranscriptSegment {
            text: text.to_string(),
            start,
            duration,
        });
    }

    normalize_segments(segments)
}

fn parse_vtt_transcript(body: &str) -> Vec<TranscriptSegment> {
    let mut segments = Vec::new();
    let mut pending_start = None;
    let mut pending_duration = None;
    let mut pending_lines: Vec<String> = Vec::new();

    let flush = |segments: &mut Vec<TranscriptSegment>,
                 pending_start: &mut Option<f64>,
                 pending_duration: &mut Option<f64>,
                 pending_lines: &mut Vec<String>| {
        if pending_lines.is_empty() {
            return;
        }
        segments.push(TranscriptSegment {
            text: pending_lines.join(" "),
            start: *pending_start,
            duration: *pending_duration,
        });
        *pending_start = None;
        *pending_duration = None;
        pending_lines.clear();
    };

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            flush(
                &mut segments,
                &mut pending_start,
                &mut pending_duration,
                &mut pending_lines,
            );
            continue;
        }
        if trimmed.starts_with("WEBVTT") || trimmed.starts_with("NOTE") {
            continue;
        }
        if trimmed.chars().all(|ch| ch.is_ascii_digit()) {
            continue;
        }
        if let Some((raw_start, raw_end)) = trimmed.split_once("-->") {
            flush(
                &mut segments,
                &mut pending_start,
                &mut pending_duration,
                &mut pending_lines,
            );
            let start = parse_timestamp_to_seconds(raw_start.trim());
            let end = raw_end
                .split_whitespace()
                .next()
                .and_then(parse_timestamp_to_seconds);
            pending_start = start;
            pending_duration = match (start, end) {
                (Some(start), Some(end)) => Some((end - start).max(0.0)),
                _ => None,
            };
            continue;
        }
        pending_lines.push(strip_html_tags(trimmed));
    }

    flush(
        &mut segments,
        &mut pending_start,
        &mut pending_duration,
        &mut pending_lines,
    );

    normalize_segments(segments)
}

fn parse_srt_transcript(body: &str) -> Vec<TranscriptSegment> {
    let mut segments = Vec::new();

    for block in body.split("\n\n") {
        let lines = block
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>();
        if lines.len() < 2 {
            continue;
        }

        let timing_index = if lines
            .first()
            .is_some_and(|line| line.chars().all(|ch| ch.is_ascii_digit()))
        {
            1
        } else {
            0
        };
        let Some((raw_start, raw_end)) = lines[timing_index].split_once("-->") else {
            continue;
        };

        let start = parse_timestamp_to_seconds(raw_start.trim());
        let end = parse_timestamp_to_seconds(raw_end.trim());
        let text = lines
            .iter()
            .skip(timing_index + 1)
            .map(|line| strip_html_tags(line))
            .collect::<Vec<_>>()
            .join(" ");

        segments.push(TranscriptSegment {
            text,
            start,
            duration: match (start, end) {
                (Some(start), Some(end)) => Some((end - start).max(0.0)),
                _ => None,
            },
        });
    }

    normalize_segments(segments)
}

fn parse_timestamp_to_seconds(value: &str) -> Option<f64> {
    let normalized = value.trim().replace(',', ".");
    let parts = normalized.split(':').collect::<Vec<_>>();
    match parts.as_slice() {
        [minutes, seconds] => {
            let minutes = minutes.trim().parse::<f64>().ok()?;
            let seconds = seconds.trim().parse::<f64>().ok()?;
            Some((minutes * 60.0) + seconds)
        }
        [hours, minutes, seconds] => {
            let hours = hours.trim().parse::<f64>().ok()?;
            let minutes = minutes.trim().parse::<f64>().ok()?;
            let seconds = seconds.trim().parse::<f64>().ok()?;
            Some((hours * 3600.0) + (minutes * 60.0) + seconds)
        }
        _ => None,
    }
}

fn strip_html_tags(value: &str) -> String {
    STRIP_HTML_RE.replace_all(value, "").to_string()
}

async fn fetch_text(
    client: &Client,
    url: &str,
    headers: &HeaderMap,
    timeout_duration: Duration,
) -> Result<HttpTextResponse> {
    let response = client
        .get(url)
        .headers(headers.clone())
        .timeout(timeout_duration)
        .send()
        .await?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let body = response.text().await?;
    Ok(HttpTextResponse {
        ok: status.is_success(),
        status: status.as_u16(),
        content_type,
        body,
    })
}

async fn fetch_json_post(
    client: &Client,
    url: &str,
    headers: &HeaderMap,
    timeout_duration: Duration,
    body: Value,
) -> Result<HttpTextResponse> {
    let response = client
        .post(url)
        .headers(headers.clone())
        .header(CONTENT_TYPE, "application/json")
        .timeout(timeout_duration)
        .json(&body)
        .send()
        .await?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let body = response.text().await?;
    Ok(HttpTextResponse {
        ok: status.is_success(),
        status: status.as_u16(),
        content_type,
        body,
    })
}

fn urlencoding(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_youtube_ids_from_urls_and_direct_ids() {
        assert_eq!(
            parse_youtube_video_id(Some("dQw4w9WgXcQ")),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(
            parse_youtube_video_id(Some("https://www.youtube.com/watch?v=dQw4w9WgXcQ")),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(
            parse_youtube_video_id(Some("https://youtu.be/dQw4w9WgXcQ")),
            Some("dQw4w9WgXcQ".to_string())
        );
    }

    #[test]
    fn normalizes_transcript_request_defaults() {
        let normalized = normalize_transcript_request(TranscriptInput {
            url: Some("https://www.youtube.com/watch?v=dQw4w9WgXcQ".to_string()),
            video_id: None,
            language: None,
            methods: None,
            format: None,
            include_segments: None,
            include_auto_captions: None,
            timeout: None,
        })
        .unwrap();

        assert_eq!(normalized.video_id, "dQw4w9WgXcQ");
        assert_eq!(normalized.language, "en");
        assert_eq!(normalized.format, "text");
        assert!(!normalized.methods.is_empty());
    }

    #[test]
    fn parses_vtt_and_srt_transcripts() {
        let vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello world\n\n00:00:02.000 --> 00:00:03.000\nAgain\n";
        let srt = "1\n00:00:00,000 --> 00:00:02,000\nHello world\n\n2\n00:00:02,000 --> 00:00:03,000\nAgain\n";

        assert_eq!(parse_vtt_transcript(vtt).len(), 2);
        assert_eq!(parse_srt_transcript(srt).len(), 2);
    }

    #[test]
    fn parse_youtube_id_from_various_url_formats() {
        assert_eq!(
            parse_youtube_video_id(Some("dQw4w9WgXcQ")),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(
            parse_youtube_video_id(Some("https://www.youtube.com/watch?v=dQw4w9WgXcQ")),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(
            parse_youtube_video_id(Some("https://youtu.be/dQw4w9WgXcQ")),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(
            parse_youtube_video_id(Some("https://www.youtube.com/embed/dQw4w9WgXcQ")),
            Some("dQw4w9WgXcQ".to_string())
        );
    }

    #[test]
    fn parse_youtube_id_rejects_invalid_input() {
        assert_eq!(parse_youtube_video_id(None), None);
        assert_eq!(parse_youtube_video_id(Some("")), None);
        assert_eq!(parse_youtube_video_id(Some("   ")), None);
        assert_eq!(parse_youtube_video_id(Some("too_short")), None);
        assert_eq!(parse_youtube_video_id(Some("https://example.com")), None);
    }

    #[test]
    fn pick_track_prefers_exact_manual_match() {
        let tracks = vec![
            Track {
                language_code: "en".to_string(),
                url: "https://example.com/en-auto".to_string(),
                is_auto_generated: true,
            },
            Track {
                language_code: "en".to_string(),
                url: "https://example.com/en-manual".to_string(),
                is_auto_generated: false,
            },
        ];
        let selected = pick_track(tracks, "en", true).unwrap();
        assert!(!selected.is_auto_generated);
        assert_eq!(selected.url, "https://example.com/en-manual");
    }

    #[test]
    fn pick_track_falls_back_to_auto_when_no_manual() {
        let tracks = vec![Track {
            language_code: "en".to_string(),
            url: "https://example.com/en-auto".to_string(),
            is_auto_generated: true,
        }];
        let selected = pick_track(tracks, "en", true).unwrap();
        assert!(selected.is_auto_generated);
    }

    #[test]
    fn pick_track_excludes_auto_when_flag_false() {
        let tracks = vec![
            Track {
                language_code: "en".to_string(),
                url: "https://example.com/auto".to_string(),
                is_auto_generated: true,
            },
            Track {
                language_code: "fr".to_string(),
                url: "https://example.com/fr".to_string(),
                is_auto_generated: false,
            },
        ];
        // Requesting "en" but auto excluded → falls to first non-auto (fr)
        let selected = pick_track(tracks, "en", false).unwrap();
        assert_eq!(selected.language_code, "fr");
    }

    #[test]
    fn pick_track_matches_base_language() {
        let tracks = vec![Track {
            language_code: "en-US".to_string(),
            url: "https://example.com/en-us".to_string(),
            is_auto_generated: false,
        }];
        // Requesting "en" should match "en-US" via base-language fallback
        let selected = pick_track(tracks, "en", false).unwrap();
        assert_eq!(selected.language_code, "en-US");
    }

    #[test]
    fn pick_track_returns_none_for_empty_tracks() {
        assert!(pick_track(Vec::new(), "en", true).is_none());
    }

    #[test]
    fn pick_track_returns_none_when_all_urls_empty() {
        let tracks = vec![Track {
            language_code: "en".to_string(),
            url: "   ".to_string(),
            is_auto_generated: false,
        }];
        assert!(pick_track(tracks, "en", false).is_none());
    }

    #[test]
    fn build_caption_urls_prefers_json3() {
        let urls = build_caption_fetch_urls("https://example.com/caption");
        assert_eq!(urls.len(), 2);
        assert!(urls[0].contains("fmt=json3"));
        assert_eq!(urls[1], "https://example.com/caption");
    }

    #[test]
    fn build_caption_urls_preserves_existing_fmt() {
        let urls = build_caption_fetch_urls("https://example.com/caption?fmt=srv3");
        assert_eq!(urls.len(), 1);
        assert_eq!(urls[0], "https://example.com/caption?fmt=srv3");
    }

    #[test]
    fn build_caption_urls_uses_ampersand_for_existing_query() {
        let urls = build_caption_fetch_urls("https://example.com/caption?hl=en");
        assert!(urls[0].contains("&fmt=json3"));
    }

    #[test]
    fn resolve_absolute_url_passthrough_for_absolute() {
        let result = resolve_absolute_url("https://instance.com", "https://other.com/path");
        assert_eq!(result, Some("https://other.com/path".to_string()));
    }

    #[test]
    fn resolve_absolute_url_joins_relative() {
        let result = resolve_absolute_url("https://instance.com", "/api/captions/123");
        assert_eq!(result, Some("https://instance.com/api/captions/123".to_string()));
    }

    #[test]
    fn resolve_absolute_url_returns_none_for_invalid_both() {
        let result = resolve_absolute_url("not-a-url", "also-not-a-url");
        assert_eq!(result, None);
    }

    #[test]
    fn map_external_tracks_handles_array_payload() {
        let payload = serde_json::json!([
            { "languageCode": "en", "url": "https://example.com/en" }
        ]);
        let tracks = map_external_tracks(&payload);
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].language_code, "en");
    }

    #[test]
    fn map_external_tracks_handles_captions_key() {
        let payload = serde_json::json!({
            "captions": [{ "languageCode": "fr", "url": "https://example.com/fr" }]
        });
        let tracks = map_external_tracks(&payload);
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].language_code, "fr");
    }

    #[test]
    fn map_external_tracks_handles_subtitles_key() {
        let payload = serde_json::json!({
            "subtitles": [{ "languageCode": "de", "url": "https://example.com/de" }]
        });
        let tracks = map_external_tracks(&payload);
        assert_eq!(tracks.len(), 1);
    }

    #[test]
    fn map_external_tracks_handles_single_object() {
        let payload = serde_json::json!({ "url": "https://example.com/single" });
        let tracks = map_external_tracks(&payload);
        assert_eq!(tracks.len(), 1);
    }

    #[test]
    fn map_external_tracks_returns_empty_for_null() {
        let tracks = map_external_tracks(&serde_json::Value::Null);
        assert!(tracks.is_empty());
    }

    #[test]
    fn collect_ytdlp_tracks_separates_manual_and_auto() {
        let payload = serde_json::json!({
            "subtitles": {
                "en": [{ "url": "https://example.com/en-manual", "name": "English" }]
            },
            "automatic_captions": {
                "en": [{ "url": "https://example.com/en-auto", "name": "English (auto)" }]
            }
        });
        let tracks = collect_ytdlp_tracks(&payload);
        assert_eq!(tracks.len(), 2);
        let manual = tracks.iter().find(|t| !t.is_auto_generated);
        let auto = tracks.iter().find(|t| t.is_auto_generated);
        assert!(manual.is_some());
        assert!(auto.is_some());
    }

    #[test]
    fn collect_ytdlp_tracks_handles_empty_payload() {
        let payload = serde_json::json!({});
        let tracks = collect_ytdlp_tracks(&payload);
        assert!(tracks.is_empty());
    }
}
