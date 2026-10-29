// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EnToken} from "./EnToken.sol";

/// @title  EnSOL
/// @notice Enishi SOL strategy receipt token. See {EnToken} for full docs.
contract EnSOL is EnToken {
    constructor() EnToken("Enishi SOL", "enSOL") {}
}
