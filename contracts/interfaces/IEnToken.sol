// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal mint/burn surface the Vault uses on Enishi receipt tokens.
interface IEnToken {
    function mint(address to, uint256 amount) external;
    function burnFromUser(address from, uint256 amount) external;
}
