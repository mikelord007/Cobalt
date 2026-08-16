#!/usr/bin/env bash
# Create (first run) or update (subsequent runs, e.g. after a PCR-changing rebuild) a per-app,
# PCR-gated KMS key for Cobalt's attestation-gated secrets broker (D4).
#
# One KMS key per app (alias/cobalt-secrets-<app-id>) — deliberately NOT a shared platform-wide
# key, so app A's enclave can never decrypt app B's secrets even though both run under the same
# AWS account/instance. See make_key_policy.js for why the policy is structured the way it is
# (in particular: the admin statement must NOT be a blanket "kms:*", or it silently defeats the
# attestation gate).
#
# Usage:
#   ./create_or_update_key.sh <app-id> <pcr0-hex> <pcr1-hex> <pcr2-hex> [account-id] [region]
#
# Example (the ping app, its real currently-deployed measurements):
#   ./create_or_update_key.sh ping \
#     b4231239879ca56efc89f7d0ea706cb1c78848ea37b9fda7ee87878c029d11121fc8e64c6b8174b19f5402d95d5d6fdf \
#     4b4d5b3661b3efc12920900c80e126e4ce783c522de6c02a2a5bf7af3a2b9327b86776f188e4be1c1c404a129dbda493 \
#     1bd0207ec970a7b2b0fff97c319e4d768960f36ff8e88a39df92ea45a0517d9c3a616045bb09aaa0a91663297fcf287e
#
# When an app's code changes and gets rebuilt, its PCR0 (and possibly PCR2) changes too — re-run
# this script with the new values and it will update the existing key's policy in place (no new
# key, no 7-day deletion wait; key policy updates are immediate and free).

set -euo pipefail

APP_ID="${1:?usage: create_or_update_key.sh <app-id> <pcr0> <pcr1> <pcr2> [account-id] [region]}"
PCR0="${2:?missing pcr0}"
PCR1="${3:?missing pcr1}"
PCR2="${4:?missing pcr2}"
ACCOUNT_ID="${5:-279056796721}"
REGION="${6:-${AWS_REGION:-us-east-1}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALIAS="alias/cobalt-secrets-${APP_ID}"
POLICY_FILE="${SCRIPT_DIR}/.policy-${APP_ID}.json"

node "${SCRIPT_DIR}/make_key_policy.js" \
  --app-id "$APP_ID" \
  --account-id "$ACCOUNT_ID" \
  --pcr0 "$PCR0" \
  --pcr1 "$PCR1" \
  --pcr2 "$PCR2" \
  > "$POLICY_FILE"

EXISTING_KEY_ID=$(aws kms describe-key --region "$REGION" --key-id "$ALIAS" \
  --query 'KeyMetadata.KeyId' --output text 2>/dev/null || true)

if [[ -z "$EXISTING_KEY_ID" || "$EXISTING_KEY_ID" == "None" ]]; then
  echo "No existing key for $ALIAS — creating a new one." >&2
  KEY_ID=$(aws kms create-key \
    --region "$REGION" \
    --description "Cobalt per-app secrets broker key: ${APP_ID} (PCR-gated via Recipient attestation)" \
    --key-usage ENCRYPT_DECRYPT \
    --key-spec SYMMETRIC_DEFAULT \
    --policy "file://${POLICY_FILE}" \
    --tags "TagKey=platform,TagValue=cobalt-secrets-broker" "TagKey=app-id,TagValue=${APP_ID}" \
    --query 'KeyMetadata.KeyId' --output text)
  aws kms create-alias --region "$REGION" --alias-name "$ALIAS" --target-key-id "$KEY_ID"
  echo "Created $ALIAS -> $KEY_ID" >&2
else
  echo "Existing key found for $ALIAS ($EXISTING_KEY_ID) — updating its policy to the new PCR set." >&2
  # NOTE: put-key-policy requires the raw key id/ARN, not the alias.
  aws kms put-key-policy \
    --region "$REGION" \
    --key-id "$EXISTING_KEY_ID" \
    --policy-name default \
    --policy "file://${POLICY_FILE}"
  echo "Updated policy for $ALIAS ($EXISTING_KEY_ID)" >&2
fi
