// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPermit2} from "../interfaces/IPermit2.sol";

/// @notice Test-only faithful stand-in for PancakeSwap's classic (V2+V3)
///         Universal Router `Dispatcher`, restricted to the command subset that
///         matters to {UniversalRouterGuard}'s threat model.
///
///         Unlike {MockUniversalRouter} (a swap-only stub that reverts on
///         everything else), this mock ACTUALLY IMPLEMENTS the fund-moving
///         commands the guard exists to block — `PERMIT2_TRANSFER_FROM`,
///         `SWEEP`, `TRANSFER`, `PAY_PORTION` — plus the `*_EXACT_OUT` swap
///         variants, using the real `Constants` recipient mapping
///         (`MSG_SENDER` → `msg.sender`, `ADDRESS_THIS` → `address(this)`) and
///         the real `execute` loop semantics (length check + `FLAG_ALLOW_REVERT`
///         handling). This lets a differential test prove that the guard rejects
///         exactly the calldata that would otherwise drain funds, and that the
///         guard's decoder recovers the same tokenIn/tokenOut/recipient the
///         router itself acts on.
///
/// @dev    Mirrors https://github.com/pancakeswap/... UniversalRouter.execute
///         and libraries/{Commands,Constants}.sol. Not for production.
contract FaithfulUniversalRouter {
    // ─── Commands.sol ─────────────────────────────────────────────────────
    bytes1 private constant FLAG_ALLOW_REVERT = 0x80;
    // Classic Pancake/Uniswap command mask (low 6 bits). Immaterial for the
    // 0x00–0x09 command values below — they are identical under 0x3f or 0x7f.
    bytes1 private constant COMMAND_TYPE_MASK = 0x3f;

    uint256 private constant V3_SWAP_EXACT_IN = 0x00;
    uint256 private constant V3_SWAP_EXACT_OUT = 0x01;
    uint256 private constant PERMIT2_TRANSFER_FROM = 0x02;
    uint256 private constant SWEEP = 0x04;
    uint256 private constant TRANSFER = 0x05;
    uint256 private constant PAY_PORTION = 0x06;
    uint256 private constant V2_SWAP_EXACT_IN = 0x08;
    uint256 private constant V2_SWAP_EXACT_OUT = 0x09;

    // ─── Constants.sol ────────────────────────────────────────────────────
    address private constant MSG_SENDER = address(1);
    address private constant ADDRESS_THIS = address(2);

    // ─── Errors ───────────────────────────────────────────────────────────
    error LengthMismatch();
    error ExecutionFailed(uint256 commandIndex);
    error UnsupportedCommandMock(uint256 command);

    // ─── State ────────────────────────────────────────────────────────────
    IPermit2 public immutable PERMIT2;

    /// @dev Swap payout rate in bps of amountIn. 0 is treated as 10_000 (1:1).
    uint256 public outRateBps;

    constructor(address permit2) {
        PERMIT2 = IPermit2(permit2);
    }

    function setOutRateBps(uint256 bps) external {
        outRateBps = bps;
    }

    // ─── execute overloads (same selectors the guard validates) ───────────
    function execute(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 /* deadline */
    ) external payable {
        _execute(commands, inputs);
    }

    function execute(
        bytes calldata commands,
        bytes[] calldata inputs
    ) external payable {
        _execute(commands, inputs);
    }

    // ─── Internal ─────────────────────────────────────────────────────────
    function _execute(
        bytes calldata commands,
        bytes[] calldata inputs
    ) private {
        uint256 numCommands = commands.length;
        if (inputs.length != numCommands) revert LengthMismatch();

        for (uint256 i; i < numCommands; ) {
            bytes1 command = commands[i];
            bool success = _dispatch(command, inputs[i]);
            if (!success && (command & FLAG_ALLOW_REVERT == 0)) {
                revert ExecutionFailed(i);
            }
            unchecked {
                ++i;
            }
        }
    }

    /// @dev Resolve the Universal Router recipient sentinels exactly like the
    ///      real `Constants.map` / `Payments` do.
    function _map(address recipient) private view returns (address) {
        if (recipient == MSG_SENDER) return msg.sender;
        if (recipient == ADDRESS_THIS) return address(this);
        return recipient;
    }

    function _dispatch(
        bytes1 commandByte,
        bytes calldata input
    ) private returns (bool) {
        uint256 command = uint8(commandByte & COMMAND_TYPE_MASK);

        if (command == V3_SWAP_EXACT_IN) {
            (
                address recipient,
                uint256 amountIn,
                uint256 minOut,
                bytes memory path,

            ) = abi.decode(input, (address, uint256, uint256, bytes, bool));
            _swapExactIn(
                _firstV3(path),
                _lastV3(path),
                amountIn,
                minOut,
                _map(recipient)
            );
            return true;
        }

        if (command == V2_SWAP_EXACT_IN) {
            (
                address recipient,
                uint256 amountIn,
                uint256 minOut,
                address[] memory path,

            ) = abi.decode(input, (address, uint256, uint256, address[], bool));
            _swapExactIn(
                path[0],
                path[path.length - 1],
                amountIn,
                minOut,
                _map(recipient)
            );
            return true;
        }

        if (command == V3_SWAP_EXACT_OUT) {
            // exact-out V3 path is REVERSED: encodePacked(tokenOut, fee, tokenIn)
            (
                address recipient,
                uint256 amountOut,
                uint256 amountInMax,
                bytes memory path,

            ) = abi.decode(input, (address, uint256, uint256, bytes, bool));
            _swapExactOut(
                _lastV3(path),
                _firstV3(path),
                amountOut,
                amountInMax,
                _map(recipient)
            );
            return true;
        }

        if (command == V2_SWAP_EXACT_OUT) {
            (
                address recipient,
                uint256 amountOut,
                uint256 amountInMax,
                address[] memory path,

            ) = abi.decode(input, (address, uint256, uint256, address[], bool));
            _swapExactOut(
                path[0],
                path[path.length - 1],
                amountOut,
                amountInMax,
                _map(recipient)
            );
            return true;
        }

        if (command == PERMIT2_TRANSFER_FROM) {
            // Standalone fund pull from whoever called execute() to any
            // recipient — the exact command the guard must forbid.
            (address token, address recipient, uint160 amount) = abi.decode(
                input,
                (address, address, uint160)
            );
            PERMIT2.transferFrom(msg.sender, _map(recipient), amount, token);
            return true;
        }

        if (command == TRANSFER) {
            (address token, address recipient, uint256 value) = abi.decode(
                input,
                (address, address, uint256)
            );
            IERC20(token).transfer(_map(recipient), value);
            return true;
        }

        if (command == SWEEP) {
            (address token, address recipient, uint256 amountMin) = abi.decode(
                input,
                (address, address, uint256)
            );
            uint256 bal = IERC20(token).balanceOf(address(this));
            require(bal >= amountMin, "FaithfulRouter: sweep min");
            IERC20(token).transfer(_map(recipient), bal);
            return true;
        }

        if (command == PAY_PORTION) {
            (address token, address recipient, uint256 bips) = abi.decode(
                input,
                (address, address, uint256)
            );
            uint256 bal = IERC20(token).balanceOf(address(this));
            IERC20(token).transfer(_map(recipient), (bal * bips) / 10_000);
            return true;
        }

        revert UnsupportedCommandMock(command);
    }

    function _swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) private {
        // payerIsUser: true — pull tokenIn from the caller via Permit2.
        PERMIT2.transferFrom(
            msg.sender,
            address(this),
            uint160(amountIn),
            tokenIn
        );
        uint256 rate = outRateBps == 0 ? 10_000 : outRateBps;
        uint256 amountOut = (amountIn * rate) / 10_000;
        require(amountOut >= minOut, "FaithfulRouter: slippage");
        IERC20(tokenOut).transfer(recipient, amountOut);
    }

    function _swapExactOut(
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 amountInMax,
        address recipient
    ) private {
        uint256 rate = outRateBps == 0 ? 10_000 : outRateBps;
        uint256 amountIn = (amountOut * 10_000) / rate;
        require(amountIn <= amountInMax, "FaithfulRouter: excessive input");
        PERMIT2.transferFrom(
            msg.sender,
            address(this),
            uint160(amountIn),
            tokenIn
        );
        IERC20(tokenOut).transfer(recipient, amountOut);
    }

    function _firstV3(bytes memory path) private pure returns (address token) {
        assembly {
            token := shr(96, mload(add(path, 32)))
        }
    }

    function _lastV3(bytes memory path) private pure returns (address token) {
        uint256 len = path.length;
        assembly {
            token := shr(96, mload(add(add(path, 32), sub(len, 20))))
        }
    }
}
