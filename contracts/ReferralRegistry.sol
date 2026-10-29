// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/IReferralRegistry.sol";

/**
 * @title ReferralRegistry
 * @notice Stores valid referrers and their parent–child relationships.
 *
 * Flow:
 *   1. An `OPERATOR_ROLE` holder calls registerWithReferrer(user, referrer)
 *      — registers user and approves them as a referrer
 *
 * Roles:
 *   DEFAULT_ADMIN_ROLE — granted to the deployer at construction; grants/revokes
 *                        OPERATOR_ROLE and manages roles.
 *   OPERATOR_ROLE      — may call {registerWithReferrer}. Held by no one at
 *                        construction: the Vault and ENCVesting do not exist yet
 *                        at that point, so both are granted the role afterwards
 *                        during wiring. No cap on how many holders, revocable.
 *
 * Role management uses the standard OpenZeppelin AccessControl API:
 *   - `grantRole(OPERATOR_ROLE, addr)`   — authorize a new operator
 *   - `revokeRole(OPERATOR_ROLE, addr)`  — remove an operator
 *   - `hasRole(OPERATOR_ROLE, addr)`     — query
 *   - Admins of `OPERATOR_ROLE` default to `DEFAULT_ADMIN_ROLE` holders.
 */
contract ReferralRegistry is AccessControl, IReferralRegistry {
    // ─── Constants ────────────────────────────────────────────────────────────

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    // ─── State ────────────────────────────────────────────────────────────────

    // referrer => parent referrer (address(0) if not set)
    mapping(address => address) public parentOf;

    // whether an address is an approved referrer
    mapping(address => bool) public isReferrer;

    // ─── Constructor ──────────────────────────────────────────────────────────

    /**
     * @notice Deploys the registry with `root_` as the only approved referrer and
     *         the caller as {DEFAULT_ADMIN_ROLE}. No address holds
     *         {OPERATOR_ROLE} yet — grant it to the Vault and ENCVesting once
     *         they are deployed.
     * @param root_ Root address — approved as a referrer with no parent.
     */
    constructor(address root_) {
        if (root_ == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, _msgSender());

        isReferrer[root_] = true;

        emit Registered(root_, address(0));
    }

    // ─── External ─────────────────────────────────────────────────────────────

    /**
     * @notice Registers `user` under `referrer`, and immediately approves them
     *         as a referrer themselves.
     * @param user     Address to register, must not already be registered.
     * @param referrer Must be an already-approved referrer, and not `user`.
     */
    function registerWithReferrer(
        address user,
        address referrer
    ) external onlyRole(OPERATOR_ROLE) {
        if (user == referrer) revert SelfReferral();
        if (parentOf[user] != address(0)) revert ParentAlreadySet(user);
        if (isReferrer[user]) revert AlreadyReferrer(user);
        if (!isReferrer[referrer]) revert ParentNotReferrer(referrer);

        parentOf[user] = referrer;
        isReferrer[user] = true;

        emit Registered(user, referrer);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /**
     * @notice Whether `caller` may call {registerWithReferrer}.
     * @param  caller Address to check.
     * @return True if `caller` holds {OPERATOR_ROLE}.
     */
    function isOperator(address caller) external view returns (bool) {
        return hasRole(OPERATOR_ROLE, caller);
    }
}
