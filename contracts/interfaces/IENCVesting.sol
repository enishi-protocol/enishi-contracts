// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IReferralRegistry.sol";

interface IENCVesting {
    // ─── Events ───────────────────────────────────────────────────────────────

    /// @notice The TGE was anchored and the contract opened for business.
    event Started(uint256 startTime);

    /// @notice The ENC token was wired in by {start}.
    event EncTokenSet(address indexed token);

    event AllocationSet(
        uint8 indexed roundId,
        address indexed beneficiary,
        uint256 oldAmount,
        uint256 newAmount
    );
    event Claimed(
        uint8 indexed roundId,
        address indexed beneficiary,
        uint256 amount
    );

    /// @notice Newly unlocked ENC moved into a pooled round's pending pool.
    event PoolAccrued(uint8 indexed roundId, uint256 amount, uint256 pool);

    /// @notice Pool credited pro-rata to members; `leftover` stays pooled.
    event PoolAllocated(
        uint8 indexed roundId,
        uint256 allocated,
        uint256 leftover
    );

    /// @notice One {distribute} press paid `paid` ENC to `recipients` wallets.
    event Distributed(
        uint8 indexed roundId,
        uint256 recipients,
        uint256 paid,
        uint256 leftover
    );

    // ─── Errors ───────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error UnknownRound(uint8 roundId);
    error NothingToClaim();
    error NothingToDistribute(uint8 roundId);
    error LengthMismatch();
    error Underfunded(uint256 required, uint256 available);
    error AllocationCapExceeded(uint8 roundId, uint256 assigned, uint256 cap);
    error AllocationAlreadySet(uint8 roundId, address beneficiary);
    error NotStarted();
    error AlreadyStarted(uint256 startedAt);
    error EmptyInput();
    error OperatorDistributedRound(uint8 roundId);
    error InvalidReleaseIndex(uint256 index);
    error ReferrerRequired(address beneficiary);

    // ─── External: admin ─────────────────────────────────────────────────────────

    /// @notice Wire the ENC token, fund up, anchor the TGE and open the vault. One-shot.
    function start(address enc_) external;

    function addBeneficiaries(
        uint8 roundId,
        address[] calldata beneficiaries,
        uint256[] calldata amounts,
        address[] calldata referrers,
        bool settleFirst
    ) external;

    // ─── External: operator ─────────────────────────────────────────────────────

    function distribute(
        uint8 roundId
    ) external returns (uint256 paid, uint256 leftover);

    // ─── External: anyone ───────────────────────────────────────────────────────

    function claim(uint8 roundId) external returns (uint256 amount);

    function claimAll() external returns (uint256 total);

    // ─── Views ────────────────────────────────────────────────────────────────

    function cumulativeBurned() external view returns (uint256);
    function groupUnlocked(uint8 roundId) external view returns (uint256);
    function pendingPool(uint8 roundId) external view returns (uint256);
    function roundMembers(
        uint8 roundId
    ) external view returns (address[] memory);
    function previewDistribution(
        uint8 roundId
    )
        external
        view
        returns (
            address[] memory beneficiaries,
            uint256[] memory amounts,
            uint256 leftover
        );
    function claimable(
        uint8 roundId,
        address beneficiary
    ) external view returns (uint256);
    function allocationOf(
        uint8 roundId,
        address beneficiary
    ) external view returns (uint256 allocatedAmount, uint256 claimedAmount);
    function isAllNonPublicUnlocked() external view returns (bool);
    function startTime() external view returns (uint256);
    function REFERRAL_REGISTRY() external view returns (IReferralRegistry);
}
