// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IEnclaveRegistry {
    function isValidSigner(bytes32 appId, address signer) external view returns (bool);
}
