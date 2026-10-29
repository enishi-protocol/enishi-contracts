import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  BOUNDARY, CAP, CLIFF, E, INTERVAL, PUBLIC, PUBLIC_ALLOC, PUBLIC_TGE, RELEASE_COUNT,
  TEAM, TREASURY, ENC_MAX_SUPPLY, publicBps, publicEntitlement, publicReleases, unlocked,
} from "../helpers/vestingModel";
import { productionRig } from "../helpers/vestingRig";

/**
 * The time engine (PUBLIC) and the two single-beneficiary burn rounds
 * (TEAM / TREASURY), which are pulled with {claim} rather than pressed.
 *
 * The PUBLIC schedule is checked at EVERY one of its 60 releases, at both sides of
 * every release boundary, and around the cliff — no month is sampled away.
 */

describe("PUBLIC time round — full schedule coverage", () => {
  /** Every second-of-interest on the schedule, ascending. */
  const OFFSETS: bigint[] = (() => {
    const s = new Set<bigint>([0n, 1n, CLIFF - 2n, CLIFF - 1n, CLIFF, CLIFF + 1n]);
    for (let i = 0n; i <= RELEASE_COUNT + 2n; i++) {
      const due = CLIFF + INTERVAL * i;
      s.add(due - 1n); s.add(due); s.add(due + 1n);
    }
    s.add(CLIFF + INTERVAL * 100n); // long after the end
    return [...s].filter((x) => x >= 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  })();

  it("visits every one of the 60 releases and both sides of each boundary", () => {
    for (let i = 1n; i <= RELEASE_COUNT; i++) {
      const due = CLIFF + INTERVAL * (i - 1n);
      expect(OFFSETS, `release ${i} due-1`).to.include(due - 1n);
      expect(OFFSETS, `release ${i} due`).to.include(due);
    }
    // the model really does reach 100% and no more
    expect(publicReleases(CLIFF + INTERVAL * 59n)).to.equal(RELEASE_COUNT);
    expect(publicEntitlement(PUBLIC_ALLOC, CLIFF + INTERVAL * 59n)).to.equal(PUBLIC_ALLOC);
    expect(publicEntitlement(PUBLIC_ALLOC, CLIFF - 1n)).to.equal(PUBLIC_TGE);
  });

  it("matches the schedule at every offset, and claiming never outruns it", async function () {
    this.timeout(180_000);
    const { enc, v, pub } = await loadFixture(productionRig);
    const start = await v.startTime();

    let claimedSoFar = PUBLIC_TGE; // the rig already pulled the TGE tranche
    for (const off of OFFSETS) {
      // a claim mines a block and can carry us past the next offset; assertions are
      // always made against the block's real timestamp, so overshoot is harmless
      const target = start + off;
      if (BigInt(await time.latest()) < target) await time.increaseTo(target);
      const now = BigInt(await time.latest());
      const elapsed = now - start;

      expect(await v.publicReleasesUnlocked(), `releases at +${elapsed}s`)
        .to.equal(publicReleases(elapsed));
      expect(await v.publicUnlockedBps(), `bps at +${elapsed}s`)
        .to.equal(publicBps(elapsed));

      const entitlement = publicEntitlement(PUBLIC_ALLOC, elapsed);
      const want = entitlement > claimedSoFar ? entitlement - claimedSoFar : 0n;
      expect(await v.claimable(PUBLIC, pub.address), `claimable at +${elapsed}s`).to.equal(want);
      expect(entitlement, "entitlement can never exceed the allocation").to.be.lessThanOrEqual(PUBLIC_ALLOC);

      if (want > 0n && (elapsed / INTERVAL) % 7n === 0n) {
        await v.connect(pub).claimAll();
        claimedSoFar = await v.claimed(PUBLIC, pub.address);
        expect(await enc.balanceOf(pub.address), "wallet == claimed").to.equal(claimedSoFar);
      }
    }

    // by the end the whole allocation minus the TGE tranche is claimable/claimed
    if ((await v.claimable(PUBLIC, pub.address)) > 0n) await v.connect(pub).claimAll();
    expect(await v.claimed(PUBLIC, pub.address)).to.equal(PUBLIC_ALLOC);
    expect(await enc.balanceOf(pub.address)).to.equal(PUBLIC_ALLOC);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(0n);
  });

  it("releases nothing during the cliff, then exactly one release the instant it ends", async () => {
    const { v, pub } = await loadFixture(productionRig);
    const start = await v.startTime();

    // claim from well inside the cliff (the tx mines a block one second later, which
    // must still be inside it for the revert to mean what we think it means)
    await time.increaseTo(start + CLIFF - 10n);
    expect(await v.publicReleasesUnlocked()).to.equal(0n);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(0n);
    await expect(v.connect(pub).claim(PUBLIC)).to.be.revertedWithCustomError(v, "NothingToClaim");

    // and the very last second of the cliff still releases nothing
    await time.increaseTo(start + CLIFF - 1n);
    expect(await v.publicReleasesUnlocked()).to.equal(0n);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(0n);

    await time.increaseTo(start + CLIFF);
    expect(await v.publicReleasesUnlocked()).to.equal(1n);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal((PUBLIC_ALLOC - PUBLIC_TGE) / RELEASE_COUNT);
  });

  it("the TGE tranche is unlocked at genesis, pulled with claim, and only once", async () => {
    // a fresh deployment, before anyone has claimed: every round's ENC sits in the
    // vault — all but the 20,000,000 Public Sale carve-out, minted elsewhere at genesis.
    const [d, , , , , , team, treasury, pub, sale] = await ethers.getSigners();
    const enc = await (await ethers.getContractFactory("ENC")).deploy();
    await enc.waitForDeployment();
    const registry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(
      team.address,
    );
    await registry.waitForDeployment();
    const v = await (await ethers.getContractFactory("ENCVesting")).deploy(
      ENC_MAX_SUPPLY, team.address, treasury.address, pub.address, await registry.getAddress());
    // ENCVesting grants the deployer only DEFAULT_ADMIN_ROLE; the suite operates as deployer.
    await v.grantRole(await v.OPERATOR_ROLE(), (await ethers.getSigners())[0].address);
    await enc.mintGenesis(await v.getAddress(), sale.address);
    await enc.approve(await v.getAddress(), await v.totalOutstanding());
    await v.start(await enc.getAddress());

    expect(await enc.balanceOf(await v.getAddress()), "vault holds every round's ENC")
      .to.equal(await enc.VESTING_ALLOCATION());
    expect(await enc.balanceOf(pub.address), "nothing circulates yet").to.equal(0n);
    expect(await v.claimed(PUBLIC, pub.address), "nothing recorded as paid").to.equal(0n);
    expect(await v.PUBLIC_TGE_AMOUNT()).to.equal(PUBLIC_TGE);
    expect(await v.claimable(PUBLIC, pub.address), "the TGE tranche is claimable at once")
      .to.equal(PUBLIC_TGE);

    await expect(v.connect(pub).claim(PUBLIC))
      .to.emit(v, "Claimed").withArgs(PUBLIC, pub.address, PUBLIC_TGE);
    expect(await enc.balanceOf(pub.address)).to.equal(PUBLIC_TGE);
    expect(await v.claimed(PUBLIC, pub.address)).to.equal(PUBLIC_TGE);

    // and never a second time, until the cliff opens the next release
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(0n);
    await expect(v.connect(pub).claim(PUBLIC)).to.be.revertedWithCustomError(v, "NothingToClaim");
  });

  it("burning has no effect whatsoever on the PUBLIC round", async () => {
    const { enc, v, burner, pub } = await loadFixture(productionRig);
    const before = await v.claimable(PUBLIC, pub.address);
    await enc.connect(burner).burn(150_000_000n * E);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(before);
    expect(await v.publicReleasesUnlocked()).to.equal(0n);
  });

  describe("publicReleaseTime", () => {
    it("returns the due date of every release, 30 days apart after a 365-day cliff", async () => {
      const { v } = await loadFixture(productionRig);
      const start = await v.startTime();
      for (let i = 1n; i <= RELEASE_COUNT; i++) {
        expect(await v.publicReleaseTime(i), `release ${i}`)
          .to.equal(start + CLIFF + INTERVAL * (i - 1n));
      }
      expect(await v.publicReleaseTime(RELEASE_COUNT) - await v.publicReleaseTime(1n))
        .to.equal(INTERVAL * (RELEASE_COUNT - 1n));
    });

    it("rejects index 0 and anything past the last release", async () => {
      const { v } = await loadFixture(productionRig);
      await expect(v.publicReleaseTime(0)).to.be.revertedWithCustomError(v, "InvalidReleaseIndex").withArgs(0);
      await expect(v.publicReleaseTime(61)).to.be.revertedWithCustomError(v, "InvalidReleaseIndex").withArgs(61);
      await expect(v.publicReleaseTime(10_000)).to.be.revertedWithCustomError(v, "InvalidReleaseIndex");
    });

    it("a release date never moves, no matter how late the previous one was claimed", async () => {
      const { v, pub } = await loadFixture(productionRig);
      const dates = [];
      for (let i = 1n; i <= 5n; i++) dates.push(await v.publicReleaseTime(i));
      await time.increaseTo((await v.startTime()) + CLIFF + INTERVAL * 4n);
      await v.connect(pub).claimAll();
      for (let i = 1n; i <= 5n; i++) expect(await v.publicReleaseTime(i)).to.equal(dates[Number(i) - 1]);
    });
  });
});

describe("TEAM / TREASURY — pull rounds driven by burn", () => {
  const SINGLE = [
    { id: TEAM, name: "TEAM", key: "team" as const },
    { id: TREASURY, name: "TREASURY", key: "treasury" as const },
  ];

  for (const r of SINGLE) {
    it(`${r.name}: claimable tracks the curve exactly at every burn level`, async () => {
      const rig = await loadFixture(productionRig);
      const { enc, v, burner } = rig;
      const who = (rig as any)[r.key];
      let burned = 0n;
      // The ladder must fit inside the genesis burn budget — the 178,000,000 ENC
      // TGE tranche (20% of 990M less the 20M Public Sale carve-out).
      for (const step of [1n, 999n, 1_000n * E, 4_999_999n * E, 12_000_000n * E,
                          13_000_001n * E, 26_666_666n * E, 100_000_000n * E, 21_000_000n * E]) {
        await enc.connect(burner).burn(step);
        burned += step;
        const model = unlocked(burned)[r.id];
        const already = await v.claimed(r.id, who.address);
        expect(await v.claimable(r.id, who.address), `after ${burned} burned`).to.equal(model - already);
      }
    });

    it(`${r.name}: claim transfers exactly the claimable amount and is idempotent`, async () => {
      const rig = await loadFixture(productionRig);
      const { enc, v, burner } = rig;
      const who = (rig as any)[r.key];
      await enc.connect(burner).burn(20_000_000n * E);
      const want = await v.claimable(r.id, who.address);
      expect(want).to.be.greaterThan(0n);
      await expect(v.connect(who).claim(r.id)).to.emit(v, "Claimed").withArgs(r.id, who.address, want);
      expect(await enc.balanceOf(who.address)).to.equal(want);
      expect(await v.claimable(r.id, who.address)).to.equal(0n);
      await expect(v.connect(who).claim(r.id)).to.be.revertedWithCustomError(v, "NothingToClaim");
    });

    it(`${r.name}: repeated partial claims total exactly one big claim`, async () => {
      const rig = await loadFixture(productionRig);
      const { enc, v, burner } = rig;
      const who = (rig as any)[r.key];
      for (const b of [3_000_000n * E, 7_000_000n * E, 11_000_000n * E, 29_000_000n * E]) {
        await enc.connect(burner).burn(b);
        await v.connect(who).claim(r.id);
      }
      const total = 50_000_000n * E;
      expect(await enc.balanceOf(who.address)).to.equal(unlocked(total)[r.id]);
    });
  }

  it("claimAll sweeps the pull rounds and equals the sum of the individual claims", async () => {
    const { enc, v, burner, team } = await loadFixture(productionRig);
    await enc.connect(burner).burn(30_000_000n * E);
    const each = await v.claimable(TEAM, team.address);
    await v.connect(team).claimAll();
    expect(await enc.balanceOf(team.address)).to.equal(each);
  });

  it("claimAll reverts when the caller has nothing anywhere", async () => {
    const { v, outsider } = await loadFixture(productionRig);
    await expect(v.connect(outsider).claimAll()).to.be.revertedWithCustomError(v, "NothingToClaim");
  });

  it("a third party cannot sweep someone else's rounds with claimAll", async () => {
    const { enc, v, burner, outsider, team } = await loadFixture(productionRig);
    await enc.connect(burner).burn(10_000_000n * E);
    await expect(v.connect(outsider).claimAll()).to.be.revertedWithCustomError(v, "NothingToClaim");
    expect(await enc.balanceOf(team.address)).to.equal(0n);
  });

  it("a wallet with no allocation gets nothing from any round", async () => {
    const { v, burner, enc, outsider } = await loadFixture(productionRig);
    await enc.connect(burner).burn(30_000_000n * E);
    for (const r of [0, 1, 2, 3, 4]) {
      expect(await v.claimable(r, outsider.address), `round ${r}`).to.equal(0n);
    }
    await expect(v.connect(outsider).claim(TEAM)).to.be.revertedWithCustomError(v, "NothingToClaim");
  });

  it("TEAM and TREASURY cannot claim past their cap even at full unlock", async () => {
    const { enc, v, burner, team, treasury } = await loadFixture(productionRig);
    await enc.connect(burner).burn(await enc.balanceOf(burner.address));
    expect(await v.cumulativeBurned()).to.be.lessThan(BOUNDARY[2]);   // the real float cannot reach it
    for (const [id, who] of [[TEAM, team], [TREASURY, treasury]] as const) {
      await v.connect(who).claimAll();
      expect(await enc.balanceOf(who.address)).to.be.lessThanOrEqual(CAP[id]);
      expect(await enc.balanceOf(who.address)).to.equal(unlocked(await v.cumulativeBurned())[id]);
    }
  });

  it("claim rejects unknown rounds", async () => {
    const { v, team } = await loadFixture(productionRig);
    await expect(v.connect(team).claim(6)).to.be.revertedWithCustomError(v, "UnknownRound").withArgs(6);
    await expect(v.claimable(9, team.address)).to.be.revertedWithCustomError(v, "UnknownRound").withArgs(9);
  });
});
