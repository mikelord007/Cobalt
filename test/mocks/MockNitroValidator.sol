// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {INitroValidator} from "../../src/INitroValidator.sol";
import {NitroValidator} from "@nitro-validator/NitroValidator.sol";
import {CborElement, LibCborElement} from "@nitro-validator/CborDecode.sol";

/// @notice Stand-in for the real Nitro attestation crypto stack, so registry logic can be unit
///         tested without paying for certificate-chain / P384 verification in every test.
///
/// Usage: call `setNextResult(pcr0, pcr1, pcr2, publicKey, timestampMs)`, which builds a single
/// backing buffer (`bytes.concat(pcr0, pcr1, pcr2, publicKey)`) and returns it. Callers MUST pass
/// that exact returned buffer as `attestationTbs` to `validateAttestationWithHints` (and
/// therefore to `EnclaveRegistry.registerEnclave`) -- the mock's `Ptrs` offsets are only valid
/// against that buffer. Pass an empty `publicKey` to simulate an attestation with no bound key
/// (encoded as a CBOR null element, matching real Nitro documents that omit `public_key`).
contract MockNitroValidator is INitroValidator {
    bytes private nextTbs;
    uint256[3] private pcrLens;
    uint256 private pubKeyLen;
    bool private pubKeyIsNull;
    uint64 private nextTimestampMs;

    function setNextResult(
        bytes memory pcr0,
        bytes memory pcr1,
        bytes memory pcr2,
        bytes memory publicKey,
        uint64 timestampMs
    ) external returns (bytes memory attestationTbs) {
        attestationTbs = bytes.concat(pcr0, pcr1, pcr2, publicKey);
        nextTbs = attestationTbs;
        pcrLens[0] = pcr0.length;
        pcrLens[1] = pcr1.length;
        pcrLens[2] = pcr2.length;
        pubKeyLen = publicKey.length;
        pubKeyIsNull = publicKey.length == 0;
        nextTimestampMs = timestampMs;
    }

    function nextAttestationTbs() external view returns (bytes memory) {
        return nextTbs;
    }

    function validateAttestationWithHints(bytes memory attestationTbs, bytes memory, bytes memory)
        external
        view
        returns (NitroValidator.Ptrs memory ptrs)
    {
        require(keccak256(attestationTbs) == keccak256(nextTbs), "mock: attestationTbs must be nextAttestationTbs()");

        ptrs.timestamp = nextTimestampMs;
        ptrs.pcrs = new CborElement[](3);
        uint256 offset = 0;
        for (uint256 i = 0; i < 3; i++) {
            ptrs.pcrs[i] = LibCborElement.toCborElement(0x40, offset, pcrLens[i]);
            offset += pcrLens[i];
        }
        if (pubKeyIsNull) {
            ptrs.publicKey = LibCborElement.toCborElement(0xf6, 0, 0);
        } else {
            ptrs.publicKey = LibCborElement.toCborElement(0x40, offset, pubKeyLen);
        }
    }
}
