import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

// ─── Classic Universal Router command bytes (Commands.sol) ─────────────────────
const V3_SWAP_EXACT_IN = 0x00;
const V3_SWAP_EXACT_OUT = 0x01;
const PERMIT2_TRANSFER_FROM = 0x02;
const SWEEP = 0x04;
const TRANSFER = 0x05;
const PAY_PORTION = 0x06;
const V2_SWAP_EXACT_IN = 0x08;
const V2_SWAP_EXACT_OUT = 0x09;
const FLAG_ALLOW_REVERT = 0x80;

// Universal Router recipient sentinel (Constants.MSG_SENDER).
const MSG_SENDER_SENTINEL = "0x0000000000000000000000000000000000000001";

const ONE = ethers.parseEther("1");
const HUNDRED = ethers.parseEther("100");
const abi = ethers.AbiCoder.defaultAbiCoder();
const EXEC3 = new ethers.Interface([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline)",
]);

// ─── Calldata builders (mirror what universal-router-sdk emits) ────────────────
function commandBytes(bytes: number[]): string {
  return "0x" + bytes.map((b) => (b & 0xff).toString(16).padStart(2, "0")).join("");
}

function execute3(commands: number[], inputs: string[], deadline = 2n ** 47n): string {
  return EXEC3.encodeFunctionData("execute", [commandBytes(commands), inputs, deadline]);
}

function v3Path(tokens: string[], fees: number[]): string {
  const types: string[] = ["address"];
  const values: unknown[] = [tokens[0]];
  for (let i = 0; i < fees.length; i++) {
    types.push("uint24", "address");
    values.push(fees[i], tokens[i + 1]);
  }
  return ethers.solidityPacked(types, values);
}

function v3In(p: { recipient: string; path: string; amountIn?: bigint; minOut?: bigint }): string {
  return abi.encode(
    ["address", "uint256", "uint256", "bytes", "bool"],
    [p.recipient, p.amountIn ?? HUNDRED, p.minOut ?? 0n, p.path, true],
  );
}

function v2In(p: { recipient: string; path: string[]; amountIn?: bigint; minOut?: bigint }): string {
  return abi.encode(
    ["address", "uint256", "uint256", "address[]", "bool"],
    [p.recipient, p.amountIn ?? HUNDRED, p.minOut ?? 0n, p.path, true],
  );
}

// PERMIT2_TRANSFER_FROM / TRANSFER / SWEEP / PAY_PORTION share the 3-word shape.
function fundMove(token: string, recipient: string, amount: bigint, amountType = "uint256"): string {
  return abi.encode(["address", "address", amountType], [token, recipient, amount]);
}

