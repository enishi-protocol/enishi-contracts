// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test-only Permit2 (AllowanceTransfer subset). Injected via
///         `hardhat_setCode` at EnishiAddresses.PANCAKE_PERMIT2 so the
///         Vault/SWC Permit2 flow can run against mock routers. Mirrors the
///         real semantics the protocol relies on: expiration check, allowance
///         decrement, and pulling through the owner's ERC-20 approval to
///         Permit2 itself.
contract MockPermit2 {
    struct PackedAllowance {
        uint160 amount;
        uint48 expiration;
    }

    mapping(address owner => mapping(address token => mapping(address spender => PackedAllowance)))
        public allowance;

    error AllowanceExpired(uint256 deadline);
    error InsufficientAllowance(uint256 amount);

    function approve(
        address token,
        address spender,
        uint160 amount,
        uint48 expiration
    ) external {
        allowance[msg.sender][token][spender] = PackedAllowance({
            amount: amount,
            expiration: expiration
        });
    }

    function transferFrom(
        address from,
        address to,
        uint160 amount,
        address token
    ) external {
        PackedAllowance storage allowed = allowance[from][token][msg.sender];
        if (block.timestamp > allowed.expiration)
            revert AllowanceExpired(allowed.expiration);
        if (allowed.amount < amount)
            revert InsufficientAllowance(allowed.amount);
        if (allowed.amount != type(uint160).max) allowed.amount -= amount;
        IERC20(token).transferFrom(from, to, amount);
    }
}
