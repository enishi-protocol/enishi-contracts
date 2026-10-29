// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Registry of Strategy EOA Wallets (SEOAs) and per-user SEOA assignments.
interface IWhiteList {
    // ─── Events ───────────────────────────────────────────────────────────────

    event SEOAsPicked(address indexed user, address[] seoas);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error ZeroAddress();
    error EmptyInput();
    error SEOAAlreadyRegistered(address seoa);
    error PoolExhausted(uint256 requested, uint256 available);
    error UserAlreadyPicked(address user);

    // ─── Constants ────────────────────────────────────────────────────────────

    /// @notice Fixed number of SEOAs assigned per user.
    function SEOAS_PER_USER() external view returns (uint256);

    /// @notice Role identifier granted to addresses allowed to call `pick`.
    function OPERATOR_ROLE() external view returns (bytes32);

    // ─── Views ────────────────────────────────────────────────────────────────

    function isWhitelisted(address seoa) external view returns (bool);
    function seoaToUser(address seoa) external view returns (address);
    function poolSize() external view returns (uint256);
    function poolLength() external view returns (uint120);
    function cursor() external view returns (uint120);
    function availableInPool() external view returns (uint256);

    /// @notice Returns all SEOAs assigned to `user`. Empty if not picked yet.
    function getUserSEOAs(address user) external view returns (address[] memory);

    /// @notice Whether `user` has been picked for already.
    function userPicked(address user) external view returns (bool);

    // ─── Admin functions ──────────────────────────────────────────────────────

    function registerSEOAs(address[] calldata seoas) external;

    /// @notice Pause `registerSEOAs` and `pick`. Admin-only.
    function pause() external;

    /// @notice Resume operations. Admin-only.
    function unpause() external;

    // ─── Operator functions ───────────────────────────────────────────────────

    /// @notice Assigns exactly SEOAS_PER_USER fresh SEOAs from the pool to `user`.
    /// @dev    Can only be called once per user. Reverts `UserAlreadyPicked` on retry.
    function pick(address user) external returns (address[] memory assigned);
}
