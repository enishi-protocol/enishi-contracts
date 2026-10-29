// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EnToken} from "./EnToken.sol";

/// @title  EnAVAX
/// @notice Enishi AVAX strategy receipt token. See {EnToken} for full docs.
contract EnAVAX is EnToken {
    constructor() EnToken("Enishi AVAX", "enAVAX") {}
}
