// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UniversalRouterGuard} from "../libraries/UniversalRouterGuard.sol";

/// @notice Test-only harness exposing {UniversalRouterGuard.validate} as an
///         external function so its decoder/whitelist logic can be asserted
///         directly, independent of a live Vault/SWC swap flow.
contract UniversalRouterGuardHarness {
    function validate(
        bytes calldata swapData,
        address recipient,
        address tokenIn,
        address tokenOut
    ) external view returns (uint256 declaredAmountIn) {
        return UniversalRouterGuard.validate(swapData, recipient, tokenIn, tokenOut);
    }
}
