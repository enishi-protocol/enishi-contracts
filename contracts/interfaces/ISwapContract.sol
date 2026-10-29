// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  ISwapContract
 * @notice Interface for the Swap Contract (SWC). See {SwapContract} for
 *         per-function NatSpec.
 *
 *         Each SWC is an EIP-1167 minimal-proxy clone responsible for one
 *         ERC-20 (`availableTokenAddress`). It is operated 1:1 by a single
 *         EOA drawn from the WhiteList pool: the Fund System uses that EOA's
 *         private key to call {executeSwap}, which sells
 *         `availableTokenAddress` on the DEX to realise profit. {Profit} (on
 *         close) is the authoritative log for off-chain profit accounting.
 *
 *         Profit distribution (gas refund to EOA, USDT to Vault, commission
 *         flows) is intentionally out of scope — the Vault orchestrates
 *         downstream settlement against the emitted logs.
 */
interface ISwapContract {
    // ─── Types ────────────────────────────────────────────────────────────────

    /**
     * @notice A single round-1 purchase on a strategy slot, closed independently
     *         from other orders on the same slot via LIFO swapback.
     *
     *         Tracks both sides of the trade so round-2 can validate `amountIn`
     *         against the correct unit: `costBasis` is denominated in
     *         `availableToken` (what was spent), while `assetAmount` is
     *         denominated in the strategy token itself (what was received).
     *         Round-2's `amountIn` is a quantity of the strategy token —
     *         comparing it directly against `costBasis` would mix units
     *         whenever the round-1/round-2 exchange rate isn't 1:1. An order
     *         is always closed in full in a single round-2 call (`amountIn`
     *         must equal `assetAmount` exactly) — there is no partial fill,
     *         so no proportional cost-basis calculation (and no rounding) is
     *         needed.
     * @param  costBasis   `availableToken` amount spent opening the order
     *                     (immutable; used as-is when the order closes).
     * @param  assetAmount Strategy token amount received when the order was
     *                     opened (immutable; the exact `amountIn` round-2
     *                     must supply to close this order).
     */
    struct Order {
        uint128 costBasis;
        uint128 assetAmount;
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    /**
     * @param  tokenIn      Deployed token sold back (round-2 `tokenIn`).
     * @param  tokenOut     Available token received.
     * @param  amountIn     Strategy-token amount sold, closing the LIFO-head
     *                      order in full (equals that order's
     *                      {Order.assetAmount} — NOT `availableToken` units).
     * @param  amountOut    Available token received.
     * @param  profitDelta  Realised P&L in `availableToken` units for this
     *                      swapback only (signed; negative on a loss).
     *                      `= amountOut - costBasis` of the order just closed
     *                      — NOT `amountOut - amountIn`, since `amountIn` and
     *                      `amountOut`/`profitDelta` are denominated in
     *                      different tokens.
     */
    event Profit(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        int256 profitDelta,
        address payoutToken
    );
    event OperatorUpdated(
        address indexed oldOperator,
        address indexed newOperator
    );
    event ExitWithdrawn(
        address indexed token,
        address indexed to,
        uint256 amount
    );
    event ExitRealized(
        address indexed availableToken,
        uint256 principal,
        uint256 profitInAvailable
    );
    /**
     * @param  availableToken Available Token of the exited position.
     * @param  principal      Deposit amount exited, in `availableToken` units.
     * @param  stableOut      USDT locked on the SWC for the delayed withdrawal.
     */
    event ExitLiquidated(
        address indexed availableToken,
        uint256 principal,
        uint256 stableOut
    );
    /**
     * @param  availableToken Token the profit was denominated in before swapping.
     * @param  profitAmount   Total profit realised, in `availableToken` units.
     * @param  availSpentOnGas `availableToken` spent topping up the SEOA's BNB.
     * @param  stableToVault  `payoutToken` delivered to the Vault (price numerator).
     * @param  receiptToken   Corresponding receipt ERC-20 (enBTC, enETH, …).
     * @param  totalAssetUSD  User's tracked deposit valued at the realized rate
     *                        (depositedAmount × stableToVault / availIn).
     * @param  tvlUSD         System TVL for this strategy at the realized rate
     *                        (receiptTotalSupply × stableToVault / availIn).
     */
    event ProfitRealized(
        address indexed availableToken,
        uint256 profitAmount,
        uint256 availSpentOnGas,
        uint256 stableToVault,
        address receiptToken,
        uint256 totalAssetUSD,
        uint256 tvlUSD
    );

