pub mod auth;
pub mod challenge;
pub mod config;
pub mod contracts;
pub mod db;
pub mod engine;
pub mod fingerprint;
pub mod formatters;
pub mod models;
pub mod observability;
pub mod request;
pub mod routes;
pub mod search;
pub mod solver;
pub mod transcript;

use std::sync::Arc;

use anyhow::Result;
use reqwest::Client;

use crate::{config::Config, db::KeyStore};

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub http: Client,
    pub keys: KeyStore,
}

impl AppState {
    pub fn new(config: Config) -> Result<Self> {
        // User-agent reflects the real crate version (point 11a) rather than a
        // stale hardcoded string.
        let user_agent = format!("nsect-rs/{}", env!("CARGO_PKG_VERSION"));
        let http = Client::builder().user_agent(user_agent).build()?;
        // In local mode the key store is never used (no auth), but we open it
        // unconditionally so the schema is ready if the operator switches modes
        // without restarting from a fresh data dir.
        let keys = KeyStore::open(&config.db_path)?;
        Ok(Self { config, http, keys })
    }
}

pub fn build_app(state: AppState) -> axum::Router {
    routes::build_router(Arc::new(state))
}
