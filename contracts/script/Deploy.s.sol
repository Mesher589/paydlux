// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {AgentCreditToken} from "../src/AgentCreditToken.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {IERC20} from "../src/AgentCreditToken.sol";

/// Deploys the full stack to a testnet (Base Sepolia: chainId 84532).
/// The vault creates its own credit token in its constructor.
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org \
///     --private-key $TESTNET_PK --broadcast -vv
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();

        MockUSDC usdc = new MockUSDC();
        usdc.mint(msg.sender, 1_000_000 * 1e6); // $1M of fake money for demos

        AgentVault vault = new AgentVault(IERC20(address(usdc)), msg.sender, 100); // 1% fee

        console.log("MockUSDC        ", address(usdc));
        console.log("AgentCreditToken", address(vault.credit()));
        console.log("AgentVault      ", address(vault));

        vm.stopBroadcast();
    }
}
