use std::sync::Arc;
use axum::{extract::State, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use crate::{CoreState, EnclaveError, eip712};

pub struct PingState { core: Arc<CoreState> }

pub fn router(core: Arc<CoreState>) -> Router<()> {
    let state = Arc::new(PingState { core });
    Router::new().route("/ping", post(ping)).with_state(state)
}

#[derive(Deserialize)]
struct PingRequest { message: String, deadline: u64, nonce: String }

#[derive(Serialize)]
struct PongResponse { message: String, deadline: u64, nonce: String, signature: String }

// Fixed by PingConsumer.sol (built on a different track) -- do not deviate. Domain name
// "Cobalt-Ping", version "1".
const PONG_TYPEHASH_PREIMAGE: &[u8] = b"Pong(string message,uint64 deadline,bytes32 nonce)";

async fn ping(State(state): State<Arc<PingState>>, Json(req): Json<PingRequest>) -> Result<Json<PongResponse>, EnclaveError> {
    let nonce = eip712::parse_bytes32(&req.nonce).map_err(|e| EnclaveError::GenericError(e.to_string()))?;
    // The enclave transforms the input rather than echoing it -- proof the server is doing real
    // logic, not just relaying bytes.
    let message = format!("pong: {}", req.message);

    let typehash = eip712::keccak256(PONG_TYPEHASH_PREIMAGE);
    let message_hash = eip712::keccak256(message.as_bytes());
    let mut buf = Vec::with_capacity(32 * 4);
    buf.extend_from_slice(&typehash);
    buf.extend_from_slice(&message_hash);
    let mut deadline_word = [0u8; 32];
    deadline_word[16..].copy_from_slice(&(req.deadline as u128).to_be_bytes());
    buf.extend_from_slice(&deadline_word);
    buf.extend_from_slice(&nonce);
    let struct_hash = eip712::keccak256(&buf);

    let digest = state.core.domain.digest(struct_hash);
    let sig = eip712::sign_digest(&state.core.eph_kp, digest);

    Ok(Json(PongResponse {
        message, deadline: req.deadline, nonce: req.nonce,
        signature: format!("0x{}", hex::encode(sig)),
    }))
}
