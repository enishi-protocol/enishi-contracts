import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const E = (n: number | string) => ethers.parseUnits(n.toString(), 18);

const ENC_PER_UNIT = E(200_000);
const DAY = 86_400;
const WINDOW = 1090 * DAY;
const PS_BPS = 1000n;
const DEFAULT_BPS = 2500n;

async function fixture() {
  const [deployer, treasury, master, user, vault, commission, outsider] =
    await ethers.getSigners();

  const enc = await (await ethers.getContractFactory("ENC")).deploy();
  await enc.mintGenesis(deployer.address, outsider.address);

  const usdt = await (
    await ethers.getContractFactory("MockERC20")
  ).deploy("Mock USDT", "mUSDT", 18);

  const sale = await (
    await ethers.getContractFactory("EnishiPublicSale")
  ).deploy(await usdt.getAddress(), treasury.address);
  const saleAddr = await sale.getAddress();
  await sale.grantRole(await sale.OPERATOR_ROLE(), deployer.address);
  await sale.setEncToken(await enc.getAddress());
  await enc.transfer(saleAddr, 100n * ENC_PER_UNIT);
  await sale.setSaleOpen(true);

  const lock = await (
    await ethers.getContractFactory("ENCLock")
  ).deploy(await enc.getAddress(), master.address);
  const lockAddr = await lock.getAddress();

  const router = await (
    await ethers.getContractFactory("ENCStakeRouter")
  ).deploy(lockAddr, saleAddr, commission.address);
  const routerAddr = await router.getAddress();

  await router.setVault(vault.address);
  await lock.setVault(routerAddr);
  await sale.setStakeRouter(routerAddr, commission.address);

  await usdt.mint(user.address, E(10_000_000));
  await usdt.connect(user).approve(saleAddr, ethers.MaxUint256);
  await enc.transfer(user.address, E(1_000_000));
  await enc.connect(user).approve(lockAddr, ethers.MaxUint256);

  return { deployer, user, vault, commission, outsider, enc, sale, lock, router, lockAddr, saleAddr };
}

