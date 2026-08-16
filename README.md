# Cobalt

A platform for running application logic inside an AWS Nitro Enclave — a hardware-isolated
trusted execution environment — with the enclave's output cryptographically verified on Monad.
The operator, including anyone with root access to the machine hosting the enclave, cannot see
inside it or forge its output. Monad only trusts a result after AWS's own hardware has proven,
via a signed attestation, exactly which code produced it.

See `ARCHITECTURE.md` for the full design and `PLAN.md` for the build plan this repo followed.

## What's here

- **`src/`** — the on-chain attestation registry (`EnclaveRegistry.sol`), an EIP-712 consumer SDK
  (`EnclaveConsumer.sol`), and a vendored Nitro attestation verifier
  (`src/vendor/nitro-validator/`). Multi-tenant from the start: any number of apps register
  against the same deployed registry, keyed by `appId`.
- **`enclave-server/`** — a reusable Rust server template that runs inside the enclave: a fresh
  secp256k1 keypair per boot, hand-rolled EIP-712 signing, an AWS NSM attestation endpoint with
  the signing key explicitly bound, an outbound-network allowlist, and attestation-gated KMS
  secrets. Apps are drop-in modules under `src/nautilus-server/src/apps/`.
- **`tools/cobalt.js`** — the CLI. `cobalt deploy <app-dir>` runs attest → createApp →
  setAllowedImage → registerEnclave → verify against the already-deployed registry, end to end.
- **`tools/registrar.js`** — turns a raw attestation into an on-chain transaction plan, handling
  Monad's gas-estimation quirks (see `ARCHITECTURE.md` §2).
- **`examples/ping/`** — the proof-of-pipeline app: send it a message, get back an EIP-712-signed
  reply, verified on Monad by `PingConsumer.sol`.

## Quickstart

```
node tools/cobalt.js status examples/ping
node tools/cobalt.js deploy examples/ping --secrets env.json
```

Requires `PRIVATE_KEY` in the environment (a funded Monad testnet key), `forge`/`cast` on `PATH`,
and — for a real deploy rather than `--dry-run` — SSH access to an enclave-capable EC2 instance.

## Deployed (Monad testnet, chain 10143)

See `deployments/monad-testnet.json` for the live registry, verifier, and example consumer
addresses.
