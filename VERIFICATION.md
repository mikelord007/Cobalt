# Contract verification (Monad testnet, chain 10143)

All 5 deployed contracts are source-verified on Monad testnet, via
[Sourcify](https://sourcify.dev) (`exact_match`), the method documented in
[Monad's official Foundry verification guide](https://docs.monad.xyz/guides/verify-smart-contract/foundry).
Verified source is browsable on [MonadVision](https://testnet.monadvision.com), the
Sourcify-backed Monad testnet explorer (see [block explorer list](https://docs.monad.xyz/tooling-and-infra/block-explorers)).
No API key is required for Sourcify verification.

## Explorer / verifier used

- **Explorer:** MonadVision — `https://testnet.monadvision.com`
- **Verifier backend:** Sourcify
- **Verifier API:** `https://sourcify-api-monad.blockvision.org/`
- **Chain ID:** `10143`

(Monadscan, `https://testnet.monadscan.com`, is the alternative Etherscan-compatible explorer
for Monad testnet, but its verification API requires an Etherscan-v2-style API key that was not
available for this task, so Sourcify/MonadVision was used instead — this matches Monad's own
docs, which recommend Sourcify for Foundry-based verification.)

## Compiler settings

Matches `foundry.toml`: solc `0.8.26`, optimizer enabled, `optimizer_runs = 10000`.

## Constructor arguments

`P384Verifier` and `EnclaveRegistry`/`PingConsumer`'s address-only args were confirmed via public
getters (`cast call`). `CertManagerDemo`'s constructor takes a private, ungettable
`certificateExpiryGraceSeconds` value, so it was recovered directly from the actual on-chain
deployment transaction: the contract's creation block was located by binary-searching
`eth_getCode` history, the creation tx was found in that block (the one tx with `to == null`
whose sender matches the contract's `owner()`/`revoker()`), and its `input` calldata's trailing
64 bytes were decoded as the ABI-encoded constructor args. This recovered
`(0xC39773993C23f1E77898A15A38784a1b2896a423, 31536000)` — i.e. the `P384Verifier` address and a
365-day expiry grace period — which `forge verify-contract` then confirmed as an exact bytecode
match, proving the recovered value was correct.

| Contract | Constructor args |
|---|---|
| `P384Verifier` | none |
| `CertManagerDemo` (deployed as `CertManager` in `deployments/monad-testnet.json`) | `(address p384Verifier_, uint256 certificateExpiryGraceSeconds_)` = `(0xC39773993C23f1E77898A15A38784a1b2896a423, 31536000)` |
| `NitroValidator` | `(address _certManager, address _p384Verifier)` = `(0xb36f152CeF341FFA631Adc306C0ed1354d4D52CE, 0xC39773993C23f1E77898A15A38784a1b2896a423)` |
| `EnclaveRegistry` | `(address nitroValidator_)` = `(0x064Bb793b55e34945471afF31781A32c5839Dffe)` |
| `PingConsumer` | `(address registry_, bytes32 appId_)` = `(0xccF281dE61bfb970575827B5c962345F39bDa145, 0x3160ada18c530e22627bf2c8c125e08ed5022b770f07efeb2c6ffaf6da861153)` |

Note: `deployments/monad-testnet.json`'s `certManager` entry is actually a deployed
`CertManagerDemo` (`src/vendor/nitro-validator/test/helpers/CertManagerDemo.sol`), a demo-only
subclass of `CertManager` with a configurable certificate-expiry grace period, not the base
`CertManager` itself — confirmed by its constructor signature and by its `owner()`/`revoker()`
both equaling the deployer address (`0xcF0954F2a768b8e2be622898bD39eaEC94611994`), which is how
`CertManagerDemo` wires up `CertManager`'s owner/revoker (`msg.sender` for both).

## Verified contracts

| Contract | Address | Explorer page |
|---|---|---|
| `P384Verifier` | `0xC39773993C23f1E77898A15A38784a1b2896a423` | https://testnet.monadvision.com/address/0xC39773993C23f1E77898A15A38784a1b2896a423 |
| `CertManagerDemo` | `0xb36f152CeF341FFA631Adc306C0ed1354d4D52CE` | https://testnet.monadvision.com/address/0xb36f152CeF341FFA631Adc306C0ed1354d4D52CE |
| `NitroValidator` | `0x064Bb793b55e34945471afF31781A32c5839Dffe` | https://testnet.monadvision.com/address/0x064Bb793b55e34945471afF31781A32c5839Dffe |
| `EnclaveRegistry` | `0xccF281dE61bfb970575827B5c962345F39bDa145` | https://testnet.monadvision.com/address/0xccF281dE61bfb970575827B5c962345F39bDa145 |
| `PingConsumer` | `0xf62EAF1fdE81723f4d80b21eAb0A9b330ebA3a97` | https://testnet.monadvision.com/address/0xf62EAF1fdE81723f4d80b21eAb0A9b330ebA3a97 |

Each was confirmed independently of `forge verify-contract`'s own CLI success message by querying
Sourcify's status API directly, e.g.:

```
curl https://sourcify-api-monad.blockvision.org/v2/contract/10143/0xC39773993C23f1E77898A15A38784a1b2896a423
# => {"runtimeMatch":"exact_match", "match":"exact_match", ...}
```

All 5 returned `"match":"exact_match"`.

## Reproducing verification

```sh
forge verify-contract <address> <path>:<ContractName> \
  --chain 10143 \
  --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org/ \
  --compiler-version 0.8.26 \
  --num-of-optimizations 10000 \
  --constructor-args <abi-encoded-args> \
  --watch
```

Constructor args (where non-empty) were produced with `cast abi-encode "constructor(<types>)" <values>`.
