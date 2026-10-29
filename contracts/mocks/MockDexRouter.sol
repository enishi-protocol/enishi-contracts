// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test-only
contract MockDexRouter {
    /// @notice When true, every swap call reverts (router-level failure
    ///         simulation). Defaults to false (storage zero), so a freshly
    ///         injected mock works out of the box.
    bool public mustRevert;

    /// @notice Output rate in basis points (10000 = 1:1). Zero is treated as
    ///         10000 so the default (storage zero) keeps the 1:1 contract.
    uint256 public outRateBps;

    function setMustRevert(bool r) external {
        mustRevert = r;
    }

    function setOutRateBps(uint256 bps) external {
        outRateBps = bps;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        require(!mustRevert, "MockDexRouter: forced revert");
        require(path.length >= 2, "MockDexRouter: bad path");

        uint256 rate = outRateBps == 0 ? 10_000 : outRateBps;
        uint256 amountOut = (amountIn * rate) / 10_000;
        require(amountOut >= amountOutMin, "MockDexRouter: slippage");

        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        IERC20(path[path.length - 1]).transfer(to, amountOut);

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountOut;
    }

    /// @notice Spot-quote mirror of {swapExactTokensForTokens}: applies the same
    ///         `outRateBps` without moving tokens. Used by {Vault} to size the
    ///         stake-funded ENC commission.
    function getAmountsOut(
        uint256 amountIn,
        address[] calldata path
    ) external view returns (uint256[] memory amounts) {
        require(path.length >= 2, "MockDexRouter: bad path");
        uint256 rate = outRateBps == 0 ? 10_000 : outRateBps;
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = (amountIn * rate) / 10_000;
    }
}
