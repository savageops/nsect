use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow};
use headless_chrome::{
    Browser, LaunchOptions,
    browser::tab::Tab,
    protocol::cdp::{
        Emulation::{SetDeviceMetricsOverride, SetTimezoneOverride},
        Page::{self, AddScriptToEvaluateOnNewDocument},
    },
};
use serde::{Deserialize, Serialize};

use crate::{
    fingerprint::{
        FingerprintProfile, NOISE_SELECTORS, Viewport, generate_fingerprint, random_int,
    },
    formatters::{format_page_output, format_search_results},
    models::{DiscoveredLink, PageContent, SearchResultItem},
    request::NormalizedEngineRequest,
    search::{build_search_url, decode_search_result_url, is_search_blocked, search_engine_label},
};

#[derive(Debug, Clone, Serialize)]
pub struct EngineResponse {
    pub success: bool,
    /// Unified envelope: string for text/html/markdown, parsed object/array for
    /// json/links. Serialized naturally by serde — callers check `format` to
    /// know which type to expect.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<EngineMeta>,
    #[serde(rename = "errorCode", skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum EngineMeta {
    Page(PageMeta),
    Search(SearchMeta),
}

#[derive(Debug, Clone, Serialize)]
pub struct ArtifactMeta {
    #[serde(rename = "screenshotPath")]
    pub screenshot_path: Option<String>,
    #[serde(rename = "pdfPath")]
    pub pdf_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FingerprintMeta {
    #[serde(rename = "userAgent")]
    pub user_agent: String,
    pub viewport: Viewport,
    pub locale: String,
    pub timezone: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PageMeta {
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub url: String,
    #[serde(rename = "textLength")]
    pub text_length: usize,
    #[serde(rename = "linksFound")]
    pub links_found: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub links: Option<Vec<DiscoveredLink>>,
    pub elapsed: String,
    pub artifacts: ArtifactMeta,
    pub fingerprint: FingerprintMeta,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchMeta {
    #[serde(rename = "type")]
    pub kind: String,
    pub query: String,
    pub engine: Option<String>,
    #[serde(rename = "engineLabel")]
    pub engine_label: Option<String>,
    #[serde(rename = "engineOrder")]
    pub engine_order: Vec<String>,
    pub attempts: Vec<SearchAttempt>,
    #[serde(rename = "resultCount")]
    pub result_count: usize,
    pub elapsed: String,
    pub artifacts: ArtifactMeta,
    pub fingerprint: FingerprintMeta,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchAttempt {
    pub engine: String,
    #[serde(rename = "engineLabel")]
    pub engine_label: String,
    pub url: String,
    pub blocked: bool,
    #[serde(rename = "resultCount")]
    pub result_count: usize,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawSearchResult {
    url: Option<String>,
    title: Option<String>,
    snippet: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SearchPageSnapshot {
    title: String,
    url: String,
    text: String,
}

struct SearchState {
    selected_engine: Option<String>,
    results: Vec<SearchResultItem>,
    attempts: Vec<SearchAttempt>,
}

pub async fn run_nsect_engine(params: NormalizedEngineRequest) -> EngineResponse {
    tokio::task::spawn_blocking(move || run_nsect_engine_blocking(params))
        .await
        .unwrap_or_else(|error| upstream_error(&format!("Engine task join failed: {error}")))
}

fn run_nsect_engine_blocking(params: NormalizedEngineRequest) -> EngineResponse {
    let fingerprint = generate_fingerprint();
    let started_at = Instant::now();

    let browser = match build_browser(&params, &fingerprint) {
        Ok(browser) => browser,
        Err(error) => return browser_launch_error(&error.to_string()),
    };

    let result = (|| -> Result<EngineResponse> {
        let tab = browser.new_tab().context("failed to open browser tab")?;
        prime_tab(&tab, &params, &fingerprint)?;

        thread::sleep(Duration::from_millis(params.delay + random_int(0, 500)));

        if params.query.is_some() {
            let search = run_search_with_fallback(&tab, &params)?;
            let artifacts = persist_artifacts(&tab, &params)?;
            let response = EngineResponse {
                success: true,
                output: Some(format_search_results(&search.results, &params.format)),
                format: Some(params.format.clone()),
                meta: Some(EngineMeta::Search(SearchMeta {
                    kind: "search".to_string(),
                    query: params.query.clone().unwrap_or_default(),
                    engine: search.selected_engine.clone(),
                    engine_label: search.selected_engine.as_deref().map(search_engine_label),
                    engine_order: params.search_engines.clone(),
                    attempts: search.attempts,
                    result_count: search.results.len(),
                    elapsed: format_elapsed(started_at.elapsed()),
                    artifacts,
                    fingerprint: fingerprint_meta(&fingerprint),
                })),
                error_code: None,
                error: None,
            };

            close_tab_session(&tab);
            Ok(response)
        } else {
            let page = run_page_extraction(&tab, &params)?;
            let artifacts = persist_artifacts(&tab, &params)?;
            let response = EngineResponse {
                success: true,
                output: Some(format_page_output(&page, &params.format)),
                format: Some(params.format.clone()),
                meta: Some(EngineMeta::Page(PageMeta {
                    kind: "page".to_string(),
                    title: page.title.clone(),
                    url: page.url.clone(),
                    text_length: page.text.len(),
                    links_found: page.links.len(),
                    links: if params.list_links {
                        Some(page.links.clone())
                    } else {
                        None
                    },
                    elapsed: format_elapsed(started_at.elapsed()),
                    artifacts,
                    fingerprint: fingerprint_meta(&fingerprint),
                })),
                error_code: None,
                error: None,
            };

            close_tab_session(&tab);
            Ok(response)
        }
    })();

    thread::sleep(Duration::from_millis(150));
    drop(browser);
    thread::sleep(Duration::from_millis(100));

    match result {
        Ok(response) => response,
        Err(error) => upstream_error(&error.to_string()),
    }
}

fn build_browser(
    params: &NormalizedEngineRequest,
    fingerprint: &FingerprintProfile,
) -> Result<Browser> {
    let mut options = LaunchOptions::default_builder();
    options
        .headless(params.headless)
        .sandbox(false)
        .ignore_certificate_errors(true)
        .window_size(Some((
            fingerprint.viewport.width,
            fingerprint.viewport.height,
        )));

    if let Some(path) = detect_browser_path() {
        options.path(Some(path));
    }

    if let Some(proxy) = &params.proxy {
        options.proxy_server(Some(proxy.as_str()));
    }

    let launch_options = options
        .build()
        .map_err(|error| anyhow!(error.to_string()))?;
    Browser::new(launch_options).context("failed to launch Chrome/Chromium")
}

fn prime_tab(
    tab: &Tab,
    params: &NormalizedEngineRequest,
    fingerprint: &FingerprintProfile,
) -> Result<()> {
    tab.enable_stealth_mode()
        .context("failed to enable browser stealth mode")?;
    tab.set_default_timeout(Duration::from_secs(params.timeout));
    tab.set_user_agent(
        &fingerprint.user_agent,
        Some(&fingerprint.locale),
        Some(&fingerprint.platform),
    )
    .context("failed to set user agent")?;

    let mut headers = BTreeMap::new();
    headers.insert("accept-language".to_string(), fingerprint.locale.clone());
    for (key, value) in &params.headers {
        headers.insert(key.to_lowercase(), value.clone());
    }
    if !headers.is_empty() {
        let mapped = headers
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect::<std::collections::HashMap<_, _>>();
        tab.set_extra_http_headers(mapped)
            .context("failed to set HTTP headers")?;
    }

    tab.call_method(SetDeviceMetricsOverride {
        width: fingerprint.viewport.width,
        height: fingerprint.viewport.height,
        device_scale_factor: 1.0,
        mobile: false,
        scale: None,
        screen_width: Some(fingerprint.viewport.width),
        screen_height: Some(fingerprint.viewport.height),
        position_x: None,
        position_y: None,
        dont_set_visible_size: None,
        screen_orientation: None,
        viewport: None,
        display_feature: None,
        device_posture: None,
    })
    .context("failed to set viewport metrics")?;

    tab.call_method(SetTimezoneOverride {
        timezone_id: fingerprint.timezone.clone(),
    })
    .context("failed to set timezone")?;

    tab.call_method(AddScriptToEvaluateOnNewDocument {
        source: build_stealth_script(fingerprint),
        world_name: None,
        include_command_line_api: Some(false),
        run_immediately: Some(true),
    })
    .context("failed to inject stealth fingerprint script")?;

    Ok(())
}

fn run_page_extraction(tab: &Tab, params: &NormalizedEngineRequest) -> Result<PageContent> {
    let target_url = params
        .url
        .as_deref()
        .ok_or_else(|| anyhow!("missing target URL"))?;
    set_tab_cookies(tab, &params, target_url)?;
    tab.navigate_to(target_url)
        .with_context(|| format!("failed to navigate to {target_url}"))?;
    tab.wait_until_navigated()
        .context("page did not finish navigation")?;
    let _challenge_info = apply_strategy(tab, params)?;
    extract_page_content(tab, params.verbose)
}

fn run_search_with_fallback(tab: &Tab, params: &NormalizedEngineRequest) -> Result<SearchState> {
    let query = params
        .query
        .as_deref()
        .ok_or_else(|| anyhow!("missing search query"))?;

    let mut attempts = Vec::new();
    let mut selected_engine = None;
    let mut results = Vec::new();

    for engine in &params.search_engines {
        let search_url = build_search_url(engine, query, params.max_results)
            .map_err(|message| anyhow!(message))?;

        set_tab_cookies(tab, params, &search_url)?;
        match tab.navigate_to(&search_url) {
            Ok(_) => {
                tab.wait_until_navigated()
                    .with_context(|| format!("search navigation did not complete for {engine}"))?;
                let _ = apply_strategy(tab, params)?;
                let snapshot = inspect_search_page(tab)?;

                if is_search_blocked(engine, &snapshot.url, &snapshot.title, &snapshot.text) {
                    attempts.push(SearchAttempt {
                        engine: engine.clone(),
                        engine_label: search_engine_label(engine),
                        url: search_url,
                        blocked: true,
                        result_count: 0,
                        reason: "blocked".to_string(),
                        error: None,
                    });
                    continue;
                }

                let raw_results =
                    extract_search_results_for_engine(tab, engine, params.max_results)?;
                let normalized = normalize_search_results(engine, raw_results, params.max_results);
                let reason = if normalized.is_empty() {
                    "no_results"
                } else {
                    "ok"
                };
                attempts.push(SearchAttempt {
                    engine: engine.clone(),
                    engine_label: search_engine_label(engine),
                    url: search_url,
                    blocked: false,
                    result_count: normalized.len(),
                    reason: reason.to_string(),
                    error: None,
                });

                if !normalized.is_empty() {
                    selected_engine = Some(engine.clone());
                    results = normalized;
                    break;
                }
            }
            Err(error) => attempts.push(SearchAttempt {
                engine: engine.clone(),
                engine_label: search_engine_label(engine),
                url: search_url,
                blocked: false,
                result_count: 0,
                reason: "error".to_string(),
                error: Some(error.to_string()),
            }),
        }
    }

    Ok(SearchState {
        selected_engine,
        results,
        attempts,
    })
}

/// Apply the extraction strategy. Mirrors the JS `applyStrategy` — `auto`
/// detects challenges and waits for resolution, then handles SPA/scroll;
/// the other strategies are explicit. Returns challenge info if any was
/// detected so the caller can surface it in meta or fail honestly.
fn apply_strategy(tab: &Tab, params: &NormalizedEngineRequest) -> Result<crate::challenge::ChallengeInfo> {
    use crate::challenge;

    let mut challenge_info = challenge::ChallengeInfo::none();

    // Challenge handling: auto always does it; other strategies opt in via
    // bypass_challenges. Runs BEFORE the strategy-specific wait.
    let handle_challenges = params.strategy == "auto" || params.bypass_challenges;
    if handle_challenges && params.challenge_timeout > 0 {
        challenge_info = challenge::wait_for_challenge_resolution(
            tab,
            params.challenge_timeout * 1000,
            1500,
        );
    }

    match params.strategy.as_str() {
        "auto" => {
            // network idle-ish wait, then content/SPA/scroll detection.
            thread::sleep(Duration::from_millis(1200));
            if !has_substantive_content(tab) {
                let wait_secs = if params.render_wait > 0 { params.render_wait } else { 3 };
                thread::sleep(Duration::from_secs(wait_secs));
            }
            if detect_infinite_scroll(tab) {
                scroll_tab(tab, params.scroll_count, params.scroll_delay)?;
                thread::sleep(Duration::from_millis(1000));
            }
        }
        "fast" => thread::sleep(Duration::from_millis(1200)),
        "patient" => {
            if let Some(selector) = &params.selector {
                tab.wait_for_element(selector)
                    .with_context(|| format!("selector '{selector}' did not appear"))?;
            } else {
                thread::sleep(Duration::from_millis(1200));
            }
            if params.render_wait > 0 {
                thread::sleep(Duration::from_secs(params.render_wait));
            }
        }
        "spa" => {
            let wait_secs = if params.render_wait > 0 { params.render_wait } else { 3 };
            thread::sleep(Duration::from_millis(wait_secs * 1000 + 500));
        }
        "scroll" => {
            scroll_tab(tab, params.scroll_count, params.scroll_delay)?;
            thread::sleep(Duration::from_millis(1000));
        }
        _ => thread::sleep(Duration::from_millis(1200)),
    }
    Ok(challenge_info)
}

fn scroll_tab(tab: &Tab, scroll_count: u32, scroll_delay: u64) -> Result<()> {
    let script = format!(
        "(async () => {{
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            for (let i = 0; i < {}; i++) {{
                window.scrollBy(0, window.innerHeight + Math.floor(Math.random() * 400 + 100));
                await wait({} + Math.floor(Math.random() * 300));
            }}
            window.scrollTo(0, 0);
            return true;
        }})()",
        scroll_count, scroll_delay
    );
    tab.evaluate(&script, true).context("failed during scroll")?;
    Ok(())
}

fn has_substantive_content(tab: &Tab) -> bool {
    match tab.evaluate("(document.body && document.body.innerText || '').trim().length >= 200", true) {
        Ok(remote) => remote.value.and_then(|val| val.as_bool()).unwrap_or(false),
        Err(_) => false,
    }
}

fn detect_infinite_scroll(tab: &Tab) -> bool {
    let js = "(() => { const s = document.querySelectorAll(\"[data-pagination], [data-load-more], [data-infinite-scroll], .infinite-scroll, .load-more, #load-more, [role='feed']\"); if (s.length > 0) return true; const feed = document.querySelector(\"[class*='feed'], [class*='Feed'], main\"); return Boolean(feed) && document.documentElement.scrollHeight > window.innerHeight * 3; })()";
    match tab.evaluate(js, true) {
        Ok(remote) => remote.value.and_then(|val| val.as_bool()).unwrap_or(false),
        Err(_) => false,
    }
}

fn persist_artifacts(tab: &Tab, params: &NormalizedEngineRequest) -> Result<ArtifactMeta> {
    let screenshot_path = if let Some(path) = &params.screenshot_path {
        let bytes = tab
            .capture_screenshot(Page::CaptureScreenshotFormatOption::Png, None, None, true)
            .context("failed to capture screenshot")?;
        write_binary(path, &bytes)?;
        Some(path.to_string_lossy().to_string())
    } else {
        None
    };

    let pdf_path = if let Some(path) = &params.pdf_path {
        let bytes = tab.print_to_pdf(None).context("failed to render PDF")?;
        write_binary(path, &bytes)?;
        Some(path.to_string_lossy().to_string())
    } else {
        None
    };

    Ok(ArtifactMeta {
        screenshot_path,
        pdf_path,
    })
}

fn extract_page_content(tab: &Tab, verbose: bool) -> Result<PageContent> {
    let noise = serde_json::to_string(NOISE_SELECTORS).expect("noise selectors should serialize");
    let script = format!(
        "(function() {{
            const isVerbose = {};
            const noiseSels = {};
            const clone = document.cloneNode(true);
            if (!isVerbose) {{
                for (const sel of noiseSels) {{
                    clone.querySelectorAll(sel).forEach((el) => el.remove());
                }}
            }}
            const title = document.title || '';
            const url = window.location.href || '';
            const html = clone.documentElement ? clone.documentElement.outerHTML : document.documentElement.outerHTML;
            const body = clone.body || clone.documentElement;
            const text = ((body && (body.innerText || body.textContent)) || '')
                .replace(/\\n{{3,}}/g, '\\n\\n')
                .trim();
            const links = Array.from(document.querySelectorAll('a[href]'))
                .map((anchor) => ({{
                    text: (anchor.textContent || '').trim().substring(0, 200),
                    href: anchor.href,
                }}))
                .filter((link) => link.href && link.href.startsWith('http'));
            const meta = {{}};
            document.querySelectorAll('meta[property], meta[name]').forEach((node) => {{
                const key = node.getAttribute('property') || node.getAttribute('name');
                const value = node.getAttribute('content');
                if (key && value) {{
                    meta[key] = value;
                }}
            }});
            return JSON.stringify({{ title, url, text, html, links, meta }});
        }})()",
        if verbose { "true" } else { "false" },
        noise
    );

