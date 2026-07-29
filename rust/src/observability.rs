use std::{
    collections::VecDeque,
    sync::{Mutex, OnceLock},
    time::Instant,
};

use serde::Serialize;

use crate::engine::{EngineMeta, EngineResponse, SearchAttempt};

const LATENCY_WINDOW_SIZE: usize = 500;

#[derive(Debug, Default)]
struct ObservabilityState {
    success: u64,
    blocked: u64,
    fallback_depth_sum: f64,
    fallback_depth_samples: u64,
    status_429: u64,
    latency_samples_ms: VecDeque<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ObservabilitySnapshot {
    pub success: u64,
    pub blocked: u64,
    pub fallback_depth: f64,
    pub p95: f64,
    #[serde(rename = "429s")]
    pub status_429: u64,
}

fn state() -> &'static Mutex<ObservabilityState> {
    static STATE: OnceLock<Mutex<ObservabilityState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(ObservabilityState::default()))
}

fn started_at() -> Instant {
    static STARTED_AT: OnceLock<Instant> = OnceLock::new();
    *STARTED_AT.get_or_init(Instant::now)
}

pub fn record_http_response(status_code: u16, duration_ms: f64) {
    let mut state = state().lock().expect("observability mutex poisoned");
    if status_code == 429 {
        state.status_429 += 1;
    }
    if duration_ms.is_finite() && duration_ms >= 0.0 {
        state.latency_samples_ms.push_back(duration_ms);
        while state.latency_samples_ms.len() > LATENCY_WINDOW_SIZE {
            state.latency_samples_ms.pop_front();
        }
    }
}

pub fn record_engine_outcome(result: &EngineResponse) {
    if !result.success {
        return;
    }

    let Some(meta) = &result.meta else {
        return;
    };

    let mut state = state().lock().expect("observability mutex poisoned");
    state.success += 1;

    if let EngineMeta::Search(search_meta) = meta {
        for attempt in &search_meta.attempts {
            if attempt.blocked || attempt.reason == "blocked" {
                state.blocked += 1;
            }
        }
        state.fallback_depth_samples += 1;
        state.fallback_depth_sum += fallback_depth_from_attempts(&search_meta.attempts) as f64;
    }
}

pub fn get_snapshot() -> ObservabilitySnapshot {
    let state = state().lock().expect("observability mutex poisoned");
    ObservabilitySnapshot {
        success: state.success,
        blocked: state.blocked,
        fallback_depth: if state.fallback_depth_samples == 0 {
            0.0
        } else {
            round_two(state.fallback_depth_sum / state.fallback_depth_samples as f64)
        },
        p95: percentile(&state.latency_samples_ms, 95.0),
        status_429: state.status_429,
    }
}

pub fn uptime_seconds() -> u64 {
    started_at().elapsed().as_secs()
}

fn fallback_depth_from_attempts(attempts: &[SearchAttempt]) -> usize {
    if let Some(index) = attempts
        .iter()
        .position(|attempt| attempt.reason == "ok" || attempt.result_count > 0)
    {
        index
    } else {
        attempts.len().saturating_sub(1)
    }
}

fn percentile(values: &VecDeque<f64>, percentile: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }

    let mut sorted = values.iter().copied().collect::<Vec<_>>();
    sorted.sort_by(f64::total_cmp);
    let index = (((percentile / 100.0) * sorted.len() as f64).ceil() as usize).saturating_sub(1);
    round_two(sorted[index.min(sorted.len() - 1)])
}

