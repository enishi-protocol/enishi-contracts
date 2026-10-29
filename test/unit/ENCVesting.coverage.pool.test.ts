import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { BOUNDARY, CAP, E, PRIVATE, SEED, splitPool, unlocked, type Member } from "../helpers/vestingModel";
import { productionRig } from "../helpers/vestingRig";

/**
 * Pooled rounds (SEED / PRIVATE) — the operator-pressed side of the contract.
 * Every press is checked against the reference split, and `previewDistribution`
 * is required to predict the transfers wei-for-wei before each press.
 */

const POOLED = [
  { id: SEED, name: "SEED" },
  { id: PRIVATE, name: "PRIVATE" },
];

/** Deterministic RNG so a failure reproduces exactly. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const addr = () => ethers.Wallet.createRandom().address;

/** Press once and assert the preview predicted it exactly. Returns what was paid. */
async function pressAndVerify(enc: any, v: any, operator: any, round: number, members: string[]) {
  const pendingBefore = await v.pendingPool(round);
  const [pvWho, pvAmt, pvLeft] = await v.previewDistribution(round);
  const before = await Promise.all(members.map((m) => enc.balanceOf(m)));
  const vaultBefore = await enc.balanceOf(await v.getAddress());
  const outstandingBefore = await v.totalOutstanding();

  await v.connect(operator).distribute(round);

  let paid = 0n;
  for (let i = 0; i < members.length; i++) {
    const delta = (await enc.balanceOf(members[i])) - before[i];
    expect(pvWho[i], `preview member order at ${i}`).to.equal(members[i]);
    expect(delta, `preview vs transfer for member ${i}`).to.equal(pvAmt[i]);
    paid += delta;
  }
  const leftAfter = await v.pendingPool(round);
  expect(leftAfter, "preview leftover").to.equal(pvLeft);
  expect(vaultBefore - (await enc.balanceOf(await v.getAddress())), "vault balance drop").to.equal(paid);
  expect(outstandingBefore - (await v.totalOutstanding()), "totalOutstanding drop").to.equal(paid);
  expect(paid + leftAfter, "pool conservation").to.equal(pendingBefore);
  return paid;
}

