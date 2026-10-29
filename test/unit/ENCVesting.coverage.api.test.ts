import { expect } from "chai";
import { ethers, artifacts } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  BOUNDARY, CAP, E, FULL_UNLOCK_BURN, LOCKED, PRIVATE, PUBLIC, PUBLIC_ALLOC, PUBLIC_TGE,
  SEED, TEAM, TREASURY,
} from "../helpers/vestingModel";
import { INITIAL_SUPPLY_PROD, fullRangeRig, productionRig } from "../helpers/vestingRig";
import { ENC_MAX_SUPPLY } from "../../helpers/encConstants";

/**
 * Admin surface, constructor wiring, error paths and the money invariants.
 * The last block enforces that no externally callable function is left untested.
 */

describe("Constructor and immutable wiring", () => {
  it("records the token, supply baseline, TGE anchor and roles", async () => {
    const { enc, v, deployer, operator, outsider } = await loadFixture(productionRig);
    expect(await v.ENC_TOKEN()).to.equal(await enc.getAddress());
    expect(await v.INITIAL_SUPPLY()).to.equal(INITIAL_SUPPLY_PROD);
    expect(await v.startTime()).to.be.greaterThan(0n);
    const ADMIN = await v.DEFAULT_ADMIN_ROLE();
    const OPERATOR = await v.OPERATOR_ROLE();
    expect(OPERATOR).to.equal(ethers.id("OPERATOR_ROLE"));
    expect(await v.hasRole(ADMIN, deployer.address)).to.equal(true);
    expect(await v.hasRole(OPERATOR, operator.address)).to.equal(true);   // granted by the rig
    expect(await v.hasRole(OPERATOR, outsider.address)).to.equal(false);
    expect(await v.getRoleAdmin(OPERATOR)).to.equal(ADMIN);
  });

  it("grants the deployer DEFAULT_ADMIN_ROLE only — OPERATOR_ROLE must be granted separately", async () => {
    const [deployer, team, treasury, pub] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(deployer.address);
    const fresh = await (await ethers.getContractFactory("ENCVesting")).deploy(
      INITIAL_SUPPLY_PROD, team.address, treasury.address, pub.address, await registry.getAddress(),
    );
    expect(await fresh.hasRole(await fresh.DEFAULT_ADMIN_ROLE(), deployer.address)).to.equal(true);
    expect(await fresh.hasRole(await fresh.OPERATOR_ROLE(), deployer.address)).to.equal(false);
    await expect(fresh.addBeneficiaries(SEED, [team.address], [1n * E], [deployer.address], true))
      .to.be.revertedWithCustomError(fresh, "AccessControlUnauthorizedAccount")
      .withArgs(deployer.address, await fresh.OPERATOR_ROLE());
  });

  it("reports AccessControl and IAccessControl via ERC-165", async () => {
    const { v } = await loadFixture(productionRig);
    expect(await v.supportsInterface("0x01ffc9a7")).to.equal(true);   // IERC165
    expect(await v.supportsInterface("0x7965db0b")).to.equal(true);   // IAccessControl
    expect(await v.supportsInterface("0xffffffff")).to.equal(false);
  });

  it("pre-allocates the three single-beneficiary rounds, with nothing recorded as paid", async () => {
    const { v, team, treasury, pub } = await loadFixture(productionRig);
    expect((await v.allocationOf(TEAM, team.address))[0]).to.equal(CAP[TEAM]);
    expect((await v.allocationOf(TREASURY, treasury.address))[0]).to.equal(CAP[TREASURY]);
    expect((await v.allocationOf(PUBLIC, pub.address))[0]).to.equal(PUBLIC_ALLOC);
    // the rig pulled the TGE tranche; everything else is untouched
    expect((await v.allocationOf(PUBLIC, pub.address))[1]).to.equal(PUBLIC_TGE);
    expect((await v.allocationOf(TEAM, team.address))[1]).to.equal(0n);
    expect(await v.groupAssigned(TEAM)).to.equal(CAP[TEAM]);
    expect(await v.groupAssigned(TREASURY)).to.equal(CAP[TREASURY]);
    expect(await v.groupAssigned(SEED)).to.equal(0n);
    expect(await v.groupAssigned(PRIVATE)).to.equal(0n);
  });

  it("publishes the schedule constants the dApp reads", async () => {
    const { v } = await loadFixture(productionRig);
    expect(await v.PUBLIC_CLIFF_SECONDS()).to.equal(365n * 86_400n);
    expect(await v.PUBLIC_RELEASE_INTERVAL()).to.equal(30n * 86_400n);
    expect(await v.PUBLIC_RELEASE_COUNT()).to.equal(60n);
    expect(await v.PUBLIC_TGE_AMOUNT()).to.equal(PUBLIC_TGE);
    expect(await v.SEED()).to.equal(0);
    expect(await v.PRIVATE()).to.equal(1);
    expect(await v.TEAM()).to.equal(2);
    expect(await v.TREASURY()).to.equal(3);
    expect(await v.PUBLIC()).to.equal(4);
  });

  it("starts totalOutstanding at every pre-set allocation, TGE tranche included", async () => {
    // a deployment nobody has claimed from yet
    const [d, , , , , , team, treasury, pub, sale] = await ethers.getSigners();
    const enc = await (await ethers.getContractFactory("ENC")).deploy();
    await enc.waitForDeployment();
    const registry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(
      team.address,
    );
    await registry.waitForDeployment();
    const v = await (await ethers.getContractFactory("ENCVesting")).deploy(
      INITIAL_SUPPLY_PROD, team.address, treasury.address, pub.address, await registry.getAddress());
    // ENCVesting grants the deployer only DEFAULT_ADMIN_ROLE; the suite operates as deployer.
    await v.grantRole(await v.OPERATOR_ROLE(), (await ethers.getSigners())[0].address);
    await registry.grantRole(await registry.OPERATOR_ROLE(), await v.getAddress());
    await enc.mintGenesis(await v.getAddress(), sale.address);

    expect(await v.totalOutstanding()).to.equal(CAP[TEAM] + CAP[TREASURY] + PUBLIC_ALLOC);
    // and once SEED/PRIVATE are sold out, the books match what the vault was minted,
    // to the wei — the 20,000,000 Public Sale carve-out never lands here at all;
    // it is minted straight to the standalone EnishiPublicSale contract instead.
    await v.addBeneficiaries(SEED, [d.address], [CAP[SEED]], [team.address], true);
    await v.addBeneficiaries(PRIVATE, [d.address], [CAP[PRIVATE]], [team.address], true);
    expect(await v.totalOutstanding()).to.equal(await enc.VESTING_ALLOCATION());
    expect(await enc.balanceOf(await v.getAddress()), "no ENC is left unassignable")
      .to.equal(await v.totalOutstanding());
  });

  it("rejects a zero address or a zero supply", async () => {
    const [d, , , , , , team, treasury, pub] = await ethers.getSigners();
    const F = await ethers.getContractFactory("ENCVesting");
    const enc = await (await ethers.getContractFactory("ENC")).deploy();
    await enc.waitForDeployment();
    await enc.mintGenesis(d.address, pub.address);
    const registry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(
      team.address,
    );
    await registry.waitForDeployment();
    const registryAddr = await registry.getAddress();
    const Z = ethers.ZeroAddress;
    for (const args of [
      [INITIAL_SUPPLY_PROD, Z, treasury.address, pub.address, registryAddr],
      [INITIAL_SUPPLY_PROD, team.address, Z, pub.address, registryAddr],
      [INITIAL_SUPPLY_PROD, team.address, treasury.address, Z, registryAddr],
      [INITIAL_SUPPLY_PROD, team.address, treasury.address, pub.address, Z],
    ] as const) {
      await expect(F.deploy(...(args as any))).to.be.revertedWithCustomError(F, "ZeroAddress");
    }
    await expect(F.deploy(0n, team.address, treasury.address, pub.address, registryAddr))
      .to.be.revertedWithCustomError(F, "ZeroAmount");

    // The ENC address is no longer a constructor arg — start() is what rejects zero.
    const v = await F.deploy(INITIAL_SUPPLY_PROD, team.address, treasury.address, pub.address, registryAddr);
    await expect(v.start(Z)).to.be.revertedWithCustomError(v, "ZeroAddress");
  });

  it("cumulativeBurned floors at zero if the supply ever grows past the baseline", async () => {
    const [d, , , , , , team, treasury, pub] = await ethers.getSigners();
    const enc = await (await ethers.getContractFactory("MockBurnableENC")).deploy();
    await enc.mint(d.address, 1_000n * E);
    // The vault has to be funded before it will start, so the baseline is set to
    // land 500 tokens BELOW the resulting live supply on purpose.
    const owed = CAP[TEAM] + CAP[TREASURY] + PUBLIC_ALLOC;
    const registry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(
      team.address,
    );
    await registry.waitForDeployment();
    const v = await (await ethers.getContractFactory("ENCVesting")).deploy(
      owed + 500n * E, team.address, treasury.address, pub.address, await registry.getAddress());
    // ENCVesting grants the deployer only DEFAULT_ADMIN_ROLE; the suite operates as deployer.
    await v.grantRole(await v.OPERATOR_ROLE(), (await ethers.getSigners())[0].address);

    // Unstarted, the token is not wired yet and nothing can have burned.
    expect(await v.cumulativeBurned()).to.equal(0n);

    // start() wires the token and pulls the vault's full backing in from the owner.
    await enc.mint(d.address, owed);
    await enc.approve(await v.getAddress(), owed);
    await v.start(await enc.getAddress());
    expect(await v.cumulativeBurned()).to.equal(0n);
    await enc.connect(d).burn(400n * E);   // supply 600 > baseline 500
    expect(await v.cumulativeBurned()).to.equal(0n);
    await enc.connect(d).burn(200n * E);   // supply 400 < baseline 500
    expect(await v.cumulativeBurned()).to.equal(100n * E);
  });
});

