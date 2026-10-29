// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/**
 * @title ENCTestnet
 * @notice Testnet-only twin of {ENC}. Identical behaviour (ERC20 + EIP-2612 permit
 *         + burnable, fixed supply minted once at deploy) with one difference: the
 *         supply is split between TWO recipients at genesis instead of one.
 *
 * @dev Exists so burn-based unlock can actually be exercised on testnet. Real {ENC}
 *      mints its entire 3,000,000,000 supply straight into {ENCVesting}, which leaves
 *      no circulating ENC to burn — and burning is what drives the SEED/PRIVATE/TEAM/
 *      TREASURY unlock. Here the vesting share is minted to the vault while the rest
 *      goes to a testing wallet that can burn it down gradually.
 *
 *      NEVER deploy this to mainnet. `MAX_SUPPLY` here is a constructor argument, not
 *      the fixed 3,000,000,000 of the production token; production tokenomics live in
 *      {ENC} and must not be changed to accommodate testing.
 */
contract ENCTestnet is ERC20Permit, ERC20Burnable {
    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice Total supply minted at construction. Matches {ENC.MAX_SUPPLY}'s role
    ///         as the baseline `ENCVesting.INITIAL_SUPPLY` is measured against.
    uint256 public immutable MAX_SUPPLY;

    // ─── Errors ───────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();

    // ─── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param vesting_        {ENCVesting}; receives `vestingAmount_` to back allocations.
     * @param treasury_       Testing wallet; receives `treasuryAmount_`, free to burn.
     * @param publicWallet_   PUBLIC round's beneficiary; receives its TGE tranche
     *                        directly, mirroring {ENCVesting}'s pre-credited
     *                        `claimed[PUBLIC]`. Must be the same address passed to
     *                        {ENCVesting}'s constructor, and `publicTgeAmount_` must
     *                        equal `ENCVesting.PUBLIC_TGE_AMOUNT`, or the tranche is
     *                        stranded and the books disagree.
     * @param vestingAmount_  ENC minted to `vesting_`. Must cover every round's
     *                        allocation minus the pre-delivered TGE tranche.
     * @param treasuryAmount_ ENC minted to `treasury_`, the burnable float.
     * @param publicTgeAmount_ ENC minted to `publicWallet_` at genesis. Pass 0 when
     *                        {ENCVesting} holds the TGE tranche and PUBLIC claims it.
     */
    constructor(
        address vesting_,
        address treasury_,
        address publicWallet_,
        uint256 vestingAmount_,
        uint256 treasuryAmount_,
        uint256 publicTgeAmount_
    ) ERC20("Test Enishi", "tENC") ERC20Permit("Enishi") {
        if (vesting_ == address(0) || treasury_ == address(0) || publicWallet_ == address(0)) {
            revert ZeroAddress();
        }
        if (vestingAmount_ == 0 || treasuryAmount_ == 0) revert ZeroAmount();

        MAX_SUPPLY = vestingAmount_ + treasuryAmount_ + publicTgeAmount_;
        _mint(vesting_, vestingAmount_);
        _mint(treasury_, treasuryAmount_);
        // Zero when {ENCVesting} pays the TGE tranche out of its own balance instead.
        if (publicTgeAmount_ != 0) _mint(publicWallet_, publicTgeAmount_);
    }
}
