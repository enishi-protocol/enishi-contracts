// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  ISwapContractFactory
 * @notice Deploys per-user, per-strategy Swap Contracts (SWCs) as EIP-1167
 *         minimal proxy clones. Tracks the clone for each
 *         (user, availableTokenAddress) pair so a subsequent deposit reuses
 *         the existing SWC.
 */
interface ISwapContractFactory {
    // ─── Events ───────────────────────────────────────────────────────────────

    event SwapContractCreated(
        address indexed user,
        address indexed availableTokenAddress,
        address indexed operator,
        address swc
    );
    event VaultUpdated(address indexed oldVault, address indexed newVault);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error ZeroAddress();
    error LengthMismatch();
    error EmptyInput();
    error NotVault(address caller);
    error AlreadyCreated(address user, address availableTokenAddress);
    error OperatorAlreadyAssigned(address operator, address existingSwc);

    // ─── Views ────────────────────────────────────────────────────────────────

    function IMPLEMENTATION() external view returns (address);
    function vault() external view returns (address);
    function swcOf(address user, address availableTokenAddress) external view returns (address);
    function swcOfOperator(address operator) external view returns (address);

    function predictAddress(
        address user,
        address availableTokenAddress,
        bytes32 salt
    ) external view returns (address);

    // ─── Vault API ────────────────────────────────────────────────────────────

    function createBatch(
        address user,
        address[] calldata operators,
        address[] calldata availableTokenAddresses
    ) external returns (address[] memory swcs);

    function createDeterministic(
        address user,
        address operator,
        address availableTokenAddress,
        bytes32 salt
    ) external returns (address swc);

    // ─── Admin ────────────────────────────────────────────────────────────────

    function setVault(address newVault) external;
}
