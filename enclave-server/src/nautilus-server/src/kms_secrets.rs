// Attestation-gated secrets: fetch a KMS-encrypted ciphertext blob and decrypt it using AWS KMS's
// Recipient attestation mechanism (kms:RecipientAttestation:* condition keys on the key policy).
// This requires a SEPARATE NSM attestation from the signing-key one in common.rs, binding a fresh
// RSA public key (KMS's envelope-encryption recipient mechanism needs RSA, not secp256k1 -- tested
// live: reusing the secp256k1 key gets ValidationException: Invalid public key from KMS).

// `nsm_api` is the dependency key in Cargo.toml (renamed via `package =`), so that's the extern
// crate name to use here, not the upstream crate's own package name.
use nsm_api::api::{Request as NsmRequest, Response as NsmResponse};
use nsm_api::driver;
use serde_bytes::ByteBuf;
use base64::Engine;
use rsa::{RsaPrivateKey, RsaPublicKey};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------------------------
// Step 1: ephemeral RSA keypair for this decrypt (SPKI DER public half -- NOT PKCS#1 -- because
// that's what AWS's Nitro attestation SDK expects bound into the attestation document).
// ---------------------------------------------------------------------------------------------

pub fn generate_ephemeral_rsa_keypair() -> anyhow::Result<(RsaPrivateKey, Vec<u8>)> {
    use rsa::pkcs8::EncodePublicKey;
    let priv_key = RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048)?;
    let pub_key = RsaPublicKey::from(&priv_key);
    let pub_der = pub_key.to_public_key_der()?.as_bytes().to_vec();
    Ok((priv_key, pub_der))
}

// ---------------------------------------------------------------------------------------------
// Step 2: a second, separate NSM attestation binding the RSA public key (distinct from the
// secp256k1 signing-key attestation in common.rs -- KMS's Recipient mechanism only accepts RSA).
// ---------------------------------------------------------------------------------------------

pub fn get_kms_attestation(rsa_pub_der: &[u8]) -> anyhow::Result<Vec<u8>> {
    let fd = driver::nsm_init();
    let request = NsmRequest::Attestation { user_data: None, nonce: None, public_key: Some(ByteBuf::from(rsa_pub_der.to_vec())) };
    let response = driver::nsm_process_request(fd, request);
    driver::nsm_exit(fd);
    match response {
        NsmResponse::Attestation { document } => Ok(document),
        other => anyhow::bail!("NSM returned {other:?}, expected an Attestation document"),
    }
}

// ---------------------------------------------------------------------------------------------
// Step 3: hand-signed AWS SigV4 POST to KMS's Decrypt action.
// ---------------------------------------------------------------------------------------------

struct SigV4Credentials {
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
}

