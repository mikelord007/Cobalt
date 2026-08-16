# dice — a second example app

A verifiable dice roll: `POST /roll { sides, deadline, nonce }` returns a hardware-attested,
EIP-712-signed roll in `[1, sides]`. The point: nothing about how this server is operated lets
anyone rig the outcome — the roll happens inside hardware even the operator can't see into, and
the signature proves an unmodified copy of this code produced it.

Its logic lives in the platform itself, at
`enclave-server/src/nautilus-server/src/apps/dice/mod.rs` — this folder is only the *deploy
config* `cobalt deploy` reads, the same shape as `examples/ping/`.

## Try it

```
npm install -g mikelord007/Cobalt   # if you haven't already
export PRIVATE_KEY=0x...            # a funded Monad testnet key
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
