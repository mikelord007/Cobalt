// Hand-rolled EIP-712 domain separator, struct hashing, and signing. No typed-data crate: the
// surface we need (a fixed domain plus a couple of struct shapes per app) is small enough that
// hand-rolling avoids a dependency whose generality we'd never use.

use k256::ecdsa::{SigningKey, VerifyingKey, Signature, RecoveryId};
use sha3::{Digest, Keccak256};

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(data);
    h.finalize().into()
}

fn encode_address(addr: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(addr);
    w
}

fn encode_uint(value: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&value.to_be_bytes());
    w
}

pub struct Domain {
    pub name: String,
    pub version: String,
    pub chain_id: u64,
    pub verifying_contract: [u8; 20],
}

impl Domain {
    fn separator(&self) -> [u8; 32] {
        let typehash = keccak256(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        let name_hash = keccak256(self.name.as_bytes());
        let version_hash = keccak256(self.version.as_bytes());
        let mut buf = Vec::with_capacity(32 * 5);
        buf.extend_from_slice(&typehash);
        buf.extend_from_slice(&name_hash);
        buf.extend_from_slice(&version_hash);
        buf.extend_from_slice(&encode_uint(self.chain_id as u128));
        buf.extend_from_slice(&encode_address(&self.verifying_contract));
        keccak256(&buf)
    }

    pub fn digest(&self, struct_hash: [u8; 32]) -> [u8; 32] {
        let mut buf = Vec::with_capacity(2 + 32 + 32);
        buf.extend_from_slice(&[0x19, 0x01]);
        buf.extend_from_slice(&self.separator());
        buf.extend_from_slice(&struct_hash);
        keccak256(&buf)
    }
}

// Ecrecover-compatible 65-byte r||s||v, v in {27,28}, low-S normalized (sign_prehash_recoverable
// already does this, so Solidity's ECDSA.recoverCalldata never rejects it as malleable).
pub fn sign_digest(kp: &SigningKey, digest: [u8; 32]) -> [u8; 65] {
    let (sig, recid): (Signature, RecoveryId) = kp.sign_prehash_recoverable(&digest)
        .expect("signing a fixed-size digest cannot fail");
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&sig.to_bytes());
    out[64] = recid.to_byte() + 27;
    out
}

// Must stay in exact lockstep with EnclaveRegistry's on-chain address derivation (Solidity side,
// built by a different track): strip the leading 0x04 SEC1 prefix byte from the uncompressed
// public key, keccak256 the remaining 64 bytes, take the low 20 bytes.
pub fn eth_address(vk: &VerifyingKey) -> [u8; 20] {
    let uncompressed = vk.to_encoded_point(false);
    let xy = &uncompressed.as_bytes()[1..];
    let hash = keccak256(xy);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[12..]);
    addr
}

pub fn parse_fixed_hex<const N: usize>(s: &str) -> anyhow::Result<[u8; N]> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let bytes = hex::decode(s)?;
    anyhow::ensure!(bytes.len() == N, "expected {} bytes, got {}", N, bytes.len());
    let mut out = [0u8; N];
    out.copy_from_slice(&bytes);
    Ok(out)
}
pub fn parse_address(s: &str) -> anyhow::Result<[u8; 20]> { parse_fixed_hex::<20>(s) }
pub fn parse_bytes32(s: &str) -> anyhow::Result<[u8; 32]> { parse_fixed_hex::<32>(s) }

#[cfg(test)]
mod tests {
    use super::*;

    fn test_domain() -> Domain {
        Domain {
            name: "Cobalt-Ping".to_string(),
            version: "1".to_string(),
            chain_id: 10143,
            verifying_contract: [0x11u8; 20],
        }
    }

    fn pong_struct_hash(message: &str, deadline: u64, nonce: [u8; 32]) -> [u8; 32] {
        let typehash = keccak256(b"Pong(string message,uint64 deadline,bytes32 nonce)");
        let message_hash = keccak256(message.as_bytes());
        let mut buf = Vec::with_capacity(32 * 4);
        buf.extend_from_slice(&typehash);
        buf.extend_from_slice(&message_hash);
        buf.extend_from_slice(&encode_uint(deadline as u128));
        buf.extend_from_slice(&nonce);
        keccak256(&buf)
    }

    #[test]
    fn struct_hash_is_field_sensitive() {
        let base = pong_struct_hash("hello", 1000, [1u8; 32]);
        let diff_message = pong_struct_hash("goodbye", 1000, [1u8; 32]);
        let diff_deadline = pong_struct_hash("hello", 1001, [1u8; 32]);
        let diff_nonce = pong_struct_hash("hello", 1000, [2u8; 32]);
        assert_ne!(base, diff_message);
        assert_ne!(base, diff_deadline);
        assert_ne!(base, diff_nonce);
        assert_ne!(diff_message, diff_deadline);
        assert_ne!(diff_deadline, diff_nonce);
    }

    #[test]
    fn sign_and_recover_round_trip() {
        let kp = SigningKey::random(&mut rand::rngs::OsRng);
        let vk = VerifyingKey::from(&kp);
        let domain = test_domain();
        let struct_hash = pong_struct_hash("hello", 1000, [7u8; 32]);
        let digest = domain.digest(struct_hash);

        let sig_bytes = sign_digest(&kp, digest);
        let v = sig_bytes[64];
        assert!(v == 27 || v == 28, "v must be 27 or 28, got {v}");

        let sig = Signature::from_slice(&sig_bytes[..64]).expect("valid signature bytes");
        let recid = RecoveryId::from_byte(v - 27).expect("valid recovery id");
        let recovered = VerifyingKey::recover_from_prehash(&digest, &sig, recid)
            .expect("recovery should succeed");
        assert_eq!(recovered, vk);
    }

    #[test]
    fn eth_address_is_nonzero_for_random_key() {
        let kp = SigningKey::random(&mut rand::rngs::OsRng);
        let vk = VerifyingKey::from(&kp);
        let addr = eth_address(&vk);
        assert_ne!(addr, [0u8; 20]);
    }
}
