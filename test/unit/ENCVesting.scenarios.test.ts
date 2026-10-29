import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ENC_MAX_SUPPLY } from "../../helpers/encConstants";

const E = (n: number | string) => ethers.parseUnits(n.toString(), 18);
const SEED = 0, PRIVATE = 1, TEAM = 2, TREASURY = 3;
const NAMES = ["SEED", "PRIVATE", "TEAM", "TREASURY"];

/**
 * Fixture uses the real tokenomics caps: SEED 12,000,000 / Private 28,000,000 /
 * Team 450,000,000 (fixed, auto-allocated at construction) / Treasury 1,520,000,000
 * (fixed, auto-allocated at construction). The split-change boundaries (SEED full
 * @30,000,000 / Private full @56,666,667 / Team full @940,000,001) were computed by
 * hand and verified in the earlier burn-unlock discussion — reused verbatim here.
 */
const CAP_SEED = E(12_000_000);
const CAP_PRIVATE = E(28_000_000);
const CAP_TEAM = E(450_000_000);
const CAP_TREASURY = E(1_520_000_000);
const DOC_CAPS = [CAP_SEED, CAP_PRIVATE, CAP_TEAM, CAP_TREASURY];
const DOC_TOTAL = DOC_CAPS.reduce((a, b) => a + b, 0n); // 2,010,000,000
// 970M vests here (178M TGE + 792M monthly); the other 20M of the 990M
// The other 20M of the 990M Public allocation is sold by the standalone
// EnishiPublicSale contract, not administered here.
const PUBLIC_ALLOCATION = E(970_000_000); // 178M TGE-unlocked + 792M cliff/vesting
const PUBLIC_TGE = E(178_000_000);
const INITIAL_SUPPLY = ENC_MAX_SUPPLY;

async function docFixture() {
  const [deployer, s1, s2, s3, s4, p1, p2, p3, team, treasury, pub, publicSale] =
    await ethers.getSigners();

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
  // ENCVesting must be authorized to call registerWithReferrer for its own
  // addBeneficiaries referrer registration to succeed.
  await referralRegistry.grantRole(await referralRegistry.OPERATOR_ROLE(), await v.getAddress());

  // In production the genesis mint splits the supply between the vault and
  // the standalone EnishiPublicSale contract's 20M carve-out.
  await enc.mintGenesis(await v.getAddress(), publicSale.address);
  await v.start(await enc.getAddress());
  // PUBLIC's TGE tranche is no longer pre-credited: the vault holds it and the
  // beneficiary pulls it. It is the only circulating ENC, so these suites take it
  // as their burn float.
  await v.connect(pub).claim(4);
  await enc.connect(pub).transfer(deployer.address, PUBLIC_TGE);


  // SEED: 4 investors split EQUALLY (3,000,000 each) → cap 12,000,000
  // `team` is the ReferralRegistry root — a pre-approved referrer — and is never
  // itself a beneficiary in any round below.
  await v.addBeneficiaries(SEED, [s1.address, s2.address, s3.address, s4.address],
    [E(3_000_000), E(3_000_000), E(3_000_000), E(3_000_000)], [team.address, team.address, team.address, team.address], true);
  // PRIVATE: pro-rata 50/30/20 → cap 28,000,000
  await v.addBeneficiaries(PRIVATE, [p1.address, p2.address, p3.address],
    [E(14_000_000), E(8_400_000), E(5_600_000)], [team.address, team.address, team.address], true);


  return { enc, v, deployer, s1, s2, s3, s4, p1, p2, p3, team, treasury, pub };
}

const burn = (enc: any, who: any, amt: bigint) => enc.connect(who).burn(amt);

async function unlocked(v: any): Promise<bigint[]> {
  return Promise.all([SEED, PRIVATE, TEAM, TREASURY].map((r) => v.groupUnlocked(r)));
}

const sum = (a: bigint[]) => a.reduce((x, y) => x + y, 0n);

