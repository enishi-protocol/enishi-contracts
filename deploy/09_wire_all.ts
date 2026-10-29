import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Check, createStepper, eq, verifyChecks } from "../helpers/wiring";

/**
 * Wires the Vault stack (WhiteList, SwapContractFactory, ReferralRegistry,
 * receipt tokens, ENCCommission, ENCLock) to the Vault, then verifies every
 * link on chain.
 *
 * Commission stake: the Vault takes ENCStakeRouter as STAKE_ROUTER, the router
 * is ENCLock's vault, and EnishiPublicSale only accepts the router, so Public
 * Sale lots pay the commission first. EnishiPublicSale.setStakeRouter is
 * one-shot: a sale already bound to another router aborts the run.
 *
 * Every check that can abort runs before the first transaction, and the
 * commission stake is wired before the factory routes users to the Vault.
 *
 * The vesting / public-sale release (ENC genesis mint, ENCVesting.start and its
 * roles) is wired separately by 02e_wire_vesting.ts (tag `WireVesting`).
 */
const RECEIPTS = [
  "EnBTC",
  "EnETH",
  "EnXRP",
  "EnBNB",
  "EnSOL",
  "EnAVAX",
  "EnLINK",
] as const;

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network, ethers } = hre;
  const { log, get } = deployments;
  const { deployer } = await getNamedAccounts();

  const addr = async (name: string) => (await get(name)).address;
  const vault = await addr("Vault");
  const factoryAddr = await addr("SwapContractFactory");
  const whitelistAddr = await addr("WhiteList");
  const referralAddr = await addr("ReferralRegistry");
  const encCommissionAddr = await addr("ENCCommission");
  const encLockAddr = await addr("ENCLock");
  const encAddr = await addr("ENC");
  const publicSaleAddr = await addr("EnishiPublicSale");
  const stakeRouterAddr = await addr("ENCStakeRouter");

  log(`\nWiring Enishi contracts to Vault on ${network.name}...`);
  log(`  vault  : ${vault}`);
  log(`  sender : ${deployer}`);

  const stakeRouter = await ethers.getContractAt("ENCStakeRouter", stakeRouterAddr);
  const publicSale = await ethers.getContractAt("EnishiPublicSale", publicSaleAddr);
  const vaultC = await ethers.getContractAt("Vault", vault);

  // ─── Preflight (read-only) ────────────────────────────────────────────────
  // Every check that can abort runs before the first transaction, so a failed
  // run never leaves the Vault live with ENCLock still trusting another vault.

  let boundRouter: string;
  try {
    boundRouter = await publicSale.stakeRouter();
  } catch {
    throw new Error(
      `EnishiPublicSale ${publicSaleAddr} predates the commission API (no stakeRouter()); ` +
        `redeploy it with 02d, then 04b and 08.`,
    );
  }
  if (!eq(boundRouter, ethers.ZeroAddress) && !eq(boundRouter, stakeRouterAddr)) {
    throw new Error(
      `EnishiPublicSale ${publicSaleAddr} is bound to router ${boundRouter}, not ` +
        `${stakeRouterAddr}; setStakeRouter is one-shot — resolve manually.`,
    );
  }
  await verifyChecks(log, [
    ["ENCStakeRouter.ENC_LOCK == ENCLock", async () => eq(await stakeRouter.ENC_LOCK(), encLockAddr)],
    ["ENCStakeRouter.PUBLIC_SALE == EnishiPublicSale", async () => eq(await stakeRouter.PUBLIC_SALE(), publicSaleAddr)],
    [
      "ENCStakeRouter.ENC_COMMISSION == Vault.ENC_COMMISSION",
      async () => eq(await stakeRouter.ENC_COMMISSION(), await vaultC.ENC_COMMISSION()),
    ],
  ]);

  const referral = await ethers.getContractAt("ReferralRegistry", referralAddr);
  const REFERRAL_OPERATOR_ROLE = await referral.OPERATOR_ROLE();
  const REFERRAL_ADMIN_ROLE = await referral.DEFAULT_ADMIN_ROLE();
  if (
    !(await referral.hasRole(REFERRAL_OPERATOR_ROLE, vault)) &&
    !(await referral.hasRole(REFERRAL_ADMIN_ROLE, deployer))
  ) {
    throw new Error(
      `ReferralRegistry ${referralAddr}: Vault ${vault} lacks OPERATOR_ROLE and the ` +
        `deployer is not DEFAULT_ADMIN_ROLE — grant it from the registry admin, then re-run Wire.`,
    );
  }

  const { step, stats } = createStepper(log, network.live ? 2 : 1);

  // ─── ENCStakeRouter + EnishiPublicSale + ENCLock ──────────────────────────
  // Commission stake and ENCCommission first: the Vault must settle commission
  // before the factory routes users to it.

  await step(
    "ENCStakeRouter.setVault(Vault)",
    async () => eq(await stakeRouter.vault(), vault),
    () => stakeRouter.setVault(vault),
  );
  await step(
    "Vault.setStakeRouter(ENCStakeRouter)",
    async () => eq(await vaultC.STAKE_ROUTER(), stakeRouterAddr),
    () => vaultC.setStakeRouter(stakeRouterAddr),
  );

  await step(
    "EnishiPublicSale.setStakeRouter(ENCStakeRouter, ENCCommission)",
    async () => eq(await publicSale.stakeRouter(), stakeRouterAddr),
    () => publicSale.setStakeRouter(stakeRouterAddr, encCommissionAddr),
  );

  const encLock = await ethers.getContractAt("ENCLock", encLockAddr);
  await step(
    "ENCLock.setVault(ENCStakeRouter)",
    async () => eq(await encLock.vault(), stakeRouterAddr),
    () => encLock.setVault(stakeRouterAddr),
  );

  // ─── ENCCommission ────────────────────────────────────────────────────────

  const encCommission = await ethers.getContractAt(
    "ENCCommission",
    encCommissionAddr,
  );
  await step(
    "ENCCommission.setAuthorizedCaller(Vault, true)",
    () => encCommission.isAuthorizedCaller(vault),
    () => encCommission.setAuthorizedCaller(vault, true),
  );

  // ─── SwapContractFactory ──────────────────────────────────────────────────

  const factory = await ethers.getContractAt(
    "SwapContractFactory",
    factoryAddr,
  );
  await step(
    "SwapContractFactory.setVault(Vault)",
    async () => eq(await factory.vault(), vault),
    () => factory.setVault(vault),
  );

  // ─── WhiteList ────────────────────────────────────────────────────────────

  const whitelist = await ethers.getContractAt("WhiteList", whitelistAddr);
  const OPERATOR_ROLE = await whitelist.OPERATOR_ROLE();
  await step(
    "WhiteList.grantRole(OPERATOR_ROLE, Vault)",
    () => whitelist.hasRole(OPERATOR_ROLE, vault),
    () => whitelist.grantRole(OPERATOR_ROLE, vault),
  );
  // The constructor's placeholder operator (deployer) must not keep pick().
  if (!eq(deployer, vault)) {
    await step(
      "WhiteList.revokeRole(OPERATOR_ROLE, deployer)",
      async () => !(await whitelist.hasRole(OPERATOR_ROLE, deployer)),
      () => whitelist.revokeRole(OPERATOR_ROLE, deployer),
    );
  }

  // ─── ReferralRegistry ─────────────────────────────────────────────────────
  // The Vault registers referrers on first deposit. (ENCVesting's role is
  // granted by 02e_wire_vesting.)

  await step(
    "ReferralRegistry.grantRole(OPERATOR_ROLE, Vault)",
    () => referral.hasRole(REFERRAL_OPERATOR_ROLE, vault),
    () => referral.grantRole(REFERRAL_OPERATOR_ROLE, vault),
  );

  // ─── Receipt tokens ───────────────────────────────────────────────────────

  for (const name of RECEIPTS) {
    const token = await ethers.getContractAt("EnToken", await addr(name));
    await step(
      `${name}.setOperator(Vault)`,
      async () => eq(await token.operator(), vault),
      () => token.setOperator(vault),
    );
  }

  // ─── Final on-chain verification ─────────────────────────────────────────

  const checks: Check[] = [
    ["Vault.WHITELIST == WhiteList", async () => eq(await vaultC.WHITELIST(), whitelistAddr)],
    ["Vault.SWC_FACTORY == SwapContractFactory", async () => eq(await vaultC.SWC_FACTORY(), factoryAddr)],
    ["Vault.REFERRAL_REGISTRY == ReferralRegistry", async () => eq(await vaultC.REFERRAL_REGISTRY(), referralAddr)],
    ["Vault.ENC_COMMISSION == ENCCommission", async () => eq(await vaultC.ENC_COMMISSION(), encCommissionAddr)],
    ["Vault.STAKE_ROUTER == ENCStakeRouter", async () => eq(await vaultC.STAKE_ROUTER(), stakeRouterAddr)],
    ["Vault.ENC == ENC", async () => eq(await vaultC.ENC(), encAddr)],
    ["ENCCommission.ENC_TOKEN == ENC", async () => eq(await encCommission.ENC_TOKEN(), encAddr)],
    ["ENCCommission.REFERRAL_REGISTRY == ReferralRegistry", async () => eq(await encCommission.REFERRAL_REGISTRY(), referralAddr)],
    ["ENCLock.ENC_TOKEN == ENC", async () => eq(await encLock.ENC_TOKEN(), encAddr)],
    ["ENCLock.vault == ENCStakeRouter", async () => eq(await encLock.vault(), stakeRouterAddr)],
    ["ENCCommission.isAuthorizedCaller(Vault)", () => encCommission.isAuthorizedCaller(vault)],
    ["SwapContractFactory.vault == Vault", async () => eq(await factory.vault(), vault)],
    ["WhiteList: Vault has OPERATOR_ROLE", () => whitelist.hasRole(OPERATOR_ROLE, vault)],
    ["ReferralRegistry: Vault has OPERATOR_ROLE", () => referral.hasRole(REFERRAL_OPERATOR_ROLE, vault)],
  ];
  for (const name of RECEIPTS) {
    const token = await ethers.getContractAt("EnToken", await addr(name));
    checks.push([`${name}.operator == Vault`, async () => eq(await token.operator(), vault)]);
  }
  checks.push(
    ["ENCStakeRouter.vault == Vault", async () => eq(await stakeRouter.vault(), vault)],
    ["ENCStakeRouter.ENC_LOCK == ENCLock", async () => eq(await stakeRouter.ENC_LOCK(), encLockAddr)],
    ["ENCStakeRouter.PUBLIC_SALE == EnishiPublicSale", async () => eq(await stakeRouter.PUBLIC_SALE(), publicSaleAddr)],
    [
      "ENCStakeRouter.ENC_COMMISSION == Vault.ENC_COMMISSION",
      async () => eq(await stakeRouter.ENC_COMMISSION(), await vaultC.ENC_COMMISSION()),
    ],
    ["EnishiPublicSale.stakeRouter == ENCStakeRouter", async () => eq(await publicSale.stakeRouter(), stakeRouterAddr)],
    [
      "EnishiPublicSale.commissionRecipient == ENCCommission",
      async () => eq(await publicSale.commissionRecipient(), encCommissionAddr),
    ],
  );
  await verifyChecks(log, checks);

  log(`\n  wiring done — ${stats.sent} tx sent, ${stats.skipped} already correct, ${checks.length} checks passed`);
};

func.tags = ["Wire"];
export default func;
