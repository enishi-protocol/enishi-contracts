import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ENC_MAX_SUPPLY } from "../../helpers/encConstants";

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

/// SEED takes 40% of every burn while all four groups are active, so this is the
/// burn needed to unlock `amount` for SEED.
const burnForSeed = (amount: bigint) => (amount * 10n) / 4n;

async function fixture() {
  const [deployer, operator, a, b, c, team, treasury, pub, publicSale] =
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

  return { enc, v, deployer, operator, a, b, c, team, treasury, pub };
}

const burn = (enc: any, deployer: any, amount: bigint) => enc.connect(deployer).burn(amount);

describe("ENCVesting — addBeneficiaries settleFirst flag", () => {
  it("settleFirst=true pays the pending pool to existing members before newcomers join", async () => {
    const { enc, v, deployer, a, b , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [a.address], [E(3_000_000)], [team.address], true);
    await burn(enc, deployer, burnForSeed(E(1_200_000)));
    expect(await v.pendingPool(SEED)).to.equal(E(1_200_000));

    // registering b settles first: a takes the whole 1,200,000 pool alone
    await expect(v.addBeneficiaries(SEED, [b.address], [E(9_000_000)], [team.address], true))
      .to.changeTokenBalance(enc, a, E(1_200_000));
    expect(await v.pendingPool(SEED)).to.equal(0n);
  });

  it("settleFirst=false leaves the pool for old and new members to share pro-rata", async () => {
    const { enc, v, deployer, operator, a, b , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [a.address], [E(3_000_000)], [team.address], true);
    await burn(enc, deployer, burnForSeed(E(1_200_000)));

    // registering b does NOT settle: nothing moves, the 1,200,000 stays pooled
    await expect(v.addBeneficiaries(SEED, [b.address], [E(9_000_000)], [team.address], false))
      .to.changeTokenBalance(enc, a, 0n);
    expect(await v.pendingPool(SEED)).to.equal(E(1_200_000));

    // the next press splits it 3M/9M over both members: 300,000 / 900,000
    await expect(v.connect(operator).distribute(SEED))
      .to.changeTokenBalances(enc, [a, b], [E(300_000), E(900_000)]);
  });
});

