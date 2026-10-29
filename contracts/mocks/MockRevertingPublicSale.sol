// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice Test-only Public Sale that is correctly bound to any router but
 *         reverts on every status read and pull, to prove the stake router
 *         degrades to the ENC lock instead of blocking the Vault.
 */
contract MockRevertingPublicSale {
    error SaleDown();

    address public immutable commissionRecipient;

    constructor(address recipient_) {
        commissionRecipient = recipient_;
    }

    /// @dev Bound to every caller, so only {commissionStatus} decides.
    function stakeRouter() external view returns (address) {
        return msg.sender;
    }

    function commissionStatus(address) external pure returns (bool, uint256) {
        revert SaleDown();
    }

    function collectCommission(address, uint256) external pure returns (uint256) {
        revert SaleDown();
    }
}
