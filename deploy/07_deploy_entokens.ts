import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys all 7 Enishi receipt tokens.
 *
 * Deploy only. Permission model (per token), wired manually afterwards:
 *   - owner    = deployer (rotate to multisig via transferOwnership)
 *   - operator = unset. Owner calls setOperator(vault) once the Vault exists.
 *
 * On bscMainnet / bscTestnet, also writes each deployed address into that
 * network's address library (EnishiAddresses.sol / EnishiAddressesTestnet.sol)
 * EN_* constants and recompiles — Vault.sol (deployed next, in 08) resolves
 * receipt tokens through that library at compile time, so it must see the real
 * addresses before it builds. Other networks (hardhat, localhost) are skipped.
 */
const TOKENS = [
  { name: "EnBTC", constant: "EN_BTC" },
  { name: "EnETH", constant: "EN_ETH" },
  { name: "EnXRP", constant: "EN_XRP" },
  { name: "EnBNB", constant: "EN_BNB" },
  { name: "EnSOL", constant: "EN_SOL" },
  { name: "EnAVAX", constant: "EN_AVAX" },
  { name: "EnLINK", constant: "EN_LINK" },
] as const;

const LIBRARIES_DIR = path.join(__dirname, "..", "contracts", "libraries");

const ADDRESSES_FILE_BY_NETWORK: Record<string, string> = {
  bscMainnet: "EnishiAddresses.sol",
  bscTestnet: "EnishiAddressesTestnet.sol",
};

/**
 * Replace one `address internal constant <name> = 0x...;` assignment (the
 * value may be on the same line or the next, and `=` may be column-aligned,
 * matching the libraries' existing styles) with `newAddress`, preserving
 * everything else byte-for-byte.
 */
function setAddressConstant(
  source: string,
  fileName: string,
  constantName: string,
  newAddress: string,
): string {
  const pattern = new RegExp(
    `(address internal constant ${constantName}\\s*=\\s*)0x[0-9a-fA-F]{40}(;)`,
  );
  if (!pattern.test(source)) {
    throw new Error(
      `${fileName}: could not find constant ${constantName} to update`,
    );
  }
  return source.replace(pattern, `$1${newAddress}$2`);
}

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log(`\nDeploying Enishi receipt tokens on ${network.name}...`);
  log(`  owner    = deployer = ${deployer}`);
  log(`  operator = (unset — call setOperator(vault) manually after deploy)`);

  const deployedAddresses: Record<string, string> = {};

  for (const { name } of TOKENS) {
    const result = await deploy(name, {
      from: deployer,
      args: [],
      log: true,
      skipIfAlreadyDeployed: true,
      waitConfirmations: network.live ? 5 : 1,
    });
    deployedAddresses[name] = result.address;

    if (network.live && result.newlyDeployed) {
      try {
        await hre.run("verify:verify", {
          address: result.address,
          constructorArguments: [],
        });
        log(`  ${name} verified`);
      } catch (e) {
        log(`  ${name} verify skipped/failed: ${(e as Error).message}`);
      }
    }
  }

  const addressesFileName = ADDRESSES_FILE_BY_NETWORK[network.name];
  if (addressesFileName) {
    const addressesFile = path.join(LIBRARIES_DIR, addressesFileName);
    log(`\nUpdating ${addressesFileName} with the deployed receipt token addresses...`);
    let source = fs.readFileSync(addressesFile, "utf8");
    for (const { name, constant } of TOKENS) {
      source = setAddressConstant(source, addressesFileName, constant, deployedAddresses[name]);
      log(`  ${constant} = ${deployedAddresses[name]}`);
    }
    fs.writeFileSync(addressesFile, source);

    log(`  Recompiling so later deploy steps (Vault) build against the new addresses...`);
    await hre.run("compile");
  }
};

func.tags = ["EnTokens"];
export default func;
