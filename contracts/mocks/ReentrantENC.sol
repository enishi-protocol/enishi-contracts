// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

interface IReentrantCommission {
    function distribute(address user, uint256 amount) external;
}

interface IReentrantClaim {
    function claim(uint8 roundId) external returns (uint256);
}

/// @notice Test-only ENC stand-in that re-enters the contract paying it out on the
///         first transfer, to prove {ReentrancyGuardTransient} actually blocks it.
///         Also used as a burnable, permit-capable ENC wherever a test needs to
///         drive `totalSupply` freely.
contract ReentrantENC is ERC20, ERC20Permit, ERC20Burnable {
    uint256 public constant MAX_SUPPLY = 3_000_000_000 ether;

    IReentrantCommission public target;
    address public reentryUser;
    uint256 public reentryAmount;
    bool public armed;

    IReentrantClaim public claimTarget;
    uint8 public claimRound;
    bool public claimArmed;

    constructor() ERC20("ReentrantENC", "rENC") ERC20Permit("ReentrantENC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Test-only: burn from any holder, so a suite can drive the supply
    ///         down without first claiming ENC out of the vault holding it.
    function burnFromAnyone(address from, uint256 amount) external {
        _burn(from, amount);
    }

    /// @notice Arm a callback into {ENCCommission-distribute}.
    function arm(IReentrantCommission target_, address user_, uint256 amount_) external {
        target = target_;
        reentryUser = user_;
        reentryAmount = amount_;
        armed = true;
    }

    /// @notice Arm a callback into {ENCVesting-claim}.
    function armClaim(IReentrantClaim target_, uint8 roundId_) external {
        claimTarget = target_;
        claimRound = roundId_;
        claimArmed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && address(target) != address(0)) {
            armed = false; // single-shot, otherwise infinite recursion
            target.distribute(reentryUser, reentryAmount);
        }
        if (claimArmed && address(claimTarget) != address(0)) {
            claimArmed = false; // single-shot
            claimTarget.claim(claimRound);
        }
    }
}
