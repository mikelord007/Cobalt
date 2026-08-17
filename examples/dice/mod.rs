use std::sync::Arc;
use axum::{extract::State, routing::post, Json, Router};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use crate::{CoreState, EnclaveError, eip712};

pub struct DiceState { core: Arc<CoreState> }

pub fn router(core: Arc<CoreState>) -> Router<()> {
    let state = Arc::new(DiceState { core });
    Router::new().route("/roll", post(roll)).with_state(state)
}

#[derive(Deserialize)]
struct RollRequest { sides: u32, deadline: u64, nonce: String }

#[derive(Serialize)]
struct RollResponse { sides: u32, result: u32, deadline: u64, nonce: String, signature: String }

// Domain name "Cobalt-Dice", version "1". No dedicated on-chain consumer for this sample app --
// CONSUMER_CONTRACT_ADDRESS is a placeholder (see cobalt-dice-app/README.md).
const DICE_ROLL_TYPEHASH_PREIMAGE: &[u8] = b"DiceRoll(uint32 sides,uint32 result,uint64 deadline,bytes32 nonce)";

async fn roll(State(state): State<Arc<DiceState>>, Json(req): Json<RollRequest>) -> Result<Json<RollResponse>, EnclaveError> {
    if req.sides < 2 {
        return Err(EnclaveError::GenericError("sides must be at least 2".to_string()));
    }
    let nonce = eip712::parse_bytes32(&req.nonce).map_err(|e| EnclaveError::GenericError(e.to_string()))?;

    // The roll happens inside the enclave using its own hardware-backed randomness (OsRng) --
    // the same entropy source ping's ephemeral signing key is generated from -- so not even the
    // operator running this machine can see or influence the outcome. `% sides` is slightly
    // biased toward small results for sides that don't evenly divide u32::MAX; a production
    // version would want unbiased-modulo rejection sampling for perfect uniformity, but that's
    // overkill for this sample app.
    let result = (rand::rngs::OsRng.next_u32() % req.sides) + 1;

    let typehash = eip712::keccak256(DICE_ROLL_TYPEHASH_PREIMAGE);
    let mut buf = Vec::with_capacity(32 * 4);
    buf.extend_from_slice(&typehash);
    let mut sides_word = [0u8; 32];
    sides_word[28..].copy_from_slice(&req.sides.to_be_bytes());
    buf.extend_from_slice(&sides_word);
    let mut result_word = [0u8; 32];
    result_word[28..].copy_from_slice(&result.to_be_bytes());
    buf.extend_from_slice(&result_word);
    let mut deadline_word = [0u8; 32];
    deadline_word[16..].copy_from_slice(&(req.deadline as u128).to_be_bytes());
    buf.extend_from_slice(&deadline_word);
    buf.extend_from_slice(&nonce);
    let struct_hash = eip712::keccak256(&buf);

    let digest = state.core.domain.digest(struct_hash);
    let sig = eip712::sign_digest(&state.core.eph_kp, digest);

    Ok(Json(RollResponse {
        sides: req.sides, result, deadline: req.deadline, nonce: req.nonce,
        signature: format!("0x{}", hex::encode(sig)),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dice_struct_hash(sides: u32, result: u32, deadline: u64, nonce: [u8; 32]) -> [u8; 32] {
        let typehash = eip712::keccak256(DICE_ROLL_TYPEHASH_PREIMAGE);
        let mut buf = Vec::with_capacity(32 * 4);
        buf.extend_from_slice(&typehash);
        let mut sides_word = [0u8; 32];
        sides_word[28..].copy_from_slice(&sides.to_be_bytes());
        buf.extend_from_slice(&sides_word);
        let mut result_word = [0u8; 32];
        result_word[28..].copy_from_slice(&result.to_be_bytes());
        buf.extend_from_slice(&result_word);
        let mut deadline_word = [0u8; 32];
        deadline_word[16..].copy_from_slice(&(deadline as u128).to_be_bytes());
        buf.extend_from_slice(&deadline_word);
        buf.extend_from_slice(&nonce);
        eip712::keccak256(&buf)
    }

    #[test]
    fn struct_hash_is_field_sensitive() {
        let base = dice_struct_hash(6, 3, 1000, [1u8; 32]);
        let diff_sides = dice_struct_hash(20, 3, 1000, [1u8; 32]);
        let diff_result = dice_struct_hash(6, 4, 1000, [1u8; 32]);
        let diff_deadline = dice_struct_hash(6, 3, 1001, [1u8; 32]);
        let diff_nonce = dice_struct_hash(6, 3, 1000, [2u8; 32]);
        assert_ne!(base, diff_sides);
        assert_ne!(base, diff_result);
        assert_ne!(base, diff_deadline);
        assert_ne!(base, diff_nonce);
        assert_ne!(diff_sides, diff_result);
    }

    #[test]
    fn roll_is_always_within_range() {
        for sides in [2u32, 3, 4, 6, 8, 10, 12, 20, 100] {
            for _ in 0..200 {
                let result = (rand::rngs::OsRng.next_u32() % sides) + 1;
                assert!(result >= 1 && result <= sides, "result {result} out of range for sides {sides}");
            }
        }
    }
}