describe("ENCVesting — scenarios from the spec (real caps)", () => {
  // ─── Main example: phase 1 (40/40/10/10) ───────────────────────────────────
  it("burn 20,000,000 → SEED 8M / Priv 8M / Team 2M / Trea 2M (split 40/40/10/10)", async () => {
    const { enc, v, deployer } = await loadFixture(docFixture);
    await burn(enc, deployer, E(20_000_000));
    const u = await unlocked(v);
    expect(u).to.deep.equal([E(8_000_000), E(8_000_000), E(2_000_000), E(2_000_000)]);
    expect(sum(u)).to.equal(E(20_000_000)); // 1 burn = 1 unlock
  });

  it("burn 11,000,000 more (crossing the SEED @30M boundary) → 12M / 12.6M / 3.2M / 3.2M, total 31M", async () => {
    const { enc, v, deployer } = await loadFixture(docFixture);
    await burn(enc, deployer, E(20_000_000));
    await burn(enc, deployer, E(11_000_000));

    const u = await unlocked(v);
    // first 10M split 40/40/10/10 (SEED fills exactly at B=30M), leftover 1M split 60/20/20
    expect(u[SEED]).to.equal(CAP_SEED);          // hits the cap, stops
    expect(u[PRIVATE]).to.equal(E(12_600_000));  // 12M + 600k
    expect(u[TEAM]).to.equal(E(3_200_000));      // 3M + 200k
    expect(u[TREASURY]).to.equal(E(3_200_000));  // 3M + 200k
    expect(sum(u)).to.equal(E(31_000_000));      // NOTHING lost
  });

  it("any way of chunking the burn gives the same result (11M ≡ 10M+1M ≡ 1.1M×10)", async () => {
    const run = async (chunks: bigint[]) => {
      const { enc, v, deployer } = await loadFixture(docFixture);
      await burn(enc, deployer, E(20_000_000));
      for (const c of chunks) await burn(enc, deployer, c);
      return unlocked(v);
    };
    const oneShot = await run([E(11_000_000)]);
    const twoStep = await run([E(10_000_000), E(1_000_000)]);
    const tenStep = await run(Array(10).fill(E(1_100_000)));

    expect(twoStep).to.deep.equal(oneShot);
    expect(tenStep).to.deep.equal(oneShot);
    expect(sum(oneShot)).to.equal(E(31_000_000));
  });

  // ─── The three split changes ───────────────────────────────────────────────
  it("SEED-full boundary (30,000,000) → the split shifts to 60/20/20", async () => {
    const { enc, v, deployer } = await loadFixture(docFixture);
    await burn(enc, deployer, E(30_000_000));
    const before = await unlocked(v);
    expect(before[SEED]).to.equal(CAP_SEED); // just hit the cap

    await burn(enc, deployer, E(1_000_000));
    const after = await unlocked(v);
    const d = after.map((x, i) => x - before[i]);
    expect(d).to.deep.equal([0n, E(600_000), E(200_000), E(200_000)]); // 0/60/20/20
  });

  it("PRIVATE-full boundary (56,666,667) → the split shifts to 50/50", async () => {
    const { enc, v, deployer } = await loadFixture(docFixture);
    await burn(enc, deployer, 56_666_667n * 10n ** 18n);
    const before = await unlocked(v);
    expect(before[PRIVATE]).to.equal(CAP_PRIVATE); // just hit the cap

    await burn(enc, deployer, E(1_000_000));
    const d = (await unlocked(v)).map((x, i) => x - before[i]);
    expect(d).to.deep.equal([0n, 0n, E(500_000), E(500_000)]); // 0/0/50/50
  });

  // NOTE: Team-full (@940,000,001) / total-cap (@2,010,000,000) boundaries are
  // NOT reachable in this fixture: the real ENC token has a hard-fixed 3B supply
  // (no mint), and 2,802,000,000 of it must be funded into vesting up front just
  // to satisfy the invariant (TEAM+TREASURY+PUBLIC auto-allocated + SEED+PRIVATE
  // set below) — leaving the deployer only 198,000,000 spare to burn from. That's
  // real, deliberate: reaching Team/Treasury-full in production takes a very long
  // time (way more ENC burned than currently exists outside locked allocations).
  // These boundaries are only reachable analytically (see the burn-unlock table
  // discussion), not by literally burning that much in a unit test.

  // ─── Invariants & boundaries (within the available burn budget: 198,000,000) ─
  it("the 1 burn = 1 unlock invariant holds across the whole available burn budget", async () => {
    const { enc, v, deployer } = await loadFixture(docFixture);
    const STEP = E(15_000_000);
    // Past the Private-full boundary (56,666,667, ceilDiv does not divide evenly) a few
    // wei of drift is possible from rounding down (always safe — never unlocks more
    // than was actually burned).
    const MAX_DRIFT = 10n;
    // The 20,000,000 Public Sale carve-out is reserved inside the vault, so the
    // circulating float is the 178,000,000 TGE tranche and nothing else.
    for (let step = 1; step <= 11; step++) { // 11 × 15M = 165M ≤ 178M available
      await burn(enc, deployer, STEP);
      const b = STEP * BigInt(step);
      const s = sum(await unlocked(v));
      expect(s, `at burn ${b / E(1)}`).to.be.lte(b);
      expect(b - s, `at burn ${b / E(1)}`).to.be.lte(MAX_DRIFT);
    }
  });

  it("burning the entire available budget (178,000,000) → SEED/PRIVATE fully full, Team/Treasury far from cap", async () => {
    const { enc, v, deployer } = await loadFixture(docFixture);
    await burn(enc, deployer, E(178_000_000));
    const u = await unlocked(v);
    expect(u[SEED]).to.equal(CAP_SEED);
    expect(u[PRIVATE]).to.equal(CAP_PRIVATE);
    expect(u[TEAM]).to.be.lt(CAP_TEAM);
    expect(u[TREASURY]).to.be.lt(CAP_TREASURY);
    // No more than a few wei lost to rounding down at the Private boundary.
    expect(E(178_000_000) - sum(u)).to.be.lte(10n);
  });

  it("no round ever exceeds its cap at any burn level (within the available budget)", async () => {
    const { enc, v, deployer } = await loadFixture(docFixture);
    const STEP = E(10_000_000);
    for (let step = 1; step <= 17; step++) { // 17 × 10M = 170M ≤ 178M available
      await burn(enc, deployer, STEP);
      const u = await unlocked(v);
      u.forEach((x, i) => expect(x, `${NAMES[i]} exceeded cap`).to.be.lte(DOC_CAPS[i]));
    }
  });

  // ─── Splitting within a round ──────────────────────────────────────────────
  it("distribute: SEED splits EQUALLY across 4 investors, PRIVATE splits pro-rata 50/30/20", async () => {
    const { enc, v, deployer, s1, s2, s3, s4, p1, p2, p3 } = await loadFixture(docFixture);
    await burn(enc, deployer, E(20_000_000)); // SEED group = 8M, PRIVATE group = 8M

    // SEED/PRIVATE are pooled rounds: the tokens only reach wallets once distribute is pressed.
    // SEED: 8,000,000/4 = 2,000,000 each
    await expect(v.distribute(SEED)).to.changeTokenBalances(
      enc, [s1, s2, s3, s4], [E(2_000_000), E(2_000_000), E(2_000_000), E(2_000_000)],
    );
    // PRIVATE: 8,000,000 × (14M/28M, 8.4M/28M, 5.6M/28M) = 4M / 2.4M / 1.6M
    await expect(v.distribute(PRIVATE)).to.changeTokenBalances(
      enc, [p1, p2, p3], [E(4_000_000), E(2_400_000), E(1_600_000)],
    );
  });

  // ─── Claim ─────────────────────────────────────────────────────────────────
  it("receiving in several batches = receiving in one: the totals match", async () => {
    const { enc, v, deployer, s1, s2 } = await loadFixture(docFixture);

    // Press distribute in 3 stages: every press pays ALL 4 investors, nobody is skipped.
    await burn(enc, deployer, E(10_000_000));
    await v.distribute(SEED);
    await burn(enc, deployer, E(10_000_000));
    await v.distribute(SEED);
    await burn(enc, deployer, E(10_000_000));
    await v.distribute(SEED);

    // Splitting into several batches gives exactly the single-batch result: SEED at its
    // cap (burn 30,000,000) → each investor receives the full 3,000,000.
    expect(await enc.balanceOf(s1.address)).to.equal(await enc.balanceOf(s2.address));
    expect(await enc.balanceOf(s1.address)).to.equal(E(3_000_000));
  });

  it("a pooled round is payable only through the press (no pull, no double pay)", async () => {
    const { enc, v, deployer, s1 } = await loadFixture(docFixture);
    await burn(enc, deployer, E(20_000_000));

    // An investor cannot pull before the press...
    await expect(v.connect(s1).claim(SEED))
      .to.be.revertedWithCustomError(v, "OperatorDistributedRound").withArgs(SEED);

    await expect(v.distribute(SEED)).to.changeTokenBalance(enc, s1, E(2_000_000)); // 8M x 3/12

    // ...nor after it, and a second press moves nothing until more ENC is burned.
    await expect(v.connect(s1).claim(SEED))
      .to.be.revertedWithCustomError(v, "OperatorDistributedRound").withArgs(SEED);
    await expect(v.distribute(SEED)).to.be.revertedWithCustomError(v, "NothingToDistribute");
  });

  it("nobody can touch another round's share", async () => {
    const { enc, v, deployer, s1, p1, p2, p3 } = await loadFixture(docFixture);
    await burn(enc, deployer, E(20_000_000));

    // s1 (SEED round) has nothing in the PRIVATE round.
    expect(await v.claimable(PRIVATE, s1.address)).to.equal(0n);

    // Press PRIVATE: tokens go straight to p1/p2/p3 by 50/30/20, s1 receives nothing.
    await expect(v.distribute(PRIVATE)).to.changeTokenBalances(
      enc, [p1, p2, p3, s1], [E(4_000_000), E(2_400_000), E(1_600_000), 0n],
    );
    expect(await v.claimable(PRIVATE, p1.address)).to.equal(0n);
  });

  it("a wallet with no allocation receives nothing from the press", async () => {
    const { enc, v, deployer, team } = await loadFixture(docFixture);
    await burn(enc, deployer, E(20_000_000));
    // team is not a member of the SEED round
    expect(await v.claimable(SEED, team.address)).to.equal(0n);
    await expect(v.distribute(SEED)).to.changeTokenBalance(enc, team, 0n);
    expect(await v.claimable(SEED, team.address)).to.equal(0n);
  });

  it("total tokens distributable to everyone = the round's total unlock", async () => {
    const { enc, v, deployer } = await loadFixture(docFixture);
    await burn(enc, deployer, E(31_000_000)); // exactly the example boundary (SEED just full + spillover)

    // The pool has not been settled yet so claimable is still 0; previewDistribution
    // shows what the next press would pay each investor.
    const [, seedAmounts] = await v.previewDistribution(SEED);
    const [, privAmounts] = await v.previewDistribution(PRIVATE);
    const seedSum = sum([...seedAmounts]);
    const privSum = sum([...privAmounts]);

    expect(seedSum).to.equal(await v.groupUnlocked(SEED));       // 12,000,000
    expect(privSum).to.equal(await v.groupUnlocked(PRIVATE));    // 12,600,000
    expect(seedSum).to.equal(CAP_SEED);
    expect(privSum).to.equal(E(12_600_000));
  });
});
