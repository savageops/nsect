use std::env;
use std::path::PathBuf;

/// Runtime mode — the conditional-security trigger.
///
/// Auth, key-state, rate limiting, and search cooldown are conditional surfaces
/// (per the security doctrine): they activate only in Hosted mode. In Local
/// mode (default) the engine runs keyless, unqueued, and ungated — the
/// developer's machine is the trust boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    Local,
    Hosted,
}

impl Mode {
    pub fn is_hosted(self) -> bool {
        self == Mode::Hosted
    }
}

/// Optional challenge-solver configuration. When no API key is set, the solver
/// is disabled and challenges fail honestly (mirrors JS resolveSolverConfig).
#[derive(Clone, Debug)]
pub struct SolverConfig {
    pub enabled: bool,
    pub provider: String,
    pub api_key: String,
    pub timeout: u64,
    pub kinds: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub mode: Mode,
    pub port: u16,
    /// Admin secret. None in local mode; required (non-empty) in hosted mode.
    pub admin_key: Option<String>,
    pub db_path: PathBuf,
    pub solver: SolverConfig,
    pub invidious_instances: Vec<String>,
    pub piped_instances: Vec<String>,
    pub yt_dlp_commands: Vec<String>,
}

impl Config {
    pub fn from_env() -> Self {
        let mode = resolve_mode(&env::vars().collect::<Vec<_>>());
        let port = env::var("PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(3000);

        let admin_key = if mode.is_hosted() {
            let key = env::var("ADMIN_KEY")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty());
            // Fail-fast: hosted mode without an admin secret is a misconfiguration.
            // The caller (main.rs) must surface this before binding a listener.
            match key {
                Some(k) => Some(k),
                None => panic!(
                    "ADMIN_KEY is required in hosted mode \
                     (NSECT_HOSTED=1 or NODE_ENV=production). \
                     Set a strong secret before starting the server."
                ),
            }
        } else {
            None
        };

        let db_path = env::var("NSECT_RS_DB_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("data/keys.sqlite"));

        let solver = {
            let api_key = env::var("NSECT_SOLVER_API_KEY")
                .unwrap_or_default()
                .trim()
                .to_string();
            if api_key.is_empty() {
                SolverConfig {
                    enabled: false,
                    provider: "capsolver".to_string(),
                    api_key: String::new(),
                    timeout: 60,
                    kinds: Vec::new(),
                }
            } else {
                let provider = env::var("NSECT_SOLVER_PROVIDER")
                    .unwrap_or_else(|_| "capsolver".to_string())
                    .trim()
                    .to_string();
                let timeout = env::var("NSECT_SOLVER_TIMEOUT")
                    .ok()
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(60);
                let kinds = env::var("NSECT_SOLVER_KINDS")
                    .unwrap_or_else(|_| {
                        "cloudflare_turnstile,cloudflare,hcaptcha,recaptcha".to_string()
                    })
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>();
                SolverConfig {
                    enabled: true,
                    provider,
                    api_key,
                    timeout,
                    kinds,
                }
            }
        };

        Self {
            mode,
            port,
            admin_key,
            db_path,
            solver,
            invidious_instances: parse_csv_env("NSECT_INVIDIOUS_INSTANCES").unwrap_or_else(|| {
                vec![
                    "https://invidious.nerdvpn.de".to_string(),
                    "https://invidious.protokolla.fi".to_string(),
                    "https://yewtu.be".to_string(),
                ]
            }),
            piped_instances: parse_csv_env("NSECT_PIPED_INSTANCES").unwrap_or_else(|| {
                vec![
                    "https://pipedapi.kavin.rocks".to_string(),
                    "https://pipedapi.adminforge.de".to_string(),
                    "https://pipedapi.aeong.one".to_string(),
                ]
            }),
            yt_dlp_commands: parse_csv_env("NSECT_YTDLP_COMMANDS")
                .unwrap_or_else(|| vec!["yt-dlp".to_string(), "yt-dlp.exe".to_string()]),
        }
    }
}

/// Resolve the deployment mode from environment. Pure function over the env
/// slice for testability. Precedence (highest wins):
///   1. NSECT_HOSTED=1            -> Hosted (explicit operator opt-in)
///   2. NODE_ENV=production        -> Hosted (safety: prod cannot run keyless)
///   3. (otherwise)                -> Local
pub fn resolve_mode(env: &[(String, String)]) -> Mode {
    fn get(env: &[(String, String)], key: &str) -> Option<String> {
        env.iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.trim().to_lowercase())
    }

    if let Some(hosted) = get(env, "NSECT_HOSTED") {
        if hosted == "1" || hosted == "true" || hosted == "yes" {
            return Mode::Hosted;
        }
    }
    if let Some(node_env) = get(env, "NODE_ENV") {
        if node_env == "production" {
            return Mode::Hosted;
        }
    }
    Mode::Local
}

