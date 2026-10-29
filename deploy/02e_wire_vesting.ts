import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Check, createStepper, eq, verifyChecks } from "../helpers/wiring";

/**
 * Wires the vesting / public-sale release: ReferralRegistry, ENCVesting, ENC
 * and EnishiPublicSale only. Independent of the Vault stack (03–08), so it can
 * ship first:
 *
 *   npx hardhat deploy --network <network> \
 *     --tags ReferralRegistry,ENCVesting,ENC,PublicSale,WireVesting
 *
 * Steps (each skipped when already on chain):
 *   - ENC.mintGenesis(ENCVesting, EnishiPublicSale) — one-shot, renounces ENC ownership
 *   - ENCVesting.start(ENC) — one-shot, anchors the TGE
 *   - ENCVesting.grantRole(OPERATOR_ROLE, ENC_VESTING_PUBLIC_WALLET)
 *   - ReferralRegistry.grantRole(OPERATOR_ROLE, ENCVesting) — addBeneficiaries registers referrers
 *
 * EnishiPublicSale.setSaleOpen(true) stays manual: the deployer does not hold
 * its OPERATOR_ROLE (02d grants it to ENC_VESTING_PUBLIC_WALLET).
 */
function reqEnv(key: string): string {
  const v = process.env[key]?.trim();
  if (!v) throw new Error(`Missing env var ${key}`);
  return v;
}

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network, ethers } = hre;
  const { log, get } = deployments;
  const { deployer } = await getNamedAccounts();

  const referralAddr = (await get("ReferralRegistry")).address;
  const encAddr = (await get("ENC")).address;
  const encVestingAddr = (await get("ENCVesting")).address;
  const publicSaleAddr = (await get("EnishiPublicSale")).address;
  const vestingOperator = reqEnv("ENC_VESTING_PUBLIC_WALLET");

  log(`\nWiring ENCVesting + EnishiPublicSale on ${network.name}...`);
  log(`  ENC              : ${encAddr}`);
  log(`  ENCVesting       : ${encVestingAddr}`);
  log(`  EnishiPublicSale : ${publicSaleAddr}`);
  log(`  sender           : ${deployer}`);

  const { step, stats } = createStepper(log, network.live ? 2 : 1);

  const enc = await ethers.getContractAt("ENC", encAddr);
  const encVesting = await ethers.getContractAt("ENCVesting", encVestingAddr);
  const publicSale = await ethers.getContractAt("EnishiPublicSale", publicSaleAddr);
  const referral = await ethers.getContractAt("ReferralRegistry", referralAddr);

  // ─── Guards ───────────────────────────────────────────────────────────────
  // mintGenesis is one-shot and burns ENC ownership, so a reused ENCVesting
  // must belong to *this* ENC and *this* ReferralRegistry, and the sale must
  // pay out *this* ENC.

  const vestingReferral: string = await encVesting.REFERRAL_REGISTRY();
  if (!eq(vestingReferral, referralAddr)) {
    throw new Error(
      `ENCVesting ${encVestingAddr} uses ReferralRegistry ${vestingReferral}, ` +
        `deployments/ has ${referralAddr} — refusing to wire a split registry.`,
    );
  }
  const vestingStart: bigint = await encVesting.startTime();
  if (vestingStart !== 0n) {
    const vestingEnc: string = await encVesting.ENC_TOKEN();
    if (!eq(vestingEnc, encAddr)) {
      throw new Error(
        `ENCVesting ${encVestingAddr} already started with ENC ${vestingEnc}, ` +
          `deployments/ has ENC ${encAddr} — mintGenesis would strand the supply. ` +
          `Point deployments/ at ENC ${vestingEnc}, or delete ENCVesting.json for a fresh vesting.`,
      );
    }
  }
  const saleEnc: string = await publicSale.ENC_TOKEN();
  if (!eq(saleEnc, encAddr)) {
    throw new Error(
      `EnishiPublicSale ${publicSaleAddr} pays out ENC ${saleEnc}, deployments/ has ENC ${encAddr} — ` +
        `run --tags PublicSale first (setEncToken), or fix deployments/.`,
    );
  }
  if (!(await enc.genesisMinted()) && !eq(await enc.owner(), deployer)) {
    throw new Error(
      `ENC ${encAddr} genesis not minted and owner is ${await enc.owner()}, not the deployer.`,
    );
  }

  // ─── ENC genesis mint — one-shot, renounces ENC ownership ─────────────────

  await step(
    `ENC.mintGenesis(ENCVesting ${encVestingAddr}, EnishiPublicSale ${publicSaleAddr})`,
    () => enc.genesisMinted(),
    () => enc.mintGenesis(encVestingAddr, publicSaleAddr),
  );
  log(`    ENCVesting holds ${ethers.formatEther(await enc.balanceOf(encVestingAddr))} ENC`);
  log(`    EnishiPublicSale holds ${ethers.formatEther(await enc.balanceOf(publicSaleAddr))} ENC`);

  // The genesis mint lands the 20,000,000 ENC straight in EnishiPublicSale's
  // balance, which is all it sells from — exactly its default saleCapEnc, which
  // setSaleOpen(true) requires to be fully backed. The sale stays closed until
  // its operator (ENC_VESTING_PUBLIC_WALLET) opens it.

  // ─── Start the vesting clock — only now that the ENC has landed ───────────

  await step(
    `ENCVesting.start(${encAddr}) — wires ENC and anchors the TGE`,
    async () => (await encVesting.startTime()) !== 0n,
    () => encVesting.start(encAddr),
  );
  log(`    ENCVesting startTime: ${await encVesting.startTime()}`);

  // ─── ENCVesting operator ──────────────────────────────────────────────────
  // ENC_VESTING_PUBLIC_WALLET runs the vesting day to day, same as it holds
  // EnishiPublicSale's OPERATOR_ROLE (02d). The deployer also keeps the role
  // from construction; as admin it can revoke it later.

  const VESTING_OPERATOR_ROLE = await encVesting.OPERATOR_ROLE();
  await step(
    `ENCVesting.grantRole(OPERATOR_ROLE, ENC_VESTING_PUBLIC_WALLET ${vestingOperator})`,
    () => encVesting.hasRole(VESTING_OPERATOR_ROLE, vestingOperator),
    () => encVesting.grantRole(VESTING_OPERATOR_ROLE, vestingOperator),
  );

  // ─── ReferralRegistry ─────────────────────────────────────────────────────
  // ENCVesting.addBeneficiaries registers referrers, so it needs OPERATOR_ROLE.

  const REFERRAL_OPERATOR_ROLE = await referral.OPERATOR_ROLE();
  const REFERRAL_ADMIN_ROLE = await referral.DEFAULT_ADMIN_ROLE();
  if (
    !(await referral.hasRole(REFERRAL_OPERATOR_ROLE, encVestingAddr)) &&
    !(await referral.hasRole(REFERRAL_ADMIN_ROLE, deployer))
  ) {
    throw new Error(
      `ReferralRegistry ${referralAddr}: ENCVesting ${encVestingAddr} lacks OPERATOR_ROLE and the ` +
        `deployer is not DEFAULT_ADMIN_ROLE — grant it from the registry admin, then re-run WireVesting.`,
    );
  }
  await step(
    "ReferralRegistry.grantRole(OPERATOR_ROLE, ENCVesting)",
    () => referral.hasRole(REFERRAL_OPERATOR_ROLE, encVestingAddr),
    () => referral.grantRole(REFERRAL_OPERATOR_ROLE, encVestingAddr),
  );

  // ─── Final on-chain verification ─────────────────────────────────────────

  const SALE_OPERATOR_ROLE = await publicSale.OPERATOR_ROLE();
  const checks: Check[] = [
    ["ENC.genesisMinted", () => enc.genesisMinted()],
    ["ENCVesting.REFERRAL_REGISTRY == ReferralRegistry", async () => eq(await encVesting.REFERRAL_REGISTRY(), referralAddr)],
    ["ENCVesting.ENC_TOKEN == ENC", async () => eq(await encVesting.ENC_TOKEN(), encAddr)],
    ["ENCVesting.startTime != 0", async () => (await encVesting.startTime()) !== 0n],
    ["ENCVesting: ENC_VESTING_PUBLIC_WALLET has OPERATOR_ROLE", () => encVesting.hasRole(VESTING_OPERATOR_ROLE, vestingOperator)],
    ["ReferralRegistry: ENCVesting has OPERATOR_ROLE", () => referral.hasRole(REFERRAL_OPERATOR_ROLE, encVestingAddr)],
    ["EnishiPublicSale.ENC_TOKEN == ENC", async () => eq(await publicSale.ENC_TOKEN(), encAddr)],
    ["EnishiPublicSale: ENC_VESTING_PUBLIC_WALLET has OPERATOR_ROLE", () => publicSale.hasRole(SALE_OPERATOR_ROLE, vestingOperator)],
    [
      "EnishiPublicSale: ENC held backs the unsold cap",
      async () => (await publicSale.remainingEnc()) === (await publicSale.saleCapEnc()) - (await publicSale.encSold()),
    ],
  ];
  await verifyChecks(log, checks);

  log(`\n  vesting wiring done — ${stats.sent} tx sent, ${stats.skipped} already correct, ${checks.length} checks passed`);
};

func.tags = ["WireVesting"];
export default func;
