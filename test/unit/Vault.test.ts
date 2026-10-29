import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

const ZERO = ethers.ZeroAddress;
const MAX_UINT = ethers.MaxUint256;
const FEE = 500; // V3_FEE_DEFAULT

// Encode a packed V3 path: abi.encodePacked(token0, fee0, token1, …).
function encodePath(tokens: string[], fees: number[]): string {
  let p = tokens[0].toLowerCase().replace("0x", "");
  for (let i = 0; i < fees.length; i++) {
    p += fees[i].toString(16).padStart(6, "0") + tokens[i + 1].toLowerCase().replace("0x", "");
  }
  return "0x" + p;
}

// ─── EIP-2612 permit signing ──────────────────────────────────────────────────
// The receipt (enToken) contracts inherit ERC20Permit; requestExit consumes an
// off-chain permit instead of a prior approve. Sign the EIP-712 Permit digest for
// `owner`, granting `spender` an allowance of `value` until `deadline`.
async function signPermit(
  token: any,
  owner: any,
  spender: string,
  value: bigint,
  deadline: bigint,
): Promise<{ v: number; r: string; s: string }> {
  const [name, nonce, net] = await Promise.all([
    token.name(),
    token.nonces(owner.address),
    ethers.provider.getNetwork(),
  ]);
  const domain = {
    name,
    version: "1",
    chainId: net.chainId,
    verifyingContract: await token.getAddress(),
  };
  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const sig = ethers.Signature.from(
    await owner.signTypedData(domain, types, {
      owner: owner.address,
      spender,
      value,
      nonce,
      deadline,
    }),
  );
  return { v: sig.v, r: sig.r, s: sig.s };
}

// Well-formed but empty permit fields, for exit paths that revert *before* the
// contract reaches the permit call (InvalidSlot, SwcNotFound, NothingToExit, …).
const DUMMY_PERMIT = {
  permitDeadline: 0n,
  permitV: 0,
  permitR: ethers.ZeroHash,
  permitS: ethers.ZeroHash,
};

// Build the four permit fields for `slot`: a real signature when `signer` holds a
// receipt balance for that slot, otherwise the dummy (revert happens earlier).
async function permitFields(ctx: any, slot: number, signer: any) {
  const receipt = ctx.receipts?.[slot];
  if (!receipt) return DUMMY_PERMIT;
  const amount = await receipt.balanceOf(signer.address);
  if (amount === 0n) return DUMMY_PERMIT;
  const { v, r, s } = await signPermit(receipt, signer, ctx.vaultAddr, amount, ethers.MaxUint256);
  return { permitDeadline: ethers.MaxUint256, permitV: v, permitR: r, permitS: s };
}

// ─── Fixed addresses pinned by {Vault} via EnishiAddresses (mainnet) ──────────
// These mirror EnishiAddresses.sol exactly; we inject mock code at them.
const ROUTER = ethers.getAddress("0x1b81D678ffb9C0263b24A97847620C99d213eB14"); // PANCAKE_V3
const QUOTER = ethers.getAddress("0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997");
const AGGREGATOR = ethers.getAddress("0x1A0A18AC4BECDDbd6389559687d1A73d8927E416"); // PANCAKE_UNIVERSAL_ROUTER_V2_V3
const PERMIT2 = ethers.getAddress("0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768"); // PANCAKE_PERMIT2

// Real classic Universal Router `execute(commands, inputs, deadline)` calldata
// with a single V3_SWAP_EXACT_IN command (recipient is the calling contract),
// as validated on-chain by UniversalRouterGuard. The fee tier is arbitrary —
// the mock router and the guard both only read the path's first/last token.
const UR_EXECUTE_IFACE = new ethers.Interface([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline)",
]);
const V3_SWAP_EXACT_IN = "0x00";
const AGG_FEE = 500;
function aggData(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  minOut: bigint,
  recipient: string,
): string {
  const path = ethers.solidityPacked(["address", "uint24", "address"], [tokenIn, AGG_FEE, tokenOut]);
  const input = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "uint256", "bytes", "bool"],
    [recipient, amountIn, minOut, path, true],
  );
  return UR_EXECUTE_IFACE.encodeFunctionData("execute", [V3_SWAP_EXACT_IN, [input], 2n ** 47n]);
}
// The single supported stablecoin (EnishiAddresses.BSC_USDT).
const USDT = ethers.getAddress("0x55d398326f99059fF775485246999027B3197955");
// Mainnet USDC — no longer supported; used to assert UnsupportedStablecoin.
const UNSUPPORTED_STABLE = ethers.getAddress("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d");

// Mainnet Available Token (strategy) addresses from EnishiAddresses.strategyAt,
// slot 0..6 (slot 3 is WBNB).
const STRAT: string[] = [
  "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
  "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
  "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE",
  "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  "0x570A5D26f7765Ecb712C0924E4De545B89fD43dF",
  "0x1CE0c2827e2eF14D5C4f29a091d735A204794041",
  "0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD",
].map((a) => ethers.getAddress(a));

// Receipt contract names indexed by strategy slot (must match symbol → slot
// binding in EnishiAddresses.strategyAt).
const RECEIPTS = [
  "EnBTC", "EnETH", "EnXRP", "EnBNB", "EnSOL", "EnAVAX", "EnLINK",
];

// Receipt token addresses pinned by EnishiAddresses.strategyAt, slot 0..6 —
// the Vault calls these directly, so the mocks must be etched exactly here.
const RECEIPT_ADDRS: string[] = [
  "0x8281c6790E8A4BAB0Ded95164A4c83e423C74b05", // EN_BTC
  "0x4019D71805A3a96d0E6d7f4Eb39B04c7d8e5D1e0", // EN_ETH
  "0x5BE9F238afC31b4e5ff424882c0423C0e1FED37b", // EN_XRP
  "0xcdb075800dD10f000517e5d2cb70F3b8360F4055", // EN_BNB
  "0x1BE0FD7f378177303dd4f591AB73b26a82346088", // EN_SOL
  "0x788309b5cea31AbC5bAf747742af6cf9Dcd4beED", // EN_AVAX
  "0xB417Bd7BC4BE3176483bAd9c0705576F3a5Cb83c", // EN_LINK
].map((a) => ethers.getAddress(a));

// Put a fully-initialised copy of `src` (code + storage) at `target`. Unlike a
// bare hardhat_setCode, this also carries name/symbol/owner so owner-gated and
// metadata calls work at the pinned address.
async function etchContract(target: string, src: any): Promise<void> {
  const srcAddr = await src.getAddress();
  const code = await ethers.provider.getCode(srcAddr);
  await ethers.provider.send("hardhat_setCode", [target, code]);
  for (let slot = 0; slot < 10; slot++) {
    const val = await ethers.provider.getStorage(srcAddr, slot);
    if (val !== ethers.ZeroHash) {
      await ethers.provider.send("hardhat_setStorageAt", [
        target,
        ethers.toBeHex(slot),
        val,
      ]);
    }
  }
}

// We exercise slots 1..6 (bootstrap still creates all 7 SWCs since it never
// *calls* the token). Slot 0 is left out to keep these deposit assertions
// focused; on real BSC every slot maps to a live token.
const ALL6 = Array.from({ length: 6 }, (_, i) => i + 1); // slots 1..6
const SIX = [1, 2, 3, 4, 5, 6];

// Deterministic, collision-free SEOA addresses (well above injected ranges).
function seoaAddrs(n: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(0x10_0000 + i), 20)),
  );
}

