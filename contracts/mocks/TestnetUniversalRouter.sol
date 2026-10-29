// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPermit2} from "../interfaces/IPermit2.sol";
import {EnishiAddresses} from "../libraries/EnishiAddresses.sol";
import {UniversalRouterCommands} from "../libraries/UniversalRouterCommands.sol";

/// @notice Chapel-only classic (V2+V3) Universal Router stand-in for the
///         protocol's mock tokens (the real testnet Universal Router has no
///         pools for them). Decodes real `execute(commands, inputs[, deadline])`
///         calldata (only V2/V3 `SWAP_EXACT_IN`) and pulls `tokenIn` through the
///         real Permit2 deployment on testnet.
contract TestnetUniversalRouter {
    uint256 public outRateBps; // 10_000 = 1:1; 0 ⇒ treated as 10_000

    function setOutRateBps(uint256 bps) external {
        outRateBps = bps;
    }

    function execute(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 /* deadline */
    ) external payable {
        _run(commands, inputs);
    }

    function execute(
        bytes calldata commands,
        bytes[] calldata inputs
    ) external payable {
        _run(commands, inputs);
    }

    function _run(bytes calldata commands, bytes[] calldata inputs) private {
        uint256 len = commands.length;
        for (uint256 i; i < len; ) {
            _dispatch(commands[i], inputs[i]);
            unchecked {
                ++i;
            }
        }
    }

    function _dispatch(bytes1 commandByte, bytes calldata input) private {
        uint256 command = uint8(
            commandByte & UniversalRouterCommands.COMMAND_TYPE_MASK
        );

        address recipient;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut;

        if (command == UniversalRouterCommands.V3_SWAP_EXACT_IN) {
            bytes memory path;
            (recipient, amountIn, minOut, path, ) = abi.decode(
                input,
                (address, uint256, uint256, bytes, bool)
            );
            tokenIn = _firstTokenV3(path);
            tokenOut = _lastTokenV3(path);
        } else if (command == UniversalRouterCommands.V2_SWAP_EXACT_IN) {
            address[] memory path;
            (recipient, amountIn, minOut, path, ) = abi.decode(
                input,
                (address, uint256, uint256, address[], bool)
            );
            tokenIn = path[0];
            tokenOut = path[path.length - 1];
        } else {
            revert("TestnetUniversalRouter: unsupported command");
        }

        IPermit2(EnishiAddresses.PANCAKE_PERMIT2).transferFrom(
            msg.sender,
            address(this),
            uint160(amountIn),
            tokenIn
        );

        uint256 rate = outRateBps == 0 ? 10_000 : outRateBps;
        uint256 amountOut = (amountIn * rate) / 10_000;
        require(amountOut >= minOut, "TestnetUniversalRouter: slippage");

        IERC20(tokenOut).transfer(recipient, amountOut);
    }

    function _firstTokenV3(
        bytes memory path
    ) private pure returns (address token) {
        assembly {
            token := shr(96, mload(add(path, 32)))
        }
    }

    function _lastTokenV3(
        bytes memory path
    ) private pure returns (address token) {
        uint256 len = path.length;
        assembly {
            token := shr(96, mload(add(add(path, 32), sub(len, 20))))
        }
    }
}