describe("ENCVesting — operator distribution (SEED/PRIVATE)", () => {
  it("splits pro-rata by allocation: 3M/4M/5M of the 12M cap, unlock 1,200,000", async () => {
    const { enc, v, deployer, operator, a, b, c , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [a.address, b.address, c.address], [E(3_000_000), E(4_000_000), E(5_000_000)], [team.address, team.address, team.address], true);

    await burn(enc, deployer, burnForSeed(E(1_200_000)));
    expect(await v.pendingPool(SEED)).to.equal(E(1_200_000));

    await expect(v.connect(operator).distribute(SEED)).to.changeTokenBalances(
      enc,
      [a, b, c],
      [E(300_000), E(400_000), E(500_000)], // 1.2M × 3/12, 4/12, 5/12
    );
    expect(await v.pendingPool(SEED)).to.equal(0n);
  });

  it("spec example: cap 12M, only 1M/2M/2M assigned, unlock 100,000 → 20,000/40,000/40,000", async () => {
    const { enc, v, deployer, operator, a, b, c , team } = await loadFixture(fixture);
    // Only 5,000,000 of the 12,000,000 cap is assigned, so the denominator is the
    // 5,000,000 actually held by investors — the whole 100,000 goes out, not 5/12 of it.
    await v.addBeneficiaries(SEED, [a.address, b.address, c.address], [E(1_000_000), E(2_000_000), E(2_000_000)], [team.address, team.address, team.address], true);
    expect(await v.groupAssigned(SEED)).to.equal(E(5_000_000));

    await burn(enc, deployer, burnForSeed(E(100_000)));
    expect(await v.pendingPool(SEED)).to.equal(E(100_000));

    await expect(v.connect(operator).distribute(SEED)).to.changeTokenBalances(
      enc,
      [a, b, c],
      [E(20_000), E(40_000), E(40_000)], // 100,000 x 1/5, 2/5, 2/5
    );
    // Nothing withheld: the full unlock was distributed.
    expect(await v.pendingPool(SEED)).to.equal(0n);
  });

  it("adding a user settles the round first, so the newcomers start from zero", async () => {
    const { enc, v, deployer, operator, a, b, c , team } = await loadFixture(fixture);

    // Unlock 1,200,000 while the round has no members yet — it waits in the pool.
    await burn(enc, deployer, burnForSeed(E(1_200_000)));
    expect(await v.pendingPool(SEED)).to.equal(E(1_200_000));

    // A registers first. There is nobody to settle onto yet, so the pool waits for A.
    await v.addBeneficiaries(SEED, [a.address], [E(3_000_000)], [team.address], true);
    expect(await v.pendingPool(SEED)).to.equal(E(1_200_000));

    // B and C join. A is now an existing member, so the whole 1,200,000 is settled
    // onto A before B and C are registered — they cannot reach back for a share.
    await expect(v.addBeneficiaries(SEED, [b.address, c.address], [E(4_000_000), E(5_000_000)], [team.address, team.address], true))
      .to.changeTokenBalances(enc, [a, b, c], [E(1_200_000), 0n, 0n]);
    expect(await v.pendingPool(SEED)).to.equal(0n);

    // From here the three split every new unlock 3/12 : 4/12 : 5/12.
    await burn(enc, deployer, burnForSeed(E(1_200_000)));
    await expect(v.connect(operator).distribute(SEED)).to.changeTokenBalances(
      enc,
      [a, b, c],
      [E(300_000), E(400_000), E(500_000)],
    );
    expect(await v.pendingPool(SEED)).to.equal(0n);

    // A later 600,000 unlock is split the same way.
    await burn(enc, deployer, burnForSeed(E(600_000)));
    await expect(v.connect(operator).distribute(SEED)).to.changeTokenBalances(
      enc,
      [a, b, c],
      [E(150_000), E(200_000), E(250_000)],
    );
  });

  it("§2.2 of the spec: a user at their allocation cap → leftover is retained, the next press splits it among the rest", async () => {
    const { enc, v, deployer, operator, a, b, c , team } = await loadFixture(fixture);

    // Reproduce the spec's state: A nearly full (100,000 left), B and C with plenty of room.
    await burn(enc, deployer, burnForSeed(E(2_900_000)));
    await v.addBeneficiaries(SEED, [a.address], [E(3_000_000)], [team.address], true);
    await v.connect(operator).distribute(SEED); // A is alone at the press → takes all 2,900,000
    expect(await v.claimable(SEED, a.address)).to.equal(0n); // paid out, remaining room = 100,000
    expect(await v.credited(SEED, a.address)).to.equal(E(2_900_000));

    await v.addBeneficiaries(SEED, [b.address, c.address], [E(4_000_000), E(5_000_000)], [team.address, team.address], true);
    expect(await v.pendingPool(SEED)).to.equal(0n);

    // The round unlocks another 600,000.
    await burn(enc, deployer, burnForSeed(E(600_000)));
    expect(await v.pendingPool(SEED)).to.equal(E(600_000));

    // Preview matches the spec's numbers before the press.
    const preview = await v.previewDistribution(SEED);
    expect(preview.amounts[0]).to.equal(E(100_000)); // A: 150,000 → clipped to the 100,000 of room
    expect(preview.amounts[1]).to.equal(E(200_000)); // B: 600,000 × 4/12
    expect(preview.amounts[2]).to.equal(E(250_000)); // C: 600,000 × 5/12
    expect(preview.leftover).to.equal(E(50_000));

    // Press 1: distributes 550,000, the 50,000 leftover stays in the pool.
    await expect(v.connect(operator).distribute(SEED)).to.changeTokenBalances(
      enc,
      [a, b, c],
      [E(100_000), E(200_000), E(250_000)],
    );
    expect(await v.pendingPool(SEED)).to.equal(E(50_000));

    // A has reached their Total Allocation.
    expect((await v.allocationOf(SEED, a.address))[1]).to.equal(E(3_000_000));

    // Press 2: the remaining 50,000 is split between B and C by 4:5 (A drops out of the denominator).
    await v.connect(operator).distribute(SEED);
    const paidB = (await v.allocationOf(SEED, b.address))[1];
    const paidC = (await v.allocationOf(SEED, c.address))[1];
    expect(paidB).to.equal(E(200_000) + (E(50_000) * 4n) / 9n);
    expect(paidC).to.equal(E(250_000) + (E(50_000) * 5n) / 9n);
    expect(await v.pendingPool(SEED)).to.be.lt(10n); // only rounding dust left
  });

  it("nobody receives more than their Total Allocation even when the whole budget is burned", async () => {
    const { enc, v, deployer, operator, a, b, c , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [a.address, b.address, c.address], [E(3_000_000), E(4_000_000), E(5_000_000)], [team.address, team.address, team.address], true);

    await burn(enc, deployer, E(30_000_000)); // SEED at its cap
    expect(await v.groupUnlocked(SEED)).to.equal(CAP_SEED);

    await v.connect(operator).distribute(SEED);
    expect(await enc.balanceOf(a.address)).to.equal(E(3_000_000));
    expect(await enc.balanceOf(b.address)).to.equal(E(4_000_000));
    expect(await enc.balanceOf(c.address)).to.equal(E(5_000_000));

    // Nothing left to press.
    await expect(v.connect(operator).distribute(SEED))
      .to.be.revertedWithCustomError(v, "NothingToDistribute").withArgs(SEED);
  });

  it("repeated claims cannot drain someone else's share (the old pool-draining bug)", async () => {
    const { enc, v, deployer, operator, a, b , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [a.address, b.address], [E(6_000_000), E(6_000_000)], [team.address, team.address], true);

    await burn(enc, deployer, burnForSeed(E(1_000_000)));
    await v.connect(operator).distribute(SEED); // 500,000 each

    expect(await enc.balanceOf(a.address)).to.equal(E(500_000));
    // A has no pull path at all, so there is no way to nibble at B's share.
    for (let i = 0; i < 5; i++) {
      await expect(v.connect(a).claim(SEED))
        .to.be.revertedWithCustomError(v, "OperatorDistributedRound").withArgs(SEED);
    }
    // Extra presses move nothing either — the round only pays what burn unlocked.
    for (let i = 0; i < 5; i++) {
      await expect(v.connect(operator).distribute(SEED))
        .to.be.revertedWithCustomError(v, "NothingToDistribute").withArgs(SEED);
    }
    expect(await enc.balanceOf(a.address)).to.equal(E(500_000));
    expect(await enc.balanceOf(b.address)).to.equal(E(500_000));
  });

  it("pressing more often changes nothing but a few wei of rounding dust", async () => {
    const balancesAfter = async (chunks: bigint[]) => {
      const { enc, v, deployer, operator, a, b, c , team } = await loadFixture(fixture);
      await v.addBeneficiaries(SEED, [a.address, b.address, c.address], [E(3_000_000), E(4_000_000), E(5_000_000)], [team.address, team.address, team.address], true);
      for (const chunk of chunks) {
        await burn(enc, deployer, chunk);
        await v.connect(operator).distribute(SEED);
      }
      return Promise.all([a, b, c].map((w) => enc.balanceOf(w.address)));
    };

    const oneShot = await balancesAfter([burnForSeed(E(1_200_000))]);
    const twoStep = await balancesAfter([burnForSeed(E(400_000)), burnForSeed(E(800_000))]);
    const sixStep = await balancesAfter(Array(6).fill(burnForSeed(E(200_000))));

    expect(oneShot).to.deep.equal([E(300_000), E(400_000), E(500_000)]);

    // Each press floors its per-member share and re-splits the remainder on the next
    // press, so staging the same burn can shift a couple of wei between members. The
    // totals still never exceed what was unlocked, and nobody passes their allocation.
    const ALLOCATIONS = [E(3_000_000), E(4_000_000), E(5_000_000)];
    for (const staged of [twoStep, sixStep]) {
      for (let i = 0; i < 3; i++) {
        const drift = staged[i] > oneShot[i] ? staged[i] - oneShot[i] : oneShot[i] - staged[i];
        expect(drift).to.be.lte(10n);
        expect(staged[i]).to.be.lte(ALLOCATIONS[i]);
      }
      expect(staged[0] + staged[1] + staged[2]).to.be.lte(E(1_200_000));
    }
  });

  it("an unlocked pool waits for the operator — the investor cannot pull it", async () => {
    const { enc, v, deployer, operator, a , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [a.address], [E(3_000_000)], [team.address], true);
    await burn(enc, deployer, burnForSeed(E(1_200_000)));

    // The unlock is pooled, but nothing is credited and no ENC has moved.
    expect(await v.pendingPool(SEED)).to.equal(E(1_200_000));
    expect(await v.claimable(SEED, a.address)).to.equal(0n);
    expect(await enc.balanceOf(a.address)).to.equal(0n);

    // A cannot pull it: the press is the only way ENC leaves the contract.
    await expect(v.connect(a).claim(SEED))
      .to.be.revertedWithCustomError(v, "OperatorDistributedRound").withArgs(SEED);

    await expect(v.connect(operator).distribute(SEED)).to.changeTokenBalance(enc, a, E(1_200_000));
  });

  it("adding users cannot exceed the round's cap", async () => {
    const { v, a, b , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [a.address], [E(11_000_000)], [team.address], true);
    await expect(v.addBeneficiaries(SEED, [b.address], [E(1_000_001)], [team.address], true))
      .to.be.revertedWithCustomError(v, "AllocationCapExceeded")
      .withArgs(SEED, E(12_000_001), CAP_SEED);

    // Landing exactly on the cap is allowed.
    await v.addBeneficiaries(SEED, [b.address], [E(1_000_000)], [team.address], true);
    expect(await v.groupAssigned(SEED)).to.equal(CAP_SEED);
  });

  it("add user: rejects duplicates, the zero address, zero amounts and length mismatches", async () => {
    const { v, a, b , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [a.address], [E(1_000_000)], [team.address], true);

    await expect(v.addBeneficiaries(SEED, [a.address], [E(1)], [team.address], true))
      .to.be.revertedWithCustomError(v, "AllocationAlreadySet").withArgs(SEED, a.address);
    await expect(v.addBeneficiaries(SEED, [ethers.ZeroAddress], [E(1)], [ethers.ZeroAddress], true))
      .to.be.revertedWithCustomError(v, "ZeroAddress");
    await expect(v.addBeneficiaries(SEED, [b.address], [0n], [team.address], true))
      .to.be.revertedWithCustomError(v, "ZeroAmount");
    await expect(v.addBeneficiaries(SEED, [b.address], [], [team.address], true))
      .to.be.revertedWithCustomError(v, "LengthMismatch");
    await expect(v.addBeneficiaries(SEED, [], [], [], true))
      .to.be.revertedWithCustomError(v, "EmptyInput");
  });

  it("only SEED/PRIVATE use the pool mechanism; TEAM/TREASURY/PUBLIC do not", async () => {
    const { v, a , team } = await loadFixture(fixture);
    for (const r of [TEAM, TREASURY, PUBLIC]) {
      await expect(v.addBeneficiaries(r, [a.address], [E(1)], [team.address], true))
        .to.be.revertedWithCustomError(v, "UnknownRound").withArgs(r);
      await expect(v.distribute(r)).to.be.revertedWithCustomError(v, "UnknownRound").withArgs(r);
      await expect(v.pendingPool(r)).to.be.revertedWithCustomError(v, "UnknownRound").withArgs(r);
    }
  });

  it("PRIVATE operates independently of SEED", async () => {
    const { enc, v, deployer, operator, a, b , team } = await loadFixture(fixture);
    await v.addBeneficiaries(PRIVATE, [a.address, b.address], [E(20_000_000), E(8_000_000)], [team.address, team.address], true);

    // Phase 1: PRIVATE also takes 40% of the burn.
    await burn(enc, deployer, E(3_000_000));
    expect(await v.pendingPool(PRIVATE)).to.equal(E(1_200_000));

    await expect(v.connect(operator).distribute(PRIVATE)).to.changeTokenBalances(
      enc,
      [a, b],
      [(E(1_200_000) * 20n) / 28n, (E(1_200_000) * 8n) / 28n],
    );
  });
});

