import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

/**
 * Deploys Vault.
 *
 * Deploy only. Every contract address comes from deployments/<network>/
 * (WhiteList, SwapContractFactory, ReferralRegistry, ENCCommission,
 * ENCStakeRouter, ENC); only FUND_WALLET is read from .env. ENCStakeRouter
 * needs EnishiPublicSale (02d) deployed first — 04b skips without it.
 *
 * On bscTestnet this deploys VaultTestnet (same constructor, plus an
 * owner-controlled clock — warpBy/warpTo — and exit delay — setExitDelay —
 * to skip the 48-hour exit delay),
 * still recorded as deployments/<network>/Vault.json so later scripts are
 * unchanged. Every other network gets the real Vault.
 *
 * Wiring (setVault, grantRole, setOperator, …) is done by 09_wire_all.ts.
 */
function reqEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var ${key}`);
  return v;
}

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, log, get } = deployments;
  const { deployer } = await getNamedAccounts();

  const fundWallet = reqEnv("FUND_WALLET");
  const whitelist = (await get("WhiteList")).address;
  const swapContractFactory = (await get("SwapContractFactory")).address;
  const referral = (await get("ReferralRegistry")).address;
  const encCommission = (await get("ENCCommission")).address;
  const stakeRouter = (await get("ENCStakeRouter")).address;
  const enc = (await get("ENC")).address;

  const args = [
    whitelist,
    swapContractFactory,
    referral,
    encCommission,
    stakeRouter,
    enc,
    fundWallet,
  ];

  const contract = network.name === "bscTestnet" ? "VaultTestnet" : "Vault";

  log(`\nDeploying Vault (${contract}) on ${network.name}...`);
  log(`  whitelist           : ${whitelist}`);
  log(`  swapContractFactory : ${swapContractFactory}`);
  log(`  referral            : ${referral}`);
  log(`  encCommission       : ${encCommission}`);
  log(`  stakeRouter         : ${stakeRouter}`);
  log(`  enc                 : ${enc}`);
  log(`  fundWallet          : ${fundWallet}`);

  const result = await deploy("Vault", {
    contract,
    from: deployer,
    args,
    log: true,
    waitConfirmations: network.live ? 5 : 1,
  });
  log(`  Vault deployed at : ${result.address}`);

  if (network.live && result.newlyDeployed) {
    log(`\nVerifying on BSCScan...`);
    try {
      await hre.run("verify:verify", {
        address: result.address,
        constructorArguments: args,
      });
    } catch (e) {
      log(`verify skipped/failed: ${(e as Error).message}`);
    }
  }
};

func.tags = ["Vault"];
export default func;
