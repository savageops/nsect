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

#[derive(Clone, Debug)]
pub struct Config {
    pub mode: Mode,
    pub port: u16,
    /// Admin secret. None in local mode; required (non-empty) in hosted mode.
    pub admin_key: Option<String>,
    pub db_path: PathBuf,
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

        Self {
            mode,
            port,
            admin_key,
            db_path,
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
}
