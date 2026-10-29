import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const E = (n: number | string) => ethers.parseUnits(n.toString(), 18);

const ENC_PER_UNIT = E(200_000);
const MAX_UNITS = 100n;
const DAY = 86_400;
const CLIFF = 730 * DAY;
const INTERVAL = 30 * DAY;
const WINDOW = 1090 * DAY;

async function fixture() {
  const [deployer, treasury, buyer1, buyer2, router, recipient, outsider] =
    await ethers.getSigners();

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
  await sale.setStakeRouter(router.address, recipient.address);

  for (const b of [buyer1, buyer2]) {
    await usdt.mint(b.address, E(10_000_000));
    await usdt.connect(b).approve(saleAddr, ethers.MaxUint256);
  }

  return { deployer, buyer1, buyer2, router, recipient, outsider, enc, usdt, sale };
}

/** Mine a block whose timestamp is exactly `t`. */
async function at(t: number) {
  await time.setNextBlockTimestamp(t);
  await ethers.provider.send("evm_mine", []);
}

/** Buy `units` in a block stamped `t`; return the lot's start. */
async function buyAt(sale: any, buyer: any, units: number, t: number) {
  await time.setNextBlockTimestamp(t);
  await sale.connect(buyer).buy(units);
  return t;
}

/** Buy `units` now; return the lot's start. */
async function buyNow(sale: any, buyer: any, units: number) {
  const receipt = await (await sale.connect(buyer).buy(units)).wait();
  return (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;
}

const boundary = (lotStart: number, k: number) => lotStart + CLIFF + (k - 1) * INTERVAL;

describe("EnishiPublicSale — setStakeRouter", () => {
  async function bareSale() {
    const [deployer, treasury, router, recipient, outsider] = await ethers.getSigners();
    const usdt = await (
      await ethers.getContractFactory("MockERC20")
    ).deploy("Mock USDT", "mUSDT", 18);
    const sale = await (
      await ethers.getContractFactory("EnishiPublicSale")
    ).deploy(await usdt.getAddress(), treasury.address);
    return { deployer, router, recipient, outsider, sale };
  }

  it("sets router and recipient once and emits StakeRouterUpdated", async () => {
    const { sale, router, recipient } = await loadFixture(bareSale);
    await expect(sale.setStakeRouter(router.address, recipient.address))
      .to.emit(sale, "StakeRouterUpdated")
      .withArgs(ethers.ZeroAddress, router.address, recipient.address);
    expect(await sale.stakeRouter()).to.equal(router.address);
    expect(await sale.commissionRecipient()).to.equal(recipient.address);
  });

  it("reverts StakeRouterAlreadySet on a second call", async () => {
    const { sale, router, recipient, outsider } = await loadFixture(bareSale);
    await sale.setStakeRouter(router.address, recipient.address);
    await expect(
      sale.setStakeRouter(outsider.address, outsider.address),
    ).to.be.revertedWithCustomError(sale, "StakeRouterAlreadySet");
  });

  it("reverts ZeroAddress for a zero router or recipient", async () => {
    const { sale, router, recipient } = await loadFixture(bareSale);
    await expect(
      sale.setStakeRouter(ethers.ZeroAddress, recipient.address),
    ).to.be.revertedWithCustomError(sale, "ZeroAddress");
    await expect(
      sale.setStakeRouter(router.address, ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(sale, "ZeroAddress");
  });

  it("reverts for a caller without DEFAULT_ADMIN_ROLE", async () => {
    const { sale, router, recipient, outsider } = await loadFixture(bareSale);
    await expect(
      sale.connect(outsider).setStakeRouter(router.address, recipient.address),
    ).to.be.revertedWithCustomError(sale, "AccessControlUnauthorizedAccount");
  });

  it("collectCommission reverts NotStakeRouter before a router is set", async () => {
    const { sale, router } = await loadFixture(bareSale);
    await expect(
      sale.connect(router).collectCommission(router.address, 1n),
    ).to.be.revertedWithCustomError(sale, "NotStakeRouter")
      .withArgs(router.address);
  });
});

describe("EnishiPublicSale — commissionStatus", () => {
  it("is inactive with zero balance for a wallet with no lots", async () => {
    const { sale, outsider } = await loadFixture(fixture);
    expect(await sale.commissionStatus(outsider.address)).to.deep.equal([false, 0n]);
  });

  it("counts a fresh lot in full", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(2);
    expect(await sale.commissionStatus(buyer1.address)).to.deep.equal([
      true,
      2n * ENC_PER_UNIT,
    ]);
  });

  it("stays active until the last second of the 1090-day window", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    const start = await buyNow(sale, buyer1, 1);

    await at(start + WINDOW - 1);
    expect(await sale.commissionStatus(buyer1.address)).to.deep.equal([true, ENC_PER_UNIT]);

    await at(start + WINDOW);
    expect(await sale.commissionStatus(buyer1.address)).to.deep.equal([false, 0n]);
  });

  it("excludes claimed ENC from the balance", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    const start = await buyNow(sale, buyer1, 6); // 1.2M ENC
    await at(boundary(start, 3));
    await sale.connect(buyer1).claim(); // 300k

    expect(await sale.commissionStatus(buyer1.address)).to.deep.equal([true, E(900_000)]);
  });

  it("ignores expired lots but stays active while a newer lot is inside the window", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    const t0 = await time.latest();
    await buyAt(sale, buyer1, 1, t0 + 10);
    await buyAt(sale, buyer1, 2, t0 + 10 + 100 * DAY);

    await at(t0 + 10 + WINDOW); // first lot just expired
    expect(await sale.commissionStatus(buyer1.address)).to.deep.equal([
      true,
      2n * ENC_PER_UNIT,
    ]);
  });
});

