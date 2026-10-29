import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ENC_MAX_SUPPLY } from "../../helpers/encConstants";

/**
 * Conformance suite: every case here is lifted straight from the client spec
 * (the SEED/PRIVATE distribution discussion and the 2026-08-10 meeting notes).
 * Each `it` names the spec item it checks, so a failure points at the clause.
 */

const E = (n: number | string) => ethers.parseUnits(n.toString(), 18);

const SEED = 0, PRIVATE = 1, TEAM = 2, TREASURY = 3, PUBLIC = 4;

const CAP_SEED = E(12_000_000);
const CAP_PRIVATE = E(28_000_000);
const CAP_TEAM = E(450_000_000);
const CAP_TREASURY = E(1_520_000_000);
// 970M vests here (178M TGE + 792M monthly); the other 20M of the 990M
// The other 20M of the 990M Public allocation is sold by the standalone
// EnishiPublicSale contract, not administered here.
const PUBLIC_ALLOC = E(970_000_000);
const PUBLIC_TGE = E(178_000_000);
const INITIAL_SUPPLY = ENC_MAX_SUPPLY;
const LOCKED = CAP_SEED + CAP_PRIVATE + CAP_TEAM + CAP_TREASURY + PUBLIC_ALLOC - PUBLIC_TGE;

/// SEED takes 40% of every burn while all four groups are active.
const burnForSeed = (amount: bigint) => (amount * 10n) / 4n;

async function fixture() {
  const [deployer, operator, u1, u2, u3, team, treasury, pub, publicSale] =
    await ethers.getSigners();

  const enc = await (await ethers.getContractFactory("ENC")).deploy();
  await enc.waitForDeployment();
  const referralRegistry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(
    team.address,
  );
  await referralRegistry.waitForDeployment();
  const v = await (await ethers.getContractFactory("ENCVesting")).deploy(
    INITIAL_SUPPLY, team.address, treasury.address, pub.address, await referralRegistry.getAddress(),
  );
  // ENCVesting grants the deployer only DEFAULT_ADMIN_ROLE; the suite operates as deployer.
  await v.grantRole(await v.OPERATOR_ROLE(), (await ethers.getSigners())[0].address);
  await v.waitForDeployment();
  // ENCVesting must be authorized to register beneficiaries' referrers.
  await referralRegistry.grantRole(await referralRegistry.OPERATOR_ROLE(), await v.getAddress());
  // In production the genesis mint splits the supply between the vault and
  // the standalone EnishiPublicSale contract's 20M carve-out.
  await enc.mintGenesis(await v.getAddress(), publicSale.address);
  await v.start(await enc.getAddress());
  // PUBLIC's TGE tranche is no longer pre-credited: the vault holds it and the
  // beneficiary pulls it. It is the only circulating ENC, so these suites take it
  // as their burn float.
  await v.connect(pub).claim(PUBLIC);
  await enc.connect(pub).transfer(deployer.address, PUBLIC_TGE);

  await v.grantRole(await v.OPERATOR_ROLE(), operator.address);

  return { enc, v, deployer, operator, u1, u2, u3, team, treasury, pub };
}

const burn = (enc: any, deployer: any, amount: bigint) => enc.connect(deployer).burn(amount);
const paid = (v: any, round: number, who: any) => v.allocationOf(round, who.address).then((r: any) => r[1]);

