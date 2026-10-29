// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only WBNB (Wrapped BNB) mock. Supports {deposit}/{withdraw}
///         semantics used by {SwapContract._chargeOperatorGas}. Designed to
///         survive `hardhat_setCode` injection at {EnishiAddresses.WBNB}.
///         Pre-fund with ETH before tests that call {withdraw}.
contract MockWBNB is ERC20 {
    constructor() ERC20("Wrapped BNB", "WBNB") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Wrap native BNB into WBNB (1:1).
    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    /// @notice Unwrap `amount` WBNB back to native BNB. Burns the tokens and
    ///         sends ETH to the caller. The contract must hold enough ETH.
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        payable(msg.sender).transfer(amount);
    }

    /// @notice Accept ETH (pre-funding for tests / deposit fallback).
    receive() external payable {}
}
