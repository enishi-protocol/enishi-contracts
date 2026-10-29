// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @notice Test-only ENC stand-in: permissionless mint + burn so a fuzz harness can
///         drive `totalSupply` (and therefore ENCVesting.cumulativeBurned) anywhere.
contract MockBurnableENC is ERC20, ERC20Burnable {
    constructor() ERC20("Mock Enishi", "mENC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
