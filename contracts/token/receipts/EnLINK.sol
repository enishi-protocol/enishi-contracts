// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EnToken} from "./EnToken.sol";

/// @title  EnLINK
/// @notice Enishi LINK strategy receipt token. See {EnToken} for full docs.
contract EnLINK is EnToken {
    constructor() EnToken("Enishi LINK", "enLINK") {}
}