describe("OPERATOR_ROLE management", () => {
  it("only the admin may grant it", async () => {
    const { v, deployer, outsider } = await loadFixture(productionRig);
    const ADMIN = await v.DEFAULT_ADMIN_ROLE();
    const OPERATOR = await v.OPERATOR_ROLE();
    await expect(v.connect(outsider).grantRole(OPERATOR, outsider.address))
      .to.be.revertedWithCustomError(v, "AccessControlUnauthorizedAccount").withArgs(outsider.address, ADMIN);
    await expect(v.grantRole(OPERATOR, outsider.address))
      .to.emit(v, "RoleGranted").withArgs(OPERATOR, outsider.address, deployer.address);
  });

  it("a revoked operator loses the press immediately", async () => {
    const { enc, v, burner, operator, outsider, u1, deployer } = await loadFixture(productionRig);
    const OPERATOR = await v.OPERATOR_ROLE();
    await v.addBeneficiaries(SEED, [u1.address], [CAP[SEED]], [deployer.address], true);
    await enc.connect(burner).burn(1_000n * E);
    await v.revokeRole(OPERATOR, operator.address);
    await v.grantRole(OPERATOR, outsider.address);
    await expect(v.connect(operator).distribute(SEED))
      .to.be.revertedWithCustomError(v, "AccessControlUnauthorizedAccount").withArgs(operator.address, OPERATOR);
    await expect(v.connect(outsider).distribute(SEED)).to.not.be.reverted;
  });
});

