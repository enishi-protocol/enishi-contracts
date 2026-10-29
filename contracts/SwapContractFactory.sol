// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ISwapContractFactory} from "./interfaces/ISwapContractFactory.sol";
import {ISwapContract} from "./interfaces/ISwapContract.sol";
import {SwapContract} from "./SwapContract.sol";

/**
 * @title  SwapContractFactory
 * @notice Deploys per-user, per-strategy {SwapContract} instances as EIP-1167
 *         minimal proxy clones.
 *
 *         Roles:
 *           - `owner` (OZ {Ownable}): rotates `vault` for *future* clones.
 *                                     Cannot touch existing clones.
 *           - `vault`: only address allowed to mint new clones.
 *
 *         Two indexes enforce the spec's uniqueness invariants:
 *           - {swcOf}[user][availableTokenAddress] → SWC: one SWC per user
 *                                                    per underlying token.
 *           - {swcOfOperator}[operator] → SWC: each operator EOA (SWA)
 *                                              controls exactly one clone.
 *         `vault` set on the factory at clone time is baked into the clone's
 *         storage; subsequent factory rotations only affect *newly created*
 *         clones. The DEX router is hard-coded in {SwapContract.DEX}, shared
 *         by every clone.
 */
contract SwapContractFactory is ISwapContractFactory, Ownable {
    using Clones for address;

    // ─── State ────────────────────────────────────────────────────────────────

    address public immutable IMPLEMENTATION;
    address public vault;

    mapping(bytes32 => address) internal _swcOf;
    mapping(address => address) public swcOfOperator;

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault(msg.sender);
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor() Ownable(msg.sender) {
        IMPLEMENTATION = address(new SwapContract());
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /**
     * @notice Lookup the SWC clone for `(user, availableTokenAddress)`.
     *         Returns zero address if no clone exists for this pair.
     * @param  user                  Owner of the SWC in off-chain books.
     * @param  availableTokenAddress ERC-20 the SWC is responsible for.
     * @return swc                   Address of the deployed clone, or zero.
     */
    function swcOf(
        address user,
        address availableTokenAddress
    ) external view returns (address swc) {
        return _swcOf[_swcKey(user, availableTokenAddress)];
    }

    /// @dev Composite key for {_swcOf}: keccak256(user, availableTokenAddress).
    function _swcKey(
        address user,
        address availableTokenAddress
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(user, availableTokenAddress));
    }

    /**
     * @notice Compute the deterministic clone address for `salt` without
     *         deploying. Mirrors {createDeterministic}.
     * @param  salt      Caller-chosen salt; CREATE2 input.
     * @return predicted Address the clone would have if {createDeterministic}
     *                   were called with this salt.
     */
    function predictAddress(
        address user,
        address availableTokenAddress,
        bytes32 salt
    ) external view returns (address predicted) {
        /*
         * Clone bytecode embeds (vault, availableToken, user) as immutable
         * args, so the predicted address depends on them.
         */
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                IMPLEMENTATION,
                abi.encode(vault, availableTokenAddress, user),
                salt,
                address(this)
            );
    }

    // ─── Vault API ────────────────────────────────────────────────────────────

    /**
     * @notice Create `operators.length` clones for `user` in one call, one
     *         clone per `availableTokenAddress`. Reverts if any
     *         (user, availableTokenAddresses[i]) already has a clone.
     *         Clone addresses are non-deterministic (CREATE); use
     *         {createDeterministic} when the address must be known up front.
     * @param user                    Owner of these SWCs in off-chain books.
     * @param operators               EOAs (SEOAs) from the WhiteList, one per
     *                                clone; each becomes the clone's
     *                                {SwapContract.operator}.
     * @param availableTokenAddresses ERC-20 each clone is responsible for
     *                                (one per clone); doubles as the strategy
     *                                key in {swcOf}.
     * @return swcs                   Newly created clone addresses, in input
     *                                order.
     */
    function createBatch(
        address user,
        address[] calldata operators,
        address[] calldata availableTokenAddresses
    ) external onlyVault returns (address[] memory swcs) {
        if (user == address(0)) revert ZeroAddress();
        uint256 len = operators.length;
        if (len == 0) revert EmptyInput();
        if (availableTokenAddresses.length != len) revert LengthMismatch();

        swcs = new address[](len);
        address impl = IMPLEMENTATION;
        address vault_ = vault;

        for (uint256 i; i < len; ) {
            /*
             * Bake (vault, availableToken, user) into the clone's immutable
             * args — read back by the SWC via Clones.fetchCloneArgs, no init
             * SSTORE.
             */
            address clone = Clones.cloneWithImmutableArgs(
                impl,
                abi.encode(vault_, availableTokenAddresses[i], user)
            );
            _registerClone(
                user,
                operators[i],
                availableTokenAddresses[i],
                clone
            );
            swcs[i] = clone;

            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Create a single clone at a deterministic address derived from
     *         `salt`. Useful for cross-chain mirroring, pre-funding, or
     *         idempotent deploy scripts. Reverts if a clone already exists
     *         for `(user, availableTokenAddress)` or if the predicted address
     *         is already occupied.
     * @param user                  Owner of the SWC in off-chain books.
     * @param operator              EOA (SWA) that becomes the clone's operator.
     * @param availableTokenAddress ERC-20 this clone is responsible for;
     *                              doubles as the strategy key in {swcOf}.
     * @param salt                  CREATE2 salt; same salt always yields the
     *                              same address on a given chain.
     * @return swc                  Address of the deployed clone.
     */
    function createDeterministic(
        address user,
        address operator,
        address availableTokenAddress,
        bytes32 salt
    ) external onlyVault returns (address swc) {
        if (user == address(0)) revert ZeroAddress();

        swc = Clones.cloneDeterministicWithImmutableArgs(
            IMPLEMENTATION,
            abi.encode(vault, availableTokenAddress, user),
            salt
        );
        _registerClone(user, operator, availableTokenAddress, swc);
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @notice Shared post-clone bookkeeping for {createBatch} and
    ///         {createDeterministic}: checks `(user, availableTokenAddress)`
    ///         hasn't been registered, initializes the clone, indexes it,
    ///         and emits {SwapContractCreated}. `vault_` is passed in (not
    ///         re-read) so batch callers can hoist the SLOAD out of the loop.
    function _registerClone(
        address user,
        address operator,
        address availableTokenAddress,
        address clone
    ) internal {
        if (operator == address(0) || availableTokenAddress == address(0)) {
            revert ZeroAddress();
        }
        bytes32 key = _swcKey(user, availableTokenAddress);
        if (_swcOf[key] != address(0)) {
            revert AlreadyCreated(user, availableTokenAddress);
        }
        address existingSwc = swcOfOperator[operator];
        if (existingSwc != address(0)) {
            revert OperatorAlreadyAssigned(operator, existingSwc);
        }

        ISwapContract(clone).initialize(operator);

        _swcOf[key] = clone;
        swcOfOperator[operator] = clone;

        emit SwapContractCreated(user, availableTokenAddress, operator, clone);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /**
     * @notice Set the address allowed to mint new clones via {createBatch} /
     *         {createDeterministic}. Does NOT update `vault` on already-deployed
     *         clones — those keep the value baked in at their {initialize}.
     * @param newVault New vault address; must be non-zero.
     */
    function setVault(address newVault) external onlyOwner {
        if (newVault == address(0)) revert ZeroAddress();
        address old = vault;
        vault = newVault;
        emit VaultUpdated(old, newVault);
    }
}
