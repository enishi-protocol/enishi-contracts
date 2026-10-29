import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network, ethers } = hre;
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();

  // Owner is the deployer (constructor uses msg.sender). Transfer to a
  // multisig/timelock after deploy if desired.

  log(`\nDeploying SwapContractFactory on ${network.name}...`);
  log(`  owner    : ${deployer} (deployer)`);

  const result = await deploy("SwapContractFactory", {
    from: deployer,
    args: [],
    log: true,
    skipIfAlreadyDeployed: true,
    waitConfirmations: network.live ? 5 : 1,
  });

  // vault is left unset — call `setVault(vault)` manually after the Vault deploy.

  // Log the auto-deployed SwapContract implementation.
  const factory = await ethers.getContractAt(
    "SwapContractFactory",
    result.address,
  );
  const impl = await factory.IMPLEMENTATION();
  log(`  IMPLEMENTATION : ${impl}`);

  if (network.live && result.newlyDeployed) {
    log(`\nVerifying SwapContractFactory on BSCScan...`);
    try {
      await hre.run("verify:verify", {
        address: result.address,
        constructorArguments: [],
      });
    } catch (err) {
      log(`Factory verification skipped/failed: ${(err as Error).message}`);
    }

    log(`\nVerifying SwapContract implementation on BSCScan...`);
    try {
      await hre.run("verify:verify", {
        address: impl,
        constructorArguments: [],
      });
    } catch (err) {
      log(
        `Implementation verification skipped/failed: ${(err as Error).message}`,
      );
    }
  }
};

func.tags = ["SwapContractFactory"];
// The factory's constructor deploys the SwapContract implementation, which
// resolves receipt tokens (EN_*) from the address library at compile time —
// EnTokens must deploy and write their addresses into it first.
func.dependencies = ["EnTokens"];
export default func;
