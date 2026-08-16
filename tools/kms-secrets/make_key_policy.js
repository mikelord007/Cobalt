#!/usr/bin/env node
// PCR-gated KMS key policy generator for Cobalt's attestation-gated secrets broker (D4).
//
// Cobalt is multi-tenant (see src/EnclaveRegistry.sol — apps are keyed by appId, each with its
// own allowed PCR set via setAllowedImage), so the KMS-side gating has to mirror that per-app
// isolation. There is deliberately no shared platform-wide key: each app gets its own KMS key
// (see create_or_update_key.sh), and this script is what scopes that key's policy to exactly
// that app's measurements, so app A's enclave can never decrypt app B's secrets even though both
// run under the same AWS account and possibly the same parent EC2 instance.
//
// Mechanism: kms:Decrypt (and the other recipient-aware KMS APIs) is only granted when the
// caller's attestation document — passed as the `Recipient` parameter on the API call itself,
// generated fresh inside the enclave via NSM — has PCR0/PCR1/PCR2 values matching this policy's
// condition. kms:Encrypt has no such condition: encrypting doesn't require attestation, only
// decrypting does, since only the enclave should ever see plaintext.
//
// Usage:
//   node make_key_policy.js --app-id ping --account-id 279056796721 \
//     --pcr0 <hex96> --pcr1 <hex96> --pcr2 <hex96> [--principal arn:aws:iam::...:root]
//
// Prints the policy JSON to stdout. Pipe into `aws kms create-key --policy file:///dev/stdin`
// or `aws kms put-key-policy` (see create_or_update_key.sh, which drives this).

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      out[key] = val;
      i++;
    }
  }
  return out;
}

function requireHex96(name, val) {
  if (!val || !/^[0-9a-fA-F]{96}$/.test(val)) {
    throw new Error(
      `--${name} must be a 96-hex-char (48-byte / SHA-384) PCR value, got: ${val}`
    );
  }
  return val.toLowerCase();
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const appId = args["app-id"];
  const accountId = args["account-id"];
  if (!appId) throw new Error("--app-id is required (e.g. 'ping')");
  if (!accountId || !/^\d{12}$/.test(accountId)) {
    throw new Error("--account-id must be a 12-digit AWS account id");
  }

  const pcr0 = requireHex96("pcr0", args["pcr0"]);
  const pcr1 = requireHex96("pcr1", args["pcr1"]);
  const pcr2 = requireHex96("pcr2", args["pcr2"]);

  // Principal for both the admin and the encrypt/decrypt statements. Defaults to the account
  // root principal. This is intentionally NOT narrowed to a specific IAM role, because the
  // security boundary here is the attestation condition, not IAM identity — the whole point of
  // this feature is that *even* a principal with full account access (root, or an EC2 instance
  // role with broad permissions) still cannot call kms:Decrypt successfully unless it presents
  // a matching attestation. If you have a dedicated platform-operator role or per-app enclave
  // instance-profile role, pass --principal to scope it down further; that's an IAM-side
  // hardening on top of, not a substitute for, the PCR condition.
  const principal =
    args["principal"] || `arn:aws:iam::${accountId}:root`;

  const policy = {
    Version: "2012-10-17",
    Id: `cobalt-secrets-${appId}-key-policy`,
    Statement: [
      {
        // IMPORTANT: this is deliberately NOT "kms:*". A blanket kms:* grant to root here
        // would include kms:Decrypt itself, unconditionally — silently defeating the whole
        // point of the conditioned statement below. This was caught by actually testing the
        // denial case rather than reading the policy: an earlier draft used "kms:*" here and a
        // plain, no-Recipient kms:decrypt call succeeded and returned plaintext, because *this*
        // unconditioned statement matched even though the conditioned statement below correctly
        // denied it. Key management actions only — no cryptographic operations (Decrypt/Encrypt/
        // GenerateDataKey*/GenerateRandom/DeriveSharedSecret/ReEncrypt/Sign/Verify) are granted
        // here.
        Sid: "EnableIamRootKeyManagementOnly",
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${accountId}:root` },
        Action: [
          "kms:CreateAlias",
          "kms:DeleteAlias",
          "kms:UpdateAlias",
          "kms:DescribeKey",
          "kms:EnableKey",
          "kms:DisableKey",
          "kms:PutKeyPolicy",
          "kms:GetKeyPolicy",
          "kms:GetKeyRotationStatus",
          "kms:EnableKeyRotation",
          "kms:DisableKeyRotation",
          "kms:ScheduleKeyDeletion",
          "kms:CancelKeyDeletion",
          "kms:CreateGrant",
          "kms:ListGrants",
          "kms:RevokeGrant",
          "kms:UpdateKeyDescription",
          "kms:TagResource",
          "kms:UntagResource",
          "kms:ListResourceTags",
        ],
        Resource: "*",
      },
      {
        Sid: "AllowEncryptNoAttestationRequired",
        Effect: "Allow",
        Principal: { AWS: principal },
        Action: ["kms:Encrypt", "kms:DescribeKey", "kms:GetPublicKey"],
        Resource: "*",
      },
      {
        // This is the actual gate. kms:Decrypt (and the other recipient-aware ops) is only
        // permitted when the request's Recipient.AttestationDocument decodes to PCR0/PCR1/PCR2
        // exactly matching this app's measured values. PCR0 uses AWS's
        // `kms:RecipientAttestation:ImageSha384` condition key name (it's the enclave image
        // hash); PCR1/PCR2 use `kms:RecipientAttestation:PCR<N>` — note the asymmetric naming.
        Sid: `AllowDecryptOnlyWithMatchingAttestation-${appId}`,
        Effect: "Allow",
        Principal: { AWS: principal },
        Action: [
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:GenerateDataKeyPair",
          "kms:GenerateRandom",
          "kms:DeriveSharedSecret",
        ],
        Resource: "*",
        Condition: {
          StringEqualsIgnoreCase: {
            "kms:RecipientAttestation:ImageSha384": pcr0,
            "kms:RecipientAttestation:PCR1": pcr1,
            "kms:RecipientAttestation:PCR2": pcr2,
          },
        },
      },
    ],
  };

  process.stdout.write(JSON.stringify(policy, null, 2) + "\n");
}

main();
