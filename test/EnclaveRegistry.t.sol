// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {EnclaveRegistry} from "../src/EnclaveRegistry.sol";
import {INitroValidator} from "../src/INitroValidator.sol";
import {MockNitroValidator} from "./mocks/MockNitroValidator.sol";

contract EnclaveRegistryTest is Test {
    EnclaveRegistry registry;
    MockNitroValidator validator;

    bytes32 constant APP_ID = keccak256("cobalt-test-app");

    function setUp() public {
        // Foundry's default block.timestamp == 1 underflows the freshness math in
        // _verifyAndDeriveSigner (timestampSeconds + MAX_ATTESTATION_AGE compared against it).
        vm.warp(1_700_000_000);
        validator = new MockNitroValidator();
        registry = new EnclaveRegistry(INitroValidator(address(validator)));
    }

    // ---- helpers ----------------------------------------------------------

    function _nonZeroPcrs() internal pure returns (bytes memory pcr0, bytes memory pcr1, bytes memory pcr2) {
        pcr0 = new bytes(48);
        pcr1 = new bytes(48);
        pcr2 = new bytes(48);
        pcr0[0] = 0x01;
    }

    function _zeroPcrs() internal pure returns (bytes memory pcr0, bytes memory pcr1, bytes memory pcr2) {
        pcr0 = new bytes(48);
        pcr1 = new bytes(48);
        pcr2 = new bytes(48);
    }

    function _pcrSetHash(bytes memory pcr0, bytes memory pcr1, bytes memory pcr2) internal pure returns (bytes32) {
        return keccak256(bytes.concat(pcr0, pcr1, pcr2));
    }

    /// @dev Builds a fake 65-byte ANSI X9.62 uncompressed public key (0x04 prefix + 64 bytes) and
    ///      independently computes the Ethereum address the registry should derive from it,
    ///      using the exact same convention: keccak256(pubkey[1:])[12:].
    function _makePublicKey(bytes32 seed) internal pure returns (bytes memory pubKey, address expectedSigner) {
        pubKey = abi.encodePacked(bytes1(0x04), seed, seed);
        expectedSigner = address(uint160(uint256(keccak256(abi.encodePacked(seed, seed)))));
    }

    function _freshTimestampMs() internal view returns (uint64) {
        return uint64(block.timestamp) * 1000;
    }

    // ---- happy path ---------------------------------------------------------

    function test_RegisterEnclave_HappyPath() public {
        registry.createApp(APP_ID, 1 hours, bytes32(0), "");

        (bytes memory pcr0, bytes memory pcr1, bytes memory pcr2) = _nonZeroPcrs();
        registry.setAllowedImage(APP_ID, _pcrSetHash(pcr0, pcr1, pcr2));

        (bytes memory pubKey, address expectedSigner) = _makePublicKey(keccak256("key-1"));
        bytes memory attestationTbs = validator.setNextResult(pcr0, pcr1, pcr2, pubKey, _freshTimestampMs());

        address signer = registry.registerEnclave(APP_ID, attestationTbs, "", "");

        assertEq(signer, expectedSigner);
        assertTrue(registry.isValidSigner(APP_ID, signer));
    }

    // ---- image allowlisting --------------------------------------------------

    function test_RegisterEnclave_RevertsForDisallowedImage() public {
        registry.createApp(APP_ID, 1 hours, bytes32(0), "");
        // Deliberately do not call setAllowedImage.

        (bytes memory pcr0, bytes memory pcr1, bytes memory pcr2) = _nonZeroPcrs();
        (bytes memory pubKey,) = _makePublicKey(keccak256("key-2"));
        bytes memory attestationTbs = validator.setNextResult(pcr0, pcr1, pcr2, pubKey, _freshTimestampMs());

        bytes32 pcrSetHash = _pcrSetHash(pcr0, pcr1, pcr2);
        vm.expectRevert(abi.encodeWithSelector(EnclaveRegistry.ImageNotAllowed.selector, APP_ID, pcrSetHash));
        registry.registerEnclave(APP_ID, attestationTbs, "", "");
    }

    function test_RegisterEnclave_RevertsForZeroPcrsEvenIfAllowlisted() public {
        registry.createApp(APP_ID, 1 hours, bytes32(0), "");

        (bytes memory pcr0, bytes memory pcr1, bytes memory pcr2) = _zeroPcrs();
        bytes32 zeroPcrSetHash = _pcrSetHash(pcr0, pcr1, pcr2);
        // Allowlist the all-zero hash on purpose -- the zero check must still fire, because it
        // runs inside verification, before the allowlist check is ever consulted.
        registry.setAllowedImage(APP_ID, zeroPcrSetHash);

        (bytes memory pubKey,) = _makePublicKey(keccak256("key-3"));
        bytes memory attestationTbs = validator.setNextResult(pcr0, pcr1, pcr2, pubKey, _freshTimestampMs());

        vm.expectRevert(abi.encodeWithSelector(EnclaveRegistry.ZeroPcrs.selector, APP_ID));
        registry.registerEnclave(APP_ID, attestationTbs, "", "");
    }

    // ---- freshness ------------------------------------------------------------

    function test_RegisterEnclave_RevertsForStaleAttestation() public {
        registry.createApp(APP_ID, 1 hours, bytes32(0), "");

        (bytes memory pcr0, bytes memory pcr1, bytes memory pcr2) = _nonZeroPcrs();
        registry.setAllowedImage(APP_ID, _pcrSetHash(pcr0, pcr1, pcr2));

        (bytes memory pubKey,) = _makePublicKey(keccak256("key-4"));
        // 61 minutes old -- past the 60 minute freshness window.
        uint64 staleMs = uint64(block.timestamp - 61 minutes) * 1000;
        bytes memory attestationTbs = validator.setNextResult(pcr0, pcr1, pcr2, pubKey, staleMs);

        vm.expectRevert(abi.encodeWithSelector(EnclaveRegistry.AttestationTooOld.selector, staleMs));
        registry.registerEnclave(APP_ID, attestationTbs, "", "");
    }

    function test_RegisterEnclave_RevertsExactlyAtFreshnessBoundary() public {
        registry.createApp(APP_ID, 1 hours, bytes32(0), "");

        (bytes memory pcr0, bytes memory pcr1, bytes memory pcr2) = _nonZeroPcrs();
        registry.setAllowedImage(APP_ID, _pcrSetHash(pcr0, pcr1, pcr2));

        (bytes memory pubKey,) = _makePublicKey(keccak256("key-5"));
        // Exactly at the boundary: timestampSeconds + MAX_ATTESTATION_AGE == block.timestamp.
        // The check is strict `<=`, so the boundary itself must be rejected.
        uint64 boundaryMs = uint64(block.timestamp - 60 minutes) * 1000;
        bytes memory attestationTbs = validator.setNextResult(pcr0, pcr1, pcr2, pubKey, boundaryMs);

        vm.expectRevert(abi.encodeWithSelector(EnclaveRegistry.AttestationTooOld.selector, boundaryMs));
        registry.registerEnclave(APP_ID, attestationTbs, "", "");
    }

    // ---- signer TTL -------------------------------------------------------------

    function test_SignerExpiresAfterTTL() public {
        registry.createApp(APP_ID, 1 hours, bytes32(0), "");

        (bytes memory pcr0, bytes memory pcr1, bytes memory pcr2) = _nonZeroPcrs();
        registry.setAllowedImage(APP_ID, _pcrSetHash(pcr0, pcr1, pcr2));

        (bytes memory pubKey,) = _makePublicKey(keccak256("key-6"));
        bytes memory attestationTbs = validator.setNextResult(pcr0, pcr1, pcr2, pubKey, _freshTimestampMs());
        address signer = registry.registerEnclave(APP_ID, attestationTbs, "", "");

        assertTrue(registry.isValidSigner(APP_ID, signer));

        vm.warp(block.timestamp + 1 hours + 1);
        assertFalse(registry.isValidSigner(APP_ID, signer));
    }

    // ---- revocation -----------------------------------------------------------

    function test_RevokeSigner_Works() public {
        registry.createApp(APP_ID, 1 hours, bytes32(0), "");

        (bytes memory pcr0, bytes memory pcr1, bytes memory pcr2) = _nonZeroPcrs();
        registry.setAllowedImage(APP_ID, _pcrSetHash(pcr0, pcr1, pcr2));

        (bytes memory pubKey,) = _makePublicKey(keccak256("key-7"));
        bytes memory attestationTbs = validator.setNextResult(pcr0, pcr1, pcr2, pubKey, _freshTimestampMs());
        address signer = registry.registerEnclave(APP_ID, attestationTbs, "", "");

        assertTrue(registry.isValidSigner(APP_ID, signer));
        registry.revokeSigner(signer);
        assertFalse(registry.isValidSigner(APP_ID, signer));
    }

    function test_RevokeSigner_RevertsForNonOwner() public {
        registry.createApp(APP_ID, 1 hours, bytes32(0), "");

        (bytes memory pcr0, bytes memory pcr1, bytes memory pcr2) = _nonZeroPcrs();
        registry.setAllowedImage(APP_ID, _pcrSetHash(pcr0, pcr1, pcr2));

        (bytes memory pubKey,) = _makePublicKey(keccak256("key-8"));
        bytes memory attestationTbs = validator.setNextResult(pcr0, pcr1, pcr2, pubKey, _freshTimestampMs());
        address signer = registry.registerEnclave(APP_ID, attestationTbs, "", "");

        address stranger = address(0xBEEF);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(EnclaveRegistry.NotAppOwner.selector, APP_ID, stranger));
        registry.revokeSigner(signer);
    }

    // ---- config version bump ---------------------------------------------------

    function test_BumpConfigVersion_InvalidatesSignerAndImage_ReaffirmingRestoresImage() public {
        registry.createApp(APP_ID, 1 hours, bytes32(0), "");

        (bytes memory pcr0, bytes memory pcr1, bytes memory pcr2) = _nonZeroPcrs();
        bytes32 pcrSetHash = _pcrSetHash(pcr0, pcr1, pcr2);
        registry.setAllowedImage(APP_ID, pcrSetHash);

        (bytes memory pubKey,) = _makePublicKey(keccak256("key-9"));
        bytes memory attestationTbs = validator.setNextResult(pcr0, pcr1, pcr2, pubKey, _freshTimestampMs());
        address signer = registry.registerEnclave(APP_ID, attestationTbs, "", "");

        assertTrue(registry.isValidSigner(APP_ID, signer));
        assertTrue(registry.isImageAllowed(APP_ID, pcrSetHash));

        registry.bumpConfigVersion(APP_ID);

        assertFalse(registry.isValidSigner(APP_ID, signer));
        assertFalse(registry.isImageAllowed(APP_ID, pcrSetHash));

        registry.setAllowedImage(APP_ID, pcrSetHash);
        assertTrue(registry.isImageAllowed(APP_ID, pcrSetHash));
    }

    // ---- pausing ----------------------------------------------------------------

    function test_Paused_BlocksRegistrationAndInvalidatesExistingSigners() public {
        registry.createApp(APP_ID, 1 hours, bytes32(0), "");

        (bytes memory pcr0, bytes memory pcr1, bytes memory pcr2) = _nonZeroPcrs();
        registry.setAllowedImage(APP_ID, _pcrSetHash(pcr0, pcr1, pcr2));

        (bytes memory pubKey,) = _makePublicKey(keccak256("key-10"));
        bytes memory attestationTbs = validator.setNextResult(pcr0, pcr1, pcr2, pubKey, _freshTimestampMs());
        address signer = registry.registerEnclave(APP_ID, attestationTbs, "", "");
        assertTrue(registry.isValidSigner(APP_ID, signer));

        registry.setPaused(APP_ID, true);

        assertFalse(registry.isValidSigner(APP_ID, signer));

        (bytes memory pubKey2,) = _makePublicKey(keccak256("key-11"));
        bytes memory attestationTbs2 = validator.setNextResult(pcr0, pcr1, pcr2, pubKey2, _freshTimestampMs());
        vm.expectRevert(abi.encodeWithSelector(EnclaveRegistry.AppIsPaused.selector, APP_ID));
        registry.registerEnclave(APP_ID, attestationTbs2, "", "");
    }

    // ---- app lifecycle -----------------------------------------------------------

    function test_CreateApp_RevertsOnDuplicate() public {
        registry.createApp(APP_ID, 1 hours, bytes32(0), "");
        vm.expectRevert(abi.encodeWithSelector(EnclaveRegistry.AppAlreadyExists.selector, APP_ID));
        registry.createApp(APP_ID, 1 hours, bytes32(0), "");
    }

    function test_SetAllowedImage_RevertsForNonOwner() public {
        registry.createApp(APP_ID, 1 hours, bytes32(0), "");

        address stranger = address(0xBEEF);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(EnclaveRegistry.NotAppOwner.selector, APP_ID, stranger));
        registry.setAllowedImage(APP_ID, keccak256("some-image"));
    }

    function test_TransferAppOwnership_Works() public {
        registry.createApp(APP_ID, 1 hours, bytes32(0), "");
        address newOwner = address(0xCAFE);

        registry.transferAppOwnership(APP_ID, newOwner);

        (address owner,,,,,,) = registry.apps(APP_ID);
        assertEq(owner, newOwner);

        // The old owner can no longer administer the app.
        vm.expectRevert(abi.encodeWithSelector(EnclaveRegistry.NotAppOwner.selector, APP_ID, address(this)));
        registry.setPaused(APP_ID, true);

        // The new owner can.
        vm.prank(newOwner);
        registry.setPaused(APP_ID, true);
        (,,, bool paused,,,) = registry.apps(APP_ID);
        assertTrue(paused);
    }
}
