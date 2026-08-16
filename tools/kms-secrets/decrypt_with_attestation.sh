#!/usr/bin/env bash
# Reference/manual-test helper: calls KMS Decrypt with a Recipient attestation, exactly the shape
# the enclave-side Rust code (kms_secrets.rs) replicates using hand-rolled SigV4 instead of the
# CLI. Useful for manually verifying a key's gating behavior against a real or synthetic
# attestation document without booting an enclave.
#
# Usage:
#   ./decrypt_with_attestation.sh <app-id> <ciphertext-b64-file> [attestation-b64-file]
#
# If attestation-b64-file is omitted, calls Decrypt with NO Recipient at all — i.e. simulates
# "an operator with root access to the parent EC2 instance just tries to decrypt the blob
# directly." Per the app's key policy, this must be denied; if it isn't, the policy has a hole
# (see kms-secrets-demo.md for the exact bug this class of mistake causes: a blanket "kms:*"
# admin statement would silently defeat the attestation gate).

set -euo pipefail

APP_ID="${1:?usage: decrypt_with_attestation.sh <app-id> <ciphertext-b64-file> [attestation-b64-file]}"
CIPHERTEXT_FILE="${2:?usage: decrypt_with_attestation.sh <app-id> <ciphertext-b64-file> [attestation-b64-file]}"
ATTESTATION_B64_FILE="${3:-}"
REGION="${AWS_REGION:-us-east-1}"
KEY_ALIAS="alias/cobalt-secrets-${APP_ID}"

# Decode the base64 ciphertext to a real temp file rather than handing the CLI a quoted
# `fileb://<(process substitution)` string -- quoting suppresses bash's process-substitution
# expansion, so that form silently passes the literal, unexpanded text as the argument instead of
# a file descriptor path. Caught by actually running this, not by reading it.
TMP_CIPHERTEXT=$(mktemp)
TMP_RECIPIENT=""
cleanup() { rm -f "$TMP_CIPHERTEXT" "$TMP_RECIPIENT"; }
trap cleanup EXIT
base64 -d "$CIPHERTEXT_FILE" > "$TMP_CIPHERTEXT"

if [[ -n "$ATTESTATION_B64_FILE" ]]; then
  TMP_RECIPIENT=$(mktemp)
  node -e "
    const fs = require('fs');
    const b64 = fs.readFileSync(process.argv[1], 'utf8').trim();
    fs.writeFileSync(process.argv[2], JSON.stringify({
      KeyEncryptionAlgorithm: 'RSAES_OAEP_SHA_256',
      AttestationDocument: b64,
    }));
  " "$ATTESTATION_B64_FILE" "$TMP_RECIPIENT"

  aws kms decrypt \
    --region "$REGION" \
    --key-id "$KEY_ALIAS" \
    --ciphertext-blob "fileb://${TMP_CIPHERTEXT}" \
    --recipient "file://${TMP_RECIPIENT}"
else
  echo "No attestation supplied — calling Decrypt with NO Recipient (expect AccessDeniedException):" >&2
  aws kms decrypt \
    --region "$REGION" \
    --key-id "$KEY_ALIAS" \
    --ciphertext-blob "fileb://${TMP_CIPHERTEXT}"
fi
