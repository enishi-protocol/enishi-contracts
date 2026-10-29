import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import * as fs from "fs";
import * as path from "path";

export type SwcEntry = {
  id: string;
  seoaAddress: string;
  privateKey: string;
  derivationPath: string;
};

// BIP-44 Ethereum account path — fixed, same as MetaMask / Trust Wallet.
const HD_PATH = "m/44'/60'/0'/0";

// id prefix: swc-001, swc-002…
const ID_PREFIX = "swc";

function reqEnv(key: string): string {
  const v = process.env[key];
  if (v === undefined || v.trim() === "")
    throw new Error(`Missing env var ${key}`);
  return v.trim();
}

function reqInt(key: string, allowZero = false): number {
  const raw = reqEnv(key);
  const n = Number(raw);
  const ok = Number.isInteger(n) && (allowZero ? n >= 0 : n > 0);
  if (!ok)
    throw new Error(
      `${key} must be a ${
        allowZero ? "non-negative" : "positive"
      } integer, got "${raw}"`,
    );
  return n;
}

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, network, ethers } = hre;
  const { log } = deployments;

  const count = reqInt("SEOA_COUNT");
  const hdIndex = reqInt("SEOA_HD_INDEX", true);
  const phrase = reqEnv("SEOA_MNEMONIC").replace(/\s+/g, " ");

  const mnemonic = ethers.Mnemonic.fromPhrase(phrase);

  const outPath = path.resolve(reqEnv("SEOA_OUTPUT"));

  log(`\nGenerating ${count} SEOAs...`);
  log(`  source : mnemonic (${phrase.split(" ").length} words)`);
  log(`  path   : ${HD_PATH}/${hdIndex} … ${HD_PATH}/${hdIndex + count - 1}`);
  log(`  output : ${outPath}`);

  const pad = Math.max(String(hdIndex + count).length, 3);

  const wallets: SwcEntry[] = Array.from({ length: count }, (_, i) => {
    const derivationPath = `${HD_PATH}/${hdIndex + i}`;
    const w = ethers.HDNodeWallet.fromMnemonic(mnemonic, derivationPath);
    return {
      id: `${ID_PREFIX}-${String(hdIndex + i + 1).padStart(pad, "0")}`,
      seoaAddress: w.address,
      privateKey: w.privateKey,
      derivationPath,
    };
  });

  if (new Set(wallets.map((w) => w.seoaAddress)).size !== wallets.length) {
    throw new Error("derivation produced duplicate addresses — aborting");
  }

  const serialized = JSON.stringify({ swcs: wallets }, null, 2);
  for (const entry of JSON.parse(serialized).swcs as SwcEntry[]) {
    const derived = new ethers.Wallet(entry.privateKey).address;
    if (derived !== entry.seoaAddress) {
      throw new Error(
        `${entry.id}: privateKey derives to ${derived}, not ${entry.seoaAddress} — aborting`,
      );
    }
    const fromSeed = ethers.HDNodeWallet.fromPhrase(
      phrase,
      "",
      entry.derivationPath,
    );
    if (fromSeed.privateKey !== entry.privateKey) {
      throw new Error(
        `${entry.id}: mnemonic + ${entry.derivationPath} does not reproduce the key — aborting`,
      );
    }
  }
  log(
    `  ${wallets.length}/${wallets.length} key verified (privateKey → address, and mnemonic + path → privateKey)`,
  );

  if (fs.existsSync(outPath)) {
    throw new Error(
      `${outPath} already exists — refusing to overwrite existing keys. Move it or set SEOA_OUTPUT.`,
    );
  }
  fs.writeFileSync(outPath, serialized);
  fs.chmodSync(outPath, 0o600);

  log(`  written to ${outPath} (chmod 600) — back this up now`);
  log(`  next: hardhat deploy --network ${network.name} --tags RegisterSEOAs`);
};

func.tags = ["GenerateSEOAs"];
export default func;
