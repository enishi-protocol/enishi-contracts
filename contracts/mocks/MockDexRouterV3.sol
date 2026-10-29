// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IDexRouterV3} from "../interfaces/IDexRouter.sol";

/// @notice Test-only
contract MockDexRouterV3 is IDexRouterV3 {
    /// @notice When true, every swap reverts (router-level failure simulation).
    bool public mustRevert;

    /// @notice Output rate in basis points (10000 = 1:1). Zero ⇒ 10000.
    uint256 public outRateBps;

    function setMustRevert(bool r) external {
        mustRevert = r;
    }

    function setOutRateBps(uint256 bps) external {
        outRateBps = bps;
    }

    /*
        @See https://developer.pancakeswap.finance/contracts/v3/smartrouter/v3swaprouter#exactinputsingle
    */
    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable override returns (uint256 amountOut) {
        require(!mustRevert, "MockDexRouterV3: forced revert");

        amountOut = _applyRate(params.amountIn);
        require(
            amountOut >= params.amountOutMinimum,
            "MockDexRouterV3: slippage"
        );

        IERC20(params.tokenIn).transferFrom(
            msg.sender,
            address(this),
            params.amountIn
        );
        IERC20(params.tokenOut).transfer(params.recipient, amountOut);
    }

    /* 
        @See https://developer.pancakeswap.finance/contracts/v3/smartrouter/v3swaprouter#exactinput
    */
    function exactInput(
        ExactInputParams calldata params
    ) external payable override returns (uint256 amountOut) {
        require(!mustRevert, "MockDexRouterV3: forced revert");
        require(params.path.length >= 43, "MockDexRouterV3: bad path");

        address tokenIn = _firstToken(params.path);
        address tokenOut = _lastToken(params.path);

        amountOut = _applyRate(params.amountIn);
        require(
            amountOut >= params.amountOutMinimum,
            "MockDexRouterV3: slippage"
        );

        IERC20(tokenIn).transferFrom(
            msg.sender,
            address(this),
            params.amountIn
        );
        IERC20(tokenOut).transfer(params.recipient, amountOut);
    }

    /* 
        @See https://developer.pancakeswap.finance/contracts/v3/smartrouter/v3swaprouter#exactoutputsingle
    */
    function exactOutputSingle(
        ExactOutputSingleParams calldata params
    ) external payable override returns (uint256 amountIn) {
        require(!mustRevert, "MockDexRouterV3: forced revert");

        uint256 rate = outRateBps == 0 ? 10_000 : outRateBps;
        // inverse: how much tokenIn is needed to produce amountOut at `rate`
        amountIn = (params.amountOut * 10_000) / rate;
        require(
            amountIn <= params.amountInMaximum,
            "MockDexRouterV3: too much in"
        );

        IERC20(params.tokenIn).transferFrom(
            msg.sender,
            address(this),
            amountIn
        );
        IERC20(params.tokenOut).transfer(params.recipient, params.amountOut);
    }

    /*
        @See https://developer.pancakeswap.finance/contracts/v3/smartrouter/v3swaprouter#exactoutput
    */
    function exactOutput(
        ExactOutputParams calldata params
    ) external payable override returns (uint256 amountIn) {
        require(!mustRevert, "MockDexRouterV3: forced revert");
        require(params.path.length >= 43, "MockDexRouterV3: bad path");

        // path is reversed: first token = tokenOut, last token = tokenIn
        address tokenOut = _firstToken(params.path);
        address tokenIn = _lastToken(params.path);

        uint256 rate = outRateBps == 0 ? 10_000 : outRateBps;
        amountIn = (params.amountOut * 10_000) / rate;
        require(amountIn <= params.amountInMaximum, "MockDexRouterV3: too much in");

        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(params.recipient, params.amountOut);
    }

    function _applyRate(uint256 amountIn) internal view returns (uint256) {
        uint256 rate = outRateBps == 0 ? 10_000 : outRateBps;
        return (amountIn * rate) / 10_000;
    }

    /// @dev First 20 bytes of a V3 packed path.
    function _firstToken(
        bytes calldata path
    ) internal pure returns (address a) {
        a = address(bytes20(path[0:20]));
    }

    /// @dev Last 20 bytes of a V3 packed path.
    function _lastToken(bytes calldata path) internal pure returns (address a) {
        a = address(bytes20(path[path.length - 20:path.length]));
    }
}
