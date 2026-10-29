// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    Initializable
} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {
    ReentrancyGuardTransient
} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {
    SafeERC20
} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ISwapContract} from "./interfaces/ISwapContract.sol";
import {IVault} from "./interfaces/IVault.sol";
import {IDexRouterV3, IWBNB} from "./interfaces/IDexRouter.sol";
import {IPermit2} from "./interfaces/IPermit2.sol";
import {EnishiAddresses} from "./libraries/EnishiAddresses.sol";
import {EnishiConstants} from "./libraries/EnishiConstants.sol";
import {UniversalRouterGuard} from "./libraries/UniversalRouterGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title  SwapContract (SWC)
 * @notice Swap-only Swap Contract deployed as an EIP-1167 minimal proxy
 *         clone. Holds capital, executes DEX swaps on behalf of the mapped
 *         EOA operator, and emits {Profit} on each close as the authoritative
 *         log for off-chain profit accounting (round-1 deploys are covered by
 *         the DEX pool's own `Swap` event).
 *
 *         Roles:
 *           - `operator` (EOA from WhiteList): only caller of {executeSwap}.
 *           - `vault`: rotates `operator` and toggles {pause}/{unpause}.
 *                     `vault` itself is immutable on the clone —
 *                     use a multisig/timelock at deploy time.
 *         The DEX router ({DEX}) is selected from {EnishiAddresses} by
 *         {block.chainid} — same bytecode deploys to BSC mainnet (56) and
 *         testnet (97). To migrate to another router, update
 *         {EnishiAddresses}, redeploy a new implementation, and have the
 *         factory mint clones from it.
 *         `user` is stored on the clone so the SWC can attribute profit when
 *         triggering settlement on the Vault.
 */
contract SwapContract is
    ISwapContract,
    Initializable,
    ReentrancyGuardTransient,
    Pausable
{
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;
    using Address for address payable;
    using Address for address;

    // ─── State ────────────────────────────────────────────────────────────────

    address public operator;

    /// @notice Bitmask of deployed tokens
    uint32 internal deployedMask;

    /// @notice True while the pending exit principal is held in USDT
    ///         ({liquidateForExit}) rather than the Available Token
    ///         ({realizeForExit}). Packs into the `operator` slot.
    bool public pendingStable;

    /// @notice Non-zero while an exit is pending (between realizeForExit /
    ///         liquidateForExit and releasePrincipal). Blocks executeSwap to
    ///         prevent the operator from moving principal out from under a
    ///         pending exit.
    uint128 public pendingPrincipal;

    uint128 public depositedAmount;

    /// @notice Order queue per strategy slot; last element = most recently
    ///         opened order = LIFO-head, the only order the next round-2
    ///         swapback can consume from.
    mapping(address tokenOut => Order[]) internal _ordersOf;

    // ─── Immutable args (clone bytecode, no init SSTORE) ──────────────────────
    function _args()
        internal
        view
        returns (address vault_, address availableToken_, address user_)
    {
        (vault_, availableToken_, user_) = abi.decode(
            Clones.fetchCloneArgs(address(this)),
            (address, address, address)
        );
    }

    function vault() public view returns (address v) {
        (v, , ) = _args();
    }

    function availableTokenAddress() public view returns (address t) {
        (, t, ) = _args();
    }

    function user() public view returns (address u) {
        (, , u) = _args();
    }

    // ─── DEX Router (chainid-pinned) ─────────────────────────────────────────

    function DEX_V3() public pure returns (address) {
        return EnishiAddresses.PANCAKE_V3;
    }

    function UNIVERSAL_ROUTER() public pure returns (address) {
        return EnishiAddresses.PANCAKE_UNIVERSAL_ROUTER_V2_V3;
    }

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        _;
    }

    modifier onlyVault() {
        if (msg.sender != vault()) revert NotVault(msg.sender);
        _;
    }

    modifier noExitPending() {
        if (pendingPrincipal != 0) revert ExitPending();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor() {
        _disableInitializers();
    }

    // ─── Init ─────────────────────────────────────────────────────────────────

    /**
     * @param operator_ EOA from the WhiteList allowed to call {executeSwap}.
     */
    function initialize(address operator_) external initializer {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
    }

    // ─── Operator API ─────────────────────────────────────────────────────────

    /// @inheritdoc ISwapContract
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
    )
        external
        onlyOperator
        nonReentrant
        whenNotPaused
        noExitPending
        returns (uint256 amountOut)
    {
        return
            _execute(
                tokenIn,
                tokenOut,
                swapData,
                amountIn,
                amountOutMin,
                minStableOut,
                minEncOut,
                gasPath,
                encPath,
                stablePath
            );
    }

    /// @inheritdoc ISwapContract
    function executeSwap(
        address tokenIn,
        address tokenOut,
        bytes calldata swapData,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata gasPath,
        bytes calldata encPath,
        bytes calldata stablePath
    )
        external
        onlyOperator
        nonReentrant
        whenNotPaused
        noExitPending
        returns (uint256 amountOut)
    {
        return
            _execute(
                tokenIn,
                tokenOut,
                swapData,
                amountIn,
                amountOutMin,
                0,
                0,
                gasPath,
                encPath,
                stablePath
            );
    }

    // ─── Vault Admin ──────────────────────────────────────────────────────────

    /**
     * @notice Pause {executeSwap}
     */
    function pause() external onlyVault {
        _pause();
    }

    /// @notice Resume {executeSwap} after a pause.
    function unpause() external onlyVault {
        _unpause();
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice Returns the list of strategy tokens currently deployed by this SWC.
    function getDeployedTokens() external view returns (address[] memory list) {
        uint32 mask = deployedMask;
        list = new address[](_popcount(mask));
        uint256 j;
        for (uint8 i; i < EnishiConstants.STRATEGY_COUNT; ) {
            if (mask & (uint32(1) << i) != 0) {
                (address available, ) = EnishiAddresses.strategyAt(i);
                list[j++] = available;
            }
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Returns the number of strategy slots currently holding a deployed position.
    function deployedCount() external view returns (uint256) {
        return _popcount(deployedMask);
    }

    /// @inheritdoc ISwapContract
    function orderCount(address tokenOut) external view returns (uint256) {
        return _ordersOf[tokenOut].length;
    }

    /**
     * @notice Rotate the EOA operator (e.g. compromised key).
     * @param newOperator New operator EOA; must be non-zero.
     */
    function setOperator(address newOperator) external onlyVault {
        if (newOperator == address(0)) revert ZeroAddress();
        address old = operator;
        operator = newOperator;
        emit OperatorUpdated(old, newOperator);
    }

    function deposit(address availableToken, uint256 amount) external onlyVault {
        IERC20(availableToken).safeTransferFrom(msg.sender, address(this), amount);
        depositedAmount += amount.toUint128();
    }

    /**
     * @param  availableToken       Available Token to consolidate into.
     * @param  principal            Amount retained for the delayed withdrawal.
     * @param  minConsolidationOuts Per-slot minimum out for each consolidation
     *                              swap (length == STRATEGY_COUNT). Pass 0 for
     *                              slots with no open position.
     * @param  consolidationSwapData Per-slot Universal Router calldata (strategy token
     *                              → availableToken) the d-app built off-chain.
     *                              Length must equal STRATEGY_COUNT; entries for
     *                              slots with no open position are ignored. The
     *                              encoded amountIn must lie between the slot's
     *                              open-order total and its balance, so a dust
     *                              donation landing first cannot revert the exit.
     * @return profitInAvailable    Surplus sent to the Vault (0 if none).
     */
    function realizeForExit(
        address availableToken,
        uint256 principal,
        uint256[] calldata minConsolidationOuts,
        bytes[] calldata consolidationSwapData
    ) external onlyVault nonReentrant returns (uint256 profitInAvailable) {
        _unwindForExit(
            availableToken,
            availableToken,
            principal,
            minConsolidationOuts,
            consolidationSwapData
        );

        uint256 total = IERC20(availableToken).balanceOf(address(this));
        if (total > principal) {
            unchecked {
                profitInAvailable = total - principal;
            }
            IERC20(availableToken).safeTransfer(msg.sender, profitInAvailable);
        }

        // Lock the remaining principal so executeSwap cannot move it before
        // releasePrincipal is called. Uses min(total, principal) in case of loss.
        pendingPrincipal = (total > principal ? principal : total).toUint128();

        emit ExitRealized(availableToken, principal, profitInAvailable);
    }

    /**
     * @notice Sell every position, including the idle Available Token,
     *         straight to USDT for a stable-payout exit and lock the proceeds
     *         on this SWC until {releasePrincipal}. No profit is split off, so
     *         no commission is charged on gains still open at exit.
     * @param  availableToken Available Token of the exited position.
     * @param  principal      Deposit amount exited, in `availableToken` units.
     * @param  minStableOuts  Per-slot minimum USDT out (length == STRATEGY_COUNT).
     * @param  stableSwapData Per-slot Universal Router calldata (slot token →
     *                        USDT). Length must equal STRATEGY_COUNT. Deployed
     *                        slots follow the {realizeForExit} amount rules; the
     *                        Available Token slot must sell at least
     *                        min(balance, principal) less a 0.1% dust
     *                        tolerance (see {_liquidateIdle}).
     * @return stableOut      USDT locked for the delayed withdrawal (0 on a
     *                        total loss).
     */
    function liquidateForExit(
        address availableToken,
        uint256 principal,
        uint256[] calldata minStableOuts,
        bytes[] calldata stableSwapData
    ) external onlyVault nonReentrant returns (uint256 stableOut) {
        address usdt = EnishiAddresses.BSC_USDT;
        _unwindForExit(
            availableToken,
            usdt,
            principal,
            minStableOuts,
            stableSwapData
        );

        // Lock the whole USDT balance; the SWC holds no USDT between swaps,
        // so anything here belongs to this user's position.
        stableOut = IERC20(usdt).balanceOf(address(this));
        pendingPrincipal = stableOut.toUint128();
        pendingStable = true;

        emit ExitLiquidated(availableToken, principal, stableOut);
    }

    /**
     * @notice Hand the principal locked by {realizeForExit} or
     *         {liquidateForExit} to the Vault. Returns 0 instead of reverting
     *         when nothing is locked (a total loss leaves `pendingPrincipal`
     *         at 0), so the Vault can still close the exit rather than
     *         leaving it pending forever.
     * @param  token  Token the principal is held in: USDT after
     *                {liquidateForExit}, otherwise the Available Token.
     * @return amount Amount transferred to the Vault (0 on total loss).
     */
    function releasePrincipal(
        address token
    ) external onlyVault nonReentrant returns (uint256 amount) {
        if (token == address(0)) revert ZeroAddress();
        bool stable = pendingStable;
        address expected = stable
            ? EnishiAddresses.BSC_USDT
            : availableTokenAddress();
        if (token != expected) revert InvalidPayoutToken(token, expected);

        amount = pendingPrincipal;
        address v = msg.sender;
        if (stable) pendingStable = false;
        if (amount != 0) {
            pendingPrincipal = 0;
            IERC20(token).safeTransfer(v, amount);
        }
        emit ExitWithdrawn(token, v, amount);
    }

    // ─── Internal ───────────────────────────────────────────────────────────────

    /**
     * @dev Profit params ignored on round-1. On round-2, {_realizeProfit} fires
     *      automatically when `profitDelta > 0`, paying out in USDT.
     */
    function _execute(
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
    ) internal returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();

        if (
            tokenIn == tokenOut ||
            tokenIn == address(0) ||
            tokenOut == address(0)
        ) revert InvalidPath();

        uint256 deadline = block.timestamp +
            EnishiConstants.SWAP_DEADLINE_BUFFER_SECONDS;

        (address vlt, address avail, address usr) = _args();
        bool round1 = tokenIn == avail;
        bool round2 = tokenOut == avail;
        if (!(round1 || round2)) revert InvalidPath();

        if (!_isWhitelistedToken(tokenIn)) revert TokenNotWhitelisted(tokenIn);
        if (!_isWhitelistedToken(tokenOut))
            revert TokenNotWhitelisted(tokenOut);

        if (round2 && _ordersOf[tokenIn].length == 0) revert InvalidPath();

        amountOut = _swapViaUniversalRouter(
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            swapData
        );

        address payoutToken = EnishiAddresses.BSC_USDT;

        int256 profitDelta;
        if (round1) {
            Order[] storage orders = _ordersOf[tokenOut];
            if (orders.length == 0) _trackDeployed(tokenOut);

            uint128 costBasis128 = amountIn.toUint128();
            uint128 assetAmount128 = amountOut.toUint128();
            orders.push(
                Order({costBasis: costBasis128, assetAmount: assetAmount128})
            );

            emit OrderOpened(tokenOut, orders.length - 1, costBasis128, assetAmount128);
        } else {
            Order[] storage orders = _ordersOf[tokenIn];
            uint256 len = orders.length;
            if (len == 0) revert InvalidPath();

            Order memory head = orders[len - 1];
            // Orders always close in full in a single call — no partial
            // fill, so no proportional cost-basis calculation (and no
            // rounding) is needed.
            if (amountIn != head.assetAmount)
                revert InsufficientOrderAmount(head.assetAmount, amountIn);

            orders.pop();

            profitDelta = amountOut.toInt256() - int256(uint256(head.costBasis));
            if (orders.length == 0) _untrackDeployed(tokenIn);

            emit Profit(
                tokenIn,
                tokenOut,
                amountIn,
                amountOut,
                profitDelta,
                payoutToken
            );
        }

        // Round-2 only: realize the *profit* atomically in the same call.
        if (round2 && profitDelta > 0) {
            _realizeProfit(
                uint256(profitDelta),
                payoutToken,
                minStableOut,
                minEncOut,
                gasPath,
                stablePath,
                deadline,
                vlt,
                avail,
                usr,
                encPath
            );
        }
    }

    /**
     * @dev Execute pre-built Universal Router calldata against the pinned
     *      {UNIVERSAL_ROUTER}.
    */
    function _swapViaUniversalRouter(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata swapData
    ) internal returns (uint256 amountOut) {
        uint256 declaredIn = UniversalRouterGuard.validate(
            swapData,
            address(this),
            tokenIn,
            tokenOut
        );
        if (declaredIn != amountIn) revert SwapAmountMismatch(declaredIn, amountIn);

        amountOut = _runUniversalRouter(
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            swapData
        );
    }

    /**
     * @dev Shared unwind for {realizeForExit} (`tokenOut` = Available Token)
     *      and {liquidateForExit} (`tokenOut` = USDT). Sells every deployed
     *      slot into `tokenOut` and clears the order book. When `tokenOut` is
     *      not the Available Token, the idle Available Token is sold too (see
     *      {_liquidateIdle}).
     */
    function _unwindForExit(
        address availableToken,
        address tokenOut,
        uint256 principal,
        uint256[] calldata minOuts,
        bytes[] calldata swapData
    ) private {
        if (availableToken == address(0)) revert ZeroAddress();
        address expected = availableTokenAddress();
        if (availableToken != expected) {
            revert AvailableTokenMismatch(availableToken, expected);
        }
        if (
            minOuts.length != EnishiConstants.STRATEGY_COUNT ||
            swapData.length != EnishiConstants.STRATEGY_COUNT
        ) revert LengthMismatch();

        depositedAmount -= principal.toUint128();

        // Slot of the idle Available Token to sell; none when unwinding into it.
        uint8 idleSlot = tokenOut == availableToken
            ? type(uint8).max
            : _strategyIndexOf(availableToken);
        uint32 mask = deployedMask;
        for (uint8 i; i < EnishiConstants.STRATEGY_COUNT; ) {
            if (mask & (uint32(1) << i) != 0) {
                (address dt, ) = EnishiAddresses.strategyAt(i);
                uint256 bal = IERC20(dt).balanceOf(address(this));
                // No swap needed when the strategy token is already tokenOut.
                if (bal != 0 && dt != tokenOut) {
                    _consolidate(
                        dt,
                        tokenOut,
                        bal,
                        _openAmountOf(dt),
                        minOuts[i],
                        swapData[i]
                    );
                }
                delete _ordersOf[dt];
            } else if (i == idleSlot) {
                _liquidateIdle(
                    availableToken,
                    tokenOut,
                    principal,
                    minOuts[i],
                    swapData[i]
                );
            }
            unchecked {
                ++i;
            }
        }
        deployedMask = 0;
    }

    /**
     * @dev Sell the idle Available Token for {liquidateForExit}. The leg must
     *      cover min(balance, principal) less a dust tolerance of
     *      {EnishiConstants.EXIT_DUST_TOLERANCE_BPS} of the principal, so the
     *      principal is not left behind, yet a donation landing after the
     *      calldata was built only reverts the exit if it exceeds that
     *      tolerance. Empty `swapData` is accepted while the balance is
     *      within the tolerance (e.g. a fully deployed principal plus dust).
     */
    function _liquidateIdle(
        address availableToken,
        address tokenOut,
        uint256 principal,
        uint256 minOut,
        bytes calldata swapData
    ) private {
        uint256 bal = IERC20(availableToken).balanceOf(address(this));
        uint256 tolerance = (principal *
            EnishiConstants.EXIT_DUST_TOLERANCE_BPS) /
            EnishiConstants.BPS_DENOMINATOR;
        if (bal == 0 || (swapData.length == 0 && bal <= tolerance)) return;

        uint256 target = bal < principal ? bal : principal;
        uint256 floor;
        if (target > tolerance) {
            unchecked {
                floor = target - tolerance;
            }
        }
        _consolidate(availableToken, tokenOut, bal, floor, minOut, swapData);
    }

    /**
     * @dev Consolidation swap for {_unwindForExit}. Unlike {executeSwap}, the
     *      declared amountIn need not equal the live balance: anyone can send
     *      dust to the SWC, which would otherwise revert the user's exit. It
     *      must still cover `floor` (open orders, or see {_liquidateIdle} for
     *      the Available Token leg), capped at the balance, so the full
     *      position is sold, and not exceed the balance. Donated dust is left
     *      behind.
     */
    function _consolidate(
        address tokenIn,
        address tokenOut,
        uint256 bal,
        uint256 floor,
        uint256 amountOutMin,
        bytes calldata swapData
    ) internal {
        uint256 declaredIn = UniversalRouterGuard.validate(
            swapData,
            address(this),
            tokenIn,
            tokenOut
        );

        uint256 minIn = floor < bal ? floor : bal;
        if (declaredIn < minIn || declaredIn > bal) {
            revert ConsolidationAmountOutOfRange(declaredIn, minIn, bal);
        }

        _runUniversalRouter(
            tokenIn,
            tokenOut,
            declaredIn,
            amountOutMin,
            swapData
        );
    }

    /// @dev Total `assetAmount` across the open orders of `token`.
    function _openAmountOf(address token) internal view returns (uint256 total) {
        Order[] storage orders = _ordersOf[token];
        uint256 len = orders.length;
        for (uint256 i; i < len; ) {
            total += orders[i].assetAmount;
            unchecked {
                ++i;
            }
        }
    }

    /// @dev Grant the pinned router a Permit2 allowance of exactly `amountIn`
    ///      for this block, run the pre-validated `swapData` and measure the
    ///      `tokenOut` received.
    function _runUniversalRouter(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata swapData
    ) private returns (uint256 amountOut) {
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));

        if (
            IERC20(tokenIn).allowance(
                address(this),
                EnishiAddresses.PANCAKE_PERMIT2
            ) < amountIn
        ) {
            IERC20(tokenIn).forceApprove(
                EnishiAddresses.PANCAKE_PERMIT2,
                type(uint256).max
            );
        }
        IPermit2(EnishiAddresses.PANCAKE_PERMIT2).approve(
            tokenIn,
            UNIVERSAL_ROUTER(),
            amountIn.toUint160(),
            uint48(block.timestamp)
        );
        UNIVERSAL_ROUTER().functionCall(swapData);

        amountOut = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (amountOut < amountOutMin)
            revert InsufficientOutput(amountOut, amountOutMin);
    }

    function _strategyIndexOf(address token) internal pure returns (uint8) {
        for (uint8 i; i < EnishiConstants.STRATEGY_COUNT; ) {
            (address available, ) = EnishiAddresses.strategyAt(i);
            if (token == available) return i;
            unchecked {
                ++i;
            }
        }
        return type(uint8).max;
    }

    function _isWhitelistedToken(address token) internal pure returns (bool) {
        return _strategyIndexOf(token) != type(uint8).max;
    }

    function _receiptOf(address avail) internal pure returns (address) {
        for (uint8 i; i < EnishiConstants.STRATEGY_COUNT; ) {
            (address available, address receipt) = EnishiAddresses.strategyAt(i);
            if (avail == available) return receipt;
            unchecked {
                ++i;
            }
        }
        return address(0);
    }

    function _trackDeployed(address token) internal {
        deployedMask |= uint32(1) << _strategyIndexOf(token);
    }

    function _untrackDeployed(address token) internal {
        deployedMask &= ~(uint32(1) << _strategyIndexOf(token));
    }

    /// @dev Number of set bits in a 32-bit mask (Kernighan).
    function _popcount(uint32 x) private pure returns (uint256 count) {
        unchecked {
            for (; x != 0; ++count) {
                x &= x - 1;
            }
        }
    }

    /**
     * @dev Shared body for profit realization. No modifiers —
     *      callers must have already applied {onlyOperator}, {nonReentrant},
     *      {whenNotPaused}.
     */
    function _realizeProfit(
        uint256 profitAmount,
        address payoutToken,
        uint256 minStableOut,
        uint256 minEncOut,
        bytes calldata gasPath,
        bytes calldata stablePath,
        uint256 deadline,
        address vlt,
        address avail,
        address usr,
        bytes calldata encPath
    ) internal returns (uint256 stableToVault) {
        if (profitAmount == 0) revert ZeroAmount();
        if (payoutToken == address(0)) revert ZeroAddress();
        if (payoutToken == avail) revert InvalidPath();

        address dex = DEX_V3();
        uint256 availSpentOnGas = _chargeOperatorGas(
            avail,
            dex,
            profitAmount,
            gasPath,
            deadline
        );
        uint256 toStable = profitAmount - availSpentOnGas;

        stableToVault = _swapProfitToStable(
            avail,
            payoutToken,
            toStable,
            minStableOut,
            deadline,
            dex,
            stablePath
        );

        address receipt = _receiptOf(avail);

        uint256 totalAssetUSD;
        uint256 tvlUSD;
        if (toStable != 0) {
            totalAssetUSD = (depositedAmount * stableToVault) / toStable;
            tvlUSD = (IERC20(receipt).totalSupply() * stableToVault) / toStable;
        }

        emit ProfitRealized(
            avail,
            profitAmount,
            availSpentOnGas,
            stableToVault,
            receipt,
            totalAssetUSD,
            tvlUSD
        );

        if (stableToVault != 0) {
            _settleWithVault(
                vlt,
                avail,
                payoutToken,
                usr,
                stableToVault,
                minEncOut,
                encPath
            );
        }
    }

    /// @dev Swaps `amount` of `avail` → `payoutToken` via the caller-supplied
    ///      `stablePath`, holding the result in this SWC.
    function _swapProfitToStable(
        address avail,
        address payoutToken,
        uint256 amount,
        uint256 minStableOut,
        uint256 deadline,
        address dex,
        bytes calldata stablePath
    ) private returns (uint256 stableOut) {
        if (amount == 0) return 0;

        if (
            _firstToken(stablePath) != avail ||
            _lastToken(stablePath) != payoutToken
        ) revert InvalidPath();

        IERC20(avail).forceApprove(dex, amount);
        stableOut = IDexRouterV3(dex).exactInput(
            IDexRouterV3.ExactInputParams({
                path: stablePath,
                recipient: address(this),
                deadline: deadline,
                amountIn: amount,
                amountOutMinimum: minStableOut
            })
        );
    }

    /// @dev Approves Vault to pull `grossProfit` then calls Vault.processProfit.
    function _settleWithVault(
        address vlt,
        address avail,
        address payoutToken,
        address usr,
        uint256 grossProfit,
        uint256 minEncOut,
        bytes calldata encPath
    ) private {
        IERC20(payoutToken).forceApprove(vlt, grossProfit);
        IVault(vlt).processProfit(
            IVault.ProfitParams({
                user: usr,
                availableToken: avail,
                grossProfit: grossProfit,
                payoutToken: payoutToken,
                minEncOut: minEncOut,
                encPath: encPath
            })
        );
    }

    function _chargeOperatorGas(
        address avail,
        address dex,
        uint256 maxIn,
        bytes calldata gasPath,
        uint256 deadline
    ) internal returns (uint256 spent) {
        address payable op = payable(operator);
        uint256 half = EnishiConstants.MIN_BNB_PER_SEOA / 2;
        if (op.balance >= half) return 0;

        address wbnb = _wbnb();

        if (avail == wbnb) {
            uint256 bnbNeeded = EnishiConstants.MIN_BNB_PER_SEOA - op.balance;
            uint256 wrap = bnbNeeded > maxIn ? maxIn : bnbNeeded;
            if (wrap == 0) return 0;
            IWBNB(wbnb).withdraw(wrap);
            op.sendValue(wrap);
            return wrap;
        }

        if (gasPath.length == 0) return 0;

        _validateGasPath(gasPath, avail, wbnb);

        uint256 remaining = EnishiConstants.MIN_BNB_PER_SEOA - op.balance;
        uint256 amountOut = remaining > maxIn ? maxIn : remaining;

        IERC20(avail).forceApprove(dex, maxIn);

        try
            IDexRouterV3(dex).exactOutput(
                IDexRouterV3.ExactOutputParams({
                    path: _reversePath(gasPath),
                    recipient: address(this),
                    deadline: deadline,
                    amountOut: amountOut,
                    amountInMaximum: maxIn
                })
            )
        returns (uint256 amountInSpent) {
            spent = amountInSpent;
            IWBNB(wbnb).withdraw(amountOut);
            op.sendValue(amountOut);
        } catch {}
        IERC20(avail).forceApprove(dex, 0);
    }

    function _validateGasPath(
        bytes calldata gasPath,
        address avail,
        address wbnb
    ) private pure {
        uint256 len = gasPath.length;
        // Packed V3 path: token(20) | fee(3) | token(20) | … | token(20).
        if (len < 43 || (len - 20) % 23 != 0) revert InvalidPath();
        if (_firstToken(gasPath) != avail || _lastToken(gasPath) != wbnb)
            revert InvalidPath();
    }

    /// @dev First 20-byte token address of a packed V3 path.
    function _firstToken(bytes calldata path) private pure returns (address token) {
        assembly {
            token := shr(96, calldataload(path.offset))
        }
    }

    /// @dev Last 20-byte token address of a packed V3 path.
    function _lastToken(bytes calldata path) private pure returns (address token) {
        assembly {
            token := shr(96, calldataload(add(path.offset, sub(path.length, 20))))
        }
    }

    /// @dev Reverses a packed V3 path `abi.encodePacked(t0, fee, t1, fee, t2)`
    ///      into `abi.encodePacked(t2, fee, t1, fee, t0)` for exactOutput calls.
    function _reversePath(
        bytes calldata path
    ) private pure returns (bytes memory rev) {
        // Each hop = 20 (address) + 3 (fee). Full path = 20 + n*23 bytes, n >= 1.
        uint256 len = path.length;
        rev = new bytes(len);
        // "memory-safe": only accesses memory allocated by `new bytes(len)` above.
        assembly ("memory-safe") {
            let src := path.offset
            // Skip the 32-byte length slot to get to rev's data region.
            let dst := add(rev, 32)
            let hops := div(sub(len, 20), 23)

            for { let i := 0 } iszero(gt(i, hops)) { i := add(i, 1) } {
                let srcOff := mul(i, 23)
                let dstOff := mul(sub(hops, i), 23)

                // Copy 20-byte address via calldataload + mstore8 (no Solidity bounds checks).
                let addrWord := calldataload(add(src, srcOff))
                for { let b := 0 } lt(b, 20) { b := add(b, 1) } {
                    mstore8(add(dst, add(dstOff, b)), byte(b, addrWord))
                }

                // Copy the 3-byte fee that follows token[i] in the forward path.
                // In the reversed path it lands just before token[i]'s slot (dstOff - 3).
                if lt(i, hops) {
                    let feeWord := calldataload(add(src, add(srcOff, 20)))
                    let fdst := add(dst, sub(dstOff, 3))
                    mstore8(fdst,         byte(0, feeWord))
                    mstore8(add(fdst, 1), byte(1, feeWord))
                    mstore8(add(fdst, 2), byte(2, feeWord))
                }
            }
        }
    }

    /// @dev Wrapped BNB address.
    function _wbnb() internal pure returns (address) {
        return EnishiAddresses.WBNB;
    }

    /// @notice Accept native BNB from WBNB unwraps during gas top-ups.
    receive() external payable {}
}
