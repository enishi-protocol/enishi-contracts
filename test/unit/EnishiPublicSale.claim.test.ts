import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const E = (n: number | string) => ethers.parseUnits(n.toString(), 18);

const ENC_PER_UNIT = E(200_000);
const MAX_UNITS = 100n;
const DAY = 86_400;
const CLIFF = 730 * DAY;
const INTERVAL = 30 * DAY;
const RELEASES = 12;

async function fixture() {
  const [deployer, treasury, buyer1, buyer2, outsider] = await ethers.getSigners();

  const enc = await (await ethers.getContractFactory("ENC")).deploy();
  await enc.waitForDeployment();
  await enc.mintGenesis(deployer.address, outsider.address);

  const usdt = await (
    await ethers.getContractFactory("MockERC20")
  ).deploy("Mock USDT", "mUSDT", 18);
  await usdt.waitForDeployment();

  const sale = await (
    await ethers.getContractFactory("EnishiPublicSale")
  ).deploy(await usdt.getAddress(), treasury.address);
  await sale.waitForDeployment();

  const saleAddr = await sale.getAddress();
  await sale.grantRole(await sale.OPERATOR_ROLE(), deployer.address);
  await sale.setEncToken(await enc.getAddress());
  await enc.transfer(saleAddr, MAX_UNITS * ENC_PER_UNIT);
  await sale.setSaleOpen(true);

  for (const b of [buyer1, buyer2]) {
    await usdt.mint(b.address, E(10_000_000));
    await usdt.connect(b).approve(saleAddr, ethers.MaxUint256);
  }

  return { deployer, treasury, buyer1, buyer2, enc, usdt, sale };
}

/** Mine a block whose timestamp is exactly `t`. */
async function at(t: number) {
  await time.setNextBlockTimestamp(t);
  await ethers.provider.send("evm_mine", []);
}

const boundary = (lotStart: number, k: number) => lotStart + CLIFF + (k - 1) * INTERVAL;

/** Mirror of EnishiPublicSale._vested at tranche k: amount × k / 12, rounded half up. */
const vested = (amount: bigint, k: number) =>
  k >= RELEASES ? amount : (amount * BigInt(k) + 6n) / 12n;