    let remote = tab
        .evaluate(&script, false)
        .context("failed to extract page content")?;
    let value = remote
        .value
        .ok_or_else(|| anyhow!("page extraction returned no value"))?;
    let json = value
        .as_str()
        .ok_or_else(|| anyhow!("page extraction returned non-string payload"))?;
    serde_json::from_str(json).context("failed to parse page extraction payload")
}

fn inspect_search_page(tab: &Tab) -> Result<SearchPageSnapshot> {
    let script = "(function() { return JSON.stringify({ title: document.title || '', url: window.location.href || '', text: (document.body && document.body.innerText ? document.body.innerText : '').substring(0, 6000) }); })()";
    let remote = tab
        .evaluate(script, false)
        .context("failed to inspect search page")?;
    let value = remote
        .value
        .ok_or_else(|| anyhow!("search inspection returned no value"))?;
    let json = value
        .as_str()
        .ok_or_else(|| anyhow!("search inspection returned non-string payload"))?;
    serde_json::from_str(json).context("failed to parse search inspection payload")
}

fn extract_search_results_for_engine(
    tab: &Tab,
    engine: &str,
    count: u32,
) -> Result<Vec<RawSearchResult>> {
    let script = format!(
        "(function() {{
            const maxResults = {};
            const engine = '{}';
            const results = [];
            const push = (title, url, snippet) => {{
                if (results.length >= maxResults) return;
                results.push({{ title: title || '', url: url || '', snippet: snippet || '' }});
            }};
            if (engine === 'duckduckgo') {{
                const blocks = document.querySelectorAll('.result, .result__body');
                for (const block of blocks) {{
                    if (results.length >= maxResults) break;
                    const link = block.querySelector('a.result__a, .result__title a[href], a[href]');
                    if (!link || !link.href) continue;
                    const snippet = block.querySelector('.result__snippet, .result__extras');
                    push(link.textContent, link.href, snippet ? snippet.textContent : '');
                }}
            }} else if (engine === 'bing') {{
                const blocks = document.querySelectorAll('li.b_algo, .b_algo');
                for (const block of blocks) {{
                    if (results.length >= maxResults) break;
                    const link = block.querySelector('h2 a[href], a[href]');
                    if (!link || !link.href) continue;
                    const snippet = block.querySelector('.b_caption p, .b_snippet, p');
                    push(link.textContent, link.href, snippet ? snippet.textContent : '');
                }}
            }} else if (engine === 'brave') {{
                const blocks = document.querySelectorAll('.snippet, .result, .fdb, article');
                for (const block of blocks) {{
                    if (results.length >= maxResults) break;
                    const link = block.querySelector(\"h2 a[href], h3 a[href], a[data-testid='result-title-a'], a[href]\");
                    if (!link || !link.href) continue;
                    const snippet = block.querySelector('p, .snippet-description, .snippet-content');
                    push(link.textContent, link.href, snippet ? snippet.textContent : '');
                }}
            }} else if (engine === 'google') {{
                const blocks = document.querySelectorAll('[data-sokoban-container], .g, [class*=\\'kp-blk\\']');
                for (const block of blocks) {{
                    if (results.length >= maxResults) break;
                    const title = block.querySelector('h3');
                    const link = block.querySelector('a[href]');
                    const snippet = block.querySelector('[data-sncf], [style*=\"-webkit-line-clamp\"], .VwiC3b, span[style]');
                    if (!title || !link || !link.href) continue;
                    push(title.textContent, link.href, snippet ? snippet.textContent : '');
                }}
            }} else {{
                const anchors = document.querySelectorAll('main a[href], #search a[href], [role=\\'main\\'] a[href]');
                for (const anchor of anchors) {{
                    if (results.length >= maxResults) break;
                    const href = anchor.href;
                    const text = (anchor.textContent || '').trim();
                    if (!href || !href.startsWith('http') || text.length < 8) continue;
                    const container = anchor.closest('article, li, div, section') || anchor.parentElement;
                    const snippet = container ? container.querySelector('p') : null;
                    push(text, href, snippet ? snippet.textContent : '');
                }}
            }}
            return JSON.stringify(results);
        }})()",
        count, engine
    );

    let remote = tab
        .evaluate(&script, false)
        .with_context(|| format!("failed to extract search results for {engine}"))?;
    let value = remote
        .value
        .ok_or_else(|| anyhow!("search extraction returned no value"))?;
    let json = value
        .as_str()
        .ok_or_else(|| anyhow!("search extraction returned non-string payload"))?;
    serde_json::from_str(json).context("failed to parse search results payload")
}

