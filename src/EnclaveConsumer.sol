// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IEnclaveRegistry} from "./IEnclaveRegistry.sol";

/// @notice Base contract for consuming EIP-712 messages signed by an attested enclave.
///         Deadline and nonce are mandatory on every verified message -- never optional.
///         Nonces are global per consumer contract.
abstract contract EnclaveConsumer is EIP712 {
    IEnclaveRegistry public immutable registry;
    bytes32 public immutable appId;

    mapping(bytes32 nonce => bool) public usedNonces;

    error MessageExpired(uint64 deadline, uint256 currentTimestamp);
    error NonceAlreadyUsed(bytes32 nonce);
    error SignerNotAttested(address signer);

    constructor(IEnclaveRegistry registry_, bytes32 appId_, string memory eip712Name, string memory eip712Version)
        EIP712(eip712Name, eip712Version)
    {
        require(address(registry_) != address(0), "missing registry");
        require(appId_ != bytes32(0), "missing appId");
        registry = registry_;
        appId = appId_;
    }

    function _requireEnclaveSignature(bytes32 structHash, uint64 deadline, bytes32 nonce, bytes calldata signature)
        internal
        returns (address signer)
    {
        if (block.timestamp > deadline) revert MessageExpired(deadline, block.timestamp);
        if (usedNonces[nonce]) revert NonceAlreadyUsed(nonce);
        usedNonces[nonce] = true;

        signer = ECDSA.recoverCalldata(_hashTypedDataV4(structHash), signature);
        if (!registry.isValidSigner(appId, signer)) revert SignerNotAttested(signer);
    }
}