    /**
     * @notice Emitted when round-1 (`availableToken → tokenOut`) opens a new,
     *         independent order on a strategy slot. There is no on-chain view
     *         for reading order state back — off-chain callers must track
     *         `costBasis`/`assetAmount` per order by indexing this event (and
     *         {Profit} for closes), and use the tracked `assetAmount` of the
     *         LIFO-head (most recently opened, still-open) order as the exact
     *         `amountIn` required to close it via round-2.
     * @param  tokenOut     Strategy token the order was opened against.
     * @param  orderIndex   Index of the new order in the slot's order queue
     *                      (stable: only ever popped from the tail, so
     *                      existing indices never shift).
     * @param  costBasis    `availableToken` amount spent opening this order.
     * @param  assetAmount  Strategy token amount received when the order was
     *                      opened — the exact `amountIn` round-2 must supply
     *                      to close this order (orders always close in full).
     */
    event OrderOpened(
        address indexed tokenOut,
        uint256 indexed orderIndex,
        uint128 costBasis,
        uint128 assetAmount
    );

    // ─── Errors ───────────────────────────────────────────────────────────────

    error NotOperator(address caller);
    error NotVault(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error InvalidPath();
    error TokenNotWhitelisted(address token);
    error LengthMismatch();
    error ExitPending();
    error InsufficientOutput(uint256 amountOut, uint256 minOut);
    error SwapAmountMismatch(uint256 spent, uint256 expected);

    /// @notice {releasePrincipal} was asked for a token other than the one
    ///         the pending exit principal is held in.
    error InvalidPayoutToken(address token, address expected);
    /// @notice An exit named an Available Token other than this SWC's own.
    error AvailableTokenMismatch(address token, address expected);

    /**
     * @notice A consolidation swap in {realizeForExit} or {liquidateForExit}
     *         declared an `amountIn` outside the accepted range for its slot.
     * @param  declared `amountIn` encoded in the Universal Router calldata.
     * @param  minIn    Sum of the slot's open orders, or the exited principal
     *                  for the Available Token leg of {liquidateForExit}
     *                  (capped at `maxIn`).
     * @param  maxIn    The SWC's balance of the slot token.
     */
    error ConsolidationAmountOutOfRange(uint256 declared, uint256 minIn, uint256 maxIn);

    /**
     * @notice Round-2 `amountIn` (a strategy-token quantity) did not exactly
     *         match `assetAmount` of the LIFO-head order (the most recently
     *         opened, still-open order). Orders always close in full in a
     *         single round-2 call — there is no partial fill. Swapback never
     *         spills over into the next order automatically either: call
     *         again after the head order is closed to reach older orders.
     * @param  available `assetAmount` of the LIFO-head order (strategy token
     *                   units) — the exact `amountIn` required to close it.
     * @param  requested `amountIn` the caller attempted to sell (strategy
     *                   token units).
     */
    error InsufficientOrderAmount(uint128 available, uint256 requested);

    // ─── Init ─────────────────────────────────────────────────────────────────

    function initialize(address operator_) external;

    // ─── Operator API ─────────────────────────────────────────────────────────

    function executeSwap(
        address tokenIn,
        address tokenOut,
        bytes calldata swapData,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 minStableOut,
        uint256 minEncOut,
        bytes calldata gasPath,
        bytes calldata encPath,
        bytes calldata stablePath
    ) external returns (uint256 amountOut);

    function executeSwap(
        address tokenIn,
        address tokenOut,
        bytes calldata swapData,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata gasPath,
        bytes calldata encPath,
        bytes calldata stablePath
    ) external returns (uint256 amountOut);

    // ─── Vault Admin ──────────────────────────────────────────────────────────

    function setOperator(address newOperator) external;
    function deposit(address availableToken, uint256 amount) external;
    function realizeForExit(
        address availableToken,
        uint256 principal,
        uint256[] calldata minConsolidationOuts,
        bytes[] calldata consolidationSwapData
    ) external returns (uint256 profitInAvailable);
    function liquidateForExit(
        address availableToken,
        uint256 principal,
        uint256[] calldata minStableOuts,
        bytes[] calldata stableSwapData
    ) external returns (uint256 stableOut);
    function releasePrincipal(address token) external returns (uint256 amount);
    function pause() external;
    function unpause() external;

    // ─── Views ────────────────────────────────────────────────────────────────

    function DEX_V3() external view returns (address);
    function UNIVERSAL_ROUTER() external view returns (address);
    function operator() external view returns (address);
    function depositedAmount() external view returns (uint128);
    function pendingStable() external view returns (bool);
    function vault() external view returns (address);
    function availableTokenAddress() external view returns (address);
    function user() external view returns (address);
    function getDeployedTokens() external view returns (address[] memory);
    function deployedCount() external view returns (uint256);

    /// @notice Number of still-open orders on a strategy slot.
    function orderCount(address tokenOut) external view returns (uint256);
}
