import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ENC_MAX_SUPPLY } from "../helpers/encConstants";

/**
 * Deploys ENCVesting. An existing deployments/<network>/ENCVesting.json is
 * reused as-is (skipIfAlreadyDeployed); delete it to deploy fresh.
 *
 * Constructor args:
 *   - TEAM / TREASURY / PUBLIC beneficiary wallets from .env
 *   - ReferralRegistry address from deployments/<network>/ReferralRegistry.json
 *
 * On bscTestnet the fresh deploy uses ENCVestingTestnet (same constructor,
 * plus an operator-controlled clock — warpBy/warpTo — to fast-forward the
 * PUBLIC schedule), still recorded as deployments/<network>/ENCVesting.json so
 * later scripts are unchanged. Every other network gets the real ENCVesting.
 *
 * Wired by 02e_wire_vesting.ts (tag WireVesting):
 *   - ReferralRegistry.grantRole(OPERATOR_ROLE, ENCVesting)
 *   - ENC.mintGenesis(ENCVesting, EnishiPublicSale) then ENCVesting.start(ENC)
 *   - ENCVesting.grantRole(OPERATOR_ROLE, ENC_VESTING_PUBLIC_WALLET)
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

  const referral = (await get("ReferralRegistry")).address;

  const teamWallet = reqEnv("ENC_VESTING_TEAM_WALLET");
  const treasuryWallet = reqEnv("ENC_VESTING_TREASURY_WALLET");
  const publicWallet = reqEnv("ENC_VESTING_PUBLIC_WALLET");

  const args = [
    ENC_MAX_SUPPLY,
    teamWallet,
    treasuryWallet,
    publicWallet,
    referral,
  ];

  const contract = network.name === "bscTestnet" ? "ENCVestingTestnet" : "ENCVesting";

  log(`\nDeploying ENCVesting (${contract}) on ${network.name}...`);
  log(`  teamWallet     (TEAM beneficiary, 450,000,000 ENC)      : ${teamWallet}`);
  log(`  treasuryWallet (TREASURY beneficiary, 1,520,000,000 ENC): ${treasuryWallet}`);
  log(`  publicWallet   (PUBLIC beneficiary, 990,000,000 ENC)    : ${publicWallet}`);
  log(`  referral       (ReferralRegistry, from deployments)     : ${referral}`);

  const vesting = await deploy("ENCVesting", {
    contract,
    from: deployer,
    args,
    log: true,
    skipIfAlreadyDeployed: true,
    waitConfirmations: network.live ? 5 : 1,
  });
  log(`  ENCVesting deployed at: ${vesting.address}`);

  if (network.live && vesting.newlyDeployed) {
    try {
      await hre.run("verify:verify", {
        address: vesting.address,
        constructorArguments: [
          ENC_MAX_SUPPLY.toString(),
          teamWallet,
          treasuryWallet,
          publicWallet,
          referral,
        ],
      });
    } catch (e) {
      log(`  ENCVesting verify skipped/failed: ${(e as Error).message}`);
    }
  }
};

func.tags = ["ENCVesting"];
export default func;
