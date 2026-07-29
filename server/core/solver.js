/**
 * Challenge-solver integration (CapSolver / 2Captcha / Anti-Captcha).
 *
 * Solves interactive challenges (Cloudflare Turnstile, hCaptcha, reCAPTCHA)
 * that the challenge layer detects but cannot self-resolve. Uses the standard
 * createTask → poll getTaskResult API contract shared by all three providers —
 * no SDK dependency, just plain fetch POSTs.
 *
 * Activation is opt-in: if no solver API key is configured, the solver is
 * disabled and challenges fail honestly with CHALLENGE_BLOCKED (no behavior
 * change for users without a solver). PX "press and hold" is NOT API-solvable
 * — it requires proxy + fingerprint, which the engine handles separately.
 *
 * Cost reality (2026): Turnstile ~$1.20-1.45/1k solves, ~5-15s latency.
 * The token is UA-bound: the solver returns the worker's userAgent, which must
 * be set on the page before injecting the token or validation fails.
 */

const ENDPOINTS = {
  capsolver: {
    create: "https://api.capsolver.com/createTask",
    result: "https://api.capsolver.com/getTaskResult",
  },
  twocaptcha: {
    create: "https://api.2captcha.com/createTask",
    result: "https://api.2captcha.com/getTaskResult",
  },
  anticaptcha: {
    create: "https://api.anti-captcha.com/createTask",
    result: "https://api.anti-captcha.com/getTaskResult",
  },
};

/**
 * Map nsect's challenge.js kind → solver task type, per provider.
 * Only API-solvable kinds are listed; PX/datadome-press-and-hold are excluded.
 */
const TASK_TYPES = {
  capsolver: {
    cloudflare_turnstile: "AntiTurnstileTaskProxyLess",
    cloudflare: "AntiTurnstileTaskProxyLess",
    hcaptcha: "HCaptchaTaskProxyLess",
    recaptcha: "RecaptchaV2TaskProxyless",
  },
  twocaptcha: {
    cloudflare_turnstile: "TurnstileTaskProxyless",
    cloudflare: "TurnstileTaskProxyless",
    hcaptcha: "HCaptchaTaskProxyless",
    recaptcha: "RecaptchaV2TaskProxyless",
  },
  anticaptcha: {
    cloudflare_turnstile: "TurnstileTaskProxyless",
    cloudflare: "TurnstileTaskProxyless",
    hcaptcha: "HCaptchaTaskProxyless",
    recaptcha: "RecaptchaV2TaskProxyless",
  },
};

/**
 * Solver-eligible challenge kinds. PX (press-and-hold), DataDome slider, and
 * generic blocks are NOT API-solvable — they need proxy + fingerprint.
 */
export function isSolverEligible(kind) {
  return ["cloudflare_turnstile", "cloudflare", "hcaptcha", "recaptcha"].includes(kind);
}

/**
 * Extract the site key from the page for the given challenge kind.
 * The sitekey is a data attribute on the challenge widget element.
 *
 * @param {import("puppeteer").Page} page
 * @param {string} kind
 * @returns {Promise<string|null>}
 */
