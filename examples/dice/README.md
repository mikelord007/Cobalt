# dice — a second example app

A verifiable dice roll: `POST /roll { sides, deadline, nonce }` returns a hardware-attested,
EIP-712-signed roll in `[1, sides]`. The point: nothing about how this server is operated lets
anyone rig the outcome — the roll happens inside hardware even the operator can't see into, and
the signature proves an unmodified copy of this code produced it.

Its logic is right here in this folder, in [`mod.rs`](./mod.rs) — a normal axum route handler,
including the unit tests that check the EIP-712 struct hash is sensitive to every field. It's
wired into the enclave server by a two-line, feature-gated `#[path]` include in
`enclave-server/src/nautilus-server/src/lib.rs`; nothing about the app's logic lives anywhere
else. `cobalt.json` and `env.json` alongside it are the *deploy config* `cobalt deploy` reads, the
same shape as `examples/ping/`.

## Try it

**Prerequisites**: this deploys into a real AWS Nitro Enclave on the maintainer's EC2 fleet — you
need your own configured `aws-cli`, an EC2 key pair, a security group allowing the enclave's ports,
and a funded Monad testnet key. See the root [README](../../README.md#running-the-whole-platform-yourself)
for the full setup. If you just want to see the platform working without any of that, run
`cobalt status examples/ping` instead — it reads live on-chain state and needs no AWS account.

```
npm install -g cobalt-tee   # if you haven't already
export PRIVATE_KEY=0x...    # a funded Monad testnet key
cobalt deploy examples/dice --secrets env.json
```

First deploy of `dice` specifically will do a real, uncached enclave build — expect several
minutes. Once it's done:

```
cobalt status examples/dice
curl -X POST http://<enclave-ip>:<port>/roll \
  -H 'content-type: application/json' \
  -d '{"sides":6,"deadline":9999999999,"nonce":"0x<any 32 bytes hex>"}'
```

`CONSUMER_CONTRACT_ADDRESS` in `env.json` is a placeholder — there's no dedicated on-chain
consumer contract for this example (unlike `ping`'s `PingConsumer.sol`), since the CLI's
`createApp` / `setAllowedImage` / `registerEnclave` / `isValidSigner` steps don't need one. Only
verifying a signed result *on-chain* would — a natural next step if you want to take this further.
