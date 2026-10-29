// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EnToken} from "./EnToken.sol";

/// @title  EnXRP
/// @notice Enishi XRP strategy receipt token. See {EnToken} for full docs.
contract EnXRP is EnToken {
    constructor() EnToken("Enishi XRP", "enXRP") {}
}
