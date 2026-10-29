import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

/**
 * Deploys ReferralRegistry with `REFER_ROOT` from .env as the root referrer.
 *
 * Recorded in deployments/<network>/ReferralRegistry.json, where every later
 * script (ENCVesting, ENCCommission, Vault, Wire) resolves it from.
 */
function reqEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var ${key}`);
  return v;
}

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();

  const root = reqEnv("REFER_ROOT");

  log(`\nDeploying ReferralRegistry on ${network.name}...`);
  log(`  root : ${root}`);

  const result = await deploy("ReferralRegistry", {
    from: deployer,
    args: [root],
    log: true,
    skipIfAlreadyDeployed: true,
    waitConfirmations: network.live ? 5 : 1,
  });

  if (network.live && result.newlyDeployed) {
    log(`\nVerifying on BSCScan...`);
    try {
      await hre.run("verify:verify", {
        address: result.address,
        constructorArguments: [root],
      });
    } catch (e) {
      log(`verify skipped/failed: ${(e as Error).message}`);
    }
  }
};

func.tags = ["ReferralRegistry"];
export default func;
