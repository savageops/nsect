use rand::Rng;
use serde::Serialize;

pub const NOISE_SELECTORS: &[&str] = &[
    "nav",
    "footer",
    "header",
    "[role='navigation']",
    "[role='banner']",
    "[role='contentinfo']",
    ".ad",
    ".ads",
    ".advertisement",
    ".sidebar",
    ".cookie-banner",
    ".cookie-notice",
    ".popup",
    ".modal",
    ".overlay",
    "#cookie-banner",
    "#cookie-notice",
    ".social-share",
    ".share-buttons",
    ".related-posts",
    ".comments",
    ".newsletter",
    ".subscribe",
    "script",
    "style",
    "noscript",
    "iframe",
    "svg",
];

pub const SUPPORTED_METHODS: &[&str] = &["direct", "wait", "scroll", "timed", "spa"];
pub const SUPPORTED_FORMATS: &[&str] = &["text", "html", "markdown", "json", "links"];

pub const METHOD_HELP: &[(&str, &str)] = &[
    ("direct", "Load page, wait for navigation, extract"),
    ("wait", "Wait for specific CSS selector before extracting"),
    ("scroll", "Infinite scroll style loading before extracting"),
    ("timed", "Wait a fixed number of seconds before extracting"),
    ("spa", "Single-page app loading with render wait"),
];

const USER_AGENTS: &[&str] = &[
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
];

const VIEWPORTS: &[(u32, u32)] = &[
    (1920, 1080),
    (1366, 768),
    (1536, 864),
    (1440, 900),
    (1280, 720),
    (2560, 1440),
    (1680, 1050),
    (1600, 900),
    (1280, 800),
    (1280, 1024),
];

const LOCALES: &[&str] = &[
    "en-US", "en-GB", "en-CA", "en-AU", "en-NZ", "en-IE", "en-ZA",
];
const TIMEZONES: &[&str] = &[
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Toronto",
    "America/Vancouver",
    "Europe/London",
    "Europe/Dublin",
    "Australia/Sydney",
    "Pacific/Auckland",
];
const PLATFORMS: &[&str] = &["Win32", "MacIntel", "Linux x86_64"];

/// Coherent WebGL vendor/renderer pairs, grouped by platform. Anti-bot ML
/// models look for impossible hardware combinations (e.g. Apple GPU vendor
/// with NVIDIA ANGLE Direct3D11 renderer). Picking vendor and renderer
/// together as a matched pair prevents this — mirrors the JS fingerprint.js
/// WEBGL_PROFILES fix.
struct WebglProfile {
    vendor: &'static str,
    renderer: &'static str,
}

const WEBGL_WINDOWS: &[WebglProfile] = &[
    WebglProfile {
        vendor: "Google Inc. (NVIDIA)",
        renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0)",
    },
    WebglProfile {
        vendor: "Google Inc. (NVIDIA)",
        renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)",
    },
    WebglProfile {
        vendor: "Google Inc. (Intel)",
        renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)",
    },
    WebglProfile {
        vendor: "Google Inc. (Intel)",
        renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)",
    },
    WebglProfile {
        vendor: "Google Inc. (AMD)",
        renderer: "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0)",
    },
    WebglProfile {
        vendor: "Google Inc. (AMD)",
        renderer: "ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0)",
    },
];

const WEBGL_MAC: &[WebglProfile] = &[
    WebglProfile { vendor: "Google Inc. (Apple)", renderer: "Apple GPU" },
    WebglProfile { vendor: "Google Inc. (Apple)", renderer: "Apple M1" },
    WebglProfile { vendor: "Google Inc. (Intel)", renderer: "Intel Inc., Intel(R) Iris(TM) Plus Graphics 645" },
];

const WEBGL_LINUX: &[WebglProfile] = &[
    WebglProfile {
        vendor: "Google Inc. (NVIDIA)",
        renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER OpenGL ES 3.2)",
    },
    WebglProfile {
        vendor: "Google Inc. (Intel)",
        renderer: "Mesa Intel(R) UHD Graphics 630 (CFL GT2)",
    },
    WebglProfile {
        vendor: "Google Inc. (AMD)",
        renderer: "ANGLE (AMD, AMD Radeon RX 580 OpenGL ES 3.2)",
    },
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct FingerprintProfile {
    pub user_agent: String,
    pub viewport: Viewport,
    pub locale: String,
    pub timezone: String,
    pub platform: String,
    pub webgl_vendor: String,
    pub webgl_renderer: String,
    pub color_depth: u32,
    pub pixel_depth: u32,
    pub device_memory: u32,
    pub hardware_concurrency: u32,
    pub max_touch_points: u32,
    pub screen_avail_height: u32,
}

pub fn generate_fingerprint() -> FingerprintProfile {
    let user_agent = pick_str(USER_AGENTS);
    let (width, height) = pick_tuple(VIEWPORTS);
    let locale = pick_str(LOCALES);
    let timezone = pick_str(TIMEZONES);
    let platform = if user_agent.contains("Windows") {
        "Win32".to_string()
    } else if user_agent.contains("Mac") {
        "MacIntel".to_string()
    } else if user_agent.contains("Linux") {
        "Linux x86_64".to_string()
    } else {
        pick_str(PLATFORMS)
    };

    let mut rng = rand::rng();
    let max_touch_points = if rng.random_bool(0.4) {
        rng.random_range(1..=10)
    } else {
        0
    };

    // Pick a coherent WebGL profile matching the platform (Windows→Direct3D11,
    // Mac→Metal/Apple GPU, Linux→OpenGL). Prevents impossible combinations.
    let webgl_profiles: &[WebglProfile] = if platform == "Win32" {
        WEBGL_WINDOWS
    } else if platform == "MacIntel" {
        WEBGL_MAC
    } else {
        WEBGL_LINUX
    };
    let webgl_idx = rand::rng().random_range(0..webgl_profiles.len());
    let webgl_profile = &webgl_profiles[webgl_idx];

    FingerprintProfile {
        user_agent,
        viewport: Viewport { width, height },
        locale,
        timezone,
        platform,
        webgl_vendor: webgl_profile.vendor.to_string(),
        webgl_renderer: webgl_profile.renderer.to_string(),
        color_depth: pick_num(&[24, 30, 32]),
        pixel_depth: pick_num(&[24, 30, 32]),
        device_memory: pick_num(&[2, 4, 8, 16]),
        hardware_concurrency: pick_num(&[2, 4, 6, 8, 12, 16]),
        max_touch_points,
        screen_avail_height: height.saturating_sub(rng.random_range(0..=80)),
    }
}

pub fn random_int(min: u64, max: u64) -> u64 {
    rand::rng().random_range(min..=max)
}

fn pick_str(values: &[&str]) -> String {
    let index = rand::rng().random_range(0..values.len());
    values[index].to_string()
}

fn pick_num(values: &[u32]) -> u32 {
    let index = rand::rng().random_range(0..values.len());
    values[index]
}

fn pick_tuple(values: &[(u32, u32)]) -> (u32, u32) {
    let index = rand::rng().random_range(0..values.len());
    values[index]
}
