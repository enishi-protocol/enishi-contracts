// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library UniversalRouterCommands {
    /// @dev High bit of a command byte: continue the batch even if this
    ///      command reverts. Masked off before the command type is matched.
    bytes1 internal constant FLAG_ALLOW_REVERT = 0x80;

    /// @dev Low 7 bits of a command byte select the command type.
    bytes1 internal constant COMMAND_TYPE_MASK = 0x7f;

    uint256 internal constant V3_SWAP_EXACT_IN = 0x00;
    uint256 internal constant V3_SWAP_EXACT_OUT = 0x01;
    uint256 internal constant V2_SWAP_EXACT_IN = 0x08;
    uint256 internal constant V2_SWAP_EXACT_OUT = 0x09;
}
