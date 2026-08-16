# Attestation-gated secrets (D4): live proof

This documents a real, end-to-end run of the KMS-based secrets broker: a per-app KMS key whose
`Decrypt` permission is conditioned on a Nitro Enclave attestation (not on IAM identity), an
enclave that fetches and decrypts a secret it can only obtain by presenting a matching
attestation, and a direct proof that the same ciphertext is undecryptable by anyone *without* one
— including the AWS account root user.

Tooling lives in `tools/kms-secrets/`:
- `make_key_policy.js` — generates the key policy described below.
- `create_or_update_key.sh <app-id> <pcr0> <pcr1> <pcr2>` — creates/updates the per-app key.
- `encrypt_secret.sh <app-id> <plaintext-file> <out-file>` — encrypts a secrets blob (no
  attestation required).
- `decrypt_with_attestation.sh <app-id> <ciphertext-b64-file> [attestation-b64-file]` — manual
  test helper; with no attestation file, it calls `Decrypt` with no `Recipient` at all.

## The key policy, and why the admin statement isn't `kms:*`

`ping`'s key (`alias/cobalt-secrets-ping`,
`arn:aws:kms:us-east-1:279056796721:key/a79e660a-3b6c-417c-bc1c-07354f78b058`) has three
statements:

1. **`EnableIamRootKeyManagementOnly`** — the account root principal can manage the key (create
   aliases, read/write the policy, rotate, tag, etc.) but this statement deliberately does **not**
   include `kms:Decrypt`, `kms:Encrypt`, or any other cryptographic action. A blanket `kms:*` here
   would silently defeat statement 3 below: it would unconditionally grant `kms:Decrypt` to root,
   and IAM/KMS policy evaluation is a straight union of every matching `Allow` — one unconditioned
   `Allow` anywhere is enough to grant the call, no matter how tightly a different statement
   scopes it. This is exactly the failure mode the denial-case test below is built to catch: it
   doesn't matter how correct statement 3's `Condition` block looks on paper if some other
   statement in the same policy grants the same action unconditionally.
2. **`AllowEncryptNoAttestationRequired`** — `kms:Encrypt`/`DescribeKey`/`GetPublicKey`, no
   condition. Encrypting doesn't reveal plaintext to the caller, so it doesn't need an
   attestation; only decrypting does.
3. **`AllowDecryptOnlyWithMatchingAttestation-ping`** — `kms:Decrypt` and the other
   recipient-aware crypto actions, gated by:
   ```json
   "Condition": {
     "StringEqualsIgnoreCase": {
       "kms:RecipientAttestation:ImageSha384": "<PCR0>",
       "kms:RecipientAttestation:PCR1": "<PCR1>",
       "kms:RecipientAttestation:PCR2": "<PCR2>"
     }
   }
   ```
   PCR0 uses AWS's `ImageSha384` condition key name (not `PCR0`); PCR1/PCR2 use `PCR1`/`PCR2`
   directly. This only matches when the caller's KMS `Recipient.AttestationDocument` — a live NSM
   attestation, generated inside a running enclave and bound to an ephemeral RSA public key — has
   exactly these three measurements. All three statements use `Principal: arn:aws:iam::<account>:root`
   on purpose: the security boundary here is the attestation condition, not IAM identity. The
   whole point is that *even a principal with full account access* still can't call `Decrypt`
   successfully without presenting a matching attestation.

Regenerate/update the policy after any rebuild that changes PCR0 (or PCR2 — the application image
layer) with:
```
./tools/kms-secrets/create_or_update_key.sh ping <new-pcr0> <pcr1> <pcr2>
```
This updates the existing key's policy in place — no new key, no deletion wait.

## Proof 1: the denial case

Simulating "an operator with root access to the parent EC2 instance just tries to decrypt the
ciphertext directly" — a plain `kms:Decrypt` call with **no** `Recipient` — against the real
ciphertext used in the live run below, using the scoped IAM user's own credentials:

