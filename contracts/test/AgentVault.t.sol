// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {AgentVault, IERC20} from "../src/AgentVault.sol";
import {AgentCreditToken} from "../src/AgentCreditToken.sol";

/// @dev USDC-like token: 6 decimals, returns bool.
contract MockUSDC is IERC20 {
    uint256 private _ts;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint256 supply) {
        balanceOf[msg.sender] = supply;
        _ts = supply;
    }

    function totalSupply() external view returns (uint256) {
        return _ts;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "bal");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        emit Transfer(msg.sender, to, v);
        return true;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }

    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        require(allowance[f][msg.sender] >= v, "allow");
        require(balanceOf[f] >= v, "bal");
        allowance[f][msg.sender] -= v;
        balanceOf[f] -= v;
        balanceOf[t] += v;
        emit Transfer(f, t, v);
        return true;
    }

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
        _ts += v;
        emit Transfer(address(0), to, v);
    }
}

contract AgentVaultTest is Test {
    AgentVault internal vault;
    AgentCreditToken internal credit;
    MockUSDC internal usdc;

    address internal principal = makeAddr("principal");
    uint256 internal constant PAYEE_PK = 0xCAFE;
    address internal payee;
    address internal feeTo = makeAddr("feeTo");

    uint256 internal constant PRINCIPAL_PK = 0xA11CE;
    uint256 internal constant AGENT_PK = 0xB0B;
    uint256 internal constant ATTACKER_PK = 0xDEAD;

    address internal principalKey;
    address internal agentKey;
    address internal attackerKey;
    address internal payeeKey;

    uint128 internal constant UNIT = 1e6; // 1.00 USDC
    uint64 internal constant DAY = 86400;

    bytes32 internal mandateId;

    function setUp() public {
        principalKey = vm.addr(PRINCIPAL_PK);
        agentKey = vm.addr(AGENT_PK);
        attackerKey = vm.addr(ATTACKER_PK);
        payeeKey = vm.addr(PAYEE_PK);
        payee = payeeKey;

        usdc = new MockUSDC(1_000 * UNIT);

        // The vault deploys and permanently owns its settlement token.
        vault = new AgentVault(IERC20(usdc), feeTo, 100); // 100 bps = 1%
        credit = vault.credit();

        usdc.mint(principalKey, 500 * UNIT);

        vm.startPrank(principalKey);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(500 * UNIT);
        vm.stopPrank();

        mandateId = _registerDefaultMandate();
    }

    function _registerDefaultMandate() internal returns (bytes32) {
        uint64 nowT = uint64(block.timestamp);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            PRINCIPAL_PK,
            vault.mandateDigest(principalKey, agentKey, uint64(block.timestamp - 1), nowT + 30 days, 5 * UNIT, 50 * UNIT, 200 * UNIT, bytes32(0), 1)
        );
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.prank(principalKey);
        return vault.registerMandate(
            principalKey, agentKey, uint64(block.timestamp - 1), nowT + 30 days, 5 * UNIT, 50 * UNIT, 200 * UNIT, bytes32(0), 1, sig
        );
    }

    // -------------------------------------------------- signature conventions

    /// @dev a mandate registered with a plain-wallet EIP-191 personal_sign
    ///      signature must be accepted (MetaMask / Ledger / viem signMessage).
    function testRegisterMandateWithPersonalSign() public {
        uint64 nowT = uint64(block.timestamp);
        bytes32 id = vault.mandateDigest(principalKey, agentKey, uint64(block.timestamp - 1), nowT + 30 days, 5 * UNIT, 50 * UNIT, 200 * UNIT, bytes32(0), 41);
        // sign the digest the way a browser wallet does: EIP-191 wrapper
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PRINCIPAL_PK, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", id)));
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.prank(principalKey);
        bytes32 got = vault.registerMandate(
            principalKey, agentKey, uint64(block.timestamp - 1), nowT + 30 days, 5 * UNIT, 50 * UNIT, 200 * UNIT, bytes32(0), 41, sig
        );
        assertEq(got, id);
        assertEq(vault.remainingBudget(id), 200 * UNIT);
    }

    /// @dev a personal_sign signature from the WRONG key must still be rejected.
    function testRegisterMandateRejectsWrongPersonalSign() public {
        uint64 nowT = uint64(block.timestamp);
        bytes32 id = vault.mandateDigest(principalKey, agentKey, uint64(block.timestamp - 1), nowT + 30 days, 5 * UNIT, 50 * UNIT, 200 * UNIT, bytes32(0), 42);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", id)));
        vm.prank(principalKey);
        vm.expectRevert(AgentVault.BadSignature.selector);
        vault.registerMandate(
            principalKey, agentKey, uint64(block.timestamp - 1), nowT + 30 days, 5 * UNIT, 50 * UNIT, 200 * UNIT, bytes32(0), 42, abi.encodePacked(r, s, v)
        );
    }

    // --------------------------------------------------------------- helpers

    function _bind(string memory method, string memory uri, bytes32 bodyHash) internal pure returns (AgentVault.Binding memory) {
        return AgentVault.Binding({method: method, uri: uri, bodyHash: bodyHash});
    }

    function _intent(bytes32 mid, address to_, uint128 amount, uint256 nonce, string memory method, string memory uri)
        internal
        view
        returns (AgentVault.Intent memory, bytes memory)
    {
        bytes32 requestHash = keccak256(abi.encodePacked(method, uri, bytes32(0), nonce));
        AgentVault.Intent memory it = AgentVault.Intent({
            mandateId: mid,
            payee: to_,
            amount: amount,
            validUntil: uint64(block.timestamp + 3600),
            nonce: nonce,
            requestHash: requestHash
        });
        bytes32 structHash = keccak256(
            abi.encode(AgentVault(vault).INTENT_TYPEHASH(), mid, to_, amount, it.validUntil, nonce, requestHash)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, digest);
        return (it, abi.encodePacked(r, s, v));
    }

    function _terms() internal pure returns (AgentVault.Terms memory) {
        return AgentVault.Terms({payeeProof: new bytes32[](0), contentHash: bytes32(0), releaseAfter: 0});
    }

    function _escrowTerms(uint64 window) internal pure returns (AgentVault.Terms memory) {
        return AgentVault.Terms({payeeProof: new bytes32[](0), contentHash: bytes32(0), releaseAfter: window});
    }

    function _escrowTermsWith(uint64 window, bytes32 contentHash) internal pure returns (AgentVault.Terms memory) {
        return AgentVault.Terms({payeeProof: new bytes32[](0), contentHash: contentHash, releaseAfter: window});
    }

    /// @dev like _intent but also returns the EIP-712 digest, so a test can act
    ///      as the human approver over the exact same payload.
    function _intentWithDigest(bytes32 mid, address to_, uint128 amount, uint256 nonce, string memory method, string memory uri)
        internal
        view
        returns (AgentVault.Intent memory, bytes memory, bytes32)
    {
        (AgentVault.Intent memory it, bytes memory sig) = _intent(mid, to_, amount, nonce, method, uri);
        bytes32 requestHash = keccak256(abi.encodePacked(method, uri, bytes32(0), nonce));
        bytes32 structHash = keccak256(abi.encode(AgentVault(vault).INTENT_TYPEHASH(), mid, to_, amount, it.validUntil, nonce, requestHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash));
        return (it, sig, digest);
    }

    // --------------------------------------------------- human-in-the-loop approval

    function test_approval_required_blocks_unapproved_settle() public {
        vm.prank(principalKey);
        vault.setApprovalPolicy(mandateId, true, address(0)); // approver defaults to principal

        (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, payee, 2 * UNIT, 1, "POST", "/api/data");
        vm.expectRevert(AgentVault.ApprovalRequired.selector);
        vault.settle(it, sig, _bind("POST", "/api/data", bytes32(0)), _terms());
    }

    function test_approval_by_principal_releases_settle() public {
        vm.prank(principalKey);
        vault.setApprovalPolicy(mandateId, true, address(0));

        (AgentVault.Intent memory it, bytes memory sig, bytes32 digest) = _intentWithDigest(mandateId, payee, 2 * UNIT, 1, "POST", "/api/data");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PRINCIPAL_PK, digest);
        bytes memory approval = abi.encodePacked(r, s, v);

        vault.settleWithApproval(it, sig, approval, _bind("POST", "/api/data", bytes32(0)), _terms());
        assertEq(credit.balanceOf(payee), 2 * UNIT - (2 * UNIT * 100) / 10000, "payee paid after approval");
    }

    function test_approval_from_wrong_signer_rejected() public {
        vm.prank(principalKey);
        vault.setApprovalPolicy(mandateId, true, address(0));

        (AgentVault.Intent memory it, bytes memory sig, bytes32 digest) = _intentWithDigest(mandateId, payee, 2 * UNIT, 1, "POST", "/api/data");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, digest); // agent cannot self-approve
        bytes memory approval = abi.encodePacked(r, s, v);

        vm.expectRevert(AgentVault.BadSignature.selector);
        vault.settleWithApproval(it, sig, approval, _bind("POST", "/api/data", bytes32(0)), _terms());
    }

    function test_approval_cannot_be_reused_for_another_payment() public {
        vm.prank(principalKey);
        vault.setApprovalPolicy(mandateId, true, address(0));

        (AgentVault.Intent memory it1, bytes memory sig1, bytes32 digest1) = _intentWithDigest(mandateId, payee, 2 * UNIT, 1, "POST", "/api/data");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PRINCIPAL_PK, digest1);
        bytes memory approval = abi.encodePacked(r, s, v);
        vault.settleWithApproval(it1, sig1, approval, _bind("POST", "/api/data", bytes32(0)), _terms());

        // same human approval presented against a DIFFERENT intent must fail
        (AgentVault.Intent memory it2, bytes memory sig2) = _intent(mandateId, payee, 3 * UNIT, 2, "POST", "/api/data");
        vm.expectRevert(AgentVault.BadSignature.selector);
        vault.settleWithApproval(it2, sig2, approval, _bind("POST", "/api/data", bytes32(0)), _terms());
    }

    function test_approval_via_wallet_personal_sign() public {
        vm.prank(principalKey);
        vault.setApprovalPolicy(mandateId, true, address(0));

        (AgentVault.Intent memory it, bytes memory sig, bytes32 digest) = _intentWithDigest(mandateId, payee, 2 * UNIT, 1, "POST", "/api/data");
        // a real wallet signs the EIP-191 wrapped digest, not the raw one
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PRINCIPAL_PK, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)));
        bytes memory approval = abi.encodePacked(r, s, v);

        vault.settleWithApproval(it, sig, approval, _bind("POST", "/api/data", bytes32(0)), _terms());
        assertGt(credit.balanceOf(payee), 0, "wallet-style approval releases funds");
    }

    function test_approval_sig_on_open_mandate_rejected() public {
        (AgentVault.Intent memory it, bytes memory sig, bytes32 digest) = _intentWithDigest(mandateId, payee, 2 * UNIT, 1, "POST", "/api/data");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PRINCIPAL_PK, digest);
        bytes memory approval = abi.encodePacked(r, s, v);

        vm.expectRevert(AgentVault.ApprovalNotRequired.selector);
        vault.settleWithApproval(it, sig, approval, _bind("POST", "/api/data", bytes32(0)), _terms());
    }

    // --------------------------------------------------------------- tests

    function test_happy_path_settles_and_charges_fee() public {
        (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, payee, 2 * UNIT, 1, "POST", "/api/data");
        vm.prank(principalKey);
        vault.settle(it, sig, _bind("POST", "/api/data", bytes32(0)), _terms());

        assertEq(credit.balanceOf(payee), 2 * UNIT - (2 * UNIT * 100) / 10000, "payee net");
        assertEq(credit.balanceOf(feeTo), (2 * UNIT * 100) / 10000, "fee");
        assertEq(vault.remainingBudget(mandateId), 198 * UNIT, "budget");
        assertEq(vault.paymentCount(), 1);
        assertEq(vault.feesCollected(), (2 * UNIT * 100) / 10000);
    }

    function test_reject_over_per_call_cap() public {
        (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, payee, 6 * UNIT, 1, "POST", "/api/data");
        vm.prank(principalKey);
        vm.expectRevert(AgentVault.OverPerCall.selector);
        vault.settle(it, sig, _bind("POST", "/api/data", bytes32(0)), _terms());
    }

    function test_reject_over_daily_budget() public {
        // 10 calls of 5 = 50 hits the daily cap; the 11th must fail
        for (uint256 i = 1; i <= 10; i++) {
            (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, payee, 5 * UNIT, i, "POST", "/api/data");
            vm.prank(principalKey);
            vault.settle(it, sig, _bind("POST", "/api/data", bytes32(0)), _terms());
        }
        (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, payee, 1 * UNIT, 11, "POST", "/api/data");
        vm.prank(principalKey);
        vm.expectRevert(AgentVault.OverDaily.selector);
        vault.settle(it, sig, _bind("POST", "/api/data", bytes32(0)), _terms());
    }

    function test_daily_budget_resets_next_day() public {
        for (uint256 i = 1; i <= 10; i++) {
            (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, payee, 5 * UNIT, i, "POST", "/api/data");
            vm.prank(principalKey);
            vault.settle(it, sig, _bind("POST", "/api/data", bytes32(0)), _terms());
        }
        skip(DAY);
        (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, payee, 5 * UNIT, 11, "POST", "/api/data");
        vm.prank(principalKey);
        vault.settle(it, sig, _bind("POST", "/api/data", bytes32(0)), _terms());
        assertEq(vault.paymentCount(), 11, "day rollover works");
    }

    function test_reject_over_total_budget() public {
        uint256 nonce = 1;
        // 200 USDC total budget: 10 payments of 5 per day (daily cap), 4 days
        for (uint256 day = 0; day < 4; day++) {
            for (uint256 i = 0; i < 10; i++) {
                (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, payee, 5 * UNIT, nonce, "POST", "/api/data");
                vm.prank(principalKey);
                vault.settle(it, sig, _bind("POST", "/api/data", bytes32(0)), _terms());
                nonce++;
            }
            skip(DAY);
        }
        assertEq(vault.remainingBudget(mandateId), 0, "budget exhausted");
        (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, payee, 1 * UNIT, nonce, "POST", "/api/data");
        vm.prank(principalKey);
        vm.expectRevert(AgentVault.OverBudget.selector);
        vault.settle(it, sig, _bind("POST", "/api/data", bytes32(0)), _terms());
    }

    /// @dev THE headline attack: a captured payment proof replayed against a
    ///      different endpoint of the same price must fail.
    function test_replay_same_nonce_rejected() public {
        (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, payee, 2 * UNIT, 7, "POST", "/api/one");
        vm.prank(principalKey);
        vault.settle(it, sig, _bind("POST", "/api/one", bytes32(0)), _terms());

        // exact same signed payload, replayed
        vm.prank(principalKey);
        vm.expectRevert(AgentVault.AlreadyUsed.selector);
        vault.settle(it, sig, _bind("POST", "/api/one", bytes32(0)), _terms());
    }

    function test_floating_authorization_substitution_rejected() public {
        // attacker captures a valid proof for /api/one and tries to spend it on /api/two
        (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, payee, 2 * UNIT, 7, "POST", "/api/one");
        vm.prank(principalKey);
        vault.settle(it, sig, _bind("POST", "/api/one", bytes32(0)), _terms());

        // same nonce+signature, but presented against a different live request
        vm.prank(principalKey);
        vm.expectRevert(AgentVault.RequestMismatch.selector);
        vault.settle(it, sig, _bind("POST", "/api/two", bytes32(0)), _terms());
    }

    function test_attacker_cannot_forge_intent() public {
        bytes32 requestHash = keccak256(abi.encodePacked("POST", "/api/data", bytes32(0), uint256(99)));
        AgentVault.Intent memory it = AgentVault.Intent({
            mandateId: mandateId,
            payee: attackerKey,
            amount: 5 * UNIT,
            validUntil: uint64(block.timestamp + 3600),
            nonce: 99,
            requestHash: requestHash
        });
        bytes32 structHash = keccak256(
            abi.encode(vault.INTENT_TYPEHASH(), mandateId, attackerKey, 5 * UNIT, it.validUntil, 99, requestHash)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTACKER_PK, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(principalKey);
        vm.expectRevert(AgentVault.BadSignature.selector);
        vault.settle(it, sig, _bind("POST", "/api/data", bytes32(0)), _terms());
    }

    function test_revoked_mandate_blocks_spend() public {
        vm.prank(principalKey);
        vault.revokeMandate(mandateId);
        (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, payee, 1 * UNIT, 1, "POST", "/api/data");
        vm.prank(principalKey);
        vm.expectRevert(AgentVault.MandateInactive.selector);
        vault.settle(it, sig, _bind("POST", "/api/data", bytes32(0)), _terms());
    }

    function test_expired_mandate_blocks_spend() public {
        uint64 nowT = uint64(block.timestamp);
        uint256 nonce = 42;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            PRINCIPAL_PK, vault.mandateDigest(principalKey, agentKey, uint64(block.timestamp - 1), nowT + 1 hours, 5 * UNIT, 50 * UNIT, 10 * UNIT, bytes32(0), nonce)
        );
        bytes32 shortId = vault.registerMandate(
            principalKey, agentKey, uint64(block.timestamp - 1), nowT + 1 hours, 5 * UNIT, 50 * UNIT, 10 * UNIT, bytes32(0), nonce, abi.encodePacked(r, s, v)
        );
        skip(2 hours);
        (AgentVault.Intent memory it, bytes memory sig) = _intent(shortId, payee, 1 * UNIT, 1, "POST", "/api/data");
        vm.prank(principalKey);
        vm.expectRevert(AgentVault.MandateWindow.selector);
        vault.settle(it, sig, _bind("POST", "/api/data", bytes32(0)), _terms());
    }

    // --------------------------------------------------------------- streaming

    function test_session_charges_many_times_one_signature() public {
        uint256 sNonce = 1;
        uint64 validUntil = uint64(block.timestamp + 3600);
        bytes32 structHash = keccak256(abi.encode(vault.SESSION_TYPEHASH(), mandateId, payee, 20 * UNIT, validUntil, sNonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash)));
        bytes32 sessionId = vault.openSession(mandateId, payee, 20 * UNIT, validUntil, sNonce, abi.encodePacked(r, s, v));

        // 200 sub-cent charges inside one session
        for (uint256 i = 1; i <= 200; i++) {
            uint64 vu = uint64(block.timestamp + 3600);
            bytes32 ch = keccak256(abi.encode(vault.CHARGE_TYPEHASH(), sessionId, 100_000, i, vu)); // 0.10 each
            (uint8 cv, bytes32 cr, bytes32 cs) = vm.sign(AGENT_PK, keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), ch)));
            vault.charge(sessionId, 100_000, i, vu, abi.encodePacked(cr, cs, cv));
        }
        assertEq(vault.paymentCount(), 200, "200 settled");
        assertEq(credit.balanceOf(payee), 200 * 100_000 - (200 * 100_000 * 100) / 10000, "streamed net");
    }

    function test_session_cannot_exceed_ceiling() public {
        uint256 sNonce = 1;
        uint64 validUntil = uint64(block.timestamp + 3600);
        bytes32 structHash = keccak256(abi.encode(vault.SESSION_TYPEHASH(), mandateId, payee, 1 * UNIT, validUntil, sNonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash)));
        bytes32 sessionId = vault.openSession(mandateId, payee, 1 * UNIT, validUntil, sNonce, abi.encodePacked(r, s, v));

        uint64 vu = uint64(block.timestamp + 3600);
        bytes32 ch = keccak256(abi.encode(vault.CHARGE_TYPEHASH(), sessionId, 2 * UNIT, 1, vu));
        (uint8 cv, bytes32 cr, bytes32 cs) = vm.sign(AGENT_PK, keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), ch)));
        vm.expectRevert(AgentVault.OverSession.selector);
        vault.charge(sessionId, 2 * UNIT, 1, vu, abi.encodePacked(cr, cs, cv));
    }

    // --------------------------------------------------------------- escrow

    function test_escrow_release_with_delivery_receipt() public {
        bytes32 contentHash = keccak256("delivered-payload");
        (AgentVault.Intent memory it, bytes memory sig) = _intentWithContent(mandateId, payee, 3 * UNIT, 1, contentHash);
        vm.prank(principalKey);
        bytes32 paymentId = vault.settle(it, sig, _bind("POST", "/api/report", bytes32(0)), _escrowTerms(1 days));

        assertEq(credit.balanceOf(payee), 0, "held in escrow");
        assertEq(vault.escrowAmount(paymentId), 3 * UNIT - (3 * UNIT * 100) / 10000, "escrowed net");

        // a receipt signed by the wrong key must not release funds
        uint64 deliveredAt = uint64(block.timestamp);
        bytes32 rh = keccak256(abi.encode(vault.RECEIPT_TYPEHASH(), paymentId, contentHash, deliveredAt));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), rh)));
        vm.expectRevert(AgentVault.BadSignature.selector);
        vault.release(paymentId, contentHash, deliveredAt, abi.encodePacked(r, s, v));

        // the payee's own receipt releases it
        (uint8 pv, bytes32 pr, bytes32 ps) = vm.sign(PAYEE_PK, keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), rh)));
        vault.release(paymentId, contentHash, deliveredAt, abi.encodePacked(pr, ps, pv));
        assertEq(credit.balanceOf(payee), 3 * UNIT - (3 * UNIT * 100) / 10000, "released to payee");
        assertEq(vault.escrowAmount(paymentId), 0, "escrow closed");
    }

    function test_escrow_wrong_content_hash_reverts() public {
        bytes32 expected = keccak256("delivered-payload");
        (AgentVault.Intent memory it, bytes memory sig) = _intentWithContent(mandateId, payee, 3 * UNIT, 1, expected);
        vm.prank(principalKey);
        bytes32 paymentId = vault.settle(it, sig, _bind("POST", "/api/report", bytes32(0)), _escrowTermsWith(1 days, expected));

        bytes32 wrong = keccak256("tampered-payload");
        uint64 deliveredAt = uint64(block.timestamp);
        bytes32 rh = keccak256(abi.encode(vault.RECEIPT_TYPEHASH(), paymentId, wrong, deliveredAt));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYEE_PK, keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), rh)));
        vm.expectRevert(AgentVault.ContentMismatch.selector);
        vault.release(paymentId, wrong, deliveredAt, abi.encodePacked(r, s, v));
    }

    function test_escrow_refund_by_principal() public {
        (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, payee, 4 * UNIT, 1, "POST", "/api/report");
        vm.prank(principalKey);
        bytes32 paymentId = vault.settle(it, sig, _bind("POST", "/api/report", bytes32(0)), _escrowTerms(1 days));

        uint256 before = credit.balanceOf(principalKey);
        vm.prank(principalKey);
        vault.refund(paymentId);
        assertEq(credit.balanceOf(principalKey) - before, 4 * UNIT - (4 * UNIT * 100) / 10000, "refunded net");
        assertEq(credit.balanceOf(payee), 0, "payee got nothing");
    }

    function test_escrow_auto_release_after_window() public {
        (AgentVault.Intent memory it, bytes memory sig) = _intent(mandateId, payee, 4 * UNIT, 1, "POST", "/api/report");
        vm.prank(principalKey);
        bytes32 paymentId = vault.settle(it, sig, _bind("POST", "/api/report", bytes32(0)), _escrowTerms(1 days));

        vm.expectRevert(AgentVault.EscrowNotMature.selector);
        vault.releaseExpired(paymentId);

        skip(1 days);
        vault.releaseExpired(paymentId);
        assertEq(credit.balanceOf(payee), 4 * UNIT - (4 * UNIT * 100) / 10000, "released");
    }

    // --------------------------------------------------------------- batch

    function test_batch_settlement_one_tx_many_payments() public {
        // 4 leaves
        address[4] memory payees = [makeAddr("p1"), makeAddr("p2"), makeAddr("p3"), makeAddr("p4")];
        uint128[4] memory amounts = [1 * UNIT, 2 * UNIT, 3 * UNIT, 4 * UNIT];

        bytes32[4] memory leaves;
        for (uint256 i = 0; i < 4; i++) {
            leaves[i] = keccak256(abi.encodePacked(uint32(i), payees[i], amounts[i]));
        }
        // simple 4-leaf tree
        bytes32 h01 = _hashPair(leaves[0], leaves[1]);
        bytes32 h23 = _hashPair(leaves[2], leaves[3]);
        bytes32 root = _hashPair(h01, h23);

        vm.prank(principalKey);
        bytes32 batchId = vault.publishBatch(root, 4, 10 * UNIT);

        // claim leaf 2: proof = [leaf3, h01]
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = leaves[3];
        proof[1] = h01;

        vm.prank(principalKey);
        vault.claimBatch(batchId, 2, payees[2], amounts[2], proof);
        assertEq(credit.balanceOf(payees[2]), 3 * UNIT, "leaf claimed");

        // bad proof must fail
        bytes32[] memory bad = new bytes32[](2);
        bad[0] = leaves[0];
        bad[1] = h23;
        vm.prank(principalKey);
        vm.expectRevert(AgentVault.BadProof.selector);
        vault.claimBatch(batchId, 2, payees[2], amounts[2], bad);
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    // --------------------------------------------------------------- funding

    function test_deposit_and_withdraw_1_to_1() public {
        assertEq(credit.balanceOf(principalKey), 500 * UNIT, "credits minted");
        assertEq(usdc.balanceOf(address(vault)), 500 * UNIT, "usdc custodied");

        vm.prank(principalKey);
        vault.withdraw(200 * UNIT);
        assertEq(credit.balanceOf(principalKey), 300 * UNIT);
        assertEq(usdc.balanceOf(principalKey), 200 * UNIT);
    }

    function test_withdraw_more_than_balance_reverts() public {
        vm.prank(principalKey);
        vm.expectRevert(AgentVault.InsufficientCredit.selector);
        vault.withdraw(501 * UNIT);
    }

    // --------------------------------------------------------------- helpers for content-bound intents

    function _intentWithContent(bytes32 mid, address to_, uint128 amount, uint256 nonce, bytes32 contentHash)
        internal
        view
        returns (AgentVault.Intent memory, bytes memory)
    {
        string memory method = "POST";
        string memory uri = "/api/report";
        bytes32 requestHash = keccak256(abi.encodePacked(method, uri, bytes32(0), nonce));
        AgentVault.Intent memory it = AgentVault.Intent({
            mandateId: mid,
            payee: to_,
            amount: amount,
            validUntil: uint64(block.timestamp + 3600),
            nonce: nonce,
            requestHash: requestHash
        });
        bytes32 structHash = keccak256(abi.encode(vault.INTENT_TYPEHASH(), mid, to_, amount, it.validUntil, nonce, requestHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, digest);
        return (it, abi.encodePacked(r, s, v));
    }
}
