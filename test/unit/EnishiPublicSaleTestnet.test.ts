import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const E = (n: number | string) => ethers.parseUnits(n.toString(), 18);

const ENC_PER_UNIT = E(200_000);
const MAX_UNITS = 100n;
const DAY = 86_400;
const CLIFF = 730 * DAY;
const INTERVAL = 30 * DAY;
const RELEASES = 12;

/** Mirror of EnishiPublicSale._vested at tranche k: amount × k / 12, rounded half up. */
const vested = (amount: bigint, k: number) =>
  k >= RELEASES ? amount : (amount * BigInt(k) + 6n) / 12n;

async function fixture() {
  const [deployer, treasury, buyer1, outsider] = await ethers.getSigners();

  const enc = await (await ethers.getContractFactory("ENC")).deploy();
  await enc.waitForDeployment();
  await enc.mintGenesis(deployer.address, outsider.address);

  const usdt = await (
    await ethers.getContractFactory("MockERC20")
  ).deploy("Mock USDT", "mUSDT", 18);
  await usdt.waitForDeployment();

  const sale = await (
    await ethers.getContractFactory("EnishiPublicSaleTestnet")
  ).deploy(await usdt.getAddress(), treasury.address);
  await sale.waitForDeployment();

  const saleAddr = await sale.getAddress();
  await sale.grantRole(await sale.OPERATOR_ROLE(), deployer.address);
  await sale.setEncToken(await enc.getAddress());
  await enc.transfer(saleAddr, MAX_UNITS * ENC_PER_UNIT);
  await sale.setSaleOpen(true);

  await usdt.mint(buyer1.address, E(10_000_000));
  await usdt.connect(buyer1).approve(saleAddr, ethers.MaxUint256);

  return { deployer, treasury, buyer1, outsider, enc, usdt, sale };
}

describe("EnishiPublicSaleTestnet — warpBy / warpTo", () => {
  it("defaults to a zero offset, behaving exactly like real time", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(1);
    expect(await sale.claimableOf(buyer1.address)).to.equal(0n);
    expect(await sale.timeOffset()).to.equal(0n);
  });

  it("warpBy skips the full 730-day lock instantly", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(1);

    await expect(sale.warpBy(CLIFF)).to.emit(sale, "ClockWarped").withArgs(0n, BigInt(CLIFF));
    expect(await sale.claimableOf(buyer1.address)).to.equal(vested(ENC_PER_UNIT, 1));
  });

  it("warpBy accumulates across multiple calls", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(1);

    await sale.warpBy(CLIFF);
    await sale.warpBy(11 * INTERVAL);
    expect(await sale.timeOffset()).to.equal(BigInt(CLIFF + 11 * INTERVAL));
    expect(await sale.claimableOf(buyer1.address)).to.equal(ENC_PER_UNIT);
  });

  it("warpBy with a negative delta rewinds the clock", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(1);

    await sale.warpBy(CLIFF + 6 * INTERVAL);
    expect(await sale.claimableOf(buyer1.address)).to.be.greaterThan(0n);

    await sale.warpBy(-(CLIFF + 6 * INTERVAL));
    expect(await sale.claimableOf(buyer1.address)).to.equal(0n);
  });

  it("lets a tester claim the full lot immediately after warping past release 12", async () => {
    const { sale, enc, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(1);

    await sale.warpBy(CLIFF + 11 * INTERVAL);
    await sale.connect(buyer1).claim();
    expect(await enc.balanceOf(buyer1.address)).to.equal(ENC_PER_UNIT);
  });

  it("warpTo sets the clock to an absolute timestamp", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    const receipt = await (await sale.connect(buyer1).buy(1)).wait();
    const lotStart = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;

    await sale.warpTo(lotStart + CLIFF);
    expect(await sale.claimableOf(buyer1.address)).to.equal(vested(ENC_PER_UNIT, 1));
  });

  it("reverts for a caller without OPERATOR_ROLE on both warpBy and warpTo", async () => {
    const { sale, outsider } = await loadFixture(fixture);
    await expect(sale.connect(outsider).warpBy(1)).to.be.revertedWithCustomError(
      sale,
      "AccessControlUnauthorizedAccount",
    );
    await expect(sale.connect(outsider).warpTo(1)).to.be.revertedWithCustomError(
      sale,
      "AccessControlUnauthorizedAccount",
    );
  });

  it("buy() still records the (warped) current timestamp as the lot's start", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.warpBy(365 * DAY);

    const receipt = await (await sale.connect(buyer1).buy(1)).wait();
    const blockTimestamp = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;
    const lots = await sale.lotsOf(buyer1.address);

    expect(lots[0].start).to.equal(blockTimestamp + 365 * DAY);
  });
});
