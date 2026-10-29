import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const E = (n: number | string) => ethers.parseUnits(n.toString(), 18);

const ENC_PER_UNIT = E(200_000);
const UNIT_PRICE_USDT = E(10_000);
const MAX_UNITS = 100n;

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

  // Buyers get plenty of USDT and approve the sale up front.
  for (const b of [buyer1, buyer2, outsider]) {
    await usdt.mint(b.address, E(1_000_000));
    await usdt.connect(b).approve(saleAddr, ethers.MaxUint256);
  }

  return { deployer, treasury, buyer1, buyer2, outsider, enc, usdt, sale };
}

async function fundedFixture() {
  const ctx = await fixture();
  await ctx.enc.transfer(await ctx.sale.getAddress(), MAX_UNITS * ENC_PER_UNIT);
  await ctx.sale.setSaleOpen(true);
  return ctx;
}

describe("EnishiPublicSale — funding and opening", () => {
  it("a plain ENC transfer is all the funding there is — no deposit call", async () => {
    const { sale, enc } = await loadFixture(fixture);
    const saleAddr = await sale.getAddress();
    await enc.transfer(saleAddr, MAX_UNITS * ENC_PER_UNIT);

    expect(await enc.balanceOf(saleAddr)).to.equal(MAX_UNITS * ENC_PER_UNIT);
    expect(await sale.remainingEnc()).to.equal(MAX_UNITS * ENC_PER_UNIT);
  });

  it("nothing sells until the operator opens the sale, even once the ENC is in", async () => {
    const { sale, enc, buyer1 } = await loadFixture(fixture);
    await enc.transfer(await sale.getAddress(), MAX_UNITS * ENC_PER_UNIT);

    await expect(sale.connect(buyer1).buy(1)).to.be.revertedWithCustomError(sale, "SaleNotOpen");
    await expect(sale.setSaleOpen(true)).to.emit(sale, "SaleOpenSet").withArgs(true);
    await expect(sale.connect(buyer1).buy(1)).to.not.be.reverted;
  });

  it("reverts InsufficientBacking when opening before the whole cap is funded", async () => {
    const { sale, enc } = await loadFixture(fixture);
    const cap = MAX_UNITS * ENC_PER_UNIT;
    await expect(sale.setSaleOpen(true))
      .to.be.revertedWithCustomError(sale, "InsufficientBacking")
      .withArgs(cap, 0n);

    await enc.transfer(await sale.getAddress(), cap - 1n);
    await expect(sale.setSaleOpen(true))
      .to.be.revertedWithCustomError(sale, "InsufficientBacking")
      .withArgs(cap, cap - 1n);

    await enc.transfer(await sale.getAddress(), 1n);
    await expect(sale.setSaleOpen(true)).to.emit(sale, "SaleOpenSet").withArgs(true);
  });

  it("opens with ENC beyond the cap — a stray transfer never blocks opening", async () => {
    const { sale, enc } = await loadFixture(fixture);
    await enc.transfer(await sale.getAddress(), (MAX_UNITS + 1n) * ENC_PER_UNIT);
    await expect(sale.setSaleOpen(true)).to.not.be.reverted;
    expect(await sale.remainingUnits()).to.equal(MAX_UNITS);
  });

  it("a partly funded sale opens once the cap is lowered to match", async () => {
    const { sale, enc, buyer1 } = await loadFixture(fixture);
    await enc.transfer(await sale.getAddress(), 5n * ENC_PER_UNIT);
    await sale.setSaleParams(UNIT_PRICE_USDT, ENC_PER_UNIT, 5n * ENC_PER_UNIT);

    await expect(sale.setSaleOpen(true)).to.not.be.reverted;
    await expect(sale.connect(buyer1).buy(5)).to.not.be.reverted;
  });
});

describe("EnishiPublicSale — constructor", () => {
  it("rejects a zero address for usdt or treasury", async () => {
    const [, treasury] = await ethers.getSigners();
    const usdt = await (
      await ethers.getContractFactory("MockERC20")
    ).deploy("Mock USDT", "mUSDT", 18);
    const F = await ethers.getContractFactory("EnishiPublicSale");
    const Z = ethers.ZeroAddress;

    await expect(F.deploy(Z, treasury.address))
      .to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(await usdt.getAddress(), Z))
      .to.be.revertedWithCustomError(F, "ZeroAddress");
  });

  it("starts with ENC_TOKEN unset", async () => {
    const [, treasury] = await ethers.getSigners();
    const usdt = await (
      await ethers.getContractFactory("MockERC20")
    ).deploy("Mock USDT", "mUSDT", 18);
    const sale = await (
      await ethers.getContractFactory("EnishiPublicSale")
    ).deploy(await usdt.getAddress(), treasury.address);

    expect(await sale.ENC_TOKEN()).to.equal(ethers.ZeroAddress);
    expect(await sale.saleClosed()).to.equal(true);
  });
});