describe("Spec conformance — the 5-step walkthrough (Total Allocation 2,000,000 each)", () => {
  it("steps 1-5 reproduce the spec's numbers exactly", async () => {
    const { enc, v, deployer, operator, u1, u2, u3 , team } = await loadFixture(fixture);
    const ALLOC = E(2_000_000);

    // Step 1 — unlock 1,200,000 with NO investors in the round: allocated to nobody.
    await burn(enc, deployer, burnForSeed(E(1_200_000)));
    expect(await v.pendingPool(SEED)).to.equal(E(1_200_000));
    expect((await v.roundMembers(SEED)).length).to.equal(0);

    // Step 2 — add User 1, then press: User 1 is the only member, so the whole
    // pool goes to them. Registering alone credits nothing — the press does.
    await v.addBeneficiaries(SEED, [u1.address], [ALLOC], [team.address], true);
    expect(await paid(v, SEED, u1)).to.equal(0n);
    await v.connect(operator).distribute(SEED);
    expect(await paid(v, SEED, u1)).to.equal(E(1_200_000));

    // Step 3 — add User 2 and User 3. Nothing is pooled, so the newcomers start
    // at 0 and User 1 keeps what the press already fixed.
    await v.addBeneficiaries(SEED, [u2.address, u3.address], [ALLOC, ALLOC], [team.address, team.address], true);
    expect(await v.pendingPool(SEED)).to.equal(0n);
    expect(await paid(v, SEED, u1)).to.equal(E(1_200_000));
    expect(await paid(v, SEED, u2)).to.equal(0n);
    expect(await paid(v, SEED, u3)).to.equal(0n);

    // Step 4 — unlock another 600,000, split across the 3 investors → 200,000 each.
    await burn(enc, deployer, burnForSeed(E(600_000)));
    await v.connect(operator).distribute(SEED);
    expect(await paid(v, SEED, u1)).to.equal(E(1_400_000)); // 1,200,000 + 200,000
    expect(await paid(v, SEED, u2)).to.equal(E(200_000));
    expect(await paid(v, SEED, u3)).to.equal(E(200_000));

    // Step 5 — unlock another 2,400,000. In theory 800,000 each, but User 1 can only
    // absorb 600,000 more. Press 1 pays 600,000 / 800,000 / 800,000, holding back 200,000.
    await burn(enc, deployer, burnForSeed(E(2_400_000)));
    await v.connect(operator).distribute(SEED);
    expect(await paid(v, SEED, u1)).to.equal(E(2_000_000)); // Total Allocation reached
    expect(await paid(v, SEED, u2)).to.equal(E(1_000_000));
    expect(await paid(v, SEED, u3)).to.equal(E(1_000_000));
    expect(await v.pendingPool(SEED)).to.equal(E(200_000));

    // Press 2 (the "admin presses once more" case from the 2026-08-10 meeting) hands the
    // held-back 200,000 to the two investors that still have room → 100,000 each.
    await v.connect(operator).distribute(SEED);
    expect(await paid(v, SEED, u1)).to.equal(E(2_000_000));
    expect(await paid(v, SEED, u2)).to.equal(E(1_100_000)); // spec's final figure
    expect(await paid(v, SEED, u3)).to.equal(E(1_100_000)); // spec's final figure
    expect(await v.pendingPool(SEED)).to.equal(0n);
  });
});

describe("Spec conformance — joining is never retroactive", () => {
  it("a newcomer takes NO share of the pool that accrued before they joined", async () => {
    const { enc, v, deployer, operator, u1, u2, u3 , team } = await loadFixture(fixture);

    // 100,000 unlocks while only A and B are registered...
    await v.addBeneficiaries(SEED, [u1.address, u2.address], [E(1_000_000), E(2_000_000)], [team.address, team.address], true);
    await burn(enc, deployer, burnForSeed(E(100_000)));
    expect(await v.pendingPool(SEED)).to.equal(E(100_000));

    // ...so onboarding C settles that 100,000 onto A and B first, 1/3 : 2/3.
    await expect(v.addBeneficiaries(SEED, [u3.address], [E(2_000_000)], [team.address], true))
      .to.changeTokenBalances(enc, [u1, u2, u3], [E(100_000) / 3n, (E(100_000) * 2n) / 3n, 0n]);
    expect(await v.pendingPool(SEED)).to.be.lte(1n); // only the rounding wei can remain

    // The next unlock is the first one C shares in: 90,000 over 1M/2M/2M.
    await burn(enc, deployer, burnForSeed(E(90_000)));
    await expect(v.connect(operator).distribute(SEED)).to.changeTokenBalances(
      enc, [u1, u2, u3], [E(18_000), E(36_000), E(36_000)],
    );
  });

  it("registering settles the round instead of leaving ENC pooled", async () => {
    const { enc, v, deployer, u1, u2 , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [u1.address], [E(1_000_000)], [team.address], true);
    await burn(enc, deployer, burnForSeed(E(100_000)));

    // u1 is the only member, so the whole pool is theirs before u2 exists.
    await expect(v.addBeneficiaries(SEED, [u2.address], [E(2_000_000)], [team.address], true))
      .to.changeTokenBalances(enc, [u1, u2], [E(100_000), 0n]);
    expect(await v.pendingPool(SEED)).to.equal(0n);
  });

  it("the very first investors still receive what pooled while the round was empty", async () => {
    const { enc, v, deployer, operator, u1, u2 , team } = await loadFixture(fixture);
    // Nothing to settle — there are no members yet — so this pool stays for them.
    await burn(enc, deployer, burnForSeed(E(100_000)));
    await v.addBeneficiaries(SEED, [u1.address, u2.address], [E(1_000_000), E(1_000_000)], [team.address, team.address], true);
    await expect(v.connect(operator).distribute(SEED))
      .to.changeTokenBalances(enc, [u1, u2], [E(50_000), E(50_000)]);
  });

  it("settling on join emits Distributed, exactly like a button press", async () => {
    const { enc, v, deployer, u1, u2 , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [u1.address], [E(1_000_000)], [team.address], true);
    await burn(enc, deployer, burnForSeed(E(100_000)));
    await expect(v.addBeneficiaries(SEED, [u2.address], [E(2_000_000)], [team.address], true))
      .to.emit(v, "Distributed").withArgs(SEED, 1, E(100_000), 0n);
  });

  it("onboarding into a round with nothing pooled moves no ENC and emits no Distributed", async () => {
    const { enc, v, u1, u2 , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [u1.address], [E(1_000_000)], [team.address], true);
    await expect(v.addBeneficiaries(SEED, [u2.address], [E(2_000_000)], [team.address], true))
      .to.changeTokenBalances(enc, [u1, u2], [0n, 0n]);
    await expect(v.addBeneficiaries(SEED, [u3Placeholder()], [E(1_000_000)], [team.address], true))
      .to.not.emit(v, "Distributed");
  });
});

