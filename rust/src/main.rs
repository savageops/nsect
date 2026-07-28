use std::{fs, path::PathBuf};

use anyhow::Result;
use clap::{Args, Parser, Subcommand};
use nsect_rs::{
    AppState, build_app,
    config::Config,
    engine::run_nsect_engine,
    fingerprint::{METHOD_HELP, SUPPORTED_FORMATS},
    request::{
        CookiesInput, EngineNormalizationOptions, EngineRequestInput, HeadersInput,
        StringListInput, normalize_engine_request,
    },
    transcript::{
        StringListInput as TranscriptMethodInput, TranscriptInput, fetch_youtube_transcript,
    },
};
use tracing_subscriber::{EnvFilter, fmt};

const ROOT_HELP: &str = "\
Native Rust runtime for Nsect

Usage:
  nsect-rs.exe [COMMAND]

Default behavior:
  Running nsect-rs.exe with no command starts the HTTP API server.

Commands:
  serve               Run the HTTP API server
  engine              Run the Nsect engine against a page URL or search query
  transcribe-youtube  Fetch a YouTube transcript with ordered adapter fallback
  help                Print help for a command

Global options:
  -h, --help          Print this help text
  -V, --version       Print version

Examples:
  nsect-rs.exe
  nsect-rs.exe serve
  nsect-rs.exe engine --url https://example.com --format markdown --metadata
  nsect-rs.exe engine --query \"open source crawling frameworks\" --search-engines duckduckgo,bing,brave,google
  nsect-rs.exe transcribe-youtube --video-id dQw4w9WgXcQ --format json --include-segments

