import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

/**
 * Deploys EnishiPublicSale.
 *
 * Runs right after ENC (02c) and before 02e_wire_vesting's genesis mint —
 * ENC.mintGenesis mints the 20,000,000 ENC Public Sale carve-out straight into
 * this contract, so its address must exist before that one-shot mint runs.
 *
 * ENC_TOKEN is not a constructor argument (see EnishiPublicSale.sol) — it is
 * set once here via setEncToken right after deploy. The sale starts closed;
 * once the genesis mint has landed the carve-out (= the default sale cap,
 * which opening requires to be fully backed), ENC_VESTING_PUBLIC_WALLET
 * (the operator) opens it with setSaleOpen(true).
 *
 * ENC comes from deployments/<network>/ (ENC.json). USDT is read from
 * BSC_USDT in .env — set it to the right address for whichever network
 * you're deploying to (mainnet USDT for bscMainnet/bscStgMainet, testnet
 * USDT otherwise), mirroring Vault.sol's STABLE_USDT without hard-coding the
 * address here. Treasury is ENISHI_MASTER_WALLET (same operating wallet
 * ENCLock/ENCCommission pay into), read from .env. OPERATOR_ROLE is granted
 * to ENC_VESTING_PUBLIC_WALLET (same wallet ENCVesting's PUBLIC round pays
 * into) — it runs the sale day to day, not the deployer.
 *
 * On bscTestnet this deploys EnishiPublicSaleTestnet (operator-controlled
 * clock — warpBy/warpTo), still recorded as deployments/<network>/
 * EnishiPublicSale.json so 02e_wire_vesting is unchanged. Every other network gets
 * the real EnishiPublicSale.
 */
function reqEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var ${key}`);
  return v;
}

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network, ethers } = hre;
  const { deploy, log, get } = deployments;
  const { deployer } = await getNamedAccounts();

  const enc = (await get("ENC")).address;
  const usdt = reqEnv("BSC_USDT");
  const treasury = reqEnv("ENISHI_MASTER_WALLET");
  const operator = reqEnv("ENC_VESTING_PUBLIC_WALLET");

  const args = [usdt, treasury];

  log(`\nDeploying EnishiPublicSale on ${network.name}...`);
  log(`  usdt      (BSC_USDT, from .env)                 : ${usdt}`);
  log(`  treasury  (ENISHI_MASTER_WALLET, from .env)     : ${treasury}`);
  log(`  operator  (ENC_VESTING_PUBLIC_WALLET, from .env): ${operator}`);

  const contract = network.name === "bscTestnet" ? "EnishiPublicSaleTestnet" : "EnishiPublicSale";
  log(`  contract  : ${contract}`);

  const sale = await deploy("EnishiPublicSale", {
    contract,
    from: deployer,
    args,
    log: true,
    skipIfAlreadyDeployed: true,
    waitConfirmations: network.live ? 5 : 1,
  });

  log(`  EnishiPublicSale deployed at: ${sale.address}`);

  if (network.live && sale.newlyDeployed) {
    try {
      await hre.run("verify:verify", {
        address: sale.address,
        constructorArguments: args,
      });
    } catch (e) {
      log(`  EnishiPublicSale verify skipped/failed: ${(e as Error).message}`);
    }
  }

  const saleContract = await ethers.getContractAt("EnishiPublicSale", sale.address);

  // deployer holds DEFAULT_ADMIN_ROLE from construction, which is all
  // setEncToken needs. OPERATOR_ROLE (setSaleOpen/setSaleParams/
  // sweepUnsold) goes to ENC_VESTING_PUBLIC_WALLET instead —
  // the wallet that runs the sale day to day, not the deployer.
  const OPERATOR_ROLE = await saleContract.OPERATOR_ROLE();
  if (!(await saleContract.hasRole(OPERATOR_ROLE, operator))) {
    const tx = await saleContract.grantRole(OPERATOR_ROLE, operator);
    await tx.wait(network.live ? 2 : 1);
    log(`  EnishiPublicSale.grantRole(OPERATOR_ROLE, ${operator})`);
  }

  const currentEnc: string = await saleContract.ENC_TOKEN();
  if (currentEnc === ethers.ZeroAddress) {
    const tx = await saleContract.setEncToken(enc);
    await tx.wait(network.live ? 2 : 1);
    log(`  EnishiPublicSale.setEncToken(${enc})`);
  } else {
    log(`  EnishiPublicSale.ENC_TOKEN already set: ${currentEnc}`);
  }
};

func.tags = ["PublicSale"];
export default func;
