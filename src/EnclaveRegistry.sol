// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IEnclaveRegistry} from "./IEnclaveRegistry.sol";
import {INitroValidator} from "./INitroValidator.sol";
import {NitroValidator} from "@nitro-validator/NitroValidator.sol";
import {CborDecode, CborElement, LibCborElement} from "@nitro-validator/CborDecode.sol";
import {LibBytes} from "@nitro-validator/LibBytes.sol";

/// @notice Multi-tenant registry mapping AWS Nitro enclave attestations to Ethereum signer
///         addresses, scoped per `appId`. Each app owner controls its own signer TTL, allowed
///         PCR images, and pause switch; apps do not interfere with one another.
contract EnclaveRegistry is IEnclaveRegistry {
    using CborDecode for bytes;
    using LibCborElement for CborElement;
    using LibBytes for bytes;

    /// @notice An attestation older than this (measured from its embedded timestamp) is rejected.
    uint256 public constant MAX_ATTESTATION_AGE = 60 minutes;

    /// @notice Number of leading PCRs bound into the image identity hash (PCR0, PCR1, PCR2).
    uint256 public constant BOUND_PCR_COUNT = 3;

    struct App {
        address owner;
        // Bumping this invalidates every previously-registered signer AND every previously
        // allowed image in one shot, without having to enumerate either set.
        uint64 configVersion;
        uint32 signerTTL;
        bool paused;
        bool exists;
        bytes32 sourceCommit;
        string sourceURI;
    }

    struct Signer {
        bytes32 appId;
        uint64 configVersion;
        uint64 expiresAt;
        bool revoked;
    }

    INitroValidator public immutable nitroValidator;

    mapping(bytes32 appId => App) public apps;
    mapping(bytes32 appId => mapping(bytes32 pcrSetHash => uint64 configVersion)) public allowedImageVersion;
    mapping(address signer => Signer) public signers;

    event AppCreated(bytes32 indexed appId, address indexed owner, uint32 signerTTL);
    event AppOwnershipTransferred(bytes32 indexed appId, address indexed previousOwner, address indexed newOwner);
    event AppPaused(bytes32 indexed appId, bool paused);
    event SourceUpdated(bytes32 indexed appId, bytes32 sourceCommit, string sourceURI);
    event AllowedImageSet(bytes32 indexed appId, bytes32 pcrSetHash, uint64 configVersion);
    event AllowedImageRemoved(bytes32 indexed appId, bytes32 pcrSetHash);
    event ConfigVersionBumped(bytes32 indexed appId, uint64 newConfigVersion);
    event EnclaveRegistered(bytes32 indexed appId, address indexed signer, bytes32 pcrSetHash, uint64 expiresAt);
    event SignerRevoked(address indexed signer);

    error AppAlreadyExists(bytes32 appId);
    error AppDoesNotExist(bytes32 appId);
    error NotAppOwner(bytes32 appId, address caller);
    error AppIsPaused(bytes32 appId);
    error ImageNotAllowed(bytes32 appId, bytes32 pcrSetHash);
    error ZeroPcrs(bytes32 appId);
    error AttestationTooOld(uint64 timestampMs);
    error AttestationMissingPublicKey();
    error SignerAlreadyRegistered(address signer);

    modifier onlyAppOwner(bytes32 appId) {
        App storage app = apps[appId];
        if (!app.exists) revert AppDoesNotExist(appId);
        if (app.owner != msg.sender) revert NotAppOwner(appId, msg.sender);
        _;
    }

    constructor(INitroValidator nitroValidator_) {
        require(address(nitroValidator_) != address(0), "missing nitro validator");
        nitroValidator = nitroValidator_;
    }

    function createApp(bytes32 appId, uint32 signerTTL, bytes32 sourceCommit, string calldata sourceURI) external {
        require(appId != bytes32(0), "missing appId");
        if (apps[appId].exists) revert AppAlreadyExists(appId);
        require(signerTTL > 0, "signerTTL must be nonzero");

        apps[appId] = App({
            owner: msg.sender,
            configVersion: 1,
            signerTTL: signerTTL,
            paused: false,
            exists: true,
            sourceCommit: sourceCommit,
            sourceURI: sourceURI
        });

        emit AppCreated(appId, msg.sender, signerTTL);
        emit SourceUpdated(appId, sourceCommit, sourceURI);
    }

    function transferAppOwnership(bytes32 appId, address newOwner) external onlyAppOwner(appId) {
        require(newOwner != address(0), "missing newOwner");
        address previousOwner = apps[appId].owner;
        apps[appId].owner = newOwner;
        emit AppOwnershipTransferred(appId, previousOwner, newOwner);
    }

    function setPaused(bytes32 appId, bool paused) external onlyAppOwner(appId) {
        apps[appId].paused = paused;
        emit AppPaused(appId, paused);
    }

    function updateSource(bytes32 appId, bytes32 sourceCommit, string calldata sourceURI)
        external
        onlyAppOwner(appId)
    {
        apps[appId].sourceCommit = sourceCommit;
        apps[appId].sourceURI = sourceURI;
        emit SourceUpdated(appId, sourceCommit, sourceURI);
    }

    /// @notice Allow the image identified by `pcrSetHash` for the app's CURRENT config version.
    /// @dev Stores the app's current `configVersion` as the value (not a bool) so a later
    ///      `bumpConfigVersion` automatically invalidates every previously-allowed image without
    ///      touching this mapping.
    function setAllowedImage(bytes32 appId, bytes32 pcrSetHash) external onlyAppOwner(appId) {
        uint64 configVersion = apps[appId].configVersion;
        allowedImageVersion[appId][pcrSetHash] = configVersion;
        emit AllowedImageSet(appId, pcrSetHash, configVersion);
    }

    function removeAllowedImage(bytes32 appId, bytes32 pcrSetHash) external onlyAppOwner(appId) {
        delete allowedImageVersion[appId][pcrSetHash];
        emit AllowedImageRemoved(appId, pcrSetHash);
    }

    function bumpConfigVersion(bytes32 appId) external onlyAppOwner(appId) {
        uint64 newConfigVersion = ++apps[appId].configVersion;
        emit ConfigVersionBumped(appId, newConfigVersion);
    }

    /// @notice Revoke a previously-registered signer. Not gated by `onlyAppOwner` since the
    ///         caller doesn't know the signer's appId in advance; instead the app is derived
    ///         from the signer record itself and ownership is checked against that.
    function revokeSigner(address signer) external {
        Signer storage s = signers[signer];
        App storage app = apps[s.appId];
        if (app.owner != msg.sender) revert NotAppOwner(s.appId, msg.sender);
        s.revoked = true;
        emit SignerRevoked(signer);
    }

    function registerEnclave(
        bytes32 appId,
        bytes calldata attestationTbs,
        bytes calldata signature,
        bytes calldata attestationSigHints
    ) external returns (address signer) {
        App storage app = apps[appId];
        if (!app.exists) revert AppDoesNotExist(appId);
        if (app.paused) revert AppIsPaused(appId);

        bytes32 pcrSetHash;
        (signer, pcrSetHash) = _verifyAndDeriveSigner(appId, attestationTbs, signature, attestationSigHints);

        uint64 configVersion = app.configVersion;
        if (allowedImageVersion[appId][pcrSetHash] != configVersion) revert ImageNotAllowed(appId, pcrSetHash);
        if (signers[signer].appId != bytes32(0)) revert SignerAlreadyRegistered(signer);

        uint64 expiresAt = uint64(block.timestamp) + app.signerTTL;
        signers[signer] = Signer(appId, configVersion, expiresAt, false);

        emit EnclaveRegistered(appId, signer, pcrSetHash, expiresAt);
    }

    function isValidSigner(bytes32 appId, address signer) external view returns (bool) {
        Signer storage s = signers[signer];
        if (s.appId != appId) return false;
        if (s.revoked) return false;
        if (block.timestamp > s.expiresAt) return false;
        App storage app = apps[appId];
        if (!app.exists || app.paused) return false;
        if (s.configVersion != app.configVersion) return false;
        return true;
    }

    function isImageAllowed(bytes32 appId, bytes32 pcrSetHash) external view returns (bool) {
        return allowedImageVersion[appId][pcrSetHash] == apps[appId].configVersion;
    }

    /// @dev Split out of `registerEnclave` purely to keep `NitroValidator.Ptrs`'s many fields off
    ///      that function's stack frame -- avoids "stack too deep" without enabling `via_ir`
    ///      (the vendored assembly-heavy libraries don't tolerate `via_ir` well).
    function _verifyAndDeriveSigner(
        bytes32 appId,
        bytes calldata attestationTbs,
        bytes calldata signature,
        bytes calldata attestationSigHints
    ) internal returns (address signer, bytes32 pcrSetHash) {
        NitroValidator.Ptrs memory ptrs =
            nitroValidator.validateAttestationWithHints(attestationTbs, signature, attestationSigHints);

        uint64 timestampSeconds = ptrs.timestamp / 1000;
        if (timestampSeconds + MAX_ATTESTATION_AGE <= block.timestamp) revert AttestationTooOld(ptrs.timestamp);

        pcrSetHash = _pcrSetHash(attestationTbs, ptrs, appId);

        if (ptrs.publicKey.isNull() || ptrs.publicKey.length() == 0) revert AttestationMissingPublicKey();
        // Skip the ANSI X9.62 uncompressed-point 0x04 prefix byte. This convention MUST stay in
        // lockstep with however the enclave derives its own Ethereum address from the same key:
        // address = keccak256(uncompressed_pubkey[1:])[12:].
        bytes32 publicKeyHash = attestationTbs.keccak(ptrs.publicKey.start() + 1, ptrs.publicKey.length() - 1);
        signer = address(uint160(uint256(publicKeyHash)));
    }

    /// @dev Concatenates the raw bytes of the first `BOUND_PCR_COUNT` PCRs and hashes them.
    ///      Reverts if every byte across the whole concatenation is zero -- this fires during
    ///      verification itself, before the allowlist is even consulted, so an all-zero hash can
    ///      never be used even if it happens to be allowlisted.
    function _pcrSetHash(bytes calldata attestationTbs, NitroValidator.Ptrs memory ptrs, bytes32 appId)
        internal
        pure
        returns (bytes32)
    {
        bytes memory concatenated;
        bool anyNonZero;
        for (uint256 i = 0; i < BOUND_PCR_COUNT; i++) {
            CborElement pcr = ptrs.pcrs[i];
            require(!pcr.isNull(), "missing bound pcr");
            bytes memory pcrBytes = attestationTbs.slice(pcr);
            if (!anyNonZero) {
                for (uint256 j = 0; j < pcrBytes.length; j++) {
                    if (pcrBytes[j] != 0) {
                        anyNonZero = true;
                        break;
                    }
                }
            }
            concatenated = bytes.concat(concatenated, pcrBytes);
        }
        if (!anyNonZero) revert ZeroPcrs(appId);
        return keccak256(concatenated);
    }
}
