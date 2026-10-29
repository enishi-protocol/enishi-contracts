import { expect } from "chai";
import { ethers } from "hardhat";
import { time, reset } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ENC_MAX_SUPPLY } from "../../helpers/encConstants";

/**
 * Boundary sweep across the PUBLIC release grid.
 *
 *   lock-up = 365 days  → release 01 the instant it ends
 *   then every 30 days  → release k at startTime + 365 days + (k − 1) × 30 days
 *
 * Every mark is probed one second BEFORE and exactly AT it, so "before the due time
 * you cannot claim, at the due time you can" is proven rather than assumed.
 * Mid-interval points (the "middle of the month" cases) are probed too.
 *
 * Offsets rather than hardcoded calendar dates: a chain's clock can only move
 * forward from real time, so a fixed past TGE would be unreachable and a fixed
 * future one would rot. The calendar dates each offset corresponds to are printed
 * by `scripts/public-schedule.ts` against the live deployment.
 *
 * Own file because it rewinds to a fresh chain — the other suites push the clock
 * years ahead and timestamps never move backwards within one chain.
 */

const E = (n: number | string) => ethers.parseUnits(n.toString(), 18);

const PUBLIC = 4;
const INITIAL_SUPPLY = ENC_MAX_SUPPLY;
// 970M vests here (178M TGE + 792M monthly); the other 20M of the 990M
// Public allocation is sold by the standalone EnishiPublicSale contract,
// not administered here.
const PUBLIC_ALLOC = E(970_000_000);
const PUBLIC_TGE = E(178_000_000);
const PER_RELEASE = E(13_200_000); // (990M − 198M) / 60

const DAY = 24 * 3600;
const CLIFF = 365 * DAY;
const INTERVAL = 30 * DAY;

const iso = (ts: bigint | number) => new Date(Number(ts) * 1000).toISOString().slice(0, 10);

async function deployFresh() {
  const [deployer, team, treasury, pub, publicSale] = await ethers.getSigners();
  const enc = await (await ethers.getContractFactory("ENC")).deploy();
  await enc.waitForDeployment();
  const registry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(
    team.address,
  );
  await registry.waitForDeployment();
  const v = await (await ethers.getContractFactory("ENCVesting")).deploy(
    INITIAL_SUPPLY, team.address, treasury.address, pub.address, await registry.getAddress(),
  );
  // ENCVesting grants the deployer only DEFAULT_ADMIN_ROLE; the suite operates as deployer.
  await v.grantRole(await v.OPERATOR_ROLE(), (await ethers.getSigners())[0].address);
  await v.waitForDeployment();
  // The vault holds every round's ENC, PUBLIC's TGE tranche included — {start}
  // refuses until it covers what the constructor already committed.
  // In production the genesis mint splits the supply between the vault and
  // the standalone EnishiPublicSale contract's 20M carve-out.
  await enc.mintGenesis(await v.getAddress(), publicSale.address);
  await v.start(await enc.getAddress());
  // settle the TGE tranche up front, so the assertions below see only monthly releases
  await v.connect(pub).claim(PUBLIC);
  return { enc, v, pub, start: await v.startTime() };
}

/** Timestamp release `k` (1-based) becomes claimable. */
const due = (start: bigint, k: number) => start + BigInt(CLIFF + (k - 1) * INTERVAL);

