import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

/**
 * Deploys ENCStakeRouter.
 *
 * Deploy only. Constructor args, all from deployments/<network>/:
 *   - ENCLock, EnishiPublicSale, ENCCommission
 *
 * Skipped while the network has no EnishiPublicSale deployment: the router
 * requires the sale to have code, and 08_deploy_vault then fails until the
 * sale is deployed. The Vault takes the router in its constructor.
 *
 * Wired afterwards by 09_wire_all.ts: router.setVault(Vault),
 * EnishiPublicSale.setStakeRouter(router, ENCCommission),
 * ENCLock.setVault(router).
 */
const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, log, get, getOrNull } = deployments;
  const { deployer } = await getNamedAccounts();

  const publicSale = await getOrNull("EnishiPublicSale");
  if (!publicSale) {
    log(`\nENCStakeRouter skipped on ${network.name}: no EnishiPublicSale deployment.`);
    return;
  }

  // A sale deployed before the commission API would leave every lot inactive
  // behind the router's try/catch. Refuse it rather than wire it silently.
  const sale = await hre.ethers.getContractAt("EnishiPublicSale", publicSale.address);
  try {
    await sale.stakeRouter();
  } catch {
    throw new Error(
      `EnishiPublicSale ${publicSale.address} predates the commission API (no stakeRouter()); ` +
        `redeploy it with 02d before deploying ENCStakeRouter.`,
    );
  }

  const encLock = (await get("ENCLock")).address;
  const encCommission = (await get("ENCCommission")).address;

  log(`\nDeploying ENCStakeRouter on ${network.name}...`);
  log(`  encLock       : ${encLock} (from deployments)`);
  log(`  publicSale    : ${publicSale.address} (from deployments)`);
  log(`  encCommission : ${encCommission} (from deployments)`);
  log(`  owner         : ${deployer} (deployer; transfer later if needed)`);

  const args = [encLock, publicSale.address, encCommission];
  const result = await deploy("ENCStakeRouter", {
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

func.tags = ["ENCStakeRouter"];
export default func;
