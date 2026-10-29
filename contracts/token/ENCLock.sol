// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IENCLock.sol";
import "../interfaces/IENC.sol";

/**
 * @title ENCLock
 * @notice Lock ENC to reduce commission rate. Supports top-up, plan change, and force unlock.
 *
 * Plans:
 *   0   days → 25% commission
 *   30  days → 21% commission
 *   180 days → 18% commission
 *   360 days → 15% commission
 *   720 days → 10% commission
 *
 * Force unlock: send 10% of locked balance to Enishi's master wallet, receive 90% immediately.
 */
contract ENCLock is Ownable, ReentrancyGuardTransient, IENCLock {
    using SafeERC20 for IENC;

    // ─── Constants ────────────────────────────────────────────────────────────

    uint256 public constant FORCE_UNLOCK_BURN_BPS = 1000; // 10% in basis points
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // ─── Types ────────────────────────────────────────────────────────────────

    struct LockInfo {
        uint256 amount;
        uint256 expiry;
        uint32 durationDays;
    }

    // ─── State ────────────────────────────────────────────────────────────────

    IENC public ENC_TOKEN;

    // valid lock durations in days → commission in basis points
    mapping(uint32 => uint16) public commissionBps;
    uint32[] public validDurations;

    mapping(address => LockInfo) public lockOf;

    address public vault;

    /// @notice Enishi's master wallet
    address public immutable ENISHI_MASTER_WALLET;

    // ─── Modifiers ──────────────────────────────────────────────────────────

    /// @dev Restricts to the Vault for {collectCommission}.
    modifier onlyVault() {
        if (_msgSender() != vault) revert NotVault(_msgSender());
        _;
    }

    // ─── Constructor ────────────────────────────────────────────────────────────

    /// @param enc_                ENC token address.
    /// @param enishiMasterWallet_ Enishi's master wallet, receiving the full force-unlock
    ///                            share on every unlock before expiry (must be non-zero).
    constructor(
        address enc_,
        address enishiMasterWallet_
    ) Ownable(_msgSender()) {
        if (enc_ == address(0) || enishiMasterWallet_ == address(0))
            revert ZeroAddress();

        ENC_TOKEN = IENC(enc_);
        ENISHI_MASTER_WALLET = enishiMasterWallet_;

        _addPlan(30, 2100);
        _addPlan(180, 1800);
        _addPlan(360, 1500);
        _addPlan(720, 1000);
    }

    // ─── External ─────────────────────────────────────────────────────────────

    /// @notice Lock ENC for the first time. User must not have an active lock.
    /// @param amount       Amount of ENC to lock (must be > 0).
    /// @param durationDays Must be one of the valid plan durations.
    function lock(uint256 amount, uint32 durationDays) external nonReentrant {
        _lock(_msgSender(), amount, durationDays);
    }

    /// @notice Lock ENC using an EIP-2612 permit signature. No prior approve needed.
    /// @param amount       Amount of ENC to lock (must be > 0).
    /// @param durationDays Must be one of the valid plan durations.
    /// @param deadline     Permit expiry timestamp.
    /// @param v            Signature component.
    /// @param r            Signature component.
    /// @param s            Signature component.
    function lockWithPermit(
        uint256 amount,
        uint32 durationDays,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        _tryPermit(amount, deadline, v, r, s);
        _lock(_msgSender(), amount, durationDays);
    }

    /// @notice Add more ENC to existing lock. Resets expiry to now + current duration.
    /// @param amount Additional ENC to lock (must be > 0).
    function topUp(uint256 amount) external nonReentrant {
        _topUp(_msgSender(), amount);
    }

    /// @notice Add more ENC using an EIP-2612 permit signature. No prior approve needed.
    /// @param amount   Additional ENC to lock (must be > 0).
    /// @param deadline Permit expiry timestamp.
    /// @param v        Signature component.
    /// @param r        Signature component.
    /// @param s        Signature component.
    function topUpWithPermit(
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        _tryPermit(amount, deadline, v, r, s);
        _topUp(_msgSender(), amount);
    }

    /// @notice Restake after lock has expired. Resets expiry to now + new duration without withdrawing.
    /// @param newDurationDays Must be one of the valid plan durations.
    function restake(uint32 newDurationDays) external nonReentrant {
        if (commissionBps[newDurationDays] == 0)
            revert InvalidDuration(newDurationDays);
        LockInfo storage info = lockOf[_msgSender()];
        if (info.amount == 0) revert NotLocked();
        if (block.timestamp < info.expiry) revert LockNotExpired(info.expiry);

        info.durationDays = newDurationDays;
        info.expiry = block.timestamp + uint256(newDurationDays) * 1 days;

        emit Restaked(_msgSender(), info.amount, newDurationDays, info.expiry);
    }

    /// @notice Change lock plan. Resets expiry to now + new duration.
    /// Only allowed when remaining days of current lock < newDurationDays.
    /// @param newDurationDays Must be one of the valid plan durations.
    function changePlan(uint32 newDurationDays) external nonReentrant {
        if (commissionBps[newDurationDays] == 0)
            revert InvalidDuration(newDurationDays);
        LockInfo storage info = lockOf[_msgSender()];
        if (info.amount == 0) revert NotLocked();
        if (block.timestamp >= info.expiry) revert LockExpired(info.expiry);

        uint256 remainingDays = (info.expiry - block.timestamp + 1 days - 1) /
            1 days;
        if (newDurationDays <= remainingDays)
            revert PlanDowngradeNotAllowed(newDurationDays, remainingDays);

        info.durationDays = newDurationDays;
        info.expiry = block.timestamp + uint256(newDurationDays) * 1 days;

        emit PlanChanged(_msgSender(), newDurationDays, info.expiry);
    }

    /// @notice Unlock at any time.
    function unlock() external nonReentrant {
        LockInfo memory info = lockOf[_msgSender()];
        if (info.amount == 0) revert NotLocked();

        delete lockOf[_msgSender()];

        uint256 toMasterWallet;
        uint256 returned;

        if (block.timestamp < info.expiry) {
            IENC enc = ENC_TOKEN;
            toMasterWallet =
                (info.amount * FORCE_UNLOCK_BURN_BPS) /
                BPS_DENOMINATOR;
            returned = info.amount - toMasterWallet;
            if (toMasterWallet > 0) {
                enc.safeTransfer(ENISHI_MASTER_WALLET, toMasterWallet);
            }
        } else {
            returned = info.amount;
        }

        ENC_TOKEN.safeTransfer(_msgSender(), returned);

        emit Unlocked(_msgSender(), returned, toMasterWallet);
    }

    /// @param  user   Staker whose locked ENC funds the commission.
    /// @param  amount ENC to pull; must be > 0 and ≤ the user's staked amount.
    /// @param  to     Recipient of the pulled ENC (the ENC Commission Contract).
    /// @return remaining The user's locked ENC after the deduction.
    function collectCommission(
        address user,
        uint256 amount,
        address to
    ) external onlyVault nonReentrant returns (uint256 remaining) {
        if (user == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        LockInfo storage info = lockOf[user];
        uint256 staked = info.amount;
        if (staked == 0) revert NotLocked();
        if (block.timestamp >= info.expiry) revert LockExpired(info.expiry);
        if (amount > staked) revert InsufficientStake(amount, staked);

        /*
            Effects: shrink the locked principal (plan/expiry unchanged); clear
            the record entirely when fully drained.
        */
        remaining = staked - amount;
        if (remaining == 0) {
            delete lockOf[user];
        } else {
            info.amount = remaining;
        }

        // Interaction: forward the commission ENC to the splitter.
        ENC_TOKEN.safeTransfer(to, amount);

        emit CommissionCollected(user, to, amount, remaining);
    }

    /// @notice Set the Vault allowed to call {collectCommission}. Owner-only;
    ///         emits {VaultUpdated} with old/new for the audit trail.
    /// @param  newVault New vault address; must be non-zero.
    function setVault(address newVault) external onlyOwner {
        if (newVault == address(0)) revert ZeroAddress();
        address old = vault;
        vault = newVault;
        emit VaultUpdated(old, newVault);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice Returns commission in basis points for a user based on their active lock.
    /// Returns 2500 (25%) if not locked or lock expired.
    function getCommissionBps(address user) external view returns (uint16) {
        LockInfo memory info = lockOf[user];
        if (info.amount == 0 || block.timestamp >= info.expiry) return 2500;
        return commissionBps[info.durationDays];
    }

    /// @notice Returns commission bps for a given withdrawal amount.
    /// If amount exceeds user's locked balance (or no active lock), returns 2500 (25%).
    function getCommissionBpsForAmount(
        address user,
        uint256 amount
    ) external view returns (uint16) {
        LockInfo memory info = lockOf[user];
        if (
            info.amount == 0 ||
            block.timestamp >= info.expiry ||
            amount > info.amount
        ) return 2500;
        return commissionBps[info.durationDays];
    }

    /// @notice Returns all valid duration plans.
    function getValidDurations() external view returns (uint32[] memory) {
        return validDurations;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _topUp(address user, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        LockInfo storage info = lockOf[user];
        if (info.amount == 0) revert NotLocked();
        if (block.timestamp >= info.expiry) revert LockExpired(info.expiry);

        uint256 newTotal = info.amount + amount;
        uint256 newExpiry = block.timestamp +
            uint256(info.durationDays) *
            1 days;
        info.amount = newTotal;
        info.expiry = newExpiry;

        ENC_TOKEN.safeTransferFrom(user, address(this), amount);

        emit ToppedUp(user, amount, newTotal, newExpiry);
    }

    function _lock(address user, uint256 amount, uint32 durationDays) internal {
        if (amount == 0) revert ZeroAmount();
        if (commissionBps[durationDays] == 0)
            revert InvalidDuration(durationDays);

        if (lockOf[user].amount > 0) revert AlreadyLocked();

        uint256 expiry = block.timestamp + uint256(durationDays) * 1 days;
        lockOf[user] = LockInfo({
            amount: amount,
            expiry: expiry,
            durationDays: durationDays
        });

        ENC_TOKEN.safeTransferFrom(user, address(this), amount);

        emit Locked(user, amount, durationDays, expiry);
    }

    /// @dev Best-effort permit for the caller. Anyone can lift the signature
    ///      from the mempool and submit it first, burning the nonce; that
    ///      grants the same allowance, so a failed permit is ignored and the
    ///      subsequent transferFrom enforces the allowance.
    function _tryPermit(
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        try
            ENC_TOKEN.permit(
                _msgSender(),
                address(this),
                amount,
                deadline,
                v,
                r,
                s
            )
        {} catch {}
    }

    function _addPlan(uint32 durationDays, uint16 bps) internal {
        commissionBps[durationDays] = bps;
        validDurations.push(durationDays);
    }
}
