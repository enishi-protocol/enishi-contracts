/**
 * ENC tokenomics, for TypeScript (deploy scripts, tests, tooling).
 */

const E = 10n ** 18n;

/** ENC's fixed total supply. Mirrors `EnishiConstants.ENC_MAX_SUPPLY`. */
export const ENC_MAX_SUPPLY = 3_000_000_000n * E;

/** Per-round allocations. Must add up to {ENC_MAX_SUPPLY}. */
export const ROUND_ALLOCATION = {
  SEED: 12_000_000n * E,
  PRIVATE: 28_000_000n * E,
  TEAM: 450_000_000n * E,
  TREASURY: 1_520_000_000n * E,
  PUBLIC: 990_000_000n * E,
} as const;

/** PUBLIC's 20% TGE tranche — unlocked from block one, pulled with `claim(4)`. */
export const PUBLIC_TGE_AMOUNT = (ROUND_ALLOCATION.PUBLIC * 2000n) / 10_000n;