/** A throwaway address for the "nothing to settle" case above. */
function u3Placeholder() {
  return ethers.getAddress("0x000000000000000000000000000000000000dEaD");
}

describe("Spec conformance — pro-rata split (2026-08-03 Q, 2026-08-04 Yamamoto OK)", () => {
  it("denominator is the investors' assigned total, not the round cap", async () => {
    const { enc, v, deployer, operator, u1, u2, u3 , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [u1.address, u2.address, u3.address],
      [E(1_000_000), E(2_000_000), E(2_000_000)], [team.address, team.address, team.address], true);

    await burn(enc, deployer, burnForSeed(E(100_000)));
    await expect(v.connect(operator).distribute(SEED)).to.changeTokenBalances(
      enc, [u1, u2, u3], [E(20_000), E(40_000), E(40_000)],
    );
    expect(await v.pendingPool(SEED)).to.equal(0n); // the whole 100,000 went out
  });

  it("§2.2 special case: reproduces the spec's table exactly", async () => {
    const { enc, v, deployer, operator, u1, u2, u3 , team } = await loadFixture(fixture);

    // Build the exact state of the spec's table. Crediting is pro-rata, so the
    // table's non-proportional figures (2.9M / 3.8M / 4.7M against 3M / 4M / 5M)
    // are only reachable by staging the joins: A absorbs 50,000 alone, then B joins
    // for 70,000, then C joins for the remaining 11,280,000.
    await v.addBeneficiaries(SEED, [u1.address], [E(3_000_000)], [team.address], true);
    await burn(enc, deployer, burnForSeed(E(50_000)));
    await v.connect(operator).distribute(SEED);

    await v.addBeneficiaries(SEED, [u2.address], [E(4_000_000)], [team.address], true);
    await burn(enc, deployer, burnForSeed(E(70_000)));
    await v.connect(operator).distribute(SEED);

    await v.addBeneficiaries(SEED, [u3.address], [E(5_000_000)], [team.address], true);
    await burn(enc, deployer, burnForSeed(E(11_280_000)));
    await v.connect(operator).distribute(SEED);

    // ── the spec's table ──────────────────────────────────────────────────────
    //          Total Allocation | already allocated | remaining
    //  User A     3,000,000     |     2,900,000     |   100,000
    //  User B     4,000,000     |     3,800,000     |   200,000
    //  User C     5,000,000     |     4,700,000     |   300,000
    //  Total     12,000,000     |    11,400,000     |   600,000
    const table = [
      { who: u1, total: E(3_000_000), allocated: E(2_900_000), remaining: E(100_000) },
      { who: u2, total: E(4_000_000), allocated: E(3_800_000), remaining: E(200_000) },
      { who: u3, total: E(5_000_000), allocated: E(4_700_000), remaining: E(300_000) },
    ];
    for (const row of table) {
      expect(await v.allocation(SEED, row.who.address)).to.equal(row.total);
      expect(await v.credited(SEED, row.who.address)).to.equal(row.allocated);
      expect(await v.allocation(SEED, row.who.address) - await v.credited(SEED, row.who.address))
        .to.equal(row.remaining);
    }
    expect(await v.groupAssigned(SEED)).to.equal(E(12_000_000));

    // The category unlocks another 600,000.
    await burn(enc, deployer, burnForSeed(E(600_000)));
    expect(await v.pendingPool(SEED)).to.equal(E(600_000));

    // A: 600,000 x 3/12 = 150,000 but only 100,000 of room  → 100,000
    // B: 600,000 x 4/12 = 200,000, exactly its room         → 200,000
    // C: 600,000 x 5/12 = 250,000, within its room          → 250,000
    const preview = await v.previewDistribution(SEED);
    expect(preview.amounts[0]).to.equal(E(100_000));
    expect(preview.amounts[1]).to.equal(E(200_000));
    expect(preview.amounts[2]).to.equal(E(250_000));
    expect(preview.leftover).to.equal(E(50_000));

    await expect(v.connect(operator).distribute(SEED)).to.changeTokenBalances(
      enc, [u1, u2, u3], [E(100_000), E(200_000), E(250_000)],
    );

    // Distributed 550,000; the undistributed 50,000 is kept, not lost.
    expect(await v.pendingPool(SEED)).to.equal(E(50_000));

    // ...and it is added to the round's unlock at the next distribution: only C
    // still has room, so the whole 50,000 goes there and the round closes at cap.
    await v.connect(operator).distribute(SEED);
    expect(await paid(v, SEED, u3)).to.equal(E(5_000_000));
    expect(await v.pendingPool(SEED)).to.equal(0n);
    const total = (await paid(v, SEED, u1)) + (await paid(v, SEED, u2)) + (await paid(v, SEED, u3));
    expect(total).to.equal(E(12_000_000));
  });
});

