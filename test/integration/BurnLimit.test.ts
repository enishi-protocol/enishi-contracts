import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * The spec sentence, end to end:
 *
 *   "When every token except the Public token is unlocked, burning stops.
 *    In other words 990,000,000 ENC is fixed and circulates on the market.
 *    The 30% burn share is added to the 10% operating expense, so operating
 *    expense becomes 40%."
 *
 * Two contracts have to agree on that single moment: {ENCVesting} decides when
 * the non-Public rounds are fully unlocked, {ENCCommission} decides when to stop
 * burning. They are wired to different quantities — cumulative burn vs. total
 * supply — so this suite pins them to each other rather than testing either alone.
 */
describe("Burn limit — ENCVesting and ENCCommission agree on when burning stops", () => {
  const E = 10n ** 18n;
  const SUPPLY = 3_000_000_000n * E;
  const FLOOR = 990_000_000n * E; // Public allocation — the fixed circulating amount
  const MAX_BURN = 2_010_000_000n * E; // Seed + Private + Team + Treasury

  const CAP = [12_000_000n * E, 28_000_000n * E, 450_000_000n * E, 1_520_000_000n * E];
  const [SEED, PRIVATE, TEAM, TREASURY] = [0, 1, 2, 3];

  async function fixture() {
    const [owner, operator, root, user, master, team, treasury, pub] = await ethers.getSigners();

    // A stand-in ENC whose supply can be driven all the way to the floor. The two
    // contracts under test only ever read totalSupply / burn, so this is faithful.
    const enc = await (await ethers.getContractFactory("ReentrantENC")).deploy();
    await enc.waitForDeployment();
    const encAddr = await enc.getAddress();

    const registry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(
      root.address,
    );
    await registry.waitForDeployment();
    // OPERATOR_ROLE is granted after deploy, never in the constructor.
    await registry.grantRole(await registry.OPERATOR_ROLE(), operator.address);

    const vesting = await (await ethers.getContractFactory("ENCVesting")).deploy(
      SUPPLY, team.address, treasury.address, pub.address, await registry.getAddress(),
    );
    // ENCVesting grants the deployer only DEFAULT_ADMIN_ROLE; the suite operates as deployer.
    await vesting.grantRole(await vesting.OPERATOR_ROLE(), (await ethers.getSigners())[0].address);
    await vesting.waitForDeployment();

    const commission = await (await ethers.getContractFactory("ENCCommission")).deploy(
      encAddr, await registry.getAddress(), master.address,
    );
    await commission.waitForDeployment();
    await commission.setAuthorizedCaller(owner.address, true);
    await registry.connect(operator).registerWithReferrer(user.address, root.address);

    // The whole supply exists and is burnable, so the burn engine can be driven to
    // the floor inside one test — on mainnet the same total is reached over years
    // of recycled commission.
    await enc.mint(owner.address, SUPPLY);

    // The vault holds what it owes, exactly as after ENC's genesis mint, and only
    // then opens. That leaves most of the supply inside it, so the suite drives the
    // burn through the mock's holder-agnostic burn rather than the owner's wallet.
    const owed = await vesting.totalOutstanding();
    await enc.connect(owner).approve(await vesting.getAddress(), owed);
    await vesting.start(encAddr);
    const vault = await vesting.getAddress();
    const burn = (amount: bigint) => enc.burnFromAnyone(vault, amount);

    return { enc, vesting, burn, vault, commission, owner, root, user, master, team, treasury, pub };
  }

  it("both contracts read the same burn progress at every level", async () => {
    const { enc, vesting, commission, owner, burn } = await loadFixture(fixture);

    const SAMPLES = [
      0n,
      1n,
      30_000_000n * E, // SEED cap reached
      56_666_667n * E, // PRIVATE cap reached
      500_000_000n * E,
      940_000_000n * E, // TEAM cap reached
      MAX_BURN - 1n,
      MAX_BURN,
    ];

    let burned = 0n;
    for (const target of SAMPLES) {
      if (target > burned) {
        await burn(target - burned);
        burned = target;
      }
      expect(await vesting.cumulativeBurned(), `burned ${target}`).to.equal(burned);
      // ENCCommission tracks supply, ENCVesting tracks burn — same moment either way.
      expect(await commission.remainingBurnCap(), `cap left at ${target}`)
        .to.equal(MAX_BURN - burned);
      expect(await commission.isBurnFinished(), `finished at ${target}`)
        .to.equal(await vesting.isAllNonPublicUnlocked());
    }
  });

  it("burning stops exactly when the non-Public rounds are fully unlocked", async () => {
    const { enc, vesting, commission, owner, burn } = await loadFixture(fixture);

    await burn(MAX_BURN - 1n);
    expect(await vesting.isAllNonPublicUnlocked()).to.equal(false);
    expect(await commission.isBurnFinished()).to.equal(false);
    expect(await commission.remainingBurnCap()).to.equal(1n);

    await burn(1n);
    expect(await vesting.isAllNonPublicUnlocked()).to.equal(true);
    expect(await commission.isBurnFinished()).to.equal(true);
    expect(await commission.remainingBurnCap()).to.equal(0n);

    // Every non-Public round is at its cap — bar a few wei of ceilDiv rounding on
    // TREASURY, the last group the unlock curve fills.
    expect(await vesting.groupUnlocked(SEED)).to.equal(CAP[SEED]);
    expect(await vesting.groupUnlocked(PRIVATE)).to.equal(CAP[PRIVATE]);
    expect(await vesting.groupUnlocked(TEAM)).to.equal(CAP[TEAM]);
    expect(CAP[TREASURY] - (await vesting.groupUnlocked(TREASURY))).to.be.lessThan(10n);
  });

  it("990,000,000 ENC is exactly what is left, and it stays there", async () => {
    const { enc, commission, owner, user, burn } = await loadFixture(fixture);
    await burn(MAX_BURN);
    expect(await enc.totalSupply()).to.equal(FLOOR);

    // Twenty more settlements, each with a 30% burn share: not one wei leaves.
    for (let i = 0; i < 20; i++) {
      const amount = 1_000n * E;
      await enc.connect(owner).transfer(await commission.getAddress(), amount);
      await commission.distribute(user.address, amount);
      expect(await enc.totalSupply(), `settlement ${i}`).to.equal(FLOOR);
    }
  });

  it("the burn share becomes operating expense: 10% + 30% = 40%", async () => {
    const { enc, commission, owner, user, master, root, burn } = await loadFixture(fixture);
    const amount = 1_000n * E;

    // Before the limit: master gets operating 10% + CSR 20%, and 30% is burned.
    await enc.connect(owner).transfer(await commission.getAddress(), amount);
    const supplyBefore = await enc.totalSupply();
    const masterBefore = await enc.balanceOf(master.address);
    await commission.distribute(user.address, amount);
    expect(await enc.balanceOf(master.address) - masterBefore).to.equal((amount * 3000n) / 10_000n);
    expect(supplyBefore - (await enc.totalSupply())).to.equal((amount * 3000n) / 10_000n);

    // After the limit: the same 30% lands on the master wallet instead.
    await burn(await commission.remainingBurnCap());
    await enc.connect(owner).transfer(await commission.getAddress(), amount);
    const supplyAtFloor = await enc.totalSupply();
    const [m0, r0] = [await enc.balanceOf(master.address), await enc.balanceOf(root.address)];
    await commission.distribute(user.address, amount);

    const toMaster = (await enc.balanceOf(master.address)) - m0;
    const csr = (amount * 2000n) / 10_000n;
    expect(toMaster - csr, "operating share").to.equal((amount * 4000n) / 10_000n);
    expect((await enc.balanceOf(root.address)) - r0, "referral untouched")
      .to.equal((amount * 4000n) / 10_000n);
    expect(await enc.totalSupply(), "nothing burned").to.equal(supplyAtFloor);
  });

  it("ENCLock's force-unlock share is a plain transfer, unaffected by ENCCommission's burn floor", async () => {
    const { enc, commission, owner, user, burn } = await loadFixture(fixture);

    const [, , , , , enishiMasterWallet] = await ethers.getSigners();
    const lock = await (await ethers.getContractFactory("ENCLock")).deploy(
      await enc.getAddress(),
      enishiMasterWallet.address,
    );
    await lock.waitForDeployment();

    // Drive supply to the floor: ENCCommission will not burn another wei.
    await burn(MAX_BURN);
    expect(await enc.totalSupply()).to.equal(FLOOR);
    expect(await commission.isBurnFinished()).to.equal(true);

    // A user force-unlocks: ENCLock has no floor concept of its own — the full 10%
    // share always moves to enishiMasterWallet as a plain transfer, never a burn.
    const staked = 1_000_000n * E;
    await enc.connect(owner).transfer(user.address, staked);
    await enc.connect(user).approve(await lock.getAddress(), staked);
    await lock.connect(user).lock(staked, 720);

    const walletBefore = await enc.balanceOf(enishiMasterWallet.address);
    await expect(lock.connect(user).unlock())
      .to.emit(lock, "Unlocked")
      .withArgs(user.address, staked - staked / 10n, staked / 10n);

    // A transfer, not a burn: totalSupply is untouched, so the floor stays exactly FLOOR.
    expect(await enc.totalSupply()).to.equal(FLOOR);
    expect(await enc.balanceOf(enishiMasterWallet.address) - walletBefore).to.equal(staked / 10n);
    // ENCCommission stays consistent, as before.
    expect(await commission.remainingBurnCap()).to.equal(0n);
    expect(await commission.isBurnFinished()).to.equal(true);
  });
});
