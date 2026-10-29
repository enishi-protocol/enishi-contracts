import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  SwapContractFactory,
  SwapContract,
  MockERC20,
} from "../../typechain-types";

const ZERO = ethers.ZeroAddress;

describe("SwapContractFactory", () => {
  let factory: SwapContractFactory;
  let owner: SignerWithAddress;
  let vault: SignerWithAddress;
  let stranger: SignerWithAddress;
  let user: SignerWithAddress;
  let op1: SignerWithAddress;
  let op2: SignerWithAddress;
  let op3: SignerWithAddress;
  let btcb: MockERC20;
  let weth: MockERC20;
  let wxrp: MockERC20;

  beforeEach(async () => {
    [owner, vault, stranger, user, op1, op2, op3] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    btcb = (await Token.deploy("BTCB", "BTCB", 18)) as unknown as MockERC20;
    weth = (await Token.deploy("WETH", "WETH", 18)) as unknown as MockERC20;
    wxrp = (await Token.deploy("WXRP", "WXRP", 18)) as unknown as MockERC20;

    const Factory = await ethers.getContractFactory("SwapContractFactory");
    factory = (await Factory.connect(owner).deploy()) as unknown as SwapContractFactory;
    await factory.waitForDeployment();
    await factory.connect(owner).setVault(vault.address);
  });

  // ─── Deployment ───────────────────────────────────────────────────────────

  describe("Deployment", () => {
    it("sets owner to deployer and deploys an implementation with code", async () => {
      expect(await factory.owner()).to.equal(owner.address);
      const impl = await factory.IMPLEMENTATION();
      expect(impl).to.not.equal(ZERO);
      expect(await ethers.provider.getCode(impl)).to.not.equal("0x");
    });

    it("swcOfOperator returns zero for unassigned operator", async () => {
      expect(await factory.swcOfOperator(stranger.address)).to.equal(ZERO);
    });

    it("freshly deployed factory has no vault", async () => {
      const fresh = (await (
        await ethers.getContractFactory("SwapContractFactory")
      ).deploy()) as unknown as SwapContractFactory;
      expect(await fresh.vault()).to.equal(ZERO);
    });

    it("locks the implementation against direct initialize", async () => {
      const impl = await factory.IMPLEMENTATION();
      const swc = (await ethers.getContractAt(
        "SwapContract",
        impl,
      )) as unknown as SwapContract;
      await expect(
        swc.initialize(op1.address),
      ).to.be.revertedWithCustomError(swc, "InvalidInitialization");
    });
  });

  // ─── setVault ─────────────────────────────────────────────────────────────

  describe("setVault", () => {
    it("owner can rotate vault and emits VaultUpdated", async () => {
      await expect(factory.connect(owner).setVault(stranger.address))
        .to.emit(factory, "VaultUpdated")
        .withArgs(vault.address, stranger.address);
      expect(await factory.vault()).to.equal(stranger.address);
    });

    it("reverts when caller is not owner", async () => {
      await expect(
        factory.connect(stranger).setVault(stranger.address),
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    });

    it("reverts on zero address", async () => {
      await expect(
        factory.connect(owner).setVault(ZERO),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  // ─── createBatch ──────────────────────────────────────────────────────────

  describe("createBatch", () => {
    let opAddrs: string[];
    let tokenAddrs: string[];

    beforeEach(async () => {
      opAddrs = [op1.address, op2.address, op3.address];
      tokenAddrs = [
        await btcb.getAddress(),
        await weth.getAddress(),
        await wxrp.getAddress(),
      ];
    });

    it("reverts when caller is not vault", async () => {
      await expect(
        factory.connect(stranger).createBatch(user.address, opAddrs, tokenAddrs),
      ).to.be.revertedWithCustomError(factory, "NotVault");
    });

    it("reverts when user is zero", async () => {
      await expect(
        factory.connect(vault).createBatch(ZERO, opAddrs, tokenAddrs),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("reverts on empty input", async () => {
      await expect(
        factory.connect(vault).createBatch(user.address, [], []),
      ).to.be.revertedWithCustomError(factory, "EmptyInput");
    });

    it("reverts on length mismatch", async () => {
      await expect(
        factory
          .connect(vault)
          .createBatch(user.address, opAddrs, tokenAddrs.slice(0, 2)),
      ).to.be.revertedWithCustomError(factory, "LengthMismatch");
    });

    it("reverts when an operator is zero", async () => {
      const ops = [op1.address, ZERO, op3.address];
      await expect(
        factory.connect(vault).createBatch(user.address, ops, tokenAddrs),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("reverts when an available token is zero", async () => {
      const toks = [await btcb.getAddress(), ZERO, await wxrp.getAddress()];
      await expect(
        factory.connect(vault).createBatch(user.address, opAddrs, toks),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("creates clones, populates mappings and emits events", async () => {
      const tx = await factory
        .connect(vault)
        .createBatch(user.address, opAddrs, tokenAddrs);
      const receipt = await tx.wait();

      // 3 SwapContractCreated events.
      const events = receipt!.logs
        .map((l) => {
          try {
            return factory.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .filter((e): e is NonNullable<typeof e> => e?.name === "SwapContractCreated");
      expect(events).to.have.lengthOf(3);

      for (let i = 0; i < 3; i++) {
        const clone = events[i].args.swc as string;
        expect(events[i].args.user).to.equal(user.address);
        expect(events[i].args.availableTokenAddress).to.equal(tokenAddrs[i]);
        expect(events[i].args.operator).to.equal(opAddrs[i]);

        expect(await factory.swcOf(user.address, tokenAddrs[i])).to.equal(clone);
        expect(await factory.swcOfOperator(opAddrs[i])).to.equal(clone);

        const swc = (await ethers.getContractAt(
          "SwapContract",
          clone,
        )) as unknown as SwapContract;
        expect(await swc.operator()).to.equal(opAddrs[i]);
        expect(await swc.vault()).to.equal(vault.address);
        expect(await swc.availableTokenAddress()).to.equal(tokenAddrs[i]);
      }

    });

    it("reverts on duplicate (user, availableToken) within the batch", async () => {
      const dupTokens = [tokenAddrs[0], tokenAddrs[1], tokenAddrs[0]];
      // Use distinct operators so the trigger is the token duplicate.
      await expect(
        factory.connect(vault).createBatch(user.address, opAddrs, dupTokens),
      ).to.be.revertedWithCustomError(factory, "AlreadyCreated");
    });

    it("reverts on duplicate operator within the batch", async () => {
      const dupOps = [op1.address, op2.address, op1.address];
      await expect(
        factory.connect(vault).createBatch(user.address, dupOps, tokenAddrs),
      ).to.be.revertedWithCustomError(factory, "OperatorAlreadyAssigned");
    });

    it("reverts when re-creating an existing (user, availableToken) across calls", async () => {
      await factory
        .connect(vault)
        .createBatch(user.address, [op1.address], [tokenAddrs[0]]);
      await expect(
        factory
          .connect(vault)
          .createBatch(user.address, [op2.address], [tokenAddrs[0]]),
      ).to.be.revertedWithCustomError(factory, "AlreadyCreated");
    });

    it("reverts when re-using an operator across calls", async () => {
      await factory
        .connect(vault)
        .createBatch(user.address, [op1.address], [tokenAddrs[0]]);
      await expect(
        factory
          .connect(vault)
          .createBatch(stranger.address, [op1.address], [tokenAddrs[1]]),
      ).to.be.revertedWithCustomError(factory, "OperatorAlreadyAssigned");
    });
  });

  // ─── createDeterministic ──────────────────────────────────────────────────

  describe("createDeterministic", () => {
    const salt = ethers.id("salt-1");

    it("reverts when caller is not vault", async () => {
      await expect(
        factory
          .connect(stranger)
          .createDeterministic(
            user.address,
            op1.address,
            await btcb.getAddress(),
            salt,
          ),
      ).to.be.revertedWithCustomError(factory, "NotVault");
    });

    it("reverts when user is zero", async () => {
      await expect(
        factory
          .connect(vault)
          .createDeterministic(ZERO, op1.address, await btcb.getAddress(), salt),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("reverts on zero operator / zero available token", async () => {
      await expect(
        factory
          .connect(vault)
          .createDeterministic(user.address, ZERO, await btcb.getAddress(), salt),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(
        factory
          .connect(vault)
          .createDeterministic(user.address, op1.address, ZERO, salt),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("deploys at the address predicted by predictAddress", async () => {
      const predicted = await factory.predictAddress(
        user.address,
        await btcb.getAddress(),
        salt,
      );
      const tx = await factory
        .connect(vault)
        .createDeterministic(
          user.address,
          op1.address,
          await btcb.getAddress(),
          salt,
        );
      const receipt = await tx.wait();
      const event = receipt!.logs
        .map((l) => {
          try {
            return factory.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e?.name === "SwapContractCreated");
      expect(event!.args.swc).to.equal(predicted);

      expect(
        await factory.swcOf(user.address, await btcb.getAddress()),
      ).to.equal(predicted);
      expect(await factory.swcOfOperator(op1.address)).to.equal(predicted);
    });

    it("reverts on duplicate (user, availableToken)", async () => {
      await factory
        .connect(vault)
        .createDeterministic(
          user.address,
          op1.address,
          await btcb.getAddress(),
          salt,
        );
      await expect(
        factory
          .connect(vault)
          .createDeterministic(
            user.address,
            op2.address,
            await btcb.getAddress(),
            ethers.id("different-salt"),
          ),
      ).to.be.revertedWithCustomError(factory, "AlreadyCreated");
    });

    it("reverts when re-using operator across calls", async () => {
      await factory
        .connect(vault)
        .createDeterministic(
          user.address,
          op1.address,
          await btcb.getAddress(),
          salt,
        );
      await expect(
        factory
          .connect(vault)
          .createDeterministic(
            stranger.address,
            op1.address,
            await weth.getAddress(),
            ethers.id("different-salt"),
          ),
      ).to.be.revertedWithCustomError(factory, "OperatorAlreadyAssigned");
    });

    it("same salt + different args → different address (no collision)", async () => {
      await factory
        .connect(vault)
        .createDeterministic(
          user.address,
          op1.address,
          await btcb.getAddress(),
          salt,
        );
      // The clone embeds (vault, availableToken, user) as immutable args, so the
      // CREATE2 address depends on them — the same salt no longer collides for
      // different args. (Duplicate (user, token) is still caught by AlreadyCreated.)
      await expect(
        factory
          .connect(vault)
          .createDeterministic(
            stranger.address,
            op2.address,
            await weth.getAddress(),
            salt,
          ),
      ).to.not.be.reverted;
    });
  });
});
