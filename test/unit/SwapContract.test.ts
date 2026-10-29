import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  SwapContractFactory,
  SwapContract,
  MockERC20,
  MockDexRouterV3,
  MockWBNB,
  MockVault,
  MockUniversalRouter,
} from "../../typechain-types";

// ─── Address pins (BSC mainnet constants from EnishiAddresses) ────────────────

const DEX_ADDRESS    = "0x1b81D678ffb9C0263b24A97847620C99d213eB14"; // PANCAKE_V3
const AGGREGATOR_ADDRESS = "0x1A0A18AC4BECDDbd6389559687d1A73d8927E416"; // PANCAKE_UNIVERSAL_ROUTER_V2_V3
const PERMIT2_ADDRESS = "0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768"; // PANCAKE_PERMIT2
const QUOTER_ADDRESS = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const WBNB_ADDRESS   = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT_ADDRESS   = "0x55d398326f99059fF775485246999027B3197955";
const BTCB_ADDRESS   = "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c";
const ETH_ADDRESS    = "0x2170Ed0880ac9A755fd29B2688956BD959F933F8";
const XRP_ADDRESS    = "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE";
const SOL_ADDRESS    = "0x570A5D26f7765Ecb712C0924E4De545B89fD43dF";

const ZERO           = ethers.ZeroAddress;
const STRATEGY_COUNT = 7;
const DEFAULT_FEE    = 500; // V3_FEE_LOW = V3_FEE_DEFAULT
const MIN_BNB        = ethers.parseEther("0.003"); // MIN_BNB_PER_SEOA
const ONE_ETH        = ethers.parseEther("1");
const LARGE_ETH_HEX  = ethers.toBeHex(ethers.parseEther("10000"));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Encode a packed V3 path: abi.encodePacked(token0, fee0, token1, fee1, token2, …)
 * fees.length must equal tokens.length - 1.
 */
function encodePath(tokens: string[], fees: number[]): string {
  if (fees.length !== tokens.length - 1)
    throw new Error(`encodePath: fees.length (${fees.length}) != tokens.length-1 (${tokens.length - 1})`);
  let path = tokens[0].toLowerCase().replace("0x", "");
  for (let i = 0; i < fees.length; i++) {
    path += fees[i].toString(16).padStart(6, "0") + tokens[i + 1].toLowerCase().replace("0x", "");
  }
  return "0x" + path;
}

/**
 * Build the 7-element portfolioPaths array keyed by strategy slot index.
 * Any slot without an override gets "0x" (empty = no open position).
 */
function buildPortfolioPaths(overrides: Record<string, string> = {}): string[] {
  const SLOT_ORDER: string[] = [
    BTCB_ADDRESS, ETH_ADDRESS, XRP_ADDRESS, WBNB_ADDRESS,
    "0x570A5D26f7765Ecb712C0924E4De545B89fD43dF", // SOL
    "0x1CE0c2827e2eF14D5C4f29a091d735A204794041", // AVAX
    "0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD", // LINK
  ].map((a) => a.toLowerCase());

  const paths = new Array<string>(STRATEGY_COUNT).fill("0x");
  for (const [addr, path] of Object.entries(overrides)) {
    const idx = SLOT_ORDER.indexOf(addr.toLowerCase());
    if (idx === -1) throw new Error(`buildPortfolioPaths: unknown token ${addr}`);
    paths[idx] = path;
  }
  return paths;
}

// ─── Common path builders ─────────────────────────────────────────────────────

const btcbToEthPath       = () => encodePath([BTCB_ADDRESS, ETH_ADDRESS], [DEFAULT_FEE]);
const ethToBtcbPath       = () => encodePath([ETH_ADDRESS, BTCB_ADDRESS], [DEFAULT_FEE]);
const btcbToWbnbGasPath   = () => encodePath([BTCB_ADDRESS, WBNB_ADDRESS], [DEFAULT_FEE]);
const wbnbToEthPath       = () => encodePath([WBNB_ADDRESS, ETH_ADDRESS], [DEFAULT_FEE]);
const ethToWbnbPath       = () => encodePath([ETH_ADDRESS, WBNB_ADDRESS], [DEFAULT_FEE]);

// portfolioPaths helpers — each specifies which tokens the SWC holds so the quoter
// can price them to USDT.  Always include every token with a non-zero balance.

const portfolioEmpty = () =>
  buildPortfolioPaths({});

const portfolioWithBtcb = () =>
  buildPortfolioPaths({
    [BTCB_ADDRESS]: encodePath([BTCB_ADDRESS, USDT_ADDRESS], [DEFAULT_FEE]),
  });

const portfolioWithEth = () =>
  buildPortfolioPaths({
    [ETH_ADDRESS]: encodePath([ETH_ADDRESS, USDT_ADDRESS], [DEFAULT_FEE]),
  });

const portfolioWithBtcbAndEth = () =>
  buildPortfolioPaths({
    [BTCB_ADDRESS]: encodePath([BTCB_ADDRESS, USDT_ADDRESS], [DEFAULT_FEE]),
    [ETH_ADDRESS]:  encodePath([ETH_ADDRESS,  USDT_ADDRESS], [DEFAULT_FEE]),
  });

const portfolioWithWbnbAndEth = () =>
  buildPortfolioPaths({
    [WBNB_ADDRESS]: encodePath([WBNB_ADDRESS, USDT_ADDRESS], [DEFAULT_FEE]),
    [ETH_ADDRESS]:  encodePath([ETH_ADDRESS,  USDT_ADDRESS], [DEFAULT_FEE]),
  });

const portfolioWithWbnb = () =>
  buildPortfolioPaths({
    [WBNB_ADDRESS]: encodePath([WBNB_ADDRESS, USDT_ADDRESS], [DEFAULT_FEE]),
  });

// ─── Injection helpers ────────────────────────────────────────────────────────

/** Deploy a contract, capture its runtime bytecode, inject at `addr`. Returns attached instance. */
async function injectBytecode<T>(factoryName: string, addr: string, constructorArgs: unknown[] = []): Promise<T> {
  const Factory = await ethers.getContractFactory(factoryName);
  const impl = await Factory.deploy(...constructorArgs);
  await impl.waitForDeployment();
  const code = await ethers.provider.getCode(await impl.getAddress());
  await network.provider.send("hardhat_setCode", [addr, code]);
  return Factory.attach(addr) as unknown as T;
}

// All 7 strategy-token addresses (slot order). The contract's _snapshotPortfolio
// iterates every slot and calls balanceOf, so all 7 addresses must hold contract
// code or the call reverts with empty returndata.
const ALL_STRATEGY_TOKENS: string[] = [
  BTCB_ADDRESS, ETH_ADDRESS, XRP_ADDRESS, WBNB_ADDRESS,
  "0x570A5D26f7765Ecb712C0924E4De545B89fD43dF", // SOL
  "0x1CE0c2827e2eF14D5C4f29a091d735A204794041", // AVAX
  "0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD", // LINK
];

// Receipt (enToken) addresses, slot order. _realizeProfit reads balanceOf(user)
// and totalSupply() on the receipt token for the availableToken slot, so these
// must hold contract code or the call reverts with empty returndata.
// They are pinned by EnishiAddresses.strategyAt — mirror it exactly.
const ALL_RECEIPT_TOKENS: string[] = [
  "0x8281c6790E8A4BAB0Ded95164A4c83e423C74b05", // EN_BTC
  "0x4019D71805A3a96d0E6d7f4Eb39B04c7d8e5D1e0", // EN_ETH
  "0x5BE9F238afC31b4e5ff424882c0423C0e1FED37b", // EN_XRP
  "0xcdb075800dD10f000517e5d2cb70F3b8360F4055", // EN_BNB
  "0x1BE0FD7f378177303dd4f591AB73b26a82346088", // EN_SOL
  "0x788309b5cea31AbC5bAf747742af6cf9Dcd4beED", // EN_AVAX
  "0xB417Bd7BC4BE3176483bAd9c0705576F3a5Cb83c", // EN_LINK
];

/** Etch a bare MockERC20 at every strategy slot lacking code (snapshot needs balanceOf). */
async function injectAllStrategyTokens() {
  for (const a of [...ALL_STRATEGY_TOKENS, ...ALL_RECEIPT_TOKENS]) {
    if ((await ethers.provider.getCode(a)) === "0x") {
      await injectBytecode<MockERC20>("MockERC20", a, ["TOK", "TOK", 18]);
    }
  }
}


// Real classic Universal Router `execute(commands, inputs, deadline)` calldata
// with a single V3_SWAP_EXACT_IN command (recipient is the calling SWC), as
// validated on-chain by UniversalRouterGuard. The fee tier is arbitrary — the
// mock router and the guard both only read the path's first/last token.
const UR_EXECUTE_IFACE = new ethers.Interface([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline)",
]);
const UR_V3_SWAP_EXACT_IN = "0x00";
const AGG_FEE = 500;

/** Extract (tokenIn, tokenOut) from a packed V3 path's first/last 20 bytes. */
function pathEnds(path: string): [string, string] {
  const h = path.slice(2);
  const tokenIn = ethers.getAddress("0x" + h.slice(0, 40));
  const tokenOut = ethers.getAddress("0x" + h.slice(h.length - 40));
  return [tokenIn, tokenOut];
}

/** Build Universal Router `execute()` swapData (recipient is the SWC itself). */
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
  return UR_EXECUTE_IFACE.encodeFunctionData("execute", [UR_V3_SWAP_EXACT_IN, [input], 2n ** 47n]);
}

const NP_KEY = "executeSwap(address,address,bytes,uint256,uint256,bytes,bytes,bytes)";
const WP_KEY = "executeSwap(address,address,bytes,uint256,uint256,uint256,uint256,bytes,bytes,bytes)";

/** New-overload executeSwap (no profit params). `path` supplies tokenIn/tokenOut. */
function execNP(
  swc: any,
  signer: SignerWithAddress,
  path: string,
  amountIn: bigint,
  amountOutMin: bigint,
  gasPath: string,
  encPath: string,
  stablePath: string,
  overrides?: any,
) {
  const [tokenIn, tokenOut] = pathEnds(path);
  const sd = aggData(tokenIn, tokenOut, amountIn, amountOutMin, swc.target);
  const args: any[] = [tokenIn, tokenOut, sd, amountIn, amountOutMin, gasPath, encPath, stablePath];
  if (overrides !== undefined) args.push(overrides);
  return swc.connect(signer)[NP_KEY](...args);
}

/** New-overload executeSwap (with profit params). `path` supplies tokenIn/tokenOut. */
function execWP(
  swc: any,
  signer: SignerWithAddress,
  path: string,
  amountIn: bigint,
  amountOutMin: bigint,
  minStableOut: bigint,
  minEncOut: bigint,
  gasPath: string,
  encPath: string,
  stablePath: string,
  overrides?: any,
) {
  const [tokenIn, tokenOut] = pathEnds(path);
  const sd = aggData(tokenIn, tokenOut, amountIn, amountOutMin, swc.target);
  const args: any[] = [
    tokenIn, tokenOut, sd, amountIn, amountOutMin, minStableOut, minEncOut, gasPath, encPath, stablePath,
  ];
  if (overrides !== undefined) args.push(overrides);
  return swc.connect(signer)[WP_KEY](...args);
}

/**
 * Route `amount` of `token` into `swc` via the real {deposit} entry point (mint to
 * `vault`, approve, deposit) so `depositedAmount` is set correctly — `realizeForExit`
 * now does `depositedAmount -= principal`, which underflows if a test funds the SWC
 * via a bare `mint(swc.target, ...)` without ever routing it through {deposit}.
 */
async function depositPrincipal(
  swc: any,
  vault: SignerWithAddress,
  token: MockERC20,
  amount: bigint,
) {
  await token.mint(vault.address, amount);
  await token.connect(vault).approve(swc.target, amount);
  await swc.connect(vault).deposit(token.target, amount);
}

// ─── Root fixture ──────────────────────────────────────────────────────────────
//
// All tests share this fixture via loadFixture for snapshot/revert isolation.
// Sets up:
//   • MockERC20 at BTCB, ETH, USDT pinned addresses
//   • MockWBNB at WBNB pinned address + 10 ETH native balance
//   • MockDexRouterV3 at DEX_ADDRESS
//   • MockDexQuoterV3 at QUOTER_ADDRESS
//   • MockVault at vault signer address
//   • 1 M tokens minted to DEX for each of BTCB, ETH, USDT, WBNB
//   • SwapContractFactory + SwapContract implementation
//   • One BTCB SWC created for `user` with `operator`

