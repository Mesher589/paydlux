// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {AgentCreditToken} from "../src/AgentCreditToken.sol";
import {IERC20} from "../src/AgentCreditToken.sol";

/// Deploys the vault to a real Base Sepolia (or a fork of it) using the
/// REAL Circle test USDC at 0x036CbD53842c5426634e7929541eC2318f3dCF7e.
/// Usage:
///   forge script script/DeployBaseSepolia.s.sol --rpc-url $RPC \
///     --private-key $PK --broadcast
contract DeployBaseSepolia is Script {
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external {
        vm.startBroadcast();
        AgentVault vault = new AgentVault(IERC20(USDC), msg.sender, 100); // 1% fee
        console.log("AgentCreditToken", address(vault.credit()));
        console.log("AgentVault      ", address(vault));
        vm.stopBroadcast();
    }
}