describe("ENCVesting — PUBLIC release timing", () => {
  beforeEach(async () => {
    await reset(); // fresh chain: the clock must start before the schedule
  });

  it("publicReleaseTime matches the 365 + 30·(k−1) grid exactly", async () => {
    const { v, start } = await deployFresh();
    for (const k of [1, 2, 3, 4, 5, 6, 7, 30, 60]) {
      expect(await v.publicReleaseTime(k), `release ${k}`).to.equal(due(start, k));
    }
    // Release 1 is exactly one year out; the gap to release 2 is exactly 30 days.
    expect((await v.publicReleaseTime(1)) - start).to.equal(BigInt(CLIFF));
    expect((await v.publicReleaseTime(2)) - (await v.publicReleaseTime(1))).to.equal(
      BigInt(INTERVAL),
    );
  });

  it("one second before each release nothing new; at the mark exactly one more", async () => {
    const { v, pub, start } = await deployFresh();

    for (let k = 1; k <= 7; k++) {
      await time.increaseTo(due(start, k) - 2n);
      expect(await v.publicReleasesUnlocked(), `1s before release ${k}`).to.equal(BigInt(k - 1));
      expect(await v.claimable(PUBLIC, pub.address), `1s before release ${k}`).to.equal(
        PER_RELEASE * BigInt(k - 1),
      );

      await time.increaseTo(due(start, k));
      expect(await v.publicReleasesUnlocked(), `exactly at release ${k}`).to.equal(BigInt(k));
      expect(await v.claimable(PUBLIC, pub.address), `exactly at release ${k}`).to.equal(
        PER_RELEASE * BigInt(k),
      );
    }
  });

  it("mid-month (day 1, 15, 29 after a boundary) unlocks nothing extra", async () => {
    const { v, pub, start } = await deployFresh();

    // Sit just past release 4, then walk through the month without crossing release 5.
    await time.increaseTo(due(start, 4));
    for (const offsetDays of [1, 10, 15, 20, 29]) {
      await time.increaseTo(due(start, 4) + BigInt(offsetDays * DAY));
      expect(await v.publicReleasesUnlocked(), `+${offsetDays} days`).to.equal(4n);
      expect(await v.claimable(PUBLIC, pub.address), `+${offsetDays} days`).to.equal(
        PER_RELEASE * 4n,
      );
    }
    // Day 30 is release 5.
    await time.increaseTo(due(start, 5));
    expect(await v.publicReleasesUnlocked()).to.equal(5n);
  });

  it("claiming at the boundary works, claiming again right after reverts", async () => {
    const { enc, v, pub, start } = await deployFresh();

    await time.increaseTo(due(start, 4)); // 4 tranches accumulated, nothing claimed yet
    await expect(v.connect(pub).claim(PUBLIC)).to.changeTokenBalance(enc, pub, PER_RELEASE * 4n);
    await expect(v.connect(pub).claim(PUBLIC)).to.be.revertedWithCustomError(v, "NothingToClaim");
  });

  it("after claiming, a mid-month retry reverts; only the next boundary adds ONE release", async () => {
    const { enc, v, pub, start } = await deployFresh();

    await time.increaseTo(due(start, 4));
    await v.connect(pub).claim(PUBLIC);

    await time.increaseTo(due(start, 4) + BigInt(15 * DAY)); // mid-month
    await expect(v.connect(pub).claim(PUBLIC)).to.be.revertedWithCustomError(v, "NothingToClaim");

    await time.increaseTo(due(start, 5)); // exactly at the release 5 boundary
    await expect(v.connect(pub).claim(PUBLIC)).to.changeTokenBalance(enc, pub, PER_RELEASE);

    await time.increaseTo(due(start, 5) + BigInt(14 * DAY)); // mid-month again
    await expect(v.connect(pub).claim(PUBLIC)).to.be.revertedWithCustomError(v, "NothingToClaim");

    await time.increaseTo(due(start, 6));
    await expect(v.connect(pub).claim(PUBLIC)).to.changeTokenBalance(enc, pub, PER_RELEASE);
  });

  it("a late claim does not shift the schedule: the next release keeps its original date", async () => {
    const { enc, v, pub, start } = await deployFresh();

    // Claims release 1 sixteen days late.
    await time.increaseTo(due(start, 1) + BigInt(16 * DAY));
    await expect(v.connect(pub).claim(PUBLIC)).to.changeTokenBalance(enc, pub, PER_RELEASE);

    // Release 2 is unmoved: 14 days after that claim, not 30.
    await time.increaseTo(due(start, 2) - 2n);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(0n);
    await time.increaseTo(due(start, 2));
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(PER_RELEASE);
  });

  it("skipping several months then claiming once pays the whole backlog, schedule unchanged", async () => {
    const { enc, v, pub, start } = await deployFresh();

    await time.increaseTo(due(start, 6) + BigInt(15 * DAY)); // ignores releases 1..6
    expect(await v.publicReleasesUnlocked()).to.equal(6n);
    await expect(v.connect(pub).claim(PUBLIC)).to.changeTokenBalance(enc, pub, PER_RELEASE * 6n);

    await time.increaseTo(due(start, 7));
    await expect(v.connect(pub).claim(PUBLIC)).to.changeTokenBalance(enc, pub, PER_RELEASE);
  });

  it("the schedule's calendar dates are one year + k months out (sanity print)", async () => {
    const { v, start } = await deployFresh();
    const r1 = await v.publicReleaseTime(1);
    const r60 = await v.publicReleaseTime(60);
    // A year of lock-up plus 59 thirty-day months = 2135 days end to end.
    expect((r60 - start) / BigInt(DAY)).to.equal(BigInt(365 + 59 * 30));
    expect(iso(r1).length).to.equal(10); // dates are well-formed; exact values printed by the script
  });
});