describe("ENCVesting — operator role", () => {
  it("only OPERATOR_ROLE holders can press distribute", async () => {
    const { enc, v, deployer, operator, a, b , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [a.address], [E(3_000_000)], [team.address], true);
    await burn(enc, deployer, burnForSeed(E(1_000_000)));

    await expect(v.connect(b).distribute(SEED))
      .to.be.revertedWithCustomError(v, "AccessControlUnauthorizedAccount")
      .withArgs(b.address, await v.OPERATOR_ROLE());
    await expect(v.connect(operator).distribute(SEED)).to.not.be.reverted;
  });

  it("admin hands the operator role over and both changes emit events", async () => {
    const { v, deployer, operator, a } = await loadFixture(fixture);
    const role = await v.OPERATOR_ROLE();
    await expect(v.grantRole(role, a.address))
      .to.emit(v, "RoleGranted").withArgs(role, a.address, deployer.address);
    await expect(v.revokeRole(role, operator.address))
      .to.emit(v, "RoleRevoked").withArgs(role, operator.address, deployer.address);
    expect(await v.hasRole(role, a.address)).to.equal(true);
    expect(await v.hasRole(role, operator.address)).to.equal(false);

    await expect(v.connect(a).grantRole(role, deployer.address))
      .to.be.revertedWithCustomError(v, "AccessControlUnauthorizedAccount")
      .withArgs(a.address, await v.DEFAULT_ADMIN_ROLE());
  });

  it("the operator onboards investors but cannot rewrite one or pull ENC into their own wallet", async () => {
    const { enc, v, deployer, operator, a, b, c , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [a.address], [E(3_000_000)], [team.address], true);
    await burn(enc, deployer, burnForSeed(E(1_000_000)));

    // Onboarding a NEW investor is part of the operator's job. It settles the pool
    // onto the existing member (a) on the way in — never onto the operator's wallet,
    // and never onto the newcomer.
    await expect(v.connect(operator).addBeneficiaries(SEED, [c.address], [E(1_000_000)], [team.address], true))
      .to.changeTokenBalances(enc, [a, c, operator], [E(1_000_000), 0n, 0n]);
    // Rewriting an existing one is not — allocations stay immutable once set.
    await expect(v.connect(operator).addBeneficiaries(SEED, [a.address], [E(9_000_000)], [team.address], true))
      .to.be.revertedWithCustomError(v, "AllocationAlreadySet").withArgs(SEED, a.address);
    // And a wallet without OPERATOR_ROLE cannot onboard anyone.
    await expect(v.connect(b).addBeneficiaries(SEED, [b.address], [E(1_000_000)], [team.address], true))
      .to.be.revertedWithCustomError(v, "AccessControlUnauthorizedAccount")
      .withArgs(b.address, await v.OPERATOR_ROLE());

    // Pressing distribute only pushes tokens to investor wallets; the operator gets
    // nothing. The onboarding already drained the pool, so fresh unlock is needed:
    // 1,000,000 splits pro-rata over a (3M) and c (1M).
    await burn(enc, deployer, burnForSeed(E(1_000_000)));
    await expect(v.connect(operator).distribute(SEED))
      .to.changeTokenBalances(enc, [a, c, operator], [E(750_000), E(250_000), 0n]);
  });

  it("one press sweeps ALL members of the round; the operator cannot cherry-pick", async () => {
    const { enc, v, deployer, operator, a, b, c , team } = await loadFixture(fixture);
    await v.addBeneficiaries(SEED, [a.address, b.address, c.address], [E(3_000_000), E(4_000_000), E(5_000_000)], [team.address, team.address, team.address], true);
    await burn(enc, deployer, burnForSeed(E(1_200_000)));

    // distribute() takes no parameter but roundId — there is no variant that pays a
    // subset, so no investor can be favoured or skipped.
    const tx = await v.connect(operator).distribute(SEED);
    const receipt = await tx.wait();
    const claimedEvents = receipt!.logs.filter((l: any) => l.fragment?.name === "Claimed");
    expect(claimedEvents.length).to.equal(3); // all 3 investors in the same tx

    // After the press, nobody has anything left pending.
    for (const who of [a, b, c]) {
      expect(await v.claimable(SEED, who.address)).to.equal(0n);
    }
    expect(await enc.balanceOf(a.address)).to.equal(E(300_000));
    expect(await enc.balanceOf(b.address)).to.equal(E(400_000));
    expect(await enc.balanceOf(c.address)).to.equal(E(500_000));
  });
});
