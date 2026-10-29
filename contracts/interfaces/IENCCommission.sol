// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Distributes ENC commission across referral, operating, CSR and burn destinations.
interface IENCCommission {
    // ─── Events ───────────────────────────────────────────────────────────────

    event Distributed(
        address indexed user,
        address indexed referrer,
        uint256 totalAmount,
        uint256 referralAmount,
        uint256 operatingAmount,
        uint256 csrAmount,
        uint256 burnAmount
    );
    event SplitChanged(
        uint16 referralBps,
        uint16 operatingBps,
        uint16 csrBps,
        uint16 burnBps
    );
    event EnishiMasterWalletChanged(
        address indexed previousWallet,
        address indexed newWallet
    );
    event AuthorizedCallerChanged(address indexed caller, bool authorized);
    event DustSwept(address indexed to, uint256 amount);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error NotAuthorized();
    error InvalidSplit(uint256 sumBps);
    error NoReferrer(address user);
    error InsufficientBalance(uint256 requested, uint256 available);

    // ─── Owner functions ──────────────────────────────────────────────────────

    /// @notice Update the four split percentages used by subsequent `distribute` calls.
    function setSplit(
        uint16 referralBps_,
        uint16 operatingBps_,
        uint16 csrBps_,
        uint16 burnBps_
    ) external;

    /// @notice Update the Enishi Master Wallet (recipient of operating + CSR fees).
    function setEnishiMasterWallet(address newWallet) external;

    /// @notice Authorize or revoke a caller for `distribute`.
    function setAuthorizedCaller(address caller, bool authorized) external;

    // ─── External ─────────────────────────────────────────────────────────────

    /// @notice Distribute `amount` ENC among referrer, master wallet, and burn per the current split.
    function distribute(address user, uint256 amount) external;

    // ─── Views ────────────────────────────────────────────────────────────────

    function referralBps() external view returns (uint16);
    function operatingBps() external view returns (uint16);
    function csrBps() external view returns (uint16);
    function burnBps() external view returns (uint16);
    function enishiMasterWallet() external view returns (address);
    function isAuthorizedCaller(address caller) external view returns (bool);
    function isBurnFinished() external view returns (bool);
    function remainingBurnCap() external view returns (uint256);
}
