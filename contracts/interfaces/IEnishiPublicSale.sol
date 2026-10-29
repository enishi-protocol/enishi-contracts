// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IEnishiPublicSale {
    // ─── Structs ──────────────────────────────────────────────────────────────

    /// @notice One purchase. `amount` and `claimed` are measured on the lot's
    ///         original 12-tranche schedule: `claimed` is the part of that
    ///         schedule already paid out. `remaining` is the ENC still owed;
    ///         it equals `amount - claimed` until a commission is deducted,
    ///         after which every unclaimed tranche shrinks by the same ratio.
    ///         `deducted` is the total commission ENC taken from the lot, so
    ///         ENC paid out = `amount - remaining - deducted`.
    ///         `start` is the moment its 730-day lock started.
    /// @dev    uint96 holds ~79B ENC, far above ENC's 3B max supply, and keeps
    ///         the lot in two slots: `amount|claimed` and
    ///         `remaining|start|deducted`. The window scan reads `start` and
    ///         `remaining`, and {collectCommission} writes `remaining` and
    ///         `deducted`, so each touches one slot per lot.
    struct Lot {
        uint96 amount;
        uint96 claimed;
        uint96 remaining;
        uint64 start;
        uint96 deducted;
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    /// @notice A purchase was recorded; its lock runs from `start`. `lotIndex`
    ///         is this lot's position in `buyer`'s {lotsOf} array. `usdtPaid`
    ///         is `units * unitPriceUsdt` at the time of purchase — the price
    ///         may change later via {setSaleParams}, so this is the only
    ///         reliable record of what was actually paid.
    event Purchased(
        address indexed buyer,
        uint256 units,
        uint256 amount,
        uint256 usdtPaid,
        uint256 start,
        uint256 lotIndex
    );

    /// @notice `account` claimed vested ENC across one or more lots. Emitted
    ///         by both {claim} and {claimLot}, so it alone covers every payout.
    event Claimed(address indexed account, uint256 amount);

    /// @notice `account` claimed `amount` vested ENC from lot `lotIndex` alone
    ///         via {claimLot}. Always followed by a matching {Claimed}.
    event LotClaimed(address indexed account, uint256 indexed lotIndex, uint256 amount);

    /// @notice An operator swept `amount` ENC that no lot owes to `to`.
    event Swept(address indexed to, uint256 amount);

    /// @notice The sale was switched open or closed.
    event SaleOpenSet(bool open);

    /// @notice Price/unit size/cap were retuned; applies to future {buy} calls.
    event SaleParamsSet(
        uint256 oldUnitPriceUsdt,
        uint256 newUnitPriceUsdt,
        uint256 oldEncPerUnit,
        uint256 newEncPerUnit,
        uint256 oldSaleCapEnc,
        uint256 newSaleCapEnc
    );

    /// @notice The commission router and the ENC recipient were set (one-shot).
    event StakeRouterUpdated(
        address indexed oldRouter,
        address indexed newRouter,
        address indexed recipient
    );

    /// @notice `amount` ENC was deducted from lot `lotIndex` of `account` as
    ///         commission. Emitted once per lot touched.
    event LotCommissionDeducted(
        address indexed account,
        uint256 indexed lotIndex,
        uint256 amount
    );

    /// @notice `amount` ENC of `account`'s lots was sent to `to` as commission.
    event CommissionCollected(
        address indexed account,
        address indexed to,
        uint256 amount
    );

    // ─── Errors ───────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error EncTokenNotSet();
    error EncTokenAlreadySet();
    error SaleCapExceeded(uint256 requested, uint256 remaining);
    error InsufficientBacking(uint256 requested, uint256 available);
    error NothingToClaim();
    error SaleNotOpen();
    error SaleNotClosed();
    error SaleStateUnchanged(bool closed);
    error SaleCapBelowSold(uint256 newCap, uint256 sold);
    error InvalidLotIndex(uint256 lotIndex, uint256 lotCount);
    error StakeRouterAlreadySet();
    error NotStakeRouter(address caller);
    error InsufficientCommissionBalance(uint256 requested, uint256 available);

    // ─── External: admin ──────────────────────────────────────────────────────

    /// @notice Set {ENC_TOKEN}. Callable exactly once — ENC_TOKEN can never
    ///         change afterwards, since every lot, totalLocked, and encSold
    ///         figure would otherwise refer to the wrong token.
    ///         DEFAULT_ADMIN_ROLE-gated, not OPERATOR_ROLE.
    /// @param  enc_ The ENC token this sale pays out.
    function setEncToken(address enc_) external;

    /// @notice Switch the sale open or closed. The sale starts closed; open it
    ///         once ENC has been transferred in: requires {ENC_TOKEN} set and
    ///         ENC held beyond what lots owe ≥ the cap still unsold.
    ///         Closed blocks {buy} and opens {sweepUnsold}; open does the
    ///         reverse. Toggle freely either way.
    function setSaleOpen(bool open) external;

    /// @notice Reclaim ENC not committed to any sold unit. Only while the
    ///         sale is closed (see {setSaleOpen}). {saleCapEnc} is unchanged,
    ///         so reopening needs the cap lowered via {setSaleParams} or the
    ///         ENC topped back up (see {backingShortfall}).
    /// @param  to Recipient of the swept ENC.
    function sweepUnsold(address to) external;

    /// @notice Retune the USDT price per unit, the ENC size of one unit, and
    ///         the total ENC sale cap, all at once. Future {buy} calls only.
    ///         While the sale is open, a new cap must stay backed by ENC held.
    function setSaleParams(
        uint256 newUnitPriceUsdt,
        uint256 newEncPerUnit,
        uint256 newSaleCapEnc
    ) external;

    /// @notice Set the only caller of {collectCommission} and the only address
    ///         commission ENC can be sent to. Callable exactly once, so the
    ///         sale admin can never point either elsewhere. The router's owner
    ///         still decides which Vaults may pull through it.
    ///         DEFAULT_ADMIN_ROLE-gated.
    /// @param  router    The ENC stake router the Vault charges through.
    /// @param  recipient The ENC Commission contract receiving deducted ENC.
    function setStakeRouter(address router, address recipient) external;

    // ─── External: stake router ───────────────────────────────────────────────

    /// @notice Deduct `amount` ENC of commission from `account`'s lots still
    ///         inside the commission window, oldest lot first, and send it to
    ///         {commissionRecipient}. Within a lot, every unclaimed tranche
    ///         shrinks by the same ratio. All or nothing: reverts when the
    ///         lots' unclaimed ENC is below `amount`. Only {stakeRouter}.
    /// @param  account Buyer charged.
    /// @param  amount  ENC to deduct.
    /// @return balance The buyer's commission balance after the deduction.
    function collectCommission(
        address account,
        uint256 amount
    ) external returns (uint256 balance);

    // ─── External: buyer ──────────────────────────────────────────────────────

    /// @notice Buy `units` at the current price/size, paid in USDT, while the
    ///         sale is open. The purchase locks for 730 days, then releases in
    ///         12 equal tranches: one when the lock ends, then one every 30 days.
    /// @param  units Whole units to buy.
    function buy(uint256 units) external;

    /// @notice Claim every vested-but-unclaimed ENC across the caller's lots.
    /// @return amount ENC transferred to the caller.
    function claim() external returns (uint256 amount);

    /// @notice Claim the vested-but-unclaimed ENC of one specific lot only.
    /// @param  lotIndex Index into the caller's lot array, as in {lotsOf}.
    /// @return amount   ENC transferred to the caller.
    function claimLot(uint256 lotIndex) external returns (uint256 amount);

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice Every lot `account` holds, oldest first.
    function lotsOf(address account) external view returns (Lot[] memory);

    /// @notice Vested-but-unclaimed ENC across every lot `account` holds.
    function claimableOf(address account) external view returns (uint256);

    /// @notice Whether `account` holds a lot inside the commission window and
    ///         the unclaimed ENC of those lots, which backs the commission.
    /// @param  account Buyer.
    /// @return active  True while any lot is younger than the window.
    /// @return balance Unclaimed ENC across the lots inside the window.
    function commissionStatus(
        address account
    ) external view returns (bool active, uint256 balance);

    /// @notice The only caller of {collectCommission}; zero until set.
    function stakeRouter() external view returns (address);

    /// @notice The only recipient of deducted commission ENC; zero until set.
    function commissionRecipient() external view returns (address);

    /// @notice Vested-but-unclaimed ENC for one specific lot of `account`,
    ///         indexed the same way as {lotsOf}.
    function claimableOfLot(
        address account,
        uint256 lotIndex
    ) external view returns (uint256);

    /// @notice ENC committed to sold units so far; never exceeds {saleCapEnc}.
    function encSold() external view returns (uint256);

    /// @notice ENC still available for purchase: the lower of what the cap
    ///         allows and what is actually held for sale.
    function remainingEnc() external view returns (uint256);

    /// @notice Whole units still purchasable at the current {encPerUnit}.
    function remainingUnits() external view returns (uint256);

    /// @notice Minimum ENC the operator must transfer in before {saleCapEnc}
    ///         can be set to `newCap` (or the sale opened at it); 0 if the ENC
    ///         held already covers it. Reverts {SaleCapBelowSold} below {encSold}.
    /// @param  newCap The cap the operator wants to set.
    function backingShortfall(uint256 newCap) external view returns (uint256);
}
