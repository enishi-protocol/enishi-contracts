// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  EnishiAddressesTestnet
 */
library EnishiAddresses {
    // ─── PancakeSwap routers / WBNB ───────────────────────────────────────────
    // https://developer.pancakeswap.finance/contracts/v3/addresses

    address internal constant PANCAKE_V2 =
        0xD99D1c33F9fC3444f8101754aBC46c52416550D1;

    address internal constant PANCAKE_V2_FACTORY =
        0x6725F303b657a9451d8BA641348b6761A6CC7a17;

    address internal constant PANCAKE_V3 =
        0x1b81D678ffb9C0263b24A97847620C99d213eB14;

    address internal constant PANCAKE_V3_QUOTER =
        0x13f4EA83D0bd40E75C8222255bc855a974568Dd4;

    /// @notice PancakeSwap Universal Router (classic V2+V3 variant, NOT Infinity).
    /// @custom:see https://developer.pancakeswap.finance/contracts/universal-router/addresses
    address internal constant PANCAKE_UNIVERSAL_ROUTER_V2_V3 =
        0x9A082015c919AD0E47861e5Db9A1c7070E81A2C7;

    /// @notice Permit2 the Universal Router pulls input tokens through
    ///         (PancakeSwap self-deployed; same address on mainnet and testnet).
    address internal constant PANCAKE_PERMIT2 =
        0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768;

    // ─── Stablecoin (deposit / payout token) ──────────────────────────────────

    address internal constant BSC_USDT =
        0xaa9D29f539628cc656E72F5347D3E53F24259894;

    function isSupportedStablecoin(address token) internal pure returns (bool) {
        return token == BSC_USDT;
    }

    // ─── Available tokens per strategy ────────────────────────────────────────

    address internal constant BTC =
        0x85b334CefEEDDa23a5754157CEA0ABBed8f04dE6;
    address internal constant ETH =
        0x850e9C04aA6B28490aEE74Bf92f2F82dDD59529d;
    address internal constant WBNB =
        0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd;
    address internal constant XRP =
        0x768f6ea6917D657694dc21867178A543f4acc208;
    address internal constant AVAX =
        0x117650197765eb94f60309Aa837c6793B99A81C0;
    address internal constant LINK =
        0x2B25Eb8E4c34B282aAD704742c57446d6736B244;
    address internal constant SOL =
        0x15d9F0E1356D804339B85d7289433905531BC509;

    // ─── Receipt tokens per strategy (enBTC, enETH, …) ────────────────────────

    address internal constant EN_BTC  = 0xE5510329Ff467A8a642e472173fE6454F05610F5;
    address internal constant EN_ETH  = 0xf589D1DCB8E1A2Dae18D4393eeA2d151605d1543;
    address internal constant EN_BNB  = 0xf8B279737CDAE37713B6c727c728f1306a358d43;
    address internal constant EN_XRP  = 0x30DC46c824F4a877aF5a4cB4CAad926bB71dB422;
    address internal constant EN_AVAX = 0x32de4F7C712195312C6EC34BF86B2D4B04DeC58E;
    address internal constant EN_LINK = 0x54bED3cD9D859618a6D74155137ce927cbFc4878;
    address internal constant EN_SOL  = 0xcd2d0b5523f099683dd4fF36EA6AD86CA0C02553;

    /**
     * @param i Slot index in [0, STRATEGY_COUNT).
     * @return available Available token address.
     * @return receipt   Receipt token address.
     */
    function strategyAt(
        uint8 i
    ) internal pure returns (address available, address receipt) {
        if (i == 0) return (BTC, EN_BTC);
        if (i == 1) return (ETH, EN_ETH);
        if (i == 2) return (XRP, EN_XRP);
        if (i == 3) return (WBNB, EN_BNB);
        if (i == 4) return (SOL, EN_SOL);
        if (i == 5) return (AVAX, EN_AVAX);
        if (i == 6) return (LINK, EN_LINK);

        revert("EnishiAddressesTestnet: slot OOB");
    }
}