describe("UniversalRouterGuard ⇄ FaithfulUniversalRouter (differential)", function () {
  async function fixture() {
    const [deployer, attacker] = await ethers.getSigners();

    const ERC20 = await ethers.getContractFactory("MockERC20");
    const tokenIn = await ERC20.deploy("USDT", "USDT", 18);
    const tokenOut = await ERC20.deploy("XRP", "XRP", 18);

    const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    const router = await (
      await ethers.getContractFactory("FaithfulUniversalRouter")
    ).deploy(await permit2.getAddress());
    const vault = await (
      await ethers.getContractFactory("MockGuardedVault")
    ).deploy(await router.getAddress(), await permit2.getAddress());
    const guard = await (await ethers.getContractFactory("UniversalRouterGuardHarness")).deploy();

    const tokenInAddr = await tokenIn.getAddress();
    const tokenOutAddr = await tokenOut.getAddress();
    const vaultAddr = await vault.getAddress();
    const routerAddr = await router.getAddress();

    const VAULT_BAL = ethers.parseEther("1000");
    const ROUTER_OUT = ethers.parseEther("1000");
    await tokenIn.mint(vaultAddr, VAULT_BAL); // vault funds the swaps
    await tokenOut.mint(routerAddr, ROUTER_OUT); // router pays tokenOut out of its balance
    await vault.arm(tokenInAddr); // standing max Permit2 allowance, like the real Vault

    return {
      deployer, attacker, tokenIn, tokenOut, permit2, router, vault, guard,
      tokenInAddr, tokenOutAddr, vaultAddr, routerAddr, VAULT_BAL, ROUTER_OUT,
    };
  }

  // ── Fund-moving commands: the guard must reject them, and forwarding them raw
  //    must actually move funds (otherwise the guard's rejection proves nothing).
  describe("fund-moving commands are blocked by the guard", function () {
    it("PERMIT2_TRANSFER_FROM: raw it drains the vault; the guard rejects it", async function () {
      const f = await loadFixture(fixture);
      const evil = execute3(
        [PERMIT2_TRANSFER_FROM],
        [fundMove(f.tokenInAddr, f.attacker.address, f.VAULT_BAL, "uint160")],
      );

      // Guard rejects (pure decode).
      await expect(f.guard.validate(evil, f.vaultAddr, f.tokenInAddr, f.tokenOutAddr))
        .to.be.revertedWithCustomError(f.guard, "UnsupportedCommand")
        .withArgs(PERMIT2_TRANSFER_FROM);

      // Guarded forward reverts and moves nothing.
      await expect(f.vault.guardedExecute(evil, f.tokenInAddr, f.tokenOutAddr)).to.be.reverted;
      expect(await f.tokenIn.balanceOf(f.attacker.address)).to.equal(0n);
      expect(await f.tokenIn.balanceOf(f.vaultAddr)).to.equal(f.VAULT_BAL);

      // But raw (pre-guard hole) it steals the vault's whole tokenIn balance.
      await f.vault.unsafeExecute(evil);
      expect(await f.tokenIn.balanceOf(f.attacker.address)).to.equal(f.VAULT_BAL);
    });

    it("SWEEP: raw it empties the router to the attacker; the guard rejects it", async function () {
      const f = await loadFixture(fixture);
      const evil = execute3([SWEEP], [fundMove(f.tokenOutAddr, f.attacker.address, 0n)]);

      await expect(f.guard.validate(evil, f.vaultAddr, f.tokenInAddr, f.tokenOutAddr))
        .to.be.revertedWithCustomError(f.guard, "UnsupportedCommand")
        .withArgs(SWEEP);

      await f.vault.unsafeExecute(evil);
      expect(await f.tokenOut.balanceOf(f.attacker.address)).to.equal(f.ROUTER_OUT);
    });

    it("TRANSFER: raw it pays the attacker; the guard rejects it", async function () {
      const f = await loadFixture(fixture);
      const evil = execute3([TRANSFER], [fundMove(f.tokenOutAddr, f.attacker.address, HUNDRED)]);

      await expect(f.guard.validate(evil, f.vaultAddr, f.tokenInAddr, f.tokenOutAddr))
        .to.be.revertedWithCustomError(f.guard, "UnsupportedCommand")
        .withArgs(TRANSFER);

      await f.vault.unsafeExecute(evil);
      expect(await f.tokenOut.balanceOf(f.attacker.address)).to.equal(HUNDRED);
    });

    it("PAY_PORTION: raw it siphons a % to the attacker; the guard rejects it", async function () {
      const f = await loadFixture(fixture);
      const evil = execute3([PAY_PORTION], [fundMove(f.tokenOutAddr, f.attacker.address, 5000n)]); // 50%

      await expect(f.guard.validate(evil, f.vaultAddr, f.tokenInAddr, f.tokenOutAddr))
        .to.be.revertedWithCustomError(f.guard, "UnsupportedCommand")
        .withArgs(PAY_PORTION);

      await f.vault.unsafeExecute(evil);
      expect(await f.tokenOut.balanceOf(f.attacker.address)).to.equal(f.ROUTER_OUT / 2n);
    });

    it("*_EXACT_OUT swaps are rejected (only exact-in is whitelisted)", async function () {
      const f = await loadFixture(fixture);
      const outV3 = execute3(
        [V3_SWAP_EXACT_OUT],
        [v3In({ recipient: f.vaultAddr, path: v3Path([f.tokenOutAddr, f.tokenInAddr], [500]) })],
      );
      await expect(f.guard.validate(outV3, f.vaultAddr, f.tokenInAddr, f.tokenOutAddr))
        .to.be.revertedWithCustomError(f.guard, "UnsupportedCommand")
        .withArgs(V3_SWAP_EXACT_OUT);

      const outV2 = execute3(
        [V2_SWAP_EXACT_OUT],
        [v2In({ recipient: f.vaultAddr, path: [f.tokenInAddr, f.tokenOutAddr] })],
      );
      await expect(f.guard.validate(outV2, f.vaultAddr, f.tokenInAddr, f.tokenOutAddr))
        .to.be.revertedWithCustomError(f.guard, "UnsupportedCommand")
        .withArgs(V2_SWAP_EXACT_OUT);
    });

    it("a batch hiding a PERMIT2_TRANSFER_FROM behind a valid swap is rejected wholesale", async function () {
      const f = await loadFixture(fixture);
      const batch = execute3(
        [V3_SWAP_EXACT_IN, PERMIT2_TRANSFER_FROM],
        [
          v3In({ recipient: f.vaultAddr, path: v3Path([f.tokenInAddr, f.tokenOutAddr], [500]) }),
          fundMove(f.tokenInAddr, f.attacker.address, ethers.parseEther("500"), "uint160"),
        ],
      );

      await expect(f.guard.validate(batch, f.vaultAddr, f.tokenInAddr, f.tokenOutAddr))
        .to.be.revertedWithCustomError(f.guard, "UnsupportedCommand")
        .withArgs(PERMIT2_TRANSFER_FROM);

      // Raw, the swap runs AND the attacker is paid — the batch smuggles the drain.
      await f.vault.unsafeExecute(batch);
      expect(await f.tokenIn.balanceOf(f.attacker.address)).to.equal(ethers.parseEther("500"));
    });
  });

  // ── Recipient / token checks are load-bearing: without them the router would
  //    debit the vault while sending tokenOut somewhere else.
  describe("recipient & token checks", function () {
    it("rejects a swap whose recipient is the attacker; raw, the router pays the attacker", async function () {
      const f = await loadFixture(fixture);
      const evil = execute3(
        [V3_SWAP_EXACT_IN],
        [v3In({ recipient: f.attacker.address, path: v3Path([f.tokenInAddr, f.tokenOutAddr], [500]) })],
      );

      await expect(f.guard.validate(evil, f.vaultAddr, f.tokenInAddr, f.tokenOutAddr))
        .to.be.revertedWithCustomError(f.guard, "InvalidIntermediateRecipient")
        .withArgs(f.attacker.address);

      await f.vault.unsafeExecute(evil);
      expect(await f.tokenOut.balanceOf(f.attacker.address)).to.equal(HUNDRED);
      expect(await f.tokenIn.balanceOf(f.vaultAddr)).to.equal(f.VAULT_BAL - HUNDRED);
    });

    it("rejects a swap whose last token is not tokenOut", async function () {
      const f = await loadFixture(fixture);
      const evil = execute3(
        [V3_SWAP_EXACT_IN],
        [v3In({ recipient: f.vaultAddr, path: v3Path([f.tokenInAddr, f.attacker.address], [500]) })],
      );
      await expect(f.guard.validate(evil, f.vaultAddr, f.tokenInAddr, f.tokenOutAddr))
        .to.be.revertedWithCustomError(f.guard, "UnexpectedTokenOut")
        .withArgs(f.attacker.address);
    });
  });

  // ── Consistency: what the guard accepts, the router executes as a clean
  //    tokenIn → tokenOut swap delivered to the vault.
  describe("accepted calldata executes as a clean self-swap", function () {
    it("V3_SWAP_EXACT_IN: vault spends amountIn, receives tokenOut", async function () {
      const f = await loadFixture(fixture);
      const swap = execute3(
        [V3_SWAP_EXACT_IN],
        [v3In({ recipient: f.vaultAddr, path: v3Path([f.tokenInAddr, f.tokenOutAddr], [500]) })],
      );
      await expect(f.guard.validate(swap, f.vaultAddr, f.tokenInAddr, f.tokenOutAddr)).to.not.be.reverted;

      await f.vault.guardedExecute(swap, f.tokenInAddr, f.tokenOutAddr);
      expect(await f.tokenIn.balanceOf(f.vaultAddr)).to.equal(f.VAULT_BAL - HUNDRED);
      expect(await f.tokenOut.balanceOf(f.vaultAddr)).to.equal(HUNDRED); // 1:1 default rate
      expect(await f.tokenOut.balanceOf(f.attacker.address)).to.equal(0n);
    });

    it("V2_SWAP_EXACT_IN with the ALLOW_REVERT flag: masked off, still a self-swap", async function () {
      const f = await loadFixture(fixture);
      const swap = execute3(
        [V2_SWAP_EXACT_IN | FLAG_ALLOW_REVERT],
        [v2In({ recipient: f.vaultAddr, path: [f.tokenInAddr, f.tokenOutAddr] })],
      );
      await expect(f.guard.validate(swap, f.vaultAddr, f.tokenInAddr, f.tokenOutAddr)).to.not.be.reverted;

      await f.vault.guardedExecute(swap, f.tokenInAddr, f.tokenOutAddr);
      expect(await f.tokenOut.balanceOf(f.vaultAddr)).to.equal(HUNDRED);
    });
  });

  // ── The MSG_SENDER sentinel: the real router maps it to the caller (the
  //    vault), so it is a LEGITIMATE way to deliver tokenOut back to the vault.
  //    The current guard rejects it because it requires the literal address.
  //    This pins that behaviour: if the operator's SDK ever emits the sentinel
  //    (split/fee routes, or a different SDK config) the guard will reject a
  //    swap the router would have executed correctly — verify the calldata
  //    source always encodes the literal recipient, or teach the guard to
  //    accept address(1)=MSG_SENDER (but NOT address(2)=ADDRESS_THIS).
  describe("MSG_SENDER sentinel handling (documented assumption)", function () {
    it("the router maps address(1) to the vault, but the guard rejects it", async function () {
      const f = await loadFixture(fixture);
      const swap = execute3(
        [V3_SWAP_EXACT_IN],
        [v3In({ recipient: MSG_SENDER_SENTINEL, path: v3Path([f.tokenInAddr, f.tokenOutAddr], [500]) })],
      );

      // Router side: the sentinel resolves to msg.sender (the vault) → correct delivery.
      const before = await f.tokenOut.balanceOf(f.vaultAddr);
      await f.vault.unsafeExecute(swap);
      expect(await f.tokenOut.balanceOf(f.vaultAddr)).to.equal(before + HUNDRED);

      // Guard side: same calldata is rejected as an invalid recipient.
      await expect(f.guard.validate(swap, f.vaultAddr, f.tokenInAddr, f.tokenOutAddr))
        .to.be.revertedWithCustomError(f.guard, "InvalidIntermediateRecipient")
        .withArgs(MSG_SENDER_SENTINEL);
    });
  });
});
