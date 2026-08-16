use k256::ecdsa::SigningKey;
use axum::response::{IntoResponse, Response};
use axum::http::StatusCode;
use axum::Json;
use serde_json::json;

pub mod eip712;
pub mod common;
pub mod kms_secrets;

pub struct CoreState {
    pub eph_kp: SigningKey,
    pub domain: eip712::Domain,
}

#[derive(Debug)]
pub enum EnclaveError {
    GenericError(String),
}

impl IntoResponse for EnclaveError {
    fn into_response(self) -> Response {
        let EnclaveError::GenericError(msg) = self;
        (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
    }
}

// Adding a new app: (1) src/apps/<name>/mod.rs exporting `pub fn router(core: Arc<CoreState>) -> axum::Router<()>`,
// (2) src/apps/<name>/allowed_endpoints.yaml (can be `endpoints: []`), (3) a two-line addition below,
// (4) a one-line addition to Cargo.toml's [features]. Nothing else changes.
mod apps {
    #[cfg(feature = "ping")] #[path = "ping/mod.rs"] pub mod ping;
}
pub mod app {
    #[cfg(feature = "ping")] pub use crate::apps::ping::*;
}
