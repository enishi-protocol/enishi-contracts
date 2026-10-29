// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UniversalRouterCommands} from "./UniversalRouterCommands.sol";
import {EnishiAddresses} from "./EnishiAddresses.sol";

interface IPancakeV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

/**
 * @title  UniversalRouterGuard
 * @notice Validates a pre-built PancakeSwap (classic V2+V3) Universal Router.
 */
library UniversalRouterGuard {
    // ─── Errors ───────────────────────────────────────────────────────────
    error InvalidExecuteSelector(bytes4 selector);
    error EmptyCommands();
    error CommandsInputsLengthMismatch();
    error UnsupportedCommand(uint256 command);
    error UnexpectedTokenOut(address token);
    error InvalidV3Path();
    error InvalidV2Path();
    error PayerNotUser();
    error PayerIsUser();
    error BrokenChain(address expected, address got);
    error IncompleteChain();
    error InvalidIntermediateRecipient(address recipient);

    // ─── Selectors ────────────────────────────────────────────────────────
    /// @dev `execute(bytes,bytes[])`
    bytes4 internal constant EXECUTE_2ARG = 0x24856bc3;
    /// @dev `execute(bytes,bytes[],uint256)`
    bytes4 internal constant EXECUTE_3ARG = 0x3593564c;

    address internal constant ADDRESS_THIS =
        0x0000000000000000000000000000000000000002;

    /**
     * @notice Revert unless `swapData` is a well-formed `execute(...)` batch of
     *         V2/V3 exact-in routes that each pull `tokenIn` from `recipient` and
     *         deliver `tokenOut` back to it (splits and mixed v2+v3 allowed).
     * @param  swapData  Raw Universal Router `execute(...)` calldata (with selector).
     * @param  recipient The calling Vault/SWC (`address(this)`).
     * @param  tokenIn   First token every route must consume.
     * @param  tokenOut  Last token every route must deliver.
     * @return declaredAmountIn Total the calldata pulls from the caller.
     */
    function validate(
        bytes calldata swapData,
        address recipient,
        address tokenIn,
        address tokenOut
    ) internal view returns (uint256 declaredAmountIn) {
        if (swapData.length < 4) revert InvalidExecuteSelector(bytes4(0));

        bytes4 selector;
        assembly ("memory-safe") {
            selector := shl(224, shr(224, calldataload(swapData.offset)))
        }

        bytes memory commands;
        bytes[] memory inputs;
        if (selector == EXECUTE_3ARG) {
            (commands, inputs, ) = abi.decode(swapData[4:], (bytes, bytes[], uint256));
        } else if (selector == EXECUTE_2ARG) {
            (commands, inputs) = abi.decode(swapData[4:], (bytes, bytes[]));
        } else {
            revert InvalidExecuteSelector(selector);
        }

        uint256 count = commands.length;
        if (count == 0) revert EmptyCommands();
        if (count != inputs.length) revert CommandsInputsLengthMismatch();

        address currentToken = tokenIn;
        bool atRouteStart = true;

        for (uint256 i; i < count; ) {
            (
                address rcpt,
                uint256 amtIn,
                address firstTok,
                address lastTok,
                bool payerIsUser
            ) = _decodeSwap(commands[i], inputs[i]);

            if (firstTok != currentToken) revert BrokenChain(currentToken, firstTok);

            if (atRouteStart) {
                if (!payerIsUser) revert PayerNotUser();
                declaredAmountIn += amtIn;
            } else {
                if (payerIsUser) revert PayerIsUser();
            }

            if (rcpt == recipient) {
                if (lastTok != tokenOut) revert UnexpectedTokenOut(lastTok);
                currentToken = tokenIn;
                atRouteStart = true;
            } else if (rcpt == ADDRESS_THIS) {
                currentToken = lastTok;
                atRouteStart = false;
            } else {
                if (i + 1 >= count) revert InvalidIntermediateRecipient(rcpt);
                _requireNextV2Pair(rcpt, commands[i + 1], inputs[i + 1], lastTok);
                currentToken = lastTok;
                atRouteStart = false;
            }

            unchecked {
                ++i;
            }
        }

        if (!atRouteStart) revert IncompleteChain();
    }

    // ─── Internal ─────────────────────────────────────────────────────────

    function _decodeSwap(
        bytes1 commandByte,
        bytes memory input
    )
        private
        pure
        returns (
            address recipient,
            uint256 amountIn,
            address firstToken,
            address lastToken,
            bool payerIsUser
        )
    {
        uint256 command = uint8(commandByte & UniversalRouterCommands.COMMAND_TYPE_MASK);

        if (command == UniversalRouterCommands.V3_SWAP_EXACT_IN) {
            // abi.encode(address recipient, uint256 amountIn, uint256 amountOutMin, bytes path, bool payerIsUser)
            bytes memory path;
            (recipient, amountIn, , path, payerIsUser) = abi.decode(
                input,
                (address, uint256, uint256, bytes, bool)
            );
            (firstToken, lastToken) = _v3PathEnds(path);
            return (recipient, amountIn, firstToken, lastToken, payerIsUser);
        }

        if (command == UniversalRouterCommands.V2_SWAP_EXACT_IN) {
            // abi.encode(address recipient, uint256 amountIn, uint256 amountOutMin, address[] path, bool payerIsUser)
            address[] memory path;
            (recipient, amountIn, , path, payerIsUser) = abi.decode(
                input,
                (address, uint256, uint256, address[], bool)
            );
            if (path.length < 2) revert InvalidV2Path();
            return (recipient, amountIn, path[0], path[path.length - 1], payerIsUser);
        }

        revert UnsupportedCommand(command);
    }

    function _requireNextV2Pair(
        address recipient,
        bytes1 nextCommandByte,
        bytes memory nextInput,
        address expectedInput
    ) private view {
        uint256 nextCommand = uint8(
            nextCommandByte & UniversalRouterCommands.COMMAND_TYPE_MASK
        );
        if (nextCommand != UniversalRouterCommands.V2_SWAP_EXACT_IN) {
            revert InvalidIntermediateRecipient(recipient);
        }
        (, , , address[] memory nextPath, ) = abi.decode(
            nextInput,
            (address, uint256, uint256, address[], bool)
        );
        if (nextPath.length < 2) revert InvalidV2Path();
        if (nextPath[0] != expectedInput) revert BrokenChain(expectedInput, nextPath[0]);
        if (
            recipient !=
            IPancakeV2Factory(EnishiAddresses.PANCAKE_V2_FACTORY).getPair(nextPath[0], nextPath[1])
        ) {
            revert InvalidIntermediateRecipient(recipient);
        }
    }

    /// @dev First and last 20-byte token of a packed V3 path
    ///      `abi.encodePacked(token, fee, token, fee, …, token)`.
    function _v3PathEnds(
        bytes memory path
    ) private pure returns (address first, address last) {
        uint256 len = path.length;
        // 20 (token) + n * 23 (fee + token), n >= 1  ⇒  len >= 43, (len-20)%23==0.
        if (len < 43 || (len - 20) % 23 != 0) revert InvalidV3Path();
        assembly ("memory-safe") {
            let dataStart := add(path, 32)
            first := shr(96, mload(dataStart))
            last := shr(96, mload(add(dataStart, sub(len, 20))))
        }
    }
}
