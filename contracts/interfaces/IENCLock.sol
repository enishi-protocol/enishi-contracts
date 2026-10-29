// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IENCLock {
    // ─── Events ───────────────────────────────────────────────────────────────

    event Locked(
        address indexed user,
        uint256 amount,
        uint32 durationDays,
        uint256 expiry
    );
    event ToppedUp(
        address indexed user,
        uint256 addedAmount,
        uint256 newTotal,
        uint256 newExpiry
    );
    event PlanChanged(
        address indexed user,
        uint32 newDurationDays,
        uint256 newExpiry
    );
    event Restaked(
        address indexed user,
        uint256 amount,
        uint32 newDurationDays,
        uint256 newExpiry
    );
    event Unlocked(
        address indexed user,
        uint256 returned,
        uint256 toMasterWallet
    );
    event VaultUpdated(address indexed oldVault, address indexed newVault);
    event CommissionCollected(
        address indexed user,
        address indexed to,
        uint256 amount,
        uint256 remaining
    );

    // ─── Errors ───────────────────────────────────────────────────────────────

    error InvalidDuration(uint32 durationDays);
    error PlanDowngradeNotAllowed(
        uint32 newDurationDays,
        uint256 remainingDays
    );
    error AlreadyLocked();
    error LockExpired(uint256 expiry);
    error LockNotExpired(uint256 expiry);
    error NotLocked();
    error ZeroAmount();
    error ZeroAddress();
    error NotVault(address caller);
    error InsufficientStake(uint256 requested, uint256 available);

    // ─── External ─────────────────────────────────────────────────────────────

    function lock(uint256 amount, uint32 durationDays) external;
    function lockWithPermit(
        uint256 amount,
        uint32 durationDays,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
    function topUp(uint256 amount) external;
    function topUpWithPermit(
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
    function restake(uint32 newDurationDays) external;
    function changePlan(uint32 newDurationDays) external;
    function unlock() external;

    function collectCommission(
        address user,
        uint256 amount,
        address to
    ) external returns (uint256 remaining);

    function setVault(address newVault) external;

    // ─── Views ────────────────────────────────────────────────────────────────

    function lockOf(
        address user
    )
        external
        view
        returns (uint256 amount, uint256 expiry, uint32 durationDays);

    function getCommissionBps(address user) external view returns (uint16);
    function getCommissionBpsForAmount(
        address user,
        uint256 amount
    ) external view returns (uint16);
    function getValidDurations() external view returns (uint32[] memory);
    function vault() external view returns (address);
    function ENISHI_MASTER_WALLET() external view returns (address);
}
