// The two generic endpoints every app gets for free: /attestation (NSM attestation binding the
// enclave's secp256k1 signing key) and /health (liveness plus a probe of every host the app is
// allowed to reach, per allowed_endpoints.yaml).

use std::sync::Arc;
use std::collections::HashMap;
use axum::{extract::State, Json};
use serde::Serialize;
// `nsm_api` is the dependency key in Cargo.toml (renamed via `package =`), so that's the extern
// crate name to use here, not the upstream crate's own package name.
use nsm_api::api::{Request as NsmRequest, Response as NsmResponse};
use nsm_api::driver;
use serde_bytes::ByteBuf;
use k256::ecdsa::VerifyingKey;

use crate::{CoreState, EnclaveError};

#[derive(Serialize)]
pub struct AttestationResponse { pub attestation: String }

pub async fn get_attestation(State(state): State<Arc<CoreState>>) -> Result<Json<AttestationResponse>, EnclaveError> {
    // Uncompressed SEC1: 0x04 || X(32) || Y(32). EnclaveRegistry strips the leading 0x04 and hashes
    // the remaining 64 bytes to derive the signer address -- see eip712::eth_address, which must
    // stay in lockstep with this. A compressed (33-byte) key here would silently register the
    // wrong address. The `public_key` field must be EXPLICITLY requested -- it is optional and
    // absent by default; omitting it produces a confusing "missing key" error at registration
    // despite the cryptographic verification succeeding perfectly.
    let pk_bytes = VerifyingKey::from(&state.eph_kp).to_encoded_point(false).as_bytes().to_vec();
    let fd = driver::nsm_init();
    let request = NsmRequest::Attestation { user_data: None, nonce: None, public_key: Some(ByteBuf::from(pk_bytes)) };
    let response = driver::nsm_process_request(fd, request);
    driver::nsm_exit(fd);
    match response {
        NsmResponse::Attestation { document } => Ok(Json(AttestationResponse { attestation: hex::encode(document) })),
        other => Err(EnclaveError::GenericError(format!("NSM returned {other:?}, expected an Attestation document"))),
    }
}

#[derive(Serialize)]
pub struct HealthCheckResponse {
    pub pk: String,
    pub eth_address: String,
    pub endpoints_status: HashMap<String, bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoints_error: Option<String>,
}

pub async fn health_check(State(state): State<Arc<CoreState>>) -> Json<HealthCheckResponse> {
    let vk = VerifyingKey::from(&state.eph_kp);
    let pk = hex::encode(vk.to_encoded_point(false).as_bytes());
    let eth_address = format!("0x{}", hex::encode(crate::eip712::eth_address(&vk)));

    let mut endpoints_status = HashMap::new();
    let mut endpoints_error = None;
    match load_allowed_endpoints() {
        Ok(endpoints) => {
            let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(5)).build().unwrap();
            for host in endpoints {
                let ok = check_endpoint(&client, &host).await;
                endpoints_status.insert(host, ok);
            }
        }
        Err(e) => { endpoints_error = Some(e.to_string()); }
    }
    Json(HealthCheckResponse { pk, eth_address, endpoints_status, endpoints_error })
}

// Read relative to CWD -- must be copied alongside the binary in the container image (see the
// Containerfile) or this silently reports "healthy" having probed nothing.
fn load_allowed_endpoints() -> anyhow::Result<Vec<String>> {
    #[derive(serde::Deserialize)]
    struct Endpoints { endpoints: Vec<String> }
    let contents = std::fs::read_to_string("allowed_endpoints.yaml")?;
    let parsed: Endpoints = serde_yaml::from_str(&contents)?;
    Ok(parsed.endpoints)
}

async fn check_endpoint(client: &reqwest::Client, host: &str) -> bool {
    let url = if host.ends_with("amazonaws.com") { format!("https://{host}/ping") } else { format!("https://{host}") };
    match client.get(&url).send().await {
        Ok(resp) => {
            if host.ends_with("amazonaws.com") {
                resp.text().await.map(|b| b.contains("healthy")).unwrap_or(false)
            } else {
                resp.status().is_success()
            }
        }
        Err(_) => false,
    }
}
