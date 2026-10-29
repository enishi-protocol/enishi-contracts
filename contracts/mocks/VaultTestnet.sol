// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../Vault.sol";

/**
 * @title VaultTestnet
 * @notice Testnet-only twin of {Vault}. Identical behavior, with two additions
 *         so testers can complete an exit without waiting out the real 48 hours:
 *         the owner may shift the clock the contract uses for the exit delay,
 *         and may change the exit delay itself.
 *
 * @dev NEVER deploy this to mainnet. `warpBy`/`warpTo`/`setExitDelay` let the
 *      owner bypass the exit delay at will — that is the point for testnet QA,
 *      and a severe vulnerability anywhere real money is at stake. Production
 *      must use {Vault}, whose `_now()` is plain `block.timestamp` and whose
 *      exit delay is the fixed {EnishiConstants.EXIT_DELAY}.
 */
contract VaultTestnet is Vault {
    // ─── Events ───────────────────────────────────────────────────────────────

    event ClockWarped(int256 oldOffset, int256 newOffset);
    event ExitDelayUpdated(uint256 oldDelay, uint256 newDelay);

    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice Seconds added to `block.timestamp` for every exit-delay read.
    int256 public timeOffset;

    /// @notice Wait between requestExit and executeExit. Starts at
    ///         {EnishiConstants.EXIT_DELAY}; read at execute time, so a change
    ///         also applies to exits already pending.
    uint256 public exitDelay = EnishiConstants.EXIT_DELAY;

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(
        IWhiteList whitelist_,
        ISwapContractFactory factory_,
        IReferralRegistry referral_,
        IENCCommission encCommission_,
        IENCStakeRouter stakeRouter_,
        IENC enc_,
        address fundWallet_
    ) Vault(whitelist_, factory_, referral_, encCommission_, stakeRouter_, enc_, fundWallet_) {}

    // ─── External: admin ──────────────────────────────────────────────────────

    /// @notice Jump the clock forward (or back) by `deltaSeconds`.
    /// @param  deltaSeconds Seconds to add to the current offset; negative rewinds.
    function warpBy(int256 deltaSeconds) external onlyOwner {
        int256 oldOffset = timeOffset;
        int256 newOffset = oldOffset + deltaSeconds;
        timeOffset = newOffset;

        emit ClockWarped(oldOffset, newOffset);
    }

    /// @notice Set the clock to a specific timestamp.
    /// @param  timestamp Target timestamp; must be reachable from `block.timestamp`.
    function warpTo(uint256 timestamp) external onlyOwner {
        int256 oldOffset = timeOffset;
        int256 newOffset = int256(timestamp) - int256(block.timestamp);
        timeOffset = newOffset;

        emit ClockWarped(oldOffset, newOffset);
    }

    /// @notice Change the exit delay (0 lets an exit complete in the same block).
    /// @param  newDelay New wait in seconds between requestExit and executeExit.
    function setExitDelay(uint256 newDelay) external onlyOwner {
        emit ExitDelayUpdated(exitDelay, newDelay);
        exitDelay = newDelay;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @dev `block.timestamp` shifted by the owner-controlled offset.
    function _now() internal view override returns (uint256) {
        return uint256(int256(block.timestamp) + timeOffset);
    }

    /// @dev Owner-configurable exit delay (see {setExitDelay}).
    function _exitDelay() internal view override returns (uint256) {
        return exitDelay;
    }
}
