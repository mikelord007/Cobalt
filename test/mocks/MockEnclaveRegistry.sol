// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IEnclaveRegistry} from "../../src/IEnclaveRegistry.sol";

/// @notice Trivial settable registry for testing consumers without the attestation stack.
contract MockEnclaveRegistry is IEnclaveRegistry {
    mapping(bytes32 appId => mapping(address signer => bool)) public valid;

    function setValidSigner(bytes32 appId, address signer, bool isValid) external {
        valid[appId][signer] = isValid;
    }

    function isValidSigner(bytes32 appId, address signer) external view returns (bool) {
        return valid[appId][signer];
    }
}
