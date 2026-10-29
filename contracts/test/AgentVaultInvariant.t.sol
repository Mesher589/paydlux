// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {AgentVault, IERC20} from "../src/AgentVault.sol";
import {AgentVaultTest} from "./AgentVault.t.sol";

/// @notice Invariant + fuzz tests for the two claims the product rests on:
///         (1) no payment can exceed the mandate's policy envelope, and
///         (2) a payment proof is bound to exactly one HTTP request.
contract AgentVaultInvariant is AgentVaultTest {
    /// @dev the auto-generated getter returns a tuple, not the struct.
    function _perCall(bytes32 id) internal view returns (uint128) {
        (, , , , uint128 perCallMax, , , , , , , , , ) = vault.mandates(id);
        return perCallMax;
    }

    function _totalBudget(bytes32 id) internal view returns (uint128) {
        (, , , , , , uint128 totalBudget, , , , , , , ) = vault.mandates(id);
        return totalBudget;
    }

    function _spent(bytes32 id) internal view returns (uint128) {
        (, , , , , , , , , , , uint128 spent, , ) = vault.mandates(id);
        return spent;
    }
    /// @dev fuzz: any amount above the per-call cap must revert, for arbitrary
    ///      payees, nonces and request contents.
    function testFuzz_overPerCallAlwaysReverts(uint128 amount, address randPayee, uint256 nonce, bytes32 bodyHash) public {
        amount = uint128(bound(amount, _perCall(mandateId) + 1, type(uint128).max));
        nonce = bound(nonce, 1, 1e12);

        (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, randPayee, amount, nonce, "POST", "/api/x");
        vm.prank(principalKey);
        vm.expectRevert(AgentVault.OverPerCall.selector);
        vault.settle(it, sig, _bind("POST", "/api/x", bodyHash), _terms());
    }

    /// @dev fuzz: a valid proof presented against any request other than the one
    ///      it was bound to must revert. This is the floating-authorization class.
    /// @dev intent signed over an explicit bodyHash (the base helper pins it to 0).
    function _intentBH(bytes32 mid, address to_, uint128 amount, uint256 nonce, string memory method, string memory uri, bytes32 bh)
        internal
        view
        returns (AgentVault.Intent memory, bytes memory)
    {
        bytes32 rh = keccak256(abi.encodePacked(method, uri, bh, nonce));
        AgentVault.Intent memory it = AgentVault.Intent({
            mandateId: mid,
            payee: to_,
            amount: amount,
            validUntil: uint64(block.timestamp + 3600),
            nonce: nonce,
            requestHash: rh
        });
        bytes32 sh = keccak256(abi.encode(vault.INTENT_TYPEHASH(), mid, to_, amount, it.validUntil, nonce, rh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), sh)));
        return (it, abi.encodePacked(r, s, v));
    }

    function testFuzz_proofBoundToItsOwnRequest(uint256 nonce, string memory uriA, string memory uriB, bytes32 bodyHash) public {
        nonce = bound(nonce, 1, 1e12);
        vm.assume(keccak256(bytes(uriA)) != keccak256(bytes(uriB)));

        (AgentVault.Intent memory it, bytes memory sig) = _intentBH(mandateId, payee, 2 * UNIT, nonce, "POST", uriA, bodyHash);
        vm.prank(principalKey);
        vault.settle(it, sig, _bind("POST", uriA, bodyHash), _terms());

        // same signature, different live request
        vm.prank(principalKey);
        vm.expectRevert(AgentVault.RequestMismatch.selector);
        vault.settle(it, sig, _bind("POST", uriB, bodyHash), _terms());
    }

    /// @dev fuzz: total settled can never exceed the mandate's total budget,
    ///      whatever the sequence of valid-looking payments.
    function testFuzz_budgetIsHard(uint128[10] memory amounts, uint256 seed) public {
        uint128 perCall = _perCall(mandateId);
        bytes32 mid = mandateId;

        for (uint256 i = 0; i < 10; i++) {
            uint128 a = uint128(bound(amounts[i], 1, perCall));
            (AgentVault.Intent memory it, bytes memory sig) = _intent(mid, payee, a, i + 1, "POST", "/api/data");
            try vault.settle(it, sig, _bind("POST", "/api/data", bytes32(0)), _terms()) {} catch {}
            if (i % 3 == 2) skip(DAY); // roll the daily window so budget, not day, binds
        }

        assertLe(vault.volumeSettled(), _totalBudget(mid), "total budget is a hard ceiling");
        assertLe(vault.remainingBudget(mid), _totalBudget(mid));
        assertEq(vault.remainingBudget(mid), _totalBudget(mid) - _spent(mid));
    }

    /// @dev fuzz: credits are conserved. Everything minted equals USDC custodied
    ///      plus fees, and settlement never creates or destroys value.
    function testFuzz_valueIsConserved(uint128 depositAmount, uint128[5] memory payments) public {
        depositAmount = uint128(bound(depositAmount, 1, 100 * UNIT));

        address alice = makeAddr("alice");
        uint256 alicePk = uint256(keccak256("alice"));
        address aliceKey = vm.addr(alicePk);

        usdc.mint(aliceKey, depositAmount);
        vm.startPrank(aliceKey);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(depositAmount);
        vm.stopPrank();

        uint64 nowT = uint64(block.timestamp);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            alicePk,
            vault.mandateDigest(aliceKey, alice, uint64(block.timestamp - 1), nowT + 30 days, depositAmount, depositAmount, depositAmount, bytes32(0), 7)
        );
        bytes32 mid = vault.registerMandate(
            aliceKey, alice, uint64(block.timestamp - 1), nowT + 30 days, depositAmount, depositAmount, depositAmount, bytes32(0), 7, abi.encodePacked(r, s, v)
        );

        for (uint256 i = 0; i < 5; i++) {
            uint128 a = uint128(bound(payments[i], 1, depositAmount));
            bytes32 rh = keccak256(abi.encodePacked("POST", "/api/data", bytes32(0), uint256(i + 1)));
            AgentVault.Intent memory it = AgentVault.Intent({
                mandateId: mid,
                payee: payee,
                amount: a,
                validUntil: uint64(block.timestamp + 3600),
                nonce: i + 1,
                requestHash: rh
            });
            bytes32 sh = keccak256(abi.encode(vault.INTENT_TYPEHASH(), mid, payee, a, it.validUntil, uint256(i + 1), rh));
            (uint8 av, bytes32 ar, bytes32 as_) = vm.sign(alicePk, keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), sh)));
            try vault.settle(it, abi.encodePacked(ar, as_, av), _bind("POST", "/api/data", bytes32(0)), _terms()) {} catch {}
        }

        // settlement burns the gross then mints net+fee, so supply never drifts:
        // every credit outstanding is backed 1:1 by USDC sitting in the vault.
        uint256 supply = vault.credit().totalSupply();
        uint256 held = usdc.balanceOf(address(vault));
        assertEq(supply, held, "credits are fully backed 1:1");
        assertLe(vault.feesCollected(), supply, "fees cannot exceed circulation");
    }
}
