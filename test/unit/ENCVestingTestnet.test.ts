import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ENC_MAX_SUPPLY } from "../helpers/vestingModel";

const DAY = 86_400;
const CLIFF = 365 * DAY;
const INTERVAL = 30 * DAY;
const RELEASES = 60;
const PUBLIC = 4;

async function fixture() {
  const [deployer, operator, team, treasury, pub, publicSale, outsider] = await ethers.getSigners();

  const enc = await (await ethers.getContractFactory("ENC")).deploy();
  await enc.waitForDeployment();

  const referralRegistry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(
    deployer.address,
  );
  await referralRegistry.waitForDeployment();

  const v = await (await ethers.getContractFactory("ENCVestingTestnet")).deploy(
    ENC_MAX_SUPPLY, team.address, treasury.address, pub.address, await referralRegistry.getAddress(),
  );
  await v.waitForDeployment();

  await referralRegistry.grantRole(await referralRegistry.OPERATOR_ROLE(), await v.getAddress());
  await enc.mintGenesis(await v.getAddress(), publicSale.address);
  await v.grantRole(await v.OPERATOR_ROLE(), operator.address);

  return { deployer, operator, team, treasury, pub, outsider, enc, v };
}

async function startedFixture() {
  const ctx = await fixture();
  await ctx.v.start(await ctx.enc.getAddress());
  return ctx;
}

describe("ENCVestingTestnet — warpBy / warpTo", () => {
  it("defaults to a zero offset, behaving exactly like real time", async () => {
    const { v } = await loadFixture(startedFixture);
    expect(await v.timeOffset()).to.equal(0n);
    expect(await v.publicReleasesUnlocked()).to.equal(0n);
  });

  it("warpBy skips the full 365-day cliff instantly", async () => {
    const { v, operator } = await loadFixture(startedFixture);

    await expect(v.connect(operator).warpBy(CLIFF))
      .to.emit(v, "ClockWarped")
      .withArgs(0n, BigInt(CLIFF));
    expect(await v.publicReleasesUnlocked()).to.equal(1n);
  });

  it("warpBy accumulates across multiple calls", async () => {
    const { v, operator } = await loadFixture(startedFixture);

    await v.connect(operator).warpBy(CLIFF);
    await v.connect(operator).warpBy(4 * INTERVAL);
    expect(await v.timeOffset()).to.equal(BigInt(CLIFF + 4 * INTERVAL));
    expect(await v.publicReleasesUnlocked()).to.equal(5n);
  });

  it("warpBy with a negative delta rewinds the clock", async () => {
    const { v, operator } = await loadFixture(startedFixture);

    await v.connect(operator).warpBy(CLIFF + 6 * INTERVAL);
    expect(await v.publicReleasesUnlocked()).to.equal(7n);

    await v.connect(operator).warpBy(-(CLIFF + 6 * INTERVAL));
    expect(await v.publicReleasesUnlocked()).to.equal(0n);
  });

  it("lets PUBLIC claim its whole allocation after warping past release 60", async () => {
    const { v, enc, operator, pub } = await loadFixture(startedFixture);
    const [allocated] = await v.allocationOf(PUBLIC, pub.address);

    await v.connect(operator).warpBy(CLIFF + (RELEASES - 1) * INTERVAL);
    expect(await v.publicUnlockedBps()).to.equal(10_000n);

    await v.connect(pub).claim(PUBLIC);
    expect(await enc.balanceOf(pub.address)).to.equal(allocated);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(0n);
  });

  it("warpTo sets the clock to an absolute timestamp", async () => {
    const { v, operator } = await loadFixture(startedFixture);
    const startTime = await v.startTime();

    await v.connect(operator).warpTo(startTime + BigInt(CLIFF + 2 * INTERVAL));
    expect(await v.publicReleasesUnlocked()).to.equal(3n);
  });

  it("start() records the (warped) current timestamp as startTime", async () => {
    const { v, enc, operator } = await loadFixture(fixture);
    await v.connect(operator).warpBy(10 * DAY);

    const receipt = await (await v.start(await enc.getAddress())).wait();
    const blockTimestamp = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;

    expect(await v.startTime()).to.equal(BigInt(blockTimestamp + 10 * DAY));
  });

  it("the deployer (admin only) cannot warp until it grants itself OPERATOR_ROLE", async () => {
    const { v, deployer } = await loadFixture(startedFixture);
    const role = await v.OPERATOR_ROLE();
    await expect(v.connect(deployer).warpBy(CLIFF))
      .to.be.revertedWithCustomError(v, "AccessControlUnauthorizedAccount")
      .withArgs(deployer.address, role);
    await v.connect(deployer).grantRole(role, deployer.address);
    await expect(v.connect(deployer).warpBy(CLIFF)).to.emit(v, "ClockWarped");
  });

  it("reverts for a caller without OPERATOR_ROLE on both warpBy and warpTo", async () => {
    const { v, outsider } = await loadFixture(startedFixture);
    const role = await v.OPERATOR_ROLE();
    await expect(v.connect(outsider).warpBy(1))
      .to.be.revertedWithCustomError(v, "AccessControlUnauthorizedAccount")
      .withArgs(outsider.address, role);
    await expect(v.connect(outsider).warpTo(1))
      .to.be.revertedWithCustomError(v, "AccessControlUnauthorizedAccount")
      .withArgs(outsider.address, role);
  });
});
