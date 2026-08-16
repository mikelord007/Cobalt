// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {NitroValidator} from "@nitro-validator/NitroValidator.sol";

interface INitroValidator {
    function validateAttestationWithHints(
        bytes memory attestationTbs,
        bytes memory signature,
        bytes memory attestationSigHints
    ) external returns (NitroValidator.Ptrs memory);
}
