// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EnToken} from "./EnToken.sol";

/// @title  EnBNB
/// @notice Enishi BNB strategy receipt token. See {EnToken} for full docs.
contract EnBNB is EnToken {
    constructor() EnToken("Enishi BNB", "enBNB") {}
}
