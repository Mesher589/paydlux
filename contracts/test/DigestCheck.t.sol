// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {IERC20} from "../src/AgentVault.sol";

contract DigestCheckTest is Test {
    AgentVault v;

    function setUp() public {
        v = new AgentVault(IERC20(address(0xBEEF)), address(this), 10);
    }

    function testDigestComposition() public view {
        address p = address(0x123);
        address a = address(0x456);
        bytes32 sh = v.mandateStructHash(p, a, 1, 2, 3, 4, 5, bytes32(0), 7);
        bytes32 d = v.mandateDigest(p, a, 1, 2, 3, 4, 5, bytes32(0), 7);
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", v.DOMAIN_SEPARATOR(), sh));
        assertEq(d, expected, "digest != 0x1901||DS||structHash");
    }
}
