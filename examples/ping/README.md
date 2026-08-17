# ping — the proof-of-pipeline app

`POST /ping { message, deadline, nonce }` returns a hardware-attested, EIP-712-signed `pong:
<message>` — proof the enclave transformed the input rather than just echoing bytes back. It's the
simplest possible app that exercises the full pipeline end to end, and the one
[`PingConsumer.sol`](../../src/examples/PingConsumer.sol) verifies on-chain.

Its logic is right here in this folder, in [`mod.rs`](./mod.rs) — a normal axum route handler. It's
wired into the enclave server by a two-line, feature-gated `#[path]` include in
`enclave-server/src/nautilus-server/src/lib.rs`; nothing about the app's logic lives anywhere else.
`cobalt.json` and `env.json` alongside it are the *deploy config* `cobalt deploy` reads.

## Try it

**Prerequisites**: this deploys into a real AWS Nitro Enclave on the maintainer's EC2 fleet — you
need your own configured `aws-cli`, an EC2 key pair, a security group allowing the enclave's ports,
and a funded Monad testnet key. See the root [README](../../README.md#running-the-whole-platform-yourself)
for the full setup. If you just want to see the platform working without any of that,
`cobalt status examples/ping` reads live on-chain state and needs no AWS account.

```
npm install -g cobalt-tee   # if you haven't already
export PRIVATE_KEY=0x...    # a funded Monad testnet key
cobalt deploy examples/ping --secrets env.json
```

Once it's done:

```
cobalt status examples/ping
curl -X POST http://<enclave-ip>:<port>/ping \
  -H 'content-type: application/json' \
  -d '{"message":"hi","deadline":9999999999,"nonce":"0x<any 32 bytes hex>"}'
```

`cobalt.json`'s `appId` is pinned explicitly (rather than derived from the app name) to match the
already-deployed `PingConsumer.sol` at the address in `env.json`'s `CONSUMER_CONTRACT_ADDRESS`.
