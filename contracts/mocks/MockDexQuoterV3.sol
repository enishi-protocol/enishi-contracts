// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDexQuoterV3} from "../interfaces/IDexRouter.sol";

/// @notice Test-only PancakeSwap V3 `QuoterV2` mock implementing
///         {IDexQuoterV3}. Returns `amountIn * outRateBps / 10000` as the
///         quoted `amountOut`; no tokens move. Designed to survive
///         `hardhat_setCode` injection at the pinned V3 Quoter address.
contract MockDexQuoterV3 is IDexQuoterV3 {
    /// @notice Output rate in basis points (10000 = 1:1). Zero ⇒ 10000.
    uint256 public outRateBps;

    /// @notice Number of {quoteExactInput} calls, so tests can count quotes.
    uint256 public quoteCount;

    function setOutRateBps(uint256 bps) external {
        outRateBps = bps;
    }

    function quoteExactInputSingle(
        QuoteExactInputSingleParams memory params
    )
        external
        override
        returns (
            uint256 amountOut,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        )
    {
        uint256 rate = outRateBps == 0 ? 10_000 : outRateBps;
        amountOut = (params.amountIn * rate) / 10_000;
        sqrtPriceX96After = 0;
        initializedTicksCrossed = 0;
        gasEstimate = 0;
    }

    function quoteExactInput(
        bytes memory,
        uint256 amountIn
    )
        external
        override
        returns (
            uint256 amountOut,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        )
    {
        ++quoteCount;
        uint256 rate = outRateBps == 0 ? 10_000 : outRateBps;
        amountOut = (amountIn * rate) / 10_000;
        sqrtPriceX96AfterList = new uint160[](0);
        initializedTicksCrossedList = new uint32[](0);
        gasEstimate = 0;
    }
}
