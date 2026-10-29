// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {
    ReentrancyGuardTransient
} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {
    SafeERC20
} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    IERC20Permit
} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {EnishiConstants} from "./libraries/EnishiConstants.sol";
import {EnishiAddresses} from "./libraries/EnishiAddresses.sol";
import {UniversalRouterGuard} from "./libraries/UniversalRouterGuard.sol";
import {IVault} from "./interfaces/IVault.sol";
import {IEnToken} from "./interfaces/IEnToken.sol";
import {IWhiteList} from "./interfaces/IWhiteList.sol";
import {ISwapContractFactory} from "./interfaces/ISwapContractFactory.sol";
import {ISwapContract} from "./interfaces/ISwapContract.sol";
import {IReferralRegistry} from "./interfaces/IReferralRegistry.sol";
import {IENCCommission} from "./interfaces/IENCCommission.sol";
import {IENCStakeRouter} from "./interfaces/IENCStakeRouter.sol";
import {IENC} from "./interfaces/IENC.sol";
import {IDexRouterV3, IDexQuoterV3} from "./interfaces/IDexRouter.sol";
import {IPermit2} from "./interfaces/IPermit2.sol";

/**
 * @title  Vault
 */
contract Vault is IVault, Ownable, Pausable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using Address for address payable;
    using Address for address;
    using SafeCast for uint256;

    // ─── Constants ────────────────────────────────────────────────────────────

    uint8 public constant STRATEGY_COUNT = EnishiConstants.STRATEGY_COUNT;

    uint8 public constant MIN_STRATEGIES = EnishiConstants.MIN_STRATEGIES;

    /// @notice Minimum total deposit per Execute.
    uint256 public constant MIN_DEPOSIT = EnishiConstants.MIN_DEPOSIT;

    uint16 public constant FUND_COMMISSION_BPS =
        EnishiConstants.FUND_COMMISSION_BPS;

    uint16 public constant BPS_DENOMINATOR = EnishiConstants.BPS_DENOMINATOR;

    /// @notice Minimum BNB forwarded to each SEOA for swap gas.
    uint256 public constant MIN_BNB_PER_SEOA = EnishiConstants.MIN_BNB_PER_SEOA;

    // ─── Immutables ───────────────────────────────────────────────────────────

    IWhiteList public immutable WHITELIST;
    ISwapContractFactory public immutable SWC_FACTORY;
    IReferralRegistry public immutable REFERRAL_REGISTRY;
    IENCCommission public immutable ENC_COMMISSION;
    /// @notice Source of the discounted ENC commission: Public Sale lots
    ///         first, then the ENC lock (see {IENCStakeRouter}).
    IENCStakeRouter public STAKE_ROUTER;
    IENC public immutable ENC;
    address public immutable FUND_WALLET;

    /// @notice PancakeSwap V3 SwapRouter.
    address public constant DEX_ROUTER = EnishiAddresses.PANCAKE_V3;

    /// @notice PancakeSwap V3 QuoterV2.
    address public constant DEX_QUOTER = EnishiAddresses.PANCAKE_V3_QUOTER;

    /// @notice Permit2 the Universal Router pulls input tokens through.
    address public constant PERMIT2 = EnishiAddresses.PANCAKE_PERMIT2;

    /// @notice PancakeSwap classic (V2+V3) Universal Router.
    address public constant UNIVERSAL_ROUTER =
        EnishiAddresses.PANCAKE_UNIVERSAL_ROUTER_V2_V3;

    address public constant STABLE_USDT = EnishiAddresses.BSC_USDT;

    // ─── State ────────────────────────────────────────────────────────────────

    struct ExitRequest {
        uint128 amount;
        uint64 requestTime;
        bool payoutStable;
    }
    mapping(address user => mapping(uint8 slot => ExitRequest))
        public exitRequestOf;

    struct DepositContext {
        address user;
        address depositToken;
        bool firstDeposit;
        bool topUpBnb;
        uint256 bnbPerSeoa;
        address[] strategyTokens;
        address[] seoas;
        address[] swcs;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    /**
     * @notice Deploy the Vault and wire all protocol dependencies.
     * @param whitelist_ WhiteList for SEOA picks.
     * @param factory_   SwapContractFactory for SWC creation.
     * @param referral_  ReferralRegistry for referrer linking.
     */
    constructor(
        IWhiteList whitelist_,
        ISwapContractFactory factory_,
        IReferralRegistry referral_,
        IENCCommission encCommission_,
        IENCStakeRouter stakeRouter_,
        IENC enc_,
        address fundWallet_
    ) Ownable(msg.sender) {
        if (
            address(whitelist_) == address(0) ||
            address(factory_) == address(0) ||
            address(referral_) == address(0) ||
            address(encCommission_) == address(0) ||
            address(stakeRouter_) == address(0) ||
            address(enc_) == address(0) ||
            fundWallet_ == address(0)
        ) revert ZeroAddress();

        WHITELIST = whitelist_;
        SWC_FACTORY = factory_;
        REFERRAL_REGISTRY = referral_;
        ENC_COMMISSION = encCommission_;
        STAKE_ROUTER = stakeRouter_;
        ENC = enc_;
        FUND_WALLET = fundWallet_;

        IERC20(STABLE_USDT).forceApprove(PERMIT2, type(uint256).max);
        _approveRouterPermit2();
    }

    /// @notice Returns true if `token` is the supported stablecoin (USDT).
    function isSupportedStablecoin(address token) public pure returns (bool) {
        return EnishiAddresses.isSupportedStablecoin(token);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @notice Pause new deposits ({executeDeposit}). Owner only. Exit and
    ///         profit settlement stay open, so users can always withdraw.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume deposits after a pause. Owner only.
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Replace the ENC stake router (e.g. when upgrading commission-discount logic).
     * @param  newStakeRouter New ENC stake router; must be non-zero.
     */
    function setStakeRouter(IENCStakeRouter newStakeRouter) external onlyOwner {
        if (address(newStakeRouter) == address(0)) revert ZeroAddress();
        emit StakeRouterUpdated(address(STAKE_ROUTER), address(newStakeRouter));
        STAKE_ROUTER = newStakeRouter;
    }

    // ─── Execute (Deposit) ────────────────────────────────────────────────────

    /**
     * @notice Deposit stablecoins into one or more strategy slots, bootstrapping the user on first call.
     * @param slots         Strategy slots to deposit into; unique, < STRATEGY_COUNT.
     * @param depositToken  Stablecoin to deposit (USDT).
     * @param totalDeposit  Total deposit, split evenly across slots.
     * @param minTokenOuts  Per-slot slippage guard (length == slots.length).
     * @param swapPaths     Per-slot Universal Router `execute()` calldata
     *                      (depositToken → strategy token) built off-chain via
     *                      the universal-router-sdk with payer = Permit2 and
     *                      recipient = this Vault. Length == slots.length. The
     *                      encoded amountIn must equal this slot's share of
     *                      totalDeposit (last slot carries the remainder).
     * @param referrer      Referrer; used only on the first deposit.
     */
    function executeDeposit(
        uint8[] calldata slots,
        address depositToken,
        uint256 totalDeposit,
        uint256[] calldata minTokenOuts,
        bytes[] calldata swapPaths,
        address referrer
    ) external payable nonReentrant whenNotPaused {
        uint256 strategyCount = slots.length;
        if (strategyCount < MIN_STRATEGIES || strategyCount > STRATEGY_COUNT) {
            revert InvalidStrategyCount(strategyCount);
        }
        if (totalDeposit < MIN_DEPOSIT) {
            revert DepositBelowMinimum(MIN_DEPOSIT, totalDeposit);
        }
        if (minTokenOuts.length != strategyCount) revert LengthMismatch();
        if (swapPaths.length != strategyCount) revert LengthMismatch();
        if (!isSupportedStablecoin(depositToken)) {
            revert UnsupportedStablecoin(depositToken);
        }

        bool topUpBnb = msg.value != 0;
        uint256 bnbPerSeoa = msg.value / strategyCount;
        if (topUpBnb && bnbPerSeoa < MIN_BNB_PER_SEOA) {
            revert BnbBelowMinimum(MIN_BNB_PER_SEOA, bnbPerSeoa);
        }

        /* Split evenly; remainder goes to the last slot. */
        uint256 amountPerSlot = totalDeposit / strategyCount;
        if (amountPerSlot == 0) revert ZeroAmount();
        uint256 remainder = totalDeposit - amountPerSlot * strategyCount;

        address user = _msgSender();

        bool firstDeposit = !WHITELIST.userPicked(user);

        if (REFERRAL_REGISTRY.parentOf(user) == address(0)) {
            if (referrer == address(0)) revert ReferrerRequired();
            REFERRAL_REGISTRY.registerWithReferrer(user, referrer);
        }

        /* Pull the deposit stablecoin from the user. */
        IERC20(depositToken).safeTransferFrom(
            user,
            address(this),
            totalDeposit
        );

        address[] memory strategyTokens;

        address[] memory seoas;
        address[] memory swcs;
        if (firstDeposit) {
            strategyTokens = _strategyTokensSnapshot();
            (seoas, swcs) = _bootstrapUser(user, strategyTokens);
            if (topUpBnb && seoas.length != STRATEGY_COUNT)
                revert LengthMismatch();
        } else if (topUpBnb) {
            seoas = WHITELIST.getUserSEOAs(user);
            if (seoas.length != STRATEGY_COUNT) revert LengthMismatch();
        }

        DepositContext memory ctx = DepositContext({
            user: user,
            depositToken: depositToken,
            firstDeposit: firstDeposit,
            topUpBnb: topUpBnb,
            bnbPerSeoa: bnbPerSeoa,
            strategyTokens: strategyTokens,
            seoas: seoas,
            swcs: swcs
        });

        // Process each slot.
        uint256 lastIndex = strategyCount - 1;
        uint256 seenMask;
        for (uint256 i; i < strategyCount; ) {
            uint8 slot = slots[i];
            if (slot >= STRATEGY_COUNT) revert InvalidSlot(slot);

            uint256 bit = 1 << slot;
            if ((seenMask & bit) != 0) revert DuplicateSlot(slot);
            seenMask |= bit;

            uint256 amount = (i == lastIndex)
                ? amountPerSlot + remainder
                : amountPerSlot;

            _processSlot(ctx, slot, amount, minTokenOuts[i], swapPaths[i]);

            unchecked {
                ++i;
            }
        }
    }

    function _processSlot(
        DepositContext memory ctx,
        uint8 slot,
        uint256 amount,
        uint256 minTokenOut,
        bytes calldata path
    ) internal {
        if (exitRequestOf[ctx.user][slot].amount != 0) {
            revert DepositBlockedByPendingExit(slot);
        }

        address availableToken = ctx.firstDeposit
            ? ctx.strategyTokens[slot]
            : _strategyTokenAt(slot);
        address receipt = _receiptAt(slot);
        if (receipt == address(0)) revert ReceiptNotConfigured(availableToken);

        address swc = ctx.firstDeposit
            ? ctx.swcs[slot]
            : SWC_FACTORY.swcOf(ctx.user, availableToken);
        if (swc == address(0)) revert SwcNotFound(ctx.user, availableToken);

        uint256 tokenOut = _swapViaUniversalRouter(
            ctx.depositToken,
            availableToken,
            amount,
            minTokenOut,
            path
        );
        // Mint receipt to user, 1:1 with tokens received from the swap.
        IEnToken(receipt).mint(ctx.user, tokenOut);
        IERC20(availableToken).forceApprove(swc, tokenOut);
        ISwapContract(swc).deposit(availableToken, tokenOut);

        // Transfer BNB to SEOA.
        if (ctx.topUpBnb) {
            address payable seoa = payable(ctx.seoas[slot]);
            if (seoa == address(0)) revert ZeroAddress();
            seoa.sendValue(ctx.bnbPerSeoa);
            emit SeoaFunded(ctx.user, seoa, ctx.bnbPerSeoa);
        }

        emit Deposited(ctx.user, slot, availableToken, amount, tokenOut, swc);
    }

    // ─── Profit Distribution (Fund System) ───────────────────────────────────

    /**
     * @notice Distribute realised profit: pull stablecoin from the calling SWC, split between
     *         fund commission, ENC commission, and user payout.
     * @param  params See {ProfitParams}.
     * @dev    Callable only by the SWC registered for (params.user, params.availableToken).
     */
    function processProfit(ProfitParams calldata params) external nonReentrant {
        address swc = _msgSender();
        if (SWC_FACTORY.swcOf(params.user, params.availableToken) != swc) {
            revert UnauthorizedSettler(swc);
        }
        _processProfit(params, swc);
    }

    function _processProfit(ProfitParams calldata p, address swc) internal {
        if (p.user == address(0)) revert ZeroAddress();
        if (p.availableToken == address(0)) revert ZeroAddress();
        if (p.grossProfit == 0) revert NothingToProcess();
        if (!isSupportedStablecoin(p.payoutToken)) {
            revert UnsupportedStablecoin(p.payoutToken);
        }

        // Pull the stablecoin from the SWC into the Vault atomically.
        // This ensures grossProfit cannot exceed what the SWC actually holds,
        // preventing a caller-inflated grossProfit from draining Vault balances.
        IERC20(p.payoutToken).safeTransferFrom(
            swc,
            address(this),
            p.grossProfit
        );

        (
            uint256 fundCommission,
            uint256 encCommissionStable,
            uint256 userPayout
        ) = _distributeProfit(
                p.user,
                p.payoutToken,
                p.grossProfit,
                p.minEncOut,
                p.encPath
            );

        emit ProfitProcessed(
            p.user,
            p.availableToken,
            p.payoutToken,
            p.grossProfit,
            fundCommission,
            encCommissionStable,
            userPayout,
            0
        );
    }

    function _distributeProfit(
        address user,
        address payoutToken,
        uint256 grossProfit,
        uint256 minEncOut,
        bytes calldata encPath
    )
        internal
        returns (
            uint256 fundCommission,
            uint256 encCommissionStable,
            uint256 userPayout
        )
    {
        // Fund Commission (20%) -> Fund Wallet.
        fundCommission = _takeFundCommission(user, payoutToken, grossProfit);

        uint256 netProfit;
        unchecked {
            netProfit = grossProfit - fundCommission;
        }

        // ENC Commission -> ENC Commission Contract (split 40/10/20/30).
        encCommissionStable = _settleEncCommission(
            user,
            payoutToken,
            minEncOut,
            netProfit,
            encPath
        );

        // Remainder -> user.
        unchecked {
            userPayout = netProfit - encCommissionStable;
        }
        _payoutUser(user, payoutToken, userPayout);
    }

    // ─── Exit (Withdraw) ──────────────────────────────────────────────────────────

    /// @notice Initiate an exit for a single strategy slot; starts the 48-hour delay.
    function requestExit(ExitParams calldata e) external nonReentrant {
        _requestExit(e);
    }

    /// @notice Initiate exits for multiple slots in one transaction.
    function requestExitMany(
        ExitParams[] calldata exits
    ) external nonReentrant {
        uint256 len = exits.length;
        if (len == 0) revert EmptyInput();
        for (uint256 i; i < len; ) {
            _requestExit(exits[i]);
            unchecked {
                ++i;
            }
        }
    }

    function _requestExit(ExitParams calldata e) internal {
        address user = _msgSender();
        uint8 slot = e.slot;
        if (slot >= STRATEGY_COUNT) revert InvalidSlot(slot);
        if (exitRequestOf[user][slot].amount != 0) {
            revert ExitAlreadyPending(slot);
        }

        address availableToken = _strategyTokenAt(slot);
        address receipt = _receiptAt(slot);
        if (receipt == address(0)) revert ReceiptNotConfigured(availableToken);

        address swc = SWC_FACTORY.swcOf(user, availableToken);
        if (swc == address(0)) revert SwcNotFound(user, availableToken);

        uint256 amount = ISwapContract(swc).depositedAmount();
        if (amount == 0) revert NothingToExit(slot);

        /*
            Best-effort permit: anyone can lift the signature from the mempool
            and submit it first, burning the nonce. That grants the same
            allowance, so a failed permit is ignored — the transferFrom below
            still reverts if the allowance is missing. Also lets contract
            wallets (no ECDSA key) exit via a plain approve.
        */
        try
            IERC20Permit(receipt).permit(
                user,
                address(this),
                amount,
                e.permitDeadline,
                e.permitV,
                e.permitR,
                e.permitS
            )
        {} catch {}

        /* Lock the receipt (enToken) on the Vault until the delayed withdrawal. */
        IERC20(receipt).safeTransferFrom(user, address(this), amount);

        uint256 stableOut;
        if (e.payoutStable) {
            /* SWC sells everything straight to USDT and locks it until the
               delayed withdrawal. No profit split, so no commission. */
            stableOut = ISwapContract(swc).liquidateForExit(
                availableToken,
                amount,
                e.minConsolidationOuts,
                e.consolidationPaths
            );
        } else {
            /* SWC consolidates deployed tokens and forwards the profit surplus here. */
            uint256 profitInAvailable = ISwapContract(swc).realizeForExit(
                availableToken,
                amount,
                e.minConsolidationOuts,
                e.consolidationPaths
            );
            _settleExitProfit(user, availableToken, amount, profitInAvailable, e);
        }

        uint256 requestedAt = _now();
        exitRequestOf[user][slot] = ExitRequest({
            amount: amount.toUint128(),
            requestTime: uint64(requestedAt),
            payoutStable: e.payoutStable
        });
        bytes32 requestId = bytes32(
            (uint256(uint160(user)) << 96) |
                (uint256(slot) << 88) |
                uint256(uint64(requestedAt))
        );

        if (e.payoutStable) {
            emit ExitStableLocked(requestId, user, slot, stableOut);
        }
        emit ExitStrategyRequested(requestId, swc, user, requestedAt);
    }

    /// @dev CASE A / B: realised exit profit -> payout stablecoin, net of commissions.
    function _settleExitProfit(
        address user,
        address availableToken,
        uint256 amount,
        uint256 profitInAvailable,
        ExitParams calldata e
    ) internal {
        if (profitInAvailable == 0) return;
        if (e.encPath.length == 0) revert EncPathRequired();

        address payoutToken = STABLE_USDT;
        uint256 grossProfit = _swapWithPath(
            availableToken,
            payoutToken,
            profitInAvailable,
            e.minStableOut,
            address(this),
            e.stablePath
        );
        (
            uint256 fundCommission,
            uint256 encCommissionStable,
            uint256 userPayout
        ) = _distributeProfit(
                user,
                payoutToken,
                grossProfit,
                e.minEncOut,
                e.encPath
            );
        uint256 totalAssetUSD = (amount * grossProfit) / profitInAvailable;
        emit ProfitProcessed(
            user,
            availableToken,
            payoutToken,
            grossProfit,
            fundCommission,
            encCommissionStable,
            userPayout,
            totalAssetUSD
        );
    }

    /// @notice Complete a pending exit identified by `requestId` (after the 48-hour delay).
    function executeExit(bytes32 requestId) external nonReentrant {
        /* Decode the (user, slot) packed into the requestId by {requestExit}. */
        _executeExit(
            address(uint160(uint256(requestId) >> 96)),
            uint8(uint256(requestId) >> 88)
        );
    }

    /// @notice Complete a pending exit identified by `user` + `slot` (after the 48-hour delay).
    function withdrawExit(address user, uint8 slot) external nonReentrant {
        _executeExit(user, slot);
    }

    function _executeExit(address user, uint8 slot) internal {
        ExitRequest memory req = exitRequestOf[user][slot];
        if (req.amount == 0) revert NoPendingExit(slot);
        uint256 unlockAt = uint256(req.requestTime) + _exitDelay();
        if (_now() < unlockAt) revert ExitDelayNotElapsed(unlockAt);

        address availableToken = _strategyTokenAt(slot);
        address receipt = _receiptAt(slot);
        address swc = SWC_FACTORY.swcOf(user, availableToken);
        if (swc == address(0)) revert SwcNotFound(user, availableToken);

        if (
            _msgSender() != user &&
            _msgSender() != ISwapContract(swc).operator() &&
            _msgSender() != owner()
        ) revert UnauthorizedExit(_msgSender());

        delete exitRequestOf[user][slot];

        /* The SWC holds the principal in USDT for a payoutStable exit,
           otherwise in the Available Token. */
        address payoutToken = req.payoutStable ? STABLE_USDT : availableToken;
        uint256 payoutAmount = ISwapContract(swc).releasePrincipal(payoutToken);

        /* Burn the locked receipt and pay the principal to the user.
           payoutAmount is 0 on a total loss; the exit still closes so the
           slot is not blocked forever. */
        IEnToken(receipt).burnFromUser(address(this), req.amount);
        if (payoutAmount != 0) {
            IERC20(payoutToken).safeTransfer(user, payoutAmount);
        }

        emit Exited(
            user,
            slot,
            availableToken,
            receipt,
            swc,
            req.amount,
            payoutToken,
            payoutAmount
        );
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _bootstrapUser(
        address user,
        address[] memory strategyTokens
    ) internal returns (address[] memory seoas, address[] memory swcs) {
        seoas = WHITELIST.pick(user);
        swcs = SWC_FACTORY.createBatch(user, seoas, strategyTokens);
    }

    /// @dev Clock for the exit delay. Production behavior is plain
    ///      `block.timestamp`; a testnet-only subclass may override it to
    ///      fast-forward past {EnishiConstants.EXIT_DELAY}. Swap deadlines keep
    ///      using `block.timestamp` — the DEX checks those against real time.
    function _now() internal view virtual returns (uint256) {
        return block.timestamp;
    }

    /// @dev Wait between {requestExit} and {executeExit}. Production behavior
    ///      is the fixed {EnishiConstants.EXIT_DELAY}; a testnet-only subclass
    ///      may override it so testers need not wait the real 48 hours.
    function _exitDelay() internal view virtual returns (uint256) {
        return EnishiConstants.EXIT_DELAY;
    }

    function _strategyTokenAt(uint8 slot) internal pure returns (address) {
        (address available, ) = EnishiAddresses.strategyAt(slot);
        return available;
    }

    function _receiptAt(uint8 slot) internal pure returns (address) {
        (, address receipt) = EnishiAddresses.strategyAt(slot);
        return receipt;
    }

    function _strategyTokensSnapshot()
        internal
        pure
        returns (address[] memory t)
    {
        t = new address[](STRATEGY_COUNT);
        for (uint8 i; i < STRATEGY_COUNT; ) {
            (address available, ) = EnishiAddresses.strategyAt(i);
            t[i] = available;
            unchecked {
                ++i;
            }
        }
    }

    // ─── Internal: Permit2 ────────────────────────────────────────────────────

    /**
     * @dev Open an unlimited, non-expiring Permit2 pull allowance for the
     *      pinned {UNIVERSAL_ROUTER} over the deposit stablecoin, once at
     *      construction — no per-swap approve.
     */
    function _approveRouterPermit2() internal {
        IPermit2 permit2 = IPermit2(PERMIT2);
        permit2.approve(
            STABLE_USDT,
            UNIVERSAL_ROUTER,
            type(uint160).max,
            type(uint48).max
        );
    }

    function _swapViaUniversalRouter(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata swapData
    ) internal returns (uint256 amountOut) {
        uint256 declaredIn = UniversalRouterGuard.validate(
            swapData,
            address(this),
            tokenIn,
            tokenOut
        );
        if (declaredIn != amountIn)
            revert SwapAmountMismatch(declaredIn, amountIn);

        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));

        UNIVERSAL_ROUTER.functionCall(swapData);

        amountOut = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (amountOut < minOut)
            revert InsufficientSwapOutput(amountOut, minOut);
    }

    function _swapWithPath(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        address to,
        bytes calldata path
    ) internal returns (uint256 amountOut) {
        _checkPath(path, tokenIn, tokenOut);

        _approveRouter(tokenIn, amountIn);
        amountOut = IDexRouterV3(DEX_ROUTER).exactInput(
            IDexRouterV3.ExactInputParams({
                path: path,
                recipient: to,
                deadline: block.timestamp +
                    EnishiConstants.SWAP_DEADLINE_BUFFER_SECONDS,
                amountIn: amountIn,
                amountOutMinimum: amountOutMin
            })
        );
    }

    function _checkPath(
        bytes calldata path,
        address tokenIn,
        address tokenOut
    ) private pure {
        if (path.length < 43 || (path.length - 20) % 23 != 0) {
            revert InvalidSwapPath();
        }
        if (_firstToken(path) != tokenIn || _lastToken(path) != tokenOut) {
            revert InvalidSwapPath();
        }
    }

    /// @dev First token (bytes[0:20]) of a packed V3 path.
    function _firstToken(
        bytes calldata path
    ) private pure returns (address token) {
        assembly {
            token := shr(96, calldataload(path.offset))
        }
    }

    /// @dev Last token (bytes[len-20:len]) of a packed V3 path.
    function _lastToken(
        bytes calldata path
    ) private pure returns (address token) {
        assembly {
            token := shr(
                96,
                calldataload(add(path.offset, sub(path.length, 20)))
            )
        }
    }

    // ─── Internal: Profit Distribution ────────────────────────────────────────

    /**
     * @dev Send the Fund Commission ({FUND_COMMISSION_BPS} of `grossProfit`)
     *      in `token` to {FUND_WALLET}, and return the amount taken.
     */
    function _takeFundCommission(
        address user,
        address token,
        uint256 grossProfit
    ) internal returns (uint256 fundCommission) {
        fundCommission = (grossProfit * FUND_COMMISSION_BPS) / BPS_DENOMINATOR;
        if (fundCommission != 0) {
            IERC20(token).safeTransfer(FUND_WALLET, fundCommission);
        }
        emit FundCommissionPaid(user, token, fundCommission);
    }

    /**
     * @dev Compute the ENC Commission and route it to the ENC Commission
     * Contract for the 40/10/20/30 split.
     */
    function _settleEncCommission(
        address user,
        address payoutToken,
        uint256 minEncOut,
        uint256 netProfit,
        bytes calldata encPath
    ) internal returns (uint256 stableSpent) {
        uint256 encAmount = _chargeStake(user, payoutToken, netProfit, encPath);
        bool fromStake = encAmount != 0;

        if (!fromStake) {
            // Take 25% of net from profit and swap it (USDT -> ENC) into the Vault.
            stableSpent =
                (netProfit * EnishiConstants.ENC_COMMISSION_DEFAULT_BPS) /
                BPS_DENOMINATOR;
            if (stableSpent == 0) return 0;

            encAmount = _swapWithPath(
                payoutToken,
                address(ENC),
                stableSpent,
                minEncOut,
                address(this),
                encPath
            );
        }

        if (encAmount == 0) return stableSpent;

        if (!fromStake) {
            IERC20(address(ENC)).safeTransfer(
                address(ENC_COMMISSION),
                encAmount
            );
        }
        ENC_COMMISSION.distribute(user, encAmount);
    }

    /**
     * @dev Charge the commission in ENC from the user's stake, as the stake
     *      router decides: quote ENC once for the amount it names, then let it
     *      pull from the stake straight to the ENC Commission Contract
     *      (Stake → Commission), skipping the Vault hop.
     * @return encAmount ENC the ENC Commission Contract received; 0 when no
     *                   stake covers the commission. Measured from its balance,
     *                   so a faulty router cannot make {ENC_COMMISSION}
     *                   distribute ENC it was never sent.
     */
    function _chargeStake(
        address user,
        address payoutToken,
        uint256 netProfit,
        bytes calldata encPath
    ) internal returns (uint256 encAmount) {
        uint256 quotedStable = STAKE_ROUTER.commissionQuote(user, netProfit);
        if (quotedStable == 0) return 0;

        uint256 quotedEnc = _quoteEnc(payoutToken, quotedStable, encPath);
        if (quotedEnc == 0) return 0;

        address commission = address(ENC_COMMISSION);
        uint256 before = ENC.balanceOf(commission);
        STAKE_ROUTER.chargeCommission(user, netProfit, quotedStable, quotedEnc);
        encAmount = ENC.balanceOf(commission) - before;
    }

    /**
     * @param  stableCoin       Stablecoin to quote from (USDT).
     * @param  stableCoinAmount Amount of `stableCoin` to convert.
     * @param  encPath          Packed V3 route the d-app picked (stableCoin → ENC);
     *                          empty → default route. Must match the route used for
     *                          the actual swap so the stake quote stays consistent.
     * @return encOut           ENC receivable for `stableCoinAmount` at spot.
     */
    function _quoteEnc(
        address stableCoin,
        uint256 stableCoinAmount,
        bytes calldata encPath
    ) internal returns (uint256 encOut) {
        _checkPath(encPath, stableCoin, address(ENC));
        (encOut, , , ) = IDexQuoterV3(DEX_QUOTER).quoteExactInput(
            encPath,
            stableCoinAmount
        );
    }

    function _payoutUser(address user, address token, uint256 amount) internal {
        if (amount == 0) return;
        IERC20(token).safeTransfer(user, amount);
    }

    function _approveRouter(address token, uint256 amount) internal {
        IERC20(token).forceApprove(DEX_ROUTER, amount);
    }
}