describe("Vault.executeDeposit", () => {
  // Same rig with the testnet-only VaultTestnet (owner-controlled exit clock)
  // swapped in for Vault. Built on top of deployFixture's snapshot rather than
  // re-running it — deployFixture's hardhat_reset would otherwise invalidate
  // every other test's fixture snapshot.
  async function deployTestnetFixture() {
    const ctx = await loadFixture(deployFixture);
    const VaultTestnet = await ethers.getContractFactory("VaultTestnet");
    const vault = (await VaultTestnet.deploy(
      await ctx.whitelist.getAddress(),
      await ctx.factory.getAddress(),
      await ctx.referral.getAddress(),
      await ctx.encCommission.getAddress(),
      await ctx.stakeMock.getAddress(),
      await ctx.enc.getAddress(),
      ctx.fundWallet.address,
    )) as any;
    const vaultAddr = await vault.getAddress();

    await ctx.whitelist.grantRole(await ctx.whitelist.OPERATOR_ROLE(), vaultAddr);
    await ctx.factory.setVault(vaultAddr);
    await ctx.referral.grantRole(await ctx.referral.OPERATOR_ROLE(), vaultAddr);
    for (const r of ctx.receipts) await r.setOperator(vaultAddr);
    for (const u of [ctx.user, ctx.user2]) {
      for (const tk of [ctx.usdt, ctx.unsupported]) {
        await tk.connect(u).approve(vaultAddr, MAX_UINT);
      }
    }

    return { ...ctx, vault, vaultAddr };
  }

  async function deployFixture() {
    // Reset to a clean chain first. Other test files (e.g. SwapContract.test.ts)
    // inject mocks at these same pinned mainnet addresses via hardhat_setCode,
    // which replaces bytecode but never clears storage — without this reset,
    // whichever file runs first leaves token balances sitting in storage that
    // this fixture's own minting then stacks on top of, double-counting balances.
    await ethers.provider.send("hardhat_reset", []);

    const [deployer, operator, fundWallet, referrerRoot, user, user2, stranger] =
      await ethers.getSigners();

    // 1. Inject MockERC20 runtime code at the pinned token addresses.
    const Mock = await ethers.getContractFactory("MockERC20");
    const tpl = await Mock.deploy("TPL", "TPL", 18);
    await tpl.waitForDeployment();
    const erc20Code = await ethers.provider.getCode(await tpl.getAddress());
    for (const a of [USDT, UNSUPPORTED_STABLE, ...STRAT]) {
      await ethers.provider.send("hardhat_setCode", [a, erc20Code]);
    }

    // 2. Inject MockDexRouterV3 at the V3 router address and MockDexQuoterV3
    //    at the V3 quoter address.
    const Router = await ethers.getContractFactory("MockDexRouterV3");
    const routerTpl = await Router.deploy();
    await routerTpl.waitForDeployment();
    const routerCode = await ethers.provider.getCode(await routerTpl.getAddress());
    await ethers.provider.send("hardhat_setCode", [ROUTER, routerCode]);

    const Agg = await ethers.getContractFactory("MockUniversalRouter");
    const aggTpl = await Agg.deploy();
    await aggTpl.waitForDeployment();
    const aggCode = await ethers.provider.getCode(await aggTpl.getAddress());
    await ethers.provider.send("hardhat_setCode", [AGGREGATOR, aggCode]);

    // Inject MockPermit2 at PANCAKE_PERMIT2; the Universal Router pulls tokenIn
    // through Permit2, so deposit / exit-consolidation swaps revert without it.
    const Permit2Mock = await ethers.getContractFactory("MockPermit2");
    const permit2Tpl = await Permit2Mock.deploy();
    await permit2Tpl.waitForDeployment();
    const permit2Code = await ethers.provider.getCode(await permit2Tpl.getAddress());
    await ethers.provider.send("hardhat_setCode", [PERMIT2, permit2Code]);

    const Quoter = await ethers.getContractFactory("MockDexQuoterV3");
    const quoterTpl = await Quoter.deploy();
    await quoterTpl.waitForDeployment();
    const quoterCode = await ethers.provider.getCode(await quoterTpl.getAddress());
    await ethers.provider.send("hardhat_setCode", [QUOTER, quoterCode]);

    const usdt = (await ethers.getContractAt("MockERC20", USDT)) as any;
    const unsupported = (await ethers.getContractAt("MockERC20", UNSUPPORTED_STABLE)) as any;
    const strat = (await Promise.all(
      STRAT.map((a) => ethers.getContractAt("MockERC20", a)),
    )) as any[];
    const router = (await ethers.getContractAt("MockDexRouterV3", ROUTER)) as any;
    const agg = (await ethers.getContractAt("MockUniversalRouter", AGGREGATOR)) as any;
    const quoter = (await ethers.getContractAt("MockDexQuoterV3", QUOTER)) as any;

    // 3. Deploy the 7 receipt tokens, then etch each (code + storage) at its
    //    hard-coded address so the Vault constructor's symbol check resolves.
    const receipts: any[] = [];
    for (let i = 0; i < RECEIPTS.length; i++) {
      const C = await ethers.getContractFactory(RECEIPTS[i]);
      const c = await C.deploy();
      await c.waitForDeployment();
      await etchContract(RECEIPT_ADDRS[i], c);
      receipts.push(await ethers.getContractAt(RECEIPTS[i], RECEIPT_ADDRS[i]));
    }

    // 4. Deploy dependencies. Operator slots that must point at the Vault are
    //    set to the deployer first (chicken-and-egg), then re-pointed after.
    const WhiteList = await ethers.getContractFactory("WhiteList");
    const whitelist = (await WhiteList.deploy(deployer.address)) as any;

    const Factory = await ethers.getContractFactory("SwapContractFactory");
    const factory = (await Factory.deploy()) as any; // deployer = owner

    const Referral = await ethers.getContractFactory("ReferralRegistry");
    const referral = (await Referral.deploy(
      referrerRoot.address,
    )) as any;

    // ENC stack: a plain ERC20 stands in for ENC; MockStakeRouter stands in for
    // the stake router and MockENCCommission for the splitter,
    // so the daily processProfit settlement (CASE A/B) runs deterministically.
    const enc = (await Mock.deploy("Enishi Coin", "ENC", 18)) as any;
    await enc.waitForDeployment();
    const StakeMock = await ethers.getContractFactory("MockStakeRouter");
    const stakeMock = (await StakeMock.deploy(await enc.getAddress())) as any;
    const EncCommission = await ethers.getContractFactory("MockENCCommission");
    const encCommission = (await EncCommission.deploy()) as any;

    const Vault = await ethers.getContractFactory("Vault");
    const vault = (await Vault.deploy(
      await whitelist.getAddress(),
      await factory.getAddress(),
      await referral.getAddress(),
      await encCommission.getAddress(),
      await stakeMock.getAddress(),
      await enc.getAddress(),
      fundWallet.address,
    )) as any;
    const vaultAddr = await vault.getAddress();

    // 5. Wire permissions toward the Vault.
    const OPERATOR_ROLE = await whitelist.OPERATOR_ROLE();
    await whitelist.grantRole(OPERATOR_ROLE, vaultAddr);
    await factory.setVault(vaultAddr);
    await referral.grantRole(await referral.OPERATOR_ROLE(), vaultAddr);
    for (const r of receipts) await r.setOperator(vaultAddr);

    // 6. Register a SEOA pool (enough for 3 users).
    const seoas = seoaAddrs(48);
    await whitelist.registerSEOAs(seoas);

    // 7. Pre-fund the router with output (Available) tokens for every slot.
    for (let i = 1; i < 7; i++) await strat[i].mint(ROUTER, ethers.parseEther("1000000000"));
    for (let i = 1; i < 7; i++) await strat[i].mint(AGGREGATOR, ethers.parseEther("1000000000"));

    // 8. Fund users with stablecoins + approve the Vault.
    const supply = ethers.parseEther("1000000");
    for (const u of [user, user2]) {
      for (const tk of [usdt, unsupported]) {
        await tk.mint(u.address, supply);
        await tk.connect(u).approve(vaultAddr, MAX_UINT);
      }
    }

    return {
      deployer, operator, fundWallet, referrerRoot, user, user2, stranger,
      vault, vaultAddr, whitelist, factory, referral, receipts,
      usdt, unsupported, strat, router, agg, quoter,
      enc, stakeMock, encCommission,
    };
  }

  // Convenience wrapper around executeDeposit with sane defaults.
  async function deposit(
    ctx: any,
    {
      signer,
      slots = ALL6,
      token = ctx.usdt,
      total,
      minOuts,
      swapPaths,
      bnbPerSeoa = ethers.parseEther("0.01"),
      referrer,
    }: any,
  ) {
    const n = slots.length;
    total = total ?? ethers.parseEther("10000") * BigInt(n);
    minOuts = minOuts ?? slots.map(() => 0n);
    referrer = referrer === undefined ? ctx.referrerRoot.address : referrer;
    const tokenAddr = await token.getAddress();
    const per = total / BigInt(n);
    const remainder = total - per * BigInt(n);
    swapPaths = swapPaths ?? slots.map((s: number, i: number) =>
      aggData(tokenAddr, STRAT[s] ?? STRAT[0], i === n - 1 ? per + remainder : per, 0n, ctx.vaultAddr));
    const value = bnbPerSeoa * BigInt(n);
    return ctx.vault
      .connect(signer ?? ctx.user)
      .executeDeposit(
        slots,
        tokenAddr,
        total,
        minOuts,
        swapPaths,
        referrer,
        { value },
      );
  }

  // Put a real EnishiPublicSale + ENCLock behind an ENCStakeRouter and point
  // the Vault at it. `bind = false` leaves the sale unbound (a miswired deploy).
  async function attachStakeRouter(ctx: any, bind = true) {
    const sale = (await (await ethers.getContractFactory("EnishiPublicSale"))
      .deploy(USDT, ctx.operator.address)) as any;
    await sale.grantRole(await sale.OPERATOR_ROLE(), ctx.deployer.address);
    await sale.setEncToken(ctx.enc.target);
    await ctx.enc.mint(sale.target, ethers.parseEther("20000000"));
    await sale.setSaleOpen(true);

    const lock = (await (await ethers.getContractFactory("ENCLock"))
      .deploy(ctx.enc.target, ctx.operator.address)) as any;
    const stakeRouter = (await (await ethers.getContractFactory("ENCStakeRouter"))
      .deploy(lock.target, sale.target, ctx.encCommission.target)) as any;

    await stakeRouter.setVault(ctx.vaultAddr);
    await lock.setVault(stakeRouter.target);
    if (bind) await sale.setStakeRouter(stakeRouter.target, ctx.encCommission.target);
    await ctx.vault.setStakeRouter(stakeRouter.target);

    await ctx.usdt.connect(ctx.user).approve(sale.target, MAX_UINT);
    await ctx.enc.mint(ctx.user.address, ethers.parseEther("10"));
    await ctx.enc.connect(ctx.user).approve(lock.target, MAX_UINT);
    await ctx.enc.mint(ctx.router.target, ethers.parseEther("100")); // DEX leg

    return { sale, lock, stakeRouter };
  }

  // ─── Happy path: first deposit (bootstrap) ──────────────────────────────────

  describe("first deposit (bootstrap)", () => {
    it("bootstraps the user: picks 7 SEOAs and creates 7 SWCs", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(deposit(ctx, { signer: ctx.user })).to.emit(
        ctx.factory,
        "SwapContractCreated",
      );

      expect(await ctx.whitelist.userPicked(ctx.user.address)).to.equal(true);
      const seoas = await ctx.whitelist.getUserSEOAs(ctx.user.address);
      expect(seoas).to.have.lengthOf(7);

      for (let s = 0; s < 7; s++) {
        const swc = await ctx.factory.swcOf(ctx.user.address, STRAT[s]);
        expect(swc).to.not.equal(ZERO);
      }
    });

    it("pulls the full deposit from the user and leaves no stablecoin dust in the Vault", async () => {
      const ctx = await loadFixture(deployFixture);
      const total = ethers.parseEther("10000") * 6n;
      const before = await ctx.usdt.balanceOf(ctx.user.address);

      await deposit(ctx, { signer: ctx.user, total });

      expect(await ctx.usdt.balanceOf(ctx.user.address)).to.equal(before - total);
      expect(await ctx.usdt.balanceOf(ctx.vaultAddr)).to.equal(0);
    });

    it("mints receipts 1:1 with swap output and routes tokens to each SWC", async () => {
      const ctx = await loadFixture(deployFixture);
      const perSlot = ethers.parseEther("10000");
      await deposit(ctx, { signer: ctx.user, slots: ALL6, total: perSlot * 6n });

      for (const s of ALL6) {
        // 1:1 router → tokenOut == perSlot.
        expect(await ctx.receipts[s].balanceOf(ctx.user.address)).to.equal(perSlot);
        const swc = await ctx.factory.swcOf(ctx.user.address, STRAT[s]);
        expect(await ctx.strat[s].balanceOf(swc)).to.equal(perSlot);
      }
    });

    // USDT is the only accepted deposit token; anything else must revert.
    it("reverts UnsupportedStablecoin for a non-USDT deposit token", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        deposit(ctx, { signer: ctx.user, token: ctx.unsupported }),
      ).to.be.revertedWithCustomError(ctx.vault, "UnsupportedStablecoin");
    });

    it("funds each SEOA with bnbPerSeoa and emits SeoaFunded", async () => {
      const ctx = await loadFixture(deployFixture);
      const bnb = ethers.parseEther("0.01");
      await deposit(ctx, { signer: ctx.user, bnbPerSeoa: bnb });

      const seoas = await ctx.whitelist.getUserSEOAs(ctx.user.address);
      // Only the selected slots (1..6) are funded; slot 0 is never deposited.
      for (const slot of ALL6) {
        expect(await ethers.provider.getBalance(seoas[slot])).to.equal(bnb);
      }
    });

    it("emits Deposited for every slot with correct args", async () => {
      const ctx = await loadFixture(deployFixture);
      const perSlot = ethers.parseEther("10000");
      const tx = await deposit(ctx, { signer: ctx.user, slots: SIX, total: perSlot * 6n });
      const rc = await tx.wait();
      const events = rc!.logs
        .map((l: any) => {
          try { return ctx.vault.interface.parseLog(l); } catch { return null; }
        })
        .filter((e: any) => e?.name === "Deposited");
      expect(events).to.have.lengthOf(SIX.length);
      for (let i = 0; i < SIX.length; i++) {
        expect(events[i].args.user).to.equal(ctx.user.address);
        expect(events[i].args.slot).to.equal(SIX[i]);
        expect(events[i].args.availableToken).to.equal(STRAT[SIX[i]]);
        expect(events[i].args.usdtIn).to.equal(perSlot);
        expect(events[i].args.tokenOut).to.equal(perSlot);
      }
    });

    it("registers the referrer on first deposit", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user });
      expect(await ctx.referral.parentOf(ctx.user.address)).to.equal(
        ctx.referrerRoot.address,
      );
    });
  });

  // ─── Equal split / remainder ────────────────────────────────────────────────

  describe("equal split and remainder", () => {
    it("splits evenly and pushes the remainder to the last slot", async () => {
      const ctx = await loadFixture(deployFixture);
      // Total ≥ MIN_DEPOSIT and indivisible by 6 → remainder to the last slot.
      const total = ethers.parseEther("10000") + 3n;
      const perSlot = total / 6n;
      const remainder = total - perSlot * 6n;
      await deposit(ctx, {
        signer: ctx.user,
        slots: SIX,
        total,
        minOuts: SIX.map(() => 0n),
      });

      for (let i = 0; i < 5; i++) {
        expect(await ctx.receipts[SIX[i]].balanceOf(ctx.user.address)).to.equal(perSlot);
      }
      // Last slot carries the remainder.
      expect(await ctx.receipts[SIX[5]].balanceOf(ctx.user.address)).to.equal(perSlot + remainder);
    });
  });

  // ─── Second deposit (reuse) ─────────────────────────────────────────────────

  describe("subsequent deposit (reuse)", () => {
    it("does not re-bootstrap or require a referrer", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user });

      // 2nd deposit, referrer omitted (zero) must NOT revert.
      const tx = await deposit(ctx, { signer: ctx.user, referrer: ZERO });
      await expect(tx).to.not.emit(ctx.factory, "SwapContractCreated");
    });

    it("approves the DEX per-swap with the exact amount (consumed to 0)", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user });
      // _swapViaAggregator forceApproves the exact amount then resets it to 0.
      expect(await ctx.usdt.allowance(ctx.vaultAddr, AGGREGATOR)).to.equal(0n);
      // A second deposit still succeeds (each slot re-approves its exact amount).
      await deposit(ctx, { signer: ctx.user, referrer: ZERO });
    });

    it("doubles receipt balance after two identical deposits", async () => {
      const ctx = await loadFixture(deployFixture);
      const perSlot = ethers.parseEther("10000");
      await deposit(ctx, { signer: ctx.user, slots: ALL6, total: perSlot * 6n });
      await deposit(ctx, { signer: ctx.user, slots: ALL6, total: perSlot * 6n, referrer: ZERO });
      expect(await ctx.receipts[1].balanceOf(ctx.user.address)).to.equal(perSlot * 2n);
    });
  });

  // ─── Multi-user isolation ───────────────────────────────────────────────────

  describe("multi-user", () => {
    it("assigns disjoint SEOA sets to different users", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user });
      await deposit(ctx, { signer: ctx.user2 });

      const a: string[] = await ctx.whitelist.getUserSEOAs(ctx.user.address);
      const b: string[] = await ctx.whitelist.getUserSEOAs(ctx.user2.address);
      const overlap = a.filter((x) => b.includes(x));
      expect(overlap).to.have.lengthOf(0);
    });
  });

  // ─── Stablecoin variants ────────────────────────────────────────────────────

  describe("supported stablecoins", () => {
    it("accepts USDT as the deposit token", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        deposit(ctx, { signer: ctx.user, token: ctx.usdt }),
      ).to.emit(ctx.vault, "Deposited");
    });

    it("rejects any other stablecoin", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        deposit(ctx, { signer: ctx.user, token: ctx.unsupported }),
      ).to.be.revertedWithCustomError(ctx.vault, "UnsupportedStablecoin");
    });
  });

  // ─── BNB funding edge ───────────────────────────────────────────────────────

  describe("BNB funding", () => {
    it("funds every deposited slot's SEOA with the per-slot share", async () => {
      const ctx = await loadFixture(deployFixture);
      const per = ethers.parseEther("0.01");
      await deposit(ctx, { signer: ctx.user, slots: SIX, bnbPerSeoa: per });
      const seoas = await ctx.whitelist.getUserSEOAs(ctx.user.address);
      // Slots 1..7 were deposited → their SEOAs are funded with `per`.
      expect(await ethers.provider.getBalance(seoas[1])).to.equal(per);
    });

    it("allows omitting the BNB top-up (msg.value 0 → SEOAs funded out-of-band)", async () => {
      const ctx = await loadFixture(deployFixture);
      // bnbPerSeoa 0 → msg.value 0 → topUpBnb=false → no SEOA funding, no revert.
      await expect(
        deposit(ctx, { signer: ctx.user, bnbPerSeoa: 0n }),
      ).to.emit(ctx.vault, "Deposited");
    });
  });

  // ─── Slippage guard ─────────────────────────────────────────────────────────

  describe("slippage", () => {
    it("reverts when aggregator output is below minTokenOut", async () => {
      const ctx = await loadFixture(deployFixture);
      // Aggregator returns 50% → output less than the demanded minTokenOut.
      await ctx.agg.setOutRateBps(5000);
      const perSlot = ethers.parseEther("10000");
      await expect(
        deposit(ctx, {
          signer: ctx.user,
          total: perSlot * 6n,
          minOuts: ALL6.map(() => perSlot), // demand 1:1, but get 0.5
        }),
      ).to.be.revertedWithCustomError(ctx.vault, "InsufficientSwapOutput");
    });

    it("succeeds when minTokenOut accounts for the rate", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.agg.setOutRateBps(9000); // 90%
      const perSlot = ethers.parseEther("10000");
      await deposit(ctx, {
        signer: ctx.user,
        slots: ALL6,
        total: perSlot * 6n,
        minOuts: ALL6.map(() => (perSlot * 9000n) / 10000n),
      });
      expect(await ctx.receipts[1].balanceOf(ctx.user.address)).to.equal(
        (perSlot * 9000n) / 10000n,
      );
    });
  });

  // ─── Reverts: validation ────────────────────────────────────────────────────

  describe("setStakeRouter", () => {
    it("owner repoints STAKE_ROUTER and emits StakeRouterUpdated", async () => {
      const ctx = await loadFixture(deployFixture);
      const old = await ctx.stakeMock.getAddress();
      const next = await (await (await ethers.getContractFactory("MockStakeRouter"))
        .deploy(await ctx.enc.getAddress())).getAddress();
      await expect(ctx.vault.connect(ctx.deployer).setStakeRouter(next))
        .to.emit(ctx.vault, "StakeRouterUpdated")
        .withArgs(old, next);
      expect(await ctx.vault.STAKE_ROUTER()).to.equal(next);
    });

    it("reverts when a non-owner calls", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        ctx.vault.connect(ctx.stranger).setStakeRouter(await ctx.enc.getAddress()),
      ).to.be.revertedWithCustomError(ctx.vault, "OwnableUnauthorizedAccount");
    });

    it("reverts on the zero address", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        ctx.vault.connect(ctx.deployer).setStakeRouter(ZERO),
      ).to.be.revertedWithCustomError(ctx.vault, "ZeroAddress");
    });
  });

  describe("reverts", () => {
    it("InvalidStrategyCount when below MIN_STRATEGIES", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        ctx.vault
          .connect(ctx.user)
          .executeDeposit([], USDT, ethers.parseEther("10000"), [], [], ctx.referrerRoot.address),
      ).to.be.revertedWithCustomError(ctx.vault, "InvalidStrategyCount");
    });

    it("InvalidStrategyCount when above STRATEGY_COUNT", async () => {
      const ctx = await loadFixture(deployFixture);
      const seventeen = Array.from({ length: 8 }, (_, i) => i % 7);
      await expect(
        deposit(ctx, { signer: ctx.user, slots: seventeen }),
      ).to.be.revertedWithCustomError(ctx.vault, "InvalidStrategyCount");
    });

    it("DepositBelowMinimum when totalDeposit is zero", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        deposit(ctx, { signer: ctx.user, total: 0n }),
      ).to.be.revertedWithCustomError(ctx.vault, "DepositBelowMinimum");
    });

    it("DepositBelowMinimum just below the 10,000 minimum", async () => {
      const ctx = await loadFixture(deployFixture);
      const total = ethers.parseEther("10000") - 1n;
      await expect(
        deposit(ctx, {
          signer: ctx.user,
          slots: SIX,
          total,
        }),
      )
        .to.be.revertedWithCustomError(ctx.vault, "DepositBelowMinimum")
        .withArgs(ethers.parseEther("10000"), total);
    });

    it("accepts a total of exactly MIN_DEPOSIT (10,000 USDT)", async () => {
      const ctx = await loadFixture(deployFixture);
      expect(await ctx.vault.MIN_DEPOSIT()).to.equal(ethers.parseEther("10000"));
      await expect(
        deposit(ctx, { signer: ctx.user, slots: SIX, total: ethers.parseEther("10000") }),
      ).to.emit(ctx.vault, "Deposited");
    });

    it("LengthMismatch when minTokenOuts length differs", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        deposit(ctx, { signer: ctx.user, slots: SIX, minOuts: [0n, 0n] }),
      ).to.be.revertedWithCustomError(ctx.vault, "LengthMismatch");
    });

    it("UnsupportedStablecoin for a non-stable token", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        deposit(ctx, { signer: ctx.user, token: ctx.strat[0] }),
      ).to.be.revertedWithCustomError(ctx.vault, "UnsupportedStablecoin");
    });

    it("allows an excess BNB top-up (only a shortfall reverts)", async () => {
      const ctx = await loadFixture(deployFixture);
      // 0.1 BNB / 6 = 0.01666 per SEOA (≥ min); the indivisible remainder is
      // allowed to stay in the Vault rather than reverting.
      const total = ethers.parseEther("16000");
      const per = total / 6n;
      const rem = total - per * 6n;
      await expect(
        ctx.vault.connect(ctx.user).executeDeposit(
          ALL6,
          USDT,
          total,
          ALL6.map(() => 0n),
          ALL6.map((s: number, i: number) =>
            aggData(USDT, STRAT[s], i === ALL6.length - 1 ? per + rem : per, 0n, ctx.vaultAddr)),
          ctx.referrerRoot.address,
          { value: ethers.parseEther("0.1") },
        ),
      ).to.emit(ctx.vault, "Deposited");
    });

    it("BnbBelowMinimum when the per-slot share is under the minimum", async () => {
      const ctx = await loadFixture(deployFixture);
      // 0.015 / 6 = 0.0025 BNB per SEOA, below MIN_BNB_PER_SEOA (0.003).
      await expect(
        ctx.vault.connect(ctx.user).executeDeposit(
          ALL6,
          USDT,
          ethers.parseEther("16000"),
          ALL6.map(() => 0n),
          ALL6.map((s: number) => encodePath([USDT, STRAT[s]], [FEE])),
          ctx.referrerRoot.address,
          { value: ethers.parseEther("0.015") },
        ),
      ).to.be.revertedWithCustomError(ctx.vault, "BnbBelowMinimum");
    });

    it("ReferrerRequired when first deposit has no referrer", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        deposit(ctx, { signer: ctx.user, referrer: ZERO }),
      ).to.be.revertedWithCustomError(ctx.vault, "ReferrerRequired");
    });

    it("DuplicateSlot when a slot repeats", async () => {
      const ctx = await loadFixture(deployFixture);
      const dup = [1, 2, 3, 4, 5, 6, 6];
      await expect(
        deposit(ctx, { signer: ctx.user, slots: dup }),
      ).to.be.revertedWithCustomError(ctx.vault, "DuplicateSlot");
    });

    it("InvalidSlot when a slot is out of range", async () => {
      const ctx = await loadFixture(deployFixture);
      const bad = [1, 2, 3, 4, 5, 7];
      await expect(
        deposit(ctx, { signer: ctx.user, slots: bad }),
      ).to.be.revertedWithCustomError(ctx.vault, "InvalidSlot");
    });

    it("reverts when paused and works again after unpause", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.vault.connect(ctx.deployer).pause();
      await expect(
        deposit(ctx, { signer: ctx.user }),
      ).to.be.revertedWithCustomError(ctx.vault, "EnforcedPause");

      await ctx.vault.connect(ctx.deployer).unpause();
      await expect(deposit(ctx, { signer: ctx.user })).to.emit(
        ctx.vault,
        "Deposited",
      );
    });
  });

  // ─── processProfit (daily Fund-System flow, REAL Vault) ───────────────────
  // The SWC's _realizeProfit swaps profit straight into the Vault (recipient ==
  // vault) THEN calls processProfit — so the Vault must distribute the balance
  // it already holds, NOT pull from the SWC. (A leftover transferFrom(swc) here
  // would revert: the SWC holds no stablecoin after the swap.)
  describe("processProfit (daily, real Vault)", () => {
    const GROSS = ethers.parseEther("1"); // grossProfit in payout stablecoin

    async function asSwc(swc: string) {
      await ethers.provider.send("hardhat_impersonateAccount", [swc]);
      await ethers.provider.send("hardhat_setBalance", [
        swc,
        "0x56BC75E2D63100000", // 100 ETH for gas
      ]);
      return ethers.getSigner(swc);
    }

    function pp(ctx: any, over: Record<string, any> = {}) {
      const payoutToken = over.payoutToken ?? USDT;
      return {
        user: ctx.user.address,
        availableToken: STRAT[1],
        grossProfit: GROSS,
        payoutToken,
        minEncOut: 0n,
        encPath: encodePath([payoutToken, ctx.enc.target], [FEE]),
        ...over,
      };
    }

    // CASE A: no/insufficient ENC stake → buy ENC on the DEX.
    it("CASE A: Fund(20%) + ENC(25%) + payout, distributing the Vault's balance (no SWC pull)", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX }); // bootstrap → SWC for STRAT[1]
      const swc = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);

      // Contract pulls grossProfit from the SWC: fund + approve it.
      await ctx.usdt.mint(swc, GROSS);
      await ctx.usdt.connect(await asSwc(swc)).approve(ctx.vaultAddr, GROSS);
      await ctx.enc.mint(ctx.router.target, ethers.parseEther("100")); // USDT→ENC

      const fund = ethers.parseEther("0.2"); // 20% of 1
      const encStable = ethers.parseEther("0.2"); // 25% of net (0.8)
      const userPayout = ethers.parseEther("0.6");

      const userBefore = await ctx.usdt.balanceOf(ctx.user.address);
      const swcSigner = await asSwc(swc);

      await expect(ctx.vault.connect(swcSigner).processProfit(pp(ctx)))
        .to.emit(ctx.vault, "ProfitProcessed")
        .withArgs(
          ctx.user.address,
          STRAT[1],
          USDT,
          GROSS,
          fund,
          encStable,
          userPayout,
          0n, // totalAssetUSD — only the exit path computes one
        );

      expect(await ctx.usdt.balanceOf(ctx.fundWallet.address)).to.equal(fund);
      expect(await ctx.encCommission.lastUser()).to.equal(ctx.user.address);
      expect(await ctx.encCommission.lastAmount()).to.equal(encStable);
      expect(await ctx.usdt.balanceOf(ctx.user.address)).to.equal(
        userBefore + userPayout,
      );
      // The SWC was never debited — its stablecoin balance stays 0.
      expect(await ctx.usdt.balanceOf(swc)).to.equal(0);
    });

    // CASE B: enough ENC stake → pull ENC from the lock, user keeps full net.
    it("CASE B: ENC commission from stake, full net profit to user", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swc = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);

      await ctx.usdt.mint(swc, GROSS);
      await ctx.usdt.connect(await asSwc(swc)).approve(ctx.vaultAddr, GROSS);
      await ctx.stakeMock.setBps(2000); // discounted rate (≠ default 2500)
      await ctx.stakeMock.setStaked(ethers.parseEther("1"));
      await ctx.enc.mint(ctx.stakeMock.target, ethers.parseEther("1"));

      const fund = ethers.parseEther("0.2");
      const net = ethers.parseEther("0.8");
      const encFromStake = ethers.parseEther("0.16"); // 20% of net, 1:1 quote

      const userBefore = await ctx.usdt.balanceOf(ctx.user.address);
      const swcSigner = await asSwc(swc);

      await ctx.vault.connect(swcSigner).processProfit(pp(ctx));

      expect(await ctx.usdt.balanceOf(ctx.fundWallet.address)).to.equal(fund);
      expect(await ctx.encCommission.lastAmount()).to.equal(encFromStake);
      expect(await ctx.stakeMock.staked()).to.equal(
        ethers.parseEther("1") - encFromStake,
      );
      // CASE B spends no stablecoin on ENC → user gets the full net.
      expect(await ctx.usdt.balanceOf(ctx.user.address)).to.equal(
        userBefore + net,
      );
    });

    it("distributes only the ENC the commission contract received, not what the router reports", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swc = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);
      await ctx.usdt.mint(swc, GROSS);
      await ctx.usdt.connect(await asSwc(swc)).approve(ctx.vaultAddr, GROSS);
      await ctx.stakeMock.setBps(2000);
      await ctx.stakeMock.setStaked(ethers.parseEther("1"));
      await ctx.stakeMock.setOverReport(ethers.parseEther("5")); // faulty router
      await ctx.enc.mint(ctx.stakeMock.target, ethers.parseEther("1"));

      const quotesBefore = await ctx.quoter.quoteCount();
      await ctx.vault.connect(await asSwc(swc)).processProfit(pp(ctx));

      expect((await ctx.quoter.quoteCount()) - quotesBefore).to.equal(1n);
      expect(await ctx.encCommission.lastAmount()).to.equal(ethers.parseEther("0.16"));
    });

    it("no stake in play: no quote, straight to the 25% swap", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swc = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);
      await ctx.usdt.mint(swc, GROSS);
      await ctx.usdt.connect(await asSwc(swc)).approve(ctx.vaultAddr, GROSS);
      await ctx.enc.mint(ctx.router.target, ethers.parseEther("100"));

      const quotesBefore = await ctx.quoter.quoteCount();
      await ctx.vault.connect(await asSwc(swc)).processProfit(pp(ctx));

      expect(await ctx.quoter.quoteCount()).to.equal(quotesBefore);
      expect(await ctx.encCommission.lastAmount()).to.equal(ethers.parseEther("0.2"));
    });

    it("reverts UnsupportedStablecoin when payoutToken is not USDT", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swc = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);
      await ctx.unsupported.mint(swc, GROSS);
      await ctx.unsupported.connect(await asSwc(swc)).approve(ctx.vaultAddr, GROSS);

      await expect(
        ctx.vault
          .connect(await asSwc(swc))
          .processProfit(pp(ctx, { payoutToken: UNSUPPORTED_STABLE })),
      ).to.be.revertedWithCustomError(ctx.vault, "UnsupportedStablecoin");
    });

    it("UnauthorizedSettler when caller is not the SWC for (user, token)", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      await ctx.usdt.mint(ctx.vaultAddr, GROSS);
      await expect(
        ctx.vault.connect(ctx.stranger).processProfit(pp(ctx)),
      ).to.be.revertedWithCustomError(ctx.vault, "UnauthorizedSettler");
    });

    it("NothingToProcess when grossProfit is 0", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swc = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);
      const swcSigner = await asSwc(swc);
      await expect(
        ctx.vault.connect(swcSigner).processProfit(pp(ctx, { grossProfit: 0n })),
      ).to.be.revertedWithCustomError(ctx.vault, "NothingToProcess");
    });

    it("UnsupportedStablecoin for a non-stable payout token", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swc = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);
      const swcSigner = await asSwc(swc);
      await expect(
        ctx.vault
          .connect(swcSigner)
          .processProfit(pp(ctx, { payoutToken: STRAT[1] })),
      ).to.be.revertedWithCustomError(ctx.vault, "UnsupportedStablecoin");
    });

    // Public Sale commission: the Vault reads a real ENCStakeRouter,
    // backed by a real EnishiPublicSale and a real ENCLock. 1:1 ENC quote.
    describe("via ENCStakeRouter (Public Sale decision table)", () => {
      const DAY = 86_400;
      const WINDOW = 1090 * DAY;
      const NET = ethers.parseEther("0.8");
      const PS_ENC = ethers.parseEther("0.08"); // 10% of net, from the lots
      const LOCK_ENC = ethers.parseEther("0.168"); // 21% of net, 30-day lock
      const SWAP_ENC = ethers.parseEther("0.2"); // 25% of net, bought on the DEX

      async function routerFixture() {
        const ctx = await loadFixture(deployFixture);
        await deposit(ctx, { signer: ctx.user, slots: SIX });
        const swc = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);
        return { ...ctx, swc, ...(await attachStakeRouter(ctx)) };
      }

      // Public Sale rows of the table; each leaves the clock where the row holds.
      const ROWS: Record<string, (ctx: any) => Promise<void>> = {
        "lot active, enough ENC": async (ctx) => {
          await ctx.sale.connect(ctx.user).buy(1); // 200,000 ENC
        },
        "lot active, not enough ENC": async (ctx) => {
          const cap = await ctx.sale.saleCapEnc();
          await ctx.sale.setSaleParams(ethers.parseEther("1"), ethers.parseEther("0.01"), cap);
          await ctx.sale.connect(ctx.user).buy(1); // 0.01 ENC < 0.08
        },
        "lot active, no ENC left": async (ctx) => {
          await ctx.sale.connect(ctx.user).buy(1);
          await time.increase(1060 * DAY); // last tranche, still inside the window
          await ctx.sale.connect(ctx.user).claim();
        },
        "lot expired": async (ctx) => {
          await ctx.sale.connect(ctx.user).buy(1);
          await time.increase(WINDOW);
        },
      };

      // Staking columns; locked after the row so the 30-day lock is live.
      const COLS: Record<string, bigint> = {
        "enough stake": ethers.parseEther("1"),
        "not enough stake": ethers.parseEther("0.1"),
      };

      type Source = "publicSale" | "lock" | "swap";
      const TABLE: [string, string, Source][] = [
        ["lot active, enough ENC", "enough stake", "publicSale"],
        ["lot active, enough ENC", "not enough stake", "publicSale"],
        ["lot active, not enough ENC", "enough stake", "lock"],
        ["lot active, not enough ENC", "not enough stake", "swap"],
        ["lot active, no ENC left", "enough stake", "lock"],
        ["lot active, no ENC left", "not enough stake", "swap"],
        ["lot expired", "enough stake", "lock"],
        ["lot expired", "not enough stake", "swap"],
      ];

      for (const [row, col, source] of TABLE) {
        it(`${row} × ${col} → ${source}`, async () => {
          const ctx = await loadFixture(routerFixture);
          await ROWS[row](ctx);
          await ctx.lock.connect(ctx.user).lock(COLS[col], 30);

          const lockedBefore = await ctx.sale.totalLocked();
          const stakeBefore = (await ctx.lock.lockOf(ctx.user.address)).amount;
          const userBefore = await ctx.usdt.balanceOf(ctx.user.address);

          await ctx.usdt.mint(ctx.swc, GROSS);
          const swcSigner = await asSwc(ctx.swc);
          await ctx.usdt.connect(swcSigner).approve(ctx.vaultAddr, GROSS);
          await ctx.vault.connect(swcSigner).processProfit(pp(ctx));

          const payout = (await ctx.usdt.balanceOf(ctx.user.address)) - userBefore;
          const fromSale = lockedBefore - (await ctx.sale.totalLocked());
          const fromLock = stakeBefore - (await ctx.lock.lockOf(ctx.user.address)).amount;
          const charged = await ctx.encCommission.lastAmount();

          if (source === "publicSale") {
            expect([payout, charged, fromSale, fromLock]).to.deep.equal([NET, PS_ENC, PS_ENC, 0n]);
          } else if (source === "lock") {
            expect([payout, charged, fromSale, fromLock]).to.deep.equal([NET, LOCK_ENC, 0n, LOCK_ENC]);
          } else {
            expect([payout, charged, fromSale, fromLock]).to.deep.equal([NET - SWAP_ENC, SWAP_ENC, 0n, 0n]);
          }
        });
      }

      it("lot and lock both cover: one quote at the lock's 21%, the lot charged 10% scaled from it", async () => {
        const ctx = await loadFixture(routerFixture);
        await ctx.sale.connect(ctx.user).buy(1);
        await ctx.lock.connect(ctx.user).lock(ethers.parseEther("1"), 30);
        const lockedBefore = await ctx.sale.totalLocked();

        await ctx.usdt.mint(ctx.swc, GROSS);
        const swcSigner = await asSwc(ctx.swc);
        await ctx.usdt.connect(swcSigner).approve(ctx.vaultAddr, GROSS);
        const quotesBefore = await ctx.quoter.quoteCount();
        await ctx.vault.connect(swcSigner).processProfit(pp(ctx));

        expect((await ctx.quoter.quoteCount()) - quotesBefore).to.equal(1n);
        expect(await ctx.encCommission.lastAmount()).to.equal(PS_ENC);
        expect(lockedBefore - (await ctx.sale.totalLocked())).to.equal(PS_ENC);
        expect((await ctx.lock.lockOf(ctx.user.address)).amount).to.equal(ethers.parseEther("1"));
      });

      it("lot short, lock covers: still one quote, lock charged at its plan", async () => {
        const ctx = await loadFixture(routerFixture);
        const cap = await ctx.sale.saleCapEnc();
        await ctx.sale.setSaleParams(ethers.parseEther("1"), ethers.parseEther("0.01"), cap);
        await ctx.sale.connect(ctx.user).buy(1); // 0.01 ENC < 0.08
        await ctx.lock.connect(ctx.user).lock(ethers.parseEther("1"), 30);

        await ctx.usdt.mint(ctx.swc, GROSS);
        const swcSigner = await asSwc(ctx.swc);
        await ctx.usdt.connect(swcSigner).approve(ctx.vaultAddr, GROSS);
        const quotesBefore = await ctx.quoter.quoteCount();
        await ctx.vault.connect(swcSigner).processProfit(pp(ctx));

        expect((await ctx.quoter.quoteCount()) - quotesBefore).to.equal(1n);
        expect(await ctx.encCommission.lastAmount()).to.equal(LOCK_ENC);
      });

      it("a buyer who never bought keeps the lock path", async () => {
        const ctx = await loadFixture(routerFixture);
        await ctx.lock.connect(ctx.user).lock(ethers.parseEther("1"), 30);

        await ctx.usdt.mint(ctx.swc, GROSS);
        const swcSigner = await asSwc(ctx.swc);
        await ctx.usdt.connect(swcSigner).approve(ctx.vaultAddr, GROSS);
        await ctx.vault.connect(swcSigner).processProfit(pp(ctx));

        expect(await ctx.encCommission.lastAmount()).to.equal(LOCK_ENC);
      });

      it("an unbound sale degrades to the lock instead of reverting NotStakeRouter", async () => {
        const ctx = await loadFixture(deployFixture);
        await deposit(ctx, { signer: ctx.user, slots: SIX });
        const swc = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);
        const { sale, lock } = await attachStakeRouter(ctx, false);
        await sale.connect(ctx.user).buy(1);
        await lock.connect(ctx.user).lock(ethers.parseEther("1"), 30);

        await ctx.usdt.mint(swc, GROSS);
        const swcSigner = await asSwc(swc);
        await ctx.usdt.connect(swcSigner).approve(ctx.vaultAddr, GROSS);
        await ctx.vault.connect(swcSigner).processProfit(pp(ctx));

        expect(await ctx.encCommission.lastAmount()).to.equal(LOCK_ENC);
        expect((await sale.lotsOf(ctx.user.address))[0].remaining).to.equal(ethers.parseEther("200000"));
      });

      it("a failing Public Sale degrades to the lock instead of blocking settlement", async () => {
        const ctx = await loadFixture(routerFixture);
        const broken = await (await ethers.getContractFactory("MockRevertingPublicSale"))
          .deploy(ctx.encCommission.target);
        const stakeRouter = (await (await ethers.getContractFactory("ENCStakeRouter"))
          .deploy(ctx.lock.target, broken.target, ctx.encCommission.target)) as any;
        await stakeRouter.setVault(ctx.vaultAddr);
        await ctx.lock.setVault(stakeRouter.target);
        await ctx.vault.setStakeRouter(stakeRouter.target);
        await ctx.lock.connect(ctx.user).lock(ethers.parseEther("1"), 30);

        await ctx.usdt.mint(ctx.swc, GROSS);
        const swcSigner = await asSwc(ctx.swc);
        await ctx.usdt.connect(swcSigner).approve(ctx.vaultAddr, GROSS);
        await ctx.vault.connect(swcSigner).processProfit(pp(ctx));

        expect(await ctx.encCommission.lastAmount()).to.equal(LOCK_ENC);
      });
    });
  });

  // ─── requestExit / withdrawExit (two-phase, EXIT_DELAY) ───────────────────
  describe("requestExit / withdrawExit (two-phase)", () => {
    const PER = ethers.parseEther("10000"); // enToken minted per slot (1:1 mock)
    const DEP = 2; // a non-special slot's token used as a "deployed token"
    const EXIT_DELAY = 48 * 3600;

    // Build ExitParams for `slot`, including a live EIP-2612 permit signed by
    // `signer` (defaults to ctx.user) over that slot's current receipt balance.
    async function ep(
      ctx: any,
      slot: number,
      over: Record<string, any> = {},
      signer: any = ctx.user,
    ) {
      const base = {
        slot,
        minConsolidationOuts: new Array(7).fill(0n),
        consolidationPaths: new Array(7).fill("0x"),
        minStableOut: 0n,
        stablePath: "0x",
        minEncOut: 0n,
        encPath: "0x",
        payoutStable: false,
      };
      const permit = await permitFields(ctx, slot, signer);
      // permit provides a valid default; an explicit permit* in `over` wins.
      return { ...base, ...permit, ...over };
    }

    async function timeTravel(secs: number) {
      await ethers.provider.send("evm_increaseTime", [secs]);
      await ethers.provider.send("evm_mine", []);
    }

    // Phase-1 request driven entirely by a permit signature (no prior approve).
    async function reqExit(ctx: any, slot: number, over: Record<string, any> = {}) {
      return ctx.vault.connect(ctx.user).requestExit(await ep(ctx, slot, over));
    }

    // Owner-triggered phase-2 withdrawal (auth: SEOA operator or owner).
    async function withdraw(ctx: any, user: string, slot: number) {
      return ctx.vault.connect(ctx.deployer).withdrawExit(user, slot);
    }

    // Drive a real round-1 deploy on the SWC so realizeForExit unwinds it.
    async function deploySome(ctx: any, swcAddr: string, amount: bigint) {
      const swc = (await ethers.getContractAt("SwapContract", swcAddr)) as any;
      const operatorAddr = await swc.operator();
      await ethers.provider.send("hardhat_impersonateAccount", [operatorAddr]);
      await ethers.provider.send("hardhat_setBalance", [
        operatorAddr,
        "0x56BC75E2D63100000",
      ]);
      const op = await ethers.getSigner(operatorAddr);
      const swapData = aggData(STRAT[1], STRAT[DEP], amount, 0n, swcAddr);
      await swc.connect(op)["executeSwap(address,address,bytes,uint256,uint256,bytes,bytes,bytes)"](
        STRAT[1],
        STRAT[DEP],
        swapData,
        amount,
        0,
        "0x",
        "0x",
        "0x",
      );
      return swc;
    }

    // CASE D: no Deployed Token, no profit. Request locks the receipt; the
    // principal is returned only after EXIT_DELAY.
    it("CASE D: request locks receipt (no profit); withdraw after 48h returns principal", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swc = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);
      const before = await ctx.strat[1].balanceOf(ctx.user.address);

      // Phase 1: receipt locked on the Vault, no profit, principal still in SWC.
      await expect(reqExit(ctx, 1))
        .to.emit(ctx.vault, "ExitStrategyRequested")
        .and.to.not.emit(ctx.vault, "ProfitProcessed");
      expect(await ctx.receipts[1].balanceOf(ctx.user.address)).to.equal(0);
      expect(await ctx.receipts[1].balanceOf(ctx.vaultAddr)).to.equal(PER);
      expect(await ctx.strat[1].balanceOf(ctx.user.address)).to.equal(before);
      expect(await ctx.strat[1].balanceOf(swc)).to.equal(PER); // principal retained

      // Before the delay → revert.
      await expect(
        withdraw(ctx, ctx.user.address, 1),
      ).to.be.revertedWithCustomError(ctx.vault, "ExitDelayNotElapsed");

      await timeTravel(EXIT_DELAY + 1);

      // Phase 2: principal back, receipt burned.
      await expect(withdraw(ctx, ctx.user.address, 1)).to.emit(ctx.vault, "Exited");
      expect(await ctx.strat[1].balanceOf(ctx.user.address)).to.equal(before + PER);
      expect(await ctx.strat[1].balanceOf(swc)).to.equal(0);
      expect(await ctx.receipts[1].balanceOf(ctx.vaultAddr)).to.equal(0); // burned
      expect(await ctx.usdt.balanceOf(ctx.fundWallet.address)).to.equal(0);
    });

    // Exit path through the stake router: an active Public Sale lot pays 10%
    // in ENC, so the user keeps the full net profit in USDT.
    it("exit with profit charges an active Public Sale lot via the stake router", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const { sale } = await attachStakeRouter(ctx);
      await sale.connect(ctx.user).buy(1);

      const swcAddr = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);
      await deploySome(ctx, swcAddr, ethers.parseEther("100"));
      await ctx.strat[1].mint(swcAddr, ethers.parseEther("0.5")); // surplus
      await ctx.usdt.mint(ctx.router.target, ethers.parseEther("100"));

      const fund = ethers.parseEther("0.1"); // 20% of 0.5
      const net = ethers.parseEther("0.4");
      const psEnc = ethers.parseEther("0.04"); // 10% of net, 1:1 quote
      const lockedBefore = await sale.totalLocked();
      const usdtBefore = await ctx.usdt.balanceOf(ctx.user.address);

      const consolidationPaths = new Array(7).fill("0x");
      consolidationPaths[DEP] = aggData(STRAT[DEP], STRAT[1], ethers.parseEther("100"), 0n, swcAddr);
      await expect(reqExit(ctx, 1, {
        consolidationPaths,
        stablePath: encodePath([STRAT[1], USDT], [FEE]),
        encPath: encodePath([USDT, ctx.enc.target], [FEE]),
      }))
        .to.emit(ctx.vault, "ProfitProcessed")
        .withArgs(ctx.user.address, STRAT[1], USDT, ethers.parseEther("0.5"), fund, 0n, net, PER);

      expect(await ctx.usdt.balanceOf(ctx.user.address)).to.equal(usdtBefore + net);
      expect(await ctx.encCommission.lastAmount()).to.equal(psEnc);
      expect(lockedBefore - (await sale.totalLocked())).to.equal(psEnc);
    });

    // CASE A: profit realised + paid at request; principal after 48h.
    it("CASE A: profit realised & paid at request; principal returned after 48h", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swcAddr = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);
      const swc = await deploySome(ctx, swcAddr, ethers.parseEther("100"));
      expect(await swc.deployedCount()).to.equal(1n);

      const surplus = ethers.parseEther("0.5");
      await ctx.strat[1].mint(swcAddr, surplus);
      await ctx.usdt.mint(ctx.router.target, ethers.parseEther("100"));
      await ctx.enc.mint(ctx.router.target, ethers.parseEther("100"));

      const fund = ethers.parseEther("0.1"); // 20% of 0.5
      const encStable = ethers.parseEther("0.1"); // 25% of net (0.4)
      const userPayout = ethers.parseEther("0.3");

      const stratBefore = await ctx.strat[1].balanceOf(ctx.user.address);
      const usdtBefore = await ctx.usdt.balanceOf(ctx.user.address);

      // Phase 1: deployed unwound, profit realised → user (USDT) + commissions.
      const consolidationPaths = new Array(7).fill("0x");
      consolidationPaths[DEP] = aggData(
        STRAT[DEP], STRAT[1], ethers.parseEther("100"), 0n, swcAddr,
      );
      await expect(reqExit(ctx, 1, {
        consolidationPaths,
        stablePath: encodePath([STRAT[1], USDT], [FEE]),
        encPath: encodePath([USDT, ctx.enc.target], [FEE]),
      }))
        .to.emit(ctx.vault, "ProfitProcessed")
        // totalAssetUSD = exited receipt amount × grossProfit / profitInAvailable
        // (the mock swaps 1:1, so the ratio is 1).
        .withArgs(ctx.user.address, STRAT[1], USDT, surplus, fund, encStable, userPayout, PER)
        .and.to.emit(ctx.vault, "ExitStrategyRequested");

      expect(await ctx.strat[DEP].balanceOf(swcAddr)).to.equal(0); // unwound
      expect(await swc.deployedCount()).to.equal(0n);
      expect(await ctx.usdt.balanceOf(ctx.user.address)).to.equal(usdtBefore + userPayout);
      expect(await ctx.usdt.balanceOf(ctx.fundWallet.address)).to.equal(fund);
      expect(await ctx.encCommission.lastAmount()).to.equal(encStable);
      // Principal NOT returned yet; receipt locked on the Vault.
      expect(await ctx.strat[1].balanceOf(ctx.user.address)).to.equal(stratBefore);
      expect(await ctx.receipts[1].balanceOf(ctx.user.address)).to.equal(0);
      expect(await ctx.strat[1].balanceOf(swcAddr)).to.equal(PER);

      // Phase 2 after 48h: principal back, receipt burned.
      await timeTravel(EXIT_DELAY + 1);
      await withdraw(ctx, ctx.user.address, 1);
      expect(await ctx.strat[1].balanceOf(ctx.user.address)).to.equal(stratBefore + PER);
      expect(await ctx.receipts[1].balanceOf(ctx.vaultAddr)).to.equal(0);
    });


    it("executeExit(requestId) — SDK F5 path — completes the exit", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const before = await ctx.strat[1].balanceOf(ctx.user.address);

      const tx = await reqExit(ctx, 1);
      const rc = await tx.wait();
      const ev = rc!.logs
        .map((l: any) => {
          try {
            return ctx.vault.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "ExitStrategyRequested");
      const requestId = ev!.args.requestId;

      await timeTravel(EXIT_DELAY + 1);
      await expect(
        ctx.vault.connect(ctx.deployer).executeExit(requestId),
      ).to.emit(ctx.vault, "Exited");
      expect(await ctx.strat[1].balanceOf(ctx.user.address)).to.equal(
        before + PER,
      );
      // requestId consumed → a second executeExit reverts.
      await expect(
        ctx.vault.connect(ctx.deployer).executeExit(requestId),
      ).to.be.revertedWithCustomError(ctx.vault, "NoPendingExit");
    });

    it("total loss: the exit still closes with 0 out, burns the receipt and frees the slot", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swcAddr = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);

      // Simulate a 100% loss: the SWC ends up holding none of its available token.
      await ethers.provider.send("hardhat_impersonateAccount", [swcAddr]);
      await ethers.provider.send("hardhat_setBalance", [swcAddr, "0x56BC75E2D63100000"]);
      const swcSigner = await ethers.getSigner(swcAddr);
      await ctx.strat[1].connect(swcSigner).transfer(ctx.stranger.address, PER);

      await expect(reqExit(ctx, 1)).to.emit(ctx.vault, "ExitStrategyRequested");
      await timeTravel(EXIT_DELAY + 1);

      const userBefore = await ctx.strat[1].balanceOf(ctx.user.address);
      await expect(withdraw(ctx, ctx.user.address, 1))
        .to.emit(ctx.vault, "Exited")
        .withArgs(ctx.user.address, 1, STRAT[1], await ctx.receipts[1].getAddress(), swcAddr, PER, STRAT[1], 0n);

      expect(await ctx.strat[1].balanceOf(ctx.user.address)).to.equal(userBefore);
      expect(await ctx.receipts[1].balanceOf(ctx.vaultAddr)).to.equal(0n);
      expect((await ctx.vault.exitRequestOf(ctx.user.address, 1)).amount).to.equal(0n);

      // The slot is usable again: a fresh deposit is no longer DepositBlockedByPendingExit.
      await expect(deposit(ctx, { signer: ctx.user, slots: [1] })).to.emit(ctx.vault, "Deposited");
    });

    it("withdrawExit is callable by the SWC operator (SEOA)", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swcAddr = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);
      await reqExit(ctx, 1);
      await timeTravel(EXIT_DELAY + 1);

      const swc = (await ethers.getContractAt("SwapContract", swcAddr)) as any;
      const opAddr = await swc.operator();
      await ethers.provider.send("hardhat_impersonateAccount", [opAddr]);
      await ethers.provider.send("hardhat_setBalance", [opAddr, "0x56BC75E2D63100000"]);
      const op = await ethers.getSigner(opAddr);

      await expect(
        ctx.vault.connect(op).withdrawExit(ctx.user.address, 1),
      ).to.emit(ctx.vault, "Exited");
    });

    it("user can self-claim their own withdrawal after 48h (withdrawExit)", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swcAddr = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);
      const before = await ctx.strat[1].balanceOf(ctx.user.address);

      await reqExit(ctx, 1);
      // Before the delay → self-claim still blocked by the timelock.
      await expect(
        ctx.vault.connect(ctx.user).withdrawExit(ctx.user.address, 1),
      ).to.be.revertedWithCustomError(ctx.vault, "ExitDelayNotElapsed");

      await timeTravel(EXIT_DELAY + 1);

      // User claims for themselves (msg.sender == user branch of the auth check).
      await expect(
        ctx.vault.connect(ctx.user).withdrawExit(ctx.user.address, 1),
      ).to.emit(ctx.vault, "Exited");

      expect(await ctx.strat[1].balanceOf(ctx.user.address)).to.equal(before + PER);
      expect(await ctx.strat[1].balanceOf(swcAddr)).to.equal(0);
      expect(await ctx.receipts[1].balanceOf(ctx.vaultAddr)).to.equal(0); // burned
    });

    it("user can self-claim via executeExit(requestId) after 48h", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const before = await ctx.strat[1].balanceOf(ctx.user.address);

      const tx = await ctx.vault.connect(ctx.user).requestExit(await ep(ctx, 1));
      const rc = await tx.wait();
      const ev = rc!.logs.find((l: any) => l.fragment?.name === "ExitStrategyRequested");
      const requestId = ev!.args[0];

      await timeTravel(EXIT_DELAY + 1);

      await expect(
        ctx.vault.connect(ctx.user).executeExit(requestId),
      ).to.emit(ctx.vault, "Exited");
      expect(await ctx.strat[1].balanceOf(ctx.user.address)).to.equal(before + PER);
    });

    it("withdrawExit reverts UnauthorizedExit for a random caller", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      await reqExit(ctx, 1);
      await timeTravel(EXIT_DELAY + 1);
      await expect(
        ctx.vault.connect(ctx.stranger).withdrawExit(ctx.user.address, 1),
      ).to.be.revertedWithCustomError(ctx.vault, "UnauthorizedExit");
    });

    // ─── payoutStable: liquidate straight to USDT, no profit split ──────────

    // Per-slot swapData selling each `amounts[slot]` of the slot token into USDT.
    function toUsdt(swcAddr: string, amounts: Record<number, bigint>): string[] {
      const paths = new Array(7).fill("0x");
      for (const [slot, amount] of Object.entries(amounts)) {
        paths[Number(slot)] = aggData(STRAT[Number(slot)], USDT, amount, 0n, swcAddr);
      }
      return paths;
    }

    it("payoutStable: open gains go to the user in USDT with no commission, paid after 48h", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swcAddr = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);
      const deployed = ethers.parseEther("100");
      await deploySome(ctx, swcAddr, deployed);
      const surplus = ethers.parseEther("0.5");
      await ctx.strat[1].mint(swcAddr, surplus); // open gain not yet realised
      await ctx.usdt.mint(AGGREGATOR, ethers.parseEther("1000000"));

      const total = PER + surplus; // 1:1 mock swaps
      const vaultUsdtBefore = await ctx.usdt.balanceOf(ctx.vaultAddr);
      const userUsdtBefore = await ctx.usdt.balanceOf(ctx.user.address);
      const userStratBefore = await ctx.strat[1].balanceOf(ctx.user.address);

      const consolidationPaths = toUsdt(swcAddr, { [DEP]: deployed, 1: PER - deployed + surplus });
      await expect(reqExit(ctx, 1, { consolidationPaths, payoutStable: true }))
        .to.emit(ctx.vault, "ExitStableLocked")
        .withArgs(anyValue, ctx.user.address, 1, total)
        .and.to.emit(ctx.vault, "ExitStrategyRequested")
        .and.to.not.emit(ctx.vault, "ProfitProcessed")
        .and.to.not.emit(ctx.vault, "FundCommissionPaid");

      // USDT is locked on the user's SWC, not the Vault; nothing paid yet.
      expect(await ctx.usdt.balanceOf(swcAddr)).to.equal(total);
      expect(await ctx.strat[1].balanceOf(swcAddr)).to.equal(0n);
      expect(await ctx.strat[DEP].balanceOf(swcAddr)).to.equal(0n);
      expect(await ctx.usdt.balanceOf(ctx.vaultAddr)).to.equal(vaultUsdtBefore);
      expect(await ctx.usdt.balanceOf(ctx.user.address)).to.equal(userUsdtBefore);
      expect(await ctx.usdt.balanceOf(ctx.fundWallet.address)).to.equal(0n);
      expect((await ctx.vault.exitRequestOf(ctx.user.address, 1)).payoutStable).to.equal(true);

      await expect(withdraw(ctx, ctx.user.address, 1))
        .to.be.revertedWithCustomError(ctx.vault, "ExitDelayNotElapsed");
      await timeTravel(EXIT_DELAY + 1);

      await expect(withdraw(ctx, ctx.user.address, 1))
        .to.emit(ctx.vault, "Exited")
        .withArgs(ctx.user.address, 1, STRAT[1], await ctx.receipts[1].getAddress(), swcAddr, PER, USDT, total);

      expect(await ctx.usdt.balanceOf(ctx.user.address)).to.equal(userUsdtBefore + total);
      expect(await ctx.strat[1].balanceOf(ctx.user.address)).to.equal(userStratBefore);
      expect(await ctx.usdt.balanceOf(swcAddr)).to.equal(0n);
      expect(await ctx.usdt.balanceOf(ctx.vaultAddr)).to.equal(vaultUsdtBefore);
      expect(await ctx.receipts[1].balanceOf(ctx.vaultAddr)).to.equal(0n); // burned
      expect(await ctx.usdt.balanceOf(ctx.fundWallet.address)).to.equal(0n);
    });

    it("payoutStable: the user can self-claim via executeExit(requestId)", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swcAddr = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);
      await ctx.usdt.mint(AGGREGATOR, ethers.parseEther("1000000"));
      const userUsdtBefore = await ctx.usdt.balanceOf(ctx.user.address);

      const tx = await reqExit(ctx, 1, { consolidationPaths: toUsdt(swcAddr, { 1: PER }), payoutStable: true });
      const rc = await tx.wait();
      const ev = rc!.logs.find((l: any) => l.fragment?.name === "ExitStrategyRequested");
      await timeTravel(EXIT_DELAY + 1);

      await expect(ctx.vault.connect(ctx.user).executeExit(ev!.args[0]))
        .to.emit(ctx.vault, "Exited");
      expect(await ctx.usdt.balanceOf(ctx.user.address)).to.equal(userUsdtBefore + PER);
    });

    it("payoutStable total loss: locks 0 USDT, still closes the exit and frees the slot", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swcAddr = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);

      await ethers.provider.send("hardhat_impersonateAccount", [swcAddr]);
      await ethers.provider.send("hardhat_setBalance", [swcAddr, "0x56BC75E2D63100000"]);
      const swcSigner = await ethers.getSigner(swcAddr);
      await ctx.strat[1].connect(swcSigner).transfer(ctx.stranger.address, PER);

      await expect(reqExit(ctx, 1, { payoutStable: true }))
        .to.emit(ctx.vault, "ExitStableLocked")
        .withArgs(anyValue, ctx.user.address, 1, 0n);
      await timeTravel(EXIT_DELAY + 1);

      await expect(withdraw(ctx, ctx.user.address, 1))
        .to.emit(ctx.vault, "Exited")
        .withArgs(ctx.user.address, 1, STRAT[1], await ctx.receipts[1].getAddress(), swcAddr, PER, USDT, 0n);
      expect((await ctx.vault.exitRequestOf(ctx.user.address, 1)).amount).to.equal(0n);
      await expect(deposit(ctx, { signer: ctx.user, slots: [1] })).to.emit(ctx.vault, "Deposited");
    });

    it("payoutStable reverts when the idle Available Token has no swap into USDT", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swc = await ethers.getContractAt(
        "SwapContract",
        await ctx.factory.swcOf(ctx.user.address, STRAT[1]),
      );
      await expect(reqExit(ctx, 1, { payoutStable: true }))
        .to.be.revertedWithCustomError(swc, "InvalidExecuteSelector");
    });

    it("payoutStable reverts ConsolidationAmountOutOfRange when the principal is not fully sold", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swcAddr = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);
      const swc = await ethers.getContractAt("SwapContract", swcAddr);
      await ctx.usdt.mint(AGGREGATOR, ethers.parseEther("1000000"));

      const floor = PER - PER / 1000n; // principal less the 0.1% dust tolerance
      await expect(reqExit(ctx, 1, { consolidationPaths: toUsdt(swcAddr, { 1: floor - 1n }), payoutStable: true }))
        .to.be.revertedWithCustomError(swc, "ConsolidationAmountOutOfRange")
        .withArgs(floor - 1n, floor, PER);
    });

    it("payoutStable: the SWC operator (SEOA) can complete the exit", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swcAddr = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);
      await ctx.usdt.mint(AGGREGATOR, ethers.parseEther("1000000"));
      const userUsdtBefore = await ctx.usdt.balanceOf(ctx.user.address);
      await reqExit(ctx, 1, { consolidationPaths: toUsdt(swcAddr, { 1: PER }), payoutStable: true });
      await timeTravel(EXIT_DELAY + 1);

      const swc = await ethers.getContractAt("SwapContract", swcAddr);
      const opAddr = await swc.operator();
      await ethers.provider.send("hardhat_impersonateAccount", [opAddr]);
      await ethers.provider.send("hardhat_setBalance", [opAddr, "0x56BC75E2D63100000"]);
      const op = await ethers.getSigner(opAddr);

      await expect(ctx.vault.connect(op).withdrawExit(ctx.user.address, 1)).to.emit(ctx.vault, "Exited");
      expect(await ctx.usdt.balanceOf(ctx.user.address)).to.equal(userUsdtBefore + PER);
    });

    it("requestExit reverts ExitAlreadyPending on a second request", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      await reqExit(ctx, 1);
      await expect(reqExit(ctx, 1)).to.be.revertedWithCustomError(
        ctx.vault,
        "ExitAlreadyPending",
      );
    });

    it("withdrawExit reverts NoPendingExit when nothing was requested", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      await expect(
        withdraw(ctx, ctx.user.address, 1),
      ).to.be.revertedWithCustomError(ctx.vault, "NoPendingExit");
    });

    it("NothingToExit when the user holds no receipt for that slot", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      await expect(
        ctx.vault.connect(ctx.user).requestExit(await ep(ctx, 0)),
      ).to.be.revertedWithCustomError(ctx.vault, "NothingToExit");
    });

    it("SwcNotFound for a user who never deposited", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        ctx.vault.connect(ctx.stranger).requestExit(await ep(ctx, 1, {}, ctx.stranger)),
      ).to.be.revertedWithCustomError(ctx.vault, "SwcNotFound");
    });

    it("InvalidSlot when slot >= STRATEGY_COUNT (via requestExit)", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      await expect(
        ctx.vault.connect(ctx.user).requestExit(await ep(ctx, 7)),
      ).to.be.revertedWithCustomError(ctx.vault, "InvalidSlot");
    });

    it("EncPathRequired when SWC has a profit but encPath is empty", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const swcAddr = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);

      // Inject surplus available token directly (no round-1 trade, deployedMask stays 0).
      // realizeForExit sees total > principal → profitInAvailable > 0.
      await ctx.strat[1].mint(swcAddr, ethers.parseEther("1"));

      // encPath empty → EncPathRequired because profitInAvailable > 0.
      await expect(
        ctx.vault.connect(ctx.user).requestExit(await ep(ctx, 1, { encPath: "0x" })),
      ).to.be.revertedWithCustomError(ctx.vault, "EncPathRequired");
    });

    // Pause only blocks new deposits — a user can always get their money out.
    it("requestExit and withdrawExit still work while the Vault is paused", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const before = await ctx.strat[1].balanceOf(ctx.user.address);
      await ctx.vault.connect(ctx.deployer).pause();

      await expect(reqExit(ctx, 1)).to.emit(ctx.vault, "ExitStrategyRequested");
      await timeTravel(EXIT_DELAY + 1);
      await expect(withdraw(ctx, ctx.user.address, 1)).to.emit(ctx.vault, "Exited");
      expect(await ctx.strat[1].balanceOf(ctx.user.address)).to.equal(before + PER);
    });

    // ── EIP-2612 permit path ──────────────────────────────────────────────
    it("requestExit consumes a permit (no prior approve) and locks the receipt", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const receipt = ctx.receipts[1];

      // Precondition: no standing allowance — only the permit can authorise the pull.
      expect(await receipt.balanceOf(ctx.user.address)).to.equal(PER);
      expect(await receipt.allowance(ctx.user.address, ctx.vaultAddr)).to.equal(0n);
      const nonceBefore = await receipt.nonces(ctx.user.address);

      await expect(
        ctx.vault.connect(ctx.user).requestExit(await ep(ctx, 1)),
      ).to.emit(ctx.vault, "ExitStrategyRequested");

      // Receipt moved to the Vault via the permit-authorised transferFrom; nonce burned.
      expect(await receipt.balanceOf(ctx.vaultAddr)).to.equal(PER);
      expect(await receipt.nonces(ctx.user.address)).to.equal(nonceBefore + 1n);
    });

    it("requestExit still succeeds when a front-runner already submitted the user's permit", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const receipt = ctx.receipts[1];
      const params = await ep(ctx, 1);

      // Griefer lifts the signature from the mempool and burns the nonce first.
      await receipt
        .connect(ctx.stranger)
        .permit(
          ctx.user.address,
          ctx.vaultAddr,
          PER,
          params.permitDeadline,
          params.permitV,
          params.permitR,
          params.permitS,
        );

      await expect(ctx.vault.connect(ctx.user).requestExit(params))
        .to.emit(ctx.vault, "ExitStrategyRequested");
      expect(await receipt.balanceOf(ctx.vaultAddr)).to.equal(PER);
    });

    it("requestExit falls back to a standing approve when the permit fields are unusable", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const receipt = ctx.receipts[1];
      await receipt.connect(ctx.user).approve(ctx.vaultAddr, PER);

      await expect(ctx.vault.connect(ctx.user).requestExit(await ep(ctx, 1, DUMMY_PERMIT)))
        .to.emit(ctx.vault, "ExitStrategyRequested");
      expect(await receipt.balanceOf(ctx.vaultAddr)).to.equal(PER);
    });

    it("requestExit reverts ERC20InsufficientAllowance when the permit deadline has passed", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const receipt = ctx.receipts[1];
      const amount = await receipt.balanceOf(ctx.user.address);
      const past = 1n; // long-expired deadline
      const { v, r, s } = await signPermit(receipt, ctx.user, ctx.vaultAddr, amount, past);

      await expect(
        ctx.vault.connect(ctx.user).requestExit(
          await ep(ctx, 1, { permitDeadline: past, permitV: v, permitR: r, permitS: s }),
        ),
      ).to.be.revertedWithCustomError(receipt, "ERC20InsufficientAllowance");
    });

    it("requestExit reverts ERC20InsufficientAllowance when the permit is signed for a wrong value", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const receipt = ctx.receipts[1];
      const amount = await receipt.balanceOf(ctx.user.address);
      // Sign over amount-1; the contract calls permit with the full balance, so the
      // recovered signer will not match the owner.
      const { v, r, s } = await signPermit(receipt, ctx.user, ctx.vaultAddr, amount - 1n, MAX_UINT);

      await expect(
        ctx.vault.connect(ctx.user).requestExit(
          await ep(ctx, 1, { permitDeadline: MAX_UINT, permitV: v, permitR: r, permitS: s }),
        ),
      ).to.be.revertedWithCustomError(receipt, "ERC20InsufficientAllowance");
    });

    // ─── VaultTestnet: owner-controlled exit clock ──────────────────────────
    describe("VaultTestnet — warpBy / warpTo / setExitDelay", () => {
      it("defaults to a zero offset, so the real 48h exit delay still applies", async () => {
        const ctx = await loadFixture(deployTestnetFixture);
        await deposit(ctx, { signer: ctx.user, slots: SIX });
        await reqExit(ctx, 1);

        expect(await ctx.vault.timeOffset()).to.equal(0n);
        await expect(
          withdraw(ctx, ctx.user.address, 1),
        ).to.be.revertedWithCustomError(ctx.vault, "ExitDelayNotElapsed");
      });

      it("warpBy skips the 48h exit delay without moving chain time", async () => {
        const ctx = await loadFixture(deployTestnetFixture);
        await deposit(ctx, { signer: ctx.user, slots: SIX });
        const before = await ctx.strat[1].balanceOf(ctx.user.address);
        await reqExit(ctx, 1);

        await expect(ctx.vault.warpBy(EXIT_DELAY))
          .to.emit(ctx.vault, "ClockWarped")
          .withArgs(0n, BigInt(EXIT_DELAY));
        await expect(withdraw(ctx, ctx.user.address, 1)).to.emit(ctx.vault, "Exited");
        expect(await ctx.strat[1].balanceOf(ctx.user.address)).to.equal(before + PER);
      });

      it("warpBy with a negative delta rewinds the clock", async () => {
        const ctx = await loadFixture(deployTestnetFixture);
        await deposit(ctx, { signer: ctx.user, slots: SIX });
        await reqExit(ctx, 1);

        await ctx.vault.warpBy(EXIT_DELAY);
        await ctx.vault.warpBy(-EXIT_DELAY);
        expect(await ctx.vault.timeOffset()).to.equal(0n);
        await expect(
          withdraw(ctx, ctx.user.address, 1),
        ).to.be.revertedWithCustomError(ctx.vault, "ExitDelayNotElapsed");
      });

      it("warpTo sets the clock to an absolute timestamp", async () => {
        const ctx = await loadFixture(deployTestnetFixture);
        await deposit(ctx, { signer: ctx.user, slots: SIX });
        await reqExit(ctx, 1);
        const [, requestTime] = await ctx.vault.exitRequestOf(ctx.user.address, 1);

        await ctx.vault.warpTo(requestTime + BigInt(EXIT_DELAY));
        await expect(withdraw(ctx, ctx.user.address, 1)).to.emit(ctx.vault, "Exited");
      });

      it("requestExit records the (warped) current timestamp as requestTime", async () => {
        const ctx = await loadFixture(deployTestnetFixture);
        await deposit(ctx, { signer: ctx.user, slots: SIX });
        await ctx.vault.warpBy(7 * 24 * 3600);

        const rc = await (await reqExit(ctx, 1)).wait();
        const blockTimestamp = (await ethers.provider.getBlock(rc!.blockNumber))!.timestamp;
        const [, requestTime] = await ctx.vault.exitRequestOf(ctx.user.address, 1);

        expect(requestTime).to.equal(BigInt(blockTimestamp + 7 * 24 * 3600));
      });

      it("exitDelay defaults to the 48h EXIT_DELAY", async () => {
        const ctx = await loadFixture(deployTestnetFixture);
        expect(await ctx.vault.exitDelay()).to.equal(BigInt(EXIT_DELAY));
      });

      it("setExitDelay shortens the wait, including for an exit already pending", async () => {
        const ctx = await loadFixture(deployTestnetFixture);
        await deposit(ctx, { signer: ctx.user, slots: SIX });
        await reqExit(ctx, 1);
        const [, requestTime] = await ctx.vault.exitRequestOf(ctx.user.address, 1);

        await expect(ctx.vault.setExitDelay(600))
          .to.emit(ctx.vault, "ExitDelayUpdated")
          .withArgs(BigInt(EXIT_DELAY), 600n);
        await expect(withdraw(ctx, ctx.user.address, 1))
          .to.be.revertedWithCustomError(ctx.vault, "ExitDelayNotElapsed")
          .withArgs(requestTime + 600n);

        await timeTravel(600);
        await expect(withdraw(ctx, ctx.user.address, 1)).to.emit(ctx.vault, "Exited");
      });

      it("setExitDelay(0) lets an exit complete right after the request", async () => {
        const ctx = await loadFixture(deployTestnetFixture);
        await deposit(ctx, { signer: ctx.user, slots: SIX });
        await ctx.vault.setExitDelay(0);
        await reqExit(ctx, 1);
        await expect(withdraw(ctx, ctx.user.address, 1)).to.emit(ctx.vault, "Exited");
      });

      it("setExitDelay reverts for a non-owner caller", async () => {
        const ctx = await loadFixture(deployTestnetFixture);
        await expect(ctx.vault.connect(ctx.stranger).setExitDelay(0))
          .to.be.revertedWithCustomError(ctx.vault, "OwnableUnauthorizedAccount");
      });

      it("reverts for a non-owner caller on both warpBy and warpTo", async () => {
        const ctx = await loadFixture(deployTestnetFixture);
        await expect(
          ctx.vault.connect(ctx.stranger).warpBy(1),
        ).to.be.revertedWithCustomError(ctx.vault, "OwnableUnauthorizedAccount");
        await expect(
          ctx.vault.connect(ctx.stranger).warpTo(1),
        ).to.be.revertedWithCustomError(ctx.vault, "OwnableUnauthorizedAccount");
      });
    });
  });

  // ─── requestExitMany ──────────────────────────────────────────────────────
  describe("requestExitMany", () => {
    const EXIT_DELAY = 48 * 3600;

    async function ep(
      ctx: any,
      slot: number,
      signer: any = ctx.user,
      over: Record<string, any> = {},
    ) {
      const permit = await permitFields(ctx, slot, signer);
      return {
        slot,
        minConsolidationOuts: new Array(7).fill(0n),
        consolidationPaths: new Array(7).fill("0x"),
        minStableOut: 0n,
        stablePath: "0x",
        minEncOut: 0n,
        encPath: "0x",
        payoutStable: false,
        ...permit,
        ...over,
      };
    }

    async function timeTravel(secs: number) {
      await ethers.provider.send("evm_increaseTime", [secs]);
      await ethers.provider.send("evm_mine", []);
    }

    it("requests exits for multiple slots in one tx, emitting ExitStrategyRequested for each", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });

      const tx = await ctx.vault
        .connect(ctx.user)
        .requestExitMany([await ep(ctx, 1), await ep(ctx, 2)]);
      const rc = await tx.wait();
      const evs = rc!.logs.filter((l: any) => l.fragment?.name === "ExitStrategyRequested");
      expect(evs).to.have.lengthOf(2);

      // Both receipts are now held by the Vault.
      const PER = ethers.parseEther("10000");
      expect(await ctx.receipts[1].balanceOf(ctx.vaultAddr)).to.equal(PER);
      expect(await ctx.receipts[2].balanceOf(ctx.vaultAddr)).to.equal(PER);
    });

    it("after timeTravel each slot can be withdrawn independently", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });

      await ctx.vault
        .connect(ctx.user)
        .requestExitMany([await ep(ctx, 1), await ep(ctx, 2)]);

      await timeTravel(EXIT_DELAY + 1);

      await expect(
        ctx.vault.connect(ctx.deployer).withdrawExit(ctx.user.address, 1),
      ).to.emit(ctx.vault, "Exited");
      await expect(
        ctx.vault.connect(ctx.deployer).withdrawExit(ctx.user.address, 2),
      ).to.emit(ctx.vault, "Exited");
    });

    it("mixes a USDT payout slot and an Available Token payout slot", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      const PER = ethers.parseEther("10000");
      const swc1 = await ctx.factory.swcOf(ctx.user.address, STRAT[1]);
      await ctx.usdt.mint(AGGREGATOR, ethers.parseEther("1000000"));
      const usdtPaths = new Array(7).fill("0x");
      usdtPaths[1] = aggData(STRAT[1], USDT, PER, 0n, swc1);

      const usdtBefore = await ctx.usdt.balanceOf(ctx.user.address);
      const strat2Before = await ctx.strat[2].balanceOf(ctx.user.address);
      await ctx.vault.connect(ctx.user).requestExitMany([
        await ep(ctx, 1, ctx.user, { consolidationPaths: usdtPaths, payoutStable: true }),
        await ep(ctx, 2),
      ]);
      await timeTravel(EXIT_DELAY + 1);
      await ctx.vault.connect(ctx.deployer).withdrawExit(ctx.user.address, 1);
      await ctx.vault.connect(ctx.deployer).withdrawExit(ctx.user.address, 2);

      expect(await ctx.usdt.balanceOf(ctx.user.address)).to.equal(usdtBefore + PER);
      expect(await ctx.strat[2].balanceOf(ctx.user.address)).to.equal(strat2Before + PER);
    });

    it("reverts EmptyInput when exits array is empty", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });
      await expect(
        ctx.vault.connect(ctx.user).requestExitMany([]),
      ).to.be.revertedWithCustomError(ctx.vault, "EmptyInput");
    });

    it("reverts ExitAlreadyPending when one slot already has a pending exit", async () => {
      const ctx = await loadFixture(deployFixture);
      await deposit(ctx, { signer: ctx.user, slots: SIX });

      await ctx.vault.connect(ctx.user).requestExitMany([await ep(ctx, 1)]);

      await expect(
        ctx.vault.connect(ctx.user).requestExitMany([await ep(ctx, 2), await ep(ctx, 1)]),
      ).to.be.revertedWithCustomError(ctx.vault, "ExitAlreadyPending");
    });
  });

  // ─── constructor ──────────────────────────────────────────────────────────
  describe("constructor", () => {
    it("reverts ZeroAddress when any constructor argument is zero", async () => {
      const ctx = await loadFixture(deployFixture);
      const Vault = await ethers.getContractFactory("Vault");
      const valid = [
        await ctx.whitelist.getAddress(),
        await ctx.factory.getAddress(),
        await ctx.referral.getAddress(),
        await ctx.encCommission.getAddress(),
        await ctx.stakeMock.getAddress(),
        await ctx.enc.getAddress(),
        ctx.fundWallet.address,
      ];
      // Replacing each arg with zero address must revert.
      for (let i = 0; i < valid.length; i++) {
        const args = [...valid];
        args[i] = ZERO;
        await expect(
          Vault.deploy(args[0], args[1], args[2], args[3], args[4], args[5], args[6]),
        ).to.be.revertedWithCustomError(
          await ethers.getContractFactory("Vault"),
          "ZeroAddress",
        );
      }
    });
  });
});
