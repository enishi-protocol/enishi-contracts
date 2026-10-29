// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IENCStakeRouter} from "./IENCStakeRouter.sol";

/**
 * @title  IVault
 * @notice Surface of the Enishi Vault orchestrator. Covers strategy/receipt
 *         configuration and the Execute (equal-split deposit) flow. Exit
 *         (withdraw) and profit-distribution surfaces are added in later
 *         phases.
 */
interface IVault {
    // ─── Types ──────────────────────────────────────────────────────────────────

    /**
     * @param  user           Position owner whose profit is being settled.
     * @param  availableToken Strategy token the SWC holds (e.g. BTCB, ETH).
     * @param  grossProfit    Stablecoin profit the SWC delivered to the Vault.
     * @param  payoutToken    Stablecoin (USDT) the SWC delivered and
     *                        the user is paid in.
     * @param  minEncOut      Min ENC out when commission is swapped (Case A);
     *                        the stake-funded path (Case B) ignores this.
     */
    struct ProfitParams {
        address user;
        address availableToken;
        uint256 grossProfit;
        address payoutToken;
        uint256 minEncOut;
        bytes encPath;
    }

    /**
     * @param  slot                  Strategy slot to exit; < STRATEGY_COUNT.
     * @param  minConsolidationOuts  Per-strategy-slot minimum out when SWC swaps
     *                               deployed tokens back to availableToken during
     *                               realizeForExit. Length must equal STRATEGY_COUNT.
     *                               Pass 0 for slots that have no open position.
     * @param  consolidationPaths    Per-strategy-slot V3 swap path (strategy token →
     *                               availableToken) used by the consolidation swaps in
     *                               realizeForExit. Length must equal STRATEGY_COUNT;
     *                               entries for slots with no open position are ignored.
     * @param  minStableOut          Minimum payout stablecoin out when the exit-time
     *                               profit slice is swapped Available Token → payout token.
     * @param  minEncOut             Minimum ENC out when the ENC Commission is bought on
     *                               the DEX (CASE A); the stake-funded path (CASE B)
     *                               ignores it.
     * @param  payoutStable          true: the SWC sells every position (including the
     *                               idle Available Token) straight to USDT and the user
     *                               is paid that USDT after the delay. No profit is
     *                               split off and no commission is charged, so
     *                               `minStableOut`, `stablePath`, `minEncOut` and
     *                               `encPath` are ignored. `minConsolidationOuts` /
     *                               `consolidationPaths` then target USDT, and the
     *                               Available Token slot's entry must sell at least
     *                               min(balance, principal) less a 0.1% dust tolerance.
     */
    struct ExitParams {
        uint8 slot;
        uint256[] minConsolidationOuts;
        bytes[] consolidationPaths;
        uint256 minStableOut;
        bytes stablePath;
        uint256 minEncOut;
        bytes encPath;
        uint256 permitDeadline;
        uint8 permitV;
        bytes32 permitR;
        bytes32 permitS;
        bool payoutStable;
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    event Deposited(
        address indexed user,
        uint8 indexed slot,
        address availableToken,
        uint256 usdtIn,
        uint256 tokenOut,
        address swc
    );
    event SeoaFunded(address indexed user, address indexed seoa, uint256 bnb);

    /**
     * @param  enBurned     Active enToken burned (the user's tracked deposit amount on
     *                      the SWC, not necessarily their full live receipt balance —
     *                      receipts are freely transferable).
     * @param  payoutToken  Token the user was paid in: `availableToken`, or USDT
     *                      when the exit was requested with `payoutStable`.
     * @param  payoutAmount Amount of `payoutToken` sent to the user (may differ
     *                      from `enBurned` if the SWC closed positions at a
     *                      profit/loss, and is 0 on a total loss).
     */
    event Exited(
        address indexed user,
        uint8 indexed slot,
        address availableToken,
        address receipt,
        address swc,
        uint256 enBurned,
        address payoutToken,
        uint256 payoutAmount
    );
    event ExitStrategyRequested(
        bytes32 indexed requestId,
        address indexed swcAddress,
        address indexed userAddress,
        uint256 requestedAt
    );
    /**
     * @notice A `payoutStable` exit liquidated the position to USDT; the amount
     *         is locked on the SWC and paid out after the delay.
     * @param  requestId Exit request id (same as {ExitStrategyRequested}).
     * @param  user      Position owner.
     * @param  slot      Exited strategy slot.
     * @param  stableOut USDT locked for the user (0 on a total loss).
     */
    event ExitStableLocked(
        bytes32 indexed requestId,
        address indexed user,
        uint8 indexed slot,
        uint256 stableOut
    );

    event StakeRouterUpdated(
        address indexed oldStakeRouter,
        address indexed newStakeRouter
    );

    event ProfitProcessed(
        address indexed user,
        address indexed availableToken,
        address payoutToken,
        uint256 grossProfit,
        uint256 fundCommission,
        uint256 encCommission,
        uint256 userPayout,
        uint256 totalAssetUSD
    );
    event FundCommissionPaid(
        address indexed user,
        address token,
        uint256 amount
    );
    // ─── Errors ───────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error InvalidSlot(uint8 slot);
    error NotRegistered();
    error StrategyCountMismatch(uint256 expected, uint256 actual);
    error ReceiptNotConfigured(address availableToken);
    error InvalidStrategyCount(uint256 count);
    error DepositBelowMinimum(uint256 minimum, uint256 provided);
    error DuplicateSlot(uint8 slot);
    error LengthMismatch();
    error BnbBelowMinimum(uint256 minimum, uint256 provided);
    error ReferrerRequired();
    error UnsupportedStablecoin(address token);
    error NothingToProcess();
    error SwcNotFound(address user, address availableToken);
    error EmptyInput();
    error UnauthorizedSettler(address caller);
    error NothingToExit(uint8 slot);
    error ExitAlreadyPending(uint8 slot);
    error DepositBlockedByPendingExit(uint8 slot);
    error NoPendingExit(uint8 slot);
    error ExitDelayNotElapsed(uint256 unlockAt);
    error UnauthorizedExit(address caller);
    error EncPathRequired();
    error InvalidSwapPath();
    /// @notice Universal Router deposit swap produced less `tokenOut` than `minOut`.
    error InsufficientSwapOutput(uint256 amountOut, uint256 minOut);
    /// @notice Universal Router consumed `spent` `tokenIn`, not the expected `amountIn`.
    error SwapAmountMismatch(uint256 spent, uint256 expected);

    // ─── Views ────────────────────────────────────────────────────────────────

    function STRATEGY_COUNT() external view returns (uint8);

    function UNIVERSAL_ROUTER() external view returns (address);

    function isSupportedStablecoin(address token) external view returns (bool);

    // ─── Admin ────────────────────────────────────────────────────────────────

    function pause() external;
    function unpause() external;
    function setStakeRouter(IENCStakeRouter newStakeRouter) external;

    // ─── Execute (Deposit) ────────────────────────────────────────────────────

    function executeDeposit(
        uint8[] calldata slots,
        address depositToken,
        uint256 totalDeposit,
        uint256[] calldata minTokenOuts,
        bytes[] calldata swapPaths,
        address referrer
    ) external payable;

    // ─── Profit Distribution ──────────────────────────────────────────────────

    function processProfit(ProfitParams calldata params) external;

    // ─── Exit (Withdraw) ──────────────────────────────────────────────────────

    function requestExit(ExitParams calldata params) external;

    function executeExit(bytes32 requestId) external;

    function withdrawExit(address user, uint8 slot) external;
}
