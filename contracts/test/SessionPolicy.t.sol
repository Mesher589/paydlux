// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {AgentVault, IERC20} from "../src/AgentVault.sol";
import {AgentVaultTest} from "./AgentVault.t.sol";

/// @notice Regression tests for the session-path mandate bypass reported by
///         blacklitosphere88 (GitHub issue #1 follow-up), plus the two extra
///         gaps found while reproducing it: the session path never checked the
///         mandate's validity window, and a session kept paying after the
///         mandate expired or was revoked.
/// @dev Each test here is the exploit from the report. They pass because the
///      session path now refuses; before the fix every one of them paid out.
contract SessionPolicyTest is AgentVaultTest {
    function _registerMandate(bytes32 payeeRoot, uint128 perCall, uint128 daily, uint128 total, uint256 nonce)
        internal
        returns (bytes32)
    {
        uint64 nowT = uint64(block.timestamp);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            PRINCIPAL_PK,
            vault.mandateDigest(principalKey, agentKey, nowT - 1, nowT + 30 days, perCall, daily, total, payeeRoot, nonce)
        );
        vm.prank(principalKey);
        return vault.registerMandate(
            principalKey, agentKey, nowT - 1, nowT + 30 days, perCall, daily, total, payeeRoot, nonce, abi.encodePacked(r, s, v)
        );
    }

    function _sessionDigest(bytes32 mid, address to_, uint128 maxAmount, uint64 validUntil, uint256 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 sh = keccak256(abi.encode(vault.SESSION_TYPEHASH(), mid, to_, maxAmount, validUntil, nonce));
        return keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), sh));
    }

    function _open(bytes32 mid, address to_, uint128 maxAmount, uint64 validUntil, uint256 nonce, bytes32[] memory proof)
        internal
        returns (bytes32)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, _sessionDigest(mid, to_, maxAmount, validUntil, nonce));
        return vault.openSession(mid, to_, maxAmount, validUntil, nonce, proof, abi.encodePacked(r, s, v));
    }

    function _charge(bytes32 sessionId, uint128 amount, uint256 nonce, uint64 validUntil) internal {
        bytes32 ch = keccak256(abi.encode(vault.CHARGE_TYPEHASH(), sessionId, amount, nonce, validUntil));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), ch)));
        vault.charge(sessionId, amount, nonce, validUntil, abi.encodePacked(r, s, v));
    }

    // @dev vm.expectRevert is consumed by the NEXT call, and vm.sign is a call
    //      to the cheatcode address — so the signature has to be produced
    //      before the expectation is armed. These two helpers do that.
    function _openReverts(bytes32 mid, address to_, uint128 maxAmount, uint64 validUntil, uint256 nonce, bytes32[] memory proof, bytes4 sel)
        internal
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, _sessionDigest(mid, to_, maxAmount, validUntil, nonce));
        vm.expectRevert(sel);
        vault.openSession(mid, to_, maxAmount, validUntil, nonce, proof, abi.encodePacked(r, s, v));
    }

    function _chargeReverts(bytes32 sessionId, uint128 amount, uint256 nonce, uint64 validUntil, bytes4 sel) internal {
        bytes32 ch = keccak256(abi.encode(vault.CHARGE_TYPEHASH(), sessionId, amount, nonce, validUntil));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), ch)));
        vm.expectRevert(sel);
        vault.charge(sessionId, amount, nonce, validUntil, abi.encodePacked(r, s, v));
    }

    // --------------------------------------------------- 1. payee allowlist

    /// @dev the reported bypass: an allowlisted mandate could be drained to any
    ///      address, including the agent's own.
    function test_session_to_unlisted_payee_reverts() public {
        bytes32 root = keccak256(abi.encodePacked(payee)); // allowlist = {payee}
        bytes32 mid = _registerMandate(root, 5 * UNIT, 50 * UNIT, 200 * UNIT, 7);
        _openReverts(mid, attackerKey, 200 * UNIT, uint64(block.timestamp + 3600), 1, new bytes32[](0), AgentVault.PayeeNotAllowed.selector);
    }

    /// @dev a forged proof must not pass either.
    function test_session_bad_payee_proof_reverts() public {
        bytes32 root = keccak256(abi.encodePacked(payee));
        bytes32 mid = _registerMandate(root, 5 * UNIT, 50 * UNIT, 200 * UNIT, 7);
        bytes32[] memory fake = new bytes32[](1);
        fake[0] = keccak256("not-a-sibling");
        _openReverts(mid, attackerKey, 200 * UNIT, uint64(block.timestamp + 3600), 1, fake, AgentVault.PayeeNotAllowed.selector);
    }

    /// @dev the allowlisted payee still streams normally — the fix must not
    ///      break the feature it is guarding.
    function test_session_allowlisted_payee_still_works() public {
        bytes32 root = keccak256(abi.encodePacked(payee));
        bytes32 mid = _registerMandate(root, 5 * UNIT, 50 * UNIT, 200 * UNIT, 7);
        bytes32 sid = _open(mid, payee, 20 * UNIT, uint64(block.timestamp + 3600), 1, new bytes32[](0));
        _charge(sid, 1 * UNIT, 1, uint64(block.timestamp + 3600));
        assertEq(credit.balanceOf(payee), 1 * UNIT - (1 * UNIT * 100) / 10000, "streamed net");
    }

    // --------------------------------------------------- 2. human approval

    /// @dev the reported bypass: an approval-gated mandate could be fully spent
    ///      through a session with no approver signature.
    function test_session_on_approval_gated_mandate_reverts() public {
        bytes32 mid = _registerMandate(bytes32(0), 5 * UNIT, 50 * UNIT, 200 * UNIT, 8);
        vm.prank(principalKey);
        vault.setApprovalPolicy(mid, true, principalKey);
        _openReverts(mid, payee, 200 * UNIT, uint64(block.timestamp + 3600), 1, new bytes32[](0), AgentVault.ApprovalRequired.selector);
    }

    /// @dev tightening the policy after a session is open closes the door
    ///      mid-stream: the current policy is what counts.
    function test_charge_after_policy_tightened_reverts() public {
        bytes32 mid = _registerMandate(bytes32(0), 5 * UNIT, 50 * UNIT, 200 * UNIT, 8);
        bytes32 sid = _open(mid, payee, 200 * UNIT, uint64(block.timestamp + 3600), 1, new bytes32[](0));
        _charge(sid, 1 * UNIT, 1, uint64(block.timestamp + 3600));

        vm.prank(principalKey);
        vault.setApprovalPolicy(mid, true, principalKey);
        _chargeReverts(sid, 1 * UNIT, 2, uint64(block.timestamp + 3600), AgentVault.ApprovalRequired.selector);
    }

    // --------------------------------------------------- 3. per-call cap

    /// @dev the reported bypass: one charge() could move far more than perCallMax.
    function test_charge_over_per_call_cap_reverts() public {
        bytes32 mid = _registerMandate(bytes32(0), 5 * UNIT, 50 * UNIT, 200 * UNIT, 9);
        bytes32 sid = _open(mid, payee, 200 * UNIT, uint64(block.timestamp + 3600), 1, new bytes32[](0));
        _chargeReverts(sid, 50 * UNIT, 1, uint64(block.timestamp + 3600), AgentVault.OverPerCall.selector);
    }

    /// @dev many charges at the cap still work: the ceiling is per call, not
    ///      per session.
    function test_charge_at_per_call_cap_works() public {
        bytes32 mid = _registerMandate(bytes32(0), 5 * UNIT, 50 * UNIT, 200 * UNIT, 9);
        bytes32 sid = _open(mid, payee, 200 * UNIT, uint64(block.timestamp + 3600), 1, new bytes32[](0));
        _charge(sid, 5 * UNIT, 1, uint64(block.timestamp + 3600));
        _charge(sid, 5 * UNIT, 2, uint64(block.timestamp + 3600));
        assertEq(credit.balanceOf(payee), 10 * UNIT - (10 * UNIT * 100) / 10000, "two at the cap");
    }

    // ------------------------------------------- 4. mandate window / revocation

    /// @dev extra gap: the session path ignored the mandate's own expiry.
    function test_session_on_expired_mandate_reverts() public {
        uint64 nowT = uint64(block.timestamp);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            PRINCIPAL_PK,
            vault.mandateDigest(principalKey, agentKey, nowT - 1, nowT + 1 hours, 5 * UNIT, 50 * UNIT, 200 * UNIT, bytes32(0), 10)
        );
        vm.prank(principalKey);
        bytes32 mid = vault.registerMandate(
            principalKey, agentKey, nowT - 1, nowT + 1 hours, 5 * UNIT, 50 * UNIT, 200 * UNIT, bytes32(0), 10, abi.encodePacked(r, s, v)
        );
        skip(2 hours);
        _openReverts(mid, payee, 200 * UNIT, uint64(block.timestamp + 30 days), 1, new bytes32[](0), AgentVault.MandateWindow.selector);
    }

    /// @dev a session cannot outlive the mandate that opened it.
    function test_session_cannot_outlive_mandate_window() public {
        bytes32 mid = _registerMandate(bytes32(0), 5 * UNIT, 50 * UNIT, 200 * UNIT, 11);
        _openReverts(mid, payee, 200 * UNIT, uint64(block.timestamp + 60 days), 1, new bytes32[](0), AgentVault.MandateWindow.selector);
    }

    /// @dev extra gap: revoking a mandate must stop an already-open session.
    function test_revoked_mandate_stops_open_session() public {
        bytes32 mid = _registerMandate(bytes32(0), 5 * UNIT, 50 * UNIT, 200 * UNIT, 12);
        bytes32 sid = _open(mid, payee, 200 * UNIT, uint64(block.timestamp + 3600), 1, new bytes32[](0));
        _charge(sid, 1 * UNIT, 1, uint64(block.timestamp + 3600));

        vm.prank(principalKey);
        vault.revokeMandate(mid);
        _chargeReverts(sid, 1 * UNIT, 2, uint64(block.timestamp + 3600), AgentVault.MandateInactive.selector);
    }

    /// @dev a session can never be opened past the mandate window, so mandate
    ///      expiry always implies session expiry here. The MandateWindow check
    ///      inside charge() is defence in depth, not the reachable path: this
    ///      asserts the reachable one.
    function test_charge_after_mandate_expiry_reverts() public {
        uint64 nowT = uint64(block.timestamp);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            PRINCIPAL_PK,
            vault.mandateDigest(principalKey, agentKey, nowT - 1, nowT + 1 hours, 5 * UNIT, 50 * UNIT, 200 * UNIT, bytes32(0), 13)
        );
        vm.prank(principalKey);
        bytes32 mid = vault.registerMandate(
            principalKey, agentKey, nowT - 1, nowT + 1 hours, 5 * UNIT, 50 * UNIT, 200 * UNIT, bytes32(0), 13, abi.encodePacked(r, s, v)
        );
        bytes32 sid = _open(mid, payee, 200 * UNIT, uint64(block.timestamp + 1 hours), 1, new bytes32[](0));
        skip(2 hours);
        _chargeReverts(sid, 1 * UNIT, 1, uint64(block.timestamp + 30 days), AgentVault.SessionExpired.selector);
    }
}
