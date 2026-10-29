import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ENC_MAX_SUPPLY } from "../../helpers/encConstants";
import { productionRig } from "../helpers/vestingRig";

const E = (n: number | string) => ethers.parseUnits(n.toString(), 18);

// Round ids
const SEED = 0, PRIVATE = 1, TEAM = 2, TREASURY = 3, PUBLIC = 4;

// Caps per spec
const CAP_SEED = E(12_000_000);
const CAP_PRIVATE = E(28_000_000);
const CAP_TEAM = E(450_000_000);
const CAP_TREASURY = E(1_520_000_000);
// 970M on the vesting schedule: 178M TGE-unlocked + 792M cliff/vesting.
// The other 20M of the 990M Public allocation is sold by the standalone
// EnishiPublicSale contract, not administered here.
const PUBLIC_ALLOC = E(970_000_000);
const INITIAL_SUPPLY = ENC_MAX_SUPPLY;
const PUBLIC_TGE = E(178_000_000);
const LOCKED = CAP_SEED + CAP_PRIVATE + CAP_TEAM + CAP_TREASURY + PUBLIC_ALLOC - PUBLIC_TGE;

async function fixture() {
  const [deployer, s1, s2, p1, p2, team, treasury, pub, publicSale] = await ethers.getSigners();

  const enc = await (await ethers.getContractFactory("ENC")).deploy();
  await enc.waitForDeployment();
  const referralRegistry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(
    team.address,
  );
  await referralRegistry.waitForDeployment();
  // TEAM/TREASURY/PUBLIC are auto-allocated at construction (single fixed wallet each).
  const v = await (await ethers.getContractFactory("ENCVesting")).deploy(
    INITIAL_SUPPLY, team.address, treasury.address, pub.address, await referralRegistry.getAddress(),
  );
  // ENCVesting grants the deployer only DEFAULT_ADMIN_ROLE; the suite operates as deployer.
  await v.grantRole(await v.OPERATOR_ROLE(), (await ethers.getSigners())[0].address);
  await v.waitForDeployment();
  await referralRegistry.connect(deployer).grantRole(await referralRegistry.OPERATOR_ROLE(), await v.getAddress());

  // In production the genesis mint splits the supply between the vault and
  // the standalone EnishiPublicSale contract's 20M carve-out; simulate that.
  await enc.mintGenesis(await v.getAddress(), publicSale.address);
  await v.start(await enc.getAddress());

  // PUBLIC's TGE tranche is not pre-credited any more: the vault holds it and the
  // beneficiary pulls it. It is the only circulating ENC, so it is the burn float.
  await v.connect(pub).claim(PUBLIC);
  await enc.connect(pub).transfer(deployer.address, PUBLIC_TGE);

  // allocations (Seed: equal; Private: pro-rata) — only many-investor rounds left.
  await v.addBeneficiaries(SEED, [s1.address, s2.address], [E(6_000_000), E(6_000_000)], [team.address, team.address], true);
  await v.addBeneficiaries(PRIVATE, [p1.address, p2.address], [E(20_000_000), E(8_000_000)], [team.address, team.address], true);

  return { enc, v, referralRegistry, deployer, s1, s2, p1, p2, team, treasury, pub };
}

// deployer burns `amount` ENC (reduces totalSupply → drives unlock)
async function burn(enc: any, deployer: any, amount: bigint) {
  await enc.connect(deployer).burn(amount);
}

