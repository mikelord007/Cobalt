# Build Plan

Target: a reusable platform first — a generic on-chain attestation registry and a CLI that deploys
any app's logic into a live AWS Nitro Enclave and verifies it on Monad — proven by shipping a real
app through it once the platform itself works.

**Read `ARCHITECTURE.md` §9 before starting.** It's a consolidated record of everything that isn't
reasonably knowable in advance — shell-scripting traps, cloud/enclave gotchas, toolchain issues, and
the single biggest time cost (rebuilding the enclave image from scratch on every new instance, §9.1).
Internalizing this before you write any deploy tooling will save real hours.

**Governing principle:** two decoupled tracks, both building generic, reusable pieces — neither
scoped to a specific app. Track A (the on-chain registry) needs no cloud access and produces a
demoable result on its own. Track B (the enclave server template) is the higher-risk, higher-latency
one and should run in parallel from the very start.

**Milestone map.** `M0` setup → `A1`/`A2` (generic on-chain registry) and `B1` (generic enclave
template) in parallel → `D1` (deploy automation, built directly against the generic template) → `D2`
(the CLI — the hard sync point) → prove the CLI end-to-end by deploying a real app through it → `D3`
(provisioner) / `D4` (attestation-gated secrets), both build-when-needed.

**There is deliberately no "build one app's infrastructure, then generalize it into a platform"
step.** The registry and the server template are built generic from `M0`. The CLI exists and works
before any app-specific request-handling logic does — see `ARCHITECTURE.md` §1.

---

## M0 — Setup

- Foundry (or your stack's equivalent) + Monad testnet RPC and faucet. Consider a chain-flavored
  fork of your local dev tooling if one exists — see `ARCHITECTURE.md` §2 on why generic local
  simulators can silently misprice gas.
- Clone `base/nitro-validator`; run its own test suite against its bundled real attestation fixture
  locally — this fixture is the thing that lets you build and test the entire on-chain flow with
  zero cloud access (see `A1` below).
- **Start cloud/enclave setup immediately**, in parallel with everything else — it's the long pole,
  and the first hermetic build alone commonly takes 20–40+ minutes.

---

## Track A — on-chain (no cloud access required)

### A1 — get a real attestation verified on Monad

1. Deploy `P384Verifier` → `CertManager` → `NitroValidator` to Monad testnet, in that order
   (verifier references are immutable constructor args).
2. Use `nitro-validator`'s own tooling to turn its bundled real attestation fixture into a
   ready-to-submit transaction plan.
3. Submit the resulting cold verification sequence. **Measure the actual gas per transaction on
   Monad — don't trust a number from another chain's testing.**

**This is the first deliverable and it de-risks everything downstream** — it proves the entire
hinted-attestation-verification construction actually works on Monad, with a genuine AWS attestation,
before you've written a single line of your own enclave code. If the numbers come in materially
different from what you expected, you find out here, with the whole build still ahead of you.

> Set gas limits tightly — see `ARCHITECTURE.md` §2 on Monad's charge-on-limit model. Compute limits
> via a live `eth_estimateGas` call against the real RPC, not a local simulator, for anything
> storage-heavy.

### A2 — the generic registry + SDK

- The attestation registry (`ARCHITECTURE.md` §3.2) — full PCR-set binding, all-zero-PCR rejection,
  freshness enforcement, signer TTL, config-version invalidation. **Build this multi-tenant from day
  one** — keyed by an app identifier, not hardcoded to a single app — since it's the piece every
  future app deploys against without any contract changes.
- The EIP-712 consumer SDK (§3.3) — deadline + nonce mandatory on every signed message type.
- A minimal example consumer contract is enough here, just to exercise the SDK end-to-end. Your real
  app's actual consumer contract comes later, once you're deploying it through the CLI — don't build
  app-specific business logic against the registry yet.
- Tests throughout, including one that explicitly proves a tampered PCR set gets rejected — this is
  the property you'll want to demonstrate live later.

⚠️ **Check your target chain's actual `BLOCKHASH` window in wall-clock time before binding anything
to it** — a short block time can make a nominally generous block-count window cover well under a
few minutes. Use `block.timestamp` + nonces unless you've specifically verified the window is long
enough for your use case.

---

## Track B — the enclave (runs in parallel with Track A, start immediately)

### Instance/compute choice

- Check the *specific* instance sizes your cloud provider supports for trusted-enclave workloads —
  don't assume every size in a family works; the smallest sizes in many families explicitly don't.
- Enclave support is typically a **launch-time-only** setting — verify whether it can be toggled on
  a running instance before assuming you can add it later.
- There is typically **no cloud API to start an enclave itself** (only to launch the parent
  instance) — expect to script this over SSH, at least initially.

### B1 — the reusable enclave server template

- Fork a Nitro-enclave-aware server template. Adapt signing to **secp256k1** (cheap `ecrecover`
  on-chain) and message signing to **EIP-712** (see `ARCHITECTURE.md` §4).
- **Keep the request-handling logic generic here** — a bare template (e.g. an echo/health-check
  handler) is enough to prove attestation and signing work end to end. App-specific logic gets
  layered on top once the CLI exists to deploy it; don't build one app's business logic into the
  template itself.
- Develop and test locally first — everything except the attestation call itself can run without
  any cloud access at all.
- Build the enclave image and record its measurement output.

> Use whatever your enclave tooling's debug/console mode is called while iterating (it's much
> faster to work with) — but remember **debug-mode builds produce all-zero measurements** and
> cannot be used for a real attestation. Final builds must run in production mode.

