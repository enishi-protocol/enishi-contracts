// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice Wrapped BNB (WBNB) surface.
 *
 */
interface IWBNB {
    function deposit() external payable;

    function withdraw(uint256 amount) external;
}

/**
 * @title  IDexRouterV2
 */
interface IDexRouterV2 {
    /**
     * @notice Swap an exact amount of `path[0]` for as much as possible of
     *         `path[path.length - 1]`, routing through intermediate pairs.
     * @param  amountIn     Amount of `path[0]` to spend.
     * @param  amountOutMin Minimum acceptable amount of `path[last]`;
     *                      reverts on the router if real output is lower.
     * @param  path         Token route; each consecutive pair must have a
     *                      pool with liquidity on the DEX.
     * @param  to           Recipient of the final output token.
     * @param  deadline     Unix timestamp after which the swap reverts.
     * @return amounts      Per-hop token amounts; `amounts[0] == amountIn`,
     *                      `amounts[last]` is the final output received.
     * @custom:see https://developer.pancakeswap.finance/contracts/v2/router-v2#swapexacttokensfortokens
     */
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    /**
     * @notice Spot-quote the output amounts for swapping `amountIn` of
     *         `path[0]` along `path`, at current reserves. View-only — used to
     *         size amounts off the swap path (e.g. ENC commission in {Vault}).
     * @param  amountIn Amount of `path[0]` to quote.
     * @param  path     Token route; each consecutive pair must have liquidity.
     * @return amounts  Per-hop amounts; `amounts[0] == amountIn`,
     *                  `amounts[last]` is the quoted output.
     * @custom:see https://developer.pancakeswap.finance/contracts/v2/router-v2#getamountsout
     */
    function getAmountsOut(
        uint256 amountIn,
        address[] calldata path
    ) external view returns (uint256[] memory amounts);
}

/**
 * @title  IDexRouterV3
 */
interface IDexRouterV3 {
    /**
     * @notice Parameters for a single-pool exact-input swap.
     * @param  tokenIn           Token being sold.
     * @param  tokenOut          Token being bought.
     * @param  fee               Pool fee tier in hundredths of a bip
     *                           (e.g. 500 = 0.05%, 2500 = 0.25%, 10000 = 1%).
     * @param  recipient         Recipient of `tokenOut`.
     * @param  deadline          Unix timestamp after which the swap reverts.
     * @param  amountIn          Exact amount of `tokenIn` to spend.
     * @param  amountOutMinimum  Minimum acceptable `tokenOut` (slippage guard).
     * @param  sqrtPriceLimitX96 Price limit (0 = no limit).
     */
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /**
     * @notice Swap an exact `amountIn` of one token for as much as possible of
     *         another, through a single V3 pool.
     * @param  params See {ExactInputSingleParams}.
     * @return amountOut Amount of `tokenOut` received.
     * @custom:see https://developer.pancakeswap.finance/contracts/v3/smartrouter/v3swaprouter#exactinputsingle
     */
    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut);

    /**
     * @notice Parameters for a multi-pool exact-input swap.
     * @param  path             Packed route `abi.encodePacked(tokenA, fee, tokenB, fee, …)`.
     * @param  recipient        Recipient of the final token.
     * @param  deadline         Unix timestamp after which the swap reverts.
     * @param  amountIn         Exact amount of the first token to spend.
     * @param  amountOutMinimum Minimum acceptable final output (slippage guard).
     */
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    /**
     * @notice Swap an exact `amountIn` of the first token for as much as
     *         possible of the last token, routing through the packed `path`.
     * @param  params See {ExactInputParams}.
     * @return amountOut Amount of the final token received.
     * @custom:see https://developer.pancakeswap.finance/contracts/v3/smartrouter/v3swaprouter#exactinput
     */
    function exactInput(
        ExactInputParams calldata params
    ) external payable returns (uint256 amountOut);

    /**
     * @notice Parameters for a single-pool exact-output swap.
     * @param  tokenIn           Token being sold.
     * @param  tokenOut          Token being bought (received in exact `amountOut`).
     * @param  fee               Pool fee tier.
     * @param  recipient         Recipient of `tokenOut`.
     * @param  deadline          Unix timestamp after which the swap reverts.
     * @param  amountOut         Exact amount of `tokenOut` to receive.
     * @param  amountInMaximum   Maximum `tokenIn` to spend; reverts if exceeded.
     * @param  sqrtPriceLimitX96 Price limit (0 = no limit).
     */
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    /**
     * @notice Swap as little `tokenIn` as possible to receive exactly
     *         `amountOut` of `tokenOut` through a single V3 pool.
     * @param  params See {ExactOutputSingleParams}.
     * @return amountIn Actual `tokenIn` spent.
     * @custom:see https://developer.pancakeswap.finance/contracts/v3/smartrouter/v3swaprouter#exactoutputsingle
     */
    function exactOutputSingle(
        ExactOutputSingleParams calldata params
    ) external payable returns (uint256 amountIn);

    /**
     * @notice Parameters for a multi-pool exact-output swap.
     * @param  path            Packed route in REVERSE order: `abi.encodePacked(tokenOut, fee, …, tokenIn)`.
     * @param  recipient       Recipient of `tokenOut`.
     * @param  deadline        Unix timestamp after which the swap reverts.
     * @param  amountOut       Exact amount of the last token to receive.
     * @param  amountInMaximum Maximum amount of the first token to spend; reverts if exceeded.
     */
    struct ExactOutputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
    }

    /**
     * @notice Swap as little as possible of the first token to receive exactly
     *         `amountOut` of the last token, routing through the packed `path`.
     * @param  params See {ExactOutputParams}.
     * @return amountIn Actual amount of the first token spent.
     * @custom:see https://developer.pancakeswap.finance/contracts/v3/smartrouter/v3swaprouter#exactoutput
     */
    function exactOutput(
        ExactOutputParams calldata params
    ) external payable returns (uint256 amountIn);
}

/**
 * @title  IDexQuoterV3
 * @notice PancakeSwap V3 `QuoterV2` interface
 */
interface IDexQuoterV3 {
    /**
     * @notice Parameters for quoting a single-pool exact-input swap.
     * @param  tokenIn           Token being sold.
     * @param  tokenOut          Token being bought.
     * @param  amountIn          Exact amount of `tokenIn` to price.
     * @param  fee               Pool fee tier.
     * @param  sqrtPriceLimitX96 Price limit (0 = no limit).
     */
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    /**
     * @notice Simulate an exact-input single-pool swap and return the expected
     *         output. NOT a `view` — it uses a try/catch simulation internally.
     *         Call from off-chain or from a non-critical on-chain path.
     * @param  params See {QuoteExactInputSingleParams}.
     * @return amountOut              Expected output amount.
     * @return sqrtPriceX96After      Pool price after the simulated swap.
     * @return initializedTicksCrossed Ticks crossed during simulation.
     * @return gasEstimate            Estimated gas for the real swap.
     * @custom:see https://developer.pancakeswap.finance/contracts/v3/quoter#quoteexactinputsingle
     */
    function quoteExactInputSingle(
        QuoteExactInputSingleParams memory params
    )
        external
        returns (
            uint256 amountOut,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        );

    function quoteExactInput(
        bytes memory path,
        uint256 amountIn
    )
        external
        returns (
            uint256 amountOut,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        );
}
