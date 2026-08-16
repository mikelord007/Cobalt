// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {HintedNitroAttestationTest} from "../src/vendor/nitro-validator/test/hinted/HintedNitroAttestation.t.sol";
import {NitroValidator} from "@nitro-validator/NitroValidator.sol";
import {ICertManager} from "@nitro-validator/ICertManager.sol";
import {CborDecode, CborElement, LibCborElement} from "@nitro-validator/CborDecode.sol";
import {Sha2Ext} from "@nitro-validator/Sha2Ext.sol";
import {INitroValidator} from "../src/INitroValidator.sol";
import {EnclaveRegistry} from "../src/EnclaveRegistry.sol";

/// @notice Exercises the vendored Nitro attestation pipeline (real certificate-chain
///         verification, real pure-Solidity ECDSA-P384 hint checking) against a genuine
///         AWS-signed attestation document, with zero cloud access and zero FFI, then feeds the
///         result into `EnclaveRegistry` to prove the on-chain integration seam is correct
///         end-to-end.
///
/// Inheriting the vendor's own hinted-attestation test contract means its full suite (cert chain
/// verification, hint soundness, tamper rejection, replay/malleability properties, ...) runs
/// here too, as a baseline proof the vendored crypto stack is wired up correctly in this repo, in
/// addition to the registry-specific test added below.
contract EnclaveRegistryRealAttestationTest is HintedNitroAttestationTest {
    using CborDecode for bytes;
    using LibCborElement for CborElement;

    /// @dev The bundled real attestation fixture was captured without `public_key: Some(...)`
    ///      requested, so its `public_key` CBOR field is null. This proves both halves of the
    ///      integration in one shot: the full real pipeline (cert chain + signature) succeeds
    ///      against genuine hardware-signed data, AND the registry correctly refuses to register
    ///      a signer for an attestation that carries no bound key.
    function test_RegisterEnclave_RealAttestationRevertsMissingPublicKey() public {
        bytes memory attestation = _repairMissingPublicKeyBytes(_decodeBase64(_realAttestationB64()));
        (bytes memory attestationTbs, bytes memory signature) = validator.decodeAttestationTbs(attestation);

        // Walk and cache the real cert chain (root -> intermediates -> leaf) using pure-Solidity
        // hints -- no FFI, no network access.
        ICertManager.VerifiedCert memory leaf = _cacheCertBundleWithHints(attestationTbs);

        bytes memory hash = Sha2Ext.sha384(attestationTbs, 0, attestationTbs.length);
        bytes memory attestationHints = hintCollector.collectVerifyHints(hash, signature, leaf.pubKey);

        NitroValidator.Ptrs memory ptrs = parser.parseAttestation(attestationTbs);
        assertTrue(ptrs.publicKey.isNull(), "fixture is expected to carry no bound public key");

        EnclaveRegistry registry = new EnclaveRegistry(INitroValidator(address(validator)));
        bytes32 appId = keccak256("cobalt-real-attestation-test");
        registry.createApp(appId, 1 hours, bytes32(0), "");
        registry.setAllowedImage(appId, _boundPcrSetHash(attestationTbs, ptrs));

        vm.expectRevert(EnclaveRegistry.AttestationMissingPublicKey.selector);
        registry.registerEnclave(appId, attestationTbs, signature, attestationHints);
    }

    function _boundPcrSetHash(bytes memory attestationTbs, NitroValidator.Ptrs memory ptrs)
        internal
        pure
        returns (bytes32)
    {
        bytes memory concatenated;
        for (uint256 i = 0; i < 3; i++) {
            concatenated = bytes.concat(concatenated, attestationTbs.slice(ptrs.pcrs[i]));
        }
        return keccak256(concatenated);
    }
}
