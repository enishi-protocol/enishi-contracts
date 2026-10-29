import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

/**
 * Deploys ENCCommission.
 *
 * Deploy only. Constructor args:
 *   - ENC and ReferralRegistry addresses from deployments/<network>/
 *   - ENISHI_MASTER_WALLET from .env
 *
 * Wired manually afterwards: setAuthorizedCaller(Vault, true) (09_wire_all.ts).
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

  const enc = (await get("ENC")).address;
  const referral = (await get("ReferralRegistry")).address;
  const enishiMasterWallet = reqEnv("ENISHI_MASTER_WALLET");

  log(`\nDeploying ENCCommission on ${network.name}...`);
  log(`  enc                 : ${enc} (from deployments)`);
  log(`  referralRegistry    : ${referral} (from deployments)`);
  log(`  enishiMasterWallet  : ${enishiMasterWallet}`);
  log(`  owner               : ${deployer} (deployer; transfer later if needed)`);

  const args = [enc, referral, enishiMasterWallet];
  const result = await deploy("ENCCommission", {
    from: deployer,
    args,
    log: true,
    skipIfAlreadyDeployed: true,
    waitConfirmations: network.live ? 5 : 1,
  });

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

func.tags = ["ENCCommission"];
export default func;
