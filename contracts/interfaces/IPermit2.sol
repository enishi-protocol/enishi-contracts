// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  IPermit2
 * @notice Minimal surface of Uniswap Permit2 (AllowanceTransfer) used to grant
 *         the PancakeSwap Universal Router a one-block allowance before each
 *         swap. The Universal Router pulls `tokenIn` exclusively through
 *         Permit2 — direct ERC-20 approvals to the router are ignored.
 */
interface IPermit2 {
    /**
     * @notice Set the allowance of `spender` over the caller's `token`.
     * @param  token      ERC-20 being approved.
     * @param  spender    Address allowed to pull `token` (the Universal Router).
     * @param  amount     Maximum amount `spender` may transfer.
     * @param  expiration Timestamp after which the allowance is void.
     */
    function approve(
        address token,
        address spender,
        uint160 amount,
        uint48 expiration
    ) external;

    /**
     * @notice Transfer `amount` of `token` from `from` to `to`, consuming the
     *         caller's Permit2 allowance.
     */
    function transferFrom(
        address from,
        address to,
        uint160 amount,
        address token
    ) external;
}