async function extractSiteKey(page, kind) {
  const selectors = {
    cloudflare_turnstile: [".cf-turnstile[data-sitekey]", "iframe[src*='challenges.cloudflare.com']"],
    cloudflare: [".cf-turnstile[data-sitekey]", "iframe[src*='challenges.cloudflare.com']", "#cf-challenge"],
    hcaptcha: [".h-captcha[data-sitekey]", "iframe[src*='hcaptcha']"],
    recaptcha: [".g-recaptcha[data-sitekey]", "#recaptcha[data-sitekey]"],
  };
  const sel = selectors[kind] || [];
  return page.evaluate((sels) => {
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const key = el.dataset?.sitekey || el.getAttribute("data-sitekey");
      if (key) return key;
      // For iframe-based widgets, parse the sitekey from the src URL.
      const src = el.src || el.getAttribute("src") || "";
      const match = src.match(/[?&]sitekey=([^&]+)/) || src.match(/captcha\.cloudflare\.com\/([a-f0-9x]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
    // Broader fallback: search ALL script srcs + data attributes for the
    // Cloudflare Turnstile sitekey pattern (0x4AAAAAAA...) and the generic
    // data-sitekey attribute. Managed challenges inject the sitekey via JS,
    // so it may not be on a widget element — search the full page source.
    const html = document.documentElement.outerHTML;
    // Cloudflare Turnstile sitekeys start with 0x followed by A's and alphanumerics.
    const cfMatch = html.match(/(0x[0-9a-fA-F]{6,})/);
    if (cfMatch) return cfMatch[1];
    const genericMatch = html.match(/data-sitekey="([^"]+)"/);
    return genericMatch ? genericMatch[1] : null;
  }, sel).catch(() => null);
}

/**
 * Solve an interactive challenge via the configured provider.
 *
 * @param {import("puppeteer").Page} page
 * @param {{ kind: string, label: string }} challengeInfo
 * @param {{ provider: string, apiKey: string, timeout?: number }} cfg
 * @returns {Promise<{ token: string, userAgent?: string }>}
 */
export async function solveChallenge(page, challengeInfo, cfg) {
  const { provider = "capsolver", apiKey, timeout = 60 } = cfg;
  if (!apiKey) throw new SolverError("Solver API key not configured.", "SOLVER_NO_KEY");
  const endpoints = ENDPOINTS[provider];
  if (!endpoints) throw new SolverError(`Unknown solver provider: ${provider}`, "SOLVER_BAD_PROVIDER");

  const taskType = TASK_TYPES[provider]?.[challengeInfo.kind];
  if (!taskType) throw new SolverError(`No solver task type for challenge kind: ${challengeInfo.kind}`, "SOLVER_UNSUPPORTED_KIND");

  const websiteURL = page.url();
  const websiteKey = await extractSiteKey(page, challengeInfo.kind);
  if (!websiteKey) throw new SolverError("Could not extract site key from the challenge page.", "SOLVER_NO_SITEKEY");

  // Create the task.
  const createBody = JSON.stringify({
    clientKey: apiKey,
    task: { type: taskType, websiteURL, websiteKey },
  });
  const createResp = await fetch(endpoints.create, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: createBody,
  });
  const createData = await createResp.json();
  if (createData.errorId) {
    throw new SolverError(createData.errorDescription || "Solver createTask failed.", "SOLVER_CREATE_FAILED");
  }
  const taskId = createData.taskId;
  if (!taskId) throw new SolverError("Solver returned no taskId.", "SOLVER_NO_TASK");

  // Poll for the result (up to timeout seconds).
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const resultResp = await fetch(endpoints.result, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const resultData = await resultResp.json();
    if (resultData.errorId) {
      throw new SolverError(resultData.errorDescription || "Solver getTaskResult failed.", "SOLVER_RESULT_FAILED");
    }
    if (resultData.status === "ready") {
      const solution = resultData.solution || {};
      const token = solution.token || solution.gRecaptchaResponse;
      if (!token) throw new SolverError("Solver returned ready but no token.", "SOLVER_NO_TOKEN");
      return { token, userAgent: solution.userAgent };
    }
  }
  throw new SolverError(`Solver timed out after ${timeout}s.`, "SOLVER_TIMEOUT");
}

/**
 * Inject a solved token into the page and let the challenge clear.
 *
 * @param {import("puppeteer").Page} page
 * @param {string} kind
 * @param {string} token
 */
export async function injectSolution(page, kind, token) {
  await page.evaluate((k, t) => {
    // Set the hidden response field for all challenge types.
    const selectors = [
      'input[name="cf-turnstile-response"]',
      'input[name="g-recaptcha-response"]',
      "textarea#g-recaptcha-response",
      'textarea[name="g-recaptcha-response"]',
      'textarea[name="h-captcha-response"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) el.value = t;
    }
    // For Turnstile widgets, call the registered callback if present.
    if (window.turnstile && typeof window.turnstile.reset === "function") {
      try { window.turnstile.reset(); } catch { /* ignore */ }
    }
  }, kind, token).catch(() => {});

  // Wait for the page to process the token (navigation or async validation).
  await new Promise((r) => setTimeout(r, 3000));
  await page.waitForNetworkIdle({ timeout: 10_000 }).catch(() => {});
}

/**
 * Attempt to solve an interactive challenge end-to-end: solve, align UA, inject.
 * Returns true if the challenge appears resolved after injection.
 *
 * @param {import("puppeteer").Page} page
 * @param {{ kind: string, label: string }} challengeInfo
 * @param {{ provider: string, apiKey: string, timeout?: number, userAgent?: string }} cfg
 * @param {{ setUserAgent: Function }} fp  The current fingerprint (for UA reset)
 * @returns {Promise<{ resolved: boolean, solved: boolean, token?: string }>}
 */
export async function attemptSolve(page, challengeInfo, cfg, fp) {
  const { token, userAgent } = await solveChallenge(page, challengeInfo, cfg);

  // The token is bound to the solver worker's UA — align before injecting.
  if (userAgent && userAgent !== fp.userAgent) {
    try {
      await page.setUserAgent(userAgent);
    } catch { /* best-effort */ }
  }

  await injectSolution(page, challengeInfo.kind, token);
  return { resolved: true, solved: true, token };
}

export class SolverError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "SolverError";
    this.code = code;
  }
}
