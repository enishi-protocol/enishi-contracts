// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../token/ENCVesting.sol";

/**
 * @title ENCVestingTestnet
 * @notice Testnet-only twin of {ENCVesting}. Identical behavior, with one
 *         addition: an {OPERATOR_ROLE} holder may shift the clock the contract
 *         uses for the PUBLIC schedule, so testers can fast-forward past the
 *         365-day cliff and the 60 monthly releases without waiting out real time.
 *
 * @dev NEVER deploy this to mainnet. `warpBy`/`warpTo` let {OPERATOR_ROLE} bypass
 *      the entire PUBLIC schedule at will — that is the point for testnet QA,
 *      and a severe vulnerability anywhere real money is at stake. Production
 *      must use {ENCVesting}, whose `_now()` is plain `block.timestamp` and
 *      cannot be shifted. Burn-based rounds (SEED/PRIVATE/TEAM/TREASURY) are not
 *      time-based and are unaffected.
 */
contract ENCVestingTestnet is ENCVesting {
    // ─── Events ───────────────────────────────────────────────────────────────

    event ClockWarped(int256 oldOffset, int256 newOffset);

    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice Seconds added to `block.timestamp` for every schedule read.
    int256 public timeOffset;

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(
        uint256 initialSupply_,
        address teamBeneficiary_,
        address treasuryBeneficiary_,
        address publicBeneficiary_,
        address referralRegistry_
    )
        ENCVesting(
            initialSupply_,
            teamBeneficiary_,
            treasuryBeneficiary_,
            publicBeneficiary_,
            referralRegistry_
        )
    {}

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
