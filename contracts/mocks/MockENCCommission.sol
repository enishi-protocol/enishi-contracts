// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice Test-only ENC Commission stub.
 */
contract MockENCCommission {
    address public lastUser;
    uint256 public lastAmount;
    uint256 public totalDistributed;

    event Distributed(address indexed user, uint256 amount);

    function distribute(address user, uint256 amount) external {
        lastUser = user;
        lastAmount = amount;
        totalDistributed += amount;
        emit Distributed(user, amount);
    }
}
