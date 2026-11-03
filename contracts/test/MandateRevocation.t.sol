// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {AgentVaultTest, AgentVault} from "./AgentVault.t.sol";

/// @notice Regression for the report from sales@kupia.io about registerMandate()
///         and revokeMandate().
///
/// @dev The mandate id is a hash of the mandate's own parameters, so revoking a
///      mandate left an *inactive* slot at that same id while the principal's
///      signature over that digest stayed valid forever. registerMandate only
///      guarded with `if (mandates[id].active) revert AlreadyUsed()`, so anyone
///      holding the signature — the agent, or anyone who saw it on-chain, since
///      the registration transaction is public — could put the revoked mandate
///      back exactly as it was. Revocation was advice, not a control.
///
///      Fixed by making a mandate id spent forever: `mandateSeen` is never
///      cleared. A principal who wants to resume must issue a new mandate with a
///      new nonce, which is also what makes the revocation meaningful: the old
///      id can never come back.
contract MandateRevocationTest is AgentVaultTest {
    function _active(bytes32 id) internal view returns (bool) {
        // mandates() is a public getter over a 14-field struct, so the tuple has
        // to be destructured rather than accessed by member.
        // Solidity has no skip-syntax in tuple destructuring, so all 14 fields
        // are named.
        (, , , , , , , , bool active, , , , , ) = vault.mandates(id);
        return active;
    }

    function _register(uint256 nonce, uint64 validUntil, bytes memory sig) internal returns (bytes32) {
        vm.prank(principalKey);
        return vault.registerMandate(
            principalKey, agentKey, uint64(block.timestamp - 1), validUntil, 10 * UNIT, 50 * UNIT, 200 * UNIT, bytes32(0), nonce, sig);
    }

    function _sig(uint256 nonce, uint64 validUntil) internal view returns (bytes memory) {
        bytes32 digest = vault.mandateDigest(
            principalKey, agentKey, uint64(block.timestamp - 1), validUntil, 10 * UNIT, 50 * UNIT, 200 * UNIT, bytes32(0), nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PRINCIPAL_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev The exploit from the report: revoke, then re-register the same signed
    ///      parameters under the same id. Now refused.
    function test_reregister_after_revoke_reverts() public {
        uint256 nonce = 77;
        uint64 validUntil = uint64(block.timestamp + 30 days);
        bytes memory sig = _sig(nonce, validUntil);
        bytes32 id = _register(nonce, validUntil, sig);

        vm.prank(principalKey);
        vault.revokeMandate(id);
        assertFalse(_active(id), "revoked");

        // Any caller can replay the public signature; the agent is enough.
        vm.prank(agentKey);
        vm.expectRevert(AgentVault.AlreadyUsed.selector);
        vault.registerMandate(
            principalKey, agentKey, uint64(block.timestamp - 1), validUntil, 10 * UNIT, 50 * UNIT, 200 * UNIT, bytes32(0), nonce, sig);
    }

    /// @dev Re-registering before any revocation was already refused, and still is.
    function test_double_register_reverts() public {
        uint256 nonce = 78;
        uint64 validUntil = uint64(block.timestamp + 30 days);
        bytes memory sig = _sig(nonce, validUntil);
        _register(nonce, validUntil, sig);

        vm.prank(principalKey);
        vm.expectRevert(AgentVault.AlreadyUsed.selector);
        vault.registerMandate(
            principalKey, agentKey, uint64(block.timestamp - 1), validUntil, 10 * UNIT, 50 * UNIT, 200 * UNIT, bytes32(0), nonce, sig);
    }

    /// @dev The fix must not lock the principal out of re-issuing: a new nonce is
    ///      a new id and registers fine after a revocation.
    function test_new_nonce_after_revoke_registers() public {
        uint64 validUntil = uint64(block.timestamp + 30 days);
        bytes32 old = _register(79, validUntil, _sig(79, validUntil));
        vm.prank(principalKey);
        vault.revokeMandate(old);

        bytes32 fresh = _register(80, validUntil, _sig(80, validUntil));
        assertTrue(fresh != old, "new nonce, new id");
        assertTrue(_active(fresh), "usable again");
    }

    /// @dev A failed registration must not burn an id: the revert rolls the
    ///      marker back, so a later valid attempt at the same id still works.
    function test_bad_signature_does_not_burn_the_id() public {
        uint256 nonce = 81;
        uint64 validUntil = uint64(block.timestamp + 30 days);
        bytes memory wrong = _sig(nonce + 1000, validUntil);

        vm.prank(principalKey);
        vm.expectRevert(AgentVault.BadSignature.selector);
        vault.registerMandate(
            principalKey, agentKey, uint64(block.timestamp - 1), validUntil, 10 * UNIT, 50 * UNIT, 200 * UNIT, bytes32(0), nonce, wrong);

        bytes32 id = _register(nonce, validUntil, _sig(nonce, validUntil));
        assertTrue(_active(id), "id was still free");
    }
}
