// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title AgentCreditToken (ACT)
/// @notice A 1:1 USDC-backed payment token used as the settlement instrument for
///         agent payments. Deposits of USDC mint ACT; redemptions burn ACT and
///         return USDC. Because ACT moves inside the vault, a per-call agent
///         payment costs no chain gas until a batch is settled.
/// @dev Minimal, dependency-free ERC-20. 6 decimals to match USDC exactly.
interface IERC20 {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract AgentCreditToken is IERC20 {
    string public constant name = "Agent Credit";
    string public constant symbol = "ACT";
    uint8 public constant decimals = 6;

    uint256 private _totalSupply;
    mapping(address => uint256) private _balance;
    mapping(address => mapping(address => uint256)) private _allowance;

    address public immutable issuer;

    error NotIssuer();

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    constructor() {
        issuer = msg.sender;
    }

    function totalSupply() external view override returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view override returns (uint256) {
        return _balance[account];
    }

    function allowance(address owner, address spender) external view override returns (uint256) {
        return _allowance[owner][spender];
    }

    function approve(address spender, uint256 value) external override returns (bool) {
        _approve(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external override returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external override returns (bool) {
        uint256 allowed = _allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            _allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    error InsufficientAllowance();
    error InsufficientBalance();
    error ZeroAddress();

    function mint(address to, uint256 value) external onlyIssuer {
        if (to == address(0)) revert ZeroAddress();
        _totalSupply += value;
        _balance[to] += value;
        emit Transfer(address(0), to, value);
    }

    function burn(address from, uint256 value) external onlyIssuer {
        if (_balance[from] < value) revert InsufficientBalance();
        _balance[from] -= value;
        _totalSupply -= value;
        emit Transfer(from, address(0), value);
    }

    function _approve(address owner, address spender, uint256 value) private {
        if (owner == address(0) || spender == address(0)) revert ZeroAddress();
        _allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function _transfer(address from, address to, uint256 value) private {
        if (to == address(0)) revert ZeroAddress();
        if (_balance[from] < value) revert InsufficientBalance();
        unchecked {
            _balance[from] -= value;
            _balance[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
