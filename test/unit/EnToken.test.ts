import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { EnBTC } from "../../typechain-types";

const ONE = ethers.parseEther("1");
const MAX_UINT = ethers.MaxUint256;

/**
 * Coverage of the {EnToken} base contract, exercised through {EnBTC}.
 * Two-actor model: `owner` (deployer) + `operator` (Vault, single address).
 */
describe("EnToken (via EnBTC)", () => {
  let enbtc: EnBTC;
  let owner: SignerWithAddress; // = deployer = owner
  let vault: SignerWithAddress; // = operator (set via setOperator)
  let user: SignerWithAddress;
  let other: SignerWithAddress;
  let stranger: SignerWithAddress;

  beforeEach(async () => {
    [owner, vault, user, other, stranger] = await ethers.getSigners();
    const F = await ethers.getContractFactory("EnBTC");
    enbtc = (await F.connect(owner).deploy()) as unknown as EnBTC;
    await enbtc.waitForDeployment();
    // Wire the operator for the test suite (production: real Vault Contract).
    await enbtc.connect(owner).setOperator(vault.address);
  });

  // ─── Deployment & Identity ─────────────────────────────────────────────────

  describe("Deployment & identity", () => {
    it("exposes correct name, symbol, decimals", async () => {
      expect(await enbtc.name()).to.equal("Enishi BTC");
      expect(await enbtc.symbol()).to.equal("enBTC");
      expect(await enbtc.decimals()).to.equal(18);
    });

    it("starts with totalSupply = 0", async () => {
      expect(await enbtc.totalSupply()).to.equal(0);
    });

    it("deployer is owner; operator starts as zero address on a fresh deploy", async () => {
      const F = await ethers.getContractFactory("EnBTC");
      const fresh = (await F.connect(stranger).deploy()) as unknown as EnBTC;
      expect(await fresh.owner()).to.equal(stranger.address);
      expect(await fresh.operator()).to.equal(ethers.ZeroAddress);
    });
  });

  // ─── Ownership ─────────────────────────────────────────────────────────────

  describe("Ownership", () => {
    it("owner can transfer ownership", async () => {
      await enbtc.connect(owner).transferOwnership(stranger.address);
      expect(await enbtc.owner()).to.equal(stranger.address);
    });

    it("non-owner cannot transfer ownership", async () => {
      await expect(enbtc.connect(stranger).transferOwnership(other.address))
        .to.be.revertedWithCustomError(enbtc, "OwnableUnauthorizedAccount");
    });

    it("transferOwnership to zero address reverts", async () => {
      await expect(enbtc.connect(owner).transferOwnership(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(enbtc, "OwnableInvalidOwner");
    });

    it("owner can renounce ownership (irreversible)", async () => {
      await enbtc.connect(owner).renounceOwnership();
      expect(await enbtc.owner()).to.equal(ethers.ZeroAddress);
    });
  });

  // ─── setOperator ──────────────────────────────────────────────────────────

  describe("setOperator", () => {
    it("owner sets operator and emits OperatorChanged", async () => {
      await expect(enbtc.connect(owner).setOperator(other.address))
        .to.emit(enbtc, "OperatorChanged")
        .withArgs(vault.address, other.address);
      expect(await enbtc.operator()).to.equal(other.address);
    });

    it("non-owner cannot setOperator", async () => {
      await expect(enbtc.connect(stranger).setOperator(other.address))
        .to.be.revertedWithCustomError(enbtc, "OwnableUnauthorizedAccount");
    });

    it("setOperator to zero address reverts", async () => {
      await expect(enbtc.connect(owner).setOperator(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(enbtc, "ZeroAddress");
    });

    it("after rotation, old operator can no longer mint; new can", async () => {
      await enbtc.connect(owner).setOperator(other.address);
      await expect(enbtc.connect(vault).mint(user.address, ONE))
        .to.be.revertedWithCustomError(enbtc, "NotOperator");
      await enbtc.connect(other).mint(user.address, ONE);
      expect(await enbtc.balanceOf(user.address)).to.equal(ONE);
    });

    it("setOperator works while paused (state change, no _update)", async () => {
      await enbtc.connect(owner).pause();
      await enbtc.connect(owner).setOperator(other.address);
      expect(await enbtc.operator()).to.equal(other.address);
    });

    it("after renounceOwnership, ex-owner cannot setOperator", async () => {
      await enbtc.connect(owner).renounceOwnership();
      await expect(enbtc.connect(owner).setOperator(other.address))
        .to.be.revertedWithCustomError(enbtc, "OwnableUnauthorizedAccount");
    });

    it("after renounceOwnership, existing operator still works", async () => {
      await enbtc.connect(owner).renounceOwnership();
      await enbtc.connect(vault).mint(user.address, ONE);
      expect(await enbtc.balanceOf(user.address)).to.equal(ONE);
    });
  });

  // ─── mint ──────────────────────────────────────────────────────────────────

  describe("mint", () => {
    it("operator mints; balance + totalSupply update", async () => {
      await enbtc.connect(vault).mint(user.address, ONE);
      expect(await enbtc.balanceOf(user.address)).to.equal(ONE);
      expect(await enbtc.totalSupply()).to.equal(ONE);
    });

    it("emits Transfer(0x0, to, value) on mint", async () => {
      await expect(enbtc.connect(vault).mint(user.address, ONE))
        .to.emit(enbtc, "Transfer")
        .withArgs(ethers.ZeroAddress, user.address, ONE);
    });

    it("non-operator (incl. owner) reverts with NotOperator", async () => {
      await expect(enbtc.connect(stranger).mint(user.address, ONE))
        .to.be.revertedWithCustomError(enbtc, "NotOperator");
      await expect(enbtc.connect(owner).mint(user.address, ONE))
        .to.be.revertedWithCustomError(enbtc, "NotOperator");
    });

    it("mint to zero address reverts (ERC20InvalidReceiver)", async () => {
      await expect(enbtc.connect(vault).mint(ethers.ZeroAddress, ONE))
        .to.be.revertedWithCustomError(enbtc, "ERC20InvalidReceiver");
    });

    it("multiple mints accumulate balance and totalSupply", async () => {
      await enbtc.connect(vault).mint(user.address, ONE);
      await enbtc.connect(vault).mint(user.address, ONE * 2n);
      await enbtc.connect(vault).mint(other.address, ONE * 3n);
      expect(await enbtc.balanceOf(user.address)).to.equal(ONE * 3n);
      expect(await enbtc.balanceOf(other.address)).to.equal(ONE * 3n);
      expect(await enbtc.totalSupply()).to.equal(ONE * 6n);
    });

    it("mint of zero amount succeeds (no-op transfer event)", async () => {
      await expect(enbtc.connect(vault).mint(user.address, 0))
        .to.emit(enbtc, "Transfer")
        .withArgs(ethers.ZeroAddress, user.address, 0);
    });
  });

  // ─── burnFromUser ───────────────────────────────────────────────────────────
  // {burnFromUser} is operator-only (Vault burns a locked receipt post-exit).
  // Holders cannot burn their own balance — only the operator may burn.

  describe("burnFromUser", () => {
    beforeEach(async () => {
      await enbtc.connect(vault).mint(user.address, ONE * 10n);
    });

    it("operator burns user balance without allowance via burnFromUser", async () => {
      await enbtc.connect(vault).burnFromUser(user.address, ONE * 4n);
      expect(await enbtc.balanceOf(user.address)).to.equal(ONE * 6n);
      expect(await enbtc.allowance(user.address, vault.address)).to.equal(0);
    });

    it("burnFromUser of zero amount succeeds", async () => {
      await enbtc.connect(vault).burnFromUser(user.address, 0);
      expect(await enbtc.balanceOf(user.address)).to.equal(ONE * 10n);
    });

    it("non-operator cannot burnFromUser even with allowance", async () => {
      await enbtc.connect(user).approve(stranger.address, ONE * 10n);
      await expect(enbtc.connect(stranger).burnFromUser(user.address, ONE))
        .to.be.revertedWithCustomError(enbtc, "NotOperator");
    });

    it("burnFromUser more than balance reverts", async () => {
      await expect(enbtc.connect(vault).burnFromUser(user.address, ONE * 20n))
        .to.be.revertedWithCustomError(enbtc, "ERC20InsufficientBalance");
    });

    it("burnFromUser from zero address reverts (ERC20InvalidSender)", async () => {
      await expect(enbtc.connect(vault).burnFromUser(ethers.ZeroAddress, ONE))
        .to.be.revertedWithCustomError(enbtc, "ERC20InvalidSender");
    });
  });

  // ─── transfer (freely tradeable) ────────────────────────────────────────────
  // {_update} only enforces {whenNotPaused}; mint/burnFromUser stay gated by
  // {onlyOperator} via their own function-level checks, but ordinary transfers
  // between holders are unrestricted so receipts are freely tradeable.

  describe("transfer", () => {
    beforeEach(async () => {
      await enbtc.connect(vault).mint(user.address, ONE * 10n);
    });

    it("transfer to the zero address reverts (cannot burn via transfer)", async () => {
      await expect(enbtc.connect(user).transfer(ethers.ZeroAddress, ONE))
        .to.be.revertedWithCustomError(enbtc, "ERC20InvalidReceiver");
      expect(await enbtc.totalSupply()).to.equal(ONE * 10n);
    });

    it("holder transfers freely without operator involvement", async () => {
      await expect(enbtc.connect(user).transfer(other.address, ONE * 4n))
        .to.emit(enbtc, "Transfer")
        .withArgs(user.address, other.address, ONE * 4n);
      expect(await enbtc.balanceOf(user.address)).to.equal(ONE * 6n);
      expect(await enbtc.balanceOf(other.address)).to.equal(ONE * 4n);
    });

    it("holder transferFrom works for any spender with a plain ERC20 allowance", async () => {
      await enbtc.connect(user).approve(stranger.address, ONE * 5n);
      await enbtc.connect(stranger).transferFrom(user.address, other.address, ONE * 3n);
      expect(await enbtc.balanceOf(other.address)).to.equal(ONE * 3n);
      expect(await enbtc.allowance(user.address, stranger.address)).to.equal(ONE * 2n);
    });

    it("transfer exceeding balance reverts (ERC20InsufficientBalance)", async () => {
      await expect(enbtc.connect(user).transfer(other.address, ONE * 11n))
        .to.be.revertedWithCustomError(enbtc, "ERC20InsufficientBalance");
    });

    it("operator moves a user balance via transferFrom (allowance)", async () => {
      await enbtc.connect(user).approve(vault.address, ONE * 5n);
      await enbtc.connect(vault).transferFrom(user.address, other.address, ONE * 3n);
      expect(await enbtc.balanceOf(user.address)).to.equal(ONE * 7n);
      expect(await enbtc.balanceOf(other.address)).to.equal(ONE * 3n);
      expect(await enbtc.allowance(user.address, vault.address)).to.equal(ONE * 2n);
    });

    it("operator transferFrom without allowance reverts", async () => {
      await expect(enbtc.connect(vault).transferFrom(user.address, other.address, ONE))
        .to.be.revertedWithCustomError(enbtc, "ERC20InsufficientAllowance");
    });

    it("operator transferFrom exceeding balance reverts", async () => {
      await enbtc.connect(user).approve(vault.address, MAX_UINT);
      await expect(enbtc.connect(vault).transferFrom(user.address, other.address, ONE * 11n))
        .to.be.revertedWithCustomError(enbtc, "ERC20InsufficientBalance");
    });

    it("operator transferFrom to zero address reverts (ERC20InvalidReceiver)", async () => {
      await enbtc.connect(user).approve(vault.address, MAX_UINT);
      await expect(enbtc.connect(vault).transferFrom(user.address, ethers.ZeroAddress, ONE))
        .to.be.revertedWithCustomError(enbtc, "ERC20InvalidReceiver");
    });

    it("operator can transfer its own balance", async () => {
      await enbtc.connect(vault).mint(vault.address, ONE * 2n);
      await enbtc.connect(vault).transfer(other.address, ONE);
      expect(await enbtc.balanceOf(other.address)).to.equal(ONE);
    });
  });

  // ─── setTransfersEnabled (transfer toggle) ─────────────────────────────────
  describe("setTransfersEnabled", () => {
    beforeEach(async () => {
      await enbtc.connect(vault).mint(user.address, ONE * 10n);
    });

    it("transfersEnabled defaults to true", async () => {
      expect(await enbtc.transfersEnabled()).to.be.true;
    });

    it("owner toggles the flag and emits TransfersEnabledChanged", async () => {
      await expect(enbtc.connect(owner).setTransfersEnabled(false))
        .to.emit(enbtc, "TransfersEnabledChanged")
        .withArgs(true, false);
      expect(await enbtc.transfersEnabled()).to.be.false;
      await expect(enbtc.connect(owner).setTransfersEnabled(true))
        .to.emit(enbtc, "TransfersEnabledChanged")
        .withArgs(false, true);
      expect(await enbtc.transfersEnabled()).to.be.true;
    });

    it("non-owner (incl. operator) cannot toggle", async () => {
      await expect(enbtc.connect(stranger).setTransfersEnabled(false))
        .to.be.revertedWithCustomError(enbtc, "OwnableUnauthorizedAccount");
      await expect(enbtc.connect(vault).setTransfersEnabled(false))
        .to.be.revertedWithCustomError(enbtc, "OwnableUnauthorizedAccount");
    });

    it("disabled: wallet-to-wallet transfer reverts with NotOperator", async () => {
      await enbtc.connect(owner).setTransfersEnabled(false);
      await expect(enbtc.connect(user).transfer(other.address, ONE))
        .to.be.revertedWithCustomError(enbtc, "NotOperator");
    });

    it("disabled: non-operator transferFrom reverts even with allowance", async () => {
      await enbtc.connect(user).approve(stranger.address, ONE);
      await enbtc.connect(owner).setTransfersEnabled(false);
      await expect(enbtc.connect(stranger).transferFrom(user.address, other.address, ONE))
        .to.be.revertedWithCustomError(enbtc, "NotOperator");
    });

    it("disabled: mint still works", async () => {
      await enbtc.connect(owner).setTransfersEnabled(false);
      await enbtc.connect(vault).mint(other.address, ONE);
      expect(await enbtc.balanceOf(other.address)).to.equal(ONE);
    });

    it("disabled: burnFromUser still works", async () => {
      await enbtc.connect(owner).setTransfersEnabled(false);
      await enbtc.connect(vault).burnFromUser(user.address, ONE);
      expect(await enbtc.balanceOf(user.address)).to.equal(ONE * 9n);
    });

    it("disabled: Vault pulls a receipt via transferFrom (exit flow) still works", async () => {
      await enbtc.connect(owner).setTransfersEnabled(false);
      await enbtc.connect(user).approve(vault.address, ONE * 3n);
      await enbtc.connect(vault).transferFrom(user.address, vault.address, ONE * 3n);
      expect(await enbtc.balanceOf(vault.address)).to.equal(ONE * 3n);
    });

    it("disabled: operator can transfer its own balance", async () => {
      await enbtc.connect(vault).mint(vault.address, ONE * 2n);
      await enbtc.connect(owner).setTransfersEnabled(false);
      await enbtc.connect(vault).transfer(other.address, ONE);
      expect(await enbtc.balanceOf(other.address)).to.equal(ONE);
    });

    it("re-enabled: wallet-to-wallet transfer works again", async () => {
      await enbtc.connect(owner).setTransfersEnabled(false);
      await enbtc.connect(owner).setTransfersEnabled(true);
      await enbtc.connect(user).transfer(other.address, ONE);
      expect(await enbtc.balanceOf(other.address)).to.equal(ONE);
    });

    it("pause still dominates: operator moves revert while paused and disabled", async () => {
      await enbtc.connect(owner).setTransfersEnabled(false);
      await enbtc.connect(owner).pause();
      await expect(enbtc.connect(vault).mint(user.address, ONE))
        .to.be.revertedWithCustomError(enbtc, "EnforcedPause");
    });
  });

  // ─── pause / unpause ───────────────────────────────────────────────────────

  describe("pause / unpause", () => {
    beforeEach(async () => {
      await enbtc.connect(vault).mint(user.address, ONE);
    });

    it("owner can pause; paused() reflects state", async () => {
      await enbtc.connect(owner).pause();
      expect(await enbtc.paused()).to.be.true;
    });

    it("emits Paused with caller address", async () => {
      await expect(enbtc.connect(owner).pause())
        .to.emit(enbtc, "Paused")
        .withArgs(owner.address);
    });

    it("pause when already paused reverts (EnforcedPause)", async () => {
      await enbtc.connect(owner).pause();
      await expect(enbtc.connect(owner).pause())
        .to.be.revertedWithCustomError(enbtc, "EnforcedPause");
    });

    it("unpause when not paused reverts (ExpectedPause)", async () => {
      await expect(enbtc.connect(owner).unpause())
        .to.be.revertedWithCustomError(enbtc, "ExpectedPause");
    });

    it("non-owner cannot pause", async () => {
      await expect(enbtc.connect(stranger).pause())
        .to.be.revertedWithCustomError(enbtc, "OwnableUnauthorizedAccount");
    });

    it("operator (non-owner) cannot pause", async () => {
      await expect(enbtc.connect(vault).pause())
        .to.be.revertedWithCustomError(enbtc, "OwnableUnauthorizedAccount");
    });

    it("paused blocks transfer", async () => {
      await enbtc.connect(owner).pause();
      await expect(enbtc.connect(user).transfer(other.address, ONE))
        .to.be.revertedWithCustomError(enbtc, "EnforcedPause");
    });

    it("paused blocks mint", async () => {
      await enbtc.connect(owner).pause();
      await expect(enbtc.connect(vault).mint(user.address, ONE))
        .to.be.revertedWithCustomError(enbtc, "EnforcedPause");
    });

    it("paused blocks operator transferFrom", async () => {
      await enbtc.connect(user).approve(vault.address, ONE);
      await enbtc.connect(owner).pause();
      await expect(enbtc.connect(vault).transferFrom(user.address, other.address, ONE))
        .to.be.revertedWithCustomError(enbtc, "EnforcedPause");
    });

    it("paused blocks burnFromUser", async () => {
      await enbtc.connect(owner).pause();
      await expect(enbtc.connect(vault).burnFromUser(user.address, ONE))
        .to.be.revertedWithCustomError(enbtc, "EnforcedPause");
    });

    it("approve still works when paused (no _update call)", async () => {
      await enbtc.connect(owner).pause();
      await enbtc.connect(user).approve(stranger.address, ONE);
      expect(await enbtc.allowance(user.address, stranger.address)).to.equal(ONE);
    });

    it("unpause restores operator token moves", async () => {
      await enbtc.connect(owner).pause();
      await enbtc.connect(owner).unpause();
      await enbtc.connect(vault).mint(other.address, ONE);
      expect(await enbtc.balanceOf(other.address)).to.equal(ONE);
    });
  });

  // ─── End-to-end lifecycle ──────────────────────────────────────────────────

  describe("End-to-end vault lifecycle", () => {
    it("mint → operator relocates via transferFrom → operator burnFromUser (deposit + withdraw cycle)", async () => {
      // 1. Vault mints on user execute.
      await enbtc.connect(vault).mint(user.address, ONE * 10n);
      // 2. Receipts are operator-controlled: the Vault (not the user) relocates a
      //    slice via transferFrom under an allowance (approve or EIP-2612 permit).
      await enbtc.connect(user).approve(vault.address, ONE * 3n);
      await enbtc.connect(vault).transferFrom(user.address, other.address, ONE * 3n);
      // 3. Vault burns directly from each holder on withdraw (no allowance).
      await enbtc.connect(vault).burnFromUser(user.address, ONE * 7n);
      await enbtc.connect(vault).burnFromUser(other.address, ONE * 3n);
      expect(await enbtc.totalSupply()).to.equal(0);
    });

    it("same operator address works on multiple enToken contracts", async () => {
      const F = await ethers.getContractFactory("EnETH");
      const eneth = await F.connect(owner).deploy();
      await eneth.connect(owner).setOperator(vault.address);

      await enbtc.connect(vault).mint(user.address, ONE);
      await eneth.connect(vault).mint(user.address, ONE * 2n);
      expect(await enbtc.balanceOf(user.address)).to.equal(ONE);
      expect(await eneth.balanceOf(user.address)).to.equal(ONE * 2n);
    });
  });
});