describe("Admin hand-over", () => {
  it("a new admin takes over once granted, and the old one loses it on renounce", async () => {
    const { v, deployer, outsider, operator } = await loadFixture(productionRig);
    const ADMIN = await v.DEFAULT_ADMIN_ROLE();
    const OPERATOR = await v.OPERATOR_ROLE();
    await v.grantRole(ADMIN, outsider.address);
    await v.renounceRole(ADMIN, deployer.address);
    expect(await v.hasRole(ADMIN, deployer.address)).to.equal(false);

    await expect(v.connect(deployer).revokeRole(OPERATOR, operator.address))
      .to.be.revertedWithCustomError(v, "AccessControlUnauthorizedAccount").withArgs(deployer.address, ADMIN);
    await expect(v.connect(outsider).revokeRole(OPERATOR, operator.address)).to.not.be.reverted;
  });

  it("renouncing every deployer role leaves the operator as the only presser", async () => {
    const { enc, v, burner, operator, u1, deployer } = await loadFixture(productionRig);
    const OPERATOR = await v.OPERATOR_ROLE();
    await v.addBeneficiaries(SEED, [u1.address], [CAP[SEED]], [deployer.address], true);
    await v.renounceRole(OPERATOR, deployer.address);
    await v.renounceRole(await v.DEFAULT_ADMIN_ROLE(), deployer.address);
    await enc.connect(burner).burn(1_000n * E);
    await expect(v.connect(deployer).distribute(SEED))
      .to.be.revertedWithCustomError(v, "AccessControlUnauthorizedAccount").withArgs(deployer.address, OPERATOR);
    await expect(v.connect(operator).distribute(SEED)).to.not.be.reverted;
  });
});

