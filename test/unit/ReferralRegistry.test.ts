import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ReferralRegistry } from "../../typechain-types";

describe("ReferralRegistry", () => {
  async function deploy() {
    const [owner, operator, root, userA, userB, stranger] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ReferralRegistry");
    const registry = (await Factory.connect(owner).deploy(
      root.address,
    )) as unknown as ReferralRegistry;
    await registry.waitForDeployment();
    // The constructor grants no OPERATOR_ROLE — wiring does, as it does on chain.
    await registry.connect(owner).grantRole(await registry.OPERATOR_ROLE(), operator.address);
    return { registry, owner, operator, root, userA, userB, stranger };
  }

  // ─── Deployment ──────────────────────────────────────────────────────────────

  describe("Deployment", () => {
    it("makes the deployer admin, the granted operator an operator, and root a referrer", async () => {
      const { registry, owner, operator, root } = await loadFixture(deploy);
      expect(await registry.hasRole(await registry.DEFAULT_ADMIN_ROLE(), owner.address)).to.be.true;
      expect(await registry.hasRole(await registry.OPERATOR_ROLE(), operator.address)).to.be.true;
      expect(await registry.isOperator(operator.address)).to.be.true;
      expect(await registry.isReferrer(root.address)).to.be.true;
      expect(await registry.parentOf(root.address)).to.equal(ethers.ZeroAddress);
    });

    it("emits Registered for root on deploy", async () => {
      const { owner, operator, root } = await loadFixture(deploy);
      const Factory = await ethers.getContractFactory("ReferralRegistry");
      const contract = await Factory.connect(owner).deploy(root.address);
      await expect(contract.deploymentTransaction())
        .to.emit(contract, "Registered")
        .withArgs(root.address, ethers.ZeroAddress);
    });

    it("reverts if root is zero address", async () => {
      const { registry, operator } = await loadFixture(deploy);
      const Factory = await ethers.getContractFactory("ReferralRegistry");
      await expect(Factory.deploy(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("grants no OPERATOR_ROLE at construction — not even to the deployer", async () => {
      const [owner, , root, userA] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("ReferralRegistry");
      const fresh = await Factory.connect(owner).deploy(root.address);
      await fresh.waitForDeployment();

      const ROLE = await fresh.OPERATOR_ROLE();
      expect(await fresh.hasRole(ROLE, owner.address)).to.be.false;
      expect(await fresh.isOperator(owner.address)).to.be.false;

      await expect(fresh.connect(owner).registerWithReferrer(userA.address, root.address))
        .to.be.revertedWithCustomError(fresh, "AccessControlUnauthorizedAccount")
        .withArgs(owner.address, ROLE);
    });
  });

  // ─── registerWithReferrer ────────────────────────────────────────────────────

  describe("registerWithReferrer", () => {
    it("operator registers user under root", async () => {
      const { registry, operator, root, userA } = await loadFixture(deploy);
      await expect(registry.connect(operator).registerWithReferrer(userA.address, root.address))
        .to.emit(registry, "Registered")
        .withArgs(userA.address, root.address);

      expect(await registry.isReferrer(userA.address)).to.be.true;
      expect(await registry.parentOf(userA.address)).to.equal(root.address);
    });

    it("can chain: userB registers under userA", async () => {
      const { registry, operator, root, userA, userB } = await loadFixture(deploy);
      await registry.connect(operator).registerWithReferrer(userA.address, root.address);
      await registry.connect(operator).registerWithReferrer(userB.address, userA.address);

      expect(await registry.isReferrer(userB.address)).to.be.true;
      expect(await registry.parentOf(userB.address)).to.equal(userA.address);
    });

    it("reverts on self referral", async () => {
      const { registry, operator, userA } = await loadFixture(deploy);
      await expect(registry.connect(operator).registerWithReferrer(userA.address, userA.address))
        .to.be.revertedWithCustomError(registry, "SelfReferral");
    });

    it("reverts if user already registered (parentOf set)", async () => {
      const { registry, operator, root, userA } = await loadFixture(deploy);
      await registry.connect(operator).registerWithReferrer(userA.address, root.address);
      await expect(registry.connect(operator).registerWithReferrer(userA.address, root.address))
        .to.be.revertedWithCustomError(registry, "ParentAlreadySet");
    });

    it("reverts if user is already an approved referrer (root case)", async () => {
      const { registry, operator, root, userA } = await loadFixture(deploy);
      await expect(registry.connect(operator).registerWithReferrer(root.address, userA.address))
        .to.be.revertedWithCustomError(registry, "AlreadyReferrer");
    });

    it("reverts if referrer is not approved", async () => {
      const { registry, operator, userA, stranger } = await loadFixture(deploy);
      await expect(registry.connect(operator).registerWithReferrer(userA.address, stranger.address))
        .to.be.revertedWithCustomError(registry, "ParentNotReferrer");
    });

    it("reverts for a caller without OPERATOR_ROLE", async () => {
      const { registry, root, userA, stranger } = await loadFixture(deploy);
      await expect(registry.connect(stranger).registerWithReferrer(userA.address, root.address))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, await registry.OPERATOR_ROLE());
    });
  });

  // ─── parentOf ────────────────────────────────────────────────────────────────

  describe("parentOf", () => {
    it("returns referrer after registration", async () => {
      const { registry, operator, root, userA } = await loadFixture(deploy);
      await registry.connect(operator).registerWithReferrer(userA.address, root.address);
      expect(await registry.parentOf(userA.address)).to.equal(root.address);
    });

    it("returns zero for unregistered address", async () => {
      const { registry, stranger } = await loadFixture(deploy);
      expect(await registry.parentOf(stranger.address)).to.equal(ethers.ZeroAddress);
    });
  });

  // ─── OPERATOR_ROLE ───────────────────────────────────────────────────────────

  describe("OPERATOR_ROLE", () => {
    it("admin can grant the role to several callers at once (Vault + ENCVesting)", async () => {
      const { registry, owner, operator, userA, userB } = await loadFixture(deploy);
      const ROLE = await registry.OPERATOR_ROLE();

      await registry.connect(owner).grantRole(ROLE, userA.address);
      await registry.connect(owner).grantRole(ROLE, userB.address);

      // the constructor operator keeps the role — no slot is taken away
      for (const a of [operator, userA, userB]) {
        expect(await registry.hasRole(ROLE, a.address)).to.be.true;
        expect(await registry.isOperator(a.address)).to.be.true;
      }
    });

    it("every role holder can call registerWithReferrer", async () => {
      const { registry, owner, root, userA, userB, stranger } = await loadFixture(deploy);
      const ROLE = await registry.OPERATOR_ROLE();
      await registry.connect(owner).grantRole(ROLE, stranger.address);

      await expect(registry.connect(stranger).registerWithReferrer(userA.address, root.address))
        .to.emit(registry, "Registered")
        .withArgs(userA.address, root.address);

      expect(await registry.parentOf(userA.address)).to.equal(root.address);
      expect(await registry.parentOf(userB.address)).to.equal(ethers.ZeroAddress);
    });

    it("granting the role twice is a no-op and keeps the holder authorized", async () => {
      const { registry, owner, stranger } = await loadFixture(deploy);
      const ROLE = await registry.OPERATOR_ROLE();

      await registry.connect(owner).grantRole(ROLE, stranger.address);
      await registry.connect(owner).grantRole(ROLE, stranger.address);

      expect(await registry.hasRole(ROLE, stranger.address)).to.be.true;
    });

    it("admin can revoke the role, and the revoked caller can no longer register", async () => {
      const { registry, owner, operator, root, userA } = await loadFixture(deploy);
      const ROLE = await registry.OPERATOR_ROLE();

      await registry.connect(owner).revokeRole(ROLE, operator.address);
      expect(await registry.isOperator(operator.address)).to.be.false;

      await expect(registry.connect(operator).registerWithReferrer(userA.address, root.address))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(operator.address, ROLE);
    });

    it("a non-admin cannot grant the role", async () => {
      const { registry, stranger, userA } = await loadFixture(deploy);
      const ROLE = await registry.OPERATOR_ROLE();

      await expect(registry.connect(stranger).grantRole(ROLE, userA.address))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, await registry.DEFAULT_ADMIN_ROLE());
    });

    it("isOperator is false for the zero address and for anyone unauthorized", async () => {
      const { registry, stranger } = await loadFixture(deploy);
      expect(await registry.isOperator(ethers.ZeroAddress)).to.be.false;
      expect(await registry.isOperator(stranger.address)).to.be.false;
    });
  });
});