> ⚠️ **Read `ARCHITECTURE.md` §9.2 before writing any multi-step deploy/attest shell script.** Four
> specific bugs (a piped-input trap, a self-matching process-kill pattern, CRLF-breaks-Linux-builds,
> and a detached-SSH-build hang) each look like a *different* problem until you know to check for
> them specifically.

---

## D1 — deploy automation (build-once/launch-many)

Build the reusable, scriptable deploy step directly against `B1`'s generic template — connect to an
instance, build the image, launch it, fetch the attestation, verify the measurements. Because the
template from `B1` is already generic, this targets an *arbitrary* app directory from the start —
there's no app-specific version of this step to generalize away later.

- Watch for the shell-scripting and line-ending gotchas from `ARCHITECTURE.md` §9.2 — they apply to
  any app deployed this way.
- **Build this around §9.1's build-once/launch-many principle from the start** — don't have this
  step shell out to a fresh full compile on every invocation; have it call into (or become) an
  artifact-build-and-distribute step instead. This is meaningfully more work up front than a naive
  "just script the manual steps," but it's the difference between a launch taking minutes versus
  the better part of an hour, every single time, for the rest of the project's life.
- Output: a script/command that takes an app directory and produces a live attestation.

## D2 — the CLI (hard sync point — needs A2 + D1)

Wire `D1`'s deploy automation together with `A2`'s registration tooling into one command a developer
would actually run — e.g. `platform deploy <app-dir>` — doing build → run → attest → register end to
end, against the already-deployed, already-multi-tenant registry from `A2` (no contract changes
needed — this is exactly why the registry was built generic from the start). See `ARCHITECTURE.md`
§5 for the fuller CLI-first user-flow rationale.

**This is the actual platform moment, and it happens before any specific app's logic exists** — not
after, as a generalization step bolted on once one app already works by hand.

Scope guardrail worth stating explicitly: decide up front whether this is one golden path against a
single shared instance (fastest to build, real limits on concurrent capacity) or something that
needs real fleet capacity from day one (`D3` below) — and be deliberate about which, rather than
discovering the limit mid-build.

---

## Prove the CLI end-to-end

Write your app's actual request-handling logic (whatever your app needs to accept as input and
return as a signed result), then run `platform deploy` for real. This is the first genuine,
full-stack proof: real hardware attestation → on-chain registry → live enclave handling real
requests → verified settlement on Monad — produced by the CLI itself, not assembled by hand.

If you want to debug plumbing separately from app logic, deploy something trivial first (an echo/
no-op handler) before your real app — optional, since nothing about the CLI was ever specific to one
app; it should work either way.

