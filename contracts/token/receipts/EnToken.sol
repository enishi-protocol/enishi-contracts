// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title  EnToken
 * @notice Abstract base for Enishi receipt tokens (enBTC, enETH, ...).
 *         Roles:
 *           - owner    (deployer): rotates {operator}, pauses, transfers
 *                                  ownership.
 *           - operator (Vault):    the only address allowed to {mint} and
 *                                  {burnFromUser}. Holders cannot burn their
 *                                  own balance; they may only transfer.
 */
abstract contract EnToken is ERC20, ERC20Permit, Ownable, Pausable {
    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice The single operator (Vault Contract) allowed to mint/burn.
    address public operator;

    bool public transfersEnabled = true;

    // ─── Events ───────────────────────────────────────────────────────────────

    event OperatorChanged(address indexed oldOperator, address indexed newOperator);
    event TransfersEnabledChanged(bool oldEnabled, bool newEnabled);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error NotOperator(address caller);
    error ZeroAddress();

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) ERC20Permit(name_) Ownable(msg.sender) {}

    // ─── External ─────────────────────────────────────────────────────────────

    /// @notice Set or rotate the operator. Owner-only.
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        address old = operator;
        operator = newOperator;
        emit OperatorChanged(old, newOperator);
    }

    function mint(address to, uint256 amount) external onlyOperator {
        _mint(to, amount);
    }

    function burnFromUser(address from, uint256 amount) external onlyOperator {
        _burn(from, amount);
    }

    function setTransfersEnabled(bool enabled) external onlyOwner {
        bool old = transfersEnabled;
        transfersEnabled = enabled;
        emit TransfersEnabledChanged(old, enabled);
    }

    /// @notice Pause transfers, mint, and burn. Owner-only.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume transfers after a pause.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override whenNotPaused {
        if (!transfersEnabled && msg.sender != operator) {
            revert NotOperator(msg.sender);
        }
        super._update(from, to, value);
    }
}