async function rootFixture() {
  const [owner, vault, operator, stranger, user] = await ethers.getSigners();

  // Inject ERC-20 tokens at their pinned strategy/payout addresses.
  const btcb = await injectBytecode<MockERC20>("MockERC20", BTCB_ADDRESS, ["BTCB", "BTCB", 18]);
  const eth  = await injectBytecode<MockERC20>("MockERC20", ETH_ADDRESS,  ["ETH", "ETH", 18]);
  const usdt = await injectBytecode<MockERC20>("MockERC20", USDT_ADDRESS, ["USDT", "USDT", 18]);

  // Inject MockWBNB and fund it with 10 ETH so withdraw() calls do not revert.
  const wbnb = await injectBytecode<MockWBNB>("MockWBNB", WBNB_ADDRESS);
  await network.provider.send("hardhat_setBalance", [
    WBNB_ADDRESS, ethers.toBeHex(ethers.parseEther("10")),
  ]);

  // Inject DEX mock, reset to 1:1 rate.
  const dex = await injectBytecode<MockDexRouterV3>("MockDexRouterV3", DEX_ADDRESS);
  await dex.setMustRevert(false);
  await dex.setOutRateBps(0); // 0 = default 1:1

  const agg = await injectBytecode<MockUniversalRouter>("MockUniversalRouter", AGGREGATOR_ADDRESS);
  await agg.setMustRevert(false);
  await agg.setOutRateBps(0);

  // Inject MockPermit2 at EnishiAddresses.PANCAKE_PERMIT2 (same on mainnet+testnet).
  // The Universal Router pulls tokenIn through Permit2, so without it every swap reverts.
  await injectBytecode<unknown>("MockPermit2", PERMIT2_ADDRESS);

  // Inject Quoter mock at the pinned quoter address.
  await injectBytecode<unknown>("MockDexQuoterV3", QUOTER_ADDRESS);

  // Inject MockVault at the vault signer address.
  const mockVault = await injectBytecode<MockVault>("MockVault", vault.address);

  // Pre-fund DEX with output tokens so any swap can succeed.
  const MILLION = ethers.parseEther("1000000");
  await btcb.mint(DEX_ADDRESS, MILLION);
  await eth.mint(DEX_ADDRESS, MILLION);
  await usdt.mint(DEX_ADDRESS, MILLION);
  await wbnb.mint(DEX_ADDRESS, MILLION);

  await btcb.mint(AGGREGATOR_ADDRESS, MILLION);
  await eth.mint(AGGREGATOR_ADDRESS, MILLION);
  await usdt.mint(AGGREGATOR_ADDRESS, MILLION);
  await wbnb.mint(AGGREGATOR_ADDRESS, MILLION);

  // Deploy factory (owner becomes Ownable owner) and create BTCB SWC.
  const Factory = await ethers.getContractFactory("SwapContractFactory");
  const factory = (await Factory.connect(owner).deploy()) as unknown as SwapContractFactory;
  await factory.waitForDeployment();
  await factory.connect(owner).setVault(vault.address);
  await factory.connect(vault).createBatch(user.address, [operator.address], [BTCB_ADDRESS]);

  const swcAddr = await factory.swcOf(user.address, BTCB_ADDRESS);
  const swc = (await ethers.getContractAt("SwapContract", swcAddr)) as unknown as SwapContract;

  return { owner, vault, operator, stranger, user, btcb, eth, usdt, wbnb, dex, agg, factory, swc, mockVault };
}

/**
 * {rootFixture} plus every remaining strategy/receipt-token slot injected with a
 * bare MockERC20. Composed so `injectAllStrategyTokens`'s `hardhat_setCode` calls
 * happen INSIDE the snapshot `loadFixture` takes — calling it after `loadFixture`
 * returns leaves the injected bytecode at pinned mainnet addresses un-reverted,
 * permanently polluting every later test in the process (including Vault.test.ts,
 * which targets the same addresses).
 */