describe("EnishiPublicSale — claim", () => {
  it("nothing claimable before the 730-day lock ends, and reverts on claim()", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    const receipt = await (await sale.connect(buyer1).buy(1)).wait();
    const lotStart = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;

    await at(lotStart + CLIFF - 2); // one second before unlock
    expect(await sale.claimableOf(buyer1.address)).to.equal(0n);
    await expect(sale.connect(buyer1).claim()).to.be.revertedWithCustomError(
      sale,
      "NothingToClaim",
    );
  });

  it("~1/12 claimable the instant the 730-day lock ends", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    const receipt = await (await sale.connect(buyer1).buy(1)).wait();
    const lotStart = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;

    await at(boundary(lotStart, 1));
    expect(await sale.claimableOf(buyer1.address)).to.equal(vested(ENC_PER_UNIT, 1));
  });

  it("full amount claimable at release 12 (730d + 330d) or later", async () => {
    const { sale, enc, buyer1 } = await loadFixture(fixture);
    const receipt = await (await sale.connect(buyer1).buy(1)).wait();
    const lotStart = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;

    await at(boundary(lotStart, RELEASES));
    expect(await sale.claimableOf(buyer1.address)).to.equal(ENC_PER_UNIT);

    await sale.connect(buyer1).claim();
    expect(await enc.balanceOf(buyer1.address)).to.equal(ENC_PER_UNIT);
  });

  it("never grows past the purchase amount after release 12", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    const receipt = await (await sale.connect(buyer1).buy(1)).wait();
    const lotStart = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;

    await at(boundary(lotStart, RELEASES) + 1000 * DAY);
    expect(await sale.claimableOf(buyer1.address)).to.equal(ENC_PER_UNIT);
  });

  it("partial claim then re-claim only pays the new delta", async () => {
    const { sale, enc, buyer1 } = await loadFixture(fixture);
    const receipt = await (await sale.connect(buyer1).buy(1)).wait();
    const lotStart = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;

    await at(boundary(lotStart, 3));
    await sale.connect(buyer1).claim();
    expect(await enc.balanceOf(buyer1.address)).to.equal(vested(ENC_PER_UNIT, 3));

    await at(boundary(lotStart, 7));
    await sale.connect(buyer1).claim();
    expect(await enc.balanceOf(buyer1.address)).to.equal(vested(ENC_PER_UNIT, 7));
  });

  it("claims across two lots with different start times pay correct per-lot amounts", async () => {
    const { sale, enc, buyer1 } = await loadFixture(fixture);

    const r1 = await (await sale.connect(buyer1).buy(1)).wait();
    const lot1Start = (await ethers.provider.getBlock(r1!.blockNumber))!.timestamp;

    // Advance a month, then buy a second lot — its clock starts a month behind lot1's.
    await at(lot1Start + INTERVAL);
    const r2 = await (await sale.connect(buyer1).buy(2)).wait();
    const lot2Start = (await ethers.provider.getBlock(r2!.blockNumber))!.timestamp;

    // Jump to where lot2's cliff has just ended (release 1) — lot1, a month ahead
    // on the same 12-tranche grid, is already at release 2.
    await at(boundary(lot2Start, 1));
    expect(await sale.claimableOf(buyer1.address)).to.equal(
      vested(ENC_PER_UNIT, 2) + vested(2n * ENC_PER_UNIT, 1),
    );

    await sale.connect(buyer1).claim();
    expect(await enc.balanceOf(buyer1.address)).to.equal(
      vested(ENC_PER_UNIT, 2) + vested(2n * ENC_PER_UNIT, 1),
    );

    // Now push past both lots' full vesting.
    await at(boundary(lot2Start, RELEASES));
    expect(await sale.claimableOf(buyer1.address)).to.equal(
      ENC_PER_UNIT + 2n * ENC_PER_UNIT - (vested(ENC_PER_UNIT, 2) + vested(2n * ENC_PER_UNIT, 1)),
    );
    await sale.connect(buyer1).claim();
    expect(await enc.balanceOf(buyer1.address)).to.equal(3n * ENC_PER_UNIT);
  });

  it("an amount that does not divide by 12 still pays out in full, dust included", async () => {
    const { sale, enc, buyer1 } = await loadFixture(fixture);
    // 5 units = 1,000,000 ENC, which divides evenly; use an odd lot via two buys
    // summed into one lot is not possible (separate lots), so assert on a single
    // lot's dust behavior using unit count 1 (200,000 / 12 has a remainder).
    const receipt = await (await sale.connect(buyer1).buy(1)).wait();
    const lotStart = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;
    expect(ENC_PER_UNIT % 12n).to.not.equal(0n); // confirms the dust case is real

    await at(boundary(lotStart, RELEASES));
    await sale.connect(buyer1).claim();
    expect(await enc.balanceOf(buyer1.address)).to.equal(ENC_PER_UNIT);
  });

  it("rounds each tranche half up: 4,000,000 ENC pays …333 or …334 per month, 4,000,000 in total", async () => {
    const { sale, enc, buyer1 } = await loadFixture(fixture);
    const receipt = await (await sale.connect(buyer1).buy(20)).wait(); // 20 × 200,000 = 4,000,000 ENC
    const lotStart = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;

    const LOW = E("333333.333333333333333333");
    const HIGH = E("333333.333333333333333334");
    // Cumulative vested is …333 / …667 / round, so the extra wei lands in months 2, 5, 8, 11.
    const perMonth = [LOW, HIGH, LOW, LOW, HIGH, LOW, LOW, HIGH, LOW, LOW, HIGH, LOW];

    let received = 0n;
    for (let k = 1; k <= RELEASES; k++) {
      await at(boundary(lotStart, k));
      expect(await sale.claimableOf(buyer1.address)).to.equal(perMonth[k - 1]);
      await sale.connect(buyer1).claim();
      received += perMonth[k - 1];
      expect(await enc.balanceOf(buyer1.address)).to.equal(received);
    }

    expect(received).to.equal(E(4_000_000));
    expect(await sale.totalLocked()).to.equal(0n);
  });

  it("leaves a cumulative fraction below one half rounded down and rounds one half or above up", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    const receipt = await (await sale.connect(buyer1).buy(20)).wait();
    const lotStart = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;

    await at(boundary(lotStart, 1));
    expect(await sale.claimableOf(buyer1.address)).to.equal(E("333333.333333333333333333"));

    await at(boundary(lotStart, 2));
    expect(await sale.claimableOf(buyer1.address)).to.equal(E("666666.666666666666666667"));
  });

  it("reverts NothingToClaim when nothing is vested at all", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await expect(sale.connect(buyer1).claim()).to.be.revertedWithCustomError(
      sale,
      "NothingToClaim",
    );
  });

  it("skipping releases pays the whole backlog at once, grid unchanged", async () => {
    const { sale, enc, buyer1 } = await loadFixture(fixture);
    const receipt = await (await sale.connect(buyer1).buy(1)).wait();
    const lotStart = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;

    // Skip straight to release 8 without claiming any of 1-7.
    await at(boundary(lotStart, 8));
    expect(await sale.claimableOf(buyer1.address)).to.equal(vested(ENC_PER_UNIT, 8));
    await sale.connect(buyer1).claim();
    expect(await enc.balanceOf(buyer1.address)).to.equal(vested(ENC_PER_UNIT, 8));
  });
});