Key environment variables:
  PORT                HTTP bind port for serve mode
  ADMIN_KEY           Admin route key for /api/keys/*
  NSECT_RS_DB_PATH   SQLite database path for the Rust runtime
";

const SERVE_HELP: &str = "\
Run the HTTP API server

Usage:
  nsect-rs.exe serve

Behavior:
  Boots the local Axum server with health, key lifecycle, engine, and YouTube transcript routes.

Environment variables:
  PORT                HTTP bind port for the server
  ADMIN_KEY           Admin route key for /api/keys/*
  NSECT_RS_DB_PATH   SQLite database path for the Rust runtime

Examples:
  nsect-rs.exe serve
";

const ENGINE_HELP: &str = "\
Run the Nsect engine against a page URL or search query

Usage:
  nsect-rs.exe engine [OPTIONS]

Modes:
  Page extraction     Use --url
  Search extraction   Use --query or --google

Options:
  --url <URL>                         Absolute page URL to extract
  --query <QUERY>                     Search query for multi-engine search mode
  --google <GOOGLE>                   Legacy alias for --query
  --method <METHOD>                   Page load strategy: direct | wait | scroll | timed | spa (default: direct)
  --format <FORMAT>                   Output format: text | html | markdown | json | links (default: text)
  --verbose                           Keep noisy page regions in extraction output
  --selector <SELECTOR>               CSS selector to wait for when using wait mode
  --timeout <SECONDS>                 Maximum navigation or extraction time in seconds (default: 30)
  --scroll-count <COUNT>              Number of scroll steps in scroll mode (default: 20)
  --scroll-delay <MS>                 Delay between scroll steps in milliseconds (default: 800)
  --delay <MS>                        Pre-navigation delay in milliseconds (default: 1000)
  --google-count <COUNT>              Maximum normalized search results to keep (default: 10)
  --search-engines <LIST>             Comma-delimited search engine order
  --proxy <URL>                       Upstream proxy URL
  --cookies <JSON>                    Cookies JSON payload
  --headers <JSON>                    Headers JSON payload
  --headless                          Keep the browser headless (default)
  --no-headless                       Show the browser window during execution
  --screenshot <PATH>                 Write a full-page PNG screenshot
  --pdf <PATH>                        Write a PDF render
  --list-links                        Include discovered links in page metadata
  --metadata                          Print structured execution metadata to stderr
  --output <PATH>                     Write formatted output to disk
  -h, --help                          Print this help text

Search engines:
  duckduckgo, bing, brave, google
  Google is always forced to the final attempt when included.

Notes:
  --selector is required when using --method wait against page URLs.
  --output writes the formatted payload to disk.

Examples:
  nsect-rs.exe engine --url https://example.com --format markdown
  nsect-rs.exe engine --url https://news.ycombinator.com --method wait --selector a.storylink --format links
  nsect-rs.exe engine --query \"best rust web crawler\" --format json --search-engines duckduckgo,bing,brave,google
  nsect-rs.exe engine --url https://example.com --screenshot out/page.png --pdf out/page.pdf --output out/page.txt
";

const TRANSCRIPT_HELP: &str = "\
Fetch a YouTube transcript with ordered adapter fallback

Usage:
  nsect-rs.exe transcribe-youtube [OPTIONS]

Required locator:
  --url <URL> or --video-id <VIDEO_ID>

Options:
  --url <URL>                         YouTube watch URL to transcribe
  --video-id <VIDEO_ID>               11-character YouTube video ID
  --language <LANGUAGE>               Preferred transcript language tag (default: en)
  --format <FORMAT>                   Output format: text | json | markdown (default: text)
  --timeout <SECONDS>                 Maximum transcript fetch time in seconds (default: 20)
  --include-segments                  Include timestamped segments in the response
  --include-auto-captions             Allow auto-generated captions when manual subtitles are unavailable
  --methods <LIST>                    Comma-delimited adapter order override
  --output <PATH>                     Write formatted transcript output to disk
  -h, --help                          Print this help text

Methods:
  nsect_native, nsect_signal, invidious, piped, yt_dlp

Notes:
  Adapters run in order until one succeeds.
  --include-segments keeps timestamped segment data in the JSON payload.
  --output writes the formatted transcript payload to disk.

Examples:
  nsect-rs.exe transcribe-youtube --video-id dQw4w9WgXcQ --format text
  nsect-rs.exe transcribe-youtube --url https://www.youtube.com/watch?v=dQw4w9WgXcQ --format json --include-segments
  nsect-rs.exe transcribe-youtube --video-id dQw4w9WgXcQ --methods nsect_native,nsect_signal,yt_dlp
  nsect-rs.exe transcribe-youtube --video-id dQw4w9WgXcQ --format json --output out/transcript.json
";

#[derive(Debug, Parser)]
#[command(name = "nsect-rs")]
#[command(
    about = "Native Rust runtime for Nsect",
    override_help = ROOT_HELP,
    version
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    #[command(
        about = "Run the HTTP API server",
        long_about = "Start the Axum HTTP server with health, key lifecycle, engine, and YouTube transcript routes.",
        override_help = SERVE_HELP
    )]
    Serve,
    #[command(
        about = "Run the Nsect engine against a page URL or search query",
        long_about = "Execute the browser-backed Nsect engine directly from the CLI for page extraction, search fallback, screenshots, PDFs, and saved output.",
        override_help = ENGINE_HELP
    )]
    Engine(EngineArgs),
    #[command(
        about = "Fetch a YouTube transcript with ordered adapter fallback",
        long_about = "Resolve a YouTube transcript from a video URL or video ID using the same adapter chain exposed by the HTTP API.",
        override_help = TRANSCRIPT_HELP
    )]
    TranscribeYoutube {
        #[arg(
            long,
            help = "YouTube watch URL to transcribe",
            long_help = "Absolute YouTube watch URL. Provide this or --video-id."
        )]
        url: Option<String>,
        #[arg(
            long = "video-id",
            help = "11-character YouTube video ID",
            long_help = "Direct YouTube video ID. Provide this or --url."
        )]
        video_id: Option<String>,
        #[arg(
            long,
            default_value = "en",
            help = "Preferred transcript language",
            long_help = "Preferred transcript language tag such as en or en-US."
        )]
        language: String,
        #[arg(
            long,
            default_value = "text",
            help = "Output format",
            long_help = "Transcript output format. Accepted values: text, json, markdown."
        )]
        format: String,
        #[arg(
            long,
            default_value_t = 20,
            help = "Transcript timeout in seconds",
            long_help = "Maximum transcript fetch time in seconds. Accepted range: 5 to 120."
        )]
        timeout: u64,
        #[arg(
            long = "include-segments",
            default_value_t = false,
            help = "Include timestamped segments in the response"
        )]
        include_segments: bool,
        #[arg(
            long = "include-auto-captions",
            default_value_t = true,
            help = "Allow auto-generated captions when manual subtitles are unavailable"
        )]
        include_auto_captions: bool,
        #[arg(
            long = "methods",
            value_delimiter = ',',
            help = "Comma-delimited adapter order override",
            long_help = "Override transcript adapter order. Accepted values: nsect_native, nsect_signal, invidious, piped, yt_dlp."
        )]
        methods: Vec<String>,
        #[arg(long, help = "Write formatted transcript output to this file path")]
        output: Option<PathBuf>,
    },
}

#[derive(Debug, Args)]
#[command(next_help_heading = "Engine Options")]
struct EngineArgs {
    #[arg(
        long,
        help = "Target page URL",
        long_help = "Absolute page URL to extract. Use this for page crawling mode."
    )]
    url: Option<String>,
    #[arg(
        long,
        help = "Search query text",
        long_help = "Search query for multi-engine search mode. Use this or the legacy --google alias instead of --url."
    )]
    query: Option<String>,
    #[arg(
        long,
        help = "Legacy alias for --query",
        long_help = "Legacy alias for --query. Useful for compatibility with existing payloads and scripts."
    )]
    google: Option<String>,
    #[arg(
        long,
        default_value = "direct",
        help = "Page load strategy",
        long_help = "Extraction strategy. Accepted values: direct, wait, scroll, timed, spa."
    )]
    method: String,
    #[arg(
        long,
        default_value = "text",
        help = "Output format",
        long_help = "Formatted engine output. Accepted values: text, html, markdown, json, links."
    )]
    format: String,
    #[arg(
        long,
        default_value_t = false,
        help = "Keep noisy page regions in extraction output"
    )]
    verbose: bool,
    #[arg(
        long,
        help = "CSS selector to wait for",
        long_help = "CSS selector that must appear before extraction continues. Required when using --method wait against page URLs."
    )]
    selector: Option<String>,
    #[arg(
        long,
        default_value_t = 30,
        help = "Timeout in seconds",
        long_help = "Maximum navigation or extraction time in seconds. Accepted range: 1 to 180."
    )]
    timeout: i64,
    #[arg(
        long = "scroll-count",
        default_value_t = 20,
        help = "Number of scroll steps for scroll mode"
    )]
    scroll_count: i64,
    #[arg(
        long = "scroll-delay",
        default_value_t = 800,
        help = "Delay in milliseconds between scroll steps"
    )]
    scroll_delay: i64,
    #[arg(
        long,
        default_value_t = 1000,
        help = "Pre-navigation delay in milliseconds"
    )]
    delay: i64,
    #[arg(
        long = "google-count",
        default_value_t = 10,
        help = "Maximum search results to keep",
        long_help = "Maximum number of normalized results to keep in search mode. Accepted range: 1 to 50."
    )]
    google_count: i64,
    #[arg(
        long = "search-engines",
        value_delimiter = ',',
        help = "Comma-delimited search engine order",
        long_help = "Search engine order for fallback mode. Accepted values: duckduckgo, bing, brave, google. Google is always forced to the final attempt when included."
    )]
    search_engines: Vec<String>,
    #[arg(long, help = "Upstream proxy URL")]
    proxy: Option<String>,
    #[arg(
        long,
        help = "Cookies JSON payload",
        long_help = "Cookies as JSON text. Use the same shape accepted by the HTTP API request contract."
    )]
    cookies: Option<String>,
    #[arg(
        long,
        help = "Headers JSON payload",
        long_help = "Extra HTTP headers as JSON text. Use the same shape accepted by the HTTP API request contract."
    )]
    headers: Option<String>,
    #[arg(
        long,
        default_value_t = true,
        help = "Keep the browser headless",
        long_help = "Run the browser without a visible UI window. This is the default behavior."
    )]
    headless: bool,
    #[arg(
        long = "no-headless",
        default_value_t = false,
        help = "Show the browser window during execution",
        long_help = "Disable headless mode and show the browser window while the engine runs."
    )]
    no_headless: bool,
    #[arg(long, help = "Write a full-page PNG screenshot to this path")]
    screenshot: Option<PathBuf>,
    #[arg(long, help = "Write a PDF render to this path")]
    pdf: Option<PathBuf>,
    #[arg(
        long = "list-links",
        default_value_t = false,
        help = "Include discovered links in page metadata"
    )]
    list_links: bool,
    #[arg(
        long,
        default_value_t = false,
        help = "Print structured execution metadata to stderr"
    )]
    metadata: bool,
    #[arg(long, help = "Write formatted output to this file path")]
    output: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();
    let config = Config::from_env();
    let state = AppState::new(config.clone())?;

    match cli.command.unwrap_or(Commands::Serve) {
        Commands::Serve => serve(state, config.port).await,
        Commands::Engine(args) => run_engine_cli(args).await,
        Commands::TranscribeYoutube {
            url,
            video_id,
            language,
            format,
            timeout,
            include_segments,
            include_auto_captions,
            methods,
            output,
        } => {
            let result = fetch_youtube_transcript(
                TranscriptInput {
                    url,
                    video_id,
                    language: Some(language),
                    format: Some(format),
                    timeout: Some(timeout),
                    include_segments: Some(include_segments),
                    include_auto_captions: Some(include_auto_captions),
                    methods: if methods.is_empty() {
                        None
                    } else {
                        Some(TranscriptMethodInput::Many(methods))
                    },
                },
                std::sync::Arc::new(state),
            )
            .await
            .map_err(|error| anyhow::anyhow!("{} ({})", error.message, error.field))?;
            if !result.success {
                eprintln!(
                    "[error] {}",
                    result
                        .error
                        .unwrap_or_else(|| "Transcript fetch failure".to_string())
                );
                std::process::exit(1);
            }
            let transcript_output = result.output.unwrap_or_default();
            if let Some(path) = output {
                write_output_file(&path, &transcript_output)?;
                eprintln!("[meta] Output saved: {}", path.display());
            } else {
                println!("{transcript_output}");
            }
            Ok(())
        }
    }
}

async fn serve(state: AppState, port: u16) -> Result<()> {
    let app = build_app(state);
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!(%address, "nsect-rs server listening");
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn run_engine_cli(args: EngineArgs) -> Result<()> {
    let input = EngineRequestInput {
        url: args.url,
        query: args.query,
        google: args.google,
        // The CLI --method arg is the legacy alias; the normalizer maps it to a
        // strategy. Leave `strategy` unset so the normalizer resolves it.
        method: Some(args.method.clone()),
        format: Some(args.format.clone()),
        verbose: Some(args.verbose),
        selector: args.selector,
        timeout: Some(args.timeout),
        scroll_count: Some(args.scroll_count),
        scroll_delay: Some(args.scroll_delay),
        delay: Some(args.delay),
        max_results: Some(args.google_count),
        search_engines: if args.search_engines.is_empty() {
            None
        } else {
            Some(StringListInput::Many(args.search_engines))
        },
        engines: None,
        proxy: args.proxy,
        cookies: args.cookies.map(CookiesInput::String),
        headers: args.headers.map(HeadersInput::String),
        list_links: Some(args.list_links),
        screenshot_path: args
            .screenshot
            .as_ref()
            .map(|path| path.display().to_string()),
        screenshot: None,
        pdf_path: args.pdf.as_ref().map(|path| path.display().to_string()),
        pdf: None,
        headless: Some(args.headless),
        no_headless: Some(args.no_headless),
        ..EngineRequestInput::default()
    };

    let params = normalize_engine_request(
        input,
        EngineNormalizationOptions {
            allow_file_output: true,
            allow_headful: true,
        },
    )
    .map_err(|error| anyhow::anyhow!("{}", error.message))?;

    let result = run_nsect_engine(params).await;
    if !result.success {
        eprintln!(
            "[error] {}",
            result.error.unwrap_or_else(|| "Engine failure".to_string())
        );
        std::process::exit(1);
    }

    if args.metadata {
        print_metadata(&result);
    }

    let output_value = result.output.unwrap_or(serde_json::Value::Null);
    // Render: strings print directly; structured values pretty-print as JSON.
    let output_string = match &output_value {
        serde_json::Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other)?,
    };
    if let Some(path) = args.output {
        write_output_file(&path, &output_string)?;
        if args.metadata {
            eprintln!("[meta] Output saved: {}", path.display());
        }
    } else {
        println!("{output_string}");
    }

    Ok(())
}

fn write_output_file(path: &PathBuf, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    Ok(())
}

fn print_metadata(result: &nsect_rs::engine::EngineResponse) {
    let Some(meta) = result.meta.as_ref() else {
        return;
    };

    match meta {
        nsect_rs::engine::EngineMeta::Page(meta) => {
            eprintln!("[meta] Method: page");
            eprintln!("[meta] Format: page");
            eprintln!("[meta] Target: {}", meta.url);
            eprintln!("[meta] Elapsed: {}s", meta.elapsed);
            eprintln!("[meta] Title: {}", meta.title);
            eprintln!("[meta] URL: {}", meta.url);
            eprintln!("[meta] Text length: {}", meta.text_length);
            eprintln!("[meta] Links found: {}", meta.links_found);
            eprintln!(
                "[meta] Fingerprint: {}...",
                meta.fingerprint
                    .user_agent
                    .chars()
                    .take(60)
                    .collect::<String>()
            );
            eprintln!(
                "[meta] Viewport: {}x{}",
                meta.fingerprint.viewport.width, meta.fingerprint.viewport.height
            );
            eprintln!("[meta] Locale: {}", meta.fingerprint.locale);
            eprintln!("[meta] Timezone: {}", meta.fingerprint.timezone);
        }
        nsect_rs::engine::EngineMeta::Search(meta) => {
            eprintln!("[meta] Method: search");
            eprintln!("[meta] Format: search");
            eprintln!("[meta] Search query: {}", meta.query);
            eprintln!("[meta] Elapsed: {}s", meta.elapsed);
            eprintln!(
                "[meta] Search engine: {}",
                meta.engine.clone().unwrap_or_else(|| "(none)".to_string())
            );
            eprintln!("[meta] Search results: {}", meta.result_count);
            for attempt in &meta.attempts {
                let status = if let Some(error) = &attempt.error {
                    format!("error:{error}")
                } else {
                    attempt.reason.clone()
                };
                eprintln!(
                    "[meta] Attempt: {} => {} ({})",
                    attempt.engine, status, attempt.result_count
                );
            }
            eprintln!(
                "[meta] Fingerprint: {}...",
                meta.fingerprint
                    .user_agent
                    .chars()
                    .take(60)
                    .collect::<String>()
            );
            eprintln!(
                "[meta] Viewport: {}x{}",
                meta.fingerprint.viewport.width, meta.fingerprint.viewport.height
            );
            eprintln!("[meta] Locale: {}", meta.fingerprint.locale);
            eprintln!("[meta] Timezone: {}", meta.fingerprint.timezone);
        }
    }
}

#[allow(dead_code)]
fn _supported_engine_help() -> String {
    let methods = METHOD_HELP
        .iter()
        .map(|(method, help)| format!("  {method:<10} - {help}"))
        .collect::<Vec<_>>()
        .join("\n");
    let formats = SUPPORTED_FORMATS
        .iter()
        .map(|format| format!("  {format}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("METHODS:\n{methods}\n\nFORMATS:\n{formats}")
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,headless_chrome::browser::transport=error"));
    let _ = fmt().with_env_filter(filter).try_init();
}
