/**
 * Reference model for {ENCVesting}, written from the spec (phase table, caps,
 * PUBLIC schedule) rather than transliterated from the Solidity, so a differential
 * test can actually disagree with the contract.
 */

import { ENC_MAX_SUPPLY } from "../../helpers/encConstants";

export const E = 10n ** 18n;

/** ENC's fixed total supply — re-exported so tests have one import to reach for. */
export { ENC_MAX_SUPPLY };
export const BPS = 10_000n;

export const SEED = 0, PRIVATE = 1, TEAM = 2, TREASURY = 3, PUBLIC = 4;

export const CAP = [
  12_000_000n * E,      // SEED
  28_000_000n * E,      // PRIVATE
  450_000_000n * E,     // TEAM
  1_520_000_000n * E,   // TREASURY
];

/** Burn split per phase; phase N means groups 0..N−1 are full. */
export const RATES = [
  [4000n, 4000n, 1000n, 1000n],
  [0n, 6000n, 2000n, 2000n],
  [0n, 0n, 5000n, 5000n],
  [0n, 0n, 0n, 10000n],
];

export const PUBLIC_TOTAL_ALLOC = 990_000_000n * E;
/** 20,000,000 ENC sold separately by the standalone EnishiPublicSale contract. */
export const PUBLIC_SALE_ALLOC = 20_000_000n * E;
/** What ENCVesting actually vests for the Public round: 990M − 20M Public Sale carve-out. */
export const PUBLIC_ALLOC = PUBLIC_TOTAL_ALLOC - PUBLIC_SALE_ALLOC;
export const PUBLIC_TGE_BPS = 2000n;
/** TGE tranche: 20% of the full 990M less the 20M carve-out → 178,000,000 ENC. */
export const PUBLIC_TGE =
  (PUBLIC_TOTAL_ALLOC * PUBLIC_TGE_BPS) / BPS - PUBLIC_SALE_ALLOC;
export const CLIFF = 365n * 86_400n;
export const INTERVAL = 30n * 86_400n;
export const RELEASE_COUNT = 60n;

export const TEAM_ALLOC = CAP[TEAM];
export const TREASURY_ALLOC = CAP[TREASURY];
export const LOCKED = CAP[SEED] + CAP[PRIVATE] + TEAM_ALLOC + TREASURY_ALLOC + PUBLIC_ALLOC;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
export const mulDiv = (a: bigint, b: bigint, c: bigint) => (a * b) / c;

/** Cumulative unlock per burn group at `burned`. */
export function unlocked(burned: bigint): bigint[] {
  const out = [0n, 0n, 0n, 0n];
  let left = burned;
  for (let phase = 0; phase < 4 && left > 0n; phase++) {
    const rates = RATES[phase];
    const limitRate = rates[phase];
    const missing = CAP[phase] > out[phase] ? CAP[phase] - out[phase] : 0n;
    const need = missing === 0n ? 0n : ceilDiv(missing * BPS, limitRate);
    const used = left < need ? left : need;
    for (let g = phase; g < 4; g++) if (rates[g] !== 0n) out[g] += (used * rates[g]) / BPS;
    if (need !== 0n && used === need) out[phase] = CAP[phase];
    left -= used;
  }
  for (let g = 0; g < 4; g++) if (out[g] > CAP[g]) out[g] = CAP[g];
  return out;
}

/**
 * Burn level at which each phase ends, i.e. at which group `p` reaches its cap.
 * BOUNDARY[3] is the burn that fully unlocks every group.
 */
export const BOUNDARY: bigint[] = (() => {
  const out = [0n, 0n, 0n, 0n];
  const acc = [0n, 0n, 0n, 0n];
  let burn = 0n;
  for (let phase = 0; phase < 4; phase++) {
    const rates = RATES[phase];
    const need = ceilDiv((CAP[phase] - acc[phase]) * BPS, rates[phase]);
    burn += need;
    for (let g = phase; g < 4; g++) if (rates[g] !== 0n) acc[g] += (need * rates[g]) / BPS;
    acc[phase] = CAP[phase];
    out[phase] = burn;
  }
  return out;
})();

export const FULL_UNLOCK_BURN = BOUNDARY[3];

// ─── PUBLIC time schedule ───────────────────────────────────────────────────

export function publicReleases(elapsed: bigint): bigint {
  if (elapsed < CLIFF) return 0n;
  const r = (elapsed - CLIFF) / INTERVAL + 1n;
  return r > RELEASE_COUNT ? RELEASE_COUNT : r;
}

export function publicEntitlement(alloc: bigint, elapsed: bigint): bigint {
  // TGE is 178M/970M of the vested round, not a round bps figure.
  const tge = mulDiv(alloc, PUBLIC_TGE, PUBLIC_ALLOC);
  const r = publicReleases(elapsed);
  if (r === 0n) return tge;
  if (r >= RELEASE_COUNT) return alloc;
  return tge + mulDiv(alloc - tge, r, RELEASE_COUNT);
}

export function publicBps(elapsed: bigint): bigint {
  return publicEntitlement(BPS, elapsed);
}

// ─── Pooled-round split ─────────────────────────────────────────────────────

export type Member = { alloc: bigint; credited: bigint };

/** Mirror of `_allocatePool`: pro-rata by allocation, capped at each member's room. */
export function splitPool(pool: bigint, members: Member[]): { shares: bigint[]; leftover: bigint } {
  const shares = members.map(() => 0n);
  if (pool === 0n) return { shares, leftover: 0n };

  let activeWeight = 0n;
  for (const m of members) if (m.alloc > m.credited) activeWeight += m.alloc;
  if (activeWeight === 0n) return { shares, leftover: pool };

  let allocated = 0n;
  members.forEach((m, i) => {
    if (m.alloc <= m.credited) return;
    const room = m.alloc - m.credited;
    let share = mulDiv(pool, m.alloc, activeWeight);
    if (share > room) share = room;
    shares[i] = share;
    allocated += share;
  });
  return { shares, leftover: pool - allocated };
}