The tamper-demo property from `ARCHITECTURE.md` §1 (rebuild with logic tampered → measurement
changes → registry rejects it) is a natural, cheap addition once the CLI's deploy flow already
rebuilds images as a matter of course — worth including live if you have the time, since it's the
single clearest way to make the trust model viscerally obvious to an audience.

---

## D3 — minimal provisioner (build when you actually need more than one instance)

**Why this becomes necessary**: a single shared instance has a hard *physical* capacity ceiling —
see `ARCHITECTURE.md` §9.3 on why a stated "N enclaves per instance" figure isn't free capacity.
Once you have more apps than one instance can concurrently host, you need this.

**Scope — capacity-aware instance launching only, not a full fleet manager:**
- Track which enclave-capable instances exist and how much room each has (a simple state file is
  enough at this scale — this doesn't need to be a distributed system).
- When a deploy needs capacity and nothing has room, launch a new instance reusing your already-
  proven launch configuration — not new provisioning logic, just making the existing one-off launch
  reusable and automatic.
- Hand the CLI back which instance to deploy to.

**Explicitly out of scope for a minimal version**: billing, multi-region, per-tenant isolation
beyond what the registry already provides, load balancing, auto-scaling policies. Building the full
version of this is real, separate product work — see `ARCHITECTURE.md` §7.

## D4 — attestation-gated secrets (build when your app needs a secret)

> See `ARCHITECTURE.md` §6 for the full mechanism and §9.5 for the gotchas that aren't obvious from
> your cloud provider's own docs.

Only build this once an app on the platform actually needs secret configuration — don't build it
speculatively. When you do:

1. Set up the attestation-gated key + per-app-scoped policy (§6) — this side can be built and tested
   fully independently of the enclave-side integration, using a real attestation you already have on
   hand (e.g. from the app you deployed to prove the CLI) as the test case.
2. Wire the enclave-side decrypt call into your server template — a second, separate attested
   keypair, a call to your KMS's attestation-gated decrypt, unwrapping the response.
3. **Prove it end to end against a real enclave, not just a unit test.** The attestation piece
   specifically cannot be tested any way other than actually running inside real trusted hardware —
   budget for this as a real, separate validation step, likely on a disposable/scratch instance
   rather than your primary deployment, so you're not risking anything already working.

---

## Distributing this across parallel agents

If you can run up to **four agents in parallel**, here's how to allocate them to actually get
parallelism, not just four agents doing the same thing slower with more coordination overhead.

### Phase 1 — before `D2` (fully parallel, no shared files between agents)

| Agent | Owns | Why it's safe to fully parallelize |
|---|---|---|
| **1 — On-chain** | `M0` (contract-side setup) → `A1` → `A2` (generic registry + SDK) | Touches only Solidity/contracts and testnet, no cloud dependency at all |
| **2 — Enclave** | `M0` (cloud-side setup) → `B1` (generic template) → `D1` (deploy automation) | Touches only the cloud account and the enclave server code; `D1` is a natural continuation of `B1` since both work against the same generic template — no on-chain dependency |
| **3 — Tooling (optional)** | Start the read-only viewer/dashboard against the registry's interface, using a local or mocked deployment before the real one exists | Only needs the registry's *interface* (which is stable from the moment `A2` starts, even before it's deployed), not a live deployed instance |
| **4 — Security (optional)** | Start the attestation-gated-secrets (`D4`) groundwork — key/policy tooling — against placeholder PCR values | Only needs *a* PCR set to test against, not necessarily the real one yet; swap in the real values once Agent 2 has them |

**Hard sync point: `D2` (the CLI).** This needs *both* Agent 1's deployed registry and Agent 2's
`D1` deploy-automation output. Whichever finishes first should not sit idle — redirect them to Agent
3 or 4's work, or to writing tests, until the other side is ready.

### Phase 2 — after `D2` (parallel again, with real dependencies to manage)

| Agent | Owns | Depends on |
|---|---|---|
| **2 — Enclave** (continues) | Write the real app's request-handling logic and run `platform deploy` for the first genuine end-to-end proof; then `D3` (provisioner, once needed) | Its own `B1`/`D1` work |
| **1 — On-chain** (continues) | Whatever app-specific consumer contract the real app needs, built on the SDK from `A2` | Its own `A2` work — coordinate the exact request/response shape directly with Agent 2 before either writes code against an assumption |
| **3 — Tooling** (continues) | Finish the viewer against the real deployed registry; then shift to a **verification role** — independently re-derive/re-check the other agents' critical outputs (addresses, PCR hashes, gas numbers) rather than trusting their self-reports | Needs the real deployed addresses from Agent 1 |
| **4 — Security** (continues) | `D4`'s real enclave-side integration | Needs to coordinate directly with Agent 2 on the exact file(s) it'll touch in the enclave server codebase — **agree on this before either agent starts editing**, and have Agent 4 do all the AWS/KMS-side work it can independently first while waiting for a safe integration window |

### Coordination rules that actually made this work, not just theory

1. **Establish file ownership before two agents touch the same file.** When two agents' work will
   converge on one shared file (e.g. the enclave server's entry point), agree explicitly on who
   edits it and hand off a function signature/interface rather than both editing concurrently.
2. **Whoever's changes will invalidate something another agent depends on should say so proactively.**
   Rebuilding a binary changes its measurement — if Agent 4 needs Agent 2's build's exact PCR
   values, Agent 2 should hand those over the moment they're known, not wait to be asked.
3. **Treat a peer's report as a claim to verify, not a fact to build on**, for anything load-bearing
   — re-run a critical verification step yourself before merging code or relying on a result,
   especially across a trust boundary. This single practice caught most of the real bugs in this
   kind of build (see `ARCHITECTURE.md` §9.7).
4. **A dedicated "verifier" role is a genuinely good use of a 4th agent** once the obvious parallel
   work runs out — independently re-checking derived values, re-running tests, and testing security
   gates by actually triggering the denial case (not just reading the policy) is real, valuable
   work that isn't "new features," and it's exactly the work that's easy to skip under time pressure
   if nobody's explicitly assigned to it.
5. **Keep one shared, continuously-updated plan document as the source of truth** that every agent
   checks before assuming something is or isn't in scope — coordination breaks down fast when
   agents are working from different, silently-diverging understandings of what's already decided.

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Cloud enclave setup consumes far more time than planned | High | Track A is fully independent; start cloud setup immediately; use debug/console mode for fast iteration |
| First hermetic build is slow / fails | Medium | Budget for this in `B1`, not at the `D2` CLI-integration step. Change as little as possible from a known-good reference template |
| Off-chain hint generation mismatches on-chain verification order | Medium | Use the reference implementation's own hint tooling unmodified as a byte-for-byte oracle — don't rewrite it |
| Target chain's real gas costs differ from another chain's published numbers | Low if measured early | Measure directly in `A1`, on real testnet, before building anything that assumes a specific number |
| Live demo network failure | Medium | Pre-record everything, especially any live tamper-demo |
| Attestation stale at demo time | Medium | Re-attest immediately before any live demo — script this, don't do it manually under time pressure |
| Enclave image rebuilds from scratch on every new instance (20–70 min each) | **High, if not designed around** | Decouple build from launch from the start — `ARCHITECTURE.md` §9.1. The single biggest time sink if not addressed early |
| A shell script fails with a generic/misleading error and gets misdiagnosed | Medium | Check the machine's live state directly before trusting a first plausible explanation — `ARCHITECTURE.md` §9.2 |
| A cloud CLI's official installer is unreachable in your specific network environment | Low | Confirm it's not a general connectivity issue first; an older package-manager-installed version is often a viable fallback — `ARCHITECTURE.md` §9.4 |

---

## Open decisions to make deliberately, not by default

1. **Testnet only, or also deploy to mainnet?** Check your target chain's real transaction costs —
   this may be trivial enough that "live on mainnet" is worth the low effort for a stronger claim.
2. **Result/input transport**: a straightforward HTTPS-to-enclave request/response with signed
   receipts (simpler, faster to build) vs. inputs encrypted directly to the enclave's attested key
   and posted on-chain (more trustless — the enclave operator never even transiently sees plaintext
   input in transit — but meaningfully more work). Signed receipts are the safe default for a first
   build; note the more-trustless path as a documented upgrade, not a requirement.