```
$ ./tools/kms-secrets/decrypt_with_attestation.sh ping inner-secret.ciphertext.b64
No attestation supplied — calling Decrypt with NO Recipient (expect AccessDeniedException):

An error occurred (AccessDeniedException) when calling the Decrypt operation: User:
arn:aws:iam::279056796721:user/cobalt-enclave-kms-ping is not authorized to perform: kms:Decrypt
on resource: arn:aws:kms:us-east-1:279056796721:key/a79e660a-3b6c-417c-bc1c-07354f78b058 because
no resource-based policy allows the kms:Decrypt action
```

And, for extra rigor, the exact same call using the **account root** credentials (proving this
isn't an IAM-scoping accident — root itself has no path to this key's plaintext without a
matching attestation):

```
An error occurred (AccessDeniedException) when calling the Decrypt operation: User:
arn:aws:iam::279056796721:root is not authorized to perform: kms:Decrypt on resource:
arn:aws:kms:us-east-1:279056796721:key/a79e660a-3b6c-417c-bc1c-07354f78b058 because no
resource-based policy allows the kms:Decrypt action
```

Both denied with `AccessDeniedException`. The ciphertext is only ever decryptable by presenting a
`Recipient.AttestationDocument` whose PCR0/PCR1/PCR2 match statement 3 above.

(Building this locally caught a real bug worth calling out: an earlier draft of
`decrypt_with_attestation.sh` passed AWS CLI a quoted `"fileb://<(base64 -d ...)"` string.
Process substitution does not expand inside double quotes in bash, so the CLI received the
literal, un-substituted text and failed with a paramfile error rather than actually attempting
the call. Fixed by decoding to a real temp file first — caught by actually running it, not by
reading it.)

## Proof 2: a real enclave, live, decrypting and booting from the KMS secret