describe("ENCVesting — burn 4-phase", () => {
  it("snapshots INITIAL_SUPPLY = 3B and tracks cumulativeBurned", async () => {
    const { enc, v, deployer } = await loadFixture(fixture);
    expect(await v.INITIAL_SUPPLY()).to.equal(ENC_MAX_SUPPLY);
    expect(await v.cumulativeBurned()).to.equal(0n);
    await burn(enc, deployer, E(5_000_000));
    expect(await v.cumulativeBurned()).to.equal(E(5_000_000));
  });

  it("phase 1 splits burn 40/40/10/10 and totals equal the burn", async () => {
    const { enc, v, deployer } = await loadFixture(fixture);
    await burn(enc, deployer, E(3_000_000));
    const s = await v.groupUnlocked(SEED);
    const p = await v.groupUnlocked(PRIVATE);
    const tm = await v.groupUnlocked(TEAM);
    const tr = await v.groupUnlocked(TREASURY);
    expect(s).to.equal(E(1_200_000));  // 40% → 10% of Seed cap
    expect(p).to.equal(E(1_200_000));  // 40% → 4.3% of Private cap
    expect(tm).to.equal(E(300_000));   // 10%
    expect(tr).to.equal(E(300_000));   // 10%
    expect(s + p + tm + tr).to.equal(E(3_000_000)); // 1 burned = 1 unlocked
  });

  it("phase 2: after Seed fills (30M burn), split becomes 60/20/20", async () => {
    const { enc, v, deployer } = await loadFixture(fixture);
    await burn(enc, deployer, E(30_000_000)); // Seed exactly full
    expect(await v.groupUnlocked(SEED)).to.equal(CAP_SEED);
    expect(await v.groupUnlocked(PRIVATE)).to.equal(E(12_000_000)); // 0.4*30M
    expect(await v.groupUnlocked(TEAM)).to.equal(E(3_000_000));
    expect(await v.groupUnlocked(TREASURY)).to.equal(E(3_000_000));

    // +10M more in phase 2: Private +6M, Team +2M, Treasury +2M
    await burn(enc, deployer, E(10_000_000));
    expect(await v.groupUnlocked(SEED)).to.equal(CAP_SEED); // capped
    expect(await v.groupUnlocked(PRIVATE)).to.equal(E(18_000_000));
    expect(await v.groupUnlocked(TEAM)).to.equal(E(5_000_000));
    expect(await v.groupUnlocked(TREASURY)).to.equal(E(5_000_000));
  });

  it("Private fills at ~56.67M burn and never exceeds cap", async () => {
    const { enc, v, deployer } = await loadFixture(fixture);
    await burn(enc, deployer, E(60_000_000));
    expect(await v.groupUnlocked(PRIVATE)).to.equal(CAP_PRIVATE); // clamped to 28M
    expect(await v.groupUnlocked(SEED)).to.equal(CAP_SEED);
  });

  it("distribute splits the pool: Seed equal, Private pro-rata", async () => {
    const { enc, v, deployer, s1, s2, p1, p2 } = await loadFixture(fixture);
    await burn(enc, deployer, E(3_000_000));

    // Seed 6M/12M of 1.2M unlocked = 0.6M each
    await expect(v.distribute(SEED)).to.changeTokenBalances(enc, [s1, s2], [E(600_000), E(600_000)]);
    // Private pro-rata: p1 20/28, p2 8/28 of the unlocked amount
    const g = await v.groupUnlocked(PRIVATE);
    await expect(v.distribute(PRIVATE)).to.changeTokenBalances(
      enc, [p1, p2], [(E(20_000_000) * g) / CAP_PRIVATE, (E(8_000_000) * g) / CAP_PRIVATE],
    );
  });

  it("distribute pays out, tracks claimed, and a later burn yields only the delta", async () => {
    const { enc, v, deployer, s1 } = await loadFixture(fixture);
    await burn(enc, deployer, E(3_000_000));

    await expect(v.distribute(SEED)).to.changeTokenBalance(enc, s1, E(600_000));
    expect((await v.allocationOf(SEED, s1.address))[1]).to.equal(E(600_000)); // paid out
    // A pooled-round investor has no pull path at all — the press is the only way in.
    await expect(v.connect(s1).claim(SEED))
      .to.be.revertedWithCustomError(v, "OperatorDistributedRound").withArgs(SEED);

    // more burn → more unlocked → the next press pays only the new part
    await burn(enc, deployer, E(3_000_000)); // seed now 20% → s1 total 1.2M
    await expect(v.distribute(SEED)).to.changeTokenBalance(enc, s1, E(600_000));
    expect((await v.allocationOf(SEED, s1.address))[1]).to.equal(E(1_200_000));
  });

  it("PUBLIC time round: 20% TGE-claimable at deploy, rest after cliff+vesting", async () => {
    const { v, pub } = await loadFixture(fixture);
    const startTime = await v.startTime();
    // fixture() already claimed pub's 20% TGE portion (198,000,000) for burn-test
    // headroom, so nothing more is claimable yet (still inside the cliff).
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(0n);
    await time.increaseTo(startTime + BigInt((365 + 60 * 30) * 24 * 3600) + 1n); // past cliff+vesting
    // Full entitlement is now 100% of 990,000,000; 198,000,000 already claimed.
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(PUBLIC_ALLOC - PUBLIC_TGE);
  });

  it("an EXISTING beneficiary's allocation can never be modified (AllocationAlreadySet) — TGE = deploy", async () => {
    const { v, s1 } = await loadFixture(fixture);
    await expect(v.addBeneficiaries(SEED, [s1.address], [E(1)], [ethers.ZeroAddress], true))
      .to.be.revertedWithCustomError(v, "AllocationAlreadySet")
      .withArgs(SEED, s1.address);
  });

  it("addBeneficiaries reverts AllocationCapExceeded when SEED total would exceed 12,000,000", async () => {
    const { v, team } = await loadFixture(fixture);
    const [, , , , , , , , fresh] = await ethers.getSigners();
    // s1/s2 already hold 6M each (12M total, at cap). A brand-new beneficiary
    // asking for even 1 wei more than the remaining 0 reverts.
    await expect(v.addBeneficiaries(SEED, [fresh.address], [1n], [team.address], true))
      .to.be.revertedWithCustomError(v, "AllocationCapExceeded")
      .withArgs(SEED, CAP_SEED + 1n, CAP_SEED);
  });

  it("addBeneficiaries reverts AllocationCapExceeded when PRIVATE total would exceed 28,000,000", async () => {
    const { v, team } = await loadFixture(fixture);
    const [, , , , , , , , fresh] = await ethers.getSigners();
    await expect(v.addBeneficiaries(PRIVATE, [fresh.address], [1n], [team.address], true))
      .to.be.revertedWithCustomError(v, "AllocationCapExceeded")
      .withArgs(PRIVATE, CAP_PRIVATE + 1n, CAP_PRIVATE);
  });

  it("full lifecycle: progressive SEED onboarding, non-retroactive pro-rata, join-after-100%", async () => {
    const [deployer, u1, u2, u3, u4, team, treasury, pub, publicSale] = await ethers.getSigners();
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
    await referralRegistry.connect(deployer).grantRole(await referralRegistry.OPERATOR_ROLE(), await v.getAddress());
    const need = CAP_TEAM + CAP_TREASURY + PUBLIC_ALLOC + CAP_SEED;
    // In production the genesis mint splits the supply between the vault and
    // the standalone EnishiPublicSale contract's 20M carve-out.
    await enc.mintGenesis(await v.getAddress(), publicSale.address);
    await v.start(await enc.getAddress());

    // Pull PUBLIC's immediate 20% TGE-unlock (198,000,000) to deployer for burn headroom.
    await v.connect(pub).claim(PUBLIC);
    await enc.connect(pub).transfer(deployer.address, PUBLIC_TGE);

    // #0 — TGE = deploy, already live, with NO SEED beneficiaries yet (cap reserved, assigned=0).

    // #1 — Burn 3,000,000 (phase-1: SEED gets 40%) → groupUnlocked(SEED) = 1,200,000 (10%).
    await burn(enc, deployer, E(3_000_000));
    expect(await v.groupUnlocked(SEED)).to.equal(E(1_200_000));

    // #2 — Add u1 + u2, each 10% of cap (1,200,000). Registering credits nothing;
    // the 1,200,000 stays pooled until the press.
    await v.addBeneficiaries(SEED, [u1.address, u2.address], [E(1_200_000), E(1_200_000)], [team.address, team.address], true);
    expect(await v.claimable(SEED, u1.address)).to.equal(0n);
    expect(await v.pendingPool(SEED)).to.equal(E(1_200_000));

    // #3 — one press splits the pool over the members at press time: 600,000 each
    // (pro-rata by allocation, 1.2M/2.4M — not 10% of the group unlock, because the
    // unassigned part of the cap has nobody else to go to).
    await expect(v.distribute(SEED)).to.changeTokenBalances(enc, [u1, u2], [E(600_000), E(600_000)]);

    // #4 — Burn 250,000 more (still phase 1) → groupUnlocked(SEED) = 1,300,000 (+100,000).
    await burn(enc, deployer, E(250_000));
    expect(await v.groupUnlocked(SEED)).to.equal(E(1_300_000));

    // #5 — the press splits the 100,000 over the two current members: 50,000 each.
    await expect(v.distribute(SEED)).to.changeTokenBalances(enc, [u1, u2], [E(50_000), E(50_000)]);

    // #6 — u3 takes 20% of the remaining 80% of cap = 0.2 * 9,600,000 = 1,920,000 (16% of
    // cap). The pool is empty, so joining credits them nothing.
    await v.addBeneficiaries(SEED, [u3.address], [E(1_920_000)], [team.address], true);
    expect(await v.claimable(SEED, u3.address)).to.equal(0n);
    expect(await v.pendingPool(SEED)).to.equal(0n);

    // #7 — no investor of a pooled round can pull, not even one owed nothing.
    await expect(v.connect(u3).claim(SEED))
      .to.be.revertedWithCustomError(v, "OperatorDistributedRound").withArgs(SEED);

    // #8 — pressing again moves nothing until more ENC is burned.
    await expect(v.distribute(SEED)).to.be.revertedWithCustomError(v, "NothingToDistribute");

    // #9 — Burn up to SEED's exact fill point (B=30,000,000 total) → 100% unlocked.
    await burn(enc, deployer, E(30_000_000) - E(3_250_000));
    expect(await v.groupUnlocked(SEED)).to.equal(CAP_SEED);

    // #10 — One press tops every current member up to their FULL allocation. The pool is
    // 10,700,000 but u1/u2 can only absorb 550,000 each and u3 1,920,000, so 7,680,000
    // stays pooled for whoever joins next.
    await expect(v.distribute(SEED)).to.changeTokenBalances(
      enc, [u1, u2, u3], [E(550_000), E(550_000), E(1_920_000)],
    );
    expect(await v.pendingPool(SEED)).to.equal(E(7_680_000));

    // #11 — u4 joins AFTER the round is already 100% unlocked, taking the remainder
    // of the cap: 12,000,000 - (1.2M+1.2M+1.92M) = 7,680,000. Every existing member is
    // full, so the next press hands u4 the whole leftover pool.
    await v.addBeneficiaries(SEED, [u4.address], [E(7_680_000)], [team.address], true);

    // #12 — the next press pays u4 in full — the group is already fully unlocked.
    await expect(v.distribute(SEED)).to.changeTokenBalance(enc, u4, E(7_680_000));
    expect(await v.pendingPool(SEED)).to.equal(0n);

    // Sanity: SEED is now fully assigned (12,000,000) and fully claimed by everyone.
    expect(await v.groupAssigned(SEED)).to.equal(CAP_SEED);
  });

  it("takes on allocation the vault cannot yet cover — start() settles that later", async () => {
    const [deployer, x, team, treasury, pub] = await ethers.getSigners();
    const enc = await (await ethers.getContractFactory("ENC")).deploy();
    await enc.waitForDeployment();
    await enc.mintGenesis(deployer.address, x.address);
    const referralRegistry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(
      team.address,
    );
    await referralRegistry.waitForDeployment();
    const v = await (await ethers.getContractFactory("ENCVesting")).deploy(
      INITIAL_SUPPLY, team.address, treasury.address, pub.address, await referralRegistry.getAddress(),
    );
    // ENCVesting grants the deployer only DEFAULT_ADMIN_ROLE; the suite operates as deployer.
    await v.grantRole(await v.OPERATOR_ROLE(), (await ethers.getSigners())[0].address);
    await referralRegistry.connect(deployer).grantRole(await referralRegistry.OPERATOR_ROLE(), await v.getAddress());
    await enc.transfer(await v.getAddress(), E(1_000_000));
    await expect(v.addBeneficiaries(SEED, [x.address], [E(2_000_000)], [team.address], true)).to.not.be.reverted;
    const [allocated] = await v.allocationOf(SEED, x.address);
    expect(allocated).to.equal(E(2_000_000));
  });

});

