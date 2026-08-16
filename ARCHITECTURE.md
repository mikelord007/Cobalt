# Verifiable Off-Chain Compute on Monad — Architecture

A platform for running application logic inside an AWS Nitro Enclave (a hardware-isolated trusted
execution environment), with the enclave's output cryptographically verified on-chain by Monad. The
operator — including anyone with root access to the machine hosting the enclave — cannot see inside
it or forge its output. Monad only trusts a result after AWS's own hardware has proven, via a signed
attestation, exactly which code produced it.

Derived from three references, studied in depth before building anything:

- **`MystenLabs/nautilus`** — developer-facing shape: enclave server template, reproducible StageX
  build, generic on-chain registry. (Move/Sui, Ed25519 — adapted below to EVM/secp256k1.)
- **`base/nitro-validator`** — on-chain Nitro attestation verification in Solidity: the hinted-P384
  construction, CBOR/COSE parsing, X.509 chain walking, global cert cache.
- **`base/op-enclave`** — a production consumer of the above; source of the secp256k1/`ecrecover`
  adaptation, the register-signer pattern, and the separate-RSA-key trick for encrypted inputs.

---

## 1. Build the platform first — the CLI is the deliverable, not a single app

Build the general-purpose pieces before picking any specific application: the multi-tenant on-chain
registry (§3), the reusable enclave server template with secp256k1/EIP-712 already wired in (§4), and
the deploy-build-attest-register CLI (§5) that ties them together. None of these need to know
anything about a specific app's logic — that's the whole point of building them in this order. Once
the CLI works, "deploy a new app" is a single command (`platform deploy <app-dir>`) for the rest of
the project's life, including whatever app you use to demo it. See `PLAN.md`'s milestone map for the
concrete build order this implies.

This is the opposite of — and faster than — picking one app first, building bespoke infrastructure
around it, and generalizing that infrastructure into a platform only after it already works for one
case. The registry and the server template cost the same to build generic as they do to build
app-specific; there's no reason to pay for that generalization twice.

When you do pick an app to actually deploy and show off through the finished CLI, pick one
deliberately: the "even the operator can't see this" property should be *load-bearing*, not
decorative — a good test is whether you can explain in one sentence why this specific problem is
unsolvable without a TEE.

A strong example: a **sealed-bid (second-price/Vickrey) auction**. These are notoriously unusable
on-chain without a trusted third party — whoever sees every bid can insert a fake losing bid just
under the winner's to inflate the clearing price. Commit-reveal schemes avoid that but are clunky
and griefable (a bidder can simply not reveal). A TEE removes the trusted-auctioneer problem
entirely, with a one-sentence explanation anyone immediately understands.

Whatever you pick, the property worth demonstrating live is the same, and it falls out of the CLI's
deploy flow for free (it already rebuilds images as a matter of course): **rebuild the enclave's code
with the logic tampered, and the resulting measurement changes — the on-chain registry rejects the
new image outright.** *The code cannot lie about what it is.* That's the whole trust model in one
observable fact.

---

## 2. Monad-specific facts that constrain the design

Empirically verified (not assumed from Ethereum docs) — confirm current values before relying on
them, chains evolve.