fn normalize_search_results(
    engine: &str,
    raw_results: Vec<RawSearchResult>,
    count: u32,
) -> Vec<SearchResultItem> {
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::new();

    for raw in raw_results {
        if normalized.len() >= count as usize {
            break;
        }

        let raw_url = clean_text(raw.url.unwrap_or_default());
        if !raw_url.starts_with("http") {
            continue;
        }

        let url = decode_search_result_url(engine, &raw_url);
        if !url.starts_with("http") || !seen.insert(url.clone()) {
            continue;
        }

        let title = {
            let cleaned = clean_text(raw.title.unwrap_or_default());
            if cleaned.is_empty() {
                url.clone()
            } else {
                cleaned
            }
        };

        normalized.push(SearchResultItem {
            title,
            url,
            snippet: clean_text(raw.snippet.unwrap_or_default()),
        });
    }

    normalized
}

fn set_tab_cookies(tab: &Tab, params: &NormalizedEngineRequest, target_url: &str) -> Result<()> {
    if params.cookies.is_empty() {
        return Ok(());
    }

    let cookies = params
        .cookies
        .iter()
        .cloned()
        .map(|mut cookie| {
            if cookie.url.is_none() && cookie.domain.is_none() {
                cookie.url = Some(target_url.to_string());
            }
            cookie
        })
        .collect::<Vec<_>>();
    tab.set_cookies(cookies).context("failed to set cookies")
}

