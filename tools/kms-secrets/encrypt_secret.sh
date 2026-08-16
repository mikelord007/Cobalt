#!/usr/bin/env bash
# Encrypt a plaintext secrets file into a KMS ciphertext blob scoped to a given app's PCR-gated
# key. This is what a developer/platform operator runs at deploy time, as an alternative to the
# plaintext `deploy_and_attest.sh --secrets <path>` flow: the ciphertext this produces goes into
# the outer secrets.json as KMS_SECRETS_CIPHERTEXT_B64, and only the enclave itself ever sees the
# decrypted contents.
#
# The output ciphertext blob is safe to leave on the parent EC2 instance's disk (or anywhere
# else) — it is useless without a matching attestation, so ciphertext leaking is harmless. Only
# the app's own enclave (presenting a genuine, PCR-matching attestation as the KMS `Recipient`)
# can ever turn it back into plaintext.
#
# Usage:
#   ./encrypt_secret.sh <app-id> <plaintext-file> <output-ciphertext-b64-file>
#
# Example:
#   ./encrypt_secret.sh ping ./secrets.json ./secrets.ping.ciphertext.b64
#
# Requires: aws cli configured with a principal permitted by the app's key policy's
# "AllowEncryptNoAttestationRequired" statement (see make_key_policy.js). Encrypt does NOT
# require an attestation — only Decrypt does.

set -euo pipefail

APP_ID="${1:?usage: encrypt_secret.sh <app-id> <plaintext-file> <output-ciphertext-b64-file>}"
PLAINTEXT_FILE="${2:?usage: encrypt_secret.sh <app-id> <plaintext-file> <output-ciphertext-b64-file>}"
OUT_FILE="${3:?usage: encrypt_secret.sh <app-id> <plaintext-file> <output-ciphertext-b64-file>}"
REGION="${AWS_REGION:-us-east-1}"
KEY_ALIAS="alias/cobalt-secrets-${APP_ID}"

if [[ ! -f "$PLAINTEXT_FILE" ]]; then
  echo "error: plaintext file not found: $PLAINTEXT_FILE" >&2
  exit 1
fi

aws kms encrypt \
  --region "$REGION" \
  --key-id "$KEY_ALIAS" \
  --plaintext "fileb://${PLAINTEXT_FILE}" \
  --query CiphertextBlob \
  --output text \
  > "$OUT_FILE"

echo "Encrypted $PLAINTEXT_FILE under $KEY_ALIAS -> $OUT_FILE (base64 CiphertextBlob)" >&2
