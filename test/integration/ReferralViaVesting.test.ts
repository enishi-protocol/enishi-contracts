import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ENC_MAX_SUPPLY } from "../../helpers/encConstants";

/**
 * End-to-end proof that {ReferralRegistry} correctly serves two independent
 * writers — {ENCVesting} (onboarding a SEED beneficiary) and {Vault} (a real
 * deposit) — against the SAME registry instance without clobbering each other:
 *
 *   1. ENCVesting.addBeneficiaries registers the fresh user under a referrer.
 *   2. That same user's first Vault deposit, with referrer = address(0), must
 *      NOT revert (Vault.sol only requires a referrer when the registry has
 *      none on file yet — see Vault.sol's firstDeposit gate) and must NOT
 *      clobber the referrer ENCVesting already set.
 */

const ZERO = ethers.ZeroAddress;
const MAX_UINT = ethers.MaxUint256;

// ─── Fixed addresses pinned by {Vault} via EnishiAddresses (mainnet) ──────────
const ROUTER = ethers.getAddress("0x1b81D678ffb9C0263b24A97847620C99d213eB14");
const QUOTER = ethers.getAddress("0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997");
const AGGREGATOR = ethers.getAddress("0x1A0A18AC4BECDDbd6389559687d1A73d8927E416");
const PERMIT2 = ethers.getAddress("0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768");
const USDT = ethers.getAddress("0x55d398326f99059fF775485246999027B3197955");

const STRAT: string[] = [
  "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
  "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
  "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE",
  "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  "0x570A5D26f7765Ecb712C0924E4De545B89fD43dF",
  "0x1CE0c2827e2eF14D5C4f29a091d735A204794041",
  "0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD",
].map((a) => ethers.getAddress(a));

const RECEIPTS = ["EnBTC", "EnETH", "EnXRP", "EnBNB", "EnSOL", "EnAVAX", "EnLINK"];

// Real EnishiAddresses.EN_* constants (Vault._receiptAt reads EnishiAddresses.strategyAt
// directly — it does NOT take receipt addresses from the constructor — so the mock
// receipts must be etched at these exact addresses, not arbitrary placeholders).
const RECEIPT_ADDRS: string[] = [
  "0x8281c6790E8A4BAB0Ded95164A4c83e423C74b05", // EN_BTC
  "0x4019D71805A3a96d0E6d7f4Eb39B04c7d8e5D1e0", // EN_ETH
  "0x5BE9F238afC31b4e5ff424882c0423C0e1FED37b", // EN_XRP
  "0xcdb075800dD10f000517e5d2cb70F3b8360F4055", // EN_BNB
  "0x1BE0FD7f378177303dd4f591AB73b26a82346088", // EN_SOL
  "0x788309b5cea31AbC5bAf747742af6cf9Dcd4beED", // EN_AVAX
  "0xB417Bd7BC4BE3176483bAd9c0705576F3a5Cb83c", // EN_LINK
].map((a) => ethers.getAddress(a));

async function etchContract(target: string, src: any): Promise<void> {
  const srcAddr = await src.getAddress();
  const code = await ethers.provider.getCode(srcAddr);
  await ethers.provider.send("hardhat_setCode", [target, code]);
  for (let slot = 0; slot < 10; slot++) {
    const val = await ethers.provider.getStorage(srcAddr, slot);
    if (val !== ethers.ZeroHash) {
      await ethers.provider.send("hardhat_setStorageAt", [target, ethers.toBeHex(slot), val]);
    }
  }
}

const UR_EXECUTE_IFACE = new ethers.Interface([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline)",
]);
const AGG_FEE = 500;
function aggData(tokenIn: string, tokenOut: string, amountIn: bigint, minOut: bigint, recipient: string): string {
  const path = ethers.solidityPacked(["address", "uint24", "address"], [tokenIn, AGG_FEE, tokenOut]);
  const input = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "uint256", "bytes", "bool"],
    [recipient, amountIn, minOut, path, true],
  );
  return UR_EXECUTE_IFACE.encodeFunctionData("execute", ["0x00", [input], 2n ** 47n]);
}

function seoaAddrs(n: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(0x10_0000 + i), 20)),
  );
}

const ALL6 = Array.from({ length: 6 }, (_, i) => i + 1);

