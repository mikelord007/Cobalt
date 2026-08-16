// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EnclaveConsumer} from "../EnclaveConsumer.sol";
import {IEnclaveRegistry} from "../IEnclaveRegistry.sol";

/// @notice Minimal example consumer proving the SDK end-to-end: verifies an EIP-712 `Pong`
///         message signed by an attested enclave and stores the last pong per nonce sender for
///         inspection.
contract PingConsumer is EnclaveConsumer {
    bytes32 private constant PONG_TYPEHASH = keccak256("Pong(string message,uint64 deadline,bytes32 nonce)");

    event Ponged(address indexed signer, string message, bytes32 nonce);

    constructor(IEnclaveRegistry registry_, bytes32 appId_) EnclaveConsumer(registry_, appId_, "Cobalt-Ping", "1") {}

    function submitPong(string calldata message, uint64 deadline, bytes32 nonce, bytes calldata signature)
        external
    {
        bytes32 structHash = keccak256(abi.encode(PONG_TYPEHASH, keccak256(bytes(message)), deadline, nonce));
        address signer = _requireEnclaveSignature(structHash, deadline, nonce, signature);
        emit Ponged(signer, message, nonce);
    }
}
