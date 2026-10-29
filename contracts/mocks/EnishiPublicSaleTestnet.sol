// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../EnishiPublicSale.sol";

/**
 * @title EnishiPublicSaleTestnet
 * @notice Testnet-only twin of {EnishiPublicSale}. Identical behavior, with
 *         one addition: an {OPERATOR_ROLE} holder may shift the clock the
 *         contract uses for lock/vesting math, so testers can fast-forward
 *         past the 730-day lock and the 12 monthly tranches without waiting
 *         out real time.
 *
 * @dev NEVER deploy this to mainnet. `warpBy`/`warpTo` let {OPERATOR_ROLE}
 *      bypass the entire lock schedule at will — that is the point for
 *      testnet QA, and a severe vulnerability anywhere real money is at
 *      stake. Production sales must use {EnishiPublicSale}, whose `_now()`
 *      is plain `block.timestamp` and cannot be shifted.
 */
contract EnishiPublicSaleTestnet is EnishiPublicSale {
    // ─── Events ───────────────────────────────────────────────────────────────

    event ClockWarped(int256 oldOffset, int256 newOffset);

    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice Seconds added to `block.timestamp` for every lock/vesting read.
    int256 public timeOffset;

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(
        address usdt_,
        address treasury_
    ) EnishiPublicSale(usdt_, treasury_) {}

    // ─── External: admin ──────────────────────────────────────────────────────

    /// @notice Jump the clock forward (or back) by `deltaSeconds`.
    /// @param  deltaSeconds Seconds to add to the current offset; negative rewinds.
    function warpBy(int256 deltaSeconds) external onlyRole(OPERATOR_ROLE) {
        int256 oldOffset = timeOffset;
        int256 newOffset = oldOffset + deltaSeconds;
        timeOffset = newOffset;

        emit ClockWarped(oldOffset, newOffset);
    }

    /// @notice Set the clock to a specific timestamp.
    /// @param  timestamp Target timestamp; must be reachable from `block.timestamp`.
    function warpTo(uint256 timestamp) external onlyRole(OPERATOR_ROLE) {
        int256 oldOffset = timeOffset;
        int256 newOffset = int256(timestamp) - int256(block.timestamp);
        timeOffset = newOffset;

        emit ClockWarped(oldOffset, newOffset);
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @dev `block.timestamp` shifted by the operator-controlled offset.
    function _now() internal view override returns (uint256) {
        return uint256(int256(block.timestamp) + timeOffset);
    }
}