describe("ReferralRegistry shared between ENCVesting and Vault", () => {
  async function fixture() {
    const [deployer, fundWallet, referrerRoot, freshUser] = await ethers.getSigners();

    // ── Vault mocks (mirrors test/unit/Vault.test.ts's deployFixture) ──────────
    const Mock = await ethers.getContractFactory("MockERC20");
    const tpl = await Mock.deploy("TPL", "TPL", 18);
    await tpl.waitForDeployment();
    const erc20Code = await ethers.provider.getCode(await tpl.getAddress());
    for (const a of [USDT, ...STRAT]) {
      await ethers.provider.send("hardhat_setCode", [a, erc20Code]);
    }

    const Router = await ethers.getContractFactory("MockDexRouterV3");
    const routerTpl = await Router.deploy();
    await routerTpl.waitForDeployment();
    await ethers.provider.send("hardhat_setCode", [ROUTER, await ethers.provider.getCode(await routerTpl.getAddress())]);

    const Agg = await ethers.getContractFactory("MockUniversalRouter");
    const aggTpl = await Agg.deploy();
    await aggTpl.waitForDeployment();
    await ethers.provider.send("hardhat_setCode", [AGGREGATOR, await ethers.provider.getCode(await aggTpl.getAddress())]);

    const Permit2Mock = await ethers.getContractFactory("MockPermit2");
    const permit2Tpl = await Permit2Mock.deploy();
    await permit2Tpl.waitForDeployment();
    await ethers.provider.send("hardhat_setCode", [PERMIT2, await ethers.provider.getCode(await permit2Tpl.getAddress())]);

    const Quoter = await ethers.getContractFactory("MockDexQuoterV3");
    const quoterTpl = await Quoter.deploy();
    await quoterTpl.waitForDeployment();
    await ethers.provider.send("hardhat_setCode", [QUOTER, await ethers.provider.getCode(await quoterTpl.getAddress())]);

    const usdt = (await ethers.getContractAt("MockERC20", USDT)) as any;
    const strat = (await Promise.all(STRAT.map((a) => ethers.getContractAt("MockERC20", a)))) as any[];

    const receipts: any[] = [];
    for (let i = 0; i < RECEIPTS.length; i++) {
      const C = await ethers.getContractFactory(RECEIPTS[i]);
      const c = await C.deploy();
      await c.waitForDeployment();
      await etchContract(RECEIPT_ADDRS[i], c);
      receipts.push(await ethers.getContractAt(RECEIPTS[i], RECEIPT_ADDRS[i]));
    }

    const WhiteList = await ethers.getContractFactory("WhiteList");
    const whitelist = (await WhiteList.deploy(deployer.address)) as any;

    const Factory = await ethers.getContractFactory("SwapContractFactory");
    const factory = (await Factory.deploy()) as any;

    // ── The ONE ReferralRegistry both ENCVesting and Vault will share ─────────
    const Referral = await ethers.getContractFactory("ReferralRegistry");
    const referral = (await Referral.deploy(referrerRoot.address)) as any;

    const enc = (await Mock.deploy("Enishi Coin", "ENC", 18)) as any;
    await enc.waitForDeployment();
    const StakeRouter = await ethers.getContractFactory("MockStakeRouter");
    const stakeRouter = (await StakeRouter.deploy(await enc.getAddress())) as any;
    const EncCommission = await ethers.getContractFactory("MockENCCommission");
    const encCommission = (await EncCommission.deploy()) as any;

    const Vault = await ethers.getContractFactory("Vault");
    const vault = (await Vault.deploy(
      await whitelist.getAddress(),
      await factory.getAddress(),
      await referral.getAddress(),
      await encCommission.getAddress(),
      await stakeRouter.getAddress(),
      await enc.getAddress(),
      fundWallet.address,
    )) as any;
    const vaultAddr = await vault.getAddress();

    const OPERATOR_ROLE = await whitelist.OPERATOR_ROLE();
    await whitelist.grantRole(OPERATOR_ROLE, vaultAddr);
    await factory.setVault(vaultAddr);
    await referral.grantRole(await referral.OPERATOR_ROLE(), vaultAddr);
    for (const r of receipts) await r.setOperator(vaultAddr);

    const seoas = seoaAddrs(48);
    await whitelist.registerSEOAs(seoas);

    for (let i = 1; i < 7; i++) await strat[i].mint(ROUTER, ethers.parseEther("1000000000"));
    for (let i = 1; i < 7; i++) await strat[i].mint(AGGREGATOR, ethers.parseEther("1000000000"));

    const supply = ethers.parseEther("1000000");
    await usdt.mint(freshUser.address, supply);
    await usdt.connect(freshUser).approve(vaultAddr, MAX_UINT);

    // ── ENCVesting, wired to the SAME registry ────────────────────────────────
    const [, , , , team, treasury, pub] = await ethers.getSigners();
    const vesting = await (await ethers.getContractFactory("ENCVesting")).deploy(
      ENC_MAX_SUPPLY, team.address, treasury.address, pub.address, await referral.getAddress(),
    );
    // ENCVesting grants the deployer only DEFAULT_ADMIN_ROLE; the suite operates as deployer.
    await vesting.grantRole(await vesting.OPERATOR_ROLE(), (await ethers.getSigners())[0].address);
    await vesting.waitForDeployment();

    // Authorize ENCVesting to write into the shared registry.
    await referral.connect(deployer).grantRole(await referral.OPERATOR_ROLE(), await vesting.getAddress());

    return {
      deployer, fundWallet, referrerRoot, freshUser,
      vault, vaultAddr, whitelist, factory, referral, receipts,
      usdt, strat, vesting,
    };
  }

  it("onboards a beneficiary via ENCVesting, then the same user deposits into Vault with no referrer — the registry keeps the original", async () => {
    const { vault, vaultAddr, usdt, strat, referral, vesting, referrerRoot, freshUser } =
      await loadFixture(fixture);

    const SEED = 0;
    const E = ethers.parseUnits("1", 18);

    // 1. ENCVesting onboards freshUser under referrerRoot.
    await vesting.addBeneficiaries(SEED, [freshUser.address], [1_000n * E], [referrerRoot.address], true);

    // 2. Registered BEFORE any Vault interaction.
    expect(await referral.parentOf(freshUser.address)).to.equal(referrerRoot.address);

    // 3. freshUser's real first deposit into Vault, referrer = address(0).
    const slots = ALL6;
    const n = slots.length;
    const total = ethers.parseEther("10000") * BigInt(n);
    const per = total / BigInt(n);
    const minOuts = slots.map(() => 0n);
    const swapPaths = slots.map((s, i) =>
      aggData(USDT, STRAT[s] ?? STRAT[0], i === n - 1 ? per + (total - per * BigInt(n)) : per, 0n, vaultAddr));
    const bnbPerSeoa = ethers.parseEther("0.01");

    await expect(
      vault.connect(freshUser).executeDeposit(
        slots, USDT, total, minOuts, swapPaths, ZERO, { value: bnbPerSeoa * BigInt(n) },
      ),
    ).to.not.be.reverted;

    // 4. The registry still has the ORIGINAL referrer — Vault didn't clobber it.
    expect(await referral.parentOf(freshUser.address)).to.equal(referrerRoot.address);
  });
});
