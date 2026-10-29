// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVault} from "../interfaces/IVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test-only
contract MockVault {
    IVault.ProfitParams public lastProfit;
    uint256 public processProfitCallCount;
    bool public mustRevert;
    bool public paused;

    function setMustRevert(bool r) external {
        mustRevert = r;
    }

    function pause() external {
        paused = true;
    }

    function unpause() external {
        paused = false;
    }

    function processProfit(IVault.ProfitParams calldata params) external {
        require(!mustRevert, "MockVault: forced revert");
        lastProfit = params;
        processProfitCallCount++;
        // Pull the approved payout token from the caller (mirrors real Vault behaviour).
        if (params.grossProfit > 0) {
            IERC20(params.payoutToken).transferFrom(
                msg.sender,
                address(this),
                params.grossProfit
            );
        }
    }

    receive() external payable {}
}