fn fingerprint_meta(fingerprint: &FingerprintProfile) -> FingerprintMeta {
    FingerprintMeta {
        user_agent: fingerprint.user_agent.clone(),
        viewport: fingerprint.viewport.clone(),
        locale: fingerprint.locale.clone(),
        timezone: fingerprint.timezone.clone(),
    }
}

fn build_stealth_script(fingerprint: &FingerprintProfile) -> String {
    format!(
        "(() => {{
            Object.defineProperty(navigator, 'webdriver', {{ get: () => false }});
            Object.defineProperty(navigator, 'platform', {{ get: () => '{}' }});
            Object.defineProperty(navigator, 'language', {{ get: () => '{}' }});
            Object.defineProperty(navigator, 'languages', {{ get: () => ['{}', 'en'] }});
            Object.defineProperty(navigator, 'hardwareConcurrency', {{ get: () => {} }});
            Object.defineProperty(navigator, 'deviceMemory', {{ get: () => {} }});
            Object.defineProperty(navigator, 'maxTouchPoints', {{ get: () => {} }});
            Object.defineProperty(screen, 'width', {{ get: () => {} }});
            Object.defineProperty(screen, 'height', {{ get: () => {} }});
            Object.defineProperty(screen, 'availWidth', {{ get: () => {} }});
            Object.defineProperty(screen, 'availHeight', {{ get: () => {} }});
            Object.defineProperty(screen, 'colorDepth', {{ get: () => {} }});
            Object.defineProperty(screen, 'pixelDepth', {{ get: () => {} }});
            window.chrome = window.chrome || {{ runtime: {{}} }};
            const overrideWebGl = (prototype) => {{
                if (!prototype || !prototype.getParameter) return;
                const original = prototype.getParameter;
                prototype.getParameter = function(parameter) {{
                    if (parameter === 37445) return '{}';
                    if (parameter === 37446) return '{}';
                    return original.call(this, parameter);
                }};
            }};
            overrideWebGl(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
            overrideWebGl(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
        }})()",
        escape_js(&fingerprint.platform),
        escape_js(&fingerprint.locale),
        escape_js(&fingerprint.locale),
        fingerprint.hardware_concurrency,
        fingerprint.device_memory,
        fingerprint.max_touch_points,
        fingerprint.viewport.width,
        fingerprint.viewport.height,
        fingerprint.viewport.width,
        fingerprint.screen_avail_height,
        fingerprint.color_depth,
        fingerprint.pixel_depth,
        escape_js(&fingerprint.webgl_vendor),
        escape_js(&fingerprint.webgl_renderer),
    )
}

