/**
 * Two deployment rigs for {ENCVesting}:
 *
 *  • `productionRig` — the real fixed-supply {ENC}, deployed exactly the way the
 *    deploy scripts do it: ENCVesting first, then the one genesis mint splitting
 *    the 3,000,000,000 supply between the vault (2,980,000,000 — every round
 *    except Public Sale) and a stand-in Public Sale recipient (the 20,000,000
 *    carve-out, administered by the standalone EnishiPublicSale contract, not
 *    exercised by these rigs).
 *    Nothing circulates until the PUBLIC beneficiary pulls its 20% TGE tranche, so
 *    the rig does that too — those 178,000,000 ENC are the entire burn budget and
 *    reach phases 1-2. Use it whenever fidelity matters.
 *
 *  • `fullRangeRig` — {MockBurnableENC}, minted so the burner can drive the burn all
 *    the way to FULL_UNLOCK_BURN (2,010,000,000 ENC). Use it to cover phases 3-4,
 *    which the real supply can never reach.
 */
import { ethers } from "hardhat";
import { ENC_MAX_SUPPLY, FULL_UNLOCK_BURN, LOCKED, PUBLIC as PUBLIC_ROUND } from "./vestingModel";

export const INITIAL_SUPPLY_PROD = ENC_MAX_SUPPLY;
/** Headroom above the burn needed to unlock every group. */
export const BURN_BUDGET_FULL = FULL_UNLOCK_BURN + 10_000_000n * 10n ** 18n;

export async function productionRig() {
  const [deployer, operator, u1, u2, u3, u4, team, treasury, pub, outsider, publicSale] =
    await ethers.getSigners();

  // ENC is deployed FIRST, empty; the vesting contracts then get its real address
  const enc = await (await ethers.getContractFactory("ENC")).deploy();
  await enc.waitForDeployment();

  const referralRegistry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(
    deployer.address,
  );
  await referralRegistry.waitForDeployment();

  const v = await (await ethers.getContractFactory("ENCVesting")).deploy(
    INITIAL_SUPPLY_PROD, team.address, treasury.address, pub.address, await referralRegistry.getAddress(),
  );
  // ENCVesting grants the deployer only DEFAULT_ADMIN_ROLE; the suite operates as deployer.
  await v.grantRole(await v.OPERATOR_ROLE(), (await ethers.getSigners())[0].address);
  await v.waitForDeployment();

  await referralRegistry.connect(deployer).grantRole(await referralRegistry.OPERATOR_ROLE(), await v.getAddress());

  // the one genesis mint splits the supply between the vault and the Public
  // Sale carve-out recipient, then closes ENC's mint path
  await enc.mintGenesis(await v.getAddress(), publicSale.address);

  // Nothing runs until the owner opens the vault.
  await v.start(await enc.getAddress());

  await v.grantRole(await v.OPERATOR_ROLE(), operator.address);

  // PUBLIC pulls its TGE tranche — the first, and at genesis the only, circulating
  // ENC. Nothing can be burned before this, so the burn engine starts here.
  await v.connect(pub).claim(PUBLIC_ROUND);

  return {
    enc, v, referralRegistry, deployer, burner: pub, operator, u1, u2, u3, u4, team, treasury, pub, outsider,
    publicSale,
    burnBudget: await enc.balanceOf(pub.address),
  };
}

export async function fullRangeRig() {
  const [deployer, operator, u1, u2, u3, u4, team, treasury, pub, outsider] = await ethers.getSigners();

  const enc = await (await ethers.getContractFactory("MockBurnableENC")).deploy();
  await enc.waitForDeployment();
  const initialSupply = LOCKED + BURN_BUDGET_FULL;

  const referralRegistry = await (await ethers.getContractFactory("ReferralRegistry")).deploy(
    deployer.address,
  );
  await referralRegistry.waitForDeployment();

  const v = await (await ethers.getContractFactory("ENCVesting")).deploy(
    initialSupply, team.address, treasury.address, pub.address, await referralRegistry.getAddress(),
  );
  // ENCVesting grants the deployer only DEFAULT_ADMIN_ROLE; the suite operates as deployer.
  await v.grantRole(await v.OPERATOR_ROLE(), (await ethers.getSigners())[0].address);
  await v.waitForDeployment();
  await referralRegistry.connect(deployer).grantRole(await referralRegistry.OPERATOR_ROLE(), await v.getAddress());
  await enc.mint(await v.getAddress(), LOCKED);
  await enc.mint(deployer.address, BURN_BUDGET_FULL);
  await enc.approve(await v.getAddress(), await v.totalOutstanding());
  await v.start(await enc.getAddress());
  await v.grantRole(await v.OPERATOR_ROLE(), operator.address);

  return {
    enc, v, referralRegistry, deployer, burner: deployer, operator, u1, u2, u3, u4, team, treasury, pub, outsider,
    burnBudget: BURN_BUDGET_FULL, initialSupply,
  };
}
