// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Registry that tracks approved referrers and their parent–child relationships.
interface IReferralRegistry {
    // ─── Events ───────────────────────────────────────────────────────────────

    event Registered(address indexed user, address indexed referrer);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error ZeroAddress();
    error SelfReferral();
    error AlreadyReferrer(address referrer);
    error ParentAlreadySet(address user);
    error ParentNotReferrer(address referrer);

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice Role every caller of {registerWithReferrer} must hold. Held by no
    ///         one at construction; granted to the Vault and ENCVesting during
    ///         wiring. Unlimited holders, revocable.
    function OPERATOR_ROLE() external view returns (bytes32);

    /// @notice Returns the parent referrer of `user`, or address(0) if not set.
    function parentOf(address user) external view returns (address);

    /// @notice Returns true if `referrer` is an approved referrer.
    function isReferrer(address referrer) external view returns (bool);

    /// @notice Returns true if `caller` holds {OPERATOR_ROLE}.
    function isOperator(address caller) external view returns (bool);

    // ─── Operator functions ───────────────────────────────────────────────────

    /// @notice Registers `user` into the referral system under `referrer`, and immediately approves them as a referrer.
    /// @param user     Address to register, must not already be registered.
    /// @param referrer Must be an already-approved referrer and must not equal `user`.
    function registerWithReferrer(address user, address referrer) external;
}