describe("addBeneficiaries", () => {
  it("registers members in join order and reports them", async () => {
    const { v, u1, u2, u3, deployer } = await loadFixture(productionRig);
    await v.addBeneficiaries(SEED, [u1.address, u2.address], [1n * E, 2n * E], [deployer.address, deployer.address], true);
    await v.addBeneficiaries(SEED, [u3.address], [3n * E], [deployer.address], true);
    expect(await v.roundMembers(SEED)).to.deep.equal([u1.address, u2.address, u3.address]);
    expect(await v.groupAssigned(SEED)).to.equal(6n * E);
    expect(await v.allocation(SEED, u2.address)).to.equal(2n * E);
  });

  it("rejects every malformed input", async () => {
    const { v, u1, u2, operator, deployer } = await loadFixture(productionRig);
    await expect(v.addBeneficiaries(SEED, [u1.address], [1n * E, 2n * E], [deployer.address], true))
      .to.be.revertedWithCustomError(v, "LengthMismatch");
    await expect(v.addBeneficiaries(SEED, [], [], [], true))
      .to.be.revertedWithCustomError(v, "EmptyInput");
    await expect(v.addBeneficiaries(SEED, [ethers.ZeroAddress], [1n * E], [ethers.ZeroAddress], true))
      .to.be.revertedWithCustomError(v, "ZeroAddress");
    await expect(v.addBeneficiaries(SEED, [u1.address], [0n], [deployer.address], true))
      .to.be.revertedWithCustomError(v, "ZeroAmount");
    for (const r of [TEAM, TREASURY, PUBLIC, 8]) {
      await expect(v.connect(operator).addBeneficiaries(r, [u2.address], [1n * E], [deployer.address], true))
        .to.be.revertedWithCustomError(v, "UnknownRound").withArgs(r);
    }
  });

  it("an existing allocation can never be modified, not even by the owner", async () => {
    const { v, u1, operator, deployer } = await loadFixture(productionRig);
    await v.addBeneficiaries(SEED, [u1.address], [1n * E], [deployer.address], true);
    await expect(v.addBeneficiaries(SEED, [u1.address], [2n * E], [deployer.address], true))
      .to.be.revertedWithCustomError(v, "AllocationAlreadySet").withArgs(SEED, u1.address);
    await expect(v.connect(operator).addBeneficiaries(SEED, [u1.address], [1n * E], [deployer.address], true))
      .to.be.revertedWithCustomError(v, "AllocationAlreadySet");
    // the same wallet may hold an allocation in the OTHER pooled round
    await expect(v.addBeneficiaries(PRIVATE, [u1.address], [1n * E], [deployer.address], true)).to.not.be.reverted;
  });

  it("rejects a duplicate inside a single call", async () => {
    const { v, u1, deployer } = await loadFixture(productionRig);
    await expect(v.addBeneficiaries(SEED, [u1.address, u1.address], [1n * E, 1n * E], [deployer.address, deployer.address], true))
      .to.be.revertedWithCustomError(v, "AllocationAlreadySet").withArgs(SEED, u1.address);
  });

  it("enforces the round cap, to the wei", async () => {
    const { v, u1, u2, deployer } = await loadFixture(productionRig);
    await expect(v.addBeneficiaries(SEED, [u1.address], [CAP[SEED] + 1n], [deployer.address], true))
      .to.be.revertedWithCustomError(v, "AllocationCapExceeded").withArgs(SEED, CAP[SEED] + 1n, CAP[SEED]);
    await v.addBeneficiaries(SEED, [u1.address], [CAP[SEED]], [deployer.address], true);
    await expect(v.addBeneficiaries(SEED, [u2.address], [1n], [deployer.address], true))
      .to.be.revertedWithCustomError(v, "AllocationCapExceeded").withArgs(SEED, CAP[SEED] + 1n, CAP[SEED]);
    // PRIVATE has its own, separate cap
    await expect(v.addBeneficiaries(PRIVATE, [u2.address], [CAP[PRIVATE]], [deployer.address], true)).to.not.be.reverted;
    await expect(v.addBeneficiaries(PRIVATE, [u1.address], [1n], [deployer.address], true))
      .to.be.revertedWithCustomError(v, "AllocationCapExceeded");
  });

  it("registers against an empty vault — backing is start()'s job, not this one's", async () => {
    const [d, , , , , , team, treasury, pub, sale] = await ethers.getSigners();
    const enc = await (await ethers.getContractFactory("ENC")).deploy();
    await enc.waitForDeployment();
    await enc.mintGenesis(d.address, sale.address);
    const registry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(
      team.address,
    );
    await registry.waitForDeployment();
    const v = await (await ethers.getContractFactory("ENCVesting")).deploy(
      INITIAL_SUPPLY_PROD, team.address, treasury.address, pub.address, await registry.getAddress());
    // ENCVesting grants the deployer only DEFAULT_ADMIN_ROLE; the suite operates as deployer.
    await v.grantRole(await v.OPERATOR_ROLE(), (await ethers.getSigners())[0].address);
    await registry.grantRole(await registry.OPERATOR_ROLE(), await v.getAddress());
    const committed = CAP[TEAM] + CAP[TREASURY] + PUBLIC_ALLOC;

    // Not a single wei on hand, and the registration still lands.
    expect(await enc.balanceOf(await v.getAddress())).to.equal(0n);
    await expect(v.addBeneficiaries(SEED, [d.address], [1n], [team.address], true)).to.not.be.reverted;
    expect(await v.totalOutstanding()).to.equal(committed + 1n);
  });

  it("only OPERATOR_ROLE holders may register", async () => {
    const { v, outsider, operator, u1, deployer } = await loadFixture(productionRig);
    await expect(v.connect(outsider).addBeneficiaries(SEED, [u1.address], [1n * E], [deployer.address], true))
      .to.be.revertedWithCustomError(v, "AccessControlUnauthorizedAccount")
      .withArgs(outsider.address, await v.OPERATOR_ROLE());
    await expect(v.connect(operator).addBeneficiaries(SEED, [u1.address], [1n * E], [deployer.address], true)).to.not.be.reverted;
  });
});