/// Cross-platform Chrome/Chromium/Edge discovery. Honors the CHROME env var
/// first, then probes well-known install locations for Windows, macOS, and
/// Linux (point 10: the prior version was Windows-only, silently failing on
/// other platforms).
fn detect_browser_path() -> Option<PathBuf> {
    let from_env = std::env::var("CHROME")
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.exists());
    if from_env.is_some() {
        return from_env;
    }

    [
        // Windows
        PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        PathBuf::from(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
        // macOS (Chrome + Chromium + Edge)
        PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        // Linux (common Chrome + Chromium install paths)
        PathBuf::from("/usr/bin/google-chrome"),
        PathBuf::from("/usr/bin/google-chrome-stable"),
        PathBuf::from("/usr/bin/chromium"),
        PathBuf::from("/usr/bin/chromium-browser"),
        PathBuf::from("/snap/bin/chromium"),
    ]
    .into_iter()
    .find(|path| path.exists())
}

fn write_binary(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    fs::write(path, bytes).with_context(|| format!("failed to write {}", path.display()))
}

fn close_tab_session(tab: &Tab) {
    let _ = tab.close(false);
    thread::sleep(Duration::from_millis(150));
}

fn format_elapsed(duration: Duration) -> String {
    format!("{:.2}", duration.as_secs_f64())
}

fn clean_text(value: String) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn escape_js(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n")
}

fn browser_launch_error(message: &str) -> EngineResponse {
    EngineResponse {
        success: false,
        output: None,
        format: None,
        meta: None,
        error_code: Some("BROWSER_LAUNCH".to_string()),
        error: Some(format!(
            "Browser launch failed: {message}. Ensure Chrome/Chromium is installed."
        )),
    }
}

fn upstream_error(message: &str) -> EngineResponse {
    EngineResponse {
        success: false,
        output: None,
        format: None,
        meta: None,
        error_code: Some("UPSTREAM_REQUEST".to_string()),
        error: Some(message.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_search_results_and_deduplicates() {
        let normalized = normalize_search_results(
            "duckduckgo",
            vec![
                RawSearchResult {
                    title: Some("Example".to_string()),
                    url: Some(
                        "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com".to_string(),
                    ),
                    snippet: Some("Snippet".to_string()),
                },
                RawSearchResult {
                    title: Some("Duplicate".to_string()),
                    url: Some("https://example.com".to_string()),
                    snippet: Some("Snippet".to_string()),
                },
            ],
            10,
        );

        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].url, "https://example.com");
    }
}
