// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "../interfaces/IENCStakeRouter.sol";
import "../libraries/EnishiConstants.sol";

/**
 * @title  ENCStakeRouter
 * @notice Owns the discounted ENC commission policy. A user's commission is
 *         charged in ENC from the first stake that covers it — Public Sale
 *         lots inside their window at {PUBLIC_SALE_COMMISSION_BPS}, then
 *         {ENC_LOCK} at its plan's rate — and never from both. When neither
 *         covers it, the Vault charges the default rate in stablecoin.
 *
 *         The Vault quotes ENC once, for {commissionQuote}: profit at the
 *         highest rate in play. {chargeCommission} scales that quote down for
 *         a lower rate, so changing the policy only needs a new router
 *         (`Vault.setStakeRouter`), never a new Vault.
 *
 *         {ENC_LOCK} trusts this contract as its `vault`. Public Sale reads go
 *         through try/catch, and a sale not bound to this router (see
 *         {_boundToSale}) reads as no stake, so a failing or miswired sale
 *         degrades to the ENC lock instead of blocking settlement and exits.
 *
 *         Trust: the owner can set any address as the Vault, which may then
 *         pull any active buyer's unclaimed lot ENC to {ENC_COMMISSION}.
 *         Hold ownership in a multisig or timelock.
 */