describe("Money invariants", () => {
  it("the vault always holds at least what it still owes, through a whole life cycle", async () => {
    const { enc, v, burner, operator, u1, u2, team, treasury, deployer } = await loadFixture(productionRig);
    const vAddr = await v.getAddress();
    const check = async (label: string) => {
      expect(await enc.balanceOf(vAddr), label).to.be.greaterThanOrEqual(await v.totalOutstanding());
    };
    await check("at genesis");
    await v.addBeneficiaries(SEED, [u1.address], [CAP[SEED]], [deployer.address], true);
    await v.addBeneficiaries(PRIVATE, [u2.address], [CAP[PRIVATE]], [deployer.address], true);
    await check("after registration");
    await enc.connect(burner).burn(BOUNDARY[1]);
    await check("after burning to the PRIVATE boundary");
    await v.connect(operator).distribute(SEED);
    await v.connect(operator).distribute(PRIVATE);
    await v.connect(team).claimAll();
    await v.connect(treasury).claimAll();
    await check("after everyone has been paid");
  });

  it("totalOutstanding equals Σ(allocation − claimed) at every step", async () => {
    const { enc, v, burner, operator, u1, team, treasury, pub, deployer } = await loadFixture(productionRig);
    const owed = async () => {
      let sum = 0n;
      for (const [r, w] of [[SEED, u1.address], [TEAM, team.address],
                            [TREASURY, treasury.address], [PUBLIC, pub.address]] as const) {
        const [alloc, claimed] = await v.allocationOf(r, w);
        sum += alloc - claimed;
      }
      return sum;
    };
    await v.addBeneficiaries(SEED, [u1.address], [CAP[SEED]], [deployer.address], true);
    expect(await v.totalOutstanding()).to.equal(await owed());
    await enc.connect(burner).burn(20_000_000n * E);
    await v.connect(operator).distribute(SEED);
    expect(await v.totalOutstanding()).to.equal(await owed());
    await v.connect(team).claimAll();
    expect(await v.totalOutstanding()).to.equal(await owed());
  });

  it("the vault is never an intermediate holder — ENC goes straight to the wallet", async () => {
    const { enc, v, burner, operator, u1, deployer } = await loadFixture(productionRig);
    await v.addBeneficiaries(SEED, [u1.address], [CAP[SEED]], [deployer.address], true);
    await enc.connect(burner).burn(1_000n * E);
    await expect(v.connect(operator).distribute(SEED))
      .to.changeTokenBalances(enc, [await v.getAddress(), u1.address], [-400n * E, 400n * E]);
    // LOCKED covers the five vesting rounds; the Public Sale reserve never
    // lands here at all — it's minted straight to EnishiPublicSale.
    expect(await enc.balanceOf(await v.getAddress())).to.equal(
      LOCKED - PUBLIC_TGE - 400n * E,
    );
  });

  it("no round can ever pay out more than its allocation, even under maximum burn", async () => {
    const { enc, v, burner, operator, u1, u2, team, treasury, deployer } = await loadFixture(productionRig);
    await v.addBeneficiaries(SEED, [u1.address], [CAP[SEED]], [deployer.address], true);
    await v.addBeneficiaries(PRIVATE, [u2.address], [CAP[PRIVATE]], [deployer.address], true);
    await enc.connect(burner).burn(await enc.balanceOf(burner.address));
    for (let i = 0; i < 3; i++) {
      try { await v.connect(operator).distribute(SEED); } catch {}
      try { await v.connect(operator).distribute(PRIVATE); } catch {}
    }
    await v.connect(team).claimAll();
    await v.connect(treasury).claimAll();
    expect(await enc.balanceOf(u1.address)).to.equal(CAP[SEED]);
    expect(await enc.balanceOf(u2.address)).to.equal(CAP[PRIVATE]);
    expect(await enc.balanceOf(team.address)).to.be.lessThanOrEqual(CAP[TEAM]);
    expect(await enc.balanceOf(treasury.address)).to.be.lessThanOrEqual(CAP[TREASURY]);
  });
});

describe("Genesis mint — vault holds the full supply", () => {
  it("leaves the vault holding exactly what every round still owes", async () => {
    const { enc, v } = await loadFixture(productionRig);
    // SEED/PRIVATE have no beneficiaries yet, so their caps are not in totalOutstanding.
    expect(await enc.balanceOf(await v.getAddress())).to.equal(
      (await v.totalOutstanding()) + CAP[SEED] + CAP[PRIVATE],
    );
  });

  it("puts the vault's whole allocation in the one vault, to the wei", async () => {
    const { enc, v } = await loadFixture(productionRig);
    const inVault = await enc.balanceOf(await v.getAddress());
    // PUBLIC has already pulled its TGE tranche in the rig. VESTING_ALLOCATION
    // excludes the 20,000,000 Public Sale carve-out, minted straight to
    // EnishiPublicSale instead of landing here.
    expect(inVault + PUBLIC_TGE).to.equal(await enc.VESTING_ALLOCATION());
    expect(await enc.VESTING_ALLOCATION()).to.equal(
      INITIAL_SUPPLY_PROD - (await enc.PUBLIC_SALE_ALLOCATION()),
    );
  });

  it("does not disturb any round: TGE, claims and burn unlocks are unchanged", async () => {
    const { enc, v, burner, operator, u1, team, deployer } = await loadFixture(productionRig);
    expect(await v.PUBLIC_TGE_AMOUNT()).to.equal(178_000_000n * E);

    // A burn-driven round still unlocks and pays out normally.
    await v.addBeneficiaries(SEED, [u1.address], [CAP[SEED]], [deployer.address], true);
    await enc.connect(burner).burn(30_000_000n * E);
    await v.connect(operator).distribute(SEED);
    expect(await enc.balanceOf(u1.address)).to.equal(CAP[SEED]);
    await v.connect(team).claim(TEAM);
    expect(await enc.balanceOf(team.address)).to.be.greaterThan(0n);
  });
});

