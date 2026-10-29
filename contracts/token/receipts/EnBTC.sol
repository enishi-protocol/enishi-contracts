// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EnToken} from "./EnToken.sol";

/// @title  EnBTC
/// @notice Enishi BTC strategy receipt token. See {EnToken} for full docs.
contract EnBTC is EnToken {
    constructor() EnToken("Enishi BTC", "enBTC") {}
}
