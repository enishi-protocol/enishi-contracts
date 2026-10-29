import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const E = (n: number | string) => ethers.parseUnits(n.toString(), 18);

const ENC_PER_UNIT = E(200_000);
const MAX_UNITS = 100n;

async function fixture() {
  const [deployer, treasury, buyer1, outsider, mintSink] = await ethers.getSigners();

  const enc = await (await ethers.getContractFactory("ENC")).deploy();
  await enc.waitForDeployment();
  await enc.mintGenesis(deployer.address, mintSink.address);

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

  await usdt.mint(buyer1.address, E(10_000_000));
  await usdt.connect(buyer1).approve(saleAddr, ethers.MaxUint256);

  return { deployer, treasury, buyer1, outsider, enc, usdt, sale };
}

describe("EnishiPublicSale — setSaleOpen", () => {
  it("closing blocks further buy() calls and emits SaleOpenSet(false)", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await expect(sale.setSaleOpen(false)).to.emit(sale, "SaleOpenSet").withArgs(false);
    expect(await sale.saleClosed()).to.equal(true);

    await expect(sale.connect(buyer1).buy(1)).to.be.revertedWithCustomError(
      sale,
      "SaleNotOpen",
    );
  });

  it("reopening after sales only needs the unsold cap backed, not the whole cap", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(10);
    await sale.setSaleOpen(false);

    await expect(sale.setSaleOpen(true)).to.emit(sale, "SaleOpenSet").withArgs(true);
    expect(await sale.remainingUnits()).to.equal(MAX_UNITS - 10n);
  });

  it("reverts InsufficientBacking when reopening after the unsold ENC was swept", async () => {
    const { sale, buyer1, outsider } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(10);
    await sale.setSaleOpen(false);
    await sale.sweepUnsold(outsider.address);

    await expect(sale.setSaleOpen(true))
      .to.be.revertedWithCustomError(sale, "InsufficientBacking")
      .withArgs((MAX_UNITS - 10n) * ENC_PER_UNIT, 0n);
  });

  it("reopens after a sweep once the cap is lowered to what was sold", async () => {
    const { sale, buyer1, outsider } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(10);
    await sale.setSaleOpen(false);
    await sale.sweepUnsold(outsider.address);
    await sale.setSaleParams(await sale.unitPriceUsdt(), ENC_PER_UNIT, 10n * ENC_PER_UNIT);

    await expect(sale.setSaleOpen(true)).to.not.be.reverted;
    expect(await sale.remainingUnits()).to.equal(0n);
  });

  it("reopens after a sweep once the swept ENC is transferred back", async () => {
    const { sale, enc, buyer1, outsider } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(10);
    await sale.setSaleOpen(false);
    await sale.sweepUnsold(outsider.address);

    const shortfall = await sale.backingShortfall(await sale.saleCapEnc());
    expect(shortfall).to.equal((MAX_UNITS - 10n) * ENC_PER_UNIT);
    await enc.connect(outsider).transfer(await sale.getAddress(), shortfall);
    await expect(sale.setSaleOpen(true)).to.not.be.reverted;
  });

  it("reopening resumes buy() and emits SaleOpenSet(true)", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.setSaleOpen(false);

    await expect(sale.setSaleOpen(true)).to.emit(sale, "SaleOpenSet").withArgs(true);
    expect(await sale.saleClosed()).to.equal(false);

    await expect(sale.connect(buyer1).buy(1)).to.not.be.reverted;
  });

  it("reverts SaleStateUnchanged when closing an already-closed sale", async () => {
    const { sale } = await loadFixture(fixture);
    await sale.setSaleOpen(false);
    await expect(sale.setSaleOpen(false))
      .to.be.revertedWithCustomError(sale, "SaleStateUnchanged")
      .withArgs(true);
  });

  it("reverts SaleStateUnchanged when opening an already-open sale", async () => {
    const { sale } = await loadFixture(fixture);
    await expect(sale.setSaleOpen(true))
      .to.be.revertedWithCustomError(sale, "SaleStateUnchanged")
      .withArgs(false);
  });

  it("reopening blocks sweepUnsold() again", async () => {
    const { sale, outsider } = await loadFixture(fixture);
    await sale.setSaleOpen(false);
    await sale.setSaleOpen(true);

    await expect(sale.sweepUnsold(outsider.address)).to.be.revertedWithCustomError(
      sale,
      "SaleNotClosed",
    );
  });

  it("reverts for a caller without OPERATOR_ROLE", async () => {
    const { sale, outsider } = await loadFixture(fixture);
    await expect(
      sale.connect(outsider).setSaleOpen(false),
    ).to.be.revertedWithCustomError(sale, "AccessControlUnauthorizedAccount");
  });
});

