// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "../interfaces/IENCVesting.sol";
import "../interfaces/IENC.sol";
import "../interfaces/IReferralRegistry.sol";
import "../libraries/EnishiConstants.sol";

/**
 * @title  ENCVesting
 * @notice Roles:
 *           - DEFAULT_ADMIN_ROLE: {start}, and grants/revokes every role.
 *           - OPERATOR_ROLE:      {addBeneficiaries} and {distribute} for SEED/PRIVATE.
 *         The deployer is granted DEFAULT_ADMIN_ROLE at construction; OPERATOR_ROLE
 *         is granted separately (09_wire_all grants it to ENC_VESTING_PUBLIC_WALLET).
 */
contract ENCVesting is AccessControl, ReentrancyGuardTransient, IENCVesting {
    using SafeERC20 for IENC;

    // ─── Constants ────────────────────────────────────────────────────────────

    /// @notice Role allowed to register SEED/PRIVATE beneficiaries and press {distribute}.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    uint256 internal constant BPS_DENOMINATOR = EnishiConstants.BPS_DENOMINATOR;

    /// @dev Round ids. 0..3 are burn groups (fill in this order); 4 is time-based
    ///      against a single wallet.
    uint8 public constant SEED = 0;
    uint8 public constant PRIVATE = 1;
    uint8 public constant TEAM = 2;
    uint8 public constant TREASURY = 3;
    uint8 public constant PUBLIC = 4;

    uint8 internal constant BURN_GROUPS = 4;
    uint8 internal constant ROUND_COUNT = 5;

    /// @notice Share of the PUBLIC allocation unlocked at TGE: 20%.
    uint16 internal constant PUBLIC_TGE_BPS = EnishiConstants.PUBLIC_TGE_BPS;

    /// @notice Lock on the PUBLIC allocation after TGE: 365 days.
    uint32 public constant PUBLIC_CLIFF_SECONDS = EnishiConstants.PUBLIC_CLIFF;

    /// @notice Gap between PUBLIC tranches: 30 days.
    uint32 public constant PUBLIC_RELEASE_INTERVAL =
        EnishiConstants.PUBLIC_RELEASE_INTERVAL;

    /// @notice Number of PUBLIC tranches: 60.
    uint16 public constant PUBLIC_RELEASE_COUNT =
        EnishiConstants.PUBLIC_RELEASE_COUNT;

    uint256 internal constant PUBLIC_TOTAL_ALLOCATION =
        EnishiConstants.PUBLIC_ALLOCATION;

    uint256 internal constant PUBLIC_ALLOCATION =
        EnishiConstants.PUBLIC_VESTING_ALLOCATION;

    uint256 public constant PUBLIC_TGE_AMOUNT =
        (PUBLIC_TOTAL_ALLOCATION * PUBLIC_TGE_BPS) /
            EnishiConstants.BPS_DENOMINATOR -
            EnishiConstants.PUBLIC_SALE_MAX_ALLOCATION;

    uint256 internal constant TEAM_ALLOCATION = EnishiConstants.TEAM_ALLOCATION;
    uint256 internal constant TREASURY_ALLOCATION =
        EnishiConstants.TREASURY_ALLOCATION;

    uint256 internal constant SEED_ALLOCATION = EnishiConstants.SEED_ALLOCATION;
    uint256 internal constant PRIVATE_ALLOCATION =
        EnishiConstants.PRIVATE_ALLOCATION;

    // ─── State ────────────────────────────────────────────────────────────────

    IENC public ENC_TOKEN;
    uint256 public immutable INITIAL_SUPPLY;

    uint256 public startTime;

    IReferralRegistry public REFERRAL_REGISTRY;

    /// @notice Σ (allocation − claimed) across all rounds. Invariant: ≤ ENC held.
    uint256 public totalOutstanding;

    uint256[4] public groupAssigned;

    mapping(uint8 => mapping(address => uint256)) public allocation;
    mapping(uint8 => mapping(address => uint256)) public claimed;

    /// @notice Pooled rounds only: cumulative amount settled to a member by {distribute}.
    mapping(uint8 => mapping(address => uint256)) public credited;

    mapping(uint8 => uint256) internal poolBalance;

    mapping(uint8 => uint256) internal _unlockSnapshot;

    mapping(uint8 => address[]) internal _members;

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier whenStarted() {
        if (startTime == 0) revert NotStarted();
        _;
    }


    // ─── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param initialSupply_       ENC's fixed total supply; baseline for {cumulativeBurned}.
     * @param teamBeneficiary_     Sole TEAM recipient; allocated 450,000,000 ENC.
     * @param treasuryBeneficiary_ Sole TREASURY recipient; allocated 1,520,000,000 ENC.
     * @param publicBeneficiary_   Sole PUBLIC recipient; allocated 970,000,000 ENC
     *                             (990,000,000 less the 20,000,000 ENC Public Sale
     *                             carve-out, sold separately through the standalone
     *                             EnishiPublicSale contract — not administered here).
     *                             Its TGE tranche (178,000,000 ENC) is unlocked
     *                             from {startTime} and pulled with {claim}; the ENC
     *                             for it is held here like every other allocation.
     * @param referralRegistry_    Registry used to register SEED/PRIVATE
     *                             beneficiaries under a referrer at allocation time.
     *                             This contract must separately be granted an
     *                             authorized-caller slot on it.
     * @dev   This vault is deployed before ENC exists, so it learns the token
     *        address at {start} rather than here. Deploying starts nothing: the TGE
     *        moment anchoring the PUBLIC schedule is set by {start}, which the owner
     *        presses once ENC is live and the vault can be funded.
     */
    constructor(
        uint256 initialSupply_,
        address teamBeneficiary_,
        address treasuryBeneficiary_,
        address publicBeneficiary_,
        address referralRegistry_
    ) {
        if (
            teamBeneficiary_ == address(0) ||
            treasuryBeneficiary_ == address(0) ||
            publicBeneficiary_ == address(0) ||
            referralRegistry_ == address(0)
        ) revert ZeroAddress();
        if (initialSupply_ == 0) revert ZeroAmount();
        INITIAL_SUPPLY = initialSupply_;

        REFERRAL_REGISTRY = IReferralRegistry(referralRegistry_);

        _grantRole(DEFAULT_ADMIN_ROLE, _msgSender());

        allocation[TEAM][teamBeneficiary_] = TEAM_ALLOCATION;
        groupAssigned[TEAM] = TEAM_ALLOCATION;
        emit AllocationSet(TEAM, teamBeneficiary_, 0, TEAM_ALLOCATION);

        allocation[TREASURY][treasuryBeneficiary_] = TREASURY_ALLOCATION;
        groupAssigned[TREASURY] = TREASURY_ALLOCATION;
        emit AllocationSet(
            TREASURY,
            treasuryBeneficiary_,
            0,
            TREASURY_ALLOCATION
        );

        allocation[PUBLIC][publicBeneficiary_] = PUBLIC_ALLOCATION;
        emit AllocationSet(PUBLIC, publicBeneficiary_, 0, PUBLIC_ALLOCATION);

        totalOutstanding =
            TEAM_ALLOCATION +
            TREASURY_ALLOCATION +
            PUBLIC_ALLOCATION;
    }

    // ─── External: admin ──────────────────────────────────────────────────────

    /**
     * @notice Wire the ENC token, pull in whatever the vault is still short of
     *         `totalOutstanding`, anchor the TGE and open the vault for business.
     *         Approve this contract for the shortfall first; a vault already funded
     *         by the genesis mint pulls nothing. One-shot.
     * @param enc_ The ENC token this vault pays out. Fixed from here on.
     */
    function start(address enc_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 startedAt = startTime;
        if (startedAt != 0) revert AlreadyStarted(startedAt);
        if (enc_ == address(0)) revert ZeroAddress();

        IENC token = IENC(enc_);
        ENC_TOKEN = token;
        emit EncTokenSet(enc_);

        uint256 required = totalOutstanding;
        uint256 bal = token.balanceOf(address(this));

        if (bal < required) {
            token.safeTransferFrom(_msgSender(), address(this), required - bal);
            bal = token.balanceOf(address(this));
            if (bal < required) revert Underfunded(required, bal);
        }

        uint256 now_ = _now();
        startTime = now_;
        emit Started(now_);
    }

    /**
     * @notice Register new SEED/PRIVATE investors.
     * @param roundId       {SEED} or {PRIVATE}.
     * @param beneficiaries Investor wallets. Must not already have an allocation.
     * @param amounts       Total allocation per investor. Σ must stay within `groupCap(roundId)`.
     * @param referrers     Referrer per investor. Registers the investor into
     *                      {REFERRAL_REGISTRY} under it. Ignored — address(0)
     *                      included — for an investor already registered there
     *                      (e.g. a prior direct Vault deposit or an earlier round),
     *                      whose existing referrer stands. Required otherwise:
     *                      address(0) for an unregistered investor reverts
     *                      {ReferrerRequired}.
     * @param settleFirst If true, settle the round's accrued unlocks before adding,
     *                    so existing members' vested amounts are not diluted.
     * @dev   Before {start} this needs no ENC on hand: the vault may still be empty.
     *        Once the vault is open, the registration must stay fully backed —
     *        `totalOutstanding` may not exceed the ENC held.
     */
    function addBeneficiaries(
        uint8 roundId,
        address[] calldata beneficiaries,
        uint256[] calldata amounts,
        address[] calldata referrers,
        bool settleFirst
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        _requirePooledRound(roundId);
        uint256 len = beneficiaries.length;
        if (len != amounts.length || len != referrers.length)
            revert LengthMismatch();
        if (len == 0) revert EmptyInput();

        if (settleFirst && _members[roundId].length != 0) _settle(roundId);

        uint256 outstanding = totalOutstanding;
        uint256 assigned = groupAssigned[roundId];

        for (uint256 i = 0; i < len; ++i) {
            address who = beneficiaries[i];
            if (who == address(0)) revert ZeroAddress();
            uint256 newAmt = amounts[i];
            if (newAmt == 0) revert ZeroAmount();
            if (allocation[roundId][who] != 0)
                revert AllocationAlreadySet(roundId, who);
            allocation[roundId][who] = newAmt;
            _members[roundId].push(who);
            outstanding += newAmt;
            assigned += newAmt;
            emit AllocationSet(roundId, who, 0, newAmt);
            _registerReferrer(who, referrers[i]);
        }

        uint256 maxCap = groupCap(roundId);
        if (assigned > maxCap)
            revert AllocationCapExceeded(roundId, assigned, maxCap);

        groupAssigned[roundId] = assigned;
        totalOutstanding = outstanding;

        if (startTime != 0) {
            uint256 bal = ENC_TOKEN.balanceOf(address(this));
            if (outstanding > bal) revert Underfunded(outstanding, bal);
        }
    }

    // ─── External: operator ───────────────────────────────────────────────────

    /**
     * @notice Credit the round's pending pool to its members pro-rata by
     *         allocation and push the ENC to their wallets in one call.
     * @param roundId {SEED} or {PRIVATE}.
     * @return paid     Total ENC transferred out by this press.
     * @return leftover Pool remaining afterwards; > 0 means press again.
     */
    function distribute(
        uint8 roundId
    )
        external
        onlyRole(OPERATOR_ROLE)
        whenStarted
        nonReentrant
        returns (uint256 paid, uint256 leftover)
    {
        _requirePooledRound(roundId);
        paid = _settle(roundId);
        if (paid == 0) revert NothingToDistribute(roundId);
        leftover = poolBalance[roundId];
    }

    // ─── External: beneficiary ───────────────────────────────────────────────────────

    function claim(
        uint8 roundId
    ) external whenStarted nonReentrant returns (uint256 amount) {
        if (roundId >= ROUND_COUNT) revert UnknownRound(roundId);
        if (_isPooledRound(roundId)) revert OperatorDistributedRound(roundId);
        amount = _release(roundId, _msgSender());
        if (amount == 0) revert NothingToClaim();
    }

    function claimAll()
        external
        whenStarted
        nonReentrant
        returns (uint256 total)
    {
        address beneficiary = _msgSender();
        for (uint8 roundId = TEAM; roundId < ROUND_COUNT; ++roundId) {
            total += _release(roundId, beneficiary);
        }
        if (total == 0) revert NothingToClaim();
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice Cumulative ENC burned since deploy (initial supply − current supply).
    function cumulativeBurned() public view returns (uint256) {
        IENC token = ENC_TOKEN;
        if (address(token) == address(0)) return 0; // unstarted: nothing burned yet
        uint256 supply = token.totalSupply();
        return supply >= INITIAL_SUPPLY ? 0 : INITIAL_SUPPLY - supply;
    }

    /// @notice Returns true when every non-Public round has fully unlocked,
    ///         i.e. cumulative burn has reached {EnishiConstants.ENC_MAX_BURN}.
    function isAllNonPublicUnlocked() external view returns (bool) {
        return cumulativeBurned() >= EnishiConstants.ENC_MAX_BURN;
    }

    function groupCap(uint256 roundId) public pure returns (uint256) {
        if (roundId == SEED) return SEED_ALLOCATION;
        if (roundId == PRIVATE) return PRIVATE_ALLOCATION;
        if (roundId == TEAM) return TEAM_ALLOCATION;
        if (roundId == TREASURY) return TREASURY_ALLOCATION;
        return 0;
    }

    /// @notice Total ENC unlocked so far for a burn group (across all its members).
    function groupUnlocked(uint8 roundId) external view returns (uint256) {
        if (roundId >= BURN_GROUPS) revert UnknownRound(roundId);
        return _groupUnlockedAll(cumulativeBurned())[roundId];
    }

    /// @notice ENC a pooled round has unlocked but not yet credited to anyone,
    ///         including unlock not yet accrued into storage.
    function pendingPool(uint8 roundId) public view returns (uint256) {
        _requirePooledRound(roundId);
        uint256 unlocked = _groupUnlockedAll(cumulativeBurned())[roundId];
        uint256 snapshot = _unlockSnapshot[roundId];
        return
            poolBalance[roundId] +
            (unlocked > snapshot ? unlocked - snapshot : 0);
    }

    /// @notice Every registered investor of a pooled round.
    function roundMembers(
        uint8 roundId
    ) external view returns (address[] memory) {
        _requirePooledRound(roundId);
        return _members[roundId];
    }

    /// @notice What the next {distribute} press would pay each member, and what
    ///         stays pooled. Read-only mirror of `_accrue` + `_allocatePool`.
    function previewDistribution(
        uint8 roundId
    )
        external
        view
        returns (
            address[] memory beneficiaries,
            uint256[] memory amounts,
            uint256 leftover
        )
    {
        _requirePooledRound(roundId);
        address[] storage members = _members[roundId];
        uint256 len = members.length;

        beneficiaries = new address[](len);
        for (uint256 i = 0; i < len; ++i) {
            beneficiaries[i] = members[i];
        }

        uint256 pool = pendingPool(roundId);
        uint256 allocated;
        (amounts, allocated) = _computeShares(roundId, pool);
        leftover = pool - allocated;
    }

    /// @notice Currently-claimable ENC for `beneficiary` in `roundId`.
    function claimable(
        uint8 roundId,
        address beneficiary
    ) external view returns (uint256) {
        if (roundId >= ROUND_COUNT) revert UnknownRound(roundId);
        uint256 entitlement = _entitlement(roundId, beneficiary);
        uint256 claimedAmount = claimed[roundId][beneficiary];
        return entitlement > claimedAmount ? entitlement - claimedAmount : 0;
    }

    /// @notice A beneficiary's total allocation and cumulative claimed amount.
    function allocationOf(
        uint8 roundId,
        address beneficiary
    ) external view returns (uint256 allocatedAmount, uint256 claimedAmount) {
        return (
            allocation[roundId][beneficiary],
            claimed[roundId][beneficiary]
        );
    }

    /// @notice Unlocked bps of the PUBLIC allocation (TGE included).
    function publicUnlockedBps() external view returns (uint16) {
        return _publicBps();
    }

    /// @notice Number of monthly PUBLIC releases due so far (0..60).
    function publicReleasesUnlocked() external view returns (uint256) {
        return _publicReleases();
    }

    /// @notice Due timestamp of PUBLIC release `index` (1..60).
    function publicReleaseTime(uint256 index) external view returns (uint256) {
        if (index == 0 || index > PUBLIC_RELEASE_COUNT)
            revert InvalidReleaseIndex(index);
        uint256 anchor = startTime;
        if (anchor == 0) revert NotStarted();
        return
            anchor +
            PUBLIC_CLIFF_SECONDS +
            (index - 1) *
            PUBLIC_RELEASE_INTERVAL;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @dev Clock for the PUBLIC schedule. Production behavior is plain
    ///      `block.timestamp`; a testnet-only subclass may override it to
    ///      fast-forward through the cliff and monthly releases.
    function _now() internal view virtual returns (uint256) {
        return block.timestamp;
    }

    function _registerReferrer(address who, address referrer) internal {
        if (REFERRAL_REGISTRY.parentOf(who) != address(0)) return;
        if (referrer == address(0)) revert ReferrerRequired(who);
        REFERRAL_REGISTRY.registerWithReferrer(who, referrer);
    }

    function _isPooledRound(uint8 roundId) internal pure returns (bool) {
        return roundId == SEED || roundId == PRIVATE;
    }

    function _requirePooledRound(uint8 roundId) internal pure {
        if (!_isPooledRound(roundId)) revert UnknownRound(roundId);
    }

    function _settle(uint8 roundId) internal returns (uint256 paid) {
        _accrue(roundId);
        uint256 leftover = _allocatePool(roundId);

        address[] storage members = _members[roundId];
        uint256 len = members.length;
        uint256 recipients;
        for (uint256 i = 0; i < len; ++i) {
            uint256 amount = _release(roundId, members[i]);
            if (amount != 0) {
                paid += amount;
                ++recipients;
            }
        }

        if (paid != 0) emit Distributed(roundId, recipients, paid, leftover);
    }

    /// @dev Move a pooled round's newly unlocked ENC into its pending pool.
    function _accrue(uint8 roundId) internal {
        uint256 unlocked = _groupUnlockedAll(cumulativeBurned())[roundId];
        uint256 snapshot = _unlockSnapshot[roundId];
        if (unlocked <= snapshot) return;

        uint256 delta = unlocked - snapshot;
        _unlockSnapshot[roundId] = unlocked;
        uint256 pool = poolBalance[roundId] + delta;
        poolBalance[roundId] = pool;
        emit PoolAccrued(roundId, delta, pool);
    }

    /// @dev Split `pool` pro-rata by allocation over members that still have room.
    function _computeShares(
        uint8 roundId,
        uint256 pool
    ) internal view returns (uint256[] memory shares, uint256 allocated) {
        address[] storage members = _members[roundId];
        uint256 len = members.length;
        shares = new uint256[](len);
        if (pool == 0) return (shares, 0);

        uint256 activeWeight;
        for (uint256 i = 0; i < len; ++i) {
            address who = members[i];
            uint256 allocatedTo = allocation[roundId][who];
            if (allocatedTo > credited[roundId][who])
                activeWeight += allocatedTo;
        }
        if (activeWeight == 0) return (shares, 0);

        for (uint256 i = 0; i < len; ++i) {
            address who = members[i];
            uint256 allocatedTo = allocation[roundId][who];
            uint256 creditedTo = credited[roundId][who];
            if (allocatedTo <= creditedTo) continue;

            uint256 share = Math.mulDiv(pool, allocatedTo, activeWeight);
            uint256 room = allocatedTo - creditedTo;
            if (share > room) share = room;
            shares[i] = share;
            allocated += share;
        }
    }

    function _allocatePool(uint8 roundId) internal returns (uint256 leftover) {
        uint256 pool = poolBalance[roundId];
        if (pool == 0) return 0;

        (uint256[] memory shares, uint256 allocated) = _computeShares(
            roundId,
            pool
        );

        address[] storage members = _members[roundId];
        uint256 len = shares.length;
        for (uint256 i = 0; i < len; ++i) {
            uint256 share = shares[i];
            if (share == 0) continue;
            address who = members[i];
            credited[roundId][who] += share;
        }

        leftover = pool - allocated;
        poolBalance[roundId] = leftover;
        emit PoolAllocated(roundId, allocated, leftover);
    }

    /// @dev Pay out `who`'s entitlement above what they already claimed.
    function _release(
        uint8 roundId,
        address who
    ) internal returns (uint256 amount) {
        uint256 entitlement = _entitlement(roundId, who);
        uint256 claimedAmount = claimed[roundId][who];
        if (entitlement <= claimedAmount) return 0;

        amount = entitlement - claimedAmount;
        claimed[roundId][who] = entitlement; // cumulative
        totalOutstanding -= amount; // balance drops by the same amount below

        ENC_TOKEN.safeTransfer(who, amount);
        emit Claimed(roundId, who, amount);
    }

    /// @dev Cumulative entitlement: `credited` for pooled rounds, burn-share for
    ///      TEAM/TREASURY, time schedule for PUBLIC.
    function _entitlement(
        uint8 roundId,
        address who
    ) internal view returns (uint256) {
        uint256 allocatedAmount = allocation[roundId][who];
        if (allocatedAmount == 0) return 0;

        if (_isPooledRound(roundId)) return credited[roundId][who];

        if (roundId < BURN_GROUPS) {
            uint256 cap = groupCap(roundId);
            if (cap == 0) return 0;
            uint256 groupUnlockedAmount = _groupUnlockedAll(cumulativeBurned())[
                roundId
            ];
            return Math.mulDiv(allocatedAmount, groupUnlockedAmount, cap);
        }

        // Callers already guard roundId < ROUND_COUNT, so PUBLIC is the only
        // value left once the branches above are ruled out — asserted here
        // rather than left implicit, since this function used to also branch
        // on a since-removed PUBLIC_SALE round.
        assert(roundId == PUBLIC);
        return _publicEntitlement(allocatedAmount);
    }

    function _publicEntitlement(
        uint256 allocatedAmount
    ) internal view returns (uint256) {
        uint256 anchor = startTime;
        if (anchor == 0 || _now() < anchor) return 0;
        uint256 tgeAmount = Math.mulDiv(
            allocatedAmount,
            PUBLIC_TGE_AMOUNT,
            PUBLIC_ALLOCATION
        );
        uint256 releases = _publicReleases();
        if (releases == 0) return tgeAmount;
        if (releases >= PUBLIC_RELEASE_COUNT) return allocatedAmount;
        return
            tgeAmount +
            Math.mulDiv(
                allocatedAmount - tgeAmount,
                releases,
                PUBLIC_RELEASE_COUNT
            );
    }

    /// @dev Releases due: 0 during the lock-up, then 1 + one per 30 days, capped at 60.
    function _publicReleases() internal view returns (uint256) {
        uint256 anchor = startTime;
        uint256 now_ = _now();
        if (anchor == 0 || now_ < anchor) return 0;
        uint256 elapsed = now_ - anchor;
        if (elapsed < PUBLIC_CLIFF_SECONDS) return 0;
        uint256 releases = (elapsed - PUBLIC_CLIFF_SECONDS) /
            PUBLIC_RELEASE_INTERVAL +
            1;
        return
            releases > PUBLIC_RELEASE_COUNT ? PUBLIC_RELEASE_COUNT : releases;
    }

    function _publicBps() internal view returns (uint16) {
        return uint16(_publicEntitlement(BPS_DENOMINATOR));
    }

    /// @dev Burn-split bps per group for `phase` (phase N = groups 0..N−1 full).
    function _phaseRates(
        uint256 phase
    ) internal pure returns (uint16[4] memory) {
        if (phase == SEED) return [uint16(4000), 4000, 1000, 1000];
        if (phase == PRIVATE) return [uint16(0), 6000, 2000, 2000];
        if (phase == TEAM) return [uint16(0), 0, 5000, 5000];
        return [uint16(0), 0, 0, 10000];
    }

    /// @dev Walk the phases: in each, spend burn at that phase's rates until the
    ///      limiting group (index == phase) hits its cap, then move on.
    function _groupUnlockedAll(
        uint256 burnedAmount
    ) internal pure returns (uint256[4] memory unlockedPerGroup) {
        uint256 remainingBurn = burnedAmount;
        for (uint256 phase = 0; phase < BURN_GROUPS; ++phase) {
            if (remainingBurn == 0) break;
            uint16[4] memory phaseRates = _phaseRates(phase);
            uint256 limitingGroupRate = phaseRates[phase]; // limiting group's rate (always > 0)
            uint256 cap = groupCap(phase);
            uint256 missingToCap = cap > unlockedPerGroup[phase]
                ? cap - unlockedPerGroup[phase]
                : 0;
            uint256 burnToFill = missingToCap == 0
                ? 0
                : Math.ceilDiv(
                    missingToCap * BPS_DENOMINATOR,
                    limitingGroupRate
                );
            uint256 burnUsed = remainingBurn < burnToFill
                ? remainingBurn
                : burnToFill;

            for (uint256 group = phase; group < BURN_GROUPS; ++group) {
                if (phaseRates[group] != 0) {
                    unlockedPerGroup[group] +=
                        (burnUsed * phaseRates[group]) /
                        BPS_DENOMINATOR;
                }
            }
            if (burnToFill != 0 && burnUsed == burnToFill) {
                unlockedPerGroup[phase] = cap;
            }
            remainingBurn -= burnUsed;
        }
        for (uint256 group = 0; group < BURN_GROUPS; ++group) {
            if (unlockedPerGroup[group] > groupCap(group))
                unlockedPerGroup[group] = groupCap(group);
        }
    }
}
