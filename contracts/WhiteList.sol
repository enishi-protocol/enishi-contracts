// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {EnishiConstants} from "./libraries/EnishiConstants.sol";
import "./interfaces/IWhiteList.sol";

/**
 * @title WhiteList
 * @notice Registry of Strategy EOA Wallets (SEOAs) and per-user SEOA assignments.
 *
 * Design:
 *   - `DEFAULT_ADMIN_ROLE` (Enishi admin) pre-registers SEOAs and manages roles.
 *   - `OPERATOR_ROLE` (Vault Contract) calls `pick(user)` to assign exactly
 *     `SEOAS_PER_USER` (7) SEOAs to a user. Sequential cursor → no SEOA ever shared
 *     between two users.
 *   - Each user can only be picked for once.
 *
 * Role management uses the standard OpenZeppelin AccessControl API:
 *   - `grantRole(OPERATOR_ROLE, addr)`   — authorize a new operator
 *   - `revokeRole(OPERATOR_ROLE, addr)`  — remove an operator
 *   - `hasRole(OPERATOR_ROLE, addr)`     — query
 *   - Admins of `OPERATOR_ROLE` default to `DEFAULT_ADMIN_ROLE` holders.
 */
contract WhiteList is AccessControl, Pausable, IWhiteList {
    // ─── Constants ────────────────────────────────────────────────────────────

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    uint256 public constant SEOAS_PER_USER = EnishiConstants.STRATEGY_COUNT;

    uint256 private constant _OWNER_SHIFT = 96;

    // ─── State ────────────────────────────────────────────────────────────────

    // Packed with Pausable: [_paused:1B | cursor:15B | poolLength:15B]
    uint120 public cursor;
    uint120 public poolLength;

    // Pool index → SEOA
    mapping(uint256 => address) internal _seoaByIndex;

    // SEOA → packed (poolIndex+1 in low 96b, owner in high 160b)
    mapping(address => uint256) internal _seoaInfo;

    // user → (pool start index + 1). 0 means "not picked yet".
    // The user's `SEOAS_PER_USER` SEOAs are at `_seoaByIndex[start..start+15]` — we
    // derive the list from `_seoaByIndex` on read instead of duplicating it here.
    mapping(address => uint256) internal _userStartIdxPlusOne;

    // ─── Constructor ──────────────────────────────────────────────────────────

    /**
     * @notice Initialize the contract: deployer becomes admin, `operator_` gets OPERATOR_ROLE.
     * @param  operator_ Address granted `OPERATOR_ROLE` (typically the Vault contract).
     *                   Must be non-zero. Additional operators can be added later via
     *                   `grantRole(OPERATOR_ROLE, addr)`.
     */
    constructor(address operator_) {
        if (operator_ == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, _msgSender());
        _grantRole(OPERATOR_ROLE, operator_);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /**
     * @notice Total number of SEOAs ever registered (cumulative, never decreases).
     * @return Equivalent to `poolLength`.
     */
    function poolSize() external view returns (uint256) {
        return poolLength;
    }

    /**
     * @notice Number of SEOAs still available to be picked from the pool.
     * @return `poolLength - cursor`.
     */
    function availableInPool() external view returns (uint256) {
        unchecked {
            return poolLength - cursor;
        }
    }

    /**
     * @notice Whether a given address is registered in the SEOA pool.
     * @param  seoa The address to check.
     * @return True if `seoa` was added via `registerSEOAs`, false otherwise.
     */
    function isWhitelisted(address seoa) external view returns (bool) {
        return _seoaInfo[seoa] != 0;
    }

    /**
     * @notice Returns the user that owns a given SEOA, or `address(0)` if not yet picked.
     * @param  seoa The SEOA address to look up.
     * @return The user that was assigned this SEOA, or zero address if unassigned.
     */
    function seoaToUser(address seoa) external view returns (address) {
        return address(uint160(_seoaInfo[seoa] >> _OWNER_SHIFT));
    }

    /**
     * @notice Return the full list of SEOAs assigned to a user.
     * @param  user The user to query.
     * @return list An array of exactly `SEOAS_PER_USER` SEOAs in pick order, or an
     *              empty array if the user has never been picked for.
     */
    function getUserSEOAs(
        address user
    ) external view returns (address[] memory list) {
        uint256 startPlusOne = _userStartIdxPlusOne[user];
        if (startPlusOne == 0) return new address[](0);
        uint256 start;
        unchecked {
            start = startPlusOne - 1;
        }
        list = new address[](SEOAS_PER_USER);
        for (uint256 i = 0; i < SEOAS_PER_USER; ) {
            list[i] = _seoaByIndex[start + i];
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Whether a user has already been picked for (has `SEOAS_PER_USER` SEOAs assigned).
     * @param  user The user to check.
     * @return True if `pick(user)` has been called successfully, false otherwise.
     */
    function userPicked(address user) external view returns (bool) {
        return _userStartIdxPlusOne[user] != 0;
    }

    // ─── Admin functions ──────────────────────────────────────────────────────

    /**
     * @notice Pause `registerSEOAs` and `pick`. Only callable by `DEFAULT_ADMIN_ROLE`.
     * @dev    Use for emergency lock-down; does not affect role management or views.
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Unpause the contract. Only callable by `DEFAULT_ADMIN_ROLE`.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @notice Append SEOAs to the pool. Only callable by `DEFAULT_ADMIN_ROLE`.
     * @param  seoas Addresses to register. Each must be non-zero and not yet
     *              registered. The batch and its start index are available in
     *              the transaction calldata / `poolLength`.
     */
    function registerSEOAs(
        address[] calldata seoas
    ) external onlyRole(DEFAULT_ADMIN_ROLE) whenNotPaused {
        uint256 len = seoas.length;
        if (len == 0) revert EmptyInput();

        uint256 startIndex = poolLength;
        for (uint256 i = 0; i < len; ) {
            address seoa = seoas[i];
            if (seoa == address(0)) revert ZeroAddress();
            if (_seoaInfo[seoa] != 0) revert SEOAAlreadyRegistered(seoa);

            uint256 idx;
            unchecked {
                idx = startIndex + i;
            }
            _seoaByIndex[idx] = seoa;
            _seoaInfo[seoa] = idx + 1;

            unchecked {
                ++i;
            }
        }
        unchecked {
            poolLength = uint120(startIndex + len);
        }
    }

    // ─── Operator functions ───────────────────────────────────────────────────

    /**
     * @notice Assign exactly `SEOAS_PER_USER` fresh SEOAs from the pool to `user`.
     * @dev    Callable only by accounts holding `OPERATOR_ROLE`.
     * @param  user The user to assign SEOAs to. Must be non-zero and not yet picked.
     * @return assigned Array of `SEOAS_PER_USER` SEOA addresses now owned by `user`, in pick order.
     */
    function pick(
        address user
    )
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        returns (address[] memory assigned)
    {
        if (user == address(0)) revert ZeroAddress();
        if (_userStartIdxPlusOne[user] != 0) revert UserAlreadyPicked(user);

        uint256 cursor_ = cursor;
        uint256 poolLen = poolLength;
        if (cursor_ + SEOAS_PER_USER > poolLen) {
            unchecked {
                revert PoolExhausted(SEOAS_PER_USER, poolLen - cursor_);
            }
        }

        assigned = new address[](SEOAS_PER_USER);
        uint256 ownerWord = uint256(uint160(user)) << _OWNER_SHIFT;

        unchecked {
            for (uint256 i = 0; i < SEOAS_PER_USER; ++i) {
                uint256 poolIdx = cursor_ + i;
                address seoa = _seoaByIndex[poolIdx];
                assigned[i] = seoa;
                _seoaInfo[seoa] = ownerWord | (poolIdx + 1);
            }
            _userStartIdxPlusOne[user] = cursor_ + 1; // 1-based sentinel
            cursor = uint120(cursor_ + SEOAS_PER_USER);
        }

        emit SEOAsPicked(user, assigned);
    }
}