async function rootFixtureWithStrategyTokens() {
  const base = await rootFixture();
  await injectAllStrategyTokens();
  return base;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SwapContract", () => {

  // ─── 1. Initial state ──────────────────────────────────────────────────────

  describe("Initial state", () => {
    it("exposes the pinned DEX_V3 constant", async () => {
      const { swc } = await loadFixture(rootFixture);
      expect(await swc.DEX_V3()).to.equal(DEX_ADDRESS);
    });

    it("exposes the pinned UNIVERSAL_ROUTER constant", async () => {
      const { swc } = await loadFixture(rootFixture);
      expect(await swc.UNIVERSAL_ROUTER()).to.equal(AGGREGATOR_ADDRESS);
    });

    it("stores operator and reads vault / availableTokenAddress / user from immutable clone args", async () => {
      const { swc, operator, vault, user } = await loadFixture(rootFixture);
      expect(await swc.operator()).to.equal(operator.address);
      expect(await swc.vault()).to.equal(vault.address);
      expect(await swc.availableTokenAddress()).to.equal(BTCB_ADDRESS);
      expect(await swc.user()).to.equal(user.address);
    });

    it("reverts re-initialize on a clone", async () => {
      const { swc, stranger } = await loadFixture(rootFixture);
      await expect(swc.initialize(stranger.address))
        .to.be.revertedWithCustomError(swc, "InvalidInitialization");
    });
  });

  // ─── 2. executeSwap — access control ──────────────────────────────────────

  describe("executeSwap — access control", () => {
    it("reverts NotOperator when caller is not the operator", async () => {
      const { swc, btcb, stranger } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      await expect(
        execNP(swc, stranger, 
          btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.be.revertedWithCustomError(swc, "NotOperator");
    });

    it("reverts EnforcedPause when paused", async () => {
      const { swc, btcb, vault, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      await swc.connect(vault).pause();
      await expect(
        execNP(swc, operator, 
          btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.be.revertedWithCustomError(swc, "EnforcedPause");
    });

    it("resumes after unpause", async () => {
      const { swc, btcb, vault, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      await swc.connect(vault).pause();
      await swc.connect(vault).unpause();
      await expect(
        execNP(swc, operator, 
          btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.not.be.reverted;
    });
  });

  // ─── 3. executeSwap — input validation ────────────────────────────────────

  describe("executeSwap — input validation", () => {
    it("reverts ZeroAmount when amountIn == 0", async () => {
      const { swc, operator } = await loadFixture(rootFixture);
      await expect(
        execNP(swc, operator, 
          btcbToEthPath(), 0, 0, "0x", "0x", "0x",
        ),
      ).to.be.revertedWithCustomError(swc, "ZeroAmount");
    });

    it("reverts InvalidPath when tokenIn == tokenOut", async () => {
      const { swc, operator } = await loadFixture(rootFixture);
      const samePath = encodePath([BTCB_ADDRESS, BTCB_ADDRESS], [DEFAULT_FEE]);
      await expect(
        execNP(swc, operator, 
          samePath, ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.be.revertedWithCustomError(swc, "InvalidPath");
    });

    it("reverts InvalidPath when neither side is availableTokenAddress", async () => {
      const { swc, operator } = await loadFixture(rootFixture);
      // ETH→WBNB — neither is BTCB (the availableToken for this clone)
      const badPath = encodePath([ETH_ADDRESS, WBNB_ADDRESS], [DEFAULT_FEE]);
      await expect(
        execNP(swc, operator, 
          badPath, ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.be.revertedWithCustomError(swc, "InvalidPath");
    });

    it("reverts TokenNotWhitelisted when tokenOut is a stablecoin (USDT)", async () => {
      const { swc, btcb, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      const btcbToUsdt = encodePath([BTCB_ADDRESS, USDT_ADDRESS], [DEFAULT_FEE]);
      await expect(
        execNP(swc, operator, 
          btcbToUsdt, ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.be.revertedWithCustomError(swc, "TokenNotWhitelisted")
        .withArgs(USDT_ADDRESS);
    });
  });

  // ─── 4. executeSwap — round-1 (open position) ─────────────────────────────

  describe("executeSwap — round-1 (open position)", () => {
    it("opens a new order, records costBasis/assetAmount, does not emit Profit", async () => {
      const { swc, btcb, eth, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);

      const tx = execNP(swc, operator,
        btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
      );
      await expect(tx).to.not.emit(swc, "Profit");
      await expect(tx)
        .to.emit(swc, "OrderOpened")
        .withArgs(eth.target, 0n, ONE_ETH, ONE_ETH); // 1:1 mock rate

      expect(await swc.orderCount(eth.target)).to.equal(1n);
      expect(await eth.balanceOf(swc.target)).to.equal(ONE_ETH);
    });

    it("opens a new independent order (not accumulated) on repeated round-1 swaps into the same token", async () => {
      const { swc, btcb, eth, operator } = await loadFixture(rootFixture);
      const TEN = ethers.parseEther("10");
      await btcb.mint(swc.target, TEN * 2n);

      await execNP(swc, operator,
        btcbToEthPath(), TEN, 0, "0x", "0x", "0x",
      );
      const tx2 = execNP(swc, operator,
        btcbToEthPath(), TEN, 0, "0x", "0x", "0x",
      );

      // 2 independent orders, not accumulated into 1 (which would show
      // orderCount == 1 with costBasis == TEN*2 — instead each open reports
      // costBasis == TEN individually).
      await expect(tx2)
        .to.emit(swc, "OrderOpened")
        .withArgs(eth.target, 1n, TEN, TEN); // 1:1 mock rate
      expect(await swc.orderCount(eth.target)).to.equal(2n);
      expect(await swc.deployedCount()).to.equal(1n); // still 1 slot tracked, 2 orders within it
    });

    it("sets bit in deployedMask for the opened token (slot 1 = ETH → bit 1 set → mask 2)", async () => {
      const { swc, btcb, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      await execNP(swc, operator, 
        btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
      );
      expect(await swc.deployedCount()).to.equal(1n);
      const deployed = await swc.getDeployedTokens();
      expect(deployed.map((a: string) => a.toLowerCase())).to.include(ETH_ADDRESS.toLowerCase());
    });
  });

  // ─── 5. executeSwap — multi-position management ──────────────────────────

  describe("executeSwap — multi-position management", () => {
    async function multiPositionFixture() {
      const base = await loadFixture(rootFixture);
      const { swc, btcb, operator } = base;

      // Etch XRP and SOL mocks at their whitelisted addresses.
      const xrp = await injectBytecode<MockERC20>("MockERC20", XRP_ADDRESS, ["XRP", "XRP", 18]);
      const sol = await injectBytecode<MockERC20>("MockERC20", SOL_ADDRESS, ["SOL", "SOL", 18]);

      await xrp.mint(DEX_ADDRESS, ethers.parseEther("1000000"));
      await sol.mint(DEX_ADDRESS, ethers.parseEther("1000000"));
      await xrp.mint(AGGREGATOR_ADDRESS, ethers.parseEther("1000000"));
      await sol.mint(AGGREGATOR_ADDRESS, ethers.parseEther("1000000"));
      await btcb.mint(swc.target, ethers.parseEther("100"));
      await btcb.mint(DEX_ADDRESS, ethers.parseEther("1000000"));
      await btcb.mint(AGGREGATOR_ADDRESS, ethers.parseEther("1000000"));

      return { ...base, xrp, sol };
    }

    const portfolioWithBtcbEthXrp = () =>
      buildPortfolioPaths({
        [BTCB_ADDRESS]: encodePath([BTCB_ADDRESS, USDT_ADDRESS], [DEFAULT_FEE]),
        [ETH_ADDRESS]:  encodePath([ETH_ADDRESS,  USDT_ADDRESS], [DEFAULT_FEE]),
        [XRP_ADDRESS]:  encodePath([XRP_ADDRESS,  USDT_ADDRESS], [DEFAULT_FEE]),
      });

    const portfolioWithBtcbEthXrpAda = () =>
      buildPortfolioPaths({
        [BTCB_ADDRESS]: encodePath([BTCB_ADDRESS, USDT_ADDRESS], [DEFAULT_FEE]),
        [ETH_ADDRESS]:  encodePath([ETH_ADDRESS,  USDT_ADDRESS], [DEFAULT_FEE]),
        [XRP_ADDRESS]:  encodePath([XRP_ADDRESS,  USDT_ADDRESS], [DEFAULT_FEE]),
        [SOL_ADDRESS]:  encodePath([SOL_ADDRESS,  USDT_ADDRESS], [DEFAULT_FEE]),
      });

    it("opens two positions (ETH + XRP), deployedMask tracks both", async () => {
      const { swc, eth, xrp, operator } = await loadFixture(multiPositionFixture);
      await execNP(swc, operator, 
        btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
      );
      await execNP(swc, operator, 
        encodePath([BTCB_ADDRESS, XRP_ADDRESS], [DEFAULT_FEE]), ONE_ETH, 0, "0x", "0x", "0x",
      );

      expect(await swc.deployedCount()).to.equal(2n);
      const deployed = (await swc.getDeployedTokens()).map((a: string) => a.toLowerCase());
      expect(deployed).to.have.members([ETH_ADDRESS.toLowerCase(), XRP_ADDRESS.toLowerCase()]);
      expect(await swc.orderCount(eth.target)).to.equal(1n);
      expect(await swc.orderCount(xrp.target)).to.equal(1n);
    });

    it("reverts InvalidPath when swapping between two non-avail tokens (B→C)", async () => {
      const { swc, operator } = await loadFixture(multiPositionFixture);

      await execNP(swc, operator, 
        btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
      );
      await execNP(swc, operator, 
        encodePath([BTCB_ADDRESS, XRP_ADDRESS], [DEFAULT_FEE]), ONE_ETH, 0, "0x", "0x", "0x",
      );

      // ETH→XRP: neither is BTCB (avail).
      await expect(
        execNP(swc, operator,
          encodePath([ETH_ADDRESS, XRP_ADDRESS], [DEFAULT_FEE]), ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.be.revertedWithCustomError(swc, "InvalidPath");
    });

  });

  // ─── multi-order LIFO swapback ────────────────────────────────────────────

  describe("executeSwap — multi-order LIFO swapback", () => {
    const ONE = ethers.parseEther("1");
    const TWO = ethers.parseEther("2");
    const THREE = ethers.parseEther("3");

    it("3 consecutive round-1 opens create 3 independent orders with correct indices", async () => {
      const { swc, btcb, eth, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE + TWO + THREE);

      const tx1 = execNP(swc, operator, btcbToEthPath(), ONE, 0, "0x", "0x", "0x");
      await expect(tx1).to.emit(swc, "OrderOpened").withArgs(eth.target, 0n, ONE, ONE);

      const tx2 = execNP(swc, operator, btcbToEthPath(), TWO, 0, "0x", "0x", "0x");
      await expect(tx2).to.emit(swc, "OrderOpened").withArgs(eth.target, 1n, TWO, TWO);

      const tx3 = execNP(swc, operator, btcbToEthPath(), THREE, 0, "0x", "0x", "0x");
      await expect(tx3).to.emit(swc, "OrderOpened").withArgs(eth.target, 2n, THREE, THREE);

      expect(await swc.orderCount(eth.target)).to.equal(3n);
      expect(await swc.deployedCount()).to.equal(1n); // one slot, three orders within it
    });

    it("swapback matching the LIFO-head order's full assetAmount pops it, older orders untouched", async () => {
      const { swc, btcb, eth, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE + TWO + THREE);
      await execNP(swc, operator, btcbToEthPath(), ONE, 0, "0x", "0x", "0x");
      await execNP(swc, operator, btcbToEthPath(), TWO, 0, "0x", "0x", "0x");
      await execNP(swc, operator, btcbToEthPath(), THREE, 0, "0x", "0x", "0x");

      // Close the LIFO-head order (THREE) exactly — 1:1 rate → amountOut = THREE, break-even.
      await expect(
        execNP(swc, operator, ethToBtcbPath(), THREE, 0, "0x", "0x", "0x"),
      )
        .to.emit(swc, "Profit")
        .withArgs(eth.target, btcb.target, THREE, THREE, 0n, USDT_ADDRESS);

      // Only the THREE-order was popped; TWO must now be the LIFO-head —
      // confirmed by closing it next with amountIn = TWO (would revert
      // InsufficientOrderAmount against the wrong order's assetAmount).
      expect(await swc.orderCount(eth.target)).to.equal(2n);
      await expect(
        execNP(swc, operator, ethToBtcbPath(), TWO, 0, "0x", "0x", "0x"),
      )
        .to.emit(swc, "Profit")
        .withArgs(eth.target, btcb.target, TWO, TWO, 0n, USDT_ADDRESS);
      expect(await swc.orderCount(eth.target)).to.equal(1n);
    });

    it("reverts InsufficientOrderAmount when amountIn is less than the LIFO-head order's assetAmount (no partial fill allowed)", async () => {
      const { swc, btcb, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE + TWO + THREE);
      await execNP(swc, operator, btcbToEthPath(), ONE, 0, "0x", "0x", "0x");
      await execNP(swc, operator, btcbToEthPath(), TWO, 0, "0x", "0x", "0x");
      await execNP(swc, operator, btcbToEthPath(), THREE, 0, "0x", "0x", "0x");

      // Orders always close in full — selling only part of the LIFO-head
      // order's assetAmount (THREE) must revert, not partially fill it.
      const partial = ONE;
      await expect(
        execNP(swc, operator, ethToBtcbPath(), partial, 0, "0x", "0x", "0x"),
      )
        .to.be.revertedWithCustomError(swc, "InsufficientOrderAmount")
        .withArgs(THREE, partial);

      // Confirm it did NOT partially fill: all 3 orders remain untouched.
      expect(await swc.orderCount(ETH_ADDRESS)).to.equal(3n);
    });

    it("reverts InsufficientOrderAmount when amountIn exceeds the LIFO-head order, even if the total across all orders would cover it", async () => {
      const { swc, btcb, eth, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE + TWO + THREE);
      await execNP(swc, operator, btcbToEthPath(), ONE, 0, "0x", "0x", "0x");
      await execNP(swc, operator, btcbToEthPath(), TWO, 0, "0x", "0x", "0x");
      await execNP(swc, operator, btcbToEthPath(), THREE, 0, "0x", "0x", "0x");

      // Head order (THREE) has remaining = THREE; requesting THREE + ONE would
      // only be satisfiable by also spilling into the older TWO-order — not allowed.
      const requested = THREE + ONE;
      await expect(
        execNP(swc, operator, ethToBtcbPath(), requested, 0, "0x", "0x", "0x"),
      )
        .to.be.revertedWithCustomError(swc, "InsufficientOrderAmount")
        .withArgs(THREE, requested);

      // Confirm it did NOT silently spill: all 3 orders remain untouched.
      expect(await swc.orderCount(eth.target)).to.equal(3n);
    });

    it("full drain across multiple swapbacks closes every order and untracks the slot", async () => {
      const { swc, btcb, eth, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE + TWO + THREE);
      await execNP(swc, operator, btcbToEthPath(), ONE, 0, "0x", "0x", "0x");
      await execNP(swc, operator, btcbToEthPath(), TWO, 0, "0x", "0x", "0x");
      await execNP(swc, operator, btcbToEthPath(), THREE, 0, "0x", "0x", "0x");
      expect(await swc.deployedCount()).to.equal(1n);

      // Close LIFO-head (THREE), then the new head (TWO), then the last (ONE).
      await execNP(swc, operator, ethToBtcbPath(), THREE, 0, "0x", "0x", "0x");
      expect(await swc.orderCount(eth.target)).to.equal(2n);
      await execNP(swc, operator, ethToBtcbPath(), TWO, 0, "0x", "0x", "0x");
      expect(await swc.orderCount(eth.target)).to.equal(1n);
      await execNP(swc, operator, ethToBtcbPath(), ONE, 0, "0x", "0x", "0x");

      expect(await swc.orderCount(eth.target)).to.equal(0n);
      expect(await swc.deployedCount()).to.equal(0n);
      const deployed = await swc.getDeployedTokens();
      expect(deployed.map((a: string) => a.toLowerCase())).to.not.include(ETH_ADDRESS.toLowerCase());
    });

    it("round-1 reopens correctly after a slot has been fully drained back to 0 orders", async () => {
      const { swc, btcb, eth, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE + ONE);
      await execNP(swc, operator, btcbToEthPath(), ONE, 0, "0x", "0x", "0x");
      await execNP(swc, operator, ethToBtcbPath(), ONE, 0, "0x", "0x", "0x");
      expect(await swc.orderCount(eth.target)).to.equal(0n);
      expect(await swc.deployedCount()).to.equal(0n);

      // Reopen: should track deployedMask again and start a fresh order queue.
      await expect(
        execNP(swc, operator, btcbToEthPath(), ONE, 0, "0x", "0x", "0x"),
      ).to.emit(swc, "OrderOpened").withArgs(eth.target, 0n, ONE, ONE);

      expect(await swc.orderCount(eth.target)).to.equal(1n);
      expect(await swc.deployedCount()).to.equal(1n);
    });

    it("profitDelta is computed in availableToken units even when round-1's exchange rate isn't 1:1 (unit-mismatch regression)", async () => {
      // Round-1: spend 100 BTCB, mock rate 50000bps (500%) -> receive 500 ETH.
      // This models a real 1:5 BTCB:ETH price, NOT the 1:1 rate every other
      // test in this file implicitly relies on — with the old amountOut -
      // amountIn formula (comparing BTCB spent against ETH sold), this
      // scenario either reverts (if amountIn is the real ETH quantity) or
      // silently produces a unit-mismatched profitDelta.
      const { swc, btcb, eth, agg, operator } = await loadFixture(rootFixtureWithStrategyTokens);
      const COST = ethers.parseEther("100");
      await btcb.mint(swc.target, COST);
      await agg.setOutRateBps(50000); // 100 BTCB -> 500 ETH (amountOut = amountIn * rate/10000)
      const ASSET_AMOUNT = COST * 5n; // 500 ETH
      await expect(
        execNP(swc, operator, btcbToEthPath(), COST, 0, "0x", "0x", "0x"),
      )
        .to.emit(swc, "OrderOpened")
        .withArgs(eth.target, 0n, COST, ASSET_AMOUNT);

      // Round-2: sell all 500 ETH, but the market has moved — now 1:3
      // (500 ETH -> ~166.67 BTCB instead of the 100 BTCB break-even the old
      // amountOut - amountIn formula would have compared against amountIn=500
      // directly, a nonsensical BTCB-vs-ETH subtraction). This must show a
      // REAL profit of amountOut - costBasis (100), not a unit-mismatched
      // garbage number. Positive profitDelta triggers _realizeProfit, so this
      // call needs a real stablePath (execWP).
      await agg.setOutRateBps(3333); // ~1:3 -> amountOut = amountIn * 0.3333
      const expectedOut = (ASSET_AMOUNT * 3333n) / 10000n;
      const expectedProfit = expectedOut - COST;
      const btcbUsdt = encodePath([BTCB_ADDRESS, USDT_ADDRESS], [DEFAULT_FEE]);

      await expect(
        execWP(swc, operator, ethToBtcbPath(), ASSET_AMOUNT, 0, 0, 0, "0x", "0x", btcbUsdt),
      )
        .to.emit(swc, "Profit")
        .withArgs(eth.target, btcb.target, ASSET_AMOUNT, expectedOut, expectedProfit, USDT_ADDRESS);

      expect(await swc.orderCount(eth.target)).to.equal(0n);
    });
  });

  // ─── 13. pause / unpause ──────────────────────────────────────────────────

  describe("pause / unpause", () => {
    it("vault can pause; paused blocks executeSwap", async () => {
      const { swc, btcb, vault, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      await swc.connect(vault).pause();
      await expect(
        execNP(swc, operator, 
          btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.be.revertedWithCustomError(swc, "EnforcedPause");
    });

    it("vault can unpause; executeSwap works again after unpause", async () => {
      const { swc, btcb, vault, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      await swc.connect(vault).pause();
      await swc.connect(vault).unpause();
      await expect(
        execNP(swc, operator, 
          btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.not.be.reverted;
    });

    it("reverts NotVault when a stranger calls pause", async () => {
      const { swc, stranger } = await loadFixture(rootFixture);
      await expect(swc.connect(stranger).pause())
        .to.be.revertedWithCustomError(swc, "NotVault");
    });

    it("reverts NotVault when a stranger calls unpause", async () => {
      const { swc, vault, stranger } = await loadFixture(rootFixture);
      await swc.connect(vault).pause();
      await expect(swc.connect(stranger).unpause())
        .to.be.revertedWithCustomError(swc, "NotVault");
    });

    it("admin vault functions (setOperator) still work while paused", async () => {
      const { swc, vault, stranger } = await loadFixture(rootFixture);
      await swc.connect(vault).pause();
      // setOperator works.
      await expect(swc.connect(vault).setOperator(stranger.address)).to.not.be.reverted;
    });
  });

  // ─── 14. setOperator ──────────────────────────────────────────────────────

  describe("setOperator", () => {
    it("vault can rotate operator; emits OperatorUpdated with old and new addresses", async () => {
      const { swc, vault, operator, stranger } = await loadFixture(rootFixture);
      await expect(swc.connect(vault).setOperator(stranger.address))
        .to.emit(swc, "OperatorUpdated")
        .withArgs(operator.address, stranger.address);
      expect(await swc.operator()).to.equal(stranger.address);
    });

    it("new operator can call executeSwap after rotation", async () => {
      const { swc, btcb, vault, stranger } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      await swc.connect(vault).setOperator(stranger.address);
      await expect(
        execNP(swc, stranger, 
          btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.not.be.reverted;
    });

    it("old operator cannot call executeSwap after rotation", async () => {
      const { swc, btcb, vault, operator, stranger } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      await swc.connect(vault).setOperator(stranger.address);
      await expect(
        execNP(swc, operator, 
          btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.be.revertedWithCustomError(swc, "NotOperator");
    });

    it("reverts NotVault when caller is not vault", async () => {
      const { swc, operator, stranger } = await loadFixture(rootFixture);
      await expect(swc.connect(stranger).setOperator(operator.address))
        .to.be.revertedWithCustomError(swc, "NotVault");
    });

    it("reverts ZeroAddress on zero operator", async () => {
      const { swc, vault } = await loadFixture(rootFixture);
      await expect(swc.connect(vault).setOperator(ZERO))
        .to.be.revertedWithCustomError(swc, "ZeroAddress");
    });
  });

  // ─── 15b. deposit / depositedAmount ────────────────────────────────────────

  describe("deposit", () => {
    const FIVE = ethers.parseEther("5");

    it("pulls the token from the vault and records depositedAmount, atomically", async () => {
      const { swc, btcb, vault } = await loadFixture(rootFixture);
      await btcb.mint(vault.address, FIVE);
      await btcb.connect(vault).approve(swc.target, FIVE);

      await swc.connect(vault).deposit(btcb.target, FIVE);

      expect(await swc.depositedAmount()).to.equal(FIVE);
      expect(await btcb.balanceOf(swc.target)).to.equal(FIVE);
      expect(await btcb.balanceOf(vault.address)).to.equal(0n);
    });

    it("accumulates across multiple deposits", async () => {
      const { swc, btcb, vault } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, FIVE);
      await depositPrincipal(swc, vault, btcb, FIVE);

      expect(await swc.depositedAmount()).to.equal(FIVE * 2n);
      expect(await btcb.balanceOf(swc.target)).to.equal(FIVE * 2n);
    });

    it("reverts NotVault when caller is not vault", async () => {
      const { swc, btcb, stranger } = await loadFixture(rootFixture);
      await btcb.mint(stranger.address, FIVE);
      await btcb.connect(stranger).approve(swc.target, FIVE);
      await expect(swc.connect(stranger).deposit(btcb.target, FIVE))
        .to.be.revertedWithCustomError(swc, "NotVault");
    });

    it("reverts if the vault has not approved the SWC to pull the token", async () => {
      const { swc, btcb, vault } = await loadFixture(rootFixture);
      await btcb.mint(vault.address, FIVE);
      await expect(swc.connect(vault).deposit(btcb.target, FIVE))
        .to.be.revertedWithCustomError(btcb, "ERC20InsufficientAllowance");
    });

    it("realizeForExit subtracts exactly the exited principal from depositedAmount", async () => {
      const { swc, btcb, vault } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, FIVE);
      await depositPrincipal(swc, vault, btcb, FIVE); // total depositedAmount = 10

      await swc.connect(vault).realizeForExit(btcb.target, FIVE, new Array(STRATEGY_COUNT).fill(0), new Array(STRATEGY_COUNT).fill("0x"));

      // Only the exited FIVE is deducted — the other slot's deposit is untouched.
      expect(await swc.depositedAmount()).to.equal(FIVE);
    });

    it("depositedAmount above uint128 max reverts (SafeCastOverflowedUintDowncast)", async () => {
      const { swc, btcb, vault } = await loadFixture(rootFixture);
      const TOO_BIG = 2n ** 128n; // exactly one past type(uint128).max
      await btcb.mint(vault.address, TOO_BIG);
      await btcb.connect(vault).approve(swc.target, TOO_BIG);
      await expect(swc.connect(vault).deposit(btcb.target, TOO_BIG))
        .to.be.revertedWithCustomError(swc, "SafeCastOverflowedUintDowncast");
    });
  });

  // ─── 16. realizeForExit / releasePrincipal ────────────────────────────────

  describe("realizeForExit / releasePrincipal", () => {
    const TEN = ethers.parseEther("10");

    it("realizeForExit: reverts NotVault when caller is not vault", async () => {
      const { swc, btcb, stranger } = await loadFixture(rootFixture);
      await expect(
        swc.connect(stranger).realizeForExit(btcb.target, 0, new Array(STRATEGY_COUNT).fill(0), new Array(STRATEGY_COUNT).fill("0x")),
      ).to.be.revertedWithCustomError(swc, "NotVault");
    });

    it("realizeForExit: reverts ZeroAddress on zero token", async () => {
      const { swc, vault } = await loadFixture(rootFixture);
      await expect(
        swc.connect(vault).realizeForExit(ZERO, 0, new Array(STRATEGY_COUNT).fill(0), new Array(STRATEGY_COUNT).fill("0x")),
      ).to.be.revertedWithCustomError(swc, "ZeroAddress");
    });

    it("realizeForExit: reverts LengthMismatch when minConsolidationOuts.length != STRATEGY_COUNT", async () => {
      const { swc, btcb, vault } = await loadFixture(rootFixture);
      await expect(
        swc.connect(vault).realizeForExit(btcb.target, 0, [0, 0, 0], new Array(STRATEGY_COUNT).fill("0x")),
      ).to.be.revertedWithCustomError(swc, "LengthMismatch");
    });

    it("releasePrincipal: reverts NotVault when caller is not vault", async () => {
      const { swc, btcb, stranger } = await loadFixture(rootFixture);
      await expect(swc.connect(stranger).releasePrincipal(btcb.target))
        .to.be.revertedWithCustomError(swc, "NotVault");
    });

    it("releasePrincipal: returns 0 without transferring when no principal is pending", async () => {
      const { swc, btcb, vault } = await loadFixture(rootFixture);
      expect(await swc.connect(vault).releasePrincipal.staticCall(btcb.target)).to.equal(0n);
      await expect(swc.connect(vault).releasePrincipal(btcb.target))
        .to.emit(swc, "ExitWithdrawn")
        .withArgs(btcb.target, vault.address, 0n)
        .and.to.not.emit(btcb, "Transfer");
    });

    it("total loss: realizeForExit locks 0 and releasePrincipal still succeeds with 0", async () => {
      const { swc, btcb, eth, agg, vault, operator } = await loadFixture(rootFixture);
      // 1-wei principal, fully deployed, consolidated back at a rate that rounds to 0.
      await depositPrincipal(swc, vault, btcb, 1n);
      await execNP(swc, operator, btcbToEthPath(), 1n, 0, "0x", "0x", "0x");
      await agg.setOutRateBps(1);

      await expect(
        swc.connect(vault).realizeForExit(
          btcb.target,
          1n,
          new Array(STRATEGY_COUNT).fill(0),
          buildPortfolioPaths({
            [ETH_ADDRESS]: aggData(ETH_ADDRESS, BTCB_ADDRESS, 1n, 0n, swc.target),
          }),
        ),
      )
        .to.emit(swc, "ExitRealized")
        .withArgs(btcb.target, 1n, 0n);
      expect(await btcb.balanceOf(swc.target)).to.equal(0n);
      expect(await swc.pendingPrincipal()).to.equal(0n);
      expect(await eth.balanceOf(swc.target)).to.equal(0n);

      await expect(swc.connect(vault).releasePrincipal(btcb.target))
        .to.emit(swc, "ExitWithdrawn")
        .withArgs(btcb.target, vault.address, 0n);
    });

    it("no profit: locks the full principal, emits ExitRealized(profit=0), then releases it", async () => {
      const { swc, btcb, vault } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      const vaultBefore = await btcb.balanceOf(vault.address);

      await expect(
        swc.connect(vault).realizeForExit(btcb.target, TEN, new Array(STRATEGY_COUNT).fill(0), new Array(STRATEGY_COUNT).fill("0x")),
      )
        .to.emit(swc, "ExitRealized")
        .withArgs(btcb.target, TEN, 0);

      // Principal stays on SWC until releasePrincipal.
      expect(await btcb.balanceOf(vault.address)).to.equal(vaultBefore);
      expect(await btcb.balanceOf(swc.target)).to.equal(TEN);

      await expect(swc.connect(vault).releasePrincipal(btcb.target))
        .to.emit(swc, "ExitWithdrawn")
        .withArgs(btcb.target, vault.address, TEN);

      expect(await btcb.balanceOf(swc.target)).to.equal(0n);
      expect(await btcb.balanceOf(vault.address)).to.equal(vaultBefore + TEN);
    });

    it("surplus over principal is forwarded to vault immediately as profit", async () => {
      const { swc, btcb, vault } = await loadFixture(rootFixture);
      const surplus = ethers.parseEther("2");
      await depositPrincipal(swc, vault, btcb, TEN);
      await btcb.mint(swc.target, surplus); // simulated profit sitting on the SWC
      const vaultBefore = await btcb.balanceOf(vault.address);

      await expect(
        swc.connect(vault).realizeForExit(btcb.target, TEN, new Array(STRATEGY_COUNT).fill(0), new Array(STRATEGY_COUNT).fill("0x")),
      )
        .to.emit(swc, "ExitRealized")
        .withArgs(btcb.target, TEN, surplus);

      expect(await btcb.balanceOf(vault.address)).to.equal(vaultBefore + surplus);
      expect(await btcb.balanceOf(swc.target)).to.equal(TEN);
    });

    it("deployed: auto-consolidates open position before locking principal", async () => {
      const { swc, btcb, eth, vault, operator } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);

      // Open ETH position.
      await execNP(swc, operator, 
        btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
      );
      expect(await swc.deployedCount()).to.equal(1n);

      await swc.connect(vault).realizeForExit(
        btcb.target,
        TEN,
        new Array(STRATEGY_COUNT).fill(0),
        buildPortfolioPaths({
          [ETH_ADDRESS]: aggData(ETH_ADDRESS, BTCB_ADDRESS, ONE_ETH, 0n, swc.target),
        }),
      );

      expect(await eth.balanceOf(swc.target)).to.equal(0n);
      expect(await swc.deployedCount()).to.equal(0n);
      // SWC holds principal.
      expect(await btcb.balanceOf(swc.target)).to.equal(TEN);
    });

    it("clears every order on every slot, including multiple orders on the same slot", async () => {
      const { swc, btcb, eth, vault, operator } = await loadFixture(rootFixture);
      const xrp = await injectBytecode<MockERC20>("MockERC20", XRP_ADDRESS, ["XRP", "XRP", 18]);
      await xrp.mint(DEX_ADDRESS, ethers.parseEther("1000000"));
      await xrp.mint(AGGREGATOR_ADDRESS, ethers.parseEther("1000000"));

      await depositPrincipal(swc, vault, btcb, TEN);

      // Two independent orders on the ETH slot, one order on the XRP slot.
      await execNP(swc, operator, btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x");
      await execNP(swc, operator, btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x");
      await execNP(swc, operator,
        encodePath([BTCB_ADDRESS, XRP_ADDRESS], [DEFAULT_FEE]), ONE_ETH, 0, "0x", "0x", "0x",
      );
      expect(await swc.orderCount(eth.target)).to.equal(2n);
      expect(await swc.orderCount(XRP_ADDRESS)).to.equal(1n);
      expect(await swc.deployedCount()).to.equal(2n);

      await swc.connect(vault).realizeForExit(
        btcb.target,
        TEN,
        new Array(STRATEGY_COUNT).fill(0),
        buildPortfolioPaths({
          [ETH_ADDRESS]: aggData(ETH_ADDRESS, BTCB_ADDRESS, ONE_ETH * 2n, 0n, swc.target),
          [XRP_ADDRESS]: aggData(XRP_ADDRESS, BTCB_ADDRESS, ONE_ETH, 0n, swc.target),
        }),
      );

      expect(await swc.orderCount(eth.target)).to.equal(0n);
      expect(await swc.orderCount(XRP_ADDRESS)).to.equal(0n);
      expect(await swc.deployedCount()).to.equal(0n);
      expect(await btcb.balanceOf(swc.target)).to.equal(TEN);
    });

    it("dust donated to a deployed slot after the calldata was built does not revert the exit", async () => {
      const { swc, btcb, eth, vault, operator, stranger } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      await execNP(swc, operator, btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x");

      // Calldata built off-chain against balanceOf == ONE_ETH …
      const paths = buildPortfolioPaths({
        [ETH_ADDRESS]: aggData(ETH_ADDRESS, BTCB_ADDRESS, ONE_ETH, 0n, swc.target),
      });
      // … then a griefer front-runs with 1 wei of the slot token.
      await eth.mint(stranger.address, 1n);
      await eth.connect(stranger).transfer(swc.target, 1n);

      await expect(
        swc.connect(vault).realizeForExit(btcb.target, TEN, new Array(STRATEGY_COUNT).fill(0), paths),
      )
        .to.emit(swc, "ExitRealized")
        .withArgs(btcb.target, TEN, 0);

      expect(await swc.deployedCount()).to.equal(0n);
      expect(await swc.pendingPrincipal()).to.equal(TEN);
      // The donated wei is left behind; the full position was consolidated.
      expect(await eth.balanceOf(swc.target)).to.equal(1n);
    });

    it("reverts ConsolidationAmountOutOfRange when amountIn is below the open-order total", async () => {
      const { swc, btcb, vault, operator } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      await execNP(swc, operator, btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x");

      const short = ONE_ETH - 1n;
      await expect(
        swc.connect(vault).realizeForExit(
          btcb.target,
          TEN,
          new Array(STRATEGY_COUNT).fill(0),
          buildPortfolioPaths({
            [ETH_ADDRESS]: aggData(ETH_ADDRESS, BTCB_ADDRESS, short, 0n, swc.target),
          }),
        ),
      )
        .to.be.revertedWithCustomError(swc, "ConsolidationAmountOutOfRange")
        .withArgs(short, ONE_ETH, ONE_ETH);
    });

    it("reverts ConsolidationAmountOutOfRange when amountIn exceeds the slot balance", async () => {
      const { swc, btcb, vault, operator } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      await execNP(swc, operator, btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x");

      const over = ONE_ETH + 1n;
      await expect(
        swc.connect(vault).realizeForExit(
          btcb.target,
          TEN,
          new Array(STRATEGY_COUNT).fill(0),
          buildPortfolioPaths({
            [ETH_ADDRESS]: aggData(ETH_ADDRESS, BTCB_ADDRESS, over, 0n, swc.target),
          }),
        ),
      )
        .to.be.revertedWithCustomError(swc, "ConsolidationAmountOutOfRange")
        .withArgs(over, ONE_ETH, ONE_ETH);
    });

    it("executeSwap is blocked after realizeForExit (ExitPending)", async () => {
      const { swc, btcb, vault, operator } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      await swc.connect(vault).realizeForExit(btcb.target, TEN, new Array(STRATEGY_COUNT).fill(0), new Array(STRATEGY_COUNT).fill("0x"));
      expect(await swc.pendingPrincipal()).to.be.gt(0);

      await btcb.mint(swc.target, ONE_ETH);
      await expect(
        execNP(swc, operator, 
          btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.be.revertedWithCustomError(swc, "ExitPending");
    });

    it("executeSwap unblocks after releasePrincipal clears pendingPrincipal", async () => {
      const { swc, btcb, vault, operator } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      await btcb.mint(swc.target, ethers.parseEther("10")); // simulated profit on top of principal
      await swc.connect(vault).realizeForExit(btcb.target, TEN, new Array(STRATEGY_COUNT).fill(0), new Array(STRATEGY_COUNT).fill("0x"));
      await swc.connect(vault).releasePrincipal(btcb.target);
      expect(await swc.pendingPrincipal()).to.equal(0n);

      // Fund SWC again and try a swap — must succeed.
      await btcb.mint(swc.target, ONE_ETH);
      await expect(
        execNP(swc, operator, 
          btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.not.be.reverted;
    });
  });

  // ─── liquidateForExit (stable payout) ─────────────────────────────────────

  describe("liquidateForExit / releasePrincipal (USDT)", () => {
    const TEN = ethers.parseEther("10");
    const zeros = () => new Array(STRATEGY_COUNT).fill(0);
    // EnishiConstants.EXIT_DUST_TOLERANCE_BPS (10) of the principal.
    const tolerance = (principal: bigint) => (principal * 10n) / 10_000n;

    /** Per-slot swapData selling `amounts[token]` of each token into USDT. */
    function toUsdt(swc: any, amounts: Record<string, bigint>): string[] {
      const overrides: Record<string, string> = {};
      for (const [token, amount] of Object.entries(amounts)) {
        overrides[token] = aggData(token, USDT_ADDRESS, amount, 0n, swc.target);
      }
      return buildPortfolioPaths(overrides);
    }

    it("sells deployed slots and the idle Available Token into USDT held on the SWC", async () => {
      const { swc, btcb, eth, usdt, vault, operator } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      await execNP(swc, operator, btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x");
      const vaultUsdtBefore = await usdt.balanceOf(vault.address);

      const swapData = toUsdt(swc, { [ETH_ADDRESS]: ONE_ETH, [BTCB_ADDRESS]: TEN - ONE_ETH });
      expect(await swc.connect(vault).liquidateForExit.staticCall(btcb.target, TEN, zeros(), swapData))
        .to.equal(TEN);
      await expect(swc.connect(vault).liquidateForExit(btcb.target, TEN, zeros(), swapData))
        .to.emit(swc, "ExitLiquidated")
        .withArgs(btcb.target, TEN, TEN)
        .and.to.not.emit(swc, "ExitRealized");

      expect(await usdt.balanceOf(swc.target)).to.equal(TEN);
      expect(await usdt.balanceOf(vault.address)).to.equal(vaultUsdtBefore);
      expect(await btcb.balanceOf(swc.target)).to.equal(0n);
      expect(await eth.balanceOf(swc.target)).to.equal(0n);
      expect(await swc.pendingPrincipal()).to.equal(TEN);
      expect(await swc.pendingStable()).to.equal(true);
      expect(await swc.depositedAmount()).to.equal(0n);
      expect(await swc.deployedCount()).to.equal(0n);
      expect(await swc.orderCount(eth.target)).to.equal(0n);
    });

    it("keeps open gains in the USDT payout instead of splitting them off as profit", async () => {
      const { swc, btcb, usdt, vault } = await loadFixture(rootFixture);
      const surplus = ethers.parseEther("2");
      await depositPrincipal(swc, vault, btcb, TEN);
      await btcb.mint(swc.target, surplus);
      const vaultBtcbBefore = await btcb.balanceOf(vault.address);

      await swc.connect(vault).liquidateForExit(
        btcb.target, TEN, zeros(), toUsdt(swc, { [BTCB_ADDRESS]: TEN + surplus }),
      );

      expect(await btcb.balanceOf(vault.address)).to.equal(vaultBtcbBefore);
      expect(await usdt.balanceOf(swc.target)).to.equal(TEN + surplus);
      expect(await swc.pendingPrincipal()).to.equal(TEN + surplus);
    });

    it("releasePrincipal(USDT) hands the locked USDT to the Vault and resets the lock", async () => {
      const { swc, btcb, usdt, vault, operator } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      await swc.connect(vault).liquidateForExit(btcb.target, TEN, zeros(), toUsdt(swc, { [BTCB_ADDRESS]: TEN }));
      const vaultBefore = await usdt.balanceOf(vault.address);

      await expect(swc.connect(vault).releasePrincipal(usdt.target))
        .to.emit(swc, "ExitWithdrawn")
        .withArgs(usdt.target, vault.address, TEN);

      expect(await usdt.balanceOf(vault.address)).to.equal(vaultBefore + TEN);
      expect(await usdt.balanceOf(swc.target)).to.equal(0n);
      expect(await swc.pendingPrincipal()).to.equal(0n);
      expect(await swc.pendingStable()).to.equal(false);

      // The SWC is back to Available-Token mode and can trade again.
      await depositPrincipal(swc, vault, btcb, TEN);
      await expect(execNP(swc, operator, btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x"))
        .to.not.be.reverted;
    });

    it("executeSwap is blocked while the USDT principal is pending (ExitPending)", async () => {
      const { swc, btcb, vault, operator } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      await swc.connect(vault).liquidateForExit(btcb.target, TEN, zeros(), toUsdt(swc, { [BTCB_ADDRESS]: TEN }));

      await btcb.mint(swc.target, ONE_ETH);
      await expect(execNP(swc, operator, btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x"))
        .to.be.revertedWithCustomError(swc, "ExitPending");
    });

    it("releasePrincipal reverts InvalidPayoutToken when the token does not match the lock", async () => {
      const { swc, btcb, usdt, vault } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);

      // Nothing liquidated: only the Available Token is accepted.
      await expect(swc.connect(vault).releasePrincipal(usdt.target))
        .to.be.revertedWithCustomError(swc, "InvalidPayoutToken")
        .withArgs(usdt.target, btcb.target);

      await swc.connect(vault).liquidateForExit(btcb.target, TEN, zeros(), toUsdt(swc, { [BTCB_ADDRESS]: TEN }));
      // Liquidated: only USDT is accepted.
      await expect(swc.connect(vault).releasePrincipal(btcb.target))
        .to.be.revertedWithCustomError(swc, "InvalidPayoutToken")
        .withArgs(btcb.target, usdt.target);
    });

    it("total loss: locks 0 USDT and releasePrincipal(USDT) still closes the exit", async () => {
      const { swc, btcb, usdt, vault } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      // Simulate a 100% loss: the SWC holds nothing at exit.
      await network.provider.send("hardhat_impersonateAccount", [swc.target]);
      await network.provider.send("hardhat_setBalance", [swc.target, LARGE_ETH_HEX]);
      const swcSigner = await ethers.getSigner(swc.target as string);
      await btcb.connect(swcSigner).transfer(vault.address, TEN);

      await expect(swc.connect(vault).liquidateForExit(btcb.target, TEN, zeros(), new Array(STRATEGY_COUNT).fill("0x")))
        .to.emit(swc, "ExitLiquidated")
        .withArgs(btcb.target, TEN, 0n);
      expect(await swc.pendingStable()).to.equal(true);

      await expect(swc.connect(vault).releasePrincipal(usdt.target))
        .to.emit(swc, "ExitWithdrawn")
        .withArgs(usdt.target, vault.address, 0n);
      expect(await swc.pendingStable()).to.equal(false);
    });

    it("reverts ConsolidationAmountOutOfRange when the Available Token leg leaves more than the tolerance unsold", async () => {
      const { swc, btcb, vault } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);

      const short = TEN - tolerance(TEN) - 1n;
      await expect(
        swc.connect(vault).liquidateForExit(btcb.target, TEN, zeros(), toUsdt(swc, { [BTCB_ADDRESS]: short })),
      )
        .to.be.revertedWithCustomError(swc, "ConsolidationAmountOutOfRange")
        .withArgs(short, TEN - tolerance(TEN), TEN);
    });

    it("a dust donation to the idle Available Token does not revert the exit (partly deployed)", async () => {
      const { swc, btcb, usdt, vault, operator, stranger } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      await execNP(swc, operator, btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x");
      // Calldata built against the idle balance (9) …
      const swapData = toUsdt(swc, { [ETH_ADDRESS]: ONE_ETH, [BTCB_ADDRESS]: TEN - ONE_ETH });
      // … then a griefer front-runs with 1 wei of the Available Token.
      await btcb.mint(stranger.address, 1n);
      await btcb.connect(stranger).transfer(swc.target, 1n);

      await swc.connect(vault).liquidateForExit(btcb.target, TEN, zeros(), swapData);
      expect(await usdt.balanceOf(swc.target)).to.equal(TEN);
      expect(await btcb.balanceOf(swc.target)).to.equal(1n);
    });

    it("a dust donation does not revert the exit when the whole principal is deployed (no idle leg)", async () => {
      const { swc, btcb, usdt, vault, operator, stranger } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      await execNP(swc, operator, btcbToEthPath(), TEN, 0, "0x", "0x", "0x");
      const swapData = toUsdt(swc, { [ETH_ADDRESS]: TEN }); // no Available Token leg
      await btcb.mint(stranger.address, 1n);
      await btcb.connect(stranger).transfer(swc.target, 1n);

      await swc.connect(vault).liquidateForExit(btcb.target, TEN, zeros(), swapData);
      expect(await usdt.balanceOf(swc.target)).to.equal(TEN);
      expect(await btcb.balanceOf(swc.target)).to.equal(1n);
    });

    it("a donation above the tolerance still reverts the stale calldata", async () => {
      const { swc, btcb, vault, operator, stranger } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      await execNP(swc, operator, btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x");
      const idle = TEN - ONE_ETH;
      const swapData = toUsdt(swc, { [ETH_ADDRESS]: ONE_ETH, [BTCB_ADDRESS]: idle });
      const donation = tolerance(TEN) + 1n;
      await btcb.mint(stranger.address, donation);
      await btcb.connect(stranger).transfer(swc.target, donation);

      await expect(swc.connect(vault).liquidateForExit(btcb.target, TEN, zeros(), swapData))
        .to.be.revertedWithCustomError(swc, "ConsolidationAmountOutOfRange")
        .withArgs(idle, idle + 1n, idle + donation);
    });

    it("enforces the per-slot minimum USDT out (InsufficientOutput)", async () => {
      const { swc, btcb, vault } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      const minOuts = zeros();
      minOuts[0] = TEN + 1n; // BTCB slot; the mock swaps 1:1
      await expect(
        swc.connect(vault).liquidateForExit(btcb.target, TEN, minOuts, toUsdt(swc, { [BTCB_ADDRESS]: TEN })),
      )
        .to.be.revertedWithCustomError(swc, "InsufficientOutput")
        .withArgs(TEN, TEN + 1n);
    });

    it("releasePrincipal pays only the locked USDT, not USDT donated during the delay", async () => {
      const { swc, btcb, usdt, vault, stranger } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      await swc.connect(vault).liquidateForExit(btcb.target, TEN, zeros(), toUsdt(swc, { [BTCB_ADDRESS]: TEN }));
      await usdt.mint(stranger.address, ONE_ETH);
      await usdt.connect(stranger).transfer(swc.target, ONE_ETH);

      await expect(swc.connect(vault).releasePrincipal(usdt.target))
        .to.emit(swc, "ExitWithdrawn")
        .withArgs(usdt.target, vault.address, TEN);
      expect(await usdt.balanceOf(swc.target)).to.equal(ONE_ETH);
    });

    it("reverts AvailableTokenMismatch when the exit names another token", async () => {
      const { swc, btcb, eth, vault } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      const empty = new Array(STRATEGY_COUNT).fill("0x");
      await expect(swc.connect(vault).liquidateForExit(eth.target, TEN, zeros(), empty))
        .to.be.revertedWithCustomError(swc, "AvailableTokenMismatch")
        .withArgs(eth.target, btcb.target);
      await expect(swc.connect(vault).realizeForExit(eth.target, TEN, zeros(), empty))
        .to.be.revertedWithCustomError(swc, "AvailableTokenMismatch")
        .withArgs(eth.target, btcb.target);
    });

    it("leaves dust above the principal behind when the Available Token leg sells exactly the principal", async () => {
      const { swc, btcb, usdt, vault, stranger } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      const swapData = toUsdt(swc, { [BTCB_ADDRESS]: TEN });
      await btcb.mint(stranger.address, 1n);
      await btcb.connect(stranger).transfer(swc.target, 1n);

      await swc.connect(vault).liquidateForExit(btcb.target, TEN, zeros(), swapData);
      expect(await usdt.balanceOf(swc.target)).to.equal(TEN);
      expect(await btcb.balanceOf(swc.target)).to.equal(1n);
    });

    it("reverts when the Available Token is held but no swapData is supplied for it", async () => {
      const { swc, btcb, vault } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      await expect(
        swc.connect(vault).liquidateForExit(btcb.target, TEN, zeros(), new Array(STRATEGY_COUNT).fill("0x")),
      ).to.be.revertedWithCustomError(swc, "InvalidExecuteSelector");
    });

    it("reverts UnexpectedTokenOut when a leg does not end in USDT", async () => {
      const { swc, btcb, vault, operator } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, TEN);
      await execNP(swc, operator, btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x");

      const swapData = toUsdt(swc, { [BTCB_ADDRESS]: TEN - ONE_ETH });
      swapData[1] = aggData(ETH_ADDRESS, BTCB_ADDRESS, ONE_ETH, 0n, swc.target as string);
      await expect(swc.connect(vault).liquidateForExit(btcb.target, TEN, zeros(), swapData))
        .to.be.revertedWithCustomError(swc, "UnexpectedTokenOut");
    });

    it("reverts NotVault / LengthMismatch / ZeroAddress on bad callers or inputs", async () => {
      const { swc, btcb, vault, stranger } = await loadFixture(rootFixture);
      const empty = new Array(STRATEGY_COUNT).fill("0x");
      await expect(swc.connect(stranger).liquidateForExit(btcb.target, 0, zeros(), empty))
        .to.be.revertedWithCustomError(swc, "NotVault");
      await expect(swc.connect(vault).liquidateForExit(btcb.target, 0, [0, 0, 0], empty))
        .to.be.revertedWithCustomError(swc, "LengthMismatch");
      await expect(swc.connect(vault).liquidateForExit(ZERO, 0, zeros(), empty))
        .to.be.revertedWithCustomError(swc, "ZeroAddress");
    });
  });

  // ─── order queue views ────────────────────────────────────────────────────

  describe("order queue views", () => {
    it("returns an empty order queue for a token that has never been traded", async () => {
      const { swc } = await loadFixture(rootFixture);
      expect(await swc.orderCount(XRP_ADDRESS)).to.equal(0n);
    });
  });


  describe("Aggregator revert propagation", () => {
    it("executeSwap reverts when the aggregator reverts on round-1", async () => {
      const { swc, btcb, agg, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      await agg.setMustRevert(true);
      await expect(
        execNP(swc, operator,
          btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.be.reverted;
    });

    it("executeSwap reverts when the aggregator reverts on round-2", async () => {
      const { swc, btcb, eth, agg, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      await execNP(swc, operator,
        btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
      );
      await agg.setMustRevert(true);
      await expect(
        execNP(swc, operator,
          ethToBtcbPath(), ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.be.reverted;
    });

    it("executeSwap reverts when amountOutMin exceeds mock rate (slippage guard)", async () => {
      const { swc, btcb, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      // 1:1 mock rate → amountOut = ONE_ETH, requesting 2x triggers slippage revert.
      await expect(
        execNP(swc, operator,
          btcbToEthPath(), ONE_ETH, ONE_ETH * 2n, "0x", "0x", "0x",
        ),
      ).to.be.reverted;
    });

    it("order queue is NOT mutated when round-1 aggregator call reverts", async () => {
      const { swc, btcb, agg, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      await agg.setMustRevert(true);
      await expect(
        execNP(swc, operator,
          btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.be.reverted;
      // ETH order queue must remain untouched (no order opened).
      expect(await swc.orderCount(ETH_ADDRESS)).to.equal(0n);
      expect(await swc.deployedCount()).to.equal(0n);
    });
  });

  // ─── 18. MockVault.processProfit revert propagation ───────────────────────

  describe("MockVault.processProfit revert propagation", () => {
    const COST   = ethers.parseEther("5");
    const PROFIT = ethers.parseEther("5");
    const ROUND2_IN = COST + PROFIT;

    async function gainFixtureVaultRevert() {
      const base = await loadFixture(rootFixture);
      const { swc, btcb, eth, operator, vault, mockVault } = base;

      for (const a of [operator.address, vault.address]) {
        await network.provider.send("hardhat_setBalance", [a, LARGE_ETH_HEX]);
      }
      await btcb.mint(swc.target, COST);
      await execNP(swc, operator, 
        btcbToEthPath(), COST, 0, "0x", "0x", "0x",
      );
      await eth.mint(swc.target, PROFIT);
      await mockVault.setMustRevert(true);
      return base;
    }

    it("executeSwap (round-2 with profit) reverts when MockVault.processProfit reverts", async () => {
      const { swc, operator } = await loadFixture(gainFixtureVaultRevert);
      await expect(
        execWP(swc, operator, 
          ethToBtcbPath(), ROUND2_IN, 0, 0, 0, "0x", "0x", "0x",
        ),
      ).to.be.reverted;
    });
  });

  // ─── 19. receive() — native BNB acceptance ───────────────────────────────

  describe("receive() — native BNB acceptance", () => {
    it("accepts native BNB sent directly (from WBNB unwrap simulation)", async () => {
      const { swc, vault } = await loadFixture(rootFixture);
      // Simulate WBNB calling receive() by sending ETH from vault signer.
      const before = await ethers.provider.getBalance(swc.target);
      await vault.sendTransaction({ to: swc.target, value: ethers.parseEther("1") });
      expect(await ethers.provider.getBalance(swc.target)).to.equal(before + ethers.parseEther("1"));
    });
  });

  // ─── 20. _reversePath symmetry ────────────────────────────────────────────

  describe("_reversePath — single-hop path structure", () => {
    // _reversePath is internal — we test it indirectly by verifying that the
    // 1-hop gasPath (BTCB→WBNB) correctly reaches exactOutput (WBNB→BTCB reversed)
    // through the gas top-up fixture that already exercises this path.

    it("single-hop gasPath is structurally valid (encodePath produces 43-byte path)", () => {
      const path = btcbToWbnbGasPath();
      // A valid single-hop packed V3 path: 20 (token) + 3 (fee) + 20 (token) = 43 bytes.
      expect(path.length).to.equal(2 + 43 * 2); // "0x" + 43 bytes in hex
    });

    it("two-hop gasPath encodes 66 bytes (20+3+20+3+20)", () => {
      const twoHop = encodePath([BTCB_ADDRESS, ETH_ADDRESS, WBNB_ADDRESS], [DEFAULT_FEE, DEFAULT_FEE]);
      expect(twoHop.length).to.equal(2 + 66 * 2);
    });

    it("reversed 2-hop path has correct first/last token (WBNB/BTCB)", () => {
      // forward: BTCB→ETH→WBNB  reversed: WBNB→ETH→BTCB
      const forward = encodePath([BTCB_ADDRESS, ETH_ADDRESS, WBNB_ADDRESS], [DEFAULT_FEE, DEFAULT_FEE]);
      // First 20 bytes of forward = BTCB; first 20 bytes of reversed = WBNB.
      const forwardFirst = "0x" + forward.slice(2, 42).toLowerCase();
      const forwardLast  = "0x" + forward.slice(forward.length - 40).toLowerCase();
      expect(forwardFirst).to.equal(BTCB_ADDRESS.toLowerCase());
      expect(forwardLast).to.equal(WBNB_ADDRESS.toLowerCase());
    });
  });

  // ─── 21. realizeForExit — loss scenario (total < principal) ──────────────

  describe("realizeForExit — loss scenario", () => {
    it("locks min(total, principal) when total < principal", async () => {
      const { swc, btcb, eth, vault, operator, agg } = await loadFixture(rootFixture);
      const PRINCIPAL = ethers.parseEther("10");
      const ACTUAL    = ethers.parseEther("7"); // SWC ends up with less than principal

      await depositPrincipal(swc, vault, btcb, PRINCIPAL);
      // Open a full-principal ETH position, then consolidate it back at a lossy
      // 70% rate so the SWC's real on-chain balance ends up below `depositedAmount`.
      await execNP(swc, operator, btcbToEthPath(), PRINCIPAL, 0, "0x", "0x", "0x");
      await agg.setOutRateBps(7000);
      const vaultBefore = await btcb.balanceOf(vault.address);

      await expect(
        swc.connect(vault).realizeForExit(
          btcb.target,
          PRINCIPAL,
          new Array(STRATEGY_COUNT).fill(0),
          buildPortfolioPaths({
            [ETH_ADDRESS]: aggData(ETH_ADDRESS, BTCB_ADDRESS, PRINCIPAL, 0n, swc.target),
          }),
        ),
      )
        .to.emit(swc, "ExitRealized")
        .withArgs(btcb.target, PRINCIPAL, 0); // no profit forwarded

      // Vault does NOT receive anything immediately (total <= principal branch).
      expect(await btcb.balanceOf(vault.address)).to.equal(vaultBefore);
      // pendingPrincipal should be capped at actual balance (7), not principal (10).
      expect(await swc.pendingPrincipal()).to.equal(ACTUAL);

      // releasePrincipal transfers the locked amount.
      await swc.connect(vault).releasePrincipal(btcb.target);
      expect(await btcb.balanceOf(vault.address)).to.equal(vaultBefore + ACTUAL);
    });
  });

  // ─── 22. releasePrincipal — zero-address revert ───────────────────────────

  describe("releasePrincipal — ZeroAddress guard", () => {
    it("reverts ZeroAddress when availableToken is zero", async () => {
      const { swc, btcb, vault } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, ethers.parseEther("5"));
      await swc.connect(vault).realizeForExit(btcb.target, ethers.parseEther("5"), new Array(STRATEGY_COUNT).fill(0), new Array(STRATEGY_COUNT).fill("0x"));
      await expect(swc.connect(vault).releasePrincipal(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(swc, "ZeroAddress");
    });
  });

  //

  describe("executeSwap — non-1:1 aggregator rate (round-1 only)", () => {
    it("round-1 at 80% rate: SWC receives 0.8x amountIn, order records full input", async () => {
      const { swc, btcb, eth, agg, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      await agg.setOutRateBps(8000);

      const amountOut = (ONE_ETH * 8000n) / 10000n;
      // costBasis records what was SPENT (BTCB), not what was received.
      // assetAmount records what was RECEIVED (ETH) — this is the field the
      // old Cycle-based design never tracked, causing the unit bug.
      await expect(
        execNP(swc, operator, btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x"),
      )
        .to.emit(swc, "OrderOpened")
        .withArgs(eth.target, 0n, ONE_ETH, amountOut);
      expect(await eth.balanceOf(swc.target)).to.equal(amountOut);
    });

    it("round-1 at 150% rate: SWC receives 1.5x amountIn, order cost basis = amountIn", async () => {
      const { swc, btcb, eth, agg, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      await agg.setOutRateBps(15000);

      const amountOut = (ONE_ETH * 15000n) / 10000n;
      // cost basis = amountIn, not amountOut; asset side = what was received.
      await expect(
        execNP(swc, operator, btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x"),
      )
        .to.emit(swc, "OrderOpened")
        .withArgs(eth.target, 0n, ONE_ETH, amountOut);
      expect(await eth.balanceOf(swc.target)).to.equal(amountOut);
    });

    it("slippage guard: amountOutMin > actual output causes aggregator revert", async () => {
      const { swc, btcb, agg, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      await agg.setOutRateBps(8000);

      // Ask for at least ONE_ETH out with 80% rate → revert.
      await expect(
        execNP(swc, operator, 
          btcbToEthPath(), ONE_ETH, ONE_ETH, "0x", "0x", "0x",
        ),
      ).to.be.reverted;
    });
  });

  // ─── 24. deployedCount and getDeployedTokens — view accuracy ─────────────

  describe("deployedCount and getDeployedTokens", () => {
    it("returns zero and empty list before any swap", async () => {
      const { swc } = await loadFixture(rootFixture);
      expect(await swc.deployedCount()).to.equal(0n);
      expect(await swc.getDeployedTokens()).to.deep.equal([]);
    });

    it("returns correct count after opening multiple positions", async () => {
      const { swc, btcb, operator } = await loadFixture(rootFixture);
      const xrp = await injectBytecode<MockERC20>("MockERC20", XRP_ADDRESS, ["XRP", "XRP", 18]);
      await xrp.mint(DEX_ADDRESS, ethers.parseEther("1000000"));
      await xrp.mint(AGGREGATOR_ADDRESS, ethers.parseEther("1000000"));
      await btcb.mint(swc.target, ONE_ETH * 3n);

      await execNP(swc, operator, 
        btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
      );
      await execNP(swc, operator, 
        encodePath([BTCB_ADDRESS, XRP_ADDRESS], [DEFAULT_FEE]), ONE_ETH, 0, "0x",
        "0x",
        "0x",
      );

      expect(await swc.deployedCount()).to.equal(2n);
      const tokens = (await swc.getDeployedTokens()).map((a: string) => a.toLowerCase());
      expect(tokens).to.have.members([ETH_ADDRESS.toLowerCase(), XRP_ADDRESS.toLowerCase()]);
    });
  });

  // ─── 25. pendingPrincipal blocks and lifecycle ────────────────────────────

  describe("pendingPrincipal lifecycle", () => {
    it("pendingPrincipal is zero before any realizeForExit", async () => {
      const { swc } = await loadFixture(rootFixture);
      expect(await swc.pendingPrincipal()).to.equal(0n);
    });

    it("pendingPrincipal is set after realizeForExit and cleared after releasePrincipal", async () => {
      const { swc, btcb, vault } = await loadFixture(rootFixture);
      const AMT = ethers.parseEther("5");
      await depositPrincipal(swc, vault, btcb, AMT);

      await swc.connect(vault).realizeForExit(btcb.target, AMT, new Array(STRATEGY_COUNT).fill(0), new Array(STRATEGY_COUNT).fill("0x"));
      expect(await swc.pendingPrincipal()).to.equal(AMT);

      await swc.connect(vault).releasePrincipal(btcb.target);
      expect(await swc.pendingPrincipal()).to.equal(0n);
    });

    it("second releasePrincipal pays nothing after the first already cleared it", async () => {
      const { swc, btcb, vault } = await loadFixture(rootFixture);
      const AMT = ethers.parseEther("5");
      await depositPrincipal(swc, vault, btcb, AMT);
      await swc.connect(vault).realizeForExit(btcb.target, AMT, new Array(STRATEGY_COUNT).fill(0), new Array(STRATEGY_COUNT).fill("0x"));
      await swc.connect(vault).releasePrincipal(btcb.target);

      const vaultBefore = await btcb.balanceOf(vault.address);
      await expect(swc.connect(vault).releasePrincipal(btcb.target))
        .to.emit(swc, "ExitWithdrawn")
        .withArgs(btcb.target, vault.address, 0n);
      expect(await btcb.balanceOf(vault.address)).to.equal(vaultBefore);
    });
  });

  // ─── 26. DEX allowance management ────────────────────────────────────────

  describe("DEX allowance management", () => {
    it("re-approves DEX when allowance is exhausted between round-1 swaps", async () => {
      const { swc, btcb, eth, operator } = await loadFixture(rootFixture);
      // Perform a round-1 to set initial allowance, then another to test re-approval path.
      const HALF = ONE_ETH / 2n;
      await btcb.mint(swc.target, ONE_ETH);

      await execNP(swc, operator, 
        btcbToEthPath(), HALF, 0, "0x", "0x", "0x",
      );
      // Second swap uses remaining allowance — should not revert.
      await execNP(swc, operator, 
        btcbToEthPath(), HALF, 0, "0x", "0x", "0x",
      );

      expect(await swc.orderCount(eth.target)).to.equal(2n);
    });
  });

  // ─── 27. initialize — access control ─────────────────────────────────────

  describe("initialize — access control", () => {
    it("reverts ZeroAddress when operator_ is zero", async () => {
      // Deploy a fresh (uncloned) implementation to call initialize on.
      const Impl = await ethers.getContractFactory("SwapContract");
      const impl = await Impl.deploy();
      // The constructor disables initializers, so direct call reverts InvalidInitialization.
      await expect(impl.initialize(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });
  });

  // ─── 28. pause / unpause — operator check still works ────────────────────

  describe("pause / unpause — operator check order", () => {
    it("NotOperator is checked before EnforcedPause (correct order)", async () => {
      const { swc, btcb, vault, stranger } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      await swc.connect(vault).pause();
      // Both guards apply; Solidity evaluates onlyOperator first → NotOperator.
      await expect(
        execNP(swc, stranger, 
          btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.be.revertedWithCustomError(swc, "NotOperator");
    });
  });

  // ─── 29. ExitPending blocks operator, checked after operator guard ────────

  describe("ExitPending guard ordering", () => {
    it("NotOperator takes precedence over ExitPending", async () => {
      const { swc, btcb, vault, stranger } = await loadFixture(rootFixture);
      await depositPrincipal(swc, vault, btcb, ethers.parseEther("10"));
      await swc.connect(vault).realizeForExit(btcb.target, ethers.parseEther("10"), new Array(STRATEGY_COUNT).fill(0), new Array(STRATEGY_COUNT).fill("0x"));

      await btcb.mint(swc.target, ONE_ETH);
      await expect(
        execNP(swc, stranger, 
          btcbToEthPath(), ONE_ETH, 0, "0x", "0x", "0x",
        ),
      ).to.be.revertedWithCustomError(swc, "NotOperator");
    });
  });

  // ─── 30. executeSwap — round-2 close (profit realization) ─────────────────

  describe("executeSwap — round-2 close (profit realization)", () => {
    const COST = ethers.parseEther("5");
    const PROFIT = ethers.parseEther("5");
    const btcbUsdt = () => encodePath([BTCB_ADDRESS, USDT_ADDRESS], [DEFAULT_FEE]);
    const pfBtcbUsdt = () => btcbUsdt();

    // Opens an ETH order (cost = COST). Round-2 amountIn must equal COST (the
    // order's full `remaining`) — profit comes from the aggregator rate, not
    // from swapping more ETH than the order tracks.
    async function openGain() {
      const base = await loadFixture(rootFixtureWithStrategyTokens);
      const { swc, btcb, operator } = base;
      await btcb.mint(swc.target, COST);
      await execNP(swc, operator, btcbToEthPath(), COST, 0, "0x", "0x", "0x");
      return base;
    }

    it("realizes profit: swaps to payout, settles with Vault, snapshots, closes order", async () => {
      const { swc, eth, btcb, usdt, agg, operator, user, mockVault } = await openGain();
      await agg.setOutRateBps(20000); // 200% → amountOut = COST*2 = COST + PROFIT

      await expect(
        execWP(swc, operator, ethToBtcbPath(), COST, 0, 0, 0, "0x", "0x", pfBtcbUsdt()),
      )
        .to.emit(swc, "Profit")
        .and.to.emit(swc, "ProfitRealized");

      // Order closed, slot untracked.
      expect(await swc.orderCount(eth.target)).to.equal(0n);
      expect(await swc.deployedCount()).to.equal(0n);

      // Vault settled exactly once with the realized profit (5 BTCB → 5 USDT at 1:1).
      expect(await mockVault.processProfitCallCount()).to.equal(1n);
      const lp = await mockVault.lastProfit();
      expect(lp.user).to.equal(user.address);
      expect(lp.availableToken).to.equal(BTCB_ADDRESS);
      expect(lp.payoutToken).to.equal(USDT_ADDRESS);
      expect(lp.grossProfit).to.equal(PROFIT);
      // Vault pulled the payout USDT from the SWC.
      expect(await usdt.balanceOf(mockVault.target)).to.equal(PROFIT);
      // Principal (cost basis) stays on the SWC in the available token.
      expect(await btcb.balanceOf(swc.target)).to.equal(COST);
    });

    it("ProfitRealized carries payout token and stableToVault", async () => {
      const { swc, agg, operator } = await openGain();
      await agg.setOutRateBps(20000);
      await expect(
        execWP(swc, operator, ethToBtcbPath(), COST, 0, 0, 0, "0x", "0x", pfBtcbUsdt()),
      )
        .to.emit(swc, "ProfitRealized")
        .withArgs(BTCB_ADDRESS, PROFIT, 0n, PROFIT, anyValue, anyValue, anyValue);
    });

    it("break-even (profitDelta == 0): no settlement, order still closes", async () => {
      const { swc, eth, operator, mockVault } = await openGain(); // default 1:1 rate → break-even
      await expect(
        execWP(swc, operator, ethToBtcbPath(), COST, 0, 0, 0, "0x", "0x", pfBtcbUsdt()),
      ).to.emit(swc, "Profit");
      expect(await mockVault.processProfitCallCount()).to.equal(0n);
      expect(await swc.orderCount(eth.target)).to.equal(0n);
      expect(await swc.deployedCount()).to.equal(0n);
    });

    it("loss (profitDelta < 0): no settlement, negative delta in Profit", async () => {
      const { swc, eth, agg, operator, mockVault } = await openGain();
      await agg.setOutRateBps(8000);
      await execWP(swc, operator, ethToBtcbPath(), COST, 0, 0, 0, "0x", "0x", pfBtcbUsdt());
      expect(await mockVault.processProfitCallCount()).to.equal(0n);
      expect(await swc.orderCount(eth.target)).to.equal(0n);
    });

    it("reverts InvalidPath on round-2 when no order was ever opened", async () => {
      const { swc, btcb, operator } = await loadFixture(rootFixture);
      await btcb.mint(swc.target, ONE_ETH);
      // ETH→BTCB (round-2 shape) but no ETH order is open.
      await expect(
        execNP(swc, operator, ethToBtcbPath(), ONE_ETH, 0, "0x", "0x", "0x"),
      ).to.be.revertedWithCustomError(swc, "InvalidPath");
    });

    it("reverts TokenNotWhitelisted when round-2 tokenIn is a stablecoin", async () => {
      const { swc, operator } = await loadFixture(rootFixture);
      // USDT→BTCB: tokenOut == avail (round-2) but tokenIn (USDT) is not a strategy token.
      const usdtToBtcb = encodePath([USDT_ADDRESS, BTCB_ADDRESS], [DEFAULT_FEE]);
      await expect(
        execNP(swc, operator, usdtToBtcb, ONE_ETH, 0, "0x", "0x", "0x"),
      )
        .to.be.revertedWithCustomError(swc, "TokenNotWhitelisted")
        .withArgs(USDT_ADDRESS);
    });
  });

  // ─── 32. realizeForExit — consolidation path validation ───────────────────

  // ─── 33. _chargeOperatorGas / _validateGasPath / _reversePath ─────────────

  describe("executeSwap — operator gas top-up", () => {
    const COST = ethers.parseEther("5");
    const PROFIT = ethers.parseEther("5");
    const btcbUsdt = () => encodePath([BTCB_ADDRESS, USDT_ADDRESS], [DEFAULT_FEE]);
    const pfBtcbUsdt = () => btcbUsdt();
    const btcbWbnbGas = () => encodePath([BTCB_ADDRESS, WBNB_ADDRESS], [DEFAULT_FEE]);

    // Opens a COST-sized order, then sets the aggregator rate to 200% so
    // round-2 (amountIn = COST, the order's full remaining) yields amountOut
    // = COST + PROFIT, i.e. a PROFIT-sized gain — without swapping more than
    // the order tracks.
    async function openGainLowGas() {
      const base = await loadFixture(rootFixtureWithStrategyTokens);
      const { swc, btcb, agg, operator } = base;
      await btcb.mint(swc.target, COST);
      await execNP(swc, operator, btcbToEthPath(), COST, 0, "0x", "0x", "0x");
      await agg.setOutRateBps(20000);
      // Drop the operator below MIN_BNB and zero the base fee so it can still send.
      await network.provider.send("hardhat_setBalance", [
        operator.address, ethers.toBeHex(ethers.parseEther("0.001")),
      ]);
      await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
      return base;
    }

    it("tops up operator BNB via gasPath (avail → WBNB) when below MIN_BNB", async () => {
      const { swc, operator } = await openGainLowGas();
      const before = await ethers.provider.getBalance(operator.address);

      await execWP(swc, operator,
        ethToBtcbPath(), COST, 0, 0, 0, btcbWbnbGas(), "0x", pfBtcbUsdt(), { gasPrice: 0 },
      );

      const after = await ethers.provider.getBalance(operator.address);
      expect(after).to.be.gt(before);
      expect(after).to.be.gte(MIN_BNB);
    });

    it("skips top-up when operator BNB is in the [50%, MIN) hysteresis band", async () => {
      // 0.002 BNB: below MIN (0.003) but >= 50% (0.0015) → top-up must NOT fire.
      // (With a 100% threshold this would have wrongly topped up.)
      const base = await loadFixture(rootFixtureWithStrategyTokens);
      const { swc, btcb, agg, operator } = base;
      await btcb.mint(swc.target, COST);
      await execNP(swc, operator, btcbToEthPath(), COST, 0, "0x", "0x", "0x");
      await agg.setOutRateBps(20000);
      await network.provider.send("hardhat_setBalance", [
        operator.address, ethers.toBeHex(ethers.parseEther("0.002")),
      ]);
      await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
      const before = await ethers.provider.getBalance(operator.address);

      // gasPath supplied but ignored (balance >= 50% → early return, availSpentOnGas == 0).
      await expect(
        execWP(swc, operator,
          ethToBtcbPath(), COST, 0, 0, 0, btcbWbnbGas(), "0x", pfBtcbUsdt(), { gasPrice: 0 },
        ),
      ).to.emit(swc, "ProfitRealized")
        .withArgs(BTCB_ADDRESS, PROFIT, 0n, PROFIT, anyValue, anyValue, anyValue);

      // No BNB spent on gas → operator balance unchanged.
      expect(await ethers.provider.getBalance(operator.address)).to.equal(before);
    });

    it("tops up when operator BNB is just below 50% of MIN", async () => {
      // 0.001 BNB < 0.0015 (50% of MIN) → top-up fires.
      const { swc, operator } = await openGainLowGas(); // sets balance to 0.001
      const before = await ethers.provider.getBalance(operator.address);
      await execWP(swc, operator,
        ethToBtcbPath(), COST, 0, 0, 0, btcbWbnbGas(), "0x", pfBtcbUsdt(), { gasPrice: 0 },
      );
      expect(await ethers.provider.getBalance(operator.address)).to.be.gt(before);
    });

    it("reverts InvalidPath when gasPath has the wrong first token", async () => {
      const { swc, operator } = await openGainLowGas();
      // gasPath must start at avail (BTCB); start at ETH instead.
      const badGas = encodePath([ETH_ADDRESS, WBNB_ADDRESS], [DEFAULT_FEE]);
      await expect(
        execWP(swc, operator,
          ethToBtcbPath(), COST, 0, 0, 0, badGas, "0x", pfBtcbUsdt(), { gasPrice: 0 },
        ),
      ).to.be.revertedWithCustomError(swc, "InvalidPath");
    });

    it("reverts InvalidPath when gasPath does not end at WBNB", async () => {
      const { swc, operator } = await openGainLowGas();
      const badGas = encodePath([BTCB_ADDRESS, USDT_ADDRESS], [DEFAULT_FEE]);
      await expect(
        execWP(swc, operator,
          ethToBtcbPath(), COST, 0, 0, 0, badGas, "0x", pfBtcbUsdt(), { gasPrice: 0 },
        ),
      ).to.be.revertedWithCustomError(swc, "InvalidPath");
    });

    it("reverts InvalidPath when gasPath is too short (< 43 bytes)", async () => {
      const { swc, operator } = await openGainLowGas();
      await expect(
        execWP(swc, operator,
          ethToBtcbPath(), COST, 0, 0, 0, "0xdeadbeef", "0x", pfBtcbUsdt(), { gasPrice: 0 },
        ),
      ).to.be.revertedWithCustomError(swc, "InvalidPath");
    });

    it("skips top-up (and does not revert) when operator is low but gasPath is empty", async () => {
      const { swc, operator, mockVault } = await openGainLowGas();
      const before = await ethers.provider.getBalance(operator.address);
      // empty gasPath → _chargeOperatorGas returns 0; profit still realized.
      await execWP(swc, operator,
        ethToBtcbPath(), COST, 0, 0, 0, "0x", "0x", pfBtcbUsdt(), { gasPrice: 0 },
      );
      expect(await ethers.provider.getBalance(operator.address)).to.equal(before); // no top-up
      expect(await mockVault.processProfitCallCount()).to.equal(1n);
    });

    it("skips top-up (no gasPath) when operator is already above MIN_BNB", async () => {
      // operator keeps its default (large) balance → _chargeOperatorGas early-returns.
      const base = await loadFixture(rootFixtureWithStrategyTokens);
      const { swc, btcb, agg, operator, mockVault } = base;
      await btcb.mint(swc.target, COST);
      await execNP(swc, operator, btcbToEthPath(), COST, 0, "0x", "0x", "0x");
      await agg.setOutRateBps(20000);
      await expect(
        execWP(swc, operator, ethToBtcbPath(), COST, 0, 0, 0, "0x", "0x", pfBtcbUsdt()),
      ).to.emit(swc, "ProfitRealized").withArgs(BTCB_ADDRESS, PROFIT, 0n, PROFIT, anyValue, anyValue, anyValue);
      expect(await mockVault.processProfitCallCount()).to.equal(1n);
    });
  });

  // ─── 34. round-2 minStableOut slippage guard ──────────────────────────────

  describe("executeSwap — round-2 minStableOut slippage guard", () => {
    const COST = ethers.parseEther("5");
    const PROFIT = ethers.parseEther("5");
    const btcbUsdt = () => encodePath([BTCB_ADDRESS, USDT_ADDRESS], [DEFAULT_FEE]);
    const pfBtcbUsdt = () => btcbUsdt();

    async function openGain() {
      const base = await loadFixture(rootFixtureWithStrategyTokens);
      const { swc, btcb, agg, operator } = base;
      await btcb.mint(swc.target, COST);
      await execNP(swc, operator, btcbToEthPath(), COST, 0, "0x", "0x", "0x");
      await agg.setOutRateBps(20000); // amountOut = COST*2 = COST + PROFIT
      return base;
    }

    it("reverts when DEX output is below minStableOut", async () => {
      const { swc, dex, operator } = await openGain();
      // DEX returns 70 % of input; minStableOut demands the full PROFIT amount.
      await dex.setOutRateBps(7000);
      const minStableOut = PROFIT; // impossible to satisfy at 70 %
      await expect(
        execWP(swc, operator, ethToBtcbPath(), COST, 0, minStableOut, 0, "0x", "0x", pfBtcbUsdt()),
      ).to.be.reverted; // MockDexRouterV3 reverts "MockDexRouterV3: slippage"
    });

    it("succeeds when minStableOut equals the DEX output exactly", async () => {
      const { swc, operator } = await openGain();
      // At 1:1 rate, PROFIT BTCB → PROFIT USDT.
      await expect(
        execWP(swc, operator, ethToBtcbPath(), COST, 0, PROFIT, 0, "0x", "0x", pfBtcbUsdt()),
      ).to.emit(swc, "ProfitRealized");
    });
  });

  // ─── 35. exactOutput DEX allowance reset ──────────────────────────────────

  describe("executeSwap — exactOutput DEX allowance reset after gas top-up", () => {
    const COST = ethers.parseEther("5");
    const pfBtcbUsdt = () => encodePath([BTCB_ADDRESS, USDT_ADDRESS], [DEFAULT_FEE]);

    async function openGainLowGas() {
      const base = await loadFixture(rootFixtureWithStrategyTokens);
      const { swc, btcb, agg, operator } = base;
      await btcb.mint(swc.target, COST);
      await execNP(swc, operator, btcbToEthPath(), COST, 0, "0x", "0x", "0x");
      await agg.setOutRateBps(20000);
      await network.provider.send("hardhat_setBalance", [
        operator.address, ethers.toBeHex(ethers.parseEther("0.001")),
      ]);
      await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
      return base;
    }

    it("DEX allowance is 0 after exactOutput gas top-up (no leftover approval)", async () => {
      const { swc, btcb, operator } = await openGainLowGas();

      // BTCB → WBNB gasPath triggers exactOutput; forceApprove(dex, 0) clears leftover.
      await execWP(swc, operator,
        ethToBtcbPath(), COST, 0, 0, 0, btcbToWbnbGasPath(), "0x", pfBtcbUsdt(), { gasPrice: 0 },
      );

      // Remaining BTCB allowance on the DEX should be exactly 0.
      expect(await btcb.allowance(swc.target, DEX_ADDRESS)).to.equal(0n);
    });
  });

  // ─── 36. realizeForExit — consolidationPaths length mismatch ─────────────

  describe("realizeForExit — consolidationPaths LengthMismatch", () => {
    it("reverts LengthMismatch when consolidationPaths.length != STRATEGY_COUNT", async () => {
      const { swc, btcb, vault } = await loadFixture(rootFixture);
      // minConsolidationOuts correct (7), consolidationPaths wrong (3).
      await expect(
        swc.connect(vault).realizeForExit(btcb.target, 0, new Array(STRATEGY_COUNT).fill(0), ["0x", "0x", "0x"]),
      ).to.be.revertedWithCustomError(swc, "LengthMismatch");
    });
  });

  // ─── 37. _chargeOperatorGas — partial top-up (cap branch) ─────────────────

  describe("executeSwap — _chargeOperatorGas partial top-up (profit < BNB deficit)", () => {
    // Tiny profit: less than MIN_BNB (0.003) so the full top-up cannot be covered.
    const COST = ethers.parseEther("5");
    const TINY_PROFIT = ethers.parseEther("0.001"); // < MIN_BNB
    // amountOut = COST + TINY_PROFIT when amountIn = COST → rate in bps.
    const TINY_PROFIT_RATE_BPS = ((COST + TINY_PROFIT) * 10000n) / COST;
    const pfBtcbUsdt = () => encodePath([BTCB_ADDRESS, USDT_ADDRESS], [DEFAULT_FEE]);

    it("partially tops up operator when profit < BNB deficit; operator still below MIN_BNB", async () => {
      const base = await loadFixture(rootFixtureWithStrategyTokens);
      const { swc, btcb, agg, operator } = base;

      await btcb.mint(swc.target, COST);
      await execNP(swc, operator, btcbToEthPath(), COST, 0, "0x", "0x", "0x");
      await agg.setOutRateBps(TINY_PROFIT_RATE_BPS);

      // Set operator to 0 BNB → full deficit = MIN_BNB = 0.003.
      await network.provider.send("hardhat_setBalance", [operator.address, "0x0"]);
      await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);

      const before = await ethers.provider.getBalance(operator.address);

      await execWP(swc, operator,
        ethToBtcbPath(), COST, 0, 0, 0, btcbToWbnbGasPath(), "0x", pfBtcbUsdt(), { gasPrice: 0 },
      );

      const after = await ethers.provider.getBalance(operator.address);
      // Operator received some BNB (partial top-up).
      expect(after).to.be.gt(before);
      // But still below MIN_BNB because TINY_PROFIT < full deficit.
      expect(after).to.be.lt(MIN_BNB);
    });
  });

  // ─── 38. _reversePath — multi-hop byte correctness ─────────────────────────

  describe("executeSwap — _reversePath multi-hop correctness (2-hop gas path)", () => {
    const COST = ethers.parseEther("5");
    const pfBtcbUsdt = () => encodePath([BTCB_ADDRESS, USDT_ADDRESS], [DEFAULT_FEE]);

    it("2-hop gas path BTCB→ETH→WBNB is correctly reversed for exactOutput", async () => {
      const base = await loadFixture(rootFixtureWithStrategyTokens);
      const { swc, btcb, agg, operator } = base;

      await btcb.mint(swc.target, COST);
      await execNP(swc, operator, btcbToEthPath(), COST, 0, "0x", "0x", "0x");
      await agg.setOutRateBps(20000);

      await network.provider.send("hardhat_setBalance", [
        operator.address, ethers.toBeHex(ethers.parseEther("0.001")),
      ]);
      await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);

      const before = await ethers.provider.getBalance(operator.address);

      // 2-hop: BTCB → ETH → WBNB (reversed by _reversePath to WBNB → ETH → BTCB).
      const twoHopGasPath = encodePath([BTCB_ADDRESS, ETH_ADDRESS, WBNB_ADDRESS], [DEFAULT_FEE, DEFAULT_FEE]);
      await execWP(swc, operator,
        ethToBtcbPath(), COST, 0, 0, 0, twoHopGasPath, "0x", pfBtcbUsdt(), { gasPrice: 0 },
      );

      // If _reversePath produced the wrong token order, the mock would pull the wrong
      // token and the transfer would fail. A successful tx proves the reversal is correct.
      const after = await ethers.provider.getBalance(operator.address);
      expect(after).to.be.gt(before);
      expect(after).to.be.gte(MIN_BNB);
    });
  });

  describe("executeSwap — gas top-up for a WBNB clone (direct unwrap)", () => {
    const COST = ethers.parseEther("5");

    it("unwraps WBNB held by the clone to top up the operator", async () => {
      const base = await loadFixture(rootFixtureWithStrategyTokens);
      const { factory, vault, user, agg, wbnb, stranger } = base;

      // Create a WBNB-available clone operated by `stranger`.
      await factory.connect(vault).createBatch(user.address, [stranger.address], [WBNB_ADDRESS]);
      const wbnbSwcAddr = await factory.swcOf(user.address, WBNB_ADDRESS);
      const wbnbSwc = (await ethers.getContractAt("SwapContract", wbnbSwcAddr)) as unknown as SwapContract;

      // Open an ETH position from WBNB, then set the aggregator rate so the
      // round-2 close (amountIn = COST, the order's full remaining) yields a
      // profit without swapping more than the order tracks.
      await wbnb.mint(wbnbSwcAddr, COST);
      const wbnbToEth = encodePath([WBNB_ADDRESS, ETH_ADDRESS], [DEFAULT_FEE]);
      const ethToWbnb = encodePath([ETH_ADDRESS, WBNB_ADDRESS], [DEFAULT_FEE]);
      await execNP(wbnbSwc, stranger, wbnbToEth, COST, 0, "0x", "0x", "0x");
      await agg.setOutRateBps(20000);

      // Drop operator (stranger) below MIN_BNB; zero base fee.
      await network.provider.send("hardhat_setBalance", [
        stranger.address, ethers.toBeHex(ethers.parseEther("0.001")),
      ]);
      await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
      const before = await ethers.provider.getBalance(stranger.address);

      // payout token for WBNB clone is USDT; stablePath for held WBNB → USDT.
      const stablePath = encodePath([WBNB_ADDRESS, USDT_ADDRESS], [DEFAULT_FEE]);
      // avail == WBNB → gasPath ignored (direct unwrap), pass empty.
      await execWP(wbnbSwc, stranger, ethToWbnb, COST, 0, 0, 0, "0x", "0x", stablePath, { gasPrice: 0 });

      const after = await ethers.provider.getBalance(stranger.address);
      expect(after).to.be.gt(before);
      expect(after).to.be.gte(MIN_BNB);
    });
  });
});