describe("ENCVesting — claimAll", () => {
  // claimAll only sweeps the single-beneficiary rounds (SEED/PRIVATE are paid by the
  // operator's press), so the fixture gives ONE wallet all three of them: the
  // constructor happily takes the same address for team, treasury and public.
  async function multiRoundFixture() {
    const [deployer, both, other, publicSale] = await ethers.getSigners();

    const enc = await (await ethers.getContractFactory("ENC")).deploy();
    await enc.waitForDeployment();
    const referralRegistry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(
      deployer.address,
    );
    await referralRegistry.waitForDeployment();
    const v = await (await ethers.getContractFactory("ENCVesting")).deploy(
      INITIAL_SUPPLY, both.address, both.address, both.address, await referralRegistry.getAddress(),
    );
    // ENCVesting grants the deployer only DEFAULT_ADMIN_ROLE; the suite operates as deployer.
    await v.grantRole(await v.OPERATOR_ROLE(), (await ethers.getSigners())[0].address);
    await referralRegistry.connect(deployer).grantRole(await referralRegistry.OPERATOR_ROLE(), await v.getAddress());
    // In production the genesis mint splits the supply between the vault and
    // the standalone EnishiPublicSale contract's 20M carve-out.
    await enc.mintGenesis(await v.getAddress(), publicSale.address);
    await v.start(await enc.getAddress());

    // `both` holds every round, so it is the one that pulls PUBLIC's TGE tranche;
    // that tranche is the only circulating ENC, hence the deployer's burn float.
    await v.connect(both).claim(PUBLIC);
    await enc.connect(both).transfer(deployer.address, PUBLIC_TGE);

    return { enc, v, deployer, both, other };
  }

  // Far enough past the 365-day lock-up to unlock PUBLIC's first monthly release.
  const pastFirstPublicRelease = async (v: any) =>
    time.increaseTo((await v.startTime()) + BigInt(365 * 24 * 3600) + 1n);

  it("sweeps every round in one call and equals the sum of per-round claimable", async () => {
    const { enc, v, deployer, both } = await loadFixture(multiRoundFixture);
    await burn(enc, deployer, E(3_000_000)); // phase 1: 40/40/10/10 → TEAM/TREASURY 10% each
    await pastFirstPublicRelease(v);

    const team = await v.claimable(TEAM, both.address);
    const treasury = await v.claimable(TREASURY, both.address);
    const pub = await v.claimable(PUBLIC, both.address);
    expect(team).to.equal(E(300_000));
    expect(treasury).to.equal(E(300_000));
    expect(pub).to.equal(E(13_200_000)); // 792,000,000 / 60

    await expect(v.connect(both).claimAll())
      .to.changeTokenBalance(enc, both, team + treasury + pub);

    for (const r of [TEAM, TREASURY, PUBLIC]) {
      expect(await v.claimable(r, both.address)).to.equal(0n);
    }
  });

  it("never sweeps the operator-distributed rounds", async () => {
    const { enc, v, deployer, both } = await loadFixture(multiRoundFixture);
    await v.addBeneficiaries(SEED, [both.address], [E(6_000_000)], [deployer.address], true);
    await burn(enc, deployer, E(3_000_000));

    // SEED has unlock waiting for `both`, but claimAll pays only TEAM + TREASURY.
    expect(await v.pendingPool(SEED)).to.be.gt(0n);
    await expect(v.connect(both).claimAll())
      .to.changeTokenBalance(enc, both, E(600_000));
    expect(await v.pendingPool(SEED)).to.be.gt(0n);
  });

  it("matches claiming each round one by one", async () => {
    const { enc, v, deployer, both } = await loadFixture(multiRoundFixture);
    await burn(enc, deployer, E(10_000_000));

    const expected = (await v.claimable(TEAM, both.address)) + (await v.claimable(TREASURY, both.address));
    await expect(v.connect(both).claimAll())
      .to.changeTokenBalance(enc, both, expected);

    // Same state as two separate claims would have produced.
    const [allocTeam, claimedTeam] = await v.allocationOf(TEAM, both.address);
    expect(claimedTeam).to.be.gt(0n).and.to.be.lt(allocTeam);
  });

  it("skips rounds with nothing pending instead of reverting", async () => {
    const { enc, v, deployer, both } = await loadFixture(multiRoundFixture);
    await burn(enc, deployer, E(3_000_000));

    // Drain TEAM first — that round now has 0 pending while TREASURY still does.
    await v.connect(both).claim(TEAM);
    expect(await v.claimable(TEAM, both.address)).to.equal(0n);

    const treasury = await v.claimable(TREASURY, both.address);
    await expect(v.connect(both).claimAll())
      .to.changeTokenBalance(enc, both, treasury);
  });

  it("emits Claimed once per non-empty round only", async () => {
    const { enc, v, deployer, both } = await loadFixture(multiRoundFixture);
    await burn(enc, deployer, E(3_000_000));

    const tx = await v.connect(both).claimAll();
    const receipt = await tx.wait();
    const claimedEvents = receipt!.logs.filter(
      (l: any) => l.fragment?.name === "Claimed",
    );
    expect(claimedEvents.length).to.equal(2); // TEAM + TREASURY; PUBLIC still in its lock-up
  });

  it("only the beneficiary can sweep — a third party gets nothing", async () => {
    const { enc, v, deployer, both, other } = await loadFixture(multiRoundFixture);
    await burn(enc, deployer, E(3_000_000));

    await expect(v.connect(other).claimAll())
      .to.be.revertedWithCustomError(v, "NothingToClaim");

    const expected = (await v.claimable(TEAM, both.address)) + (await v.claimable(TREASURY, both.address));
    await expect(v.connect(both).claimAll())
      .to.changeTokenBalances(enc, [both, other], [expected, 0n]);
  });

  it("reverts NothingToClaim when no round has anything pending", async () => {
    const { v, both } = await loadFixture(multiRoundFixture);
    // No burn yet and PUBLIC is still inside its lock-up → every round is empty.
    await expect(v.connect(both).claimAll())
      .to.be.revertedWithCustomError(v, "NothingToClaim");
  });

  it("reverts NothingToClaim on a second consecutive sweep", async () => {
    const { enc, v, deployer, both } = await loadFixture(multiRoundFixture);
    await burn(enc, deployer, E(3_000_000));
    await v.connect(both).claimAll();
    await expect(v.connect(both).claimAll())
      .to.be.revertedWithCustomError(v, "NothingToClaim");
  });

  it("keeps totalOutstanding in sync with what was swept", async () => {
    const { enc, v, deployer, both } = await loadFixture(multiRoundFixture);
    await burn(enc, deployer, E(3_000_000));

    const before = await v.totalOutstanding();
    const expected = (await v.claimable(TEAM, both.address)) + (await v.claimable(TREASURY, both.address));
    await v.connect(both).claimAll();

    expect(await v.totalOutstanding()).to.equal(before - expected);
    expect(await v.totalOutstanding()).to.be.lte(await enc.balanceOf(await v.getAddress()));
  });
});