describe("Spec conformance — Issue 1 and Issue 2 must be gone", () => {
  it("Issue 1: an investor's amount cannot depend on when anyone acts", async () => {
    const { enc, v, deployer, operator, u1, u2, u3 , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [u1.address, u2.address, u3.address],
      [E(2_000_000), E(2_000_000), E(2_000_000)], [team.address, team.address, team.address], true);
    await burn(enc, deployer, burnForSeed(E(1_200_000)));

    // There is no per-investor action to order: nobody can pull, ever.
    for (const who of [u1, u2, u3]) {
      await expect(v.connect(who).claim(SEED))
        .to.be.revertedWithCustomError(v, "OperatorDistributedRound").withArgs(SEED);
    }
    await expect(v.connect(operator).distribute(SEED)).to.changeTokenBalances(
      enc, [u1, u2, u3], [E(400_000), E(400_000), E(400_000)],
    );
  });

  it("Issue 2: nobody can shrink another investor's share by acting repeatedly", async () => {
    const { enc, v, deployer, operator, u1, u2 , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [u1.address, u2.address], [E(2_000_000), E(2_000_000)], [team.address, team.address], true);
    await burn(enc, deployer, burnForSeed(E(1_000_000)));
    await v.connect(operator).distribute(SEED);

    // u1 hammers every entry point; u2's position is untouched.
    for (let i = 0; i < 5; i++) {
      await expect(v.connect(u1).claim(SEED))
        .to.be.revertedWithCustomError(v, "OperatorDistributedRound").withArgs(SEED);
      await expect(v.connect(u1).claimAll())
        .to.be.revertedWithCustomError(v, "NothingToClaim");
      await expect(v.connect(operator).distribute(SEED))
        .to.be.revertedWithCustomError(v, "NothingToDistribute").withArgs(SEED);
    }
    expect(await enc.balanceOf(u1.address)).to.equal(E(500_000));
    expect(await enc.balanceOf(u2.address)).to.equal(E(500_000));
  });
});

