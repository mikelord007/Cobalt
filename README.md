# Cobalt

A platform for running application logic inside an AWS Nitro Enclave — a hardware-isolated
trusted execution environment — with the enclave's output cryptographically verified on Monad.
The operator, including anyone with root access to the machine hosting the enclave, cannot see
inside it or forge its output. Monad only trusts a result after AWS's own hardware has proven,
via a signed attestation, exactly which code produced it.

See `ARCHITECTURE.md` for the full design and `PLAN.md` for the build plan this repo followed.

## Live

**[cobalt-alpha-five.vercel.app](https://cobalt-alpha-five.vercel.app/)** — the read-only
registry dashboard and landing page: browse registered apps, allowed images, and signer state on
the live Monad testnet registry described below. It doesn't deploy anything itself — deploying is
a CLI action (see below) — it's where you go to watch the result show up on-chain afterward.

## Deployed (Monad testnet, chain 10143)

RPC: `https://testnet-rpc.monad.xyz`

| Contract | Address |
|---|---|
| `P384Verifier` | [`0xC39773993C23f1E77898A15A38784a1b2896a423`](https://testnet.monadvision.com/address/0xC39773993C23f1E77898A15A38784a1b2896a423) |
| `CertManager` | [`0xb36f152CeF341FFA631Adc306C0ed1354d4D52CE`](https://testnet.monadvision.com/address/0xb36f152CeF341FFA631Adc306C0ed1354d4D52CE) |
| `NitroValidator` | [`0x064Bb793b55e34945471afF31781A32c5839Dffe`](https://testnet.monadvision.com/address/0x064Bb793b55e34945471afF31781A32c5839Dffe) |
| `EnclaveRegistry` | [`0xccF281dE61bfb970575827B5c962345F39bDa145`](https://testnet.monadvision.com/address/0xccF281dE61bfb970575827B5c962345F39bDa145) |
| `PingConsumer` (example) | [`0xf62EAF1fdE81723f4d80b21eAb0A9b330ebA3a97`](https://testnet.monadvision.com/address/0xf62EAF1fdE81723f4d80b21eAb0A9b330ebA3a97) |

All five contracts are source-verified (exact match) on [MonadVision](https://testnet.monadvision.com),
the Sourcify-backed Monad testnet explorer, so the addresses above link straight to each contract's
verified source. See `deployments/monad-testnet.json` for the machine-readable version, including
the `ping` example's `appId`, and `VERIFICATION.md` for how verification was done and reproduced.

## What's here

- **`src/`** — the on-chain attestation registry (`EnclaveRegistry.sol`), an EIP-712 consumer SDK
  (`EnclaveConsumer.sol`), and a vendored Nitro attestation verifier
  (`src/vendor/nitro-validator/`). Multi-tenant from the start: any number of apps register
  against the same deployed registry, keyed by `appId`.
- **`enclave-server/`** — a reusable Rust server template that runs inside the enclave: a fresh
  secp256k1 keypair per boot, hand-rolled EIP-712 signing, an AWS NSM attestation endpoint with
  the signing key explicitly bound, an outbound-network allowlist, and attestation-gated KMS
  secrets. Apps are drop-in modules that live in the repo's top-level `examples/<name>/`, wired
  in by a one-line `#[path]` include in `enclave-server/src/nautilus-server/src/lib.rs` — the app
  code itself never lives inside `enclave-server/`.
- **`tools/cobalt.js`** — the CLI. `cobalt deploy <app-dir>` runs attest → createApp →
  setAllowedImage → registerEnclave → verify against the already-deployed registry, end to end.
- **`tools/registrar.js`** — turns a raw attestation into an on-chain transaction plan, handling
  Monad's gas-estimation quirks (see `ARCHITECTURE.md` §2).
- **`examples/ping/`** — the proof-of-pipeline app: send it a message, get back an EIP-712-signed
  reply, verified on Monad by `PingConsumer.sol`.
- **`examples/dice/`** — a verifiable dice roll: a hardware-attested random number an operator
  can't rig, signed by the enclave.

## Deploying an app with the CLI

`cobalt deploy` registers against the already-deployed, already-live Cobalt **registry contracts**
on Monad testnet (the addresses above) — you don't need to deploy your own copy of those. It does
**not**, however, give you someone else's enclave-hosting infrastructure for free: the CLI drives
your own AWS account over SSH to build and boot the enclave, so you need your own EC2 setup first
(key pair, security group, user-data — see "Enclave host setup" under "Running the whole platform
yourself" below) before `cobalt deploy` can actually launch anything.

**Want to see the platform work without any AWS setup?**

```
npm install -g cobalt-tee
git clone https://github.com/mikelord007/Cobalt.git   # no --recurse-submodules needed for this --
cd Cobalt                                              # status never touches lib/ or runs forge
cobalt status examples/ping
```

Reads the live registry state on Monad testnet for the deployed `ping` app — no key, no AWS
account. Still needs the clone (`cobalt` looks for `deployments/monad-testnet.json` alongside
`foundry.toml`/`enclave-server/` to know which registry to read), but it's the fast, plain clone —
just the two commands above, done in seconds.

### Prerequisites

- Node 18+.
- **Windows**: run `cobalt` from [Git Bash](https://git-scm.com/downloads/win) or from inside
  [WSL](https://learn.microsoft.com/windows/wsl/install) — the attest step shells out to a real
  bash script (`enclave-server/deploy_and_attest.sh`) that plain PowerShell/cmd.exe can't run.
  `cobalt status`, which never needs bash, works from any Windows shell.
- An AWS account with EC2 permissions and the AWS CLI configured (`aws configure`), an EC2 key
  pair, and a security group — see "Enclave host setup" below. Not needed for `cobalt status`.
- A funded Monad testnet wallet. Get testnet MON from `https://faucet.monad.xyz`.
- Foundry (`forge`/`cast`) — `npm install -g cobalt-tee`'s `postinstall` script tries to
  auto-install Foundry for you if it isn't already on `PATH` (downloads the official release
  straight from GitHub, verifies its checksum, and bundles it privately under the package without
  touching your `PATH`). This should mean a separate install step usually isn't necessary — but
  it's a best-effort step that quietly warns and moves on if it can't reach GitHub or your
  platform/arch isn't covered, rather than failing the install. If Foundry still isn't found the
  first time you run `cobalt`, it'll tell you clearly and point you at
  [getfoundry.sh](https://getfoundry.sh) — install it manually there if that happens.

### Install

```
npm install -g cobalt-tee
export PRIVATE_KEY=0x...   # a funded Monad testnet key -- PowerShell: $env:PRIVATE_KEY = "0x..."
```

### Deploy an example

```
git clone --recurse-submodules https://github.com/mikelord007/Cobalt.git
cd Cobalt
cobalt deploy examples/dice --secrets env.json
```

`cobalt` resolves your project checkout by walking up from `<app-dir>` looking for `foundry.toml` +
`enclave-server/`, so this clone is load-bearing — it's where `forge`'s build artifacts and the
CLI's other working state land, not just where the example configs happen to live. `--recurse-submodules`
matters here too: `lib/forge-std` and `lib/openzeppelin-contracts` are git submodules (see
`.gitmodules`), and `cobalt deploy` runs `forge script` against this exact checkout, so a clone
without them fails partway through with a "Source not found" error from `forge`. Already have a
clone without it? `git submodule update --init --recursive` fixes it in place.

(`examples/ping/` — the pipeline proof-of-concept, send a message, get an EIP-712-signed reply —
works the same way: `cobalt deploy examples/ping --secrets env.json`.)

`--secrets` is a JSON file, resolved relative to the app directory, passed through to the enclave
over an attestation-gated channel — `examples/dice/env.json` and `examples/ping/env.json` show the
shape (EIP-712 domain name/version and a consumer contract address).

### What actually happens

`cobalt deploy` runs the full sequence against the live registry above, end to end:

1. **attest** — build (or reuse a cached build of) the app's enclave image, boot it on
   enclave-capable compute, and pull a real hardware attestation from it.
2. **createApp** — register the app's identity on-chain, if it doesn't exist yet.
3. **setAllowedImage** — allow this specific build's PCR measurements under the app's current
   config version.
4. **registerEnclave** — submit the attestation itself; the registry verifies it against the
   vendored Nitro validator and records the enclave's derived signing address.
5. **verify** — a final on-chain read (`isValidSigner`) confirming the newly registered address is
   now trusted for this `appId`.

**The first deploy of a given app is a real, uncached build** — expect several minutes (a hermetic
enclave image build is genuinely slow; see `ARCHITECTURE.md` §9.1). Every deploy after that, for
that same source, hits an S3 artifact cache and is fast — no rebuild, just download and boot.

### Check on it afterward

```
cobalt status examples/dice
```

Prints the app's on-chain state (owner, config version, signer TTL, paused) and, if a local deploy
manifest exists, whether its enclave's signer is currently valid. Or just open the
[live dashboard](https://cobalt-alpha-five.vercel.app/) — this is exactly the on-chain state it's
reading.

## Running the whole platform yourself

The more involved case: you want to deploy your **own** copy of the registry contracts and run
your **own** enclave-hosting infrastructure, rather than deploying against the already-live one
above. This is real infrastructure work — AWS costs money, and Nitro Enclaves are genuinely picky
about instance types and launch-time flags — not a five-minute setup.

### Prerequisites

- An AWS account with EC2, IAM, KMS, and S3 permissions, and the AWS CLI configured
  (`aws configure`).
- A funded Monad testnet wallet, Foundry, Node 18+.
- An SSH key pair (an EC2 key pair you control the private half of).

### On-chain setup

```
git clone --recurse-submodules https://github.com/mikelord007/Cobalt.git
cd Cobalt
```

`lib/forge-std` and `lib/openzeppelin-contracts` are git submodules (see `.gitmodules` and
`remappings.txt`) — `--recurse-submodules` on clone pulls them in; if you already cloned without
it, run `git submodule update --init --recursive` instead of `forge install`.

Deploy the contract stack in order — each one's constructor takes the previous one's address, so
this order is not optional:

PowerShell users: replace every `export VAR=value` below with `$env:VAR = "value"`, and
`\`-continued lines with a trailing `` ` `` (backtick) instead of `\`, or just run the whole block
from Git Bash / WSL, where it works unmodified.

```
export PRIVATE_KEY=0x...
export RPC_URL=https://testnet-rpc.monad.xyz   # or your own target chain

# 1. P384Verifier -- no constructor args, chain-agnostic (AWS root CA is a compile-time constant)
forge create src/vendor/nitro-validator/src/P384Verifier.sol:P384Verifier \
  --rpc-url $RPC_URL --private-key $PRIVATE_KEY

# 2. CertManager(IP384Verifier p384Verifier_, address initialOwner, address initialRevoker)
forge create src/vendor/nitro-validator/src/CertManager.sol:CertManager \
  --rpc-url $RPC_URL --private-key $PRIVATE_KEY \
  --constructor-args <P384_VERIFIER_ADDR> <OWNER_ADDR> <REVOKER_ADDR>

# 3. NitroValidator(ICertManager _certManager, IP384Verifier _p384Verifier)
forge create src/vendor/nitro-validator/src/NitroValidator.sol:NitroValidator \
  --rpc-url $RPC_URL --private-key $PRIVATE_KEY \
  --constructor-args <CERT_MANAGER_ADDR> <P384_VERIFIER_ADDR>

# 4. EnclaveRegistry(INitroValidator nitroValidator_)
forge create src/EnclaveRegistry.sol:EnclaveRegistry \
  --rpc-url $RPC_URL --private-key $PRIVATE_KEY \
  --constructor-args <NITRO_VALIDATOR_ADDR>
```

`src/vendor/nitro-validator/test/helpers/CertManagerDemo.sol` is a test-only alternative to
`CertManager` (looser expiry grace, no owner/revoker split) used by that project's own test suite —
use the real `CertManager` above for anything you intend to actually rely on.

Then write the deployed addresses into a `deployments/<network>.json` file matching the shape of
the existing `deployments/monad-testnet.json` (`chainId`, `rpcUrl`, `p384Verifier`, `certManager`,
`nitroValidator`, `enclaveRegistry`, plus whatever consumer/app fields your own apps need) — see
"point the CLI at your own deployment" below for how this file gets picked up.

### Enclave host setup

This is the part that's genuinely picky. The reference for all of it is
`enclave-server/provisioner.sh`'s `launch_new_instance()` function — it's not a description of the
process, it's the actual automation, and it's worth reading directly. The key facts:

- **Instance type needs enclave support, set at launch time.** The project uses `c6a.xlarge`
  (4 vCPU / 2 physical cores — a Nitro enclave needs a whole physical core, with at least one more
  reserved for the host) launched with `--enclave-options Enabled=true`. This flag is launch-time
  only — you cannot enable it on a running instance.
- **A security group** opening SSH (22) and whatever ports you plan to serve apps on (the
  deploy flow allocates parent-host ports starting at 3000, incrementing per app on the same
  instance).
- **Cloud-init / user-data** that installs `aws-nitro-enclaves-cli`, Docker, and `socat`, and
  configures the Nitro allocator (`memory_mib` / `cpu_count` in
  `/etc/nitro_enclaves/allocator.yaml`). Copy `enclave-server/user-data.sh.example` to
  `.secrets/user-data.sh` (gitignored, so `provisioner.sh` expects you to put your own copy there
  — or point `$COBALT_USER_DATA` at one elsewhere). Nothing in the template is actually secret; it
  lives outside version control as operator-side infra config, not private data. It `dnf install`s
  the Nitro CLI, Docker, socat, git, make, and jq, adds `ec2-user` to the `docker`/`ne` groups,
  starts the allocator and vsock-proxy services, sets the allocator to 3072 MiB / 2 CPUs, and opens
  a vsock-proxy allowlist entry for KMS.

`provisioner.sh acquire <app>` automates the actual launch end to end — it checks existing
instances for spare physical-core capacity, and if nothing has room, launches a fresh `c6a.xlarge`
with that user-data, waits for it to reach `running` state, then polls SSH until `nitro-cli` and
Docker are actually up (not just the instance being "running") before registering it and handing
back its IP. `enclave-server/deploy_and_attest.sh` calls this automatically when you don't pass
`--instance-ip` yourself, so in practice you don't drive the EC2 console by hand — but note it
caps itself at 4 concurrent instances (`MAX_INSTANCES`, matched to a default 16-vCPU account
quota) and will error out explicitly rather than silently queueing past that.

### Point the CLI at your own deployment

`tools/cobalt.js` resolves the registry/cert-manager/validator addresses and RPC URL in this
precedence, per flag:

- `--registry`, `--cert-manager`, `--validator`: CLI flag → the app directory's `cobalt.json`
  (`registry` / `certManager` / `validator` fields) → `deployments/monad-testnet.json`'s
  `enclaveRegistry` / `certManager` / `nitroValidator` fields.
- `--rpc-url`: CLI flag → `deployments/monad-testnet.json`'s `rpcUrl` field → the hardcoded Monad
  testnet RPC. **`cobalt.json` is not consulted for `rpcUrl`** — there's no per-app RPC override,
  only the flag or the shared defaults file.

`deployments/monad-testnet.json`'s path is currently hardcoded in `loadChainDefaults()` — there's
no `--network` selector for a different defaults file. So to run against your own deployment, do
one of:

- Pass `--registry <addr> --cert-manager <addr> --validator <addr> --rpc-url <url>` on every
  `cobalt deploy` / `cobalt status` call, or
- Add `registry` / `certManager` / `validator` fields to the app's own `cobalt.json` (still pass
  `--rpc-url` each time, since that field isn't read from there), or
- Edit `deployments/monad-testnet.json` in your checkout directly to point at your own deployed
  addresses (simplest if this checkout is exclusively pointed at your own deployment from here on).

## Trust model, in one sentence

Correctness — that a result really came from the claimed code — is cryptographically enforced and
cannot be faked by the operator. Liveness — that the service is actually up and answering — still
requires trusting whoever runs the infrastructure. See `ARCHITECTURE.md` §8 for the full framing.
