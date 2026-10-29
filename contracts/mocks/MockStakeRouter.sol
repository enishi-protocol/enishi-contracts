// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IVaultCommission {
    function ENC_COMMISSION() external view returns (address);
}

/**
 * @notice Test-only stake router stub with a single lock-like stake set by
 *         the test. Pays charges out of its own ENC balance to the calling
 *         Vault's ENC_COMMISSION.
 */
contract MockStakeRouter {
    uint16 private constant DEFAULT_BPS = 2500;

    /// @notice Stake rate. Defaults to the no-discount rate (2500 bps) so the
    ///         Vault takes the CASE A path.
    uint16 public bps = DEFAULT_BPS;

    /// @notice Staked ENC.
    uint256 public staked;

    /// @notice Extra ENC {chargeCommission} reports without sending, to model
    ///         a faulty router.
    uint256 public overReport;

    /// @notice ENC token held by this stub to pay charges.
    address public immutable ENC;

    constructor(address enc_) {
        ENC = enc_;
    }

    function setBps(uint16 b) external {
        bps = b;
    }

    function setStaked(uint256 s) external {
        staked = s;
    }

    function setOverReport(uint256 extra) external {
        overReport = extra;
    }

    function commissionQuote(address, uint256 netProfit) external view returns (uint256) {
        if (bps == DEFAULT_BPS || staked == 0) return 0;
        return (netProfit * bps) / 10_000;
    }

    function chargeCommission(
        address,
        uint256,
        uint256,
        uint256 quotedEnc
    ) external returns (uint256) {
        if (staked < quotedEnc) return 0;
        staked -= quotedEnc;
        IERC20(ENC).transfer(IVaultCommission(msg.sender).ENC_COMMISSION(), quotedEnc);
        return quotedEnc + overReport;
    }
}
