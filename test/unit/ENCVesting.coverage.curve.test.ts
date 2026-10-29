import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  BOUNDARY, CAP, E, FULL_UNLOCK_BURN, RATES, SEED, PRIVATE, TEAM, TREASURY, unlocked,
} from "../helpers/vestingModel";
import { fullRangeRig } from "../helpers/vestingRig";

/**
 * Burn-curve coverage.
 *
 * The whole burn range [0, FULL_UNLOCK_BURN] is cut into contiguous segments — the
 * first test proves the cut leaves no hole — and the contract is checked at every
 * cut point against the reference model, plus at ±1 wei around every phase boundary.
 */

const GROUPS = [SEED, PRIVATE, TEAM, TREASURY];
const NAME = ["SEED", "PRIVATE", "TEAM", "TREASURY"];
const SUBDIVISIONS = 60; // per phase

/** Every burn level the suite visits, ascending, starting at 0 and ending at full unlock. */
const POINTS: bigint[] = (() => {
  const pts = new Set<bigint>([0n]);
  let lo = 0n;
  for (let phase = 0; phase < 4; phase++) {
    const hi = BOUNDARY[phase];
    const span = hi - lo;
    for (let k = 1; k <= SUBDIVISIONS; k++) pts.add(lo + (span * BigInt(k)) / BigInt(SUBDIVISIONS));
    // pin the boundary itself and its immediate neighbourhood
    for (const d of [-2n, -1n, 0n, 1n, 2n]) {
      const v = hi + d;
      if (v > 0n && v <= FULL_UNLOCK_BURN) pts.add(v);
    }
    lo = hi;
  }
  pts.add(FULL_UNLOCK_BURN);
  return [...pts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
})();

/** Which phase a burn level sits in (0..3); a boundary belongs to the phase it closes. */
const phaseOf = (b: bigint) => {
  for (let p = 0; p < 4; p++) if (b <= BOUNDARY[p]) return p;
  return 3;
};

describe("Burn curve — full-range coverage", () => {
  describe("the sweep leaves no burn interval untested", () => {
    it("starts at 0, ends at full unlock, and every consecutive pair is contiguous", () => {
      expect(POINTS[0]).to.equal(0n);
      expect(POINTS[POINTS.length - 1]).to.equal(FULL_UNLOCK_BURN);
      for (let i = 1; i < POINTS.length; i++) {
        expect(POINTS[i] > POINTS[i - 1], `points must strictly ascend at index ${i}`).to.equal(true);
      }
      // contiguity: the segments [p_i, p_i+1] tile [0, FULL_UNLOCK_BURN] with no hole
      let covered = 0n;
      for (let i = 1; i < POINTS.length; i++) covered += POINTS[i] - POINTS[i - 1];
      expect(covered).to.equal(FULL_UNLOCK_BURN);
    });

    it("subdivides all four phases, and each phase boundary is visited exactly", () => {
      for (let phase = 0; phase < 4; phase++) {
        const lo = phase === 0 ? 0n : BOUNDARY[phase - 1];
        const inside = POINTS.filter((p) => p > lo && p <= BOUNDARY[phase]);
        expect(inside.length, `phase ${phase} needs sub-points`).to.be.greaterThanOrEqual(SUBDIVISIONS);
        expect(POINTS).to.include(BOUNDARY[phase]);
      }
    });

    it("the model's boundaries are the documented ones", () => {
      // SEED takes 40% of every burn, so its 12,000,000 cap closes phase 1 at 30,000,000.
      expect(BOUNDARY[0]).to.equal(30_000_000n * E);
      // PRIVATE then takes 60% and needs 16,000,000 more: 26,666,666.666… ENC of burn.
      expect(BOUNDARY[1]).to.equal(30_000_000n * E + (16_000_000n * E * 10_000n + 5999n) / 6000n);
      expect(BOUNDARY[2] > BOUNDARY[1]).to.equal(true);
      expect(BOUNDARY[3]).to.equal(FULL_UNLOCK_BURN);
      expect(unlocked(FULL_UNLOCK_BURN)).to.deep.equal(CAP);
    });
  });

  describe("the contract matches the model at every point of the sweep", () => {
    let snapshot: Awaited<ReturnType<typeof sweep>>;

    /** One ascending pass: burn up to each point and record every view. */
    async function sweep() {
      const { enc, v, burner } = await loadFixture(fullRangeRig);
      const rows: { burn: bigint; got: bigint[]; sum: bigint }[] = [];
      let done = 0n;
      for (const p of POINTS) {
        if (p > done) {
          await enc.connect(burner).burn(p - done);
          done = p;
        }
        const got: bigint[] = [];
        for (const g of GROUPS) got.push(await v.groupUnlocked(g));
        rows.push({ burn: p, got, sum: got.reduce((a, b) => a + b, 0n) });
        expect(await v.cumulativeBurned(), `cumulativeBurned at ${p}`).to.equal(p);
      }
      return rows;
    }

    before(async () => { snapshot = await sweep(); });

    it(`reproduces the model wei-for-wei at all ${POINTS.length} burn levels`, () => {
      for (const row of snapshot) {
        const want = unlocked(row.burn);
        for (const g of GROUPS) {
          expect(row.got[g], `${NAME[g]} at burn=${row.burn}`).to.equal(want[g]);
        }
      }
    });

    it("1 burn = 1 unlock: Σ unlocked equals the burn exactly until everything is capped", () => {
      for (const row of snapshot) {
        const allFull = GROUPS.every((g) => row.got[g] === CAP[g]);
        if (allFull) {
          expect(row.sum).to.equal(CAP.reduce((a, b) => a + b, 0n));
        } else {
          // floor division can shave at most 1 wei per active group
          expect(row.burn - row.sum).to.be.lessThanOrEqual(4n);
          expect(row.sum).to.be.lessThanOrEqual(row.burn);
        }
      }
    });

    it("never exceeds a cap and never goes backwards", () => {
      let prev = [0n, 0n, 0n, 0n];
      for (const row of snapshot) {
        for (const g of GROUPS) {
          expect(row.got[g], `${NAME[g]} over cap at ${row.burn}`).to.be.lessThanOrEqual(CAP[g]);
          expect(row.got[g] >= prev[g], `${NAME[g]} went backwards at ${row.burn}`).to.equal(true);
        }
        prev = row.got;
      }
    });

    it("the marginal rate of every segment matches the published split for its phase", () => {
      for (let i = 1; i < snapshot.length; i++) {
        const a = snapshot[i - 1], b = snapshot[i];
        const pa = phaseOf(a.burn), pb = phaseOf(b.burn);
        if (pa !== pb) continue; // a segment straddling a boundary mixes two rates
        const dBurn = b.burn - a.burn;
        if (dBurn === 0n) continue;
        for (const g of GROUPS) {
          const dGot = b.got[g] - a.got[g];
          const want = (dBurn * RATES[pa][g]) / 10_000n;
          const label = `${NAME[g]} marginal rate on (${a.burn}, ${b.burn}]`;
          // never more than the published rate (allowing 2 wei of floor drift)
          expect(dGot, label).to.be.lessThanOrEqual(want + 2n);
          // and never less, except for the limiting group on the segment that ends
          // at its own cap, where the curve is snapped to the cap exactly
          const snapsToCap = g === pa && b.got[g] === CAP[g];
          if (!snapsToCap) expect(dGot + 2n, label).to.be.greaterThanOrEqual(want);
        }
      }
    });

    it("groups fill strictly in order — none is full before the ones ahead of it", () => {
      for (const row of snapshot) {
        for (let g = 1; g < 4; g++) {
          if (row.got[g] === CAP[g]) {
            expect(row.got[g - 1], `${NAME[g]} full before ${NAME[g - 1]} at burn=${row.burn}`)
              .to.equal(CAP[g - 1]);
          }
        }
        // and each group's share of the burn is bounded by its best possible rate
        for (const g of GROUPS) {
          expect(row.got[g], `${NAME[g]} exceeds the burn at ${row.burn}`).to.be.lessThanOrEqual(row.burn);
        }
      }
    });
  });

  describe("phase boundaries land exactly on the cap", () => {
    it("each limiting group hits its cap AT the boundary and is short 1 wei before it", async () => {
      const { enc, v, burner } = await loadFixture(fullRangeRig);
      let done = 0n;
      for (let phase = 0; phase < 4; phase++) {
        const at = BOUNDARY[phase];
        await enc.connect(burner).burn(at - 1n - done);
        done = at - 1n;
        expect(await v.groupUnlocked(phase), `${NAME[phase]} must not be full 1 wei early`)
          .to.be.lessThan(CAP[phase]);

        await enc.connect(burner).burn(1n);
        done = at;
        expect(await v.groupUnlocked(phase), `${NAME[phase]} must be exactly full at its boundary`)
          .to.equal(CAP[phase]);
      }
    });

    it("burning past full unlock changes nothing", async () => {
      const { enc, v, burner } = await loadFixture(fullRangeRig);
      await enc.connect(burner).burn(FULL_UNLOCK_BURN);
      const before = await Promise.all(GROUPS.map((g) => v.groupUnlocked(g)));
      await enc.connect(burner).burn(1_000_000n * E);
      for (const g of GROUPS) {
        expect(await v.groupUnlocked(g)).to.equal(before[g]).and.to.equal(CAP[g]);
      }
    });

    it("chunking a burn never changes the outcome, at any granularity", async () => {
      const target = BOUNDARY[1] + 12_345_678_901_234_567_890n;
      const chunkings = [[target], [target / 2n, target - target / 2n],
                         Array.from({ length: 25 }, (_, i) =>
                           i === 24 ? target - (target / 25n) * 24n : target / 25n)];
      const results: string[] = [];
      for (const chunks of chunkings) {
        const { enc, v, burner } = await loadFixture(fullRangeRig);
        for (const c of chunks) await enc.connect(burner).burn(c);
        expect(await v.cumulativeBurned()).to.equal(target);
        results.push((await Promise.all(GROUPS.map((g) => v.groupUnlocked(g)))).join(","));
      }
      expect(new Set(results).size, "chunking changed the unlock").to.equal(1);
      expect(results[0]).to.equal(unlocked(target).join(","));
    });
  });

  describe("groupCap", () => {
    it("returns each group's documented cap and 0 for anything else", async () => {
      const { v } = await loadFixture(fullRangeRig);
      for (const g of GROUPS) expect(await v.groupCap(g)).to.equal(CAP[g]);
      expect(await v.groupCap(4)).to.equal(0n);   // PUBLIC is not a burn group
      expect(await v.groupCap(255)).to.equal(0n);
    });

    it("is constant — no burn, and no press, can move it", async () => {
      const { enc, v, burner } = await loadFixture(fullRangeRig);
      await enc.connect(burner).burn(BOUNDARY[2]);
      for (const g of GROUPS) expect(await v.groupCap(g)).to.equal(CAP[g]);
    });
  });

  describe("groupUnlocked input validation", () => {
    it("reverts UnknownRound for PUBLIC and for out-of-range ids", async () => {
      const { v } = await loadFixture(fullRangeRig);
      await expect(v.groupUnlocked(4)).to.be.revertedWithCustomError(v, "UnknownRound").withArgs(4);
      await expect(v.groupUnlocked(200)).to.be.revertedWithCustomError(v, "UnknownRound").withArgs(200);
    });
  });
});