fn load_credentials() -> anyhow::Result<SigV4Credentials> {
    let access_key_id = std::env::var("AWS_ACCESS_KEY_ID")
        .map_err(|_| anyhow::anyhow!("AWS_ACCESS_KEY_ID must be set"))?;
    let secret_access_key = std::env::var("AWS_SECRET_ACCESS_KEY")
        .map_err(|_| anyhow::anyhow!("AWS_SECRET_ACCESS_KEY must be set"))?;
    let session_token = std::env::var("AWS_SESSION_TOKEN").ok();
    Ok(SigV4Credentials { access_key_id, secret_access_key, session_token })
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    type HmacSha256 = Hmac<Sha256>;
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts a key of any length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

// Builds the full signed header set (including Authorization) for a POST of `body` to `host`.
// Canonical request: POST\n/\n\n{sorted lowercase header:value\n pairs}\n{signed header names
// ;-joined}\n{lowercase-hex sha256(body)}. Signing key: kDate -> kRegion -> kService -> kSigning,
// each an HMAC-SHA256 chain seeded from "AWS4" + the secret key.
fn sigv4_headers(creds: &SigV4Credentials, region: &str, service: &str, host: &str, target: &str, body: &[u8]) -> Vec<(String, String)> {
    let now = chrono::Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();
    let payload_hash = sha256_hex(body);

    let mut headers: Vec<(String, String)> = vec![
        ("content-type".to_string(), "application/x-amz-json-1.1".to_string()),
        ("host".to_string(), host.to_string()),
        ("x-amz-date".to_string(), amz_date.clone()),
        ("x-amz-target".to_string(), target.to_string()),
    ];
    if let Some(token) = &creds.session_token {
        headers.push(("x-amz-security-token".to_string(), token.clone()));
    }
    headers.sort_by(|a, b| a.0.cmp(&b.0));

    let canonical_headers: String = headers.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed_headers = headers.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");

    let canonical_request = format!("POST\n/\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let canonical_request_hash = sha256_hex(canonical_request.as_bytes());

    let credential_scope = format!("{date_stamp}/{region}/{service}/aws4_request");
    let string_to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{canonical_request_hash}");

    let k_date = hmac_sha256(format!("AWS4{}", creds.secret_access_key).as_bytes(), date_stamp.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}",
        creds.access_key_id
    );

    let mut out = headers;
    out.push(("authorization".to_string(), authorization));
    out
}

pub async fn kms_decrypt(region: &str, key_id: &str, ciphertext_b64: &str, attestation_der: &[u8]) -> anyhow::Result<Vec<u8>> {
    let creds = load_credentials()?;
    let host = format!("kms.{region}.amazonaws.com");
    let attestation_b64 = base64::engine::general_purpose::STANDARD.encode(attestation_der);

    let body = serde_json::json!({
        "KeyId": key_id,
        "CiphertextBlob": ciphertext_b64,
        "Recipient": {
            "KeyEncryptionAlgorithm": "RSAES_OAEP_SHA_256",
            "AttestationDocument": attestation_b64,
        }
    })
    .to_string();

    let headers = sigv4_headers(&creds, region, "kms", &host, "TrentService.Decrypt", body.as_bytes());

    let client = reqwest::Client::new();
    let mut req = client.post(format!("https://{host}/")).body(body.clone());
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    let resp = req.send().await?;
    let status = resp.status();
    let resp_bytes = resp.bytes().await?;

    if !status.is_success() {
        let err_json: serde_json::Value = serde_json::from_slice(&resp_bytes).unwrap_or(serde_json::Value::Null);
        let err_type = err_json.get("__type").and_then(|v| v.as_str()).unwrap_or("unknown");
        let message = err_json.get("message").and_then(|v| v.as_str()).unwrap_or("");
        let hint = if err_type.contains("AccessDenied") {
            " (this likely means the enclave's PCRs don't match the kms:RecipientAttestation condition on the key policy)"
        } else {
            ""
        };
        anyhow::bail!("KMS Decrypt failed: {status} {err_type}: {message}{hint}");
    }

    let resp_json: serde_json::Value = serde_json::from_slice(&resp_bytes)?;
    let ciphertext_for_recipient = resp_json
        .get("CiphertextForRecipient")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("KMS response missing CiphertextForRecipient"))?;
    let cms_der = base64::engine::general_purpose::STANDARD.decode(ciphertext_for_recipient)?;
    Ok(cms_der)
}

// ---------------------------------------------------------------------------------------------
// Step 4: minimal hand-rolled BER/DER TLV walker over CMS ContentInfo { EnvelopedData }
// (RFC 5652 6). Two real-world BER quirks are handled deliberately -- see the doc comments on
// `parse_tlv` and `octet_string_content` and the unit tests at the bottom of this file.
// ---------------------------------------------------------------------------------------------

struct Tlv<'a> {
    tag: u8,
    constructed: bool,
    content: &'a [u8],
    consumed: usize,
}