describe("EnishiPublicSale — sweepUnsold", () => {
  it("reverts SaleNotClosed while the sale is still open", async () => {
    const { sale, outsider } = await loadFixture(fixture);
    await expect(sale.sweepUnsold(outsider.address)).to.be.revertedWithCustomError(
      sale,
      "SaleNotClosed",
    );
  });

  it("moves exactly the unsold ENC, leaving locked/claimable ENC untouched, once closed", async () => {
    const { sale, enc, buyer1, outsider } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(10); // 10 units sold, 90 remain unsold
    await sale.setSaleOpen(false);

    const saleAddr = await sale.getAddress();
    const balBefore = await enc.balanceOf(saleAddr);

    await expect(sale.sweepUnsold(outsider.address))
      .to.emit(sale, "Swept")
      .withArgs(outsider.address, 90n * ENC_PER_UNIT);

    expect(await enc.balanceOf(outsider.address)).to.equal(90n * ENC_PER_UNIT);
    expect(await enc.balanceOf(saleAddr)).to.equal(balBefore - 90n * ENC_PER_UNIT);
    expect(await enc.balanceOf(saleAddr)).to.equal(10n * ENC_PER_UNIT); // locked, still owed
  });

  it("reverts ZeroAmount when the cap is fully sold (nothing left to sweep)", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(MAX_UNITS);
    await sale.setSaleOpen(false);

    await expect(sale.sweepUnsold(buyer1.address)).to.be.revertedWithCustomError(
      sale,
      "ZeroAmount",
    );
  });

  it("sweeps the real excess balance even when funded beyond saleCapEnc", async () => {
    const { sale, enc, buyer1, outsider } = await loadFixture(fixture);
    // fixture already funded MAX_UNITS * ENC_PER_UNIT (== saleCapEnc); fund more on top.
    await enc.transfer(await sale.getAddress(), E(1_000_000));

    await sale.connect(buyer1).buy(10); // 2,000,000 ENC locked
    await sale.setSaleOpen(false);

    const saleAddr = await sale.getAddress();
    const balBefore = await enc.balanceOf(saleAddr);
    const totalLocked = await sale.totalLocked();

    await expect(sale.sweepUnsold(outsider.address))
      .to.emit(sale, "Swept")
      .withArgs(outsider.address, balBefore - totalLocked);

    expect(await enc.balanceOf(saleAddr)).to.equal(totalLocked);
  });

  it("reverts ZeroAddress for a zero recipient", async () => {
    const { sale } = await loadFixture(fixture);
    await sale.setSaleOpen(false);
    await expect(sale.sweepUnsold(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      sale,
      "ZeroAddress",
    );
  });

  it("reverts for a caller without OPERATOR_ROLE", async () => {
    const { sale, outsider } = await loadFixture(fixture);
    await sale.setSaleOpen(false);
    await expect(
      sale.connect(outsider).sweepUnsold(outsider.address),
    ).to.be.revertedWithCustomError(sale, "AccessControlUnauthorizedAccount");
  });

  it("is callable once closed, even before any unit is sold", async () => {
    const { sale, enc, outsider } = await loadFixture(fixture);
    await sale.setSaleOpen(false);
    await expect(sale.sweepUnsold(outsider.address))
      .to.emit(sale, "Swept")
      .withArgs(outsider.address, MAX_UNITS * ENC_PER_UNIT);
    expect(await enc.balanceOf(outsider.address)).to.equal(MAX_UNITS * ENC_PER_UNIT);
  });
});

describe("EnishiPublicSale — views", () => {
  it("remainingUnits and encSold track purchases correctly", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    expect(await sale.remainingUnits()).to.equal(MAX_UNITS);

    await sale.connect(buyer1).buy(37);
    expect(await sale.encSold()).to.equal(37n * ENC_PER_UNIT);
    expect(await sale.remainingUnits()).to.equal(MAX_UNITS - 37n);
    expect(await sale.remainingEnc()).to.equal((MAX_UNITS - 37n) * ENC_PER_UNIT);
  });

  it("lotsOf returns an empty array for a wallet with no purchases", async () => {
    const { sale, outsider } = await loadFixture(fixture);
    expect(await sale.lotsOf(outsider.address)).to.deep.equal([]);
  });

  it("claimableOf returns 0 for a wallet with no purchases", async () => {
    const { sale, outsider } = await loadFixture(fixture);
    expect(await sale.claimableOf(outsider.address)).to.equal(0n);
  });
});