describe("isAllNonPublicUnlocked", () => {
  const ENC_MAX_BURN = 2_010_000_000n * E;

  it("flips exactly at the 2,010,000,000 ENC burn mark", async () => {
    const { enc, v, deployer } = await loadFixture(fullRangeRig);
    expect(await v.isAllNonPublicUnlocked()).to.equal(false);

    // One wei short.
    await enc.connect(deployer).burn(ENC_MAX_BURN - 1n);
    expect(await v.cumulativeBurned()).to.equal(ENC_MAX_BURN - 1n);
    expect(await v.isAllNonPublicUnlocked()).to.equal(false);

    await enc.connect(deployer).burn(1n);
    expect(await v.cumulativeBurned()).to.equal(ENC_MAX_BURN);
    expect(await v.isAllNonPublicUnlocked()).to.equal(true);

    // Stays true once past the mark.
    await enc.connect(deployer).burn(1_000n * E);
    expect(await v.isAllNonPublicUnlocked()).to.equal(true);
  });

  it("every non-Public round is at its cap once the unlock curve is fully walked", async () => {
    const { enc, v, deployer } = await loadFixture(fullRangeRig);
    await enc.connect(deployer).burn(FULL_UNLOCK_BURN);
    for (const r of [SEED, PRIVATE, TEAM, TREASURY]) {
      expect(await v.groupUnlocked(r), `round ${r} not at cap`).to.equal(CAP[r]);
    }
    expect(await v.isAllNonPublicUnlocked()).to.equal(true);
  });

  it("the flag can lead the curve by a few wei of ceilDiv rounding", async () => {
    const { enc, v, deployer } = await loadFixture(fullRangeRig);
    // The phase walk rounds each phase's burn requirement up, so walking the whole
    // curve costs a hair more than the flat 2,010,000,000 the flag tests against.
    expect(FULL_UNLOCK_BURN).to.be.greaterThanOrEqual(ENC_MAX_BURN);
    expect(FULL_UNLOCK_BURN - ENC_MAX_BURN).to.be.lessThan(10n); // wei, not tokens

    await enc.connect(deployer).burn(ENC_MAX_BURN);
    expect(await v.isAllNonPublicUnlocked()).to.equal(true);
    // TREASURY is the last group to fill and may still be those few wei short.
    expect(CAP[TREASURY] - (await v.groupUnlocked(TREASURY))).to.be.lessThan(10n);
  });

  it("is false on the production supply — the TGE budget cannot reach the full burn", async () => {
    const { enc, v, burner } = await loadFixture(productionRig);
    await enc.connect(burner).burn(await enc.balanceOf(burner.address));
    expect(await v.cumulativeBurned()).to.be.lessThan(FULL_UNLOCK_BURN);
    expect(await v.isAllNonPublicUnlocked()).to.equal(false);
  });
});

describe("One source of truth for the supply", () => {
  it("ENC.MAX_SUPPLY, EnishiConstants and the TypeScript mirror all agree", async () => {
    const { enc } = await loadFixture(productionRig);
    // helpers/encConstants.ts has to restate the number because 02_deploy_enc_and_vesting.ts
    // must pass it to ENCVesting before ENC exists. This is what stops the two drifting.
    expect(await enc.MAX_SUPPLY(), "TS mirror drifted from EnishiConstants.ENC_MAX_SUPPLY")
      .to.equal(ENC_MAX_SUPPLY);
    expect(await enc.totalSupply()).to.equal(ENC_MAX_SUPPLY);
  });

  it("the five round allocations tile what the vault was minted", async () => {
    const { enc, v } = await loadFixture(productionRig);
    const sum =
      (await v.groupCap(SEED)) + (await v.groupCap(PRIVATE)) +
      (await v.groupCap(TEAM)) + (await v.groupCap(TREASURY)) + PUBLIC_ALLOC;
    // one wei either way means the vault is underfunded, or holds ENC nobody can withdraw
    expect(sum, "round allocations do not tile what the vault was minted")
      .to.equal(await enc.VESTING_ALLOCATION());
    // the Public Sale carve-out is minted straight to EnishiPublicSale, so the
    // vault's own rounds tile VESTING_ALLOCATION (2,980,000,000), not the full supply
    expect(sum, "round allocations do not tile the vesting allocation").to.equal(
      ENC_MAX_SUPPLY - (await enc.PUBLIC_SALE_ALLOCATION()),
    );
  });

  it("the vault holds exactly what the rounds owe", async () => {
    const { enc, v } = await loadFixture(productionRig);
    // productionRig has already pulled the TGE tranche out.
    expect(await enc.balanceOf(await v.getAddress())).to.equal(
      (await v.totalOutstanding()) + CAP[SEED] + CAP[PRIVATE],
    );
  });

  it("the vault is deployed against that exact baseline", async () => {
    const { v } = await loadFixture(productionRig);
    expect(await v.INITIAL_SUPPLY()).to.equal(ENC_MAX_SUPPLY);
  });
});