// Reads one TLV element starting at `data[0]`. Handles both DER definite-length encoding and
// BER indefinite-length encoding (length byte 0x80, terminated by an 00 00 end-of-contents
// marker). AWS KMS's CMS output frequently uses indefinite length for the outer ContentInfo/
// EnvelopedData SEQUENCEs -- to skip over such an element without knowing its length up front,
// this recursively walks each nested TLV until it hits the EOC marker, rather than doing a flat
// byte-scan for `00 00` (which would false-positive inside binary ciphertext content).
fn parse_tlv(data: &[u8]) -> anyhow::Result<Tlv<'_>> {
    anyhow::ensure!(data.len() >= 2, "truncated TLV header");
    let tag = data[0];
    let constructed = (tag & 0x20) != 0;
    let len_byte = data[1];

    if len_byte == 0x80 {
        anyhow::ensure!(constructed, "indefinite length on a primitive tag {:#x}", tag);
        let mut pos = 2usize;
        loop {
            anyhow::ensure!(pos + 2 <= data.len(), "truncated indefinite-length TLV (no EOC found)");
            if data[pos] == 0x00 && data[pos + 1] == 0x00 {
                return Ok(Tlv { tag, constructed, content: &data[2..pos], consumed: pos + 2 });
            }
            let nested = parse_tlv(&data[pos..])?;
            pos += nested.consumed;
        }
    } else if len_byte & 0x80 == 0 {
        let length = len_byte as usize;
        let header = 2;
        anyhow::ensure!(data.len() >= header + length, "truncated TLV content (short form)");
        Ok(Tlv { tag, constructed, content: &data[header..header + length], consumed: header + length })
    } else {
        let num_len_bytes = (len_byte & 0x7f) as usize;
        anyhow::ensure!(num_len_bytes > 0 && num_len_bytes <= 8, "unsupported length encoding");
        anyhow::ensure!(data.len() >= 2 + num_len_bytes, "truncated length bytes (long form)");
        let mut length: usize = 0;
        for &b in &data[2..2 + num_len_bytes] {
            length = (length << 8) | b as usize;
        }
        let header = 2 + num_len_bytes;
        anyhow::ensure!(data.len() >= header + length, "truncated TLV content (long form)");
        Ok(Tlv { tag, constructed, content: &data[header..header + length], consumed: header + length })
    }
}

fn iter_tlvs(data: &[u8]) -> anyhow::Result<Vec<Tlv<'_>>> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < data.len() {
        let t = parse_tlv(&data[pos..])?;
        pos += t.consumed;
        out.push(t);
    }
    Ok(out)
}

// The `encryptedContent` field (tag [0] in EncryptedContentInfo) is frequently emitted as
// CONSTRUCTED, indefinite-length, wrapping one or more nested PRIMITIVE OCTET STRING chunks
// rather than one flat byte string. This concatenates the *contents* of each nested chunk (not
// their raw TLV span, which would prepend each chunk's own small length header into the
// "ciphertext" and corrupt AES block alignment by a few bytes -- surfacing later as a totally
// unrelated-looking PKCS7 unpad error).
fn octet_string_content(tlv: &Tlv) -> anyhow::Result<Vec<u8>> {
    if !tlv.constructed {
        return Ok(tlv.content.to_vec());
    }
    let mut out = Vec::new();
    for chunk in iter_tlvs(tlv.content)? {
        out.extend_from_slice(&octet_string_content(&chunk)?);
    }
    Ok(out)
}

