// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IENCLock.sol";
import "./IEnishiPublicSale.sol";

/**
 * @notice Decides how a user's ENC commission is paid from their stakes:
 *         Public Sale lots inside their commission window first, then the
 *         ENC lock, each at its own discounted rate and only when it covers
 *         the whole commission. The Vault quotes ENC once, for the amount
 *         {commissionQuote} names, and falls back to the default rate in
 *         stablecoin when {chargeCommission} charges nothing.
 */
interface IENCStakeRouter {
    // ─── Events ───────────────────────────────────────────────────────────────

    event VaultUpdated(address indexed oldVault, address indexed newVault);

    /// @notice `amount` ENC of `user`'s commission was taken from the Public
    ///         Sale lots (`fromPublicSale`) or from the ENC lock.
    event CommissionRouted(
        address indexed user,
        bool indexed fromPublicSale,
        uint256 amount
    );

    // ─── Errors ───────────────────────────────────────────────────────────────

    error ZeroAddress();
    error NotContract(address account);
    error NotVault(address caller);

    // ─── External ─────────────────────────────────────────────────────────────

    /// @notice Charge `user`'s commission in ENC from the first stake that
    ///         covers it — Public Sale lots, then the ENC lock — and send it
    ///         to {ENC_COMMISSION}. Each stake owes `quotedEnc` scaled by its
    ///         rate over the quoted rate. Only the Vault.
    /// @param  user         User charged.
    /// @param  netProfit    Profit after the fund commission, in stablecoin.
    /// @param  quotedStable The amount {commissionQuote} returned; a mismatch
    ///                      charges nothing.
    /// @param  quotedEnc    ENC the DEX quotes for `quotedStable`.
    /// @return encCharged ENC sent to {ENC_COMMISSION}; 0 if no stake covers it.
    function chargeCommission(
        address user,
        uint256 netProfit,
        uint256 quotedStable,
        uint256 quotedEnc
    ) external returns (uint256 encCharged);

    /// @notice Set the Vault allowed to call {chargeCommission}. Owner only.
    /// @param  newVault New Vault; must be non-zero.
    function setVault(address newVault) external;

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice Stablecoin amount the Vault must quote in ENC before
    ///         {chargeCommission}: `netProfit` at the highest discounted rate
    ///         among `user`'s stakes. Lower rates scale down from that one
    ///         quote; DEX quotes are concave, so no stake is charged more ENC
    ///         than an exact quote would ask.
    /// @param  user      User.
    /// @param  netProfit Profit after the fund commission, in stablecoin.
    /// @return quotedStable Amount to quote; 0 when no stake can pay.
    function commissionQuote(
        address user,
        uint256 netProfit
    ) external view returns (uint256 quotedStable);

    /// @notice `user`'s Public Sale stake: the discounted rate and the lots'
    ///         unclaimed ENC while a lot is inside the commission window,
    ///         otherwise the default rate and zero. A failing sale, or one not
    ///         bound to this router, reads as no stake.
    /// @param  user User.
    /// @return bps     Commission rate in basis points.
    /// @return balance Unclaimed ENC of the lots inside the window.
    function publicSaleStake(
        address user
    ) external view returns (uint16 bps, uint256 balance);

    /// @notice `user`'s ENC lock stake: the lock plan's rate and the locked
    ///         ENC, or the default rate and zero when not locked or expired.
    /// @param  user User.
    /// @return bps     Commission rate in basis points.
    /// @return balance Locked ENC.
    function lockStake(
        address user
    ) external view returns (uint16 bps, uint256 balance);

    /// @notice The Vault allowed to call {chargeCommission}.
    function vault() external view returns (address);

    /// @notice The ENC lock, tried after the Public Sale.
    function ENC_LOCK() external view returns (IENCLock);

    /// @notice The Public Sale whose lots are tried first.
    function PUBLIC_SALE() external view returns (IEnishiPublicSale);

    /// @notice Where charged ENC goes: the ENC Commission contract.
    function ENC_COMMISSION() external view returns (address);
}
