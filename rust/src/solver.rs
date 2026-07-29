//! Challenge-solver integration (CapSolver / 2Captcha / Anti-Captcha).
//!
//! Mirrors `server/core/solver.js`. Solves interactive challenges (Cloudflare
//! Turnstile, hCaptcha, reCAPTCHA) that the challenge layer detects but cannot
//! self-resolve. Uses the standard createTask → poll getTaskResult API contract
//! shared by all three providers — plain HTTP, no SDK dependency.
//!
//! Activation is opt-in: if no solver API key is configured, the solver is
//! disabled and challenges fail honestly with CHALLENGE_BLOCKED. PX "press and
//! hold" is NOT API-solvable — it requires proxy + fingerprint, which the engine
//! handles separately.

use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use headless_chrome::browser::tab::Tab;
use serde::Deserialize;
use serde_json::json;

/// Solver provider endpoints.
fn endpoints(provider: &str) -> Option<(&'static str, &'static str)> {
    match provider {
        "capsolver" => Some((
            "https://api.capsolver.com/createTask",
            "https://api.capsolver.com/getTaskResult",
        )),
        "twocaptcha" => Some((
            "https://api.2captcha.com/createTask",
            "https://api.2captcha.com/getTaskResult",
        )),
        "anticaptcha" => Some((
            "https://api.anti-captcha.com/createTask",
            "https://api.anti-captcha.com/getTaskResult",
        )),
        _ => None,
    }
}

/// Map challenge kind → solver task type per provider.
fn task_type(provider: &str, kind: &str) -> Option<&'static str> {
    match (provider, kind) {
        ("capsolver", "cloudflare_turnstile") | ("capsolver", "cloudflare") => {
            Some("AntiTurnstileTaskProxyLess")
        }
        ("capsolver", "hcaptcha") => Some("HCaptchaTaskProxyLess"),
        ("capsolver", "recaptcha") => Some("RecaptchaV2TaskProxyless"),
        ("twocaptcha", "cloudflare_turnstile") | ("twocaptcha", "cloudflare") => {
            Some("TurnstileTaskProxyless")
        }
        ("twocaptcha", "hcaptcha") => Some("HCaptchaTaskProxyless"),
        ("twocaptcha", "recaptcha") => Some("RecaptchaV2TaskProxyless"),
        ("anticaptcha", "cloudflare_turnstile") | ("anticaptcha", "cloudflare") => {
            Some("TurnstileTaskProxyless")
        }
        ("anticaptcha", "hcaptcha") => Some("HCaptchaTaskProxyless"),
        ("anticaptcha", "recaptcha") => Some("RecaptchaV2TaskProxyless"),
        _ => None,
    }
}

/// Solver-eligible challenge kinds. PX/datadome-press-and-hold are excluded.
pub fn is_solver_eligible(kind: &str) -> bool {
    matches!(
        kind,
        "cloudflare_turnstile" | "cloudflare" | "hcaptcha" | "recaptcha"
    )
}

/// Extract the site key from the page for the given challenge kind.
fn extract_site_key(tab: &Tab, kind: &str) -> Result<Option<String>> {
    let selectors: &[&str] = match kind {
        "cloudflare_turnstile" | "cloudflare" => &[
            ".cf-turnstile[data-sitekey]",
            "iframe[src*='challenges.cloudflare.com']",
        ],
        "hcaptcha" => &[".h-captcha[data-sitekey]", "iframe[src*='hcaptcha']"],
        "recaptcha" => &[".g-recaptcha[data-sitekey]", "#recaptcha[data-sitekey]"],
        _ => &[],
    };

    let selectors_json = serde_json::to_string(selectors).unwrap_or_default();
    let js = format!(
        r#"(() => {{
            const sels = {selectors_json};
            for (const sel of sels) {{
                const el = document.querySelector(sel);
                if (!el) continue;
                const key = el.dataset?.sitekey || el.getAttribute('data-sitekey');
                if (key) return key;
                const src = el.src || el.getAttribute('src') || '';
                const m = src.match(/[?&]sitekey=([^&]+)/) || src.match(/captcha\.cloudflare\.com\/([a-f0-9x]+)/);
                if (m) return decodeURIComponent(m[1]);
            }}
            const html = document.documentElement.outerHTML;
            const cf = html.match(/(0x[0-9a-fA-F]{{6,}})/);
            if (cf) return cf[1];
            const gen = html.match(/data-sitekey="([^"]+)"/);
            return gen ? gen[1] : null;
        }})()"#
    );

    match tab.evaluate(&js, true) {
        Ok(remote) => {
            let val = remote.value.as_ref().and_then(|v| v.as_str());
            Ok(val.map(|s| s.to_string()))
        }
        Err(_) => Ok(None),
    }
}

/// The solution returned by the solver.
pub struct Solution {
    pub token: String,
    pub user_agent: Option<String>,
}