describe("ENCStakeRouter — constructor and admin", () => {
  it("stores the lock, sale and commission recipient", async () => {
    const { router, lockAddr, saleAddr, commission } = await loadFixture(fixture);
    expect(await router.ENC_LOCK()).to.equal(lockAddr);
    expect(await router.PUBLIC_SALE()).to.equal(saleAddr);
    expect(await router.ENC_COMMISSION()).to.equal(commission.address);
  });

  it("reverts ZeroAddress for any zero argument", async () => {
    const { lockAddr, saleAddr, commission } = await loadFixture(fixture);
    const F = await ethers.getContractFactory("ENCStakeRouter");
    const Z = ethers.ZeroAddress;
    await expect(F.deploy(Z, saleAddr, commission.address)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(lockAddr, Z, commission.address)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(lockAddr, saleAddr, Z)).to.be.revertedWithCustomError(F, "ZeroAddress");
  });

  it("reverts NotContract when the Public Sale has no code", async () => {
    const { lockAddr, commission, outsider } = await loadFixture(fixture);
    const F = await ethers.getContractFactory("ENCStakeRouter");
    await expect(F.deploy(lockAddr, outsider.address, commission.address))
      .to.be.revertedWithCustomError(F, "NotContract")
      .withArgs(outsider.address);
  });

  it("setVault emits old and new", async () => {
    const { router, vault, outsider } = await loadFixture(fixture);
    await expect(router.setVault(outsider.address))
      .to.emit(router, "VaultUpdated")
      .withArgs(vault.address, outsider.address);
    expect(await router.vault()).to.equal(outsider.address);
  });

  it("setVault reverts for a non-owner and for zero", async () => {
    const { router, outsider } = await loadFixture(fixture);
    await expect(router.connect(outsider).setVault(outsider.address))
      .to.be.revertedWithCustomError(router, "OwnableUnauthorizedAccount");
    await expect(router.setVault(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(router, "ZeroAddress");
  });
});

// Charging helpers: the router never quotes; tests stand in for the Vault's
// 1:1 DEX quote, so quotedEnc == quotedStable.
const NET = E(8_000); // net profit; 10% = 800, 21% = 1_680
async function charge(router: any, vault: any, user: any, net = NET) {
  const quoted = await router.commissionQuote(user.address, net);
  return router.connect(vault).chargeCommission(user.address, net, quoted, quoted);
}

describe("ENCStakeRouter — stakes", () => {
  it("no lot and no lock: default rate and zero for both, nothing to quote", async () => {
    const { router, user } = await loadFixture(fixture);
    expect(await router.publicSaleStake(user.address)).to.deep.equal([DEFAULT_BPS, 0n]);
    expect(await router.lockStake(user.address)).to.deep.equal([DEFAULT_BPS, 0n]);
    expect(await router.commissionQuote(user.address, NET)).to.equal(0n);
  });

  it("reports an active lot and a lock side by side", async () => {
    const { router, sale, lock, user } = await loadFixture(fixture);
    await lock.connect(user).lock(E(500_000), 30); // 21% plan
    await sale.connect(user).buy(1);

    expect(await router.publicSaleStake(user.address)).to.deep.equal([PS_BPS, ENC_PER_UNIT]);
    expect(await router.lockStake(user.address)).to.deep.equal([2100n, E(500_000)]);
  });

  it("an expired lot reports no Public Sale stake", async () => {
    const { router, sale, user } = await loadFixture(fixture);
    await sale.connect(user).buy(1);
    await time.increase(WINDOW);
    expect(await router.publicSaleStake(user.address)).to.deep.equal([DEFAULT_BPS, 0n]);
  });

  it("an expired lock reports no lock stake even though ENC is still locked", async () => {
    const { router, lock, user } = await loadFixture(fixture);
    await lock.connect(user).lock(E(1_000), 30);
    await time.increase(30 * DAY);
    expect(await router.lockStake(user.address)).to.deep.equal([DEFAULT_BPS, 0n]);
  });
});

describe("ENCStakeRouter — commissionQuote", () => {
  it("quotes at the Public Sale rate when only a lot can pay", async () => {
    const { router, sale, user } = await loadFixture(fixture);
    await sale.connect(user).buy(1);
    expect(await router.commissionQuote(user.address, NET)).to.equal(E(800));
  });

  it("quotes at the higher rate when a lot and a lock can both pay", async () => {
    const { router, sale, lock, user } = await loadFixture(fixture);
    await sale.connect(user).buy(1);
    await lock.connect(user).lock(E(500_000), 30); // 21%
    expect(await router.commissionQuote(user.address, NET)).to.equal(E(1_680));
  });

  it("ignores a drained lot: quotes at the lock rate only", async () => {
    const { router, sale, lock, user, vault } = await loadFixture(fixture);
    await sale.connect(user).buy(1);
    await sale.connect(user).buy(1);
    await lock.connect(user).lock(E(500_000), 360); // 15%
    // Drain both lots through the lock-free path: charge the whole balance.
    const big = (2n * ENC_PER_UNIT * 10_000n) / PS_BPS; // net whose 10% == both lots
    await charge(router, vault, user, big);
    expect((await router.publicSaleStake(user.address))[1]).to.equal(0n);

    expect(await router.commissionQuote(user.address, NET)).to.equal(E(1_200));
  });
});

describe("ENCStakeRouter — chargeCommission", () => {
  it("charges the lot at 10%, scaled down from a quote taken at the lock's 21%", async () => {
    const { router, sale, lock, enc, user, vault, commission } = await loadFixture(fixture);
    await sale.connect(user).buy(1);
    await lock.connect(user).lock(E(500_000), 30);

    await expect(charge(router, vault, user))
      .to.emit(router, "CommissionRouted").withArgs(user.address, true, E(800))
      .and.to.emit(sale, "CommissionCollected").withArgs(user.address, commission.address, E(800));

    expect(await enc.balanceOf(commission.address)).to.equal(E(800));
    expect((await lock.lockOf(user.address)).amount).to.equal(E(500_000));
  });

  it("falls to the lock when the lot cannot cover the commission", async () => {
    const { router, sale, lock, enc, user, vault, commission } = await loadFixture(fixture);
    await sale.connect(user).buy(1); // 200,000 ENC
    await lock.connect(user).lock(E(500_000), 30);
    const net = E(3_000_000); // 10% = 300,000 > lot; 21% = 630,000 > lock

    // Lock too small at 21% as well → nothing charged.
    await charge(router, vault, user, net);
    expect(await enc.balanceOf(commission.address)).to.equal(0n);

    // A net the lot cannot cover but the lock can.
    const net2 = E(2_100_000); // 10% = 210,000 > lot; 21% = 441,000 ≤ lock
    await expect(charge(router, vault, user, net2))
      .to.emit(router, "CommissionRouted").withArgs(user.address, false, E(441_000));
    expect((await lock.lockOf(user.address)).amount).to.equal(E(59_000));
    expect((await sale.lotsOf(user.address))[0].remaining).to.equal(ENC_PER_UNIT);
  });

  it("charges nothing when quotedStable does not match the router's own quote", async () => {
    const { router, sale, enc, user, vault, commission } = await loadFixture(fixture);
    await sale.connect(user).buy(1);
    await router.connect(vault).chargeCommission(user.address, NET, E(799), E(799));
    expect(await enc.balanceOf(commission.address)).to.equal(0n);
  });

  it("charges nothing for a zero quote", async () => {
    const { router, sale, enc, user, vault, commission } = await loadFixture(fixture);
    await sale.connect(user).buy(1);
    await router.connect(vault).chargeCommission(user.address, NET, E(800), 0n);
    await router.connect(vault).chargeCommission(user.address, NET, 0n, 0n);
    expect(await enc.balanceOf(commission.address)).to.equal(0n);
  });

  it("reverts NotVault for any other caller", async () => {
    const { router, user, outsider } = await loadFixture(fixture);
    await expect(router.connect(outsider).chargeCommission(user.address, NET, 1n, 1n))
      .to.be.revertedWithCustomError(router, "NotVault")
      .withArgs(outsider.address);
  });
});

describe("ENCStakeRouter — sale binding", () => {
  it("a sale bound to another router reads as no Public Sale stake", async () => {
    const { sale, user, commission, lockAddr, saleAddr } = await loadFixture(fixture);
    const unbound = await (
      await ethers.getContractFactory("ENCStakeRouter")
    ).deploy(lockAddr, saleAddr, commission.address); // sale is bound to the fixture router
    await sale.connect(user).buy(1);

    expect(await unbound.publicSaleStake(user.address)).to.deep.equal([DEFAULT_BPS, 0n]);
    expect(await unbound.commissionQuote(user.address, NET)).to.equal(0n);
  });

  it("a sale paying a different recipient reads as no Public Sale stake", async () => {
    const { deployer, enc, user, outsider, commission, lockAddr } = await loadFixture(fixture);
    const usdt = await (await ethers.getContractFactory("MockERC20")).deploy("U", "U", 18);
    const sale = await (
      await ethers.getContractFactory("EnishiPublicSale")
    ).deploy(await usdt.getAddress(), deployer.address);
    await sale.grantRole(await sale.OPERATOR_ROLE(), deployer.address);
    await sale.setEncToken(await enc.getAddress());
    await enc.transfer(await sale.getAddress(), 100n * ENC_PER_UNIT);
    await sale.setSaleOpen(true);
    const router = await (
      await ethers.getContractFactory("ENCStakeRouter")
    ).deploy(lockAddr, await sale.getAddress(), commission.address);
    await sale.setStakeRouter(await router.getAddress(), outsider.address); // wrong recipient

    await usdt.mint(user.address, E(10_000));
    await usdt.connect(user).approve(await sale.getAddress(), ethers.MaxUint256);
    await sale.connect(user).buy(1);

    expect(await router.publicSaleStake(user.address)).to.deep.equal([DEFAULT_BPS, 0n]);
  });
});

describe("ENCStakeRouter — failing Public Sale", () => {
  async function brokenSaleFixture() {
    const ctx = await loadFixture(fixture);
    const broken = await (
      await ethers.getContractFactory("MockRevertingPublicSale")
    ).deploy(ctx.commission.address);
    const router = await (
      await ethers.getContractFactory("ENCStakeRouter")
    ).deploy(ctx.lockAddr, await broken.getAddress(), ctx.commission.address);
    await router.setVault(ctx.vault.address);
    await ctx.lock.setVault(await router.getAddress());
    return { ...ctx, router };
  }

  it("reads as no Public Sale stake and charges the lock instead", async () => {
    const { router, lock, enc, user, vault, commission } = await loadFixture(brokenSaleFixture);
    await lock.connect(user).lock(E(500_000), 360);

    expect(await router.publicSaleStake(user.address)).to.deep.equal([DEFAULT_BPS, 0n]);
    expect(await router.commissionQuote(user.address, NET)).to.equal(E(1_200));
    await charge(router, vault, user);
    expect(await enc.balanceOf(commission.address)).to.equal(E(1_200));
  });
});
