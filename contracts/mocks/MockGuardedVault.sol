// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {IPermit2} from "../interfaces/IPermit2.sol";
import {UniversalRouterGuard} from "../libraries/UniversalRouterGuard.sol";

/// @notice Test-only stand-in for the Vault/SWC swap forwarder. Holds `tokenIn`,
///         grants the router a standing max Permit2 allowance (exactly like
///         `Vault._approveRouterPermit2`), and forwards pre-built Universal
///         Router calldata either:
///           - {unsafeExecute}  — raw, modelling the pre-guard hole, or
///           - {guardedExecute} — through {UniversalRouterGuard.validate},
///             modelling the fixed contracts.
///         The `recipient` the guard is told to require is `address(this)`,
///         matching how the real Vault/SWC call the guard.
contract MockGuardedVault {
    using Address for address;

    address public immutable ROUTER;
    address public immutable PERMIT2;

    constructor(address router, address permit2) {
        ROUTER = router;
        PERMIT2 = permit2;
    }

    /// @dev Mirror Vault._approveRouterPermit2: infinite ERC-20 approval to
    ///      Permit2, then infinite Permit2 allowance to the router.
    function arm(address token) external {
        IERC20(token).approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(
            token,
            ROUTER,
            type(uint160).max,
            type(uint48).max
        );
    }

    /// @notice Forward calldata to the router WITHOUT validation (the hole).
    function unsafeExecute(bytes calldata swapData) external {
        ROUTER.functionCall(swapData);
    }

    /// @notice Forward calldata to the router ONLY IF the guard accepts it.
    function guardedExecute(
        bytes calldata swapData,
        address tokenIn,
        address tokenOut
    ) external {
        UniversalRouterGuard.validate(
            swapData,
            address(this),
            tokenIn,
            tokenOut
        );
        ROUTER.functionCall(swapData);
    }
}