pub fn parse_enveloped_data(der: &[u8]) -> anyhow::Result<(Vec<u8>, [u8; 16], Vec<u8>)> {
    // ContentInfo ::= SEQUENCE { contentType OID, content [0] EXPLICIT ANY }
    let content_info = parse_tlv(der)?;
    anyhow::ensure!(content_info.tag == 0x30, "expected ContentInfo SEQUENCE, got tag {:#x}", content_info.tag);
    let ci_fields = iter_tlvs(content_info.content)?;
    anyhow::ensure!(ci_fields.len() >= 2, "ContentInfo missing the [0] content field");
    let explicit0 = &ci_fields[1];
    anyhow::ensure!(explicit0.tag == 0xA0, "expected [0] EXPLICIT content, got tag {:#x}", explicit0.tag);

    // EnvelopedData ::= SEQUENCE { version, [originatorInfo], recipientInfos SET OF, encryptedContentInfo, ... }
    let enveloped_data = parse_tlv(explicit0.content)?;
    anyhow::ensure!(enveloped_data.tag == 0x30, "expected EnvelopedData SEQUENCE, got tag {:#x}", enveloped_data.tag);
    let ed_fields = iter_tlvs(enveloped_data.content)?;

    let recipient_infos = ed_fields.iter().find(|f| f.tag == 0x31)
        .ok_or_else(|| anyhow::anyhow!("EnvelopedData missing recipientInfos SET"))?;
    let enc_content_info = ed_fields.iter().find(|f| f.tag == 0x30)
        .ok_or_else(|| anyhow::anyhow!("EnvelopedData missing encryptedContentInfo SEQUENCE"))?;

    // KeyTransRecipientInfo ::= SEQUENCE { version, rid, keyEncryptionAlgorithm, encryptedKey OCTET STRING }
    let ri_list = iter_tlvs(recipient_infos.content)?;
    let ktri = ri_list.first().ok_or_else(|| anyhow::anyhow!("no RecipientInfo entries"))?;
    anyhow::ensure!(ktri.tag == 0x30, "expected KeyTransRecipientInfo (untagged SEQUENCE), got tag {:#x}", ktri.tag);
    let ktri_fields = iter_tlvs(ktri.content)?;
    let encrypted_key_tlv = ktri_fields.iter().find(|f| f.tag & 0x1f == 0x04)
        .ok_or_else(|| anyhow::anyhow!("KeyTransRecipientInfo missing encryptedKey OCTET STRING"))?;
    let encrypted_key = octet_string_content(encrypted_key_tlv)?;

    // EncryptedContentInfo ::= SEQUENCE { contentType, contentEncryptionAlgorithm, encryptedContent [0] IMPLICIT OPTIONAL }
    let eci_fields = iter_tlvs(enc_content_info.content)?;
    let alg_id = eci_fields.iter().find(|f| f.tag == 0x30)
        .ok_or_else(|| anyhow::anyhow!("EncryptedContentInfo missing contentEncryptionAlgorithm"))?;
    let alg_fields = iter_tlvs(alg_id.content)?;
    // RFC 3565: for aes256-CBC the AlgorithmIdentifier parameters field IS the IV, as an OCTET STRING.
    let iv_tlv = alg_fields.get(1)
        .ok_or_else(|| anyhow::anyhow!("contentEncryptionAlgorithm missing IV parameters"))?;
    let iv_bytes = octet_string_content(iv_tlv)?;
    anyhow::ensure!(iv_bytes.len() == 16, "expected a 16-byte AES-CBC IV, got {}", iv_bytes.len());
    let mut iv = [0u8; 16];
    iv.copy_from_slice(&iv_bytes);

    let enc_content_tlv = eci_fields.iter().find(|f| (f.tag & 0xC0) == 0x80 && (f.tag & 0x1f) == 0)
        .ok_or_else(|| anyhow::anyhow!("EncryptedContentInfo missing [0] encryptedContent"))?;
    let encrypted_content = octet_string_content(enc_content_tlv)?;

    Ok((encrypted_key, iv, encrypted_content))
}

// ---------------------------------------------------------------------------------------------
// Step 5: unwrap the AES-256 content-encryption key with RSA-OAEP-SHA256, then AES-256-CBC/PKCS7
// decrypt the content itself.
// ---------------------------------------------------------------------------------------------

pub fn unwrap_and_decrypt(rsa_priv: &RsaPrivateKey, encrypted_key: &[u8], iv: [u8; 16], encrypted_content: &[u8]) -> anyhow::Result<Vec<u8>> {
    let aes_key = rsa_priv
        .decrypt(rsa::Oaep::new::<Sha256>(), encrypted_key)
        .map_err(|e| anyhow::anyhow!("RSA-OAEP decrypt of the wrapped AES key failed: {e}"))?;
    anyhow::ensure!(aes_key.len() == 32, "expected a 32-byte AES-256 key, got {} bytes", aes_key.len());

    use aes::Aes256;
    use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    type Aes256CbcDec = cbc::Decryptor<Aes256>;

    let mut buf = encrypted_content.to_vec();
    let decryptor = Aes256CbcDec::new_from_slices(&aes_key, &iv)
        .map_err(|e| anyhow::anyhow!("invalid AES key/IV length: {e}"))?;
    let plaintext = decryptor
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|e| anyhow::anyhow!("AES-CBC PKCS7 unpad failed: {e}"))?;
    Ok(plaintext.to_vec())
}