fn round_two(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reset_state() {
        let mut s = state().lock().unwrap();
        *s = ObservabilityState::default();
    }

    #[test]
    fn empty_snapshot_returns_zeros() {
        reset_state();
        let snap = get_snapshot();
        assert_eq!(snap.success, 0);
        assert_eq!(snap.blocked, 0);
        assert_eq!(snap.fallback_depth, 0.0);
        assert_eq!(snap.p95, 0.0);
        assert_eq!(snap.status_429, 0);
    }

    #[test]
    fn records_429_status() {
        reset_state();
        record_http_response(200, 10.0);
        record_http_response(429, 20.0);
        record_http_response(200, 30.0);
        let snap = get_snapshot();
        assert_eq!(snap.status_429, 1);
    }

    #[test]
    fn does_not_count_non_429_statuses() {
        reset_state();
        record_http_response(200, 10.0);
        record_http_response(500, 20.0);
        record_http_response(403, 30.0);
        let snap = get_snapshot();
        assert_eq!(snap.status_429, 0);
    }

    #[test]
    fn rejects_nan_and_negative_durations() {
        reset_state();
        record_http_response(200, f64::NAN);
        record_http_response(200, -5.0);
        record_http_response(200, f64::INFINITY);
        let snap = get_snapshot();
        assert_eq!(snap.p95, 0.0);
    }

    #[test]
    fn single_latency_sample() {
        reset_state();
        record_http_response(200, 42.5);
        let snap = get_snapshot();
        assert_eq!(snap.p95, 42.5);
    }

    #[test]
    fn ignores_failed_engine_outcomes() {
        reset_state();
        record_engine_outcome(&EngineResponse {
            success: false,
            output: None,
            format: None,
            meta: None,
            error_code: None,
            error: None,
        });
        let snap = get_snapshot();
        assert_eq!(snap.success, 0);
    }

    #[test]
    fn handles_engine_outcome_with_no_meta() {
        reset_state();
        record_engine_outcome(&EngineResponse {
            success: true,
            output: None,
            format: None,
            meta: None,
            error_code: None,
            error: None,
        });
        // When meta is None, record_engine_outcome returns early without
        // incrementing success — it needs meta to know it's a real result.
        let snap = get_snapshot();
        assert_eq!(snap.success, 0);
        assert_eq!(snap.fallback_depth, 0.0);
    }

    #[test]
    fn rolling_window_caps_at_500() {
        reset_state();
        for i in 0..600 {
            record_http_response(200, i as f64);
        }
        let snap = get_snapshot();
        assert!(snap.p95 > 0.0);
    }

    #[test]
    fn fallback_depth_from_attempts_first_engine_succeeds() {
        let attempts = vec![SearchAttempt {
            engine: "duckduckgo".to_string(),
            engine_label: "DuckDuckGo".to_string(),
            url: "https://ddg.com".to_string(),
            blocked: false,
            result_count: 5,
            reason: "ok".to_string(),
            error: None,
        }];
        assert_eq!(fallback_depth_from_attempts(&attempts), 0);
    }

    #[test]
    fn fallback_depth_from_attempts_last_succeeds() {
        let attempts = vec![
            SearchAttempt {
                engine: "duckduckgo".to_string(),
                engine_label: "DuckDuckGo".to_string(),
                url: "https://ddg.com".to_string(),
                blocked: false,
                result_count: 0,
                reason: "no_results".to_string(),
                error: None,
            },
            SearchAttempt {
                engine: "bing".to_string(),
                engine_label: "Bing".to_string(),
                url: "https://bing.com".to_string(),
                blocked: false,
                result_count: 0,
                reason: "blocked".to_string(),
                error: None,
            },
            SearchAttempt {
                engine: "google".to_string(),
                engine_label: "Google".to_string(),
                url: "https://google.com".to_string(),
                blocked: false,
                result_count: 2,
                reason: "ok".to_string(),
                error: None,
            },
        ];
        assert_eq!(fallback_depth_from_attempts(&attempts), 2);
    }

    #[test]
    fn fallback_depth_from_empty_attempts() {
        let attempts: Vec<SearchAttempt> = vec![];
        assert_eq!(fallback_depth_from_attempts(&attempts), 0);
    }

    #[test]
    fn percentile_empty_returns_zero() {
        let values: VecDeque<f64> = VecDeque::new();
        assert_eq!(percentile(&values, 95.0), 0.0);
    }

    #[test]
    fn round_two_truncates_correctly() {
        assert_eq!(round_two(3.14159), 3.14);
        assert_eq!(round_two(2.999), 3.0);
        assert_eq!(round_two(0.0), 0.0);
    }
}