The scoped credentials delivered to the enclave (`cobalt-enclave-kms-ping`, an IAM user with an
inline policy granting only `kms:Decrypt`/`kms:DescribeKey`/`kms:GetPublicKey`/`kms:Encrypt` on
this one key's ARN — no wildcard resource) were used to encrypt a JSON payload containing the
app's actual boot-critical config:

```json
{"CONSUMER_CONTRACT_ADDRESS": "0xf62EAF1fdE81723f4d80b21eAb0A9b330ebA3a97", "MONAD_CHAIN_ID": "10143", "EIP712_DOMAIN_NAME": "Cobalt-Ping", "EIP712_DOMAIN_VERSION": "1"}
```
```
./tools/kms-secrets/encrypt_secret.sh ping inner-secret.json inner-secret.ciphertext.b64
```

The *outer* secrets payload delivered to the enclave over vsock:7777 at deploy time deliberately
contains no `CONSUMER_CONTRACT_ADDRESS` at all — only the means to fetch and decrypt it:
```json
{
  "KMS_SECRETS_CIPHERTEXT_B64": "<ciphertext from above>",
  "KMS_SECRETS_KEY_ID": "arn:aws:kms:us-east-1:279056796721:key/a79e660a-3b6c-417c-bc1c-07354f78b058",
  "AWS_REGION": "us-east-1",
  "AWS_ACCESS_KEY_ID": "<cobalt-enclave-kms-ping access key>",
  "AWS_SECRET_ACCESS_KEY": "<cobalt-enclave-kms-ping secret key>"
}
```

`main.rs` reads `KMS_SECRETS_CIPHERTEXT_B64` before anything else at boot and `.expect()`s the
decrypt to succeed; `CONSUMER_CONTRACT_ADDRESS` is itself `.expect()`'d immediately after. If the
enclave's own NSM attestation didn't match the key policy's PCR condition, `kms_secrets::fetch_secrets`
would fail with `AccessDeniedException` (exactly as in Proof 1) and the process would panic before
ever binding a port. A successful boot is therefore only possible if SigV4 signing, the Recipient
attestation call, KMS's CMS/BER envelope, RSA-OAEP key unwrap, and AES-256-CBC decrypt all worked,
end to end, inside a real enclave.

This was deployed to a disposable scratch EC2 instance (never the live, registered `ping`
instance) via `deploy_and_attest.sh ping --secrets outer-secrets.json --instance-ip <scratch-ip>`.
Result:

```
$ curl http://<scratch-ip>:3000/health
{"pk":"04d271dcf83f587e571f602bcdddde7cebbe2323b57aa67b207824d6e23d429b611e75fd57c4a0a3a135b4dd411cd6b0289d003999c9d8bdd1418789a60db265ce",
 "eth_address":"0x2c84d6d12949c6f20ff3c84b1d1110d689727d99","endpoints_status":{}}

$ curl -X POST http://<scratch-ip>:3000/ping -d '{"message":"kms works","deadline":9999999999,"nonce":"0x0000000000000000000000000000000000000000000000000000000000000001"}'
{"message":"pong: kms works","deadline":9999999999,
 "nonce":"0x0000000000000000000000000000000000000000000000000000000000000001",
 "signature":"0x265d56dcdd28a6e15b0dace0ce1eee51c7977ffe6394d3d6866fd1a53f30148c5e5fb034fc3a00711455cac5c65679e8346841800f26734e3dc6fc08a3e6a3de1b"}
```

The enclave booted and signed. That alone proves the decrypt path worked. As a further,
cryptographic check (not just "it didn't crash"), the signature was independently verified to
recover to the reported `eth_address` under the exact EIP-712 domain that only ever existed inside
the ciphertext (`name: "Cobalt-Ping"`, `version: "1"`, `chainId: 10143`,
`verifyingContract: 0xf62EAF1fdE81723f4d80b21eAb0A9b330ebA3a97`) — i.e. the decrypted
`CONSUMER_CONTRACT_ADDRESS`/`EIP712_DOMAIN_*` values weren't merely present in the environment,
they were the values actually used to construct the signing domain:

```js
ethers.verifyTypedData(domain, types, value, signature)
// => 0x2c84D6d12949c6f20Ff3c84B1d1110D689727d99  (matches eth_address exactly)
```

## A gap this proof surfaced: enclave-side network egress

`kms_secrets.rs`'s `reqwest` client makes a normal HTTPS call to `kms.<region>.amazonaws.com`. A
Nitro Enclave has no network interface at all beyond loopback — only vsock — and the shipped
`run.sh` only ever brought up loopback. The parent instance's `nitro-enclaves-vsock-proxy` service
(vsock port 8000 → `kms.<region>.amazonaws.com:443`, gated by its own allowlist) is necessary but
not sufficient: something inside the enclave still has to turn a normal `https://kms.us-east-1.amazonaws.com/`
request into a connection over vsock to the parent. `run.sh` now does exactly that — a loopback
`/etc/hosts` mapping for the KMS hostname plus a `socat` bridge from `127.0.0.1:443` to
`VSOCK-CONNECT:3:8000` (CID 3 is the reserved parent-instance CID from inside any enclave) —
before the app binary starts. TLS (including SNI and certificate validation) passes through this
bridge untouched; only the transport hop changes. This is the one piece of enclave-server source
this work touched, and it's why PCR0/PCR2 for the build used in this proof differ from the
previously-registered `ping` measurements — the KMS key's policy was updated in place (`create_or_update_key.sh`)
to the new values before the live run, exactly the "rebuild changes PCR0" maintenance path the
tooling is designed for. It does not affect the separately-tracked, still-running, still-registered
production `ping` deployment, which was never touched or rebuilt.

## Reproducing

```bash
# 1. Create/update the per-app key (idempotent).
./tools/kms-secrets/create_or_update_key.sh ping <pcr0> <pcr1> <pcr2>

# 2. Scoped IAM user + access key (one-time).
aws iam create-user --user-name cobalt-enclave-kms-ping
aws iam put-user-policy --user-name cobalt-enclave-kms-ping \
  --policy-name ping-secrets-key-only --policy-document file://iam-user-policy.json
aws iam create-access-key --user-name cobalt-enclave-kms-ping

# 3. Encrypt the real secret.
./tools/kms-secrets/encrypt_secret.sh ping inner-secret.json inner-secret.ciphertext.b64

# 4. Denial case (must fail).
./tools/kms-secrets/decrypt_with_attestation.sh ping inner-secret.ciphertext.b64

# 5. Deploy to a real enclave with the KMS-flavored outer secrets.json and confirm /health + /ping.
./deploy_and_attest.sh ping --secrets outer-secrets.json --instance-ip <target-ip>
```
