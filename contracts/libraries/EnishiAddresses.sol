// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  EnishiAddresses
 */
library EnishiAddresses {
    // ─── PancakeSwap routers / WBNB ───────────────────────────────────────────
    // https://developer.pancakeswap.finance/contracts/v3/addresses

    address internal constant PANCAKE_V2 =
        0x10ED43C718714eb63d5aA57B78B54704E256024E;

    address internal constant PANCAKE_V2_FACTORY =
        0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;

    address internal constant PANCAKE_V3 =
        0x1b81D678ffb9C0263b24A97847620C99d213eB14;

    address internal constant PANCAKE_V3_QUOTER =
        0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997;

    /// @notice PancakeSwap Universal Router (classic V2+V3 variant, NOT Infinity).
    /// @custom:see https://developer.pancakeswap.finance/contracts/universal-router/addresses
    address internal constant PANCAKE_UNIVERSAL_ROUTER_V2_V3 =
        0x1A0A18AC4BECDDbd6389559687d1A73d8927E416;

    /// @notice Permit2 the Universal Router pulls input tokens through
    ///         (PancakeSwap self-deployed; same address on mainnet and testnet).
    address internal constant PANCAKE_PERMIT2 =
        0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768;

    // ─── Stablecoin (deposit / payout token) ──────────────────────────────────

    address internal constant BSC_USDT =
        0x55d398326f99059fF775485246999027B3197955;

    function isSupportedStablecoin(address token) internal pure returns (bool) {
        return token == BSC_USDT;
    }

    // ─── Available tokens per strategy ────────────────────────────────────────

    address internal constant BTC = 0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c;
    address internal constant ETH = 0x2170Ed0880ac9A755fd29B2688956BD959F933F8;
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address internal constant XRP = 0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE;
    address internal constant AVAX = 0x1CE0c2827e2eF14D5C4f29a091d735A204794041;
    address internal constant LINK = 0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD;
    address internal constant SOL = 0x570A5D26f7765Ecb712C0924E4De545B89fD43dF;

    // ─── Receipt tokens per strategy (enBTC, enETH, …) ────────────────────────

    address internal constant EN_BTC =
        0x8281c6790E8A4BAB0Ded95164A4c83e423C74b05;
    address internal constant EN_ETH =
        0x4019D71805A3a96d0E6d7f4Eb39B04c7d8e5D1e0;
    address internal constant EN_XRP =
        0x5BE9F238afC31b4e5ff424882c0423C0e1FED37b;
    address internal constant EN_BNB =
        0xcdb075800dD10f000517e5d2cb70F3b8360F4055;
    address internal constant EN_SOL =
        0x1BE0FD7f378177303dd4f591AB73b26a82346088;
    address internal constant EN_AVAX =
        0x788309b5cea31AbC5bAf747742af6cf9Dcd4beED;
    address internal constant EN_LINK =
        0xB417Bd7BC4BE3176483bAd9c0705576F3a5Cb83c;

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

        revert("EnishiAddresses: slot OOB");
    }
}