describe("EnishiPublicSale — claimableOfLot", () => {
  it("returns each lot's claimable amount independently, indexed like lotsOf", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);

    const r1 = await (await sale.connect(buyer1).buy(1)).wait();
    const lot1Start = (await ethers.provider.getBlock(r1!.blockNumber))!.timestamp;

    await at(lot1Start + INTERVAL);
    const r2 = await (await sale.connect(buyer1).buy(2)).wait();
    const lot2Start = (await ethers.provider.getBlock(r2!.blockNumber))!.timestamp;

    // lot1 is a month ahead of lot2 on the same 12-tranche grid.
    await at(boundary(lot2Start, 1));
    expect(await sale.claimableOfLot(buyer1.address, 0)).to.equal(vested(ENC_PER_UNIT, 2));
    expect(await sale.claimableOfLot(buyer1.address, 1)).to.equal(
      vested(2n * ENC_PER_UNIT, 1),
    );

    // Sum of per-lot amounts matches the aggregate view.
    const sum =
      (await sale.claimableOfLot(buyer1.address, 0)) +
      (await sale.claimableOfLot(buyer1.address, 1));
    expect(await sale.claimableOf(buyer1.address)).to.equal(sum);
  });

  it("reflects partial claims per lot — claiming one lot does not affect another", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);

    await sale.connect(buyer1).buy(1);
    const r2 = await (await sale.connect(buyer1).buy(2)).wait();
    const lot2Start = (await ethers.provider.getBlock(r2!.blockNumber))!.timestamp;

    await at(boundary(lot2Start, RELEASES));
    await sale.connect(buyer1).claim(); // claims everything vested on both lots

    expect(await sale.claimableOfLot(buyer1.address, 0)).to.equal(0n);
    expect(await sale.claimableOfLot(buyer1.address, 1)).to.equal(0n);
  });

  it("returns 0 for a lot still inside its 730-day lock", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(1);
    expect(await sale.claimableOfLot(buyer1.address, 0)).to.equal(0n);
  });

  it("reverts InvalidLotIndex for an out-of-range index", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(1); // buyer1 now has exactly one lot (index 0)

    await expect(sale.claimableOfLot(buyer1.address, 1))
      .to.be.revertedWithCustomError(sale, "InvalidLotIndex")
      .withArgs(1n, 1n);
  });

  it("reverts InvalidLotIndex for a wallet with no lots at all", async () => {
    const { sale, buyer2 } = await loadFixture(fixture);
    await expect(sale.claimableOfLot(buyer2.address, 0))
      .to.be.revertedWithCustomError(sale, "InvalidLotIndex")
      .withArgs(0n, 0n);
  });
});

