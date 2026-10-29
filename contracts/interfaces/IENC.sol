// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

interface IENC is IERC20, IERC20Permit {
    function burn(uint256 amount) external;
    function MAX_SUPPLY() external view returns (uint256);
}
