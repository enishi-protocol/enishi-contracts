import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { UniversalRouterGuardHarness } from "../../typechain-types";

// ─── Classic Universal Router command bytes (Commands.sol) ─────────────────────
const V3_SWAP_EXACT_IN = 0x00;
const V3_SWAP_EXACT_OUT = 0x01;
const V2_SWAP_EXACT_IN = 0x08;
const PERMIT2_TRANSFER_FROM = 0x02;
const SWEEP = 0x04;
const FLAG_ALLOW_REVERT = 0x80;

// Arbitrary addresses — `validate` is pure and never touches token contracts.
const TOKEN_IN = "0x1111111111111111111111111111111111111111";
const TOKEN_OUT = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const RECIPIENT = "0x4444444444444444444444444444444444444444";
const ATTACKER = "0x5555555555555555555555555555555555555555";

const abiCoder = ethers.AbiCoder.defaultAbiCoder();
const EXECUTE_3ARG = new ethers.Interface([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline)",
]);
const EXECUTE_2ARG = new ethers.Interface([
  "function execute(bytes commands, bytes[] inputs)",
]);

/** Packed V3 path: abi.encodePacked(token0, fee0, token1, fee1, …). */
function encodeV3Path(tokens: string[], fees: number[]): string {
  if (fees.length !== tokens.length - 1) {
    throw new Error(`encodeV3Path: fees.length (${fees.length}) != tokens.length-1 (${tokens.length - 1})`);
  }
  const types: string[] = ["address"];
  const values: unknown[] = [tokens[0]];
  for (let i = 0; i < fees.length; i++) {
    types.push("uint24", "address");
    values.push(fees[i], tokens[i + 1]);
  }
  return ethers.solidityPacked(types, values);
}

function v3Input(params: {
  recipient: string;
  amountIn?: bigint;
  amountOutMin?: bigint;
  path: string;
  payerIsUser?: boolean;
}): string {
  return abiCoder.encode(
    ["address", "uint256", "uint256", "bytes", "bool"],
    [params.recipient, params.amountIn ?? 1n, params.amountOutMin ?? 0n, params.path, params.payerIsUser ?? true],
  );
}

function v2Input(params: {
  recipient: string;
  amountIn?: bigint;
  amountOutMin?: bigint;
  path: string[];
  payerIsUser?: boolean;
}): string {
  return abiCoder.encode(
    ["address", "uint256", "uint256", "address[]", "bool"],
    [params.recipient, params.amountIn ?? 1n, params.amountOutMin ?? 0n, params.path, params.payerIsUser ?? true],
  );
}

/** Assemble `execute(commands, inputs, deadline)` calldata from command bytes. */
function execute3(commands: number[], inputs: string[], deadline = 2n ** 47n): string {
  const commandBytes = "0x" + commands.map((c) => c.toString(16).padStart(2, "0")).join("");
  return EXECUTE_3ARG.encodeFunctionData("execute", [commandBytes, inputs, deadline]);
}

function execute2(commands: number[], inputs: string[]): string {
  const commandBytes = "0x" + commands.map((c) => c.toString(16).padStart(2, "0")).join("");
  return EXECUTE_2ARG.encodeFunctionData("execute", [commandBytes, inputs]);
}