/// Solve an interactive challenge via the configured provider.
pub async fn solve_challenge(
    tab: &Tab,
    kind: &str,
    provider: &str,
    api_key: &str,
    timeout_secs: u64,
) -> Result<Solution> {
    let (create_url, result_url) = endpoints(provider)
        .ok_or_else(|| anyhow!("Unknown solver provider: {provider}"))?;

    let task_t = task_type(provider, kind)
        .ok_or_else(|| anyhow!("No solver task type for kind: {kind}"))?;

    let website_url = tab.get_url();
    let website_key = extract_site_key(tab, kind)?
        .ok_or_else(|| anyhow!("Could not extract site key from the challenge page"))?;

    // Create the task.
    let create_body = json!({
        "clientKey": api_key,
        "task": {
            "type": task_t,
            "websiteURL": website_url,
            "websiteKey": website_key,
        }
    });

    let create_resp: SolverResponse = http_post_json(create_url, &create_body).await?;
    if create_resp.error_id != 0 {
        bail!(
            "Solver createTask failed: {}",
            create_resp.error_description.unwrap_or_default()
        );
    }
    let task_id = create_resp.task_id.ok_or_else(|| anyhow!("Solver returned no taskId"))?;

    // Poll for the result.
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let result_body = json!({ "clientKey": api_key, "taskId": task_id });
        let result_resp: SolverResponse = http_post_json(result_url, &result_body).await?;
        if result_resp.error_id != 0 {
            bail!(
                "Solver getTaskResult failed: {}",
                result_resp.error_description.unwrap_or_default()
            );
        }
        if result_resp.status.as_deref() == Some("ready") {
            let sol = result_resp.solution.unwrap_or_default();
            let token = sol.token.or(sol.g_recaptcha_response)
                .ok_or_else(|| anyhow!("Solver returned ready but no token"))?;
            return Ok(Solution {
                token,
                user_agent: sol.user_agent,
            });
        }
    }
    bail!("Solver timed out after {timeout_secs}s")
}

/// Inject a solved token into the page.
pub fn inject_solution(tab: &Tab, _kind: &str, token: &str) -> Result<()> {
    let js = format!(
        r#"(() => {{
            const t = {token_json};
            const sels = [
                'input[name="cf-turnstile-response"]',
                'input[name="g-recaptcha-response"]',
                'textarea#g-recaptcha-response',
                'textarea[name="g-recaptcha-response"]',
                'textarea[name="h-captcha-response"]',
            ];
            for (const sel of sels) {{
                const el = document.querySelector(sel);
                if (el) el.value = t;
            }}
        }})()"#,
        token_json = serde_json::to_string(token).unwrap_or_default()
    );
    let _ = tab.evaluate(&js, true);
    // Wait for the page to process the token.
    std::thread::sleep(Duration::from_secs(3));
    Ok(())
}

/// Attempt to solve an interactive challenge end-to-end.
pub async fn attempt_solve(
    tab: &Tab,
    kind: &str,
    provider: &str,
    api_key: &str,
    timeout_secs: u64,
) -> Result<bool> {
    let solution = solve_challenge(tab, kind, provider, api_key, timeout_secs).await?;
    inject_solution(tab, kind, &solution.token)?;
    Ok(true)
}

// --- HTTP helper ---

#[derive(Deserialize)]
struct SolverResponse {
    #[serde(default)]
    error_id: i64,
    #[serde(default)]
    error_description: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    solution: Option<SolverSolution>,
}

#[derive(Deserialize, Default)]
struct SolverSolution {
    #[serde(default)]
    token: Option<String>,
    #[serde(default, rename = "gRecaptchaResponse")]
    g_recaptcha_response: Option<String>,
    #[serde(default)]
    user_agent: Option<String>,
}

async fn http_post_json(url: &str, body: &serde_json::Value) -> Result<SolverResponse> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let resp = client.post(url).json(body).send().await?;
    let solver_resp: SolverResponse = resp.json().await?;
    Ok(solver_resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_solver_eligible_for_api_solvable_kinds() {
        assert!(is_solver_eligible("cloudflare_turnstile"));
        assert!(is_solver_eligible("cloudflare"));
        assert!(is_solver_eligible("hcaptcha"));
        assert!(is_solver_eligible("recaptcha"));
    }

    #[test]
    fn is_solver_eligible_rejects_non_api_kinds() {
        assert!(!is_solver_eligible("perimeterx"));
        assert!(!is_solver_eligible("datadome"));
        assert!(!is_solver_eligible("blocked"));
        assert!(!is_solver_eligible("akamai"));
        assert!(!is_solver_eligible("generic"));
        assert!(!is_solver_eligible("unknown"));
    }

    #[test]
    fn endpoints_returns_known_providers() {
        assert!(endpoints("capsolver").is_some());
        assert!(endpoints("twocaptcha").is_some());
        assert!(endpoints("anticaptcha").is_some());
        assert!(endpoints("fakeprovider").is_none());
    }

    #[test]
    fn task_type_maps_correctly_for_capsolver() {
        assert_eq!(
            task_type("capsolver", "cloudflare_turnstile"),
            Some("AntiTurnstileTaskProxyLess")
        );
        assert_eq!(
            task_type("capsolver", "hcaptcha"),
            Some("HCaptchaTaskProxyLess")
        );
        assert_eq!(
            task_type("capsolver", "recaptcha"),
            Some("RecaptchaV2TaskProxyless")
        );
    }

    #[test]
    fn task_type_maps_correctly_for_twocaptcha() {
        assert_eq!(
            task_type("twocaptcha", "cloudflare"),
            Some("TurnstileTaskProxyless")
        );
        assert_eq!(
            task_type("twocaptcha", "hcaptcha"),
            Some("HCaptchaTaskProxyless")
        );
    }

    #[test]
    fn task_type_returns_none_for_unsupported_combo() {
        assert!(task_type("capsolver", "perimeterx").is_none());
        assert!(task_type("fakeprovider", "cloudflare_turnstile").is_none());
        assert!(task_type("capsolver", "unknown_kind").is_none());
    }
}