describe("EnishiPublicSale — claimLot", () => {
  it("pays only the chosen lot and leaves the other lots untouched", async () => {
    const { sale, enc, buyer1 } = await loadFixture(fixture);

    const r1 = await (await sale.connect(buyer1).buy(1)).wait();
    const lot1Start = (await ethers.provider.getBlock(r1!.blockNumber))!.timestamp;
    await sale.connect(buyer1).buy(2);

    // Both lots are fully vested by release 12 of the later lot.
    await at(boundary(lot1Start, RELEASES) + 10 * DAY);
    const lot1Due = await sale.claimableOfLot(buyer1.address, 1);
    const lot0Due = await sale.claimableOfLot(buyer1.address, 0);
    expect(lot1Due).to.be.greaterThan(0n);

    await expect(sale.connect(buyer1).claimLot(1))
      .to.emit(sale, "LotClaimed")
      .withArgs(buyer1.address, 1n, lot1Due)
      .and.to.emit(sale, "Claimed")
      .withArgs(buyer1.address, lot1Due);

    expect(await enc.balanceOf(buyer1.address)).to.equal(lot1Due);
    expect(await sale.claimableOfLot(buyer1.address, 1)).to.equal(0n);
    expect(await sale.claimableOfLot(buyer1.address, 0)).to.equal(lot0Due);
  });

  it("partial claimLot then re-claim only pays the new delta", async () => {
    const { sale, enc, buyer1 } = await loadFixture(fixture);
    const receipt = await (await sale.connect(buyer1).buy(1)).wait();
    const lotStart = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;

    await at(boundary(lotStart, 3));
    await sale.connect(buyer1).claimLot(0);
    expect(await enc.balanceOf(buyer1.address)).to.equal(vested(ENC_PER_UNIT, 3));

    await at(boundary(lotStart, 5));
    await sale.connect(buyer1).claimLot(0);
    expect(await enc.balanceOf(buyer1.address)).to.equal(vested(ENC_PER_UNIT, 5));
  });

  it("claimLot and claim() share the same books — no lot is paid twice", async () => {
    const { sale, enc, buyer1 } = await loadFixture(fixture);
    const receipt = await (await sale.connect(buyer1).buy(1)).wait();
    const lotStart = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;
    await sale.connect(buyer1).buy(1);

    await at(boundary(lotStart, RELEASES) + 30 * DAY);
    await sale.connect(buyer1).claimLot(0);
    await sale.connect(buyer1).claim();

    expect(await enc.balanceOf(buyer1.address)).to.equal(ENC_PER_UNIT * 2n);
    expect(await sale.totalLocked()).to.equal(0n);
    await expect(sale.connect(buyer1).claimLot(0)).to.be.revertedWithCustomError(sale, "NothingToClaim");
  });

  it("reverts NothingToClaim for a lot still inside its 730-day lock", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(1);
    await expect(sale.connect(buyer1).claimLot(0)).to.be.revertedWithCustomError(sale, "NothingToClaim");
  });

  it("reverts InvalidLotIndex for an out-of-range index", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(1);

    await expect(sale.connect(buyer1).claimLot(1))
      .to.be.revertedWithCustomError(sale, "InvalidLotIndex")
      .withArgs(1n, 1n);
  });

  it("reverts InvalidLotIndex when the caller has no lots, even if another wallet does", async () => {
    const { sale, buyer1, buyer2 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(1);

    await expect(sale.connect(buyer2).claimLot(0))
      .to.be.revertedWithCustomError(sale, "InvalidLotIndex")
      .withArgs(0n, 0n);
  });
});
