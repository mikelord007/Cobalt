// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";

/// @notice Broadcasts a directory of pre-planned raw transactions, generic to whatever calldata
///         a planner (e.g. `tools/registrar.js`) wrote there. A slot with no calldata file means
///         "already cached on-chain" -- skip it silently, not an error. That's what makes
///         cert-cache reuse free across repeated deploys/registrations.
contract SubmitCalldataDir is Script {
    uint256 constant MAX_SLOTS = 8;

    function run() external {
        string memory dir = vm.envString("CALLDATA_DIR");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        for (uint256 i = 1; i <= MAX_SLOTS; i++) {
            string memory calldataPath = string.concat(dir, "/tx", vm.toString(i), "_calldata.txt");
            if (!vm.exists(calldataPath)) continue;

            string memory toPath = string.concat(dir, "/tx", vm.toString(i), "_to.txt");
            string memory labelPath = string.concat(dir, "/tx", vm.toString(i), "_label.txt");
            string memory gasLimitPath = string.concat(dir, "/tx", vm.toString(i), "_gaslimit.txt");

            address to = vm.parseAddress(vm.readFile(toPath));
            bytes memory data = vm.parseBytes(vm.readFile(calldataPath));
            string memory label = vm.exists(labelPath) ? vm.readFile(labelPath) : vm.toString(i);

            bool ok;
            bytes memory ret;
            if (vm.exists(gasLimitPath)) {
                uint256 gasLimit = vm.parseUint(vm.readFile(gasLimitPath));
                (ok, ret) = to.call{gas: gasLimit}(data);
            } else {
                (ok, ret) = to.call(data);
            }
            if (!ok) {
                if (ret.length > 0) {
                    assembly {
                        revert(add(ret, 0x20), mload(ret))
                    }
                }
                revert(string.concat("call failed: ", label));
            }
        }
        vm.stopBroadcast();
    }
}
