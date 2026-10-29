import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const E = (n: number | string) => ethers.parseUnits(n.toString(), 18);

const ENC_PER_UNIT = E(200_000);
const UNIT_PRICE_USDT = E(10_000);
const SALE_CAP_ENC = E(20_000_000);

async function fixture() {
  const [deployer, treasury, buyer1, operator, outsider] = await ethers.getSigners();

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
  await enc.transfer(saleAddr, SALE_CAP_ENC);
  await sale.setSaleOpen(true);

  await usdt.mint(buyer1.address, E(10_000_000));
  await usdt.connect(buyer1).approve(saleAddr, ethers.MaxUint256);

  return { deployer, treasury, buyer1, operator, outsider, enc, usdt, sale };
}

describe("EnishiPublicSale — OPERATOR_ROLE defaults", () => {
  it("defaults to $0.05/ENC, 200,000 ENC/unit, 20,000,000 ENC cap", async () => {
    const { sale } = await loadFixture(fixture);
    expect(await sale.encPerUnit()).to.equal(ENC_PER_UNIT);
    expect(await sale.unitPriceUsdt()).to.equal(UNIT_PRICE_USDT);
    expect(await sale.saleCapEnc()).to.equal(SALE_CAP_ENC);
  });

  it("grants the deployer DEFAULT_ADMIN_ROLE at construction, not OPERATOR_ROLE", async () => {
    const [deployer, treasury] = await ethers.getSigners();
    const usdt = await (
      await ethers.getContractFactory("MockERC20")
    ).deploy("Mock USDT", "mUSDT", 18);
    const sale = await (
      await ethers.getContractFactory("EnishiPublicSale")
    ).deploy(await usdt.getAddress(), treasury.address);

    const adminRole = await sale.DEFAULT_ADMIN_ROLE();
    const operatorRole = await sale.OPERATOR_ROLE();
    expect(await sale.hasRole(adminRole, deployer.address)).to.equal(true);
    expect(await sale.hasRole(operatorRole, deployer.address)).to.equal(false);
  });

  it("lets a DEFAULT_ADMIN_ROLE holder grant OPERATOR_ROLE afterward", async () => {
    const { sale, deployer } = await loadFixture(fixture);
    const operatorRole = await sale.OPERATOR_ROLE();
    expect(await sale.hasRole(operatorRole, deployer.address)).to.equal(true);
  });
});