describe("UniversalRouterGuard", function () {
  async function deployFixture() {
    const Factory = await ethers.getContractFactory("UniversalRouterGuardHarness");
    const guard = (await Factory.deploy()) as unknown as UniversalRouterGuardHarness;
    return { guard };
  }

  // Shorthand: validate a one-command V3 swap against the standard whitelist.
  function callV3(guard: any, path: string, recipient = RECIPIENT) {
    return guard.validate(execute3([V3_SWAP_EXACT_IN], [v3Input({ recipient, path })]), RECIPIENT, TOKEN_IN, TOKEN_OUT);
  }

  describe("accepts", function () {
    it("a single-hop V3_SWAP_EXACT_IN of tokenIn → tokenOut to self", async function () {
      const { guard } = await loadFixture(deployFixture);
      await expect(callV3(guard, encodeV3Path([TOKEN_IN, TOKEN_OUT], [500]))).to.not.be.reverted;
    });

    it("a multi-hop V3 path (checks first and LAST token, ignores intermediates)", async function () {
      const { guard } = await loadFixture(deployFixture);
      const path = encodeV3Path([TOKEN_IN, OTHER, TOKEN_OUT], [500, 2500]);
      await expect(callV3(guard, path)).to.not.be.reverted;
    });

    it("a V2_SWAP_EXACT_IN of tokenIn → tokenOut to self", async function () {
      const { guard } = await loadFixture(deployFixture);
      const data = execute3([V2_SWAP_EXACT_IN], [v2Input({ recipient: RECIPIENT, path: [TOKEN_IN, TOKEN_OUT] })]);
      await expect(guard.validate(data, RECIPIENT, TOKEN_IN, TOKEN_OUT)).to.not.be.reverted;
    });

    it("masks off the ALLOW_REVERT flag bit before matching the command type", async function () {
      const { guard } = await loadFixture(deployFixture);
      const data = execute3(
        [V3_SWAP_EXACT_IN | FLAG_ALLOW_REVERT],
        [v3Input({ recipient: RECIPIENT, path: encodeV3Path([TOKEN_IN, TOKEN_OUT], [500]) })],
      );
      await expect(guard.validate(data, RECIPIENT, TOKEN_IN, TOKEN_OUT)).to.not.be.reverted;
    });

    it("the 2-arg execute(commands, inputs) overload", async function () {
      const { guard } = await loadFixture(deployFixture);
      const data = execute2([V3_SWAP_EXACT_IN], [v3Input({ recipient: RECIPIENT, path: encodeV3Path([TOKEN_IN, TOKEN_OUT], [500]) })]);
      await expect(guard.validate(data, RECIPIENT, TOKEN_IN, TOKEN_OUT)).to.not.be.reverted;
    });

    it("a split-route batch where every command is tokenIn → tokenOut to self", async function () {
      const { guard } = await loadFixture(deployFixture);
      const data = execute3(
        [V3_SWAP_EXACT_IN, V2_SWAP_EXACT_IN],
        [
          v3Input({ recipient: RECIPIENT, path: encodeV3Path([TOKEN_IN, TOKEN_OUT], [500]) }),
          v2Input({ recipient: RECIPIENT, path: [TOKEN_IN, TOKEN_OUT] }),
        ],
      );
      await expect(guard.validate(data, RECIPIENT, TOKEN_IN, TOKEN_OUT)).to.not.be.reverted;
    });
  });

  describe("rejects", function () {
    it("an unsupported command (SWEEP)", async function () {
      const { guard } = await loadFixture(deployFixture);
      const input = abiCoder.encode(["address", "address", "uint256"], [TOKEN_OUT, ATTACKER, 0]);
      await expect(guard.validate(execute3([SWEEP], [input]), RECIPIENT, TOKEN_IN, TOKEN_OUT))
        .to.be.revertedWithCustomError(guard, "UnsupportedCommand")
        .withArgs(SWEEP);
    });

    it("PERMIT2_TRANSFER_FROM (fund-moving command bypassing any swap)", async function () {
      const { guard } = await loadFixture(deployFixture);
      const input = abiCoder.encode(["address", "address", "uint160"], [TOKEN_OUT, ATTACKER, 1n]);
      await expect(guard.validate(execute3([PERMIT2_TRANSFER_FROM], [input]), RECIPIENT, TOKEN_IN, TOKEN_OUT))
        .to.be.revertedWithCustomError(guard, "UnsupportedCommand")
        .withArgs(PERMIT2_TRANSFER_FROM);
    });

    it("an exact-OUT swap command (only exact-in is whitelisted)", async function () {
      const { guard } = await loadFixture(deployFixture);
      const input = v3Input({ recipient: RECIPIENT, path: encodeV3Path([TOKEN_IN, TOKEN_OUT], [500]) });
      await expect(guard.validate(execute3([V3_SWAP_EXACT_OUT], [input]), RECIPIENT, TOKEN_IN, TOKEN_OUT))
        .to.be.revertedWithCustomError(guard, "UnsupportedCommand")
        .withArgs(V3_SWAP_EXACT_OUT);
    });

    it("a recipient that is not the calling contract", async function () {
      const { guard } = await loadFixture(deployFixture);
      const data = execute3([V3_SWAP_EXACT_IN], [v3Input({ recipient: ATTACKER, path: encodeV3Path([TOKEN_IN, TOKEN_OUT], [500]) })]);
      await expect(guard.validate(data, RECIPIENT, TOKEN_IN, TOKEN_OUT))
        .to.be.revertedWithCustomError(guard, "InvalidIntermediateRecipient")
        .withArgs(ATTACKER);
    });

    it("a path whose last token is not tokenOut", async function () {
      const { guard } = await loadFixture(deployFixture);
      const data = execute3([V3_SWAP_EXACT_IN], [v3Input({ recipient: RECIPIENT, path: encodeV3Path([TOKEN_IN, OTHER], [500]) })]);
      await expect(guard.validate(data, RECIPIENT, TOKEN_IN, TOKEN_OUT))
        .to.be.revertedWithCustomError(guard, "UnexpectedTokenOut")
        .withArgs(OTHER);
    });

    it("a path whose first token is not tokenIn", async function () {
      const { guard } = await loadFixture(deployFixture);
      const data = execute3([V3_SWAP_EXACT_IN], [v3Input({ recipient: RECIPIENT, path: encodeV3Path([OTHER, TOKEN_OUT], [500]) })]);
      await expect(guard.validate(data, RECIPIENT, TOKEN_IN, TOKEN_OUT))
        .to.be.revertedWithCustomError(guard, "BrokenChain")
        .withArgs(TOKEN_IN, OTHER);
    });

    it("a V2 path shorter than 2 tokens", async function () {
      const { guard } = await loadFixture(deployFixture);
      const data = execute3([V2_SWAP_EXACT_IN], [v2Input({ recipient: RECIPIENT, path: [TOKEN_IN] })]);
      await expect(guard.validate(data, RECIPIENT, TOKEN_IN, TOKEN_OUT)).to.be.revertedWithCustomError(guard, "InvalidV2Path");
    });

    it("a malformed V3 path length", async function () {
      const { guard } = await loadFixture(deployFixture);
      // 21 bytes: not 20 + n*23.
      const badPath = "0x" + "11".repeat(21);
      const data = execute3([V3_SWAP_EXACT_IN], [v3Input({ recipient: RECIPIENT, path: badPath })]);
      await expect(guard.validate(data, RECIPIENT, TOKEN_IN, TOKEN_OUT)).to.be.revertedWithCustomError(guard, "InvalidV3Path");
    });

    it("the whole batch if ANY command fails the whitelist (split-route)", async function () {
      const { guard } = await loadFixture(deployFixture);
      const data = execute3(
        [V3_SWAP_EXACT_IN, V3_SWAP_EXACT_IN],
        [
          v3Input({ recipient: RECIPIENT, path: encodeV3Path([TOKEN_IN, TOKEN_OUT], [500]) }),
          v3Input({ recipient: RECIPIENT, path: encodeV3Path([TOKEN_IN, OTHER], [500]) }),
        ],
      );
      await expect(guard.validate(data, RECIPIENT, TOKEN_IN, TOKEN_OUT))
        .to.be.revertedWithCustomError(guard, "UnexpectedTokenOut")
        .withArgs(OTHER);
    });

    it("empty commands", async function () {
      const { guard } = await loadFixture(deployFixture);
      await expect(guard.validate(execute3([], []), RECIPIENT, TOKEN_IN, TOKEN_OUT)).to.be.revertedWithCustomError(
        guard,
        "EmptyCommands",
      );
    });

    it("a commands/inputs length mismatch", async function () {
      const { guard } = await loadFixture(deployFixture);
      const data = execute3(
        [V3_SWAP_EXACT_IN, V3_SWAP_EXACT_IN],
        [v3Input({ recipient: RECIPIENT, path: encodeV3Path([TOKEN_IN, TOKEN_OUT], [500]) })],
      );
      await expect(guard.validate(data, RECIPIENT, TOKEN_IN, TOKEN_OUT)).to.be.revertedWithCustomError(
        guard,
        "CommandsInputsLengthMismatch",
      );
    });

    it("calldata whose selector is not an execute() overload", async function () {
      const { guard } = await loadFixture(deployFixture);
      const notExecute = new ethers.Interface(["function swap(uint256 x)"]).encodeFunctionData("swap", [1]);
      await expect(guard.validate(notExecute, RECIPIENT, TOKEN_IN, TOKEN_OUT)).to.be.revertedWithCustomError(
        guard,
        "InvalidExecuteSelector",
      );
    });

    it("calldata too short to hold a selector", async function () {
      const { guard } = await loadFixture(deployFixture);
      await expect(guard.validate("0x1234", RECIPIENT, TOKEN_IN, TOKEN_OUT)).to.be.revertedWithCustomError(
        guard,
        "InvalidExecuteSelector",
      );
    });
  });
});
