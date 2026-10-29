import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import * as fs from "fs";
import * as path from "path";
import { SwcEntry } from "./10_generate_swc_config";

function reqEnv(key: string): string {
  const v = process.env[key];
  if (v === undefined || v.trim() === "")
    throw new Error(`Missing env var ${key}`);
  return v.trim();
}

function reqInt(key: string): number {
  const raw = reqEnv(key);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${key} must be a positive integer, got "${raw}"`);
  return n;
}

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network, ethers } = hre;
  const { log, get } = deployments;
  const { deployer } = await getNamedAccounts();

  const whitelistAddr = (await get("WhiteList")).address;
  const batchSize = reqInt("SEOA_BATCH_SIZE");
  const configPath = path.resolve(reqEnv("SEOA_OUTPUT"));

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `${configPath} not found — run --tags GenerateSEOAs first, or set SEOA_OUTPUT`,
    );
  }
  const entries = JSON.parse(fs.readFileSync(configPath, "utf8"))
    .swcs as SwcEntry[];
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${configPath} has no "swcs" entries`);
  }

  const whitelist = await ethers.getContractAt("WhiteList", whitelistAddr);

  log(
    `\nRegistering SEOAs into WhiteList ${whitelistAddr} on ${network.name}...`,
  );
  log(`  config    : ${configPath} (${entries.length} SEOA)`);
  log(`  sender    : ${deployer}`);
  log(`  poolSize  : ${await whitelist.poolSize()} (before)`);

  // ─── 1. The file must describe the keys it claims to ──────────────────────

  for (const entry of entries) {
    const derived = new ethers.Wallet(entry.privateKey).address;
    if (derived !== ethers.getAddress(entry.seoaAddress)) {
      throw new Error(
        `${entry.id}: privateKey derives to ${derived}, not ${entry.seoaAddress} — aborting, nothing registered`,
      );
    }
  }
  log(`  ${entries.length}/${entries.length} privateKey → address verified`);

  // ─── 2. Register what is not in the pool yet ──────────────────────────────

  const pending: string[] = [];
  for (const entry of entries) {
    if (!(await whitelist.isWhitelisted(entry.seoaAddress)))
      pending.push(entry.seoaAddress);
  }
  log(
    `  already registered: ${entries.length - pending.length}, to register: ${
      pending.length
    }`,
  );

  const confirmations = network.live ? 2 : 1;
  for (let i = 0; i < pending.length; i += batchSize) {
    const chunk = pending.slice(i, i + batchSize);
    const tx = await whitelist.registerSEOAs(chunk);
    const receipt = await tx.wait(confirmations);
    log(
      `  batch ${Math.floor(i / batchSize) + 1}: +${chunk.length} SEOA — tx ${
        receipt?.hash
      } (gas ${receipt?.gasUsed})`,
    );
  }

  // ─── 3. Confirm the pool holds every SEOA in the file ─────────────────────

  for (const entry of entries) {
    if (!(await whitelist.isWhitelisted(entry.seoaAddress))) {
      throw new Error(
        `${entry.id} (${entry.seoaAddress}) is in the config but not registered on chain`,
      );
    }
  }
  log(
    `  ${entries.length}/${entries.length} SEOA confirmed registered on chain`,
  );

  log(`\n  poolSize  : ${await whitelist.poolSize()} (after)`);
  log(`  available : ${await whitelist.availableInPool()}`);
};

func.tags = ["RegisterSEOAs"];
export default func;
