import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

/**
 * Deploys {ENC} — after {ENCVesting}, the genesis mint's sole recipient.
 *
 * Deploy only — the genesis mint (`ENC.mintGenesis(vesting, publicSale)`) and
 * the `start(<enc>)` press are run by 02e_wire_vesting.
 *
 * If the ENCVesting in deployments/ has already
 * been started, its ENC is fixed forever: this script then deploys nothing and
 * records that ENC into deployments/<network>/ENC.json instead, so ENCLock,
 * ENCCommission and Vault are built against the token the vesting pays out.
 */
const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network, ethers } = hre;
  const { deploy, log, get, save, getOrNull, getArtifact } = deployments;
  const { deployer } = await getNamedAccounts();

  const vestingAddr = (await get("ENCVesting")).address;
  const vesting = await ethers.getContractAt("ENCVesting", vestingAddr);
  if ((await vesting.startTime()) !== 0n) {
    const address: string = await vesting.ENC_TOKEN();
    const existing = await getOrNull("ENC");
    if (existing && existing.address.toLowerCase() === address.toLowerCase()) {
      log(`\nENC: reusing ${address} (fixed by started ENCVesting ${vestingAddr})`);
      return;
    }
    if (existing) {
      throw new Error(
        `deployments/ has ENC ${existing.address} but ENCVesting ${vestingAddr} already ` +
          `started with ENC ${address}. Delete deployments/${network.name}/ENC.json to adopt it.`,
      );
    }
    const artifact = await getArtifact("ENC");
    await save("ENC", { address, abi: artifact.abi });
    log(`\nENC: adopted ${address} — fixed by started ENCVesting ${vestingAddr}, not deployed`);
    return;
  }

  log(`\nDeploying ENC on ${network.name}...`);
  log(`  deployer: ${deployer}`);

  const enc = await deploy("ENC", {
    from: deployer,
    args: [],
    log: true,
    skipIfAlreadyDeployed: true,
    waitConfirmations: network.live ? 5 : 1,
  });

  log(`  ENC deployed at: ${enc.address}`);

  if (network.live && enc.newlyDeployed) {
    try {
      await hre.run("verify:verify", { address: enc.address, constructorArguments: [] });
    } catch (e) {
      log(`  ENC verify skipped/failed: ${(e as Error).message}`);
    }
  }
};

func.tags = ["ENC"];
export default func;
