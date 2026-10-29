// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EnToken} from "./EnToken.sol";

/// @title  EnETH
/// @notice Enishi ETH strategy receipt token. See {EnToken} for full docs.
contract EnETH is EnToken {
    constructor() EnToken("Enishi ETH", "enETH") {}
}