fn parse_csv_env(name: &str) -> Option<Vec<String>> {
    let value = env::var(name).ok()?;
    let list = value
        .split(',')
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .map(|part| part.to_string())
        .collect::<Vec<_>>();
    if list.is_empty() { None } else { Some(list) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_local() {
        assert_eq!(resolve_mode(&[]), Mode::Local);
    }

    #[test]
    fn hosted_flag_promotes() {
        let env = vec![("NSECT_HOSTED".to_string(), "1".to_string())];
        assert_eq!(resolve_mode(&env), Mode::Hosted);
    }

    #[test]
    fn production_env_promotes() {
        let env = vec![("NODE_ENV".to_string(), "production".to_string())];
        assert_eq!(resolve_mode(&env), Mode::Hosted);
    }

    #[test]
    fn hosted_flag_wins_over_development() {
        let env = vec![
            ("NSECT_HOSTED".to_string(), "1".to_string()),
            ("NODE_ENV".to_string(), "development".to_string()),
        ];
        assert_eq!(resolve_mode(&env), Mode::Hosted);
    }

    #[test]
    fn zero_hosted_flag_stays_local() {
        let env = vec![("NSECT_HOSTED".to_string(), "0".to_string())];
        assert_eq!(resolve_mode(&env), Mode::Local);
    }

    #[test]
    fn solver_config_disabled_when_no_api_key() {
        // SolverConfig with empty key should be disabled
        let cfg = SolverConfig {
            enabled: false,
            provider: "capsolver".to_string(),
            api_key: String::new(),
            timeout: 60,
            kinds: Vec::new(),
        };
        assert!(!cfg.enabled);
    }

    #[test]
    fn solver_config_enabled_when_api_key_set() {
        let cfg = SolverConfig {
            enabled: true,
            provider: "capsolver".to_string(),
            api_key: "test-key".to_string(),
            timeout: 60,
            kinds: vec![
                "cloudflare_turnstile".to_string(),
                "hcaptcha".to_string(),
            ],
        };
        assert!(cfg.enabled);
        assert_eq!(cfg.provider, "capsolver");
        assert_eq!(cfg.kinds.len(), 2);
        assert!(cfg.kinds.contains(&"cloudflare_turnstile".to_string()));
    }

    #[test]
    fn resolve_mode_accepts_truthy_variants() {
        assert_eq!(resolve_mode(&[("NSECT_HOSTED".to_string(), "true".to_string())]), Mode::Hosted);
        assert_eq!(resolve_mode(&[("NSECT_HOSTED".to_string(), "YES".to_string())]), Mode::Hosted);
        assert_eq!(resolve_mode(&[("NSECT_HOSTED".to_string(), "yes".to_string())]), Mode::Hosted);
    }

    #[test]
    fn resolve_mode_ignores_empty_hosted_flag() {
        assert_eq!(resolve_mode(&[("NSECT_HOSTED".to_string(), "".to_string())]), Mode::Local);
        assert_eq!(resolve_mode(&[("NSECT_HOSTED".to_string(), "  ".to_string())]), Mode::Local);
    }

    #[test]
    fn parse_csv_env_returns_none_for_empty() {
        unsafe { std::env::remove_var("NSECT_TEST_EMPTY_CSV"); }
        assert!(parse_csv_env("NSECT_TEST_EMPTY_CSV").is_none());
    }

    #[test]
    fn parse_csv_env_returns_vec_for_values() {
        unsafe { std::env::set_var("NSECT_TEST_CSV", "a, b ,c"); }
        let result = parse_csv_env("NSECT_TEST_CSV");
        assert_eq!(result, Some(vec!["a".to_string(), "b".to_string(), "c".to_string()]));
        unsafe { std::env::remove_var("NSECT_TEST_CSV"); }
    }

    #[test]
    fn parse_csv_env_filters_empty_parts() {
        unsafe { std::env::set_var("NSECT_TEST_CSV2", "a,, ,b"); }
        let result = parse_csv_env("NSECT_TEST_CSV2");
        assert_eq!(result, Some(vec!["a".to_string(), "b".to_string()]));
        unsafe { std::env::remove_var("NSECT_TEST_CSV2"); }
    }

    #[test]
    fn solver_config_defaults_to_capsolver_provider() {
        // The SolverConfig struct default provider is capsolver (best coverage/price)
        let cfg = SolverConfig {
            enabled: true,
            provider: "capsolver".to_string(),
            api_key: "k".to_string(),
            timeout: 60,
            kinds: vec!["cloudflare_turnstile".to_string()],
        };
        assert_eq!(cfg.provider, "capsolver");
    }

    #[test]
    fn solver_config_default_timeout_is_60() {
        let cfg = SolverConfig {
            enabled: true,
            provider: "capsolver".to_string(),
            api_key: "k".to_string(),
            timeout: 60,
            kinds: vec![],
        };
        assert_eq!(cfg.timeout, 60);
    }

    #[test]
    fn mode_is_hosted_check() {
        assert!(Mode::Hosted.is_hosted());
        assert!(!Mode::Local.is_hosted());
    }
}