describe("EnishiPublicSale — setEncToken", () => {
  async function unfundedFixture() {
    const [deployer, treasury] = await ethers.getSigners();
    const enc = await (await ethers.getContractFactory("ENC")).deploy();
    const usdt = await (
      await ethers.getContractFactory("MockERC20")
    ).deploy("Mock USDT", "mUSDT", 18);
    const sale = await (
      await ethers.getContractFactory("EnishiPublicSale")
    ).deploy(await usdt.getAddress(), treasury.address);
    await sale.grantRole(await sale.OPERATOR_ROLE(), deployer.address);
    return { deployer, treasury, enc, usdt, sale };
  }

  it("sets ENC_TOKEN exactly once", async () => {
    const { sale, enc } = await loadFixture(unfundedFixture);
    await sale.setEncToken(await enc.getAddress());
    expect(await sale.ENC_TOKEN()).to.equal(await enc.getAddress());
  });

  it("reverts EncTokenAlreadySet on a second call", async () => {
    const { sale, enc } = await loadFixture(unfundedFixture);
    await sale.setEncToken(await enc.getAddress());
    await expect(
      sale.setEncToken(await enc.getAddress()),
    ).to.be.revertedWithCustomError(sale, "EncTokenAlreadySet");
  });

  it("reverts ZeroAddress for the zero address", async () => {
    const { sale } = await loadFixture(unfundedFixture);
    await expect(
      sale.setEncToken(ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(sale, "ZeroAddress");
  });

  it("reverts for a caller without DEFAULT_ADMIN_ROLE", async () => {
    const { sale, enc } = await loadFixture(unfundedFixture);
    const [, , outsider] = await ethers.getSigners();
    await expect(
      sale.connect(outsider).setEncToken(await enc.getAddress()),
    ).to.be.revertedWithCustomError(sale, "AccessControlUnauthorizedAccount");
  });

  it("reverts EncTokenNotSet when opening the sale before setEncToken", async () => {
    const { sale } = await loadFixture(unfundedFixture);
    await expect(sale.setSaleOpen(true)).to.be.revertedWithCustomError(sale, "EncTokenNotSet");
  });
});

describe("EnishiPublicSale — buy", () => {
  it("happy path: pulls USDT to treasury, records a lot, emits Purchased", async () => {
    const { sale, treasury, buyer1, usdt } = await loadFixture(fundedFixture);

    const receipt = await (await sale.connect(buyer1).buy(1)).wait();
    const blockTimestamp = (await ethers.provider.getBlock(receipt!.blockNumber))!
      .timestamp;

    const events = await sale.queryFilter(sale.filters.Purchased(), receipt!.blockNumber);
    expect(events.length).to.equal(1);
    expect(events[0].args.buyer).to.equal(buyer1.address);
    expect(events[0].args.units).to.equal(1n);
    expect(events[0].args.amount).to.equal(ENC_PER_UNIT);
    expect(events[0].args.usdtPaid).to.equal(UNIT_PRICE_USDT);
    expect(events[0].args.start).to.equal(blockTimestamp);
    expect(events[0].args.lotIndex).to.equal(0n);

    expect(await usdt.balanceOf(treasury.address)).to.equal(UNIT_PRICE_USDT);
    expect(await sale.encSold()).to.equal(ENC_PER_UNIT);

    const lots = await sale.lotsOf(buyer1.address);
    expect(lots.length).to.equal(1);
    expect(lots[0].amount).to.equal(ENC_PER_UNIT);
    expect(lots[0].claimed).to.equal(0n);
    expect(lots[0].start).to.equal(blockTimestamp);
  });

  it("reverts ZeroAmount on buy(0)", async () => {
    const { sale, buyer1 } = await loadFixture(fundedFixture);
    await expect(sale.connect(buyer1).buy(0)).to.be.revertedWithCustomError(
      sale,
      "ZeroAmount",
    );
  });

  it("reverts SaleCapExceeded when units exceed the remaining cap", async () => {
    const { sale, buyer1 } = await loadFixture(fundedFixture);
    await expect(sale.connect(buyer1).buy(MAX_UNITS + 1n))
      .to.be.revertedWithCustomError(sale, "SaleCapExceeded")
      .withArgs((MAX_UNITS + 1n) * ENC_PER_UNIT, MAX_UNITS * ENC_PER_UNIT);
  });

  it("reverts SaleNotOpen while the sale is still closed from construction", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await expect(sale.connect(buyer1).buy(1)).to.be.revertedWithCustomError(
      sale,
      "SaleNotOpen",
    );
  });

  it("allows multiple buys from the same wallet, each an independent lot", async () => {
    const { sale, buyer1 } = await loadFixture(fundedFixture);

    const r1 = await (await sale.connect(buyer1).buy(1)).wait();
    const r2 = await (await sale.connect(buyer1).buy(2)).wait();

    const e1 = await sale.queryFilter(sale.filters.Purchased(), r1!.blockNumber, r1!.blockNumber);
    const e2 = await sale.queryFilter(sale.filters.Purchased(), r2!.blockNumber, r2!.blockNumber);
    expect(e1[0].args.lotIndex).to.equal(0n);
    expect(e2[0].args.lotIndex).to.equal(1n);

    const lots = await sale.lotsOf(buyer1.address);
    expect(lots.length).to.equal(2);
    expect(lots[0].amount).to.equal(ENC_PER_UNIT);
    expect(lots[1].amount).to.equal(2n * ENC_PER_UNIT);
    expect(await sale.encSold()).to.equal(3n * ENC_PER_UNIT);
  });

  it("allows selling exactly up to the cap across multiple buyers", async () => {
    const { sale, buyer1, buyer2 } = await loadFixture(fundedFixture);

    await sale.connect(buyer1).buy(60);
    await sale.connect(buyer2).buy(40);

    expect(await sale.encSold()).to.equal(MAX_UNITS * ENC_PER_UNIT);
    expect(await sale.remainingUnits()).to.equal(0n);

    await expect(sale.connect(buyer1).buy(1))
      .to.be.revertedWithCustomError(sale, "SaleCapExceeded")
      .withArgs(ENC_PER_UNIT, 0n);
  });
});
