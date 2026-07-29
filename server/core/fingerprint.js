export const USER_AGENTS = [
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

export const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 2560, height: 1440 },
  { width: 1680, height: 1050 },
  { width: 1600, height: 900 },
  { width: 1280, height: 800 },
  { width: 1280, height: 1024 },
];

export const LOCALES = [
  "en-US", "en-GB", "en-CA", "en-AU",
  "en-NZ", "en-IE", "en-ZA",
];

export const TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Toronto", "America/Vancouver", "Europe/London", "Europe/Dublin",
  "Australia/Sydney", "Pacific/Auckland",
];

export const PLATFORMS = ["Win32", "MacIntel", "Linux x86_64"];

export const NOISE_SELECTORS = [
  "nav", "footer", "header", "[role='navigation']", "[role='banner']",
  "[role='contentinfo']", ".ad", ".ads", ".advertisement", ".sidebar",
  ".cookie-banner", ".cookie-notice", ".popup", ".modal", ".overlay",
  "#cookie-banner", "#cookie-notice", ".social-share", ".share-buttons",
  ".related-posts", ".comments", ".newsletter", ".subscribe",
  "script", "style", "noscript", "iframe", "svg",
];

export const METHODS = {
  direct: "Load page, wait for network idle, extract",
  wait: "Wait for specific CSS selector before extracting",
  scroll: "Infinite scroll - keeps scrolling to load all content",
  timed: "Wait a fixed number of seconds before extracting",
  spa: "Single-page app - wait for render, handle client-side routing",
};

export const FORMATS = ["text", "html", "markdown", "json", "links"];

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Coherent WebGL vendor/renderer pairs. Anti-bot ML models specifically look
 * for impossible hardware combinations (e.g., Apple GPU vendor with NVIDIA
 * ANGLE Direct3D11 renderer — impossible on any real device). These pairs are
 * picked together so the vendor always matches the renderer's GPU vendor.
 *
 * The Direct3D11 renderers are Windows-only (ANGLE on Mac uses Metal, on Linux
 * uses OpenGL). The pick is platform-aware so the renderer matches the OS
 * implied by the User-Agent.
 */
const WEBGL_PROFILES = {
  windows: [
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0)" },
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)" },
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)" },
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)" },
    { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0)" },
    { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0)" },
  ],
  mac: [
    { vendor: "Google Inc. (Apple)", renderer: "Apple GPU" },
    { vendor: "Google Inc. (Apple)", renderer: "Apple M1" },
    { vendor: "Google Inc. (Intel)", renderer: "Intel Inc., Intel(R) Iris(TM) Plus Graphics 645" },
  ],
  linux: [
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER OpenGL ES 3.2)" },
    { vendor: "Google Inc. (Intel)", renderer: "Mesa Intel(R) UHD Graphics 630 (CFL GT2)" },
    { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 580 OpenGL ES 3.2)" },
  ],
};

export function generateFingerprint() {
  const ua = pick(USER_AGENTS);
  const vp = pick(VIEWPORTS);
  const locale = pick(LOCALES);
  const tz = pick(TIMEZONES);
  const platform = ua.includes("Windows") ? "Win32"
    : ua.includes("Mac") ? "MacIntel"
    : ua.includes("Linux") ? "Linux x86_64"
    : pick(PLATFORMS);

  // Pick a coherent WebGL profile matching the platform (Windows→Direct3D11,
  // Mac→Metal/Apple GPU, Linux→OpenGL). Prevents impossible combinations.
  const webglProfileSet = platform === "Win32" ? WEBGL_PROFILES.windows
    : platform === "MacIntel" ? WEBGL_PROFILES.mac
    : WEBGL_PROFILES.linux;
  const webgl = pick(webglProfileSet);

  return {
    userAgent: ua,
    viewport: vp,
    locale,
    timezone: tz,
    platform,
    webgl: { vendor: webgl.vendor, renderer: webgl.renderer },
    colorDepth: pick([24, 30, 32]),
    deviceMemory: pick([2, 4, 8, 16]),
    hardwareConcurrency: pick([2, 4, 6, 8, 12, 16]),
    touchSupport: Math.random() > 0.6
      ? { maxTouchPoints: randomInt(1, 10) }
      : { maxTouchPoints: 0 },
    screen: {
      width: vp.width,
      height: vp.height,
      availWidth: vp.width,
      availHeight: vp.height - randomInt(0, 80),
      colorDepth: pick([24, 30, 32]),
      pixelDepth: pick([24, 30, 32]),
    },
  };
}
