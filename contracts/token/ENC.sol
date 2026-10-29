// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../libraries/EnishiConstants.sol";

/**
 * @title ENC
 * @notice Enishi token.
 */
contract ENC is ERC20Permit, ERC20Burnable, Ownable {
    // ─── Constants ────────────────────────────────────────────────────────────

    uint8 private constant DECIMALS = 18;

    uint256 public constant MAX_SUPPLY = EnishiConstants.ENC_MAX_SUPPLY;

    /// @notice The Public Sale carve-out, minted straight to {EnishiPublicSale}
    ///         — the standalone contract that administers it, not {ENCVesting}.
    uint256 public constant PUBLIC_SALE_ALLOCATION =
        EnishiConstants.PUBLIC_SALE_MAX_ALLOCATION;

    /// @notice The remainder of the whole supply, minted to {ENCVesting}.
    uint256 public constant VESTING_ALLOCATION =
        EnishiConstants.ENC_MAX_SUPPLY - PUBLIC_SALE_ALLOCATION;

    // ─── State ────────────────────────────────────────────────────────────────

    bool public genesisMinted;

    // ─── Events ───────────────────────────────────────────────────────────────

    event GenesisMinted(
        address indexed vestingRecipient,
        uint256 vestingAmount,
        address indexed publicSaleRecipient,
        uint256 publicSaleAmount
    );

    // ─── Errors ───────────────────────────────────────────────────────────────

    error ZeroAddress();
    error AlreadyMinted();

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor() ERC20("Enishi", "ENC") ERC20Permit("Enishi") Ownable(_msgSender()) {}

    // ─── External ─────────────────────────────────────────────────────────────
    /**
     * @notice Mints the entire supply once and closes the mint path for good.
     * @param vestingRecipient     Receives {VESTING_ALLOCATION} — the {ENCVesting}
     *                             vault, which holds every round except the
     *                             Public Sale carve-out.
     * @param publicSaleRecipient Receives {PUBLIC_SALE_ALLOCATION} — the
     *                             standalone {EnishiPublicSale} contract, which
     *                             sells from its ENC balance; its operator
     *                             opens it with `setSaleOpen(true)` afterward.
     */
    function mintGenesis(
        address vestingRecipient,
        address publicSaleRecipient
    ) external onlyOwner {
        if (vestingRecipient == address(0) || publicSaleRecipient == address(0))
            revert ZeroAddress();
        if (genesisMinted) revert AlreadyMinted();

        genesisMinted = true;
        _transferOwnership(address(0)); // no owner from here on — mint path is closed

        _mint(vestingRecipient, VESTING_ALLOCATION);
        _mint(publicSaleRecipient, PUBLIC_SALE_ALLOCATION);

        emit GenesisMinted(
            vestingRecipient,
            VESTING_ALLOCATION,
            publicSaleRecipient,
            PUBLIC_SALE_ALLOCATION
        );
    }
}
