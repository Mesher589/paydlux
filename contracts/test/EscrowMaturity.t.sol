// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AgentVaultTest, AgentVault} from "./AgentVault.t.sol";

/// @notice Regressions for the hackwatch follow-up report from KupiaSec
///         (sales at kupia.io, 2026-11-22), scored against this month's hacks.
///
/// DxSale — "a lock with no time check": refund() said "before it matures"
/// but never checked releaseAfter. Once the delivery window lapsed — the exact
/// moment the payee's money becomes claimable — the principal could still call
/// refund() and beat anyone's releaseExpired() to it, clawing back a payment
/// the payee had already earned by delivery-or-lapse. The payee's claim is
/// public, so a principal watching the mempool always wins that race.
///
/// NORA — "a stolen admin key with no delay": setFee and setFeeRecipient
/// applied inside the same transaction, so one leaked owner key could take up
/// to 10% of every later payment, invisibly. Both now go through a 48-hour
/// queue (applyFeeChange) that settles nothing early and lands loudly.
contract EscrowMaturityTest is AgentVaultTest {
    function _settleEscrow(uint256 nonce) internal returns (bytes32) {
        (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, payee, 4 * UNIT, nonce, "POST", "/api/report");
        vm.prank(principalKey);
        return vault.settle(it, sig, _bind("POST", "/api/report", bytes32(0)), _escrowTerms(1 days));
    }

    // ------------------------------------------------- refund after maturity

    /// @dev the report's scenario: window lapses, principal tries to claw back.
    function test_refund_after_maturity_rejected() public {
        bytes32 paymentId = _settleEscrow(11);
        skip(1 days); // block.timestamp == releaseAfter: releaseExpired is live now

        vm.prank(principalKey);
        vm.expectRevert(AgentVault.EscrowMatured.selector);
        vault.refund(paymentId);

        // the payee's entitlement survives the attempted clawback
        vault.releaseExpired(paymentId);
        assertEq(credit.balanceOf(payee), 4 * UNIT - (4 * UNIT * 100) / 10000, "payee still paid after maturity");
    }

    /// @dev the owner is not a second clawback door after maturity.
    function test_owner_cannot_refund_matured_escrow_either() public {
        bytes32 paymentId = _settleEscrow(12);
        skip(1 days);
        // the test contract deployed the vault, so it is the owner
        vm.expectRevert(AgentVault.EscrowMatured.selector);
        vault.refund(paymentId);
    }

    /// @dev the case that must keep working: the dispute path before maturity.
    function test_refund_before_maturity_still_works() public {
        bytes32 paymentId = _settleEscrow(13);
        skip(1 days - 1); // one second shy of maturity
        uint256 before = credit.balanceOf(principalKey);
        vm.prank(principalKey);
        vault.refund(paymentId);
        assertEq(credit.balanceOf(principalKey) - before, 4 * UNIT - (4 * UNIT * 100) / 10000, "refunded net while window open");
    }

    // ---------------------------------------------------- delayed fee change

    /// @dev the report's NORA scenario: a leaked owner key queues the maximum
    ///      fee pointed at the attacker — and takes nothing at all of what
    ///      settles inside the delay window.
    function test_leaked_owner_key_cannot_take_fee_immediately() public {
        vault.setFee(1000); // 10%, the cap
        vault.setFeeRecipient(attackerKey);

        assertEq(vault.feeBps(), 100, "queued, not applied");
        assertEq(vault.feeRecipient(), feeTo, "recipient queued, not applied");

        (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, payee, 4 * UNIT, 21, "POST", "/api/report");
        vm.prank(principalKey);
        vault.settle(it, sig, _bind("POST", "/api/report", bytes32(0)), _terms());
        assertEq(credit.balanceOf(attackerKey), 0, "attacker got nothing yet");
        assertEq(credit.balanceOf(feeTo), (4 * UNIT * 100) / 10000, "old rate paid to old recipient");
    }

    function test_apply_fee_change_requires_delay() public {
        vault.setFee(500);
        vm.expectRevert(AgentVault.NotYetEffective.selector);
        vault.applyFeeChange();

        skip(vault.FEE_DELAY() - 1);
        vm.expectRevert(AgentVault.NotYetEffective.selector);
        vault.applyFeeChange();

        skip(1);
        vault.applyFeeChange(); // permissionless: any caller may land it
        assertEq(vault.feeBps(), 500);
        assertEq(vault.feeRecipient(), feeTo, "setFee alone kept the recipient");

        vm.expectRevert(AgentVault.NothingQueued.selector);
        vault.applyFeeChange();
    }

    /// @dev after the delay the queued parameters are the ones payments use.
    function test_queued_fee_applies_after_delay() public {
        vault.queueFeeChange(250, attackerKey);
        skip(vault.FEE_DELAY());
        vault.applyFeeChange();

        (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, payee, 4 * UNIT, 22, "POST", "/api/report");
        vm.prank(principalKey);
        vault.settle(it, sig, _bind("POST", "/api/report", bytes32(0)), _terms());
        assertEq(credit.balanceOf(attackerKey), (4 * UNIT * 250) / 10000, "queued rate and recipient landed together");
    }

    function test_fee_change_access_and_zero_guards() public {
        vm.prank(attackerKey);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.queueFeeChange(1000, attackerKey);

        vm.expectRevert(AgentVault.ZeroAddress.selector);
        vault.setFeeRecipient(address(0));
    }

    /// @dev setPaused stays instant by design: a circuit breaker that waits
    ///      48 hours is not a circuit breaker. Pinned so a future "harden the
    ///      admin surface with a timelock" pass does not pause it by reflex.
    function test_setPaused_is_instant_by_design() public {
        vault.setPaused(true);
        vm.expectRevert(AgentVault.Paused.selector);
        vault.deposit(1);
    }
}
