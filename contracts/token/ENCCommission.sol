// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IENCCommission.sol";
import "../interfaces/IENC.sol";
import "../interfaces/IReferralRegistry.sol";
import "../libraries/EnishiConstants.sol";

/**
 * @title ENCCommission
 * @notice Splitter for ENC commission. Distributes incoming ENC to four destinations:
 *
 *   • 40%  → user's direct referrer       (parentOf(user) in ReferralRegistry)
 *   • 10%  → Enishi Master Wallet         (operating fee)
 *   • 20%  → Enishi Master Wallet         (CSR fee)
 *   • 30%  → burn  (or → Enishi Master Wallet once burn cap reached)
 *
 * Burn cap: once totalSupply drops to {ENC_PUBLIC_ALLOCATION} (990,000,000 ENC),
 * burning stops. Any burn share that can't be burned is instead forwarded to
 * enishiMasterWallet as additional operating expense, making operating 40% effective.
 *
 * Operating + CSR are sent in a single transfer to Enishi Master Wallet.
 * Splits are configurable by owner and must always sum to 10000 bps.
 */
contract ENCCommission is Ownable, ReentrancyGuardTransient, IENCCommission {
    using SafeERC20 for IENC;

    // ─── Constants ────────────────────────────────────────────────────────────

    uint256 public constant BPS_DENOMINATOR = EnishiConstants.BPS_DENOMINATOR;

    /// @notice Minimum circulating supply that must remain after any burn.
    uint256 public constant MIN_SUPPLY = EnishiConstants.PUBLIC_ALLOCATION;

    // ─── State ────────────────────────────────────────────────────────────────

    IENC public ENC_TOKEN;
    uint16 public referralBps;
    uint16 public operatingBps;
    uint16 public csrBps;
    uint16 public burnBps;

    IReferralRegistry public REFERRAL_REGISTRY;

    address public enishiMasterWallet;

    // Whitelist of contracts allowed to trigger distribution (e.g., Vault).
    mapping(address => bool) public isAuthorizedCaller;

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyAuthorized() {
        if (!isAuthorizedCaller[_msgSender()]) revert NotAuthorized();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    /// @param enc_                 ENC token address.
    /// @param referralRegistry_    ReferralRegistry contract used for `parentOf(user)` lookups.
    /// @param enishiMasterWallet_  Recipient for operating + CSR fees (must be non-zero).
    constructor(
        address enc_,
        address referralRegistry_,
        address enishiMasterWallet_
    ) Ownable(_msgSender()) {
        if (
            enc_ == address(0) ||
            referralRegistry_ == address(0) ||
            enishiMasterWallet_ == address(0)
        ) revert ZeroAddress();

        ENC_TOKEN = IENC(enc_);
        REFERRAL_REGISTRY = IReferralRegistry(referralRegistry_);
        enishiMasterWallet = enishiMasterWallet_;

        // Default split: 40 / 10 / 20 / 30
        _setSplit(4000, 1000, 2000, 3000);

        emit EnishiMasterWalletChanged(address(0), enishiMasterWallet_);
    }

    // ─── Owner ────────────────────────────────────────────────────────────────

    /// @notice Update the four split percentages used by subsequent `distribute` calls.
    /// @param referralBps_  New referrer share, in bps (0-10000).
    /// @param operatingBps_ New operating share, in bps (0-10000).
    /// @param csrBps_       New CSR share, in bps (0-10000).
    /// @param burnBps_      New burn share, in bps (0-10000).
    function setSplit(
        uint16 referralBps_,
        uint16 operatingBps_,
        uint16 csrBps_,
        uint16 burnBps_
    ) external onlyOwner {
        _setSplit(referralBps_, operatingBps_, csrBps_, burnBps_);
    }

    /// @notice Update the Enishi Master Wallet (recipient of operating + CSR fees).
    /// @param newWallet Non-zero recipient address for operating + CSR fees.
    function setEnishiMasterWallet(address newWallet) external onlyOwner {
        if (newWallet == address(0)) revert ZeroAddress();
        emit EnishiMasterWalletChanged(enishiMasterWallet, newWallet);
        enishiMasterWallet = newWallet;
    }

    /// @notice Authorize or revoke a caller for `distribute`.
    /// @param caller     Contract address whose authorization is being updated.
    /// @param authorized True to grant permission to call distribute, false to revoke.
    function setAuthorizedCaller(
        address caller,
        bool authorized
    ) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        isAuthorizedCaller[caller] = authorized;
        emit AuthorizedCallerChanged(caller, authorized);
    }

    // ─── External ─────────────────────────────────────────────────────────────

    /// @notice Distribute `amount` ENC among referrer, enishiMasterWallet, and burn per the current split.
    /// @param user   The user whose action incurred the commission. Referrer = `parentOf(user)`.
    /// @param amount Amount of ENC to distribute. Must be > 0 and ≤ this contract's ENC balance.
    function distribute(
        address user,
        uint256 amount
    ) external nonReentrant onlyAuthorized {
        if (amount == 0) revert ZeroAmount();
        IENC enc = ENC_TOKEN;
        uint256 bal = enc.balanceOf(address(this));
        if (bal < amount) revert InsufficientBalance(amount, bal);
        _distribute(enc, user, amount);
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @notice Validates and writes the four split values.
    /// @param referralBps_  Referrer share in bps.
    /// @param operatingBps_ Operating share in bps.
    /// @param csrBps_       CSR share in bps.
    /// @param burnBps_      Burn share in bps.
    function _setSplit(
        uint16 referralBps_,
        uint16 operatingBps_,
        uint16 csrBps_,
        uint16 burnBps_
    ) internal {
        uint256 sum = uint256(referralBps_) +
            uint256(operatingBps_) +
            uint256(csrBps_) +
            uint256(burnBps_);
        if (sum != BPS_DENOMINATOR) revert InvalidSplit(sum);

        referralBps = referralBps_;
        operatingBps = operatingBps_;
        csrBps = csrBps_;
        burnBps = burnBps_;

        emit SplitChanged(referralBps_, operatingBps_, csrBps_, burnBps_);
    }

    /// @notice Splits `amount` ENC into the four shares and transfers each to its destination.
    /// @param user   The user whose referrer receives the referral share.
    /// @param amount Total amount of ENC to split.
    function _distribute(IENC enc, address user, uint256 amount) internal {
        address referrer = REFERRAL_REGISTRY.parentOf(user);

        // Compute shares; burn share is the remainder so the four parts sum exactly to `amount`.
        uint256 referralAmount = (amount * referralBps) / BPS_DENOMINATOR;
        uint256 operatingAmount = (amount * operatingBps) / BPS_DENOMINATOR;
        uint256 csrAmount = (amount * csrBps) / BPS_DENOMINATOR;
        uint256 burnAmount = amount -
            referralAmount -
            operatingAmount -
            csrAmount;

        // ── Burn cap ────────────────────────────────────────────────────────────
        if (burnAmount > 0) {
            uint256 supply = enc.totalSupply();
            uint256 cap = supply > MIN_SUPPLY ? supply - MIN_SUPPLY : 0;
            if (burnAmount > cap) {
                operatingAmount += burnAmount - cap;
                burnAmount = cap;
            }
        }

        // If no referrer, redirect the referral share to enishiMasterWallet
        // instead of reverting — prevents a missing referrer from permanently
        // blocking profit settlement for the user.
        if (referralAmount > 0) {
            address referralDest = referrer != address(0)
                ? referrer
                : enishiMasterWallet;
            enc.safeTransfer(referralDest, referralAmount);
        }
        uint256 masterAmount = operatingAmount + csrAmount;
        if (masterAmount > 0)
            enc.safeTransfer(enishiMasterWallet, masterAmount);
        if (burnAmount > 0) enc.burn(burnAmount);

        emit Distributed(
            user,
            referrer,
            amount,
            referralAmount,
            operatingAmount,
            csrAmount,
            burnAmount
        );
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice Returns true when the burn cap has been fully reached and no more
    ///         ENC can be burned (totalSupply ≤ 990,000,000 ENC).
    function isBurnFinished() external view returns (bool) {
        return ENC_TOKEN.totalSupply() <= MIN_SUPPLY;
    }

    /// @notice Remaining ENC that can still be burned before the 990M supply floor is hit.
    function remainingBurnCap() external view returns (uint256) {
        uint256 supply = ENC_TOKEN.totalSupply();
        return supply > MIN_SUPPLY ? supply - MIN_SUPPLY : 0;
    }
}
