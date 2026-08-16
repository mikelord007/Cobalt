use std::sync::Arc;
use axum::{routing::get, Router};
use tower_http::cors::{Any, CorsLayer};
use k256::ecdsa::SigningKey;
use nautilus_server::{CoreState, common, eip712, kms_secrets};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let eph_kp = SigningKey::random(&mut rand::rngs::OsRng);

    // KMS-wrapped secrets, if present, must be resolved BEFORE any other env var is read.
    if let Ok(ciphertext_b64) = std::env::var("KMS_SECRETS_CIPHERTEXT_B64") {
        let region = std::env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".to_string());
        let key_id = std::env::var("KMS_SECRETS_KEY_ID").expect("KMS_SECRETS_KEY_ID must be set alongside KMS_SECRETS_CIPHERTEXT_B64");
        let secrets = kms_secrets::fetch_secrets(&region, &key_id, &ciphertext_b64).await.expect("failed to fetch/decrypt KMS secrets");
        if let serde_json::Value::Object(map) = secrets {
            for (key, value) in map {
                std::env::set_var(&key, value.as_str().unwrap_or_default());
            }
        }
    }

    let domain_name = std::env::var("EIP712_DOMAIN_NAME").expect("EIP712_DOMAIN_NAME must be set");
    let domain_version = std::env::var("EIP712_DOMAIN_VERSION").unwrap_or_else(|_| "1".to_string());
    let chain_id: u64 = std::env::var("MONAD_CHAIN_ID").unwrap_or_else(|_| "10143".to_string()).parse().expect("MONAD_CHAIN_ID must be a number");
    let verifying_contract = eip712::parse_address(
        &std::env::var("CONSUMER_CONTRACT_ADDRESS").expect("CONSUMER_CONTRACT_ADDRESS must be set")
    ).expect("CONSUMER_CONTRACT_ADDRESS must be a valid 20-byte hex address");

    let domain = eip712::Domain { name: domain_name, version: domain_version, chain_id, verifying_contract };

    tracing::info!("enclave signer address: 0x{}", hex::encode(eip712::eth_address(&k256::ecdsa::VerifyingKey::from(&eph_kp))));
    tracing::info!("domain: {} v{} chain {}", domain.name, domain.version, domain.chain_id);

    let core = Arc::new(CoreState { eph_kp, domain });

    let cors = CorsLayer::new().allow_methods(Any).allow_headers(Any).allow_origin(Any);
    let common_router = Router::new()
        .route("/", get(|| async { "Pong!" }))
        .route("/attestation", get(common::get_attestation))
        .route("/health", get(common::health_check))
        .with_state(core.clone());
    let app = common_router.merge(nautilus_server::app::router(core)).layer(cors);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    tracing::info!("listening on 0.0.0.0:3000");
    axum::serve(listener, app).await.unwrap();
}