describe("EnishiPublicSale — ENC backing", () => {
  it("an open sale cannot raise its cap past the ENC held", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(MAX_UNITS);                         // every funded unit sold

    await expect(sale.setSaleParams(E(10_000), ENC_PER_UNIT, (MAX_UNITS + 10n) * ENC_PER_UNIT))
      .to.be.revertedWithCustomError(sale, "InsufficientBacking")
      .withArgs(10n * ENC_PER_UNIT, 0n);
    expect(await sale.saleCapEnc()).to.equal(MAX_UNITS * ENC_PER_UNIT);
  });

  it("topping up with a plain ENC transfer lets an open sale raise its cap by exactly that much", async () => {
    const { sale, enc, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(MAX_UNITS);
    await enc.transfer(await sale.getAddress(), 3n * ENC_PER_UNIT);

    await expect(sale.setSaleParams(E(10_000), ENC_PER_UNIT, (MAX_UNITS + 4n) * ENC_PER_UNIT))
      .to.be.revertedWithCustomError(sale, "InsufficientBacking")
      .withArgs(4n * ENC_PER_UNIT, 3n * ENC_PER_UNIT);
    await sale.setSaleParams(E(10_000), ENC_PER_UNIT, (MAX_UNITS + 3n) * ENC_PER_UNIT);

    expect(await sale.remainingUnits()).to.equal(3n);
    await expect(sale.connect(buyer1).buy(4))
      .to.be.revertedWithCustomError(sale, "SaleCapExceeded")
      .withArgs(4n * ENC_PER_UNIT, 3n * ENC_PER_UNIT);
    await expect(sale.connect(buyer1).buy(3)).to.not.be.reverted;
  });

  it("an open sale can lower its cap regardless of the ENC held", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(10);
    await expect(sale.setSaleParams(E(10_000), ENC_PER_UNIT, 50n * ENC_PER_UNIT)).to.not.be.reverted;
    expect(await sale.remainingUnits()).to.equal(40n);
  });

  it("remainingEnc is the lower of the cap headroom and the ENC held for sale", async () => {
    const [deployer, treasury, , , mintSink] = await ethers.getSigners();
    const enc = await (await ethers.getContractFactory("ENC")).deploy();
    await enc.mintGenesis(deployer.address, mintSink.address);
    const usdt = await (await ethers.getContractFactory("MockERC20")).deploy("U", "U", 18);
    const sale = await (
      await ethers.getContractFactory("EnishiPublicSale")
    ).deploy(await usdt.getAddress(), treasury.address);
    expect(await sale.remainingEnc()).to.equal(0n);                    // no ENC token wired yet

    await sale.grantRole(await sale.OPERATOR_ROLE(), deployer.address);
    await sale.setEncToken(await enc.getAddress());
    await enc.transfer(await sale.getAddress(), ENC_PER_UNIT);         // 1 unit backed, cap = 100 units
    expect(await sale.remainingEnc()).to.equal(ENC_PER_UNIT);
    expect(await sale.remainingUnits()).to.equal(1n);
  });
});

