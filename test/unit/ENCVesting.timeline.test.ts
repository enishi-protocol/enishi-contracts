import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  mine,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * Every point of both time-based schedules, walked release by release.
 *
 * The reference numbers are computed here from the spec — a cliff, then N equal
 * tranches — not transliterated from the Solidity, so a mistake in the contract
 * cannot cancel out against the same mistake in the test.
 *
 * Each boundary is checked twice: one second before it and exactly on it. That is
 * where an off-by-one lives, and `claimable` is read from a block mined at exactly
 * that timestamp (`setNextBlockTimestamp` + `mine`), so the view sees the moment
 * under test and not the one after it.
 */
describe("ENCVesting — timelines, lock → fully vested", () => {
  const SUPPLY = ethers.parseEther("3000000000");
  const DAY = 86400;

  // PUBLIC (round 4): one wallet, 365-day cliff, 60 monthly releases.
  const PUBLIC = 4;
  const PUBLIC_CLIFF = 365 * DAY;
  const PUBLIC_INTERVAL = 30 * DAY;
  const PUBLIC_RELEASES = 60;

  async function rig() {
    const [deployer, , , , team, treasury, pub, , publicSale] =
      await ethers.getSigners();
    const enc = await (await ethers.getContractFactory("ENC")).deploy();
    await enc.waitForDeployment();
    const referralRegistry = await (
      await ethers.getContractFactory("ReferralRegistry")
    ).deploy(team.address);
    await referralRegistry.waitForDeployment();
    const v = await (
      await ethers.getContractFactory("ENCVesting")
    ).deploy(
      SUPPLY,
      team.address,
      treasury.address,
      pub.address,
      await referralRegistry.getAddress(),
    );
    await v.waitForDeployment();
    // ENCVesting grants the deployer only DEFAULT_ADMIN_ROLE; the suite operates as deployer.
    await v.grantRole(await v.OPERATOR_ROLE(), (await ethers.getSigners())[0].address);
    // ENCVesting must be authorized to call registerWithReferrer for its own
    // addBeneficiaries referrer registration to succeed.
    await referralRegistry.grantRole(await referralRegistry.OPERATOR_ROLE(), await v.getAddress());
    await enc.mintGenesis(await v.getAddress(), publicSale.address);
    await v.start(await enc.getAddress());

    const start = Number(await v.startTime());
    const [publicAlloc] = await v.allocationOf(PUBLIC, pub.address);
    const tge = await v.PUBLIC_TGE_AMOUNT();

    return {
      enc,
      v,
      start,
      publicAlloc,
      tge,
      deployer,
      pub,
    };
  }

  /** Mine a block whose timestamp is exactly `t`, so views read that instant. */
  async function at(t: number) {
    if (t <= (await time.latest())) throw new Error(`cannot rewind to ${t}`);
    await time.setNextBlockTimestamp(t);
    await mine();
  }

  // ─── Reference model, straight from the spec ──────────────────────────────

  function releasesDue(
    now: number,
    unlockAt: number,
    interval: number,
    count: number,
  ) {
    if (now < unlockAt) return 0;
    return Math.min(count, Math.floor((now - unlockAt) / interval) + 1);
  }

  /** PUBLIC: the TGE tranche is free at start; the rest is linear over 60 releases. */
  function publicEntitlement(
    alloc: bigint,
    tge: bigint,
    start: number,
    now: number,
  ) {
    if (now < start) return 0n;
    const r = releasesDue(
      now,
      start + PUBLIC_CLIFF,
      PUBLIC_INTERVAL,
      PUBLIC_RELEASES,
    );
    if (r === 0) return tge;
    if (r >= PUBLIC_RELEASES) return alloc;
    return tge + ((alloc - tge) * BigInt(r)) / BigInt(PUBLIC_RELEASES);
  }

  /** Boundary of release k (1-based) for a schedule anchored at `unlockAt`. */
  const boundary = (unlockAt: number, k: number, interval: number) =>
    unlockAt + (k - 1) * interval;

  // ─── PUBLIC round ─────────────────────────────────────────────────────────

  describe("PUBLIC — 365-day cliff then 60 monthly releases", () => {
    it("pays exactly the TGE tranche and nothing more for the whole cliff", async () => {
      const { v, start, tge, pub } = await loadFixture(rig);

      // The instant the vault opens, and every sampled point inside the lock.
      for (const t of [
        start + 1,
        start + DAY,
        start + 100 * DAY,
        start + PUBLIC_CLIFF - 1,
      ]) {
        await at(t);
        expect(
          await v.claimable(PUBLIC, pub.address),
          `at +${t - start}s`,
        ).to.equal(tge);
        expect(
          await v.publicReleasesUnlocked(),
          `releases at +${t - start}s`,
        ).to.equal(0n);
      }
    });

    it("matches the model at every one of the 60 boundaries, and one second before each", async () => {
      const { v, start, publicAlloc, tge, pub } = await loadFixture(rig);
      const unlockAt = start + PUBLIC_CLIFF;

      for (let k = 1; k <= PUBLIC_RELEASES; k++) {
        const b = boundary(unlockAt, k, PUBLIC_INTERVAL);

        await at(b - 1);
        expect(
          await v.claimable(PUBLIC, pub.address),
          `1s before release ${k}`,
        ).to.equal(publicEntitlement(publicAlloc, tge, start, b - 1));
        expect(
          await v.publicReleasesUnlocked(),
          `releases 1s before ${k}`,
        ).to.equal(BigInt(k - 1));

        await at(b);
        expect(
          await v.claimable(PUBLIC, pub.address),
          `at release ${k}`,
        ).to.equal(publicEntitlement(publicAlloc, tge, start, b));
        expect(await v.publicReleasesUnlocked(), `releases at ${k}`).to.equal(
          BigInt(k),
        );
      }
    });

    it("is fully vested at release 60 and never grows past the allocation", async () => {
      const { v, start, publicAlloc, pub } = await loadFixture(rig);
      const last = boundary(
        start + PUBLIC_CLIFF,
        PUBLIC_RELEASES,
        PUBLIC_INTERVAL,
      );

      await at(last);
      expect(await v.claimable(PUBLIC, pub.address)).to.equal(publicAlloc);

      for (const t of [last + 1, last + PUBLIC_INTERVAL, last + 3650 * DAY]) {
        await at(t);
        expect(
          await v.claimable(PUBLIC, pub.address),
          `at +${t - last}s past the end`,
        ).to.equal(publicAlloc);
        expect(await v.publicReleasesUnlocked()).to.equal(
          BigInt(PUBLIC_RELEASES),
        );
      }
    });

    it("claiming at every single boundary totals the allocation, to the wei", async () => {
      const { enc, v, start, publicAlloc, tge, pub } = await loadFixture(rig);

      // The TGE tranche first, at the very start.
      await at(start + 1);
      await v.connect(pub).claim(PUBLIC);
      expect(await enc.balanceOf(pub.address)).to.equal(tge);

      const unlockAt = start + PUBLIC_CLIFF;
      for (let k = 1; k <= PUBLIC_RELEASES; k++) {
        const b = boundary(unlockAt, k, PUBLIC_INTERVAL);
        await time.setNextBlockTimestamp(b);
        await v.connect(pub).claim(PUBLIC);
        expect(
          await enc.balanceOf(pub.address),
          `total after release ${k}`,
        ).to.equal(publicEntitlement(publicAlloc, tge, start, b));
      }

      expect(await enc.balanceOf(pub.address), "every wei arrives").to.equal(
        publicAlloc,
      );
      await at((await time.latest()) + DAY);
      await expect(v.connect(pub).claim(PUBLIC)).to.be.revertedWithCustomError(
        v,
        "NothingToClaim",
      );
    });

    it("claiming only once at the end pays the same total as claiming monthly", async () => {
      const { enc, v, start, publicAlloc, pub } = await loadFixture(rig);
      await at(
        boundary(start + PUBLIC_CLIFF, PUBLIC_RELEASES, PUBLIC_INTERVAL) + DAY,
      );
      await v.connect(pub).claim(PUBLIC);
      expect(await enc.balanceOf(pub.address)).to.equal(publicAlloc);
    });

    it("publishes a release grid that matches the schedule, and rejects out-of-range", async () => {
      const { v, start } = await loadFixture(rig);
      const unlockAt = start + PUBLIC_CLIFF;
      for (let k = 1; k <= PUBLIC_RELEASES; k++) {
        expect(await v.publicReleaseTime(k), `release ${k} due date`).to.equal(
          BigInt(boundary(unlockAt, k, PUBLIC_INTERVAL)),
        );
      }
      await expect(v.publicReleaseTime(0)).to.be.revertedWithCustomError(
        v,
        "InvalidReleaseIndex",
      );
      await expect(
        v.publicReleaseTime(PUBLIC_RELEASES + 1),
      ).to.be.revertedWithCustomError(v, "InvalidReleaseIndex");
    });

    it("never goes backwards across the whole schedule", async () => {
      const { v, start, pub } = await loadFixture(rig);
      let prev = 0n;
      const end =
        boundary(start + PUBLIC_CLIFF, PUBLIC_RELEASES, PUBLIC_INTERVAL) +
        PUBLIC_INTERVAL;
      for (let t = start + 1; t < end; t += 17 * DAY) {
        await at(t);
        const now = await v.claimable(PUBLIC, pub.address);
        expect(now, `dropped at +${t - start}s`).to.be.gte(prev);
        prev = now;
      }
    });
  });
});