// ---------------------------------------------------------------------------------------------
// Step 6: orchestration.
// ---------------------------------------------------------------------------------------------

pub async fn fetch_secrets(region: &str, key_id: &str, ciphertext_b64: &str) -> anyhow::Result<serde_json::Value> {
    let (rsa_priv, rsa_pub_der) = generate_ephemeral_rsa_keypair()?;
    let attestation_der = get_kms_attestation(&rsa_pub_der)?;
    let cms_der = kms_decrypt(region, key_id, ciphertext_b64, &attestation_der).await?;
    let (encrypted_key, iv, encrypted_content) = parse_enveloped_data(&cms_der)?;
    let plaintext = unwrap_and_decrypt(&rsa_priv, &encrypted_key, iv, &encrypted_content)?;
    let value: serde_json::Value = serde_json::from_slice(&plaintext)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Quirk 1: the outer SEQUENCE is indefinite-length BER (0x80 length byte, 00 00 EOC), and
    // may itself nest more indefinite-length elements. A flat byte-scan for `00 00` would break
    // as soon as an EOC-shaped byte pair appears inside a nested element's own content; the
    // recursive walk in `parse_tlv` must skip nested elements structurally instead.
    #[test]
    fn parses_indefinite_length_outer_sequence() {
        // SEQUENCE (indefinite) { INTEGER 5, OCTET STRING "hi" }
        let bytes: Vec<u8> = vec![
            0x30, 0x80, // SEQUENCE, indefinite length
            0x02, 0x01, 0x05, // INTEGER 5
            0x04, 0x02, b'h', b'i', // OCTET STRING "hi"
            0x00, 0x00, // EOC
        ];
        let tlv = parse_tlv(&bytes).expect("should parse indefinite-length SEQUENCE");
        assert_eq!(tlv.tag, 0x30);
        assert!(tlv.constructed);
        assert_eq!(tlv.consumed, bytes.len());
        assert_eq!(tlv.content, &bytes[2..bytes.len() - 2]);

        let fields = iter_tlvs(tlv.content).expect("nested fields should parse");
        assert_eq!(fields.len(), 2);
        assert_eq!(fields[0].tag, 0x02);
        assert_eq!(fields[0].content, &[0x05]);
        assert_eq!(fields[1].tag, 0x04);
        assert_eq!(fields[1].content, b"hi");
    }

    // Quirk 2: a constructed, indefinite-length OCTET STRING (or an IMPLICIT-tagged field using
    // the same encoding, as encryptedContent does) wraps multiple primitive OCTET STRING chunks.
    // The reassembled plaintext must be the concatenation of each chunk's *content*, not each
    // chunk's raw TLV bytes (which would splice in extra length-header bytes and corrupt AES
    // block alignment).
    #[test]
    fn reassembles_constructed_chunked_octet_string() {
        // [0] IMPLICIT (constructed, indefinite) { OCTET STRING "ABC", OCTET STRING "DE" }
        let bytes: Vec<u8> = vec![
            0xA0, 0x80, // [0] constructed, indefinite length
            0x04, 0x03, b'A', b'B', b'C', // chunk 1
            0x04, 0x02, b'D', b'E', // chunk 2
            0x00, 0x00, // EOC
        ];
        let tlv = parse_tlv(&bytes).expect("should parse constructed indefinite-length element");
        assert_eq!(tlv.tag, 0xA0);
        assert!(tlv.constructed);

        let reassembled = octet_string_content(&tlv).expect("should reassemble chunks");
        assert_eq!(reassembled, b"ABCDE");
        // Specifically: must NOT equal the raw nested TLV bytes (which would include each
        // chunk's own tag+length header, e.g. length 7 instead of 5).
        assert_ne!(reassembled.len(), tlv.content.len());
    }

    #[test]
    fn primitive_octet_string_content_is_unchanged() {
        let bytes: Vec<u8> = vec![0x04, 0x03, b'x', b'y', b'z'];
        let tlv = parse_tlv(&bytes).expect("should parse primitive OCTET STRING");
        assert!(!tlv.constructed);
        let content = octet_string_content(&tlv).expect("should return content directly");
        assert_eq!(content, b"xyz");
    }
}