describe("Spec conformance — the operator's limited powers (proposal §2.1)", () => {
  it("may trigger a distribution when burn has unlocked more", async () => {
    const { enc, v, deployer, operator, u1 , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [u1.address], [E(2_000_000)], [team.address], true);
    await burn(enc, deployer, burnForSeed(E(500_000)));
    await expect(v.connect(operator).distribute(SEED)).to.changeTokenBalance(enc, u1, E(500_000));
  });

  it("MAY onboard a new investor, but may NOT change an existing allocation", async () => {
    const { v, operator, u1 , team } = await loadFixture(fixture);
    await expect(v.connect(operator).addBeneficiaries(SEED, [u1.address], [E(2_000_000)], [team.address], true))
      .to.emit(v, "AllocationSet").withArgs(SEED, u1.address, 0, E(2_000_000));
    await expect(v.connect(operator).addBeneficiaries(SEED, [u1.address], [E(5_000_000)], [team.address], true))
      .to.be.revertedWithCustomError(v, "AllocationAlreadySet").withArgs(SEED, u1.address);
  });

  it("may NOT distribute more than has been unlocked", async () => {
    const { enc, v, deployer, operator, u1 , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [u1.address], [E(2_000_000)], [team.address], true);
    await burn(enc, deployer, burnForSeed(E(500_000)));

    await v.connect(operator).distribute(SEED);
    expect(await enc.balanceOf(u1.address)).to.equal(E(500_000));
    // No further burn → no further ENC, however many times it is pressed.
    for (let i = 0; i < 3; i++) {
      await expect(v.connect(operator).distribute(SEED))
        .to.be.revertedWithCustomError(v, "NothingToDistribute").withArgs(SEED);
    }
    expect(await enc.balanceOf(u1.address)).to.equal(E(500_000));
  });

  it("may NOT pay an investor beyond their Total Allocation", async () => {
    const { enc, v, deployer, operator, u1 , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [u1.address], [E(2_000_000)], [team.address], true);
    await burn(enc, deployer, E(30_000_000)); // SEED fully unlocked (12,000,000)
    await v.connect(operator).distribute(SEED);
    expect(await enc.balanceOf(u1.address)).to.equal(E(2_000_000));
    expect(await v.pendingPool(SEED)).to.equal(E(10_000_000)); // the unassigned cap stays put
  });

  it("may NOT touch the burn-based unlock mechanism (no setter exists)", async () => {
    const { v } = await loadFixture(fixture);
    const fns = v.interface.fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => f.name);
    for (const forbidden of ["setGroupCap", "setPhaseRates", "setUnlock", "setAllocation", "setClaimed"]) {
      expect(fns).to.not.include(forbidden);
    }
  });

  it("is never an intermediate holder — ENC goes straight to the investors", async () => {
    const { enc, v, deployer, operator, u1, u2 , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [u1.address, u2.address], [E(2_000_000), E(2_000_000)], [team.address, team.address], true);
    await burn(enc, deployer, burnForSeed(E(1_000_000)));
    await expect(v.connect(operator).distribute(SEED)).to.changeTokenBalances(
      enc, [u1, u2, operator], [E(500_000), E(500_000), 0n],
    );
    expect(await enc.balanceOf(operator.address)).to.equal(0n);
  });
});

describe("Spec conformance — the 2026-08-10 meeting", () => {
  it("one button pays every investor of the round at once", async () => {
    const { enc, v, deployer, operator, u1, u2, u3 , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [u1.address, u2.address, u3.address],
      [E(2_000_000), E(2_000_000), E(2_000_000)], [team.address, team.address, team.address], true);
    await burn(enc, deployer, burnForSeed(E(1_200_000)));

    const receipt = await (await v.connect(operator).distribute(SEED)).wait();
    const claimedEvents = receipt!.logs.filter((l: any) => l.fragment?.name === "Claimed");
    expect(claimedEvents.length).to.equal(3); // all three, one transaction
  });

  it("manual distribution applies to SEED and PRIVATE only", async () => {
    const { v } = await loadFixture(fixture);
    for (const r of [TEAM, TREASURY, PUBLIC]) {
      await expect(v.distribute(r)).to.be.revertedWithCustomError(v, "UnknownRound").withArgs(r);
    }
    await expect(v.distribute(SEED)).to.not.be.revertedWithCustomError(v, "UnknownRound");
    await expect(v.distribute(PRIVATE)).to.not.be.revertedWithCustomError(v, "UnknownRound");
  });

  it("investors can be onboarded gradually, never past the round cap", async () => {
    const { v, u1, u2, u3 , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [u1.address], [E(5_000_000)], [team.address], true);
    await v.addBeneficiaries(SEED, [u2.address], [E(6_000_000)], [team.address], true);
    expect(await v.groupAssigned(SEED)).to.equal(E(11_000_000));

    await expect(v.addBeneficiaries(SEED, [u3.address], [E(1_000_001)], [team.address], true))
      .to.be.revertedWithCustomError(v, "AllocationCapExceeded")
      .withArgs(SEED, E(12_000_001), CAP_SEED);

    await v.addBeneficiaries(SEED, [u3.address], [E(1_000_000)], [team.address], true);
    expect(await v.groupAssigned(SEED)).to.equal(CAP_SEED);
  });
});