contract ENCStakeRouter is Ownable, ReentrancyGuardTransient, IENCStakeRouter {
    // ─── Constants ────────────────────────────────────────────────────────────

    /// @notice Commission rate while a Public Sale lot is inside its window.
    uint16 public constant PUBLIC_SALE_COMMISSION_BPS =
        EnishiConstants.PUBLIC_SALE_COMMISSION_BPS;

    /// @notice Rate charged in stablecoin when no stake covers the commission.
    uint16 public constant DEFAULT_COMMISSION_BPS =
        EnishiConstants.ENC_COMMISSION_DEFAULT_BPS;

    uint16 private constant BPS_DENOMINATOR = EnishiConstants.BPS_DENOMINATOR;

    // ─── Types ────────────────────────────────────────────────────────────────

    /// @dev A stake's discounted rate is 0 when it cannot pay: no discount
    ///      or an empty balance.
    struct Stakes {
        uint16 saleBps;
        uint256 saleBalance;
        uint16 lockBps;
        uint256 lockBalance;
    }

    // ─── State ────────────────────────────────────────────────────────────────

    IENCLock public immutable ENC_LOCK;

    IEnishiPublicSale public immutable PUBLIC_SALE;

    address public immutable ENC_COMMISSION;

    address public vault;

    // ─── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param encLock_       ENC lock, tried after the Public Sale.
     * @param publicSale_    Public Sale; must have code, since a call to an
     *                       empty account fails outside the try/catch.
     * @param encCommission_ ENC Commission contract, where charged ENC goes.
     */
    constructor(
        address encLock_,
        address publicSale_,
        address encCommission_
    ) Ownable(_msgSender()) {
        if (
            encLock_ == address(0) ||
            publicSale_ == address(0) ||
            encCommission_ == address(0)
        ) revert ZeroAddress();
        if (publicSale_.code.length == 0) revert NotContract(publicSale_);

        ENC_LOCK = IENCLock(encLock_);
        PUBLIC_SALE = IEnishiPublicSale(publicSale_);
        ENC_COMMISSION = encCommission_;
    }

    // ─── Modifiers ────────────────────────────────────────────────────────────

    /// @dev Restricts to the Vault for {chargeCommission}.
    modifier onlyVault() {
        if (_msgSender() != vault) revert NotVault(_msgSender());
        _;
    }

    // ─── External ─────────────────────────────────────────────────────────────

    /// @inheritdoc IENCStakeRouter
    function chargeCommission(
        address user,
        uint256 netProfit,
        uint256 quotedStable,
        uint256 quotedEnc
    ) external onlyVault nonReentrant returns (uint256 encCharged) {
        Stakes memory st = _stakes(user);
        if (
            quotedStable == 0 ||
            quotedEnc == 0 ||
            quotedStable != _quotedStable(st, netProfit)
        ) return 0;

        if (st.saleBps != 0) {
            encCharged = _owed(st.saleBps, netProfit, quotedStable, quotedEnc);
            if (encCharged != 0 && st.saleBalance >= encCharged) {
                PUBLIC_SALE.collectCommission(user, encCharged);
                emit CommissionRouted(user, true, encCharged);
                return encCharged;
            }
        }
        if (st.lockBps != 0) {
            encCharged = _owed(st.lockBps, netProfit, quotedStable, quotedEnc);
            if (encCharged != 0 && st.lockBalance >= encCharged) {
                ENC_LOCK.collectCommission(user, encCharged, ENC_COMMISSION);
                emit CommissionRouted(user, false, encCharged);
                return encCharged;
            }
        }
        return 0;
    }

    /// @inheritdoc IENCStakeRouter
    function setVault(address newVault) external onlyOwner {
        if (newVault == address(0)) revert ZeroAddress();
        address old = vault;
        vault = newVault;
        emit VaultUpdated(old, newVault);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @inheritdoc IENCStakeRouter
    function commissionQuote(
        address user,
        uint256 netProfit
    ) external view returns (uint256 quotedStable) {
        return _quotedStable(_stakes(user), netProfit);
    }

    /// @inheritdoc IENCStakeRouter
    function publicSaleStake(
        address user
    ) external view returns (uint16 bps, uint256 balance) {
        (bool active, uint256 unclaimed) = _publicSaleStatus(user);
        if (!active) return (DEFAULT_COMMISSION_BPS, 0);
        return (PUBLIC_SALE_COMMISSION_BPS, unclaimed);
    }

    /// @inheritdoc IENCStakeRouter
    function lockStake(
        address user
    ) external view returns (uint16 bps, uint256 balance) {
        bps = ENC_LOCK.getCommissionBps(user);
        if (bps == DEFAULT_COMMISSION_BPS) return (bps, 0);
        (balance, , ) = ENC_LOCK.lockOf(user);
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @dev `user`'s stakes that could pay a discounted commission.
    function _stakes(address user) internal view returns (Stakes memory st) {
        (bool active, uint256 unclaimed) = _publicSaleStatus(user);
        if (active && unclaimed != 0) {
            st.saleBps = PUBLIC_SALE_COMMISSION_BPS;
            st.saleBalance = unclaimed;
        }
        uint16 lockBps = ENC_LOCK.getCommissionBps(user);
        if (lockBps != DEFAULT_COMMISSION_BPS) {
            (uint256 locked, , ) = ENC_LOCK.lockOf(user);
            if (locked != 0) {
                st.lockBps = lockBps;
                st.lockBalance = locked;
            }
        }
    }

    /// @dev `netProfit` at the highest rate in play; 0 when none.
    function _quotedStable(
        Stakes memory st,
        uint256 netProfit
    ) internal pure returns (uint256) {
        uint256 bps = st.saleBps > st.lockBps ? st.saleBps : st.lockBps;
        return (netProfit * bps) / BPS_DENOMINATOR;
    }

    /// @dev ENC owed at `bps`: the quote scaled by this rate's stablecoin
    ///      commission over the quoted amount. Exact for the quoted rate.
    function _owed(
        uint16 bps,
        uint256 netProfit,
        uint256 quotedStable,
        uint256 quotedEnc
    ) internal pure returns (uint256) {
        uint256 stable = (netProfit * bps) / BPS_DENOMINATOR;
        return (quotedEnc * stable) / quotedStable;
    }

    /// @dev Public Sale status of `user`; inactive if the sale call fails or
    ///      the sale is not bound to this router.
    function _publicSaleStatus(
        address user
    ) internal view returns (bool active, uint256 balance) {
        if (!_boundToSale()) return (false, 0);
        try PUBLIC_SALE.commissionStatus(user) returns (bool a, uint256 b) {
            return (a, b);
        } catch {
            return (false, 0);
        }
    }

    /**
     * @dev Whether the sale accepts this router's pulls and pays the same
     *      recipient the Vault distributes from. Otherwise a pull would revert
     *      NotStakeRouter (blocking settlement and exits) or send the ENC
     *      where {ENC_COMMISSION} never sees it.
     */
    function _boundToSale() internal view returns (bool) {
        try PUBLIC_SALE.stakeRouter() returns (address router) {
            if (router != address(this)) return false;
        } catch {
            return false;
        }
        try PUBLIC_SALE.commissionRecipient() returns (address recipient) {
            return recipient == ENC_COMMISSION;
        } catch {
            return false;
        }
    }
}