describe("EnishiPublicSale — setSaleParams", () => {
  it("changes price, unit size and cap together, applying to future buys only", async () => {
    const { sale, buyer1, usdt, treasury } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(1); // at the old price/size
    expect(await usdt.balanceOf(treasury.address)).to.equal(UNIT_PRICE_USDT);

    await expect(sale.setSaleParams(E(20_000), E(100_000), E(10_000_000)))
      .to.emit(sale, "SaleParamsSet")
      .withArgs(
        UNIT_PRICE_USDT,
        E(20_000),
        ENC_PER_UNIT,
        E(100_000),
        SALE_CAP_ENC,
        E(10_000_000),
      );

    expect(await sale.unitPriceUsdt()).to.equal(E(20_000));
    expect(await sale.encPerUnit()).to.equal(E(100_000));
    expect(await sale.saleCapEnc()).to.equal(E(10_000_000));

    await sale.connect(buyer1).buy(1); // at the new price/size
    expect(await usdt.balanceOf(treasury.address)).to.equal(UNIT_PRICE_USDT + E(20_000));

    const lots = await sale.lotsOf(buyer1.address);
    expect(lots[0].amount).to.equal(ENC_PER_UNIT); // old lot unaffected
    expect(lots[1].amount).to.equal(E(100_000)); // new lot at the new size
  });

  it("reverts ZeroAmount for a zero price or zero unit size", async () => {
    const { sale } = await loadFixture(fixture);
    await expect(
      sale.setSaleParams(0, ENC_PER_UNIT, SALE_CAP_ENC),
    ).to.be.revertedWithCustomError(sale, "ZeroAmount");
    await expect(
      sale.setSaleParams(UNIT_PRICE_USDT, 0, SALE_CAP_ENC),
    ).to.be.revertedWithCustomError(sale, "ZeroAmount");
  });

  it("reverts SaleCapBelowSold when the new cap is below what is already sold", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(10); // 2,000,000 ENC sold

    await expect(sale.setSaleParams(UNIT_PRICE_USDT, ENC_PER_UNIT, E(1_000_000)))
      .to.be.revertedWithCustomError(sale, "SaleCapBelowSold")
      .withArgs(E(1_000_000), E(2_000_000));
  });

  it("allows setting the cap exactly equal to what is already sold", async () => {
    const { sale, buyer1 } = await loadFixture(fixture);
    await sale.connect(buyer1).buy(10); // 2,000,000 ENC sold

    await expect(sale.setSaleParams(UNIT_PRICE_USDT, ENC_PER_UNIT, E(2_000_000))).to.not
      .be.reverted;
    expect(await sale.remainingEnc()).to.equal(0n);
  });

  it("reverts InsufficientBacking when an open sale raises its cap past the ENC held", async () => {
    const { sale } = await loadFixture(fixture);
    // fixture funds exactly SALE_CAP_ENC (20,000,000 ENC).
    await expect(sale.setSaleParams(UNIT_PRICE_USDT, ENC_PER_UNIT, SALE_CAP_ENC + E(5_000_000)))
      .to.be.revertedWithCustomError(sale, "InsufficientBacking")
      .withArgs(SALE_CAP_ENC + E(5_000_000), SALE_CAP_ENC);
  });

  it("an open sale raises its cap once the extra ENC is transferred in", async () => {
    const { sale, enc } = await loadFixture(fixture);
    await enc.transfer(await sale.getAddress(), E(5_000_000));
    await expect(sale.setSaleParams(UNIT_PRICE_USDT, ENC_PER_UNIT, SALE_CAP_ENC + E(5_000_000)))
      .to.not.be.reverted;
    expect(await sale.remainingEnc()).to.equal(SALE_CAP_ENC + E(5_000_000));
  });

  it("a closed sale raises its cap freely; reopening needs the shortfall funded", async () => {
    const { sale, enc } = await loadFixture(fixture);
    await sale.setSaleOpen(false);
    await expect(sale.setSaleParams(UNIT_PRICE_USDT, ENC_PER_UNIT, SALE_CAP_ENC + E(5_000_000)))
      .to.not.be.reverted;

    await expect(sale.setSaleOpen(true))
      .to.be.revertedWithCustomError(sale, "InsufficientBacking")
      .withArgs(SALE_CAP_ENC + E(5_000_000), SALE_CAP_ENC);
    await enc.transfer(await sale.getAddress(), E(5_000_000));
    await expect(sale.setSaleOpen(true)).to.not.be.reverted;
  });

  it("allows raising the cap freely before fund() has been called", async () => {
    const [deployer, treasury] = await ethers.getSigners();
    const usdt = await (
      await ethers.getContractFactory("MockERC20")
    ).deploy("Mock USDT", "mUSDT", 18);
    const unfundedSale = await (
      await ethers.getContractFactory("EnishiPublicSale")
    ).deploy(await usdt.getAddress(), treasury.address);
    await unfundedSale.grantRole(await unfundedSale.OPERATOR_ROLE(), deployer.address);

    await expect(
      unfundedSale.setSaleParams(UNIT_PRICE_USDT, ENC_PER_UNIT, E(50_000_000)),
    ).to.not.be.reverted;
    expect(await unfundedSale.saleCapEnc()).to.equal(E(50_000_000));
  });

  it("reverts for a caller without OPERATOR_ROLE", async () => {
    const { sale, outsider } = await loadFixture(fixture);
    await expect(
      sale.connect(outsider).setSaleParams(E(1), E(1), E(1_000_000)),
    ).to.be.revertedWithCustomError(sale, "AccessControlUnauthorizedAccount");
  });

  it("a newly granted OPERATOR_ROLE holder can call it", async () => {
    const { sale, operator } = await loadFixture(fixture);
    const operatorRole = await sale.OPERATOR_ROLE();
    await sale.grantRole(operatorRole, operator.address);

    await expect(
      sale.connect(operator).setSaleParams(E(5_000), ENC_PER_UNIT, SALE_CAP_ENC),
    ).to.not.be.reverted;
    expect(await sale.unitPriceUsdt()).to.equal(E(5_000));
  });
});