describe("EnishiPublicSale — sweepUnsold bookkeeping", () => {
  it("leaves exactly what the sold lots still owe", async () => {
    const { sale, enc, buyer1, outsider } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(10);
    await sale.setSaleOpen(false);

    const swept = (MAX_UNITS - 10n) * ENC_PER_UNIT;
    await expect(sale.sweepUnsold(outsider.address)).to.emit(sale, "Swept").withArgs(outsider.address, swept);
    expect(await enc.balanceOf(await sale.getAddress())).to.equal(await sale.totalLocked());
    expect(await sale.remainingEnc()).to.equal(0n);
  });

  it("leaves saleCapEnc unchanged and emits no SaleParamsSet", async () => {
    const { sale, buyer1, outsider } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(10);
    await sale.setSaleOpen(false);

    await expect(sale.sweepUnsold(outsider.address)).to.not.emit(sale, "SaleParamsSet");
    expect(await sale.saleCapEnc()).to.equal(MAX_UNITS * ENC_PER_UNIT);
    expect(await sale.encSold()).to.equal(10n * ENC_PER_UNIT);
  });

  it("sweeps everything beyond what sold lots owe, however the ENC arrived", async () => {
    const [deployer, treasury, , outsider, mintSink] = await ethers.getSigners();
    const enc = await (await ethers.getContractFactory("ENC")).deploy();
    await enc.mintGenesis(deployer.address, mintSink.address);
    const usdt = await (await ethers.getContractFactory("MockERC20")).deploy("U", "U", 18);
    const sale = await (
      await ethers.getContractFactory("EnishiPublicSale")
    ).deploy(await usdt.getAddress(), treasury.address);
    await sale.grantRole(await sale.OPERATOR_ROLE(), deployer.address);
    await sale.setEncToken(await enc.getAddress());

    await enc.transfer(await sale.getAddress(), E(5_000_000));        // sale is still closed from construction

    await expect(sale.sweepUnsold(outsider.address))
      .to.emit(sale, "Swept").withArgs(outsider.address, E(5_000_000));
    expect(await enc.balanceOf(await sale.getAddress())).to.equal(0n);
  });
});

describe("EnishiPublicSale — backingShortfall", () => {
  const CAP = MAX_UNITS * ENC_PER_UNIT;

  it("is 0 when the ENC held already backs the cap", async () => {
    const { sale } = await loadFixture(fixture);
    expect(await sale.backingShortfall(CAP)).to.equal(0n);
    expect(await sale.backingShortfall(CAP - ENC_PER_UNIT)).to.equal(0n);
  });

  it("claimed ENC frees no cap room: sold out, part claimed, a 1M raise still needs 1M ENC", async () => {
    const { sale, enc, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(MAX_UNITS);                          // 20M sold
    await time.increase(730 * 24 * 60 * 60);                           // past the lock
    await sale.connect(buyer1).claim();                                // first tranche paid out
    expect(await sale.totalLocked()).to.be.lessThan(CAP);

    const newCap = CAP + E(1_000_000);
    expect(await sale.backingShortfall(newCap)).to.equal(E(1_000_000));

    await enc.transfer(await sale.getAddress(), E(1_000_000));
    expect(await sale.backingShortfall(newCap)).to.equal(0n);
    await expect(sale.setSaleParams(E(10_000), ENC_PER_UNIT, newCap)).to.not.be.reverted;
  });

  it("counts ENC already held beyond what lots owe", async () => {
    const { sale, enc, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(MAX_UNITS);
    await enc.transfer(await sale.getAddress(), 3n * ENC_PER_UNIT);

    expect(await sale.backingShortfall(CAP + 5n * ENC_PER_UNIT)).to.equal(2n * ENC_PER_UNIT);
    expect(await sale.backingShortfall(CAP + 3n * ENC_PER_UNIT)).to.equal(0n);
  });

  it("matches the gap InsufficientBacking reports", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(10);
    const newCap = CAP + 7n * ENC_PER_UNIT;
    const available = (MAX_UNITS - 10n) * ENC_PER_UNIT;
    const capLeft = newCap - 10n * ENC_PER_UNIT;

    expect(await sale.backingShortfall(newCap)).to.equal(capLeft - available);
    await expect(sale.setSaleParams(E(10_000), ENC_PER_UNIT, newCap))
      .to.be.revertedWithCustomError(sale, "InsufficientBacking")
      .withArgs(capLeft, available);
  });

  it("is the whole cap before ENC_TOKEN is set", async () => {
    const [, treasury] = await ethers.getSigners();
    const usdt = await (await ethers.getContractFactory("MockERC20")).deploy("U", "U", 18);
    const sale = await (
      await ethers.getContractFactory("EnishiPublicSale")
    ).deploy(await usdt.getAddress(), treasury.address);
    expect(await sale.backingShortfall(CAP)).to.equal(CAP);
  });

  it("reverts SaleCapBelowSold for a cap under encSold", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(10);
    await expect(sale.backingShortfall(9n * ENC_PER_UNIT))
      .to.be.revertedWithCustomError(sale, "SaleCapBelowSold")
      .withArgs(9n * ENC_PER_UNIT, 10n * ENC_PER_UNIT);
  });
});
