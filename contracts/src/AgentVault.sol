// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20, AgentCreditToken} from "./AgentCreditToken.sol";

/// @notice Minimal Merkle proof verification for payee allowlists and batch leaves.
library MerkleProof {
    function verify(bytes32 root, bytes32 leaf, bytes32[] memory proof) internal pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h <= p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == root;
    }
}

/// @title AgentVault
/// @notice Settlement and policy layer for AI-agent payments. Solves three
///         problems the base x402 handshake does not:
///
///  1. POLICY ENFORCEMENT. A principal signs a Mandate delegating an agent key
///     under hard on-chain constraints: per-call cap, daily budget, total
///     budget, payee allowlist, expiry. A compromised or hallucinating agent
///     cannot spend past the mandate, because the chain — not the agent's own
///     code — refuses.
///
///  2. REQUEST-BOUND AUTHORIZATION. A base EIP-3009 signature commits to money
///     but not to the resource it buys, so a captured payment proof can be
///     replayed against a different endpoint of the same price ("floating
///     authorization"). Here every PaymentIntent commits to
///     H(method, uri, bodyHash, nonce); the vault recomputes that commitment
///     from the live request and rejects any mismatch, and every nonce is
///     single-use.
///
///  3. GAS AMORTIZATION + DELIVERY PROOF. Payments settle 1:1 in an internal
///     credit ledger (no chain gas per call), with periodic Merkle batch roots
///     for external settlement, and an escrow path that releases only against
///     a signed delivery receipt or a timeout.
contract AgentVault {
    // ------------------------------------------------------------------ EIP-712

    string public constant NAME = "AgentVault";
    string public constant VERSION = "1";

    bytes32 public immutable DOMAIN_SEPARATOR;

    bytes32 public constant MANDATE_TYPEHASH = keccak256(
        "Mandate(address principal,address agent,uint64 validAfter,uint64 validUntil,uint128 perCallMax,uint128 dailyBudget,uint128 totalBudget,bytes32 payeeRoot,uint256 nonce)"
    );
    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "PaymentIntent(bytes32 mandateId,address payee,uint128 amount,uint64 validUntil,uint256 nonce,bytes32 requestHash)"
    );
    bytes32 public constant SESSION_TYPEHASH = keccak256(
        "SpendSession(bytes32 mandateId,address payee,uint128 maxAmount,uint64 validUntil,uint256 nonce)"
    );
    bytes32 public constant CHARGE_TYPEHASH =
        keccak256("SpendClaim(bytes32 sessionId,uint128 amount,uint256 nonce,uint64 validUntil)");
    bytes32 public constant RECEIPT_TYPEHASH =
        keccak256("DeliveryReceipt(bytes32 paymentId,bytes32 contentHash,uint64 deliveredAt)");

    // ------------------------------------------------------------------ types

    struct Mandate {
        address principal;
        address agent;
        uint64 validAfter;
        uint64 validUntil;
        uint128 perCallMax;
        uint128 dailyBudget;
        uint128 totalBudget;
        bytes32 payeeRoot; // bytes32(0) => any payee allowed
        bool active;
        bool requiresApproval; // human must sign the exact intent before settle
        address approver; // who may sign; bytes(0) => the principal
        uint128 spent;
        uint128 daySpent;
        uint64 dayWindow; // unix / 86400
    }

    struct Session {
        bytes32 mandateId;
        address payee;
        uint128 maxAmount;
        uint128 charged;
        uint64 validUntil;
        bool open;
    }

    struct Escrow {
        address principal;
        address payee;
        uint128 amount;
        bytes32 contentHash; // expected delivery, bytes32(0) => any
        uint64 releaseAfter;
        bool live;
    }

    struct Batch {
        bytes32 root;
        uint128 total;
        uint128 claimed;
        uint32 leafCount;
        bool live;
    }

    /// @notice The agent-signed payment intent.
    struct Intent {
        bytes32 mandateId;
        address payee;
        uint128 amount;
        uint64 validUntil;
        uint256 nonce;
        bytes32 requestHash;
    }

    /// @notice The live HTTP request the payment is bound to.
    struct Binding {
        string method;
        string uri;
        bytes32 bodyHash;
    }

    /// @notice How the payment should settle.
    struct Terms {
        bytes32[] payeeProof;
        bytes32 contentHash;
        uint64 releaseAfter; // 0 => pay the payee immediately
    }

    // ------------------------------------------------------------------ storage

    IERC20 public immutable usdc;
    AgentCreditToken public immutable credit;
    address public owner;
    address public pendingOwner;
    address public feeRecipient;

    uint128 public feeBps; // basis points of each settled payment
    bool public paused;

    mapping(bytes32 => Mandate) public mandates;
    mapping(bytes32 => bool) public intentUsed;
    mapping(bytes32 => bool) public sessionNonceUsed;
    mapping(bytes32 => Session) public sessions;
    mapping(bytes32 => Escrow) public escrows;
    mapping(bytes32 => Batch) public batches;

    uint256 public paymentCount;
    uint256 public volumeSettled;
    uint256 public feesCollected;

    // ------------------------------------------------------------------ events

    event Deposited(address indexed principal, uint256 amount);
    event Withdrawn(address indexed principal, uint256 amount);
    event MandateRegistered(bytes32 indexed mandateId, address indexed principal, address indexed agent, uint128 totalBudget, uint64 validUntil);
    event MandateRevoked(bytes32 indexed mandateId);
    event ApprovalPolicySet(bytes32 indexed mandateId, bool required, address approver);
    event PaymentApproved(bytes32 indexed mandateId, address indexed approver);
    event PaymentSettled(bytes32 indexed paymentId, bytes32 indexed mandateId, address indexed principal, address agent, address payee, uint128 amount, uint128 fee, bool escrowed);
    event SessionOpened(bytes32 indexed sessionId, bytes32 indexed mandateId, address payee, uint128 maxAmount);
    event SessionCharged(bytes32 indexed sessionId, uint128 amount, uint128 totalCharged);
    event SessionEnded(bytes32 indexed sessionId);
    event EscrowReleased(bytes32 indexed paymentId, bytes32 indexed contentHash);
    event EscrowRefunded(bytes32 indexed paymentId, uint128 amount);
    event BatchPublished(bytes32 indexed batchId, bytes32 root, uint32 leafCount, uint128 total);
    event BatchClaimed(bytes32 indexed batchId, uint32 leafIndex, address indexed payee, uint128 amount);
    event FeeUpdated(uint128 feeBps);
    event PauseChanged(bool paused);

    // ------------------------------------------------------------------ errors

    error NotOwner();
    error ApprovalRequired();
    error ApprovalNotRequired();
    error Paused();
    error ZeroAddress();
    error BadSignature();
    error MandateInactive();
    error MandateWindow();
    error OverPerCall();
    error OverDaily();
    error OverBudget();
    error PayeeNotAllowed();
    error AlreadyUsed();
    error RequestMismatch();
    error IntentExpired();
    error InsufficientCredit();
    error SessionClosed();
    error SessionExpired();
    error OverSession();
    error EscrowNotLive();
    error EscrowNotMature();
    error ContentMismatch();
    error BatchNotLive();
    error BadProof();
    error BadAmount();

    modifier notPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev The vault deploys and permanently owns its settlement token, so the
    ///      credit ledger can never be minted by anyone else.
    constructor(IERC20 usdc_, address feeRecipient_, uint128 feeBps_) {
        if (address(usdc_) == address(0)) revert ZeroAddress();
        usdc = usdc_;
        credit = new AgentCreditToken();
        feeRecipient = feeRecipient_ == address(0) ? msg.sender : feeRecipient_;
        feeBps = feeBps_ > 1000 ? 1000 : feeBps_;
        owner = msg.sender;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(NAME)),
                keccak256(bytes(VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    // ------------------------------------------------------------------ ERC-20 safety

    /// @dev USDC returns bool; some ERC-20s return nothing. Handle both.
    function _safeTransfer(IERC20 t, address to, uint256 v) private {
        (bool ok, bytes memory data) = address(t).call(abi.encodeCall(IERC20.transfer, (to, v)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert BadAmount();
    }

    function _safeTransferFrom(IERC20 t, address from, address to, uint256 v) private {
        (bool ok, bytes memory data) = address(t).call(abi.encodeCall(IERC20.transferFrom, (from, to, v)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert BadAmount();
    }

    // ------------------------------------------------------------------ admin

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    function setFee(uint128 newFeeBps) external onlyOwner {
        feeBps = newFeeBps > 1000 ? 1000 : newFeeBps;
        emit FeeUpdated(feeBps);
    }

    function setFeeRecipient(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        feeRecipient = to;
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PauseChanged(p);
    }

    // ------------------------------------------------------------------ funding

    /// @notice Move USDC into the vault and mint 1:1 settlement credits.
    function deposit(uint256 amount) external notPaused {
        if (amount == 0) revert BadAmount();
        _safeTransferFrom(usdc, msg.sender, address(this), amount);
        credit.mint(msg.sender, amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Burn credits and pull USDC back out.
    function withdraw(uint256 amount) external {
        if (amount == 0) revert BadAmount();
        if (credit.balanceOf(msg.sender) < amount) revert InsufficientCredit();
        credit.burn(msg.sender, amount);
        _safeTransfer(usdc, msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------ mandates

    function _mandateDigest(
        address principal,
        address agent,
        uint64 validAfter,
        uint64 validUntil,
        uint128 perCallMax,
        uint128 dailyBudget,
        uint128 totalBudget,
        bytes32 payeeRoot,
        uint256 nonce
    ) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                MANDATE_TYPEHASH,
                principal,
                agent,
                validAfter,
                validUntil,
                perCallMax,
                dailyBudget,
                totalBudget,
                payeeRoot,
                nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function mandateStructHash(
        address principal,
        address agent,
        uint64 validAfter,
        uint64 validUntil,
        uint128 perCallMax,
        uint128 dailyBudget,
        uint128 totalBudget,
        bytes32 payeeRoot,
        uint256 nonce
    ) external pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MANDATE_TYPEHASH,
                principal,
                agent,
                validAfter,
                validUntil,
                perCallMax,
                dailyBudget,
                totalBudget,
                payeeRoot,
                nonce
            )
        );
    }

    function mandateDigest(
        address principal,
        address agent,
        uint64 validAfter,
        uint64 validUntil,
        uint128 perCallMax,
        uint128 dailyBudget,
        uint128 totalBudget,
        bytes32 payeeRoot,
        uint256 nonce
    ) external view returns (bytes32) {
        return _mandateDigest(principal, agent, validAfter, validUntil, perCallMax, dailyBudget, totalBudget, payeeRoot, nonce);
    }

    /// @notice Register a principal-signed mandate. The principal must already
    ///         hold credits covering the full budget.
    function registerMandate(
        address principal,
        address agent,
        uint64 validAfter,
        uint64 validUntil,
        uint128 perCallMax,
        uint128 dailyBudget,
        uint128 totalBudget,
        bytes32 payeeRoot,
        uint256 nonce,
        bytes calldata sig
    ) external notPaused returns (bytes32 id) {
        if (validUntil <= validAfter) revert MandateWindow();
        if (totalBudget == 0) revert BadAmount();
        if (perCallMax == 0 || perCallMax > totalBudget) revert OverPerCall();
        if (dailyBudget == 0) dailyBudget = totalBudget;

        id = _mandateDigest(principal, agent, validAfter, validUntil, perCallMax, dailyBudget, totalBudget, payeeRoot, nonce);
        if (mandates[id].active) revert AlreadyUsed();
        if (!_recoverMandate(id, sig, principal)) revert BadSignature();
        if (credit.balanceOf(principal) < totalBudget) revert InsufficientCredit();

        Mandate storage s = mandates[id];
        s.principal = principal;
        s.agent = agent;
        s.validAfter = validAfter;
        s.validUntil = validUntil;
        s.perCallMax = perCallMax;
        s.dailyBudget = dailyBudget;
        s.totalBudget = totalBudget;
        s.payeeRoot = payeeRoot;
        s.active = true;

        emit MandateRegistered(id, principal, agent, totalBudget, validUntil);
    }

    function revokeMandate(bytes32 id) external {
        Mandate storage m = mandates[id];
        if (!m.active) revert MandateInactive();
        if (msg.sender != m.principal && msg.sender != owner) revert NotOwner();
        m.active = false;
        emit MandateRevoked(id);
    }

    /// @notice Human-in-the-loop policy: when required, every settlement on this
    ///         mandate must carry a second signature from `approver` over the
    ///         exact same PaymentIntent the agent signed. The agent cannot
    ///         produce it; the human sees payee/amount/request before signing.
    function setApprovalPolicy(bytes32 mandateId, bool required, address approver) external {
        Mandate storage m = mandates[mandateId];
        if (!m.active) revert MandateInactive();
        if (msg.sender != m.principal && msg.sender != owner) revert NotOwner();
        m.requiresApproval = required;
        m.approver = approver == address(0) ? m.principal : approver;
        emit ApprovalPolicySet(mandateId, required, m.approver);
    }

    // ------------------------------------------------------------------ settlement core

    /// @dev Shared policy + signature + replay checks. Returns the mandate id.
    function _authorize(Intent calldata intent, bytes calldata sig, Binding calldata binding, bytes memory approvalSig)
        private
        returns (bytes32)
    {
        Mandate storage m = mandates[intent.mandateId];
        if (!m.active) revert MandateInactive();

        uint64 nowT = uint64(block.timestamp);
        if (nowT < m.validAfter || nowT > m.validUntil) revert MandateWindow();
        if (nowT > intent.validUntil) revert IntentExpired();
        if (intent.amount == 0) revert BadAmount();
        if (intent.amount > m.perCallMax) revert OverPerCall();

        // request binding: recompute the commitment from the live request
        if (intent.requestHash != keccak256(abi.encodePacked(binding.method, binding.uri, binding.bodyHash, intent.nonce))) {
            revert RequestMismatch();
        }

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(
                    abi.encode(
                        INTENT_TYPEHASH,
                        intent.mandateId,
                        intent.payee,
                        intent.amount,
                        intent.validUntil,
                        intent.nonce,
                        intent.requestHash
                    )
                )
            )
        );
        if (_recover(digest, sig) != m.agent) revert BadSignature();

        // human-in-the-loop: the approver signs the SAME intent digest, so the
        // approval is bound to this exact payee/amount/request and cannot be
        // reused for any other payment.
        if (m.requiresApproval) {
            if (approvalSig.length == 0) revert ApprovalRequired();
            // accept raw EIP-712 sigs AND wallet personal_sign sigs (MetaMask/Ledger)
            if (!(_recoverM(digest, approvalSig) == m.approver || _recoverPersonalM(digest, approvalSig) == m.approver))
                revert BadSignature();
            emit PaymentApproved(intent.mandateId, m.approver);
        } else if (approvalSig.length != 0) {
            revert ApprovalNotRequired();
        }

        bytes32 replayKey = keccak256(abi.encodePacked(intent.mandateId, intent.nonce));
        if (intentUsed[replayKey]) revert AlreadyUsed();
        intentUsed[replayKey] = true;

        return intent.mandateId;
    }

    /// @dev Budget accounting + value movement. Returns (fee, net).
    function _debit(bytes32 mandateId, uint128 amount) private returns (uint128 fee, uint128 net) {
        Mandate storage m = mandates[mandateId];

        uint64 day = uint64(block.timestamp / 86400);
        if (day != m.dayWindow) {
            m.dayWindow = day;
            m.daySpent = 0;
        }
        if (m.daySpent + amount > m.dailyBudget) revert OverDaily();
        if (m.spent + amount > m.totalBudget) revert OverBudget();
        if (credit.balanceOf(m.principal) < amount) revert InsufficientCredit();

        m.spent += amount;
        m.daySpent += amount;
        volumeSettled += amount;
        paymentCount += 1;

        fee = uint128((uint256(amount) * feeBps) / 10000);
        net = amount - fee;

        // The vault is the token issuer, so settlement is issuer-side
        // burn/mint rather than an ERC-20 transfer: same conservation, less gas.
        credit.burn(m.principal, amount);
    }

    function _payeeAllowed(bytes32 root, address payee, bytes32[] memory proof) private pure returns (bool) {
        if (root == bytes32(0)) return true;
        return MerkleProof.verify(root, keccak256(abi.encodePacked(payee)), proof);
    }

    /// @notice Settle one exact-amount payment against a mandate.
    function settle(Intent calldata intent, bytes calldata sig, Binding calldata binding, Terms calldata terms)
        external
        notPaused
        returns (bytes32 paymentId)
    {
        return _settle(intent, sig, binding, terms, hex"");
    }

    /// @notice Settle a payment on a mandate whose policy requires a human
    ///         approval signature over the exact intent (see setApprovalPolicy).
    function settleWithApproval(Intent calldata intent, bytes calldata sig, bytes calldata approvalSig, Binding calldata binding, Terms calldata terms)
        external
        notPaused
        returns (bytes32 paymentId)
    {
        return _settle(intent, sig, binding, terms, approvalSig);
    }

    function _settle(Intent calldata intent, bytes calldata sig, Binding calldata binding, Terms calldata terms, bytes memory approvalSig)
        private
        returns (bytes32 paymentId)
    {
        bytes32 mandateId = _authorize(intent, sig, binding, approvalSig);
        Mandate storage m = mandates[mandateId];
        if (!_payeeAllowed(m.payeeRoot, intent.payee, terms.payeeProof)) revert PayeeNotAllowed();

        (uint128 fee, uint128 net) = _debit(mandateId, intent.amount);

        paymentId = keccak256(abi.encodePacked(mandateId, intent.nonce, intent.payee, intent.amount));

        if (fee > 0) {
            credit.mint(feeRecipient, fee);
            feesCollected += fee;
        }

        if (terms.releaseAfter == 0) {
            credit.mint(intent.payee, net);
        } else {
            escrows[paymentId] = Escrow({
                principal: m.principal,
                payee: intent.payee,
                amount: net,
                contentHash: terms.contentHash,
                releaseAfter: uint64(block.timestamp) + terms.releaseAfter,
                live: true
            });
        }

        emit PaymentSettled(paymentId, mandateId, m.principal, m.agent, intent.payee, intent.amount, fee, terms.releaseAfter != 0);
    }

    // ------------------------------------------------------------------ streaming (upto)

    /// @notice Open a spend session: the agent pre-authorizes a ceiling and the
    ///         payee deducts as it serves. One signature, many charges — this is
    ///         what makes sub-cent calls economic.
    function openSession(
        bytes32 mandateId,
        address payee,
        uint128 maxAmount,
        uint64 validUntil,
        uint256 nonce,
        bytes calldata sig
    ) external notPaused returns (bytes32 sessionId) {
        Mandate storage m = mandates[mandateId];
        if (!m.active) revert MandateInactive();
        if (maxAmount == 0 || m.spent + maxAmount > m.totalBudget) revert OverBudget();
        if (uint64(block.timestamp) > validUntil) revert SessionExpired();

        bytes32 replayKey = keccak256(abi.encodePacked("session", mandateId, nonce));
        if (sessionNonceUsed[replayKey]) revert AlreadyUsed();
        sessionNonceUsed[replayKey] = true;

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(abi.encode(SESSION_TYPEHASH, mandateId, payee, maxAmount, validUntil, nonce))
            )
        );
        if (_recover(digest, sig) != m.agent) revert BadSignature();

        sessionId = keccak256(abi.encodePacked("session", mandateId, nonce, payee));
        sessions[sessionId] =
            Session({mandateId: mandateId, payee: payee, maxAmount: maxAmount, charged: 0, validUntil: validUntil, open: true});
        emit SessionOpened(sessionId, mandateId, payee, maxAmount);
    }

    /// @notice Payee-initiated deduction inside an open session.
    function charge(bytes32 sessionId, uint128 amount, uint256 nonce, uint64 validUntil, bytes calldata sig)
        external
        notPaused
    {
        Session storage s = sessions[sessionId];
        if (!s.open) revert SessionClosed();
        uint64 nowT = uint64(block.timestamp);
        if (nowT > s.validUntil || nowT > validUntil) revert SessionExpired();
        if (amount == 0) revert BadAmount();
        if (s.charged + amount > s.maxAmount) revert OverSession();

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(abi.encode(CHARGE_TYPEHASH, sessionId, amount, nonce, validUntil))
            )
        );
        Mandate storage m = mandates[s.mandateId];
        if (_recover(digest, sig) != m.agent) revert BadSignature();

        s.charged += amount;
        (uint128 fee, uint128 net) = _debit(s.mandateId, amount);
        if (fee > 0) {
            credit.mint(feeRecipient, fee);
            feesCollected += fee;
        }
        credit.mint(s.payee, net);

        emit SessionCharged(sessionId, amount, s.charged);
        emit PaymentSettled(
            keccak256(abi.encodePacked(sessionId, nonce)), s.mandateId, m.principal, m.agent, s.payee, amount, fee, false
        );
    }

    function closeSession(bytes32 sessionId) external {
        Session storage s = sessions[sessionId];
        if (!s.open) revert SessionClosed();
        if (msg.sender != mandates[s.mandateId].principal && msg.sender != s.payee && msg.sender != owner) revert NotOwner();
        s.open = false;
        emit SessionEnded(sessionId);
    }

    // ------------------------------------------------------------------ escrow / delivery proof

    /// @notice Payee claims escrow by presenting a delivery receipt it signed.
    function release(bytes32 paymentId, bytes32 contentHash, uint64 deliveredAt, bytes calldata sig) external notPaused {
        Escrow storage e = escrows[paymentId];
        if (!e.live) revert EscrowNotLive();
        if (e.contentHash != bytes32(0) && e.contentHash != contentHash) revert ContentMismatch();

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(abi.encode(RECEIPT_TYPEHASH, paymentId, contentHash, deliveredAt))
            )
        );
        if (_recover(digest, sig) != e.payee) revert BadSignature();

        e.live = false;
        credit.mint(e.payee, e.amount);
        emit EscrowReleased(paymentId, contentHash);
    }

    /// @notice Auto-release once the delivery window lapses with no dispute.
    function releaseExpired(bytes32 paymentId) external notPaused {
        Escrow storage e = escrows[paymentId];
        if (!e.live) revert EscrowNotLive();
        if (block.timestamp < e.releaseAfter) revert EscrowNotMature();
        e.live = false;
        credit.mint(e.payee, e.amount);
        emit EscrowReleased(paymentId, bytes32(0));
    }

    /// @notice Principal refunds an escrowed payment before it matures.
    function refund(bytes32 paymentId) external notPaused {
        Escrow storage e = escrows[paymentId];
        if (!e.live) revert EscrowNotLive();
        if (msg.sender != e.principal && msg.sender != owner) revert NotOwner();
        e.live = false;
        credit.mint(e.principal, e.amount);
        emit EscrowRefunded(paymentId, e.amount);
    }

    // ------------------------------------------------------------------ batch settlement

    /// @notice Publish a Merkle root of off-chain payment leaves and lock the
    ///         total. One chain transaction covers N agent payments; payees
    ///         claim with a proof.
    function publishBatch(bytes32 root, uint32 leafCount, uint128 total) external notPaused returns (bytes32 batchId) {
        if (root == bytes32(0) || leafCount == 0 || total == 0) revert BadAmount();
        if (credit.balanceOf(msg.sender) < total) revert InsufficientCredit();
        batchId = keccak256(abi.encodePacked(root, leafCount, total, block.timestamp));
        batches[batchId] = Batch({root: root, total: total, claimed: 0, leafCount: leafCount, live: true});
        credit.burn(msg.sender, total);
        emit BatchPublished(batchId, root, leafCount, total);
    }

    function claimBatch(bytes32 batchId, uint32 leafIndex, address payee, uint128 amount, bytes32[] calldata proof)
        external
        notPaused
    {
        Batch storage b = batches[batchId];
        if (!b.live) revert BatchNotLive();
        if (amount == 0) revert BadAmount();
        bytes32 leaf = keccak256(abi.encodePacked(leafIndex, payee, amount));
        if (!MerkleProof.verify(b.root, leaf, proof)) revert BadProof();
        if (b.claimed + amount > b.total) revert OverBudget();
        b.claimed += amount;
        if (b.claimed == b.total) b.live = false;
        credit.mint(payee, amount);
        emit BatchClaimed(batchId, leafIndex, payee, amount);
    }

    // ------------------------------------------------------------------ views

    function remainingBudget(bytes32 id) external view returns (uint128) {
        Mandate storage m = mandates[id];
        return m.active ? m.totalBudget - m.spent : 0;
    }

    function escrowAmount(bytes32 paymentId) external view returns (uint128) {
        Escrow storage e = escrows[paymentId];
        return e.live ? e.amount : 0;
    }

    // ------------------------------------------------------------------ internal

    /// @dev resolves the mandate signer under either signature convention: an
    ///      EIP-712-style raw-digest signature (smart-contract wallets,
    ///      `vm.sign`) or an EIP-191 personal-message signature (MetaMask /
    ///      Ledger / viem signMessage). Both encodings are only ever *compared*
    ///      to the mandate principal, so accepting both cannot widen the
    ///      authorisation set: a signature is valid iff it recovers to
    ///      `expected` under one of the two digests. Note the fallback must be
    ///      keyed on the expected signer, not on a zero return: ecrecover over
    ///      the wrong digest yields an arbitrary non-zero address.
    function _recoverMandate(bytes32 digest, bytes calldata sig, address expected) private pure returns (bool) {
        if (sig.length != 65) revert BadSignature();
        return _recoverAt(digest, sig) == expected || _recoverPersonal(digest, sig) == expected;
    }

    /// @dev recovers over a raw 32-byte digest. Correct for EIP-712 payloads,
    ///      whose signature is defined over the 0x1901 digest with no further
    ///      wrapping (PaymentIntent, DeliveryReceipt).
    /// @dev ecrecover over a memory signature (used for human approval sigs).
    function _recoverM(bytes32 digest, bytes memory sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            let p := add(sig, 32)
            r := mload(p)
            s := mload(add(p, 32))
            v := byte(0, mload(add(p, 64)))
        }
        if (sig.length != 65 || v < 27) return address(0);
        return ecrecover(digest, v, r, s);
    }

    /// @dev EIP-191 personal-message recovery over a memory signature.
    function _recoverPersonalM(bytes32 digest, bytes memory sig) private pure returns (address) {
        bytes32 wrapped = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        return _recoverM(wrapped, sig);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        return _recoverAt(digest, sig);
    }

    /// @dev recovers over the EIP-191 personal-message wrapper of a digest.
    ///      Required wherever a plain wallet signs the mandate id with
    ///      `personal_sign` (MetaMask, Ledger, viem signMessage): those wallets
    ///      always prepend "\x19Ethereum Signed Message:\n32", so recovering the
    ///      unwrapped digest would reject every real-world mandate signature.
    function _recoverPersonal(bytes32 digest, bytes calldata sig) private pure returns (address) {
        return _recoverAt(keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)), sig);
    }

    function _recoverAt(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        return ecrecover(digest, v, r, s);
    }
}