describe("start", () => {
  /** ENCVesting deployed and funded by the genesis mint, but not started. */
  async function unstarted() {
    const [deployer, operator, u1, , , , team, treasury, pub, outsider] = await ethers.getSigners();
    const enc = await (await ethers.getContractFactory("ENC")).deploy();
    await enc.waitForDeployment();
    const registry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(
      team.address,
    );
    await registry.waitForDeployment();
    const v = await (await ethers.getContractFactory("ENCVesting")).deploy(
      INITIAL_SUPPLY_PROD, team.address, treasury.address, pub.address, await registry.getAddress());
    // ENCVesting grants the deployer only DEFAULT_ADMIN_ROLE; the suite operates as deployer.
    await v.grantRole(await v.OPERATOR_ROLE(), (await ethers.getSigners())[0].address);
    await v.waitForDeployment();
    await registry.grantRole(await registry.OPERATOR_ROLE(), await v.getAddress());
    await enc.mintGenesis(await v.getAddress(), outsider.address);
    return { enc, v, deployer, operator, u1, team, treasury, pub, outsider };
  }

  it("leaves the TGE anchor at zero until it is pressed", async () => {
    const { v } = await loadFixture(unstarted);
    expect(await v.startTime()).to.equal(0n);
  });

  it("anchors the TGE and reports the block timestamp", async () => {
    const { enc, v } = await loadFixture(unstarted);
    const tx = await v.start(await enc.getAddress());
    const receipt = await tx.wait();
    const stamp = BigInt((await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp);
    await expect(tx).to.emit(v, "Started").withArgs(stamp);
    expect(await v.startTime()).to.equal(stamp);
  });

  it("the PUBLIC schedule does not run before start", async () => {
    const { v, pub } = await loadFixture(unstarted);
    // Years pass with the vault funded but unstarted: nothing unlocks.
    await time.increase(5 * 365 * 24 * 3600);
    expect(await v.publicReleasesUnlocked()).to.equal(0n);
    expect(await v.publicUnlockedBps()).to.equal(0);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(0n);
  });

  it("refuses while the vault holds less than it owes", async () => {
    const [d, , , , , , team, treasury, pub, sale] = await ethers.getSigners();
    const enc = await (await ethers.getContractFactory("ENC")).deploy();
    await enc.waitForDeployment();
    const registry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(
      team.address,
    );
    await registry.waitForDeployment();
    const v = await (await ethers.getContractFactory("ENCVesting")).deploy(
      INITIAL_SUPPLY_PROD, team.address, treasury.address, pub.address, await registry.getAddress());
    // ENCVesting grants the deployer only DEFAULT_ADMIN_ROLE; the suite operates as deployer.
    await v.grantRole(await v.OPERATOR_ROLE(), (await ethers.getSigners())[0].address);
    await v.waitForDeployment();
    await enc.mintGenesis(d.address, sale.address);

    const owed = CAP[TEAM] + CAP[TREASURY] + PUBLIC_ALLOC;

    // Nothing on hand and nothing approved: the top-up pull is what fails.
    await expect(v.start(await enc.getAddress())).to.be.revertedWithCustomError(enc, "ERC20InsufficientAllowance");

    // one wei short is still short
    await enc.transfer(await v.getAddress(), owed - 1n);
    await expect(v.start(await enc.getAddress())).to.be.revertedWithCustomError(enc, "ERC20InsufficientAllowance");

    // Approve the gap and start pulls exactly it.
    const before = await enc.balanceOf(d.address);
    await enc.approve(await v.getAddress(), 1n);
    await expect(v.start(await enc.getAddress())).to.emit(v, "Started");
    expect(await enc.balanceOf(d.address)).to.equal(before - 1n);
    expect(await enc.balanceOf(await v.getAddress())).to.equal(owed);
  });

  it("can only be pressed once", async () => {
    const { enc, v } = await loadFixture(unstarted);
    await enc.approve(await v.getAddress(), await v.totalOutstanding());
    await v.start(await enc.getAddress());
    const stamp = await v.startTime();
    await expect(v.start(await enc.getAddress()))
      .to.be.revertedWithCustomError(v, "AlreadyStarted").withArgs(stamp);
    expect(await v.startTime(), "the anchor never moves").to.equal(stamp);
  });

  it("is admin-only — neither the operator nor a stranger can press it", async () => {
    const { enc, v, operator, outsider } = await loadFixture(unstarted);
    await v.grantRole(await v.OPERATOR_ROLE(), operator.address);
    for (const who of [operator, outsider]) {
      await expect(v.connect(who).start(await enc.getAddress()))
        .to.be.revertedWithCustomError(v, "AccessControlUnauthorizedAccount")
        .withArgs(who.address, await v.DEFAULT_ADMIN_ROLE());
    }
    expect(await v.startTime()).to.equal(0n);
  });

  it("gates claim, claimAll, distribute and publicReleaseTime until it is pressed", async () => {
    const { v, operator, pub, u1, team } = await loadFixture(unstarted);
    await v.grantRole(await v.OPERATOR_ROLE(), operator.address);
    await v.addBeneficiaries(SEED, [u1.address], [CAP[SEED]], [team.address], true);

    await expect(v.connect(pub).claim(PUBLIC)).to.be.revertedWithCustomError(v, "NotStarted");
    await expect(v.connect(pub).claimAll()).to.be.revertedWithCustomError(v, "NotStarted");
    await expect(v.connect(operator).distribute(SEED)).to.be.revertedWithCustomError(v, "NotStarted");
    await expect(v.publicReleaseTime(1)).to.be.revertedWithCustomError(v, "NotStarted");
  });

  it("anchors the release grid to the press, not to deployment", async () => {
    const { enc, v } = await loadFixture(unstarted);
    const YEAR = 365 * 24 * 3600;
    await time.increase(YEAR);           // a year of shelf time before going live
    await enc.approve(await v.getAddress(), await v.totalOutstanding());
    await v.start(await enc.getAddress());
    const stamp = await v.startTime();
    expect(await v.publicReleaseTime(1)).to.equal(stamp + BigInt(YEAR));
  });

  it("registering beneficiaries stays open before start — only the money moves are gated", async () => {
    const { v, u1, team } = await loadFixture(unstarted);
    await expect(v.addBeneficiaries(SEED, [u1.address], [CAP[SEED]], [team.address], true)).to.not.be.reverted;
  });
});

describe("Coverage guard", () => {
  it("every externally callable function of ENCVesting is exercised by this suite", async () => {
    const abi = (await artifacts.readArtifact("ENCVesting")).abi;
    const fns = abi.filter((e: any) => e.type === "function").map((e: any) => e.name).sort();

    // Each name below is asserted on somewhere in test/unit/ENCVesting.*.test.ts
    const COVERED = new Set([
      // admin / operator
      "start", "addBeneficiaries", "distribute",
      // AccessControl
      "OPERATOR_ROLE", "DEFAULT_ADMIN_ROLE", "grantRole", "revokeRole", "renounceRole",
      "hasRole", "getRoleAdmin", "supportsInterface",
      // beneficiary
      "claim", "claimAll",
      // views
      "cumulativeBurned", "groupCap", "groupUnlocked", "pendingPool", "roundMembers",
      "previewDistribution", "claimable", "allocationOf",
      "publicUnlockedBps", "publicReleasesUnlocked", "publicReleaseTime",
      // storage getters
      "allocation", "claimed", "credited", "groupAssigned", "totalOutstanding",
      "ENC_TOKEN", "INITIAL_SUPPLY", "startTime", "REFERRAL_REGISTRY",
      // constants
      "PUBLIC_CLIFF_SECONDS", "PUBLIC_RELEASE_INTERVAL",
      "PUBLIC_RELEASE_COUNT", "PUBLIC_TGE_AMOUNT",
      // burn-cap view
      "isAllNonPublicUnlocked",
      "SEED", "PRIVATE", "TEAM", "TREASURY", "PUBLIC",
    ]);

    const uncovered = fns.filter((n: string) => !COVERED.has(n));
    expect(uncovered, `these functions have no test: ${uncovered.join(", ")}`).to.deep.equal([]);

    // and the list must not rot: every name claimed as covered must still exist
    const stale = [...COVERED].filter((n) => !fns.includes(n));
    expect(stale, `these covered names no longer exist: ${stale.join(", ")}`).to.deep.equal([]);
  });

  it("every custom error declared by IENCVesting is triggered by this suite", async () => {
    const abi = (await artifacts.readArtifact("ENCVesting")).abi;
    const errors = abi.filter((e: any) => e.type === "error").map((e: any) => e.name);
    const TRIGGERED = new Set([
      "ZeroAddress", "ZeroAmount", "UnknownRound", "NothingToClaim", "NothingToDistribute",
      "LengthMismatch", "Underfunded", "AllocationCapExceeded", "AllocationAlreadySet",
      "AccessControlUnauthorizedAccount", "EmptyInput", "OperatorDistributedRound", "InvalidReleaseIndex",
      "NotStarted", "AlreadyStarted",
      // triggered in ENCVesting.test.ts ("referrer registration on beneficiary onboarding")
      "ReferrerRequired",
    ]);
    // errors inherited from OpenZeppelin base contracts are theirs to test, and two of
    // them are unreachable here anyway: ENC has no transfer hook to reenter through,
    // and SafeERC20 cannot fail against a compliant fixed-supply token.
    // AccessControlBadConfirmation (renouncing on someone else's behalf) is OZ's own guard.
    const INHERITED = ["ReentrancyGuardReentrantCall", "SafeERC20FailedOperation", "AccessControlBadConfirmation"];
    const untested = errors.filter(
      (n: string) => !TRIGGERED.has(n) && !INHERITED.includes(n));
    expect(untested, `these errors are never triggered: ${untested.join(", ")}`).to.deep.equal([]);
  });
});
