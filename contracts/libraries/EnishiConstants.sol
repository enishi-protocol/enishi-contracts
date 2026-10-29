// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  EnishiConstants
 */
library EnishiConstants {
    uint8 internal constant STRATEGY_COUNT = 7;

    /// @notice Minimum strategies a user must select per Execute.
    uint8 internal constant MIN_STRATEGIES = 1;

    /// @notice Minimum total deposit per Execute: 10,000 USDT (BSC USDT has 18
    ///         decimals). Checked against the total, not per slot.
    uint256 internal constant MIN_DEPOSIT = 10_000 ether;

    /// @notice Minimum BNB forwarded to each SEOA for swap gas (~$1.95).
    uint256 internal constant MIN_BNB_PER_SEOA = 0.003 ether;

    uint256 internal constant EXIT_DELAY = 48 hours;

    /// @notice Shortfall (0.1% of the exited principal) the Available Token
    ///         leg of a USDT-payout exit may leave unsold, so a dust donation
    ///         landing before the exit cannot revert it.
    uint16 internal constant EXIT_DUST_TOLERANCE_BPS = 10;

    /// @notice Fund Commission skimmed off gross profit (20%), routed to the
    ///         Fund Wallet.
    uint16 internal constant FUND_COMMISSION_BPS = 2000;

    /// @notice Default ENC Commission rate (25%)
    uint16 internal constant ENC_COMMISSION_DEFAULT_BPS = 2500;

    /// @notice Basis-point denominator (100% = 10000).
    uint16 internal constant BPS_DENOMINATOR = 10_000;

    /**
     * @notice ENC's fixed total supply
     */
    uint256 internal constant ENC_MAX_SUPPLY = 3_000_000_000 ether;

    /**
     * @notice Total non-public allocation (Seed + Private + Team + Treasury = 2.01B ENC)
     */
    uint256 internal constant ENC_NON_PUBLIC_ALLOCATION = 2_010_000_000 ether;

    /**
     * @notice Round allocations
     */
    uint256 internal constant SEED_ALLOCATION = 12_000_000 ether;
    uint256 internal constant PRIVATE_ALLOCATION = 28_000_000 ether;
    uint256 internal constant TEAM_ALLOCATION = 450_000_000 ether;
    uint256 internal constant TREASURY_ALLOCATION = 1_520_000_000 ether;
    uint256 internal constant PUBLIC_ALLOCATION = 990_000_000 ether;

    /**
     * @notice Maximum cumulative ENC that can be burned to unlock all non-public tokens (2.01B ENC)
     */
    uint256 internal constant ENC_MAX_BURN = ENC_NON_PUBLIC_ALLOCATION;

    /**
     * @notice Public Sale constants (20M ENC max allocation, 2-year lock, 12-month vesting)
     */
    uint256 internal constant PUBLIC_SALE_MAX_ALLOCATION = 20_000_000 ether;

    /**
     * @notice Public tokens left on the ENCVesting schedule after the Public Sale
     *         carve-out (990,000,000 − 20,000,000 = 970,000,000 ENC). The 20M is
     *         taken out of the TGE tranche and sold through the standalone
     *         EnishiPublicSale contract, not administered by ENCVesting.
     */
    uint256 internal constant PUBLIC_VESTING_ALLOCATION =
        PUBLIC_ALLOCATION - PUBLIC_SALE_MAX_ALLOCATION;
    uint32 internal constant PUBLIC_SALE_CLIFF = 730 days;
    uint32 internal constant PUBLIC_SALE_RELEASE_INTERVAL = 30 days;
    uint16 internal constant PUBLIC_SALE_RELEASE_COUNT = 12;

    /**
     * @notice A Public Sale lot backs the ENC commission for 3 years from its
     *         purchase (730-day lock + 360-day vesting year). While a buyer
     *         holds any lot inside this window, the commission is charged at
     *         {PUBLIC_SALE_COMMISSION_BPS} from the lots' unclaimed ENC.
     */
    uint32 internal constant PUBLIC_SALE_COMMISSION_WINDOW = 1090 days;
    uint16 internal constant PUBLIC_SALE_COMMISSION_BPS = 1000;

    /**
     * @notice Public round schedule on {ENCVesting}: 20% at TGE, then a 1-year
     *         cliff followed by 60 monthly releases of the remainder.
     */
    uint16 internal constant PUBLIC_TGE_BPS = 2000;
    uint32 internal constant PUBLIC_CLIFF = 365 days;
    uint32 internal constant PUBLIC_RELEASE_INTERVAL = 30 days;
    uint16 internal constant PUBLIC_RELEASE_COUNT = 60;


    /**
     * @notice Default PancakeSwap V3 pool fee tier.
     * @dev    See https://docs.pancakeswap.finance/earn/pancakeswap-pools
     */
    uint24 internal constant V3_FEE_LOWEST = 100; //    0.01%
    uint24 internal constant V3_FEE_LOW = 500; //       0.05%
    uint24 internal constant V3_FEE_MEDIUM = 2500; //   0.25%
    uint24 internal constant V3_FEE_HIGH = 10000; //    1.00%

    uint256 internal constant SWAP_DEADLINE_BUFFER_SECONDS = 300 seconds;
}
