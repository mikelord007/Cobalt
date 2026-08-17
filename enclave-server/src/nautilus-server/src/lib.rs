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

// Adding a new app -- everything for it lives in ONE place, the repo's top-level examples/<name>/,
// which is the real and only copy of the source (nothing is generated or staged into this crate):
//   (1) examples/<name>/mod.rs, exporting `pub fn router(core: Arc<CoreState>) -> axum::Router<()>`
//   (2) examples/<name>/allowed_endpoints.yaml (can be `endpoints: []`) -- copied to
//       /allowed_endpoints.yaml by the Containerfile and read at runtime by common.rs
//   (3) examples/<name>/cobalt.json + env.json -- the deploy config `cobalt deploy` reads
//   (4) the two lines below, and (5) one line in Cargo.toml's [features]. Nothing else changes.
//
// Why exactly four `..`: this file is enclave-server/src/nautilus-server/src/lib.rs, and a
// `#[path]` on a module declared at the TOP LEVEL of a mod-rs file resolves relative to that
// file's own directory. That directory sits four components below the repo root
// (enclave-server / src / nautilus-server / src), so four `..` land on the repo root. The
// identical string resolves inside the Docker build too, because the Containerfile reproduces
// this repo-root-relative layout under /build (see enclave-server/Containerfile).
//
// Do NOT wrap these in an inline `mod apps { ... }`. rustc prepends inline module names to the
// base directory, so the path would need a fifth `..` to compensate -- and that fifth `..`
// would traverse src/apps/, which no longer exists now that the app code lives in examples/.
// Windows normalizes `..` lexically (before touching the filesystem) so a wrong count still
// compiles fine on a Windows dev box; Linux resolves `..` against the real filesystem, so the
// exact same wrong count fails inside `docker build` with an opaque "couldn't read" error. That
// asymmetry means it would pass local review and break only in the enclave build.
#[cfg(feature = "ping")] #[path = "../../../../examples/ping/mod.rs"] mod ping;
#[cfg(feature = "dice")] #[path = "../../../../examples/dice/mod.rs"] mod dice;
pub mod app {
    #[cfg(feature = "ping")] pub use crate::ping::*;
    #[cfg(feature = "dice")] pub use crate::dice::*;
}
