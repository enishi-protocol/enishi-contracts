// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IReentrancyTarget {
    function executeSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint24 fee,
        uint256 minStableOut,
        uint256 minEncOut
    ) external returns (uint256);
}

/// @notice Test-only ERC-20 that calls back into a target on every transfer,
///         used to verify {ReentrancyGuardTransient} blocks nested swaps.
contract ReentrancyAttackToken is ERC20 {
    IReentrancyTarget public target;
    address public reentryIn;
    address public reentryOut;
    bool public armed;

    constructor() ERC20("ATTACK", "ATTACK") {}

    function arm(IReentrancyTarget t, address in_, address out_) external {
        target = t;
        reentryIn = in_;
        reentryOut = out_;
        armed = true;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && address(target) != address(0)) {
            armed = false; // single-shot, otherwise infinite loop
            target.executeSwap(
                reentryIn,
                reentryOut,
                1,
                0,
                0,
                0,
                0
            );
        }
    }
}
