// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IEnishiPublicSale.sol";
import "./interfaces/IENC.sol";
import "./libraries/EnishiConstants.sol";

/**
 * @title  EnishiPublicSale
 * @notice ENC public sale paid in USDT. Each purchase is a lot locked for
 *         730 days, then released in 12 equal tranches, one every 30 days.
 *
 *         Flow: deploy (closed) → admin {setEncToken} → transfer ENC in →
 *         operator {setSaleOpen}. While open, the ENC held beyond
 *         {totalLocked} always backs the unsold cap. Close the sale to
 *         {sweepUnsold}.
 *
 *         Commission: for {COMMISSION_WINDOW} after purchase a lot's unclaimed
 *         ENC backs the buyer's Vault commission. The stake router deducts it
 *         via {collectCommission}, oldest lot first, shrinking the lot's
 *         unclaimed tranches pro rata.
 *
 *         Roles: DEFAULT_ADMIN_ROLE (deployer) — {setEncToken},
 *         {setStakeRouter}, role admin.
 *         OPERATOR_ROLE — {setSaleOpen}, {setSaleParams}, {sweepUnsold}.
 */
contract EnishiPublicSale is
    AccessControl,
    ReentrancyGuardTransient,
    IEnishiPublicSale
{
    using SafeERC20 for IENC;
    using SafeERC20 for IERC20;

    // ─── Constants ────────────────────────────────────────────────────────────

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Lock before a lot's first tranche: 730 days.
    uint32 public constant CLIFF_SECONDS = EnishiConstants.PUBLIC_SALE_CLIFF;

    /// @notice Gap between tranches: 30 days.
    uint32 public constant RELEASE_INTERVAL =
        EnishiConstants.PUBLIC_SALE_RELEASE_INTERVAL;

    /// @notice Number of tranches: 12.
    uint16 public constant RELEASE_COUNT =
        EnishiConstants.PUBLIC_SALE_RELEASE_COUNT;

    /// @notice How long a lot backs the commission after purchase: 1090 days.
    uint32 public constant COMMISSION_WINDOW =
        EnishiConstants.PUBLIC_SALE_COMMISSION_WINDOW;

    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice ENC paid out. Set once via {setEncToken}.
    IENC public ENC_TOKEN;

    IERC20 public immutable USDT_TOKEN;

    /// @notice Receives buyers' USDT.
    address public immutable TREASURY;

    /// @notice Blocks {buy}, allows {sweepUnsold}. Starts true.
    bool public saleClosed;

    /// @notice ENC per unit.
    uint256 public encPerUnit;

    /// @notice USDT per unit.
    uint256 public unitPriceUsdt;

    /// @notice Max ENC this sale may sell.
    uint256 public saleCapEnc;

    /// @notice ENC sold so far.
    uint256 public encSold;

    /// @notice ENC still owed to buyers. Always ≤ this contract's ENC balance.
    uint256 public totalLocked;

    /// @notice Sole caller of {collectCommission}. Set once via {setStakeRouter}.
    address public stakeRouter;

    /// @notice Sole recipient of commission ENC. Set once via {setStakeRouter}.
    address public commissionRecipient;

    mapping(address => Lot[]) internal _lots;

    // ─── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param usdt_     USDT token buyers pay in.
     * @param treasury_ Receives buyers' USDT.
     */
    constructor(
        address usdt_,
        address treasury_
    ) {
        if (usdt_ == address(0) || treasury_ == address(0))
            revert ZeroAddress();

        USDT_TOKEN = IERC20(usdt_);
        TREASURY = treasury_;

        _grantRole(DEFAULT_ADMIN_ROLE, _msgSender());

        saleClosed = true;

        // Defaults: $0.05/ENC, $10,000/unit (200,000 ENC/unit), 20,000,000 ENC cap.
        encPerUnit = 200_000 ether;
        unitPriceUsdt = 10_000 ether;
        saleCapEnc = EnishiConstants.PUBLIC_SALE_MAX_ALLOCATION;
    }

    // ─── Modifiers ────────────────────────────────────────────────────────────

    /// @dev Restricts to the stake router for {collectCommission}.
    modifier onlyStakeRouter() {
        if (_msgSender() != stakeRouter) revert NotStakeRouter(_msgSender());
        _;
    }

    // ─── External: admin ──────────────────────────────────────────────────────

    /**
     * @notice Set the ENC token. One-shot; required before opening the sale.
     * @param  enc_ The ENC token.
     */
    function setEncToken(address enc_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (enc_ == address(0)) revert ZeroAddress();
        if (address(ENC_TOKEN) != address(0)) revert EncTokenAlreadySet();

        ENC_TOKEN = IENC(enc_);
    }

    /**
     * @notice Open or close the sale. Opening requires {ENC_TOKEN} and enough
     *         ENC held to back the rest of the cap.
     * @param  open True to open, false to close.
     */
    function setSaleOpen(bool open) external onlyRole(OPERATOR_ROLE) {
        if (open) {
            if (address(ENC_TOKEN) == address(0)) revert EncTokenNotSet();
            _requireCapBacked(saleCapEnc);
        }
        bool closed = !open;
        if (closed == saleClosed) revert SaleStateUnchanged(closed);
        saleClosed = closed;

        emit SaleOpenSet(open);
    }

    /**
     * @notice Send all ENC not owed to any lot to `to`. Sale must be closed.
     *         The cap is left as is; reopening needs it lowered or re-backed.
     * @param  to Recipient.
     */
    function sweepUnsold(address to) external onlyRole(OPERATOR_ROLE) nonReentrant {
        if (!saleClosed) revert SaleNotClosed();
        if (to == address(0)) revert ZeroAddress();

        uint256 unsold = _availableEnc();
        if (unsold == 0) revert ZeroAmount();

        ENC_TOKEN.safeTransfer(to, unsold);

        emit Swept(to, unsold);
    }

    /**
     * @notice Update price, unit size and cap for future purchases.
     * @param  newUnitPriceUsdt USDT per unit.
     * @param  newEncPerUnit    ENC per unit.
     * @param  newSaleCapEnc    Sale cap; not below {encSold}. While the sale is
     *                          open, the ENC held must back the rest of it.
     */
    function setSaleParams(
        uint256 newUnitPriceUsdt,
        uint256 newEncPerUnit,
        uint256 newSaleCapEnc
    ) external onlyRole(OPERATOR_ROLE) {
        if (newUnitPriceUsdt == 0 || newEncPerUnit == 0) revert ZeroAmount();
        if (newSaleCapEnc < encSold)
            revert SaleCapBelowSold(newSaleCapEnc, encSold);
        if (!saleClosed) _requireCapBacked(newSaleCapEnc);

        emit SaleParamsSet(
            unitPriceUsdt,
            newUnitPriceUsdt,
            encPerUnit,
            newEncPerUnit,
            saleCapEnc,
            newSaleCapEnc
        );

        unitPriceUsdt = newUnitPriceUsdt;
        encPerUnit = newEncPerUnit;
        saleCapEnc = newSaleCapEnc;
    }

    /**
     * @notice Set the commission router and recipient. One-shot.
     * @param  router    Sole caller of {collectCommission}.
     * @param  recipient Sole recipient of commission ENC.
     */
    function setStakeRouter(
        address router,
        address recipient
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (router == address(0) || recipient == address(0))
            revert ZeroAddress();
        if (stakeRouter != address(0)) revert StakeRouterAlreadySet();

        stakeRouter = router;
        commissionRecipient = recipient;

        emit StakeRouterUpdated(address(0), router, recipient);
    }

    // ─── External: stake router ───────────────────────────────────────────────

    /**
     * @notice Deduct `amount` ENC of commission from `account`'s lots inside
     *         the commission window, oldest first, and send it to
     *         {commissionRecipient}. All or nothing.
     * @param  account Buyer charged.
     * @param  amount  ENC to deduct.
     * @return balance Commission balance left after the deduction.
     */
    function collectCommission(
        address account,
        uint256 amount
    ) external onlyStakeRouter nonReentrant returns (uint256 balance) {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        (uint256 i, , uint256 available) = _activeLots(account);
        if (amount > available)
            revert InsufficientCommissionBalance(amount, available);

        /*
            Lowering `remaining` alone shrinks every unclaimed tranche of the
            lot by the same ratio (see {_due}). The active lots hold at least
            `amount`, so the loop ends with `left` at zero.
        */
        Lot[] storage lots = _lots[account];
        uint256 left = amount;
        for (; left != 0; ++i) {
            Lot storage lot = lots[i];
            uint256 lotRemaining = lot.remaining;
            if (lotRemaining == 0) continue;

            uint256 take = left < lotRemaining ? left : lotRemaining;
            // `take` ≤ `remaining`, so both fit in uint96.
            lot.remaining = uint96(lotRemaining - take);
            lot.deducted += uint96(take);
            left -= take;

            emit LotCommissionDeducted(account, i, take);
        }

        balance = available - amount;
        totalLocked -= amount;

        address to = commissionRecipient;
        emit CommissionCollected(account, to, amount);

        ENC_TOKEN.safeTransfer(to, amount);
    }

    // ─── External: buyer ──────────────────────────────────────────────────────

    /**
     * @notice Buy `units` units; pays USDT to {TREASURY} and opens a new lot.
     * @param  units Number of units.
     */
    function buy(uint256 units) external nonReentrant {
        if (saleClosed) revert SaleNotOpen();
        if (units == 0) revert ZeroAmount();

        uint256 encAmount = units * encPerUnit;

        uint256 sold = encSold;
        uint256 cap = saleCapEnc;
        uint256 remaining = cap - sold;
        if (encAmount > remaining)
            revert SaleCapExceeded(encAmount, remaining);

        // Never sell ENC this contract does not hold.
        uint256 available = _availableEnc();
        if (encAmount > available)
            revert InsufficientBacking(encAmount, available);

        encSold = sold + encAmount;
        totalLocked += encAmount;

        uint256 startedAt = _now();
        Lot[] storage lots = _lots[_msgSender()];
        uint256 lotIndex = lots.length;
        // `encAmount` ≤ ENC held ≤ ENC max supply, well inside uint96.
        lots.push(
            Lot({
                amount: uint96(encAmount),
                claimed: 0,
                remaining: uint96(encAmount),
                start: uint64(startedAt),
                deducted: 0
            })
        );

        uint256 usdtPaid = units * unitPriceUsdt;
        emit Purchased(_msgSender(), units, encAmount, usdtPaid, startedAt, lotIndex);

        USDT_TOKEN.safeTransferFrom(
            _msgSender(),
            TREASURY,
            usdtPaid
        );
    }

    /// @notice Claim vested ENC from all of the caller's lots.
    /// @return amount ENC claimed.
    function claim() external nonReentrant returns (uint256 amount) {
        Lot[] storage lots = _lots[_msgSender()];
        uint256 len = lots.length;

        for (uint256 i = 0; i < len; ++i) {
            amount += _settleLot(lots[i]);
        }

        if (amount == 0) revert NothingToClaim();

        _payout(amount);
    }

    /**
     * @notice Claim vested ENC from one lot.
     * @param  lotIndex Index in {lotsOf}.
     * @return amount   ENC claimed.
     */
    function claimLot(uint256 lotIndex) external nonReentrant returns (uint256 amount) {
        Lot[] storage lots = _lots[_msgSender()];
        uint256 len = lots.length;
        if (lotIndex >= len) revert InvalidLotIndex(lotIndex, len);

        amount = _settleLot(lots[lotIndex]);
        if (amount == 0) revert NothingToClaim();

        emit LotClaimed(_msgSender(), lotIndex, amount);
        _payout(amount);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice All lots of `account`, oldest first.
    function lotsOf(address account) external view returns (Lot[] memory) {
        return _lots[account];
    }

    /// @notice Claimable ENC across all lots of `account`.
    function claimableOf(address account) external view returns (uint256 amount) {
        Lot[] storage lots = _lots[account];
        uint256 len = lots.length;

        for (uint256 i = 0; i < len; ++i) {
            amount += _claimable(lots[i]);
        }
    }

    /// @notice Claimable ENC for one lot of `account`.
    /// @param  lotIndex Index in {lotsOf}.
    function claimableOfLot(
        address account,
        uint256 lotIndex
    ) external view returns (uint256) {
        Lot[] storage lots = _lots[account];
        if (lotIndex >= lots.length) revert InvalidLotIndex(lotIndex, lots.length);

        return _claimable(lots[lotIndex]);
    }

    /// @notice Whether `account` has a lot inside {COMMISSION_WINDOW}, and the
    ///         unclaimed ENC across those lots.
    function commissionStatus(
        address account
    ) external view returns (bool active, uint256 balance) {
        (, active, balance) = _activeLots(account);
    }

    /// @notice ENC still buyable: min(cap left, ENC held beyond {totalLocked}).
    function remainingEnc() public view returns (uint256) {
        uint256 capLeft = saleCapEnc - encSold;
        uint256 available = address(ENC_TOKEN) == address(0) ? 0 : _availableEnc();
        return capLeft < available ? capLeft : available;
    }

    /// @notice Whole units still buyable.
    function remainingUnits() external view returns (uint256) {
        return remainingEnc() / encPerUnit;
    }

    /**
     * @notice ENC to transfer in before the cap can be `newCap`; 0 if already
     *         backed. Same rule {setSaleOpen} and {setSaleParams} enforce.
     * @param  newCap Proposed {saleCapEnc}; not below {encSold}.
     * @return ENC still missing to back `newCap` - {encSold}.
     */
    function backingShortfall(uint256 newCap) external view returns (uint256) {
        uint256 sold = encSold;
        if (newCap < sold) revert SaleCapBelowSold(newCap, sold);

        uint256 capLeft = newCap - sold;
        uint256 available = address(ENC_TOKEN) == address(0) ? 0 : _availableEnc();
        return capLeft > available ? capLeft - available : 0;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @dev ENC held beyond what lots owe; {buy} keeps balance ≥ totalLocked.
    function _availableEnc() internal view returns (uint256) {
        return ENC_TOKEN.balanceOf(address(this)) - totalLocked;
    }

    /// @dev Revert unless the ENC held beyond {totalLocked} covers `cap` - {encSold}.
    function _requireCapBacked(uint256 cap) internal view {
        uint256 capLeft = cap - encSold;
        uint256 available = _availableEnc();
        if (available < capLeft) revert InsufficientBacking(capLeft, available);
    }

    /// @dev Vested ENC of a lot: 0 during the lock, then amount × k / 12 for
    ///      tranche k (first at lock end), rounded half up to the nearest wei;
    ///      full amount from tranche 12. Never exceeds `amount`, since
    ///      amount × k + 6 < 12 × (amount + 1) for every k ≤ 12.
    function _vested(
        uint256 amount,
        uint256 start
    ) internal view returns (uint256) {
        uint256 now_ = _now();
        uint256 unlockAt = start + CLIFF_SECONDS;
        if (now_ < unlockAt) return 0;

        uint256 releases = (now_ - unlockAt) / RELEASE_INTERVAL + 1;
        if (releases >= RELEASE_COUNT) return amount;

        return (amount * releases + RELEASE_COUNT / 2) / RELEASE_COUNT;
    }

    /// @dev ENC due for the schedule moving from `claimedAmount` to `vested`:
    ///      `remaining` spread pro rata over the unclaimed schedule, so a
    ///      commission deduction shrinks each unclaimed tranche equally. The
    ///      last tranche pays all of `remaining`, so rounding strands no ENC.
    ///      Equals `vested - claimedAmount` while nothing was deducted.
    function _due(
        uint256 amount,
        uint256 claimedAmount,
        uint256 vested,
        uint256 remaining
    ) internal pure returns (uint256) {
        if (vested == amount) return remaining;
        return (remaining * (vested - claimedAmount)) / (amount - claimedAmount);
    }

    /// @dev ENC claimable now from `lot`.
    function _claimable(Lot storage lot) internal view returns (uint256) {
        uint256 amount = lot.amount;
        uint256 vested = _vested(amount, lot.start);
        uint256 claimedAmount = lot.claimed;
        if (vested <= claimedAmount) return 0;

        return _due(amount, claimedAmount, vested, lot.remaining);
    }

    /// @dev Mark the lot's vested schedule as claimed; return the ENC due.
    function _settleLot(Lot storage lot) internal returns (uint256 due) {
        uint256 amount = lot.amount;
        uint256 vested = _vested(amount, lot.start);
        uint256 claimedAmount = lot.claimed;
        if (vested <= claimedAmount) return 0;

        uint256 remaining = lot.remaining;
        due = _due(amount, claimedAmount, vested, remaining);
        lot.claimed = uint96(vested);
        lot.remaining = uint96(remaining - due);
    }

    /**
     * @dev Lots inside {COMMISSION_WINDOW}: index of the oldest, whether any
     *      exists, and their total `remaining`. Lots are appended in purchase
     *      order, so windows close oldest first; walking back from the newest
     *      lot reads only the lots still inside the window (plus one), and a
     *      buyer whose lots all expired costs one read.
     *      Assumes a non-decreasing clock; only the testnet clock can rewind.
     */
    function _activeLots(
        address account
    ) internal view returns (uint256 first, bool active, uint256 balance) {
        Lot[] storage lots = _lots[account];
        uint256 len = lots.length;
        uint256 now_ = _now();

        first = len;
        while (first != 0) {
            Lot storage lot = lots[first - 1];
            if (now_ >= uint256(lot.start) + COMMISSION_WINDOW) break;
            balance += lot.remaining;
            // Cannot underflow: the loop runs only while `first` is non-zero.
            unchecked {
                --first;
            }
        }
        active = first != len;
    }

    /// @dev Pay `amount` ENC to the caller.
    function _payout(uint256 amount) internal {
        totalLocked -= amount;
        ENC_TOKEN.safeTransfer(_msgSender(), amount);

        emit Claimed(_msgSender(), amount);
    }

    /// @dev Clock for vesting. Overridden only by the testnet subclass.
    function _now() internal view virtual returns (uint256) {
        return block.timestamp;
    }
}
