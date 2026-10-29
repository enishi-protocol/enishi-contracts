import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();

  // Constructor arg: initial OPERATOR_ROLE grantee. The Vault does not exist
  const operator = deployer;

  log(`\nDeploying WhiteList on ${network.name}...`);
  log(`  operator : ${operator}`);

  const result = await deploy("WhiteList", {
    from: deployer,
    args: [operator],
    log: true,
    skipIfAlreadyDeployed: true,
    waitConfirmations: network.live ? 5 : 1,
  });

  if (network.live && result.newlyDeployed) {
    log(`\nVerifying on BSCScan...`);
    try {
      await hre.run("verify:verify", {
        address: result.address,
        constructorArguments: [operator],
      });
    } catch (err) {
      log(`Verification skipped/failed: ${(err as Error).message}`);
    }
  }
};

func.tags = ["WhiteList"];
export default func;