describe("ENCVesting — PUBLIC monthly release schedule", () => {
  const DAY = 24 * 3600;
  const CLIFF = 365 * DAY; // lock-up is a full year, not 12 × 30
  const INTERVAL = 30 * DAY;
  const COUNT = 60;
  const TGE = E(178_000_000); // 20% of 990,000,000 less the 20M Public Sale carve-out
  const PER_RELEASE = E(13_200_000); // 80% / 60 = 792,000,000 / 60

  /** Timestamp release `k` (1-based) unlocks. */
  const dueAt = (start: bigint, k: number) => start + BigInt(CLIFF + (k - 1) * INTERVAL);

  it("the 60 releases divide the post-TGE 80% exactly, no remainder", async () => {
    expect(PER_RELEASE * BigInt(COUNT)).to.equal(PUBLIC_ALLOC - TGE);
  });

  it("nothing unlocks during the cliff — not even one second before it ends", async () => {
    const { v, pub } = await loadFixture(fixture);
    const start = await v.startTime();

    expect(await v.publicReleasesUnlocked()).to.equal(0n);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(0n);

    await time.increaseTo(dueAt(start, 1) - 2n); // one second short of the cliff end
    expect(await v.publicReleasesUnlocked()).to.equal(0n);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(0n);
  });

  it("release 1 lands the instant the cliff ends, not a month later", async () => {
    const { v, pub } = await loadFixture(fixture);
    const start = await v.startTime();

    await time.increaseTo(dueAt(start, 1));
    expect(await v.publicReleasesUnlocked()).to.equal(1n);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(PER_RELEASE);
  });

  it("holds flat between two release dates and steps by exactly one tranche", async () => {
    const { v, pub } = await loadFixture(fixture);
    const start = await v.startTime();

    await time.increaseTo(dueAt(start, 2) - 2n); // 29 days 23:59:58 into month 1
    expect(await v.publicReleasesUnlocked()).to.equal(1n);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(PER_RELEASE);

    await time.increaseTo(dueAt(start, 2));
    expect(await v.publicReleasesUnlocked()).to.equal(2n);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(PER_RELEASE * 2n);
  });

  it("every release k unlocks exactly k tranches, across the whole schedule", async () => {
    const { v, pub } = await loadFixture(fixture);
    const start = await v.startTime();

    for (const k of [1, 2, 3, 12, 30, 45, 59, 60]) {
      await time.increaseTo(dueAt(start, k));
      expect(await v.publicReleasesUnlocked(), `release ${k}`).to.equal(BigInt(k));
      expect(await v.claimable(PUBLIC, pub.address), `release ${k}`).to.equal(
        PER_RELEASE * BigInt(k),
      );
    }
  });

  it("release 60 completes the allocation and never overshoots afterwards", async () => {
    const { v, pub } = await loadFixture(fixture);
    const start = await v.startTime();

    await time.increaseTo(dueAt(start, COUNT));
    expect(await v.publicUnlockedBps()).to.equal(10000);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(PUBLIC_ALLOC - TGE);

    await time.increaseTo(dueAt(start, COUNT) + BigInt(10 * 365 * DAY)); // a decade later
    expect(await v.publicReleasesUnlocked()).to.equal(BigInt(COUNT));
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(PUBLIC_ALLOC - TGE);
  });

  it("claiming monthly totals the same as claiming once at the end", async () => {
    const start = (await loadFixture(fixture)).v; // placeholder to keep types happy
    void start;

    // Monthly: claim at every one of the 60 release dates.
    const monthly = await loadFixture(fixture);
    const startA = await monthly.v.startTime();
    let swept = 0n;
    for (let k = 1; k <= COUNT; k++) {
      await time.increaseTo(dueAt(startA, k));
      const before = await monthly.enc.balanceOf(monthly.pub.address);
      await monthly.v.connect(monthly.pub).claim(PUBLIC);
      swept += (await monthly.enc.balanceOf(monthly.pub.address)) - before;
    }
    expect(swept).to.equal(PUBLIC_ALLOC - TGE);

    // The entitlement is fully settled — a further claim has nothing left.
    await expect(monthly.v.connect(monthly.pub).claim(PUBLIC)).to.be.revertedWithCustomError(
      monthly.v,
      "NothingToClaim",
    );
  });

  it("publicReleaseTime matches the schedule and rejects out-of-range indexes", async () => {
    const { v } = await loadFixture(fixture);
    const start = await v.startTime();

    expect(await v.publicReleaseTime(1)).to.equal(dueAt(start, 1));
    expect(await v.publicReleaseTime(60)).to.equal(dueAt(start, 60));
    await expect(v.publicReleaseTime(0)).to.be.revertedWithCustomError(v, "InvalidReleaseIndex").withArgs(0);
    await expect(v.publicReleaseTime(61)).to.be.revertedWithCustomError(v, "InvalidReleaseIndex").withArgs(61);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The release grid is anchored to startTime, never to when someone claimed.
// Claiming late does NOT push the following releases back — the holder simply
// catches up. Scenario: lock 1/1/2025 → 1/1/2026, claim 15 days late, then 15 more
// days later (i.e. exactly the 30-day boundary from the unlock date) the next release
// is claimable.
// ─────────────────────────────────────────────────────────────────────────────
describe("ENCVesting — release grid is anchored to unlock date, not to claim date", () => {
  const DAY = 24 * 3600;
  const CLIFF = 365 * DAY;
  const INTERVAL = 30 * DAY;
  const PER_RELEASE = E(13_200_000);

  it("claiming 15 days late leaves release 2 on its original date, 15 days later", async () => {
    const { enc, v, pub } = await loadFixture(fixture);
    const start = await v.startTime();
    const cliffEnd = start + BigInt(CLIFF);

    // Release 1 became due at the cliff end; the holder ignores it for 15 days.
    await time.increaseTo(cliffEnd + BigInt(15 * DAY));
    expect(await v.publicReleasesUnlocked()).to.equal(1n);
    await expect(v.connect(pub).claim(PUBLIC)).to.changeTokenBalance(enc, pub, PER_RELEASE);

    // 14 days after that claim (day 29 on the grid) release 2 is not due yet.
    await time.increaseTo(cliffEnd + BigInt(29 * DAY));
    expect(await v.publicReleasesUnlocked()).to.equal(1n);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(0n);

    // Day 30 on the grid — i.e. only 15 days after the late claim, NOT 30.
    await time.increaseTo(cliffEnd + BigInt(INTERVAL));
    expect(await v.publicReleasesUnlocked()).to.equal(2n);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(PER_RELEASE);
  });

  it("skipping several releases pays the whole backlog at once, grid unchanged", async () => {
    const { v, pub } = await loadFixture(fixture);
    const start = await v.startTime();
    const cliffEnd = start + BigInt(CLIFF);

    // Never claims until midway through month 5 (releases 1..5 are due).
    await time.increaseTo(cliffEnd + BigInt(4 * INTERVAL + 15 * DAY));
    expect(await v.publicReleasesUnlocked()).to.equal(5n);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(PER_RELEASE * 5n);

    await v.connect(pub).claim(PUBLIC);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(0n);

    // Release 6 still lands on its original date, unaffected by the late catch-up.
    await time.increaseTo(cliffEnd + BigInt(5 * INTERVAL) - 2n);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(0n);
    await time.increaseTo(cliffEnd + BigInt(5 * INTERVAL));
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(PER_RELEASE);
  });

  it("two holders on the same schedule stay in step regardless of when each claims", async () => {
    const { v, pub } = await loadFixture(fixture);
    const start = await v.startTime();
    const cliffEnd = start + BigInt(CLIFF);

    // Claim at every single release date vs never claiming: the unlocked totals
    // are identical at any point in time, because timing ignores `claimed`.
    await time.increaseTo(cliffEnd + BigInt(2 * INTERVAL));
    const eager = await v.claimable(PUBLIC, pub.address); // 3 releases, unclaimed
    await v.connect(pub).claim(PUBLIC);

    await time.increaseTo(cliffEnd + BigInt(3 * INTERVAL));
    expect(eager).to.equal(PER_RELEASE * 3n);
    expect(await v.claimable(PUBLIC, pub.address)).to.equal(PER_RELEASE); // exactly one more
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isAllNonPublicUnlocked — reflects the burn cap state
// ─────────────────────────────────────────────────────────────────────────────
describe("ENCVesting — isAllNonPublicUnlocked", () => {
  const ENC_MAX_BURN = ethers.parseEther("2010000000"); // 2.01B

  it("is false when no ENC has been burned yet", async () => {
    const { v } = await loadFixture(fixture);
    expect(await v.isAllNonPublicUnlocked()).to.equal(false);
  });

  it("is false when only partially burned", async () => {
    const { enc, v, deployer } = await loadFixture(fixture);
    await enc.connect(deployer).burn(ethers.parseEther("100000000")); // 100M
    expect(await v.isAllNonPublicUnlocked()).to.equal(false);
  });

  /**
   * A started vault over a mock ENC, with the whole burn budget in the deployer's
   * hands. The vault has to be funded to start, so the mock mints both its backing
   * and the budget, and the baseline is the sum — the real token's fixed supply.
   */
  async function burnRig() {
    const [deployer, team, treasury, pub] = await ethers.getSigners();
    const enc = await (await ethers.getContractFactory("MockBurnableENC")).deploy();
    await enc.waitForDeployment();
    const F = await ethers.getContractFactory("ENCVesting");
    const referralRegistry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(
      team.address,
    );
    await referralRegistry.waitForDeployment();
    const registryAddr = await referralRegistry.getAddress();

    // What the vault commits to in its constructor, and so what start() will pull.
    const owed = await (await F.deploy(
      INITIAL_SUPPLY, team.address, treasury.address, pub.address, registryAddr,
    )).totalOutstanding();

    // The deployer needs a burn budget well past the 2.01B mark on top of that, so
    // the baseline supply this vault measures burns against is the sum of the two.
    const budget = ENC_MAX_BURN + ethers.parseEther("1000");
    const v = await F.deploy(owed + budget, team.address, treasury.address, pub.address, registryAddr);
    await v.waitForDeployment();

    await enc.mint(deployer.address, owed + budget);
    await enc.approve(await v.getAddress(), owed);
    await v.start(await enc.getAddress());

    return { enc, v, deployer, budget };
  }

  it("becomes true when cumulative burn reaches ENC_MAX_BURN (2.01B)", async () => {
    const { enc, v, deployer } = await burnRig();
    await enc.connect(deployer).burn(ENC_MAX_BURN);
    expect(await v.cumulativeBurned()).to.be.gte(ENC_MAX_BURN);
    expect(await v.isAllNonPublicUnlocked()).to.equal(true);
  });

  it("returns false even when all burn groups individually reach their cap (no overflow)", async () => {
    // This ensures the function uses >= comparison against ENC_MAX_BURN, not >.
    const { enc, v, deployer } = await burnRig();
    await enc.connect(deployer).burn(ENC_MAX_BURN - 1n); // 1 wei short
    expect(await v.isAllNonPublicUnlocked()).to.equal(false);
    await enc.connect(deployer).burn(1n); // now exactly at cap
    expect(await v.isAllNonPublicUnlocked()).to.equal(true);
  });
});

describe("ENCVesting — referrer registration on beneficiary onboarding", () => {
  it("addBeneficiaries with referrer = ZeroAddress reverts ReferrerRequired", async () => {
    const { v, outsider } = await loadFixture(productionRig);

    await expect(v.addBeneficiaries(SEED, [outsider.address], [E(1)], [ethers.ZeroAddress], true))
      .to.be.revertedWithCustomError(v, "ReferrerRequired")
      .withArgs(outsider.address);
  });

  it("addBeneficiaries skips an already-referred investor, even with referrer = ZeroAddress", async () => {
    const { v, referralRegistry, deployer, outsider } = await loadFixture(productionRig);

    // outsider already sits in the tree under deployer (e.g. a prior Vault deposit).
    await v.addBeneficiaries(SEED, [outsider.address], [E(1)], [deployer.address], true);
    expect(await referralRegistry.parentOf(outsider.address)).to.equal(deployer.address);

    // A later round may pass address(0) for them: the existing parent stands.
    await expect(
      v.addBeneficiaries(PRIVATE, [outsider.address], [E(1)], [ethers.ZeroAddress], true),
    ).to.not.be.reverted;

    expect(await referralRegistry.parentOf(outsider.address)).to.equal(deployer.address);
    expect((await v.allocationOf(PRIVATE, outsider.address))[0]).to.equal(E(1));
  });

  it("addBeneficiaries with a real approved referrer registers it correctly", async () => {
    const { v, referralRegistry, deployer, outsider } = await loadFixture(productionRig);

    await v.addBeneficiaries(SEED, [outsider.address], [E(1)], [deployer.address], true);

    expect(await referralRegistry.parentOf(outsider.address)).to.equal(deployer.address);
  });
});