describe("EnishiPublicSale — collectCommission", () => {
  it("spec example: oldest active lot first, expired lot untouched, newest lot shrinks evenly", async () => {
    const { sale, enc, buyer1, router, recipient } = await loadFixture(fixture);
    const t0 = (await time.latest()) + 10;

    // Lot 0 (expired by T), lot 1 (11 tranches claimed by T), lot 2 (in lock).
    await buyAt(sale, buyer1, 6, t0); // 1.2M
    const s1 = await buyAt(sale, buyer1, 6, t0 + 60 * DAY); // 1.2M
    const T = t0 + 1100 * DAY;
    await at(boundary(s1, 11));
    expect(T).to.be.greaterThanOrEqual(boundary(s1, 11));
    await sale.connect(buyer1).claimLot(1); // 1.1M
    const s2 = await buyAt(sale, buyer1, 3, T - DAY); // 600k
    await at(T);

    expect(await sale.commissionStatus(buyer1.address)).to.deep.equal([true, E(700_000)]);

    const lockedBefore = await sale.totalLocked();
    await expect(sale.connect(router).collectCommission(buyer1.address, E(160_000)))
      .to.emit(sale, "LotCommissionDeducted").withArgs(buyer1.address, 1n, E(100_000))
      .and.to.emit(sale, "LotCommissionDeducted").withArgs(buyer1.address, 2n, E(60_000))
      .and.to.emit(sale, "CommissionCollected").withArgs(buyer1.address, recipient.address, E(160_000));

    expect(await enc.balanceOf(recipient.address)).to.equal(E(160_000));
    expect(await sale.totalLocked()).to.equal(lockedBefore - E(160_000));
    expect(await sale.commissionStatus(buyer1.address)).to.deep.equal([true, E(540_000)]);

    const lots = await sale.lotsOf(buyer1.address);
    expect(lots[0].remaining).to.equal(E(1_200_000)); // expired, untouched
    expect(lots[1].remaining).to.equal(0n);
    expect(lots[2].remaining).to.equal(E(540_000));
    expect(lots.map((l: any) => l.deducted)).to.deep.equal([0n, E(100_000), E(60_000)]);

    // Lot 1's 12th tranche is gone; lot 2 pays 45k per tranche instead of 50k.
    await at(boundary(s1, 12));
    expect(await sale.claimableOfLot(buyer1.address, 1)).to.equal(0n);
    await at(boundary(s2, 1));
    expect(await sale.claimableOfLot(buyer1.address, 2)).to.equal(E(45_000));
    await at(boundary(s2, 12));
    expect(await sale.claimableOfLot(buyer1.address, 2)).to.equal(E(540_000));
    // Expired lot 0 still pays in full.
    expect(await sale.claimableOfLot(buyer1.address, 0)).to.equal(E(1_200_000));
  });

  it("shrinks only unclaimed tranches, already-claimed tranches stay paid", async () => {
    const { sale, buyer1, router } = await loadFixture(fixture);
    const start = await buyNow(sale, buyer1, 6); // 1.2M, 100k per tranche
    await at(boundary(start, 3));
    await sale.connect(buyer1).claim(); // 300k

    await sale.connect(router).collectCommission(buyer1.address, E(90_000));

    // 810k left over 9 tranches → 90k each, no stall right after the deduction.
    expect(await sale.claimableOf(buyer1.address)).to.equal(0n);
    for (let k = 4; k <= 12; k++) {
      await at(boundary(start, k));
      expect(await sale.claimableOf(buyer1.address)).to.equal(E(90_000));
      await sale.connect(buyer1).claim();
      // The total deducted stays put while the schedule moves on.
      expect((await sale.lotsOf(buyer1.address))[0].deducted).to.equal(E(90_000));
    }
    const lot = (await sale.lotsOf(buyer1.address))[0];
    expect(lot.claimed).to.equal(lot.amount);
    expect(lot.remaining).to.equal(0n);
    expect(lot.deducted).to.equal(E(90_000));
  });

  it("vested-but-unclaimed ENC shrinks too, since it is still unclaimed", async () => {
    const { sale, buyer1, router } = await loadFixture(fixture);
    const start = await buyNow(sale, buyer1, 6); // 1.2M
    await at(boundary(start, 2));
    expect(await sale.claimableOf(buyer1.address)).to.equal(E(200_000));

    await sale.connect(router).collectCommission(buyer1.address, E(120_000));
    // 1.08M left over the whole schedule → 90k per tranche, 2 vested.
    expect(await sale.claimableOf(buyer1.address)).to.equal(E(180_000));
  });

  it("repeated odd-sized deductions between claims pay out amount − deducted to the wei", async () => {
    const { sale, enc, buyer1, router } = await loadFixture(fixture);
    const start = await buyNow(sale, buyer1, 7);
    const amount = 7n * ENC_PER_UNIT;
    const cuts = [0n, 12_345_678_901_234_567n, E(33_333) + 7n, 7n];

    let deducted = 0n;
    const before = await enc.balanceOf(buyer1.address);
    for (let k = 1; k <= 12; k++) {
      const cut = cuts[k % cuts.length];
      if (cut > 0n) {
        await sale.connect(router).collectCommission(buyer1.address, cut);
        deducted += cut;
      }
      await at(boundary(start, k) + 1);
      await sale.connect(buyer1).claim();
    }
    const claimed = (await enc.balanceOf(buyer1.address)) - before;

    expect(claimed + deducted).to.equal(amount);
    const lot = (await sale.lotsOf(buyer1.address))[0];
    expect(lot.remaining).to.equal(0n);
    expect(await sale.totalLocked()).to.equal(0n);
  });

  it("is all or nothing: reverts InsufficientCommissionBalance and changes nothing", async () => {
    const { sale, buyer1, router } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(1);
    const lockedBefore = await sale.totalLocked();

    await expect(
      sale.connect(router).collectCommission(buyer1.address, ENC_PER_UNIT + 1n),
    ).to.be.revertedWithCustomError(sale, "InsufficientCommissionBalance")
      .withArgs(ENC_PER_UNIT + 1n, ENC_PER_UNIT);

    expect(await sale.totalLocked()).to.equal(lockedBefore);
    expect((await sale.lotsOf(buyer1.address))[0].remaining).to.equal(ENC_PER_UNIT);
  });

  it("reverts with zero available once every lot has expired", async () => {
    const { sale, buyer1, router } = await loadFixture(fixture);
    const start = await buyNow(sale, buyer1, 1);
    await at(start + WINDOW);

    await expect(
      sale.connect(router).collectCommission(buyer1.address, 1n),
    ).to.be.revertedWithCustomError(sale, "InsufficientCommissionBalance")
      .withArgs(1n, 0n);
  });

  it("a fully drained lot stays active with a zero balance", async () => {
    const { sale, buyer1, router } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(1);
    await sale.connect(router).collectCommission(buyer1.address, ENC_PER_UNIT);

    expect(await sale.commissionStatus(buyer1.address)).to.deep.equal([true, 0n]);
  });

  it("skips drained lots when deducting", async () => {
    const { sale, buyer1, router } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(1);
    await sale.connect(buyer1).buy(1);
    await sale.connect(router).collectCommission(buyer1.address, ENC_PER_UNIT);

    await expect(sale.connect(router).collectCommission(buyer1.address, E(1)))
      .to.emit(sale, "LotCommissionDeducted").withArgs(buyer1.address, 1n, E(1));
  });

  it("only touches the charged buyer's lots", async () => {
    const { sale, buyer1, buyer2, router } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(1);
    await sale.connect(buyer2).buy(1);
    await sale.connect(router).collectCommission(buyer1.address, E(1_000));

    expect(await sale.commissionStatus(buyer2.address)).to.deep.equal([true, ENC_PER_UNIT]);
  });

  it("sweepUnsold never takes ENC still owed after a deduction", async () => {
    const { sale, enc, deployer, buyer1, router } = await loadFixture(fixture);
    const start = await buyNow(sale, buyer1, 2);
    await sale.connect(router).collectCommission(buyer1.address, E(50_000));

    await sale.setSaleOpen(false);
    await sale.sweepUnsold(deployer.address);
    expect(await enc.balanceOf(await sale.getAddress())).to.equal(await sale.totalLocked());

    await at(boundary(start, 12));
    await sale.connect(buyer1).claim();
    expect(await enc.balanceOf(buyer1.address)).to.equal(2n * ENC_PER_UNIT - E(50_000));
    expect(await sale.totalLocked()).to.equal(0n);
  });

  it("invariants hold over random buy / claim / collect / warp sequences", async () => {
    const { sale, enc, buyer1, buyer2, router } = await loadFixture(fixture);
    const saleAddr = await sale.getAddress();
    const buyers = [buyer1, buyer2];

    // Deterministic PRNG (mulberry32) so a failure replays exactly.
    let seed = 0x5eed1234;
    const rand = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) % n);
    };

    const bought = new Map<string, bigint>();
    const deducted = new Map<string, bigint>();
    const received = new Map<string, bigint>();
    for (const b of buyers) {
      bought.set(b.address, 0n);
      deducted.set(b.address, 0n);
      received.set(b.address, await enc.balanceOf(b.address));
    }
    let unitsLeft = 100;

    async function checkInvariants() {
      let sumRemaining = 0n;
      for (const b of buyers) {
        let bought = 0n, owed = 0n, taken = 0n;
        for (const lot of await sale.lotsOf(b.address)) {
          sumRemaining += lot.remaining;
          expect(lot.remaining).to.be.lessThanOrEqual(lot.amount - lot.claimed);
          if (lot.claimed === lot.amount) expect(lot.remaining).to.equal(0n);
          bought += lot.amount;
          owed += lot.remaining;
          taken += lot.deducted;
        }
        // Per buyer: bought = paid out + still owed + deducted as commission.
        const paid = (await enc.balanceOf(b.address)) - received.get(b.address)!;
        expect(taken).to.equal(deducted.get(b.address)!);
        expect(bought).to.equal(paid + owed + taken);
      }
      const locked = await sale.totalLocked();
      expect(sumRemaining).to.equal(locked);
      expect(locked).to.be.lessThanOrEqual(await enc.balanceOf(saleAddr));
    }

    for (let step = 0; step < 80; step++) {
      const b = buyers[rand(2)];
      const op = rand(4);
      if (op === 0 && unitsLeft > 0) {
        const units = Math.min(1 + rand(3), unitsLeft);
        await sale.connect(b).buy(units);
        unitsLeft -= units;
        bought.set(b.address, bought.get(b.address)! + BigInt(units) * ENC_PER_UNIT);
      } else if (op === 1) {
        if ((await sale.claimableOf(b.address)) > 0n) await sale.connect(b).claim();
      } else if (op === 2) {
        const [, available] = await sale.commissionStatus(b.address);
        if (available > 0n) {
          // Odd-sized cut, up to the whole balance.
          const cut = (available * BigInt(1 + rand(1000))) / 1000n + (available > 7n ? 7n : 0n);
          const amount = cut > available ? available : cut;
          await sale.connect(router).collectCommission(b.address, amount);
          deducted.set(b.address, deducted.get(b.address)! + amount);
        }
      } else {
        await time.increase(rand(200) * DAY + rand(DAY));
      }
      await checkInvariants();
    }

    // Past every lot's last tranche, each buyer ends with bought − deducted.
    await time.increase(CLIFF + 12 * INTERVAL);
    for (const b of buyers) {
      if ((await sale.claimableOf(b.address)) > 0n) await sale.connect(b).claim();
      const got = (await enc.balanceOf(b.address)) - received.get(b.address)!;
      expect(got).to.equal(bought.get(b.address)! - deducted.get(b.address)!);
    }
    expect(await sale.totalLocked()).to.equal(0n);
    await checkInvariants();
    // Guard against a vacuous run: the sequence must have deducted something.
    expect([...deducted.values()].some((v) => v > 0n)).to.equal(true);
  });

  it("gas: a buyer whose 100 lots all expired costs about one lot read", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    for (let i = 0; i < 100; i++) await sale.connect(buyer1).buy(1);

    const active = await sale.commissionStatus.estimateGas(buyer1.address);
    await time.increase(WINDOW);
    const expired = await sale.commissionStatus.estimateGas(buyer1.address);

    expect(active).to.be.lessThan(400_000n);
    expect(expired).to.be.lessThan(40_000n);
  });

  it("reverts NotStakeRouter for any other caller", async () => {
    const { sale, buyer1, outsider } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(1);
    await expect(
      sale.connect(outsider).collectCommission(buyer1.address, 1n),
    ).to.be.revertedWithCustomError(sale, "NotStakeRouter")
      .withArgs(outsider.address);
  });

  it("reverts ZeroAmount and ZeroAddress", async () => {
    const { sale, buyer1, router } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(1);
    await expect(
      sale.connect(router).collectCommission(buyer1.address, 0n),
    ).to.be.revertedWithCustomError(sale, "ZeroAmount");
    await expect(
      sale.connect(router).collectCommission(ethers.ZeroAddress, 1n),
    ).to.be.revertedWithCustomError(sale, "ZeroAddress");
  });
});