| Fact | Consequence |
|---|---|
| **Hard 30M gas cap per transaction** (independent of the block gas limit) | Any single verification step must fit under this — check before committing to a construction |
| Monad may activate Ethereum upgrades (e.g. MODEXP repricing) on its own schedule, not Ethereum's | Don't assume Ethereum gas costs port over unchanged — measure directly on Monad |
| Monad charges **gas limit, not gas used** — no refunds for overestimating | Estimate tightly; a wide safety buffer directly costs money, not just efficiency |
| Storage costs (cold `SLOAD`/`SSTORE`) may differ significantly from Ethereum's | Don't assume a contract's Ethereum gas profile applies unchanged |
| Check the current **`BLOCKHASH` window** in blocks *and* convert to wall-clock time using the actual block time — a short block time can make a nominally-256-block window cover under two minutes, not the ~51 minutes it means on Ethereum | If you need block-hash binding beyond that window, use `block.timestamp` + nonces instead, or a history-storage precompile/contract if the chain provides one |
| **`eth_getTransactionReceipt.gasUsed` may not reflect true execution cost** on some chains — verify directly (submit a known-cost transaction with a padded limit, check what the receipt reports) before trusting receipt-based gas tooling | If receipts are unreliable, use `eth_estimateGas` instead, and cross-check it isn't itself a stale/cached artifact by re-estimating the same call against materially different state and confirming the number actually changes |
| **A local EVM simulator (e.g. vanilla `forge script`'s `revm`) may price opcodes as Ethereum, not the target chain** — this silently undershoots gas estimates for storage-heavy calls even when precompile-dominated calls estimate fine | Compute gas limits via a **live `eth_estimateGas` call against the real target-chain RPC**, not a local simulator, for any storage-write-heavy transaction. Consider a chain-flavored fork of your dev tooling if one exists |
| **`eth_estimateGas` against a public RPC may itself be unreliable for some calls**, independent of whether the underlying transaction would actually succeed — ruled out by verifying the on-chain state is genuinely correct via raw `eth_call`, and confirming an out-of-band script with byte-identical calldata succeeds reliably | Build a **fallback**: after retries (including fresh-process retries) are exhausted, fall back to a generous, empirically-safe fixed gas limit and let the real broadcast be authoritative, rather than blocking on an unreliable pre-flight check |

---

## 3. On-chain: the attestation registry

### 3.1 Vendor the Nitro-attestation verifier unmodified

Reuse `base/nitro-validator`'s `P384Verifier` → `CertManager` → `NitroValidator` contract chain
as-is (deploy in that order — both verifier references are immutable constructor args). The AWS
root CA is pinned as compile-time constants, so these contracts are chain-agnostic and deploy to
any EVM chain unchanged.

**Why this exists and what it does**: an AWS Nitro Enclave attestation document is a CBOR/COSE
structure containing a certificate chain and a P-384 ECDSA signature. Verifying this fully on-chain
via naive modular exponentiation is far too expensive on any gas-constrained chain. The "hinted"
construction sidesteps this: the caller computes the expensive modular inversions off-chain and
submits them as **hints** — the contract only *checks* each hint (`b · inv ≡ 1 mod m`, one cheap
multiply) rather than *computing* it (an expensive ~384-bit exponentiation). A wrong hint simply
reverts; it can never force a false accept, since checking is cryptographically sound regardless of
who proposes the hint. This typically brings a full attestation verification from an infeasible gas
cost down to something that fits in a handful of transactions.

The certificate chain has tiered lifetimes (root: years, regional/zonal CAs: days to weeks,
leaf/instance certs: hours) and the verifier's cache is **shared, global on-chain state** — once any
caller verifies a certificate, every later caller reusing the same chain gets a cheap "warm" path
instead of the full "cold" verification. Plan your registration flow to take advantage of this: the
first-ever registration on a chain is expensive; subsequent ones sharing the same upper chain are
much cheaper.

### 3.2 The registry contract — the one piece of real new infrastructure

A minimal reference shape (adapt names/fields to your language, but keep the four properties below —
they're each closing a real gap left by naively wiring the verifier straight to your app):

```solidity
struct App {
    address owner;
    uint64  configVersion;   // bump invalidates every existing signer AND every previously
                              // allowed image — deliberate clean-slate rotation, not per-signer
    uint32  signerTTL;       // registered signers expire and must re-attest
    bool    paused;
    bytes32 sourceCommit;    // published source, so anyone can independently rebuild and check
    string  sourceURI;
}
mapping(bytes32 appId => App) apps;
mapping(bytes32 appId => mapping(bytes32 pcrSetHash => uint64 allowedUnderVersion)) allowedImages;

struct Signer { bytes32 appId; uint64 configVersion; uint64 expiresAt; bool revoked; }
mapping(address signer => Signer) signers;
```

- **Expensive path** (once per enclave boot): verify the attestation via the vendored verifier →
  check the enclave's PCR set is on the app's allowlist *under the current config version* → reject
  all-zero PCRs (see §9.3 on debug-mode enclaves) → enforce freshness (the verifier itself doesn't —
  see below) → derive an address from the attested public key → store a signer record with an
  expiry.
- **Cheap path** (every subsequent result the enclave signs): `isValidSigner(appId, signer)` — a
  single storage read.

**Properties worth building in from the start, since retrofitting them later is real rework**:
- **Bind the full PCR set** your platform cares about (not just one register), so a tampered image
  that happens to share one measurement with a trusted one still gets rejected.
- **Signer TTL** — a registered key should expire and require re-attestation, not stay trusted
  forever. A retired or compromised enclave shouldn't remain silently trusted indefinitely.
- **Explicitly reject all-zero PCRs.** Debug-mode / console-attached enclave builds emit all-zero
  PCR values by design (see §9.3) — if your registry doesn't explicitly check for this, a
  debug-mode attestation can slip through the general validity checks.
- **Enforce attestation freshness at registration.** Generic attestation verifiers typically check
  only that a timestamp is *present*, not that it's *recent* — a stale attestation is otherwise
  replayable until its underlying certificate expires.
- **Config-version invalidation** — bumping an app's policy version should invalidate every existing
  signer *and* every previously-allowed image in one atomic action, forcing the owner to explicitly
  re-affirm both. This is the mechanism for "something's wrong, cut everyone off now."
- **On-chain source pointers** (a commit hash + URI) — cheap to add, and it's what makes the
  reproducible-build trust claim ("anyone can rebuild and check the PCRs match") checkable rather
  than just asserted.

### 3.3 The consumer-side SDK — EIP-712, not a custom intent scheme

Wrap every enclave-signed message in EIP-712 typed data rather than a hand-rolled scheme. The
domain separator binds `chainId` and `verifyingContract`, giving cross-chain and cross-contract
replay protection for free — a hand-rolled single-byte "intent" tag is a materially weaker version
of the same idea, and EIP-712 is wallet-displayable besides.

```solidity
function _requireEnclaveSignature(bytes32 structHash, uint64 deadline, bytes32 nonce, bytes calldata sig)
    internal
{
    require(block.timestamp <= deadline, "expired");
    require(!usedNonces[nonce], "replayed");
    usedNonces[nonce] = true;
    address signer = ECDSA.recover(_hashTypedDataV4(structHash), sig);
    require(registry.isValidSigner(appId, signer), "not attested");
}
```

**Make deadline and nonce mandatory on every signed message type**, not optional per-app — it's easy
to ship a first app without replay protection because nothing forces you to think about it, and
that gap is invisible until it's exploited.

---

## 4. Enclave runtime

Fork a Nitro-enclave-aware server template (e.g. `nautilus-server`). Keep the parts that are
genuinely reusable infrastructure regardless of your app: the outbound-network allowlist (an enclave
should have **no** network access by default, only explicitly permitted domains, forwarded through
the parent instance), the health-check endpoint, and a hermetic, reproducible build process — the
reproducibility is what makes "anyone can rebuild and verify the PCRs match" actually true rather
than a marketing claim.

**Sign with secp256k1, not Ed25519, if your target chain is EVM.** On-chain signature verification
becomes a plain `ecrecover` (cheap, native), not a hand-rolled Ed25519 implementation in Solidity.

**Design the attestation request to embed the actual signing key.** AWS's attestation `public_key`
field is *optional* — a Nitro attestation captured without anyone explicitly requesting a bound key
will have this field as CBOR null (see §9.3). If your registry design (correctly) requires a bound
key to derive a trusted signer address, you must explicitly request one:
`NsmRequest::Attestation { public_key: Some(pk_bytes), .. }` (or your SDK's equivalent) — otherwise
registration will fail with a confusing "missing key" error despite the underlying cryptographic
verification succeeding perfectly.

**An attestation only ever embeds one public key.** If you later need a *second* attested key for a
different purpose (see §6, secrets), that needs its own, separate attestation call — you cannot
extend or reuse an existing attestation to cover an additional key.

---

## 5. The platform layer — CLI-first, not web-first

When this becomes a real "developer deploys their own app onto this platform" product rather than a
single bespoke app, the primary action surface should be a **CLI**, with a web dashboard as a
secondary, read-only surface — not where the actual `deploy` action lives.

Deploying an enclave means handing over source code, a git ref, and PCR policy decisions — a
developer-tool action, not a form-filling one. Every comparable product (developer PaaS tooling in
general) puts the deploy verb in a CLI; a web-only flow tends to feel bolted on for this shape of
workflow.

Concrete shape — a developer deploying a new app:

1. **`platform login`** — if the platform is chain-native, wallet-based auth (sign a message) is a
   natural fit; it ties the platform identity to the same on-chain address that will own the app's
   registry objects.
2. **`platform init`** — scaffold a new enclave app from the reusable server template, or detect one
   already in the repo.
3. **`platform deploy`** — build reproducibly, provision or reuse compute, boot the enclave, pull
   the attestation, and run the registration transaction sequence. Output: a live endpoint plus the
   on-chain registry addresses.
4. **`platform logs` / `platform status`** — ongoing operational visibility.

The web surface earns its place for things genuinely better browsed than CLI'd: attestation
freshness across registered apps, PCR history, drift alerts, secrets management, billing — places
where a human is *checking on* something rather than *causing* an action.

**Decouple building the artifact from launching it — see §9.1.** This is the single highest-leverage
design decision for the platform layer, and it's much cheaper to build in from the start than to
retrofit after discovering the problem the hard way.

---

## 6. Attestation-gated secrets, if your app needs them

If enclave logic needs secret configuration (an API key, a credential), do **not** deliver it as a
plaintext file on the parent host's disk before forwarding it into the enclave — anyone with access
to that host (including the platform operator) can read it before it ever reaches the enclave. That
defeats the point of the TEE for anything secret.

**The real mechanism**: your cloud KMS's attestation-gated decrypt (e.g. AWS KMS's
`kms:RecipientAttestation:PCR<N>` condition keys). This gates the *decrypt* operation — not encrypt
— to only succeed when called from inside an enclave presenting a matching attestation. The enclave
calls the KMS decrypt API directly, with its own fresh attestation as the recipient; KMS validates
the attestation's PCRs against the key's policy and, only if they match, returns the plaintext
re-wrapped to the attestation's embedded key — meaning it's never visible in transit outside the
enclave, and never visible to whoever holds the cloud credentials calling the API. Not even a
platform operator with full account access can decrypt without a genuine, matching attestation.

Design notes, each a real gap that's easy to miss:
- Your generic managed-secrets service (e.g. AWS Secrets Manager) likely does **not** support
  attestation-gating directly — use the KMS encrypt/decrypt primitive on the secret bytes yourself.
  The resulting ciphertext blob can be stored anywhere; leaking ciphertext is harmless.
- **Scope the key policy per app** (matching the exact PCR set of whichever app's secret it
  protects), not one shared platform-wide key — otherwise any onboarded app's enclave could decrypt
  every other app's secrets.
- The attestation-gated key needs its own, separate attested keypair from your signing key (see §4)
  — typically RSA, since the envelope-encryption scheme most KMS attestation implementations use
  needs an RSA public key, not the secp256k1/ECDSA key used for on-chain signing.
- **Test the policy by actually triggering the denial case**, not by reading the policy document. A
  policy that reads correctly can still have a blanket admin/root statement elsewhere that silently
  grants an ungated path — this is only caught by confirming a no-attestation decrypt is genuinely
  refused.

---

## 7. Roadmap items, deliberately not built in a first pass

Each of these is real product work, worth naming explicitly so scope stays a decision rather than a
drift:

- **A real multi-tenant fleet/provisioner** beyond a single shared or minimally-scaled compute
  instance — capacity-aware scheduling across a pool, auto-scaling, load balancing, multi-region.
- **Monitoring and drift detection** — continuously watching that a registered app's live attestation
  still matches its expected, published-source PCRs, alerting if not.
- **A gateway** with auth and rate limiting in front of enclave endpoints.
- **Multi-tenant billing/metering.**
- **Push/oracle mode** — a scheduled, autonomous enclave that pushes updates on-chain on its own,
  rather than the simpler request/response shape.
- **Multi-TEE threshold signing** — requiring agreement across multiple *independent* TEE hardware
  vendors before a result is trusted, removing the single-cloud-vendor root-of-trust weakness that a
  single-cloud-provider design inherently has. This is the strongest "what's next" pitch item: it's
  a real, well-understood weakness (one hardware vendor's attestation is the entire trust anchor),
  and multi-vendor agreement is the standard way to remove it.
- **A real build/artifact-distribution service** beyond a reproducible build recipe — see §9.1 for
  exactly why this one has an unusually strong, concrete justification once you've felt the cost of
  not having it.

---

## 8. Trust model — state it plainly, before anyone asks

**Hardware/cryptographically enforced** — cannot be faked or socially engineered around: enclave
memory and compute integrity; *which* code produced a given result (via PCR measurement + a
reproducible build anyone can independently verify); secret confidentiality from the operator (§6).

**Trusted to the platform operator** — a real, honest limitation, not a flaw to hide: uptime;
network egress control; whether the enclave is actually running at all; transaction relaying and
potential censorship of registrations.

**The precise framing**: the system is trusted for *liveness*, not *correctness*. Correctness — that
the output really did come from the claimed code — is cryptographically enforced and cannot be
faked by the operator. Liveness — that the service is actually up and answering honestly — still
requires trusting whoever runs the infrastructure. State this distinction proactively rather than
waiting to be asked; it's the detail that shows genuine understanding of the model, and glossing
over it reads worse than owning it plainly.

---

## 9. Operational lessons — everything not reasonably knowable in advance

Learned by actually building a system like this, not from any vendor's documentation. Read this
section *before* you start, not after you've hit each one the hard way.

### 9.1 The single biggest time cost: decouple building the enclave image from launching it

**If you build nothing else from this list, build this one.** The failure mode: every time a *new*
compute instance builds an enclave image, a hermetic cross-compile toolchain (e.g. StageX/musl for a
Rust server) runs fully cold — commonly 20 to 70+ minutes — because a container build cache lives on
each instance's *local disk* and does not transfer between machines. This bites repeatedly and
compounds badly the moment you have more than one instance: every new instance, every new app,
recompiles the *entire* dependency tree from scratch, even when byte-identical layers were already
built successfully elsewhere minutes earlier.

**The fix — build once, launch many.** A Nitro enclave image (`.eif`) is a portable build output.
Build it *once* per code version (any single machine — doesn't need to be the instance that will run
it), store the artifact (object storage is the obvious place) alongside its PCR measurements, and
have every future "launch this app" step **download the pre-built image** and boot it directly — no
compiler, no container build, on the launch path at all. This turns a 20–70 minute operation into a
file download plus enclave boot: seconds to low minutes.

This does **not** weaken the reproducible-build trust property. The requirement is that the shipped
image is *independently verifiable* — anyone can rebuild from the same source and confirm the
measurements match — not that it gets *rebuilt on every single launch*. Conflating those two
guarantees is an easy, expensive mistake.

Cheaper, complementary options if a full artifact-distribution pipeline is more than you want up
front:
- **A shared/remote container build cache** — push and pull layers from a central registry instead
  of relying on each instance's local disk.
- **A golden AMI/image** — bake the container toolchain with its base layers already pulled into a
  custom machine image, so every new instance at least starts with the expensive *shared* layers
  warm, even if app-specific code still compiles fresh.

A subtler trap once you have build caching at all: **a single file's content changing anywhere
before or inside a build context invalidates every cached layer after it** — including a
multi-ten-minute compile step. A trivial fix to one script (e.g. a line-ending fix) can silently
throw away a warm compile cache and force a full rebuild. Structure your build so frequently-changing
files are introduced *after* the expensive, rarely-changing compile step wherever your tooling allows
it.

### 9.2 Shell scripting footguns worth knowing about specifically

These each masquerade as a *different* problem (network flakiness, a hang) until traced to their
actual, narrow root cause.

| Bug | What it looks like | What it actually is | Fix |
|---|---|---|---|
| `cat file \| some-tool ... < /dev/null` | Data silently never arrives at its destination — no error | A **trailing redirect on a command overrides its piped stdin** in bash — the tool's actual input is the redirect target, not the pipe | Use the tool's own file-input mechanism instead of piping (e.g. `socat`'s `file:` address) |
| `pkill -f "<pattern that's also a substring of a later command in the same script>"` | Looks like a dropped connection or transport failure partway through a multi-step remote script | `pkill -f` matches against **every process's full command line**, including a later command in the *same script* — it can kill its own invoking shell | Kill by a more specific handle (e.g. by port ownership via `fuser -k`) instead of a text pattern that could match unrelated things |
| Shell scripts / build files checked out on Windows, run under Linux/WSL | Docker build fails deep inside a heredoc with an opaque parse error; a script silently does nothing | Windows defaults to CRLF line endings; heredocs and shebang lines break on the embedded `\r` | Add a `.gitattributes` forcing LF on shell scripts and build files, and normalize already-tracked files — do this *before* the first build |
| A detached remote build kicked off over SSH (`ssh host 'nohup make ... & disown'`), even with its output fully redirected (`>build.log 2>&1 </dev/null`) | The local `ssh` invocation never returns control — looks exactly like a still-running slow build, indefinitely | Something in the remote process tree (observed with a Docker/BuildKit-based build) can briefly hold the pty open past the point where the visible work has actually finished — the remote work can be **long done** while the local script still looks stuck | Don't trust "the SSH command hasn't returned" as proof the remote step is still working, especially past its expected duration. Check the remote side directly — log file's last-modified time, whether the expected output artifact already exists on disk, `ps` on the remote host — before assuming it's merely slow |

**The general practice, not just the three specific bugs**: when a multi-step remote script fails
with a generic, unhelpful error (a bare non-zero exit, a hang, silence), don't accept the first
plausible-sounding explanation. Check the machine's actual live state directly (process list, log
tails, the platform's own inspection tooling) before concluding anything. And when you initially
diagnose something wrong, correct it explicitly once you find the real cause — don't let a wrong
explanation stand uncorrected once you know better.

### 9.3 Trusted-hardware-enclave gotchas (beyond what vendor docs make obvious)

- **A stated "N enclaves per instance" capacity figure is a platform ceiling, not available
  capacity.** The real constraint is typically *physical cores*, not the vCPU count an instance
  advertises — a machine's vCPUs may be hyperthreads on fewer physical cores, and a trusted enclave
  typically needs a whole physical core (can't split one between host and enclave), with at least
  one core reserved for the host itself. Verify actual topology directly before assuming vCPU count
  tells you anything about real capacity.
- **An attestation's embedded-public-key field is commonly optional and absent by default.** A
  reference/example attestation may have it as null if the requester didn't explicitly ask for one
  bound in — see §4. This produces a confusing failure that looks like a crypto bug but is actually
  a missing request parameter.
- **Debug-mode / console-attached enclave builds emit all-zero measurement values by design.** This
  is intentional (debug builds shouldn't be cryptographically trustworthy), but it means your
  registry must **explicitly reject** all-zero measurements — don't assume "the measurement is
  present and well-formed" implies "the measurement is real."
- **Duplicate/identical measurement values across different measurement "slots" can be entirely
  benign**, depending on how your build packages the image (e.g. a single monolithic disk image
  vs. separate boot/application layers can cause two normally-distinct measurements to land over
  the same bytes). Don't treat this as a red flag reflexively — check whether your specific build
  shape explains it before assuming something's broken.

### 9.4 Cloud CLI and credentials — practical surprises

- **An official CLI's installer can be unreachable in an otherwise-working network environment** —
  confirm the specific failure is really a general connectivity issue (test a known-working domain)
  before assuming the whole approach is blocked. A package-manager-installed older major version is
  often a viable fallback if a specific installer domain is unreachable.
- **Multiple credential environments can silently coexist on one machine** (e.g. a native shell with
  no credentials configured, and a separate virtualized/WSL environment with its own, already-live
  credentials). Check what's actually configured in *every* shell environment you might use, rather
  than assuming nothing is set up because one particular shell has nothing.

### 9.5 Attestation-gated secrets (KMS) specifics

- Attestation-gating condition keys typically gate the **decrypt** side of operations (decrypt,
  derive-shared-secret, generate-data-key, generate-random) — not encrypt. Encryption never needs an
  attestation; only decryption does.
- A general-purpose managed secrets service is unlikely to support attestation-gating directly —
  check specifically rather than assuming; the raw key-management-service encrypt/decrypt primitive
  is the more likely place this capability lives.
- **A blanket admin/root statement in a key's access policy can silently defeat an otherwise-
  correctly-scoped attestation-gated statement**, even when that gated statement is written
  perfectly. This is only caught by *actually testing* that a no-attestation decrypt is denied —
  reading the policy document alone can look completely correct and still not catch it.
- **The response envelope (commonly CMS/PKCS#7 `EnvelopedData`) is ASN.1, and real responses
  routinely use BER indefinite-length encoding in places a hand-rolled parser assumes are
  definite-length DER** — not just the outer envelope structure, but individual nested fields too.
  Specifically: an encrypted-payload field can be encoded as "constructed encoding of a primitive
  type" — a sequence of length-prefixed chunks rather than one contiguous byte string — and a parser
  that extracts the raw indefinite-length byte span as-is will silently prepend each chunk's own
  small TLV header into the "ciphertext," corrupting block alignment on decrypt. The failure this
  produces (e.g. a padding/unpad error several steps downstream) looks nothing like an encoding bug.
  **A synthetic/unit test that constructs its own fixture bytes will not catch this** — the fixture
  only exercises the encoding choices its author picked, not the ones a real server actually emits.
  Prefer a real, mature ASN.1/BER parsing library over hand-rolling one; if you must hand-roll (e.g.
  a `no_std` enclave environment with a limited dependency surface), validate against the *actual
  raw bytes of a real response* — inspect them with a tool like `openssl asn1parse` — and handle both
  definite- and indefinite-length forms for every nested field, not only the outermost one.

### 9.6 Practical budgeting for testnet funding

A full "cold" on-chain registration (verifying an entire fresh certificate chain, not reusing a
cached one) can cost meaningfully more gas than a single simple transaction — budget generous
headroom (request funding well above what a first back-of-envelope estimate suggests) so a funding
top-up doesn't interrupt a multi-step flow at an inconvenient moment.

### 9.7 The meta-lesson underlying all of this: verify for real, not just plausibly

The single practice that catches the most real bugs, across every category above: **independently
re-derive or re-verify anything load-bearing before trusting it**, especially across a trust
boundary — a collaborator's report, a higher-level tool's output, a policy document's apparent
correctness. Concretely: cross-check derived values (addresses, hashes) via two or more independent
methods before relying on them; hand-decode a low-level response when a higher-level tool's output
seems even slightly off, rather than trusting the higher-level tool; re-run someone else's
verification steps yourself before merging or depending on their work, rather than trusting the
report alone; and test security gates by actually triggering the denial case, not by reading the
policy. None of the bugs in this section were exotic — every one of them would have shipped silently
if the first plausible-looking answer had been accepted instead of checked.