describe("Pooled rounds — distribution coverage", () => {
  describe("pendingPool", () => {
    it("is zero before any burn, and both its terms are exercised", async () => {
      const { enc, v, burner, operator, u1, deployer } = await loadFixture(productionRig);
      expect(await v.pendingPool(SEED)).to.equal(0n);

      // term 2 only: burn happened, nothing accrued into storage yet
      await enc.connect(burner).burn(1_000n * E);
      expect(await v.pendingPool(SEED)).to.equal(400n * E);

      // press with a member that cannot absorb it all → term 1 (poolBalance) takes over
      await v.addBeneficiaries(SEED, [u1.address], [100n * E], [deployer.address], true);
      await v.connect(operator).distribute(SEED);
      expect(await enc.balanceOf(u1.address)).to.equal(100n * E);
      expect(await v.pendingPool(SEED)).to.equal(300n * E);

      // both terms together: new burn on top of the retained pool
      await enc.connect(burner).burn(1_000n * E);
      expect(await v.pendingPool(SEED)).to.equal(700n * E);
    });

    it("tracks the group's unlock exactly while nobody is registered", async () => {
      const { enc, v, burner } = await loadFixture(productionRig);
      for (const b of [1n, 7n, 1_000n * E, 5_000_000n * E, 24_999_999n * E]) {
        await enc.connect(burner).burn(b);
        const burned = await v.cumulativeBurned();
        expect(await v.pendingPool(SEED)).to.equal(unlocked(burned)[SEED]);
        expect(await v.pendingPool(PRIVATE)).to.equal(unlocked(burned)[PRIVATE]);
      }
    });

    it("reverts UnknownRound outside SEED/PRIVATE", async () => {
      const { v } = await loadFixture(productionRig);
      for (const r of [2, 3, 4, 9]) {
        await expect(v.pendingPool(r)).to.be.revertedWithCustomError(v, "UnknownRound").withArgs(r);
      }
    });
  });

  describe("the press pays pro-rata by allocation", () => {
    for (const round of POOLED) {
      it(`${round.name}: equal allocations split equally, uneven ones split by weight`, async () => {
        const { enc, v, burner, operator, u1, u2, u3, deployer } = await loadFixture(productionRig);
        const cap = CAP[round.id];
        const allocs = [cap / 2n, cap / 3n, cap - cap / 2n - cap / 3n];
        const who = [u1.address, u2.address, u3.address];
        await v.addBeneficiaries(round.id, who, allocs, who.map(() => deployer.address), true);

        await enc.connect(burner).burn(1_000_000n * E);
        const pool = await v.pendingPool(round.id);
        const model = splitPool(pool, allocs.map((a) => ({ alloc: a, credited: 0n }) as Member));

        await pressAndVerify(enc, v, operator, round.id, who);
        for (let i = 0; i < who.length; i++) {
          expect(await enc.balanceOf(who[i]), `member ${i}`).to.equal(model.shares[i]);
        }
        expect(await v.pendingPool(round.id)).to.equal(model.leftover);
      });
    }

    it("the denominator is the members' assigned total, not the round cap", async () => {
      const { enc, v, burner, operator, u1, u2, deployer } = await loadFixture(productionRig);
      // only 3,000,000 of SEED's 12,000,000 cap is sold
      await v.addBeneficiaries(SEED, [u1.address, u2.address], [E * 2_000_000n, E * 1_000_000n], [deployer.address, deployer.address], true);
      await enc.connect(burner).burn(2_500_000n * E); // unlocks 1,000,000 for SEED
      await pressAndVerify(enc, v, operator, SEED, [u1.address, u2.address]);
      // split 2:1 over the assigned 3,000,000 — not diluted by the unsold cap
      expect(await enc.balanceOf(u1.address)).to.equal((1_000_000n * E * 2n) / 3n);
      expect(await enc.balanceOf(u2.address)).to.equal((1_000_000n * E * 1n) / 3n);
    });

    it("a member at their cap stops absorbing and the rest stays pooled for the next press", async () => {
      // leftover needs members that are credited unevenly: u1 is nearly full when u2
      // joins, so u1's pro-rata share (weighted by its FULL allocation) overshoots the
      // room it has left, and the overshoot stays pooled.
      const { enc, v, burner, operator, u1, u2, deployer } = await loadFixture(productionRig);
      await v.addBeneficiaries(SEED, [u1.address], [10_000_000n * E], [deployer.address], true);
      await enc.connect(burner).burn(22_500_000n * E);          // SEED unlocks 9,000,000
      await pressAndVerify(enc, v, operator, SEED, [u1.address]);
      expect(await v.credited(SEED, u1.address)).to.equal(9_000_000n * E);

      await v.addBeneficiaries(SEED, [u2.address], [2_000_000n * E], [deployer.address], true);  // round now fully sold
      await enc.connect(burner).burn(5_000_000n * E);           // 2,000,000 more unlocked
      expect(await v.pendingPool(SEED)).to.equal(2_000_000n * E);

      // weight = 12,000,000 (u1 still counts at its full allocation)
      //   u1 share 1,666,666.66… → capped at its 1,000,000 of room
      //   u2 share   333,333.33…
      await pressAndVerify(enc, v, operator, SEED, [u1.address, u2.address]);
      expect(await enc.balanceOf(u1.address)).to.equal(10_000_000n * E);
      expect(await enc.balanceOf(u2.address)).to.equal(333_333_333_333_333_333_333_333n);
      expect(await v.pendingPool(SEED), "u1's overflow is retained")
        .to.equal(666_666_666_666_666_666_666_667n);

      // "press once more": u1 is out of the weight now, so u2 takes the retained pool
      await pressAndVerify(enc, v, operator, SEED, [u1.address, u2.address]);
      expect(await enc.balanceOf(u2.address)).to.equal(1_000_000n * E);
      expect(await v.pendingPool(SEED)).to.equal(0n);
      expect(await enc.balanceOf(u1.address) + await enc.balanceOf(u2.address))
        .to.equal(await v.groupUnlocked(SEED));
    });

    it("a fully sold round eventually pays every member exactly their allocation", async () => {
      const { enc, v, burner, operator, deployer } = await loadFixture(productionRig);
      const who = [addr(), addr(), addr(), addr()];
      // deliberately lopsided and not divisible
      const allocs = [1n, 7n * E, 5_000_000n * E - 3n, CAP[SEED] - 1n - 7n * E - (5_000_000n * E - 3n)];
      await v.addBeneficiaries(SEED, who, allocs, who.map(() => deployer.address), true);
      await enc.connect(burner).burn(BOUNDARY[0]);
      for (let i = 0; i < 8; i++) {
        try { await v.connect(operator).distribute(SEED); } catch { break; }
      }
      for (let i = 0; i < who.length; i++) {
        expect(await enc.balanceOf(who[i]), `member ${i} short-changed`).to.equal(allocs[i]);
      }
      expect(await v.pendingPool(SEED), "no dust stranded").to.equal(0n);
    });
  });

  describe("onboarding", () => {
    it("a newcomer takes no share of the pool that accrued before they joined", async () => {
      const { enc, v, burner, operator, u1, u2, deployer } = await loadFixture(productionRig);
      await v.addBeneficiaries(SEED, [u1.address], [6_000_000n * E], [deployer.address], true);
      await enc.connect(burner).burn(2_500_000n * E); // 1,000,000 unlocked
      // Onboarding u2 settles that 1,000,000 onto u1 first — joining is not retroactive.
      await v.addBeneficiaries(SEED, [u2.address], [6_000_000n * E], [deployer.address], true);
      expect(await enc.balanceOf(u1.address)).to.equal(1_000_000n * E);
      expect(await enc.balanceOf(u2.address)).to.equal(0n);
      expect(await v.pendingPool(SEED)).to.equal(0n);

      // From here they split every new unlock evenly.
      await enc.connect(burner).burn(2_500_000n * E);
      await pressAndVerify(enc, v, operator, SEED, [u1.address, u2.address]);
      expect(await enc.balanceOf(u1.address)).to.equal(1_500_000n * E);
      expect(await enc.balanceOf(u2.address)).to.equal(500_000n * E);
    });

    it("registering alone moves no ENC and credits nothing", async () => {
      const { enc, v, u1, deployer } = await loadFixture(productionRig);
      const vaultBefore = await enc.balanceOf(await v.getAddress());
      await v.addBeneficiaries(SEED, [u1.address], [1_000n * E], [deployer.address], true);
      expect(await enc.balanceOf(await v.getAddress())).to.equal(vaultBefore);
      expect(await v.credited(SEED, u1.address)).to.equal(0n);
      expect(await v.claimed(SEED, u1.address)).to.equal(0n);
    });

    it("a member joining after the round is fully paid unlocks the stranded pool", async () => {
      const { enc, v, burner, operator, u1, u2, deployer } = await loadFixture(productionRig);
      await v.addBeneficiaries(SEED, [u1.address], [100n * E], [deployer.address], true);
      await enc.connect(burner).burn(1_000n * E);
      await v.connect(operator).distribute(SEED);
      expect(await v.pendingPool(SEED)).to.equal(300n * E);
      await expect(v.connect(operator).distribute(SEED))
        .to.be.revertedWithCustomError(v, "NothingToDistribute").withArgs(SEED);

      await v.addBeneficiaries(SEED, [u2.address], [1_000n * E], [deployer.address], true);
      await pressAndVerify(enc, v, operator, SEED, [u1.address, u2.address]);
      expect(await enc.balanceOf(u2.address)).to.equal(300n * E);
      expect(await v.pendingPool(SEED)).to.equal(0n);
    });
  });

  describe("events", () => {
    it("emits PoolAccrued, PoolAllocated, Distributed and Claimed with the right numbers", async () => {
      const { enc, v, burner, operator, u1, deployer } = await loadFixture(productionRig);
      await v.addBeneficiaries(SEED, [u1.address], [CAP[SEED]], [deployer.address], true);
      await enc.connect(burner).burn(1_000n * E);
      await expect(v.connect(operator).distribute(SEED))
        .to.emit(v, "PoolAccrued").withArgs(SEED, 400n * E, 400n * E)
        .and.to.emit(v, "PoolAllocated").withArgs(SEED, 400n * E, 0n)
        .and.to.emit(v, "Claimed").withArgs(SEED, u1.address, 400n * E)
        .and.to.emit(v, "Distributed").withArgs(SEED, 1n, 400n * E, 0n);
    });

    it("reports the number of wallets actually paid, not the member count", async () => {
      const { enc, v, burner, operator, u1, u2, deployer } = await loadFixture(productionRig);
      await v.addBeneficiaries(SEED, [u1.address], [10_000_000n * E], [deployer.address], true);
      await enc.connect(burner).burn(22_500_000n * E);
      await v.connect(operator).distribute(SEED);
      await v.addBeneficiaries(SEED, [u2.address], [2_000_000n * E], [deployer.address], true);
      await enc.connect(burner).burn(5_000_000n * E);
      await v.connect(operator).distribute(SEED);   // pays both, leaves 666,666.66…

      // u1 has no room left, so only one wallet is paid even though the round has two
      await expect(v.connect(operator).distribute(SEED))
        .to.emit(v, "Distributed").withArgs(SEED, 1n, 666_666_666_666_666_666_666_667n, 0n);
    });

    it("emits AllocationSet on registration and RoleGranted on operator hand-over", async () => {
      const { v, u1, outsider, deployer } = await loadFixture(productionRig);
      await expect(v.addBeneficiaries(SEED, [u1.address], [5n * E], [deployer.address], true))
        .to.emit(v, "AllocationSet").withArgs(SEED, u1.address, 0n, 5n * E);
      const role = await v.OPERATOR_ROLE();
      await expect(v.grantRole(role, outsider.address))
        .to.emit(v, "RoleGranted").withArgs(role, outsider.address, deployer.address);
      expect(await v.hasRole(role, outsider.address)).to.equal(true);
    });
  });

  describe("access control and rejected inputs", () => {
    it("only OPERATOR_ROLE holders (the operator, and the deployer the rig granted) may press", async () => {
      const { enc, v, burner, operator, outsider, u1, deployer } = await loadFixture(productionRig);
      await v.addBeneficiaries(SEED, [u1.address], [CAP[SEED]], [deployer.address], true);
      await enc.connect(burner).burn(1_000n * E);
      await expect(v.connect(outsider).distribute(SEED))
        .to.be.revertedWithCustomError(v, "AccessControlUnauthorizedAccount")
        .withArgs(outsider.address, await v.OPERATOR_ROLE());
      await expect(v.connect(deployer).distribute(SEED)).to.not.be.reverted;   // deployer
      await enc.connect(burner).burn(1_000n * E);
      await expect(v.connect(operator).distribute(SEED)).to.not.be.reverted;   // operator
    });

    it("investors of a pooled round can never pull", async () => {
      const { enc, v, burner, operator, u1, deployer } = await loadFixture(productionRig);
      await v.addBeneficiaries(SEED, [u1.address], [CAP[SEED]], [deployer.address], true);
      await enc.connect(burner).burn(1_000n * E);
      for (const r of POOLED) {
        await expect(v.connect(u1).claim(r.id))
          .to.be.revertedWithCustomError(v, "OperatorDistributedRound").withArgs(r.id);
      }
      // and claimAll never touches them
      await v.connect(operator).distribute(SEED);
      const paid = await enc.balanceOf(u1.address);
      await expect(v.connect(u1).claimAll()).to.be.revertedWithCustomError(v, "NothingToClaim");
      expect(await enc.balanceOf(u1.address)).to.equal(paid);
    });

    it("distribute reverts NothingToDistribute when there is nothing to move", async () => {
      const { v, operator, u1, deployer } = await loadFixture(productionRig);
      await expect(v.connect(operator).distribute(SEED))
        .to.be.revertedWithCustomError(v, "NothingToDistribute").withArgs(SEED);
      await v.addBeneficiaries(SEED, [u1.address], [CAP[SEED]], [deployer.address], true);
      await expect(v.connect(operator).distribute(PRIVATE))
        .to.be.revertedWithCustomError(v, "NothingToDistribute").withArgs(PRIVATE);
    });

    it("distribute and previewDistribution reject non-pooled rounds", async () => {
      const { v, operator } = await loadFixture(productionRig);
      for (const r of [2, 3, 4, 77]) {
        await expect(v.connect(operator).distribute(r))
          .to.be.revertedWithCustomError(v, "UnknownRound").withArgs(r);
        await expect(v.previewDistribution(r))
          .to.be.revertedWithCustomError(v, "UnknownRound").withArgs(r);
        await expect(v.roundMembers(r))
          .to.be.revertedWithCustomError(v, "UnknownRound").withArgs(r);
      }
    });
  });

  describe("differential fuzz against the reference split", () => {
    it("matches the model wei-for-wei over 40 randomized burn/press schedules", async function () {
      this.timeout(240_000);
      const next = rng(20260811);
      let comparisons = 0;

      for (let s = 0; s < 40; s++) {
        const { enc, v, burner, operator, deployer } = await loadFixture(productionRig);
        const round = s % 2 === 0 ? SEED : PRIVATE;
        const cap = CAP[round];

        // random member set, sometimes leaving part of the cap unsold
        const n = 1 + Math.floor(next() * 5);
        const who: string[] = [];
        const allocs: bigint[] = [];
        let remaining = cap;
        for (let i = 0; i < n && remaining > 0n; i++) {
          const take = i === n - 1 && next() < 0.5
            ? remaining
            : BigInt(Math.max(1, Math.floor(next() * 1e9))) * (remaining / BigInt(1e9 + 1)) + 1n;
          const amt = take > remaining ? remaining : take;
          who.push(addr());
          allocs.push(amt);
          remaining -= amt;
        }
        await v.addBeneficiaries(round, who, allocs, who.map(() => deployer.address), true);

        const model: Member[] = allocs.map((a) => ({ alloc: a, credited: 0n }));
        let burned = 0n;

        for (let step = 0; step < 4; step++) {
          const amt = BigInt(Math.floor(next() * 12_000_000)) * E + 1n;
          await enc.connect(burner).burn(amt);
          burned += amt;

          if (next() < 0.3) continue; // sometimes skip the press

          const pool = await v.pendingPool(round);
          const want = splitPool(pool, model);
          const paidBefore = await Promise.all(who.map((w) => enc.balanceOf(w)));

          let reverted = false;
          try { await v.connect(operator).distribute(round); } catch { reverted = true; }

          if (reverted) {
            expect(want.shares.every((x) => x === 0n), `s${s}: press reverted but model paid`).to.equal(true);
            continue;
          }
          for (let i = 0; i < who.length; i++) {
            const delta = (await enc.balanceOf(who[i])) - paidBefore[i];
            expect(delta, `s${s} step${step} member${i} (burned=${burned})`).to.equal(want.shares[i]);
            model[i].credited += want.shares[i];
            comparisons++;
          }
          expect(await v.pendingPool(round), `s${s} step${step} leftover`).to.equal(want.leftover);
        }

        // nobody is ever paid beyond their allocation, and the vault stays solvent
        for (let i = 0; i < who.length; i++) {
          expect(await enc.balanceOf(who[i])).to.be.lessThanOrEqual(allocs[i]);
        }
        expect(await enc.balanceOf(await v.getAddress())).to.be.greaterThanOrEqual(await v.totalOutstanding());
      }
      expect(comparisons, "the fuzz must actually compare payouts").to.be.greaterThan(150);
    });

    it("press cadence moves wei between members but never creates or destroys value", async function () {
      this.timeout(120_000);
      const next = rng(777);
      for (let s = 0; s < 8; s++) {
        const who = [addr(), addr(), addr()];
        const a1 = BigInt(1 + Math.floor(next() * 4_000_000)) * E + 7n;
        const a2 = BigInt(1 + Math.floor(next() * 4_000_000)) * E + 13n;
        const allocs = [a1, a2, CAP[SEED] - a1 - a2];
        const burns = [1n, 2n, 3n].map(() => BigInt(1 + Math.floor(next() * 9_000_000)) * E);

        const run = async (pressEvery: boolean) => {
          const { enc, v, burner, operator, deployer } = await loadFixture(productionRig);
          await v.addBeneficiaries(SEED, who, allocs, who.map(() => deployer.address), true);
          for (const b of burns) {
            await enc.connect(burner).burn(b);
            if (pressEvery) { try { await v.connect(operator).distribute(SEED); } catch {} }
          }
          for (let i = 0; i < 4; i++) { try { await v.connect(operator).distribute(SEED); } catch { break; } }
          const bal = await Promise.all(who.map((w) => enc.balanceOf(w)));
          return { bal, pool: await v.pendingPool(SEED) };
        };

        const eager = await run(true);
        const lazy = await run(false);
        const sum = (x: bigint[]) => x.reduce((a, b) => a + b, 0n);
        expect(sum(eager.bal) + eager.pool, `s${s}: value not conserved`).to.equal(sum(lazy.bal) + lazy.pool);
        for (let i = 0; i < who.length; i++) {
          const d = eager.bal[i] > lazy.bal[i] ? eager.bal[i] - lazy.bal[i] : lazy.bal[i] - eager.bal[i];
          expect(d, `s${s}: member ${i} drifted more than dust`).to.be.lessThanOrEqual(16n);
        }
      }
    });
  });

  describe("scale", () => {
    it("handles a 60-investor round and pays every one of them correctly", async function () {
      this.timeout(120_000);
      const { enc, v, burner, operator, deployer } = await loadFixture(productionRig);
      const n = 60;
      const who = Array.from({ length: n }, addr);
      const base = CAP[SEED] / BigInt(n);
      const allocs = who.map((_, i) => (i === n - 1 ? CAP[SEED] - base * BigInt(n - 1) : base));
      await v.addBeneficiaries(SEED, who, allocs, who.map(() => deployer.address), true);
      expect((await v.roundMembers(SEED)).length).to.equal(n);

      await enc.connect(burner).burn(BOUNDARY[0]);
      const tx = await v.connect(operator).distribute(SEED);
      const rc = await tx.wait();
      for (let i = 0; i < n; i++) expect(await enc.balanceOf(who[i]), `member ${i}`).to.equal(allocs[i]);
      expect(await v.pendingPool(SEED)).to.equal(0n);
      // keep an eye on the gas ceiling of the unpaginated loop
      expect(rc!.gasUsed, `distribute gas for ${n} members`).to.be.lessThan(8_000_000n);
    });
  });
});
