import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ENC_MAX_SUPPLY } from "../../helpers/encConstants";

/**
 * {ENC.mintGenesis} is the token's only mint path. It exists so ENC can deploy
 * before {ENCVesting} — the vesting contract needs ENC's address in an
 * immutable, and minting later means that address is real rather than predicted
 * from the deployer's nonce. These tests pin the properties that make the late
 * mint safe: it runs once, it splits the supply between the two recipients,
 * and it takes the owner with it.
 */
describe("ENC", () => {
  async function fixture() {
    const [deployer, vesting, outsider, sale] = await ethers.getSigners();
    const enc = await (await ethers.getContractFactory("ENC")).deploy();
    await enc.waitForDeployment();
    return { enc, deployer, vesting, outsider, sale };
  }

  describe("constructor", () => {
    it("deploys with no supply and the deployer as owner", async () => {
      const { enc, deployer } = await loadFixture(fixture);
      expect(await enc.totalSupply(), "nothing is minted at construction").to.equal(0n);
      expect(await enc.owner()).to.equal(deployer.address);
      expect(await enc.genesisMinted()).to.equal(false);
      expect(await enc.MAX_SUPPLY()).to.equal(ENC_MAX_SUPPLY);
    });
  });

  describe("mintGenesis", () => {
    it("splits the fixed supply between ENCVesting and EnishiPublicSale", async () => {
      const { enc, vesting, sale } = await loadFixture(fixture);
      const vestingCut = await enc.VESTING_ALLOCATION();
      const saleCut = await enc.PUBLIC_SALE_ALLOCATION();

      await expect(enc.mintGenesis(vesting.address, sale.address))
        .to.emit(enc, "GenesisMinted")
        .withArgs(vesting.address, vestingCut, sale.address, saleCut);

      expect(vestingCut + saleCut, "the two cuts tile the whole supply").to.equal(
        ENC_MAX_SUPPLY,
      );
      expect(await enc.balanceOf(vesting.address)).to.equal(vestingCut);
      expect(await enc.balanceOf(sale.address)).to.equal(saleCut);
      expect(await enc.totalSupply()).to.equal(ENC_MAX_SUPPLY);
      expect(await enc.genesisMinted()).to.equal(true);
    });

    it("leaves each recipient holding exactly its cut", async () => {
      const { enc, vesting, sale } = await loadFixture(fixture);
      await enc.mintGenesis(vesting.address, sale.address);
      expect(await enc.balanceOf(vesting.address)).to.equal(
        await enc.VESTING_ALLOCATION(),
      );
      expect(await enc.balanceOf(sale.address)).to.equal(
        await enc.PUBLIC_SALE_ALLOCATION(),
      );
    });

    it("renounces ownership in the same call, closing the mint path", async () => {
      const { enc, vesting, sale } = await loadFixture(fixture);
      await expect(enc.mintGenesis(vesting.address, sale.address))
        .to.emit(enc, "OwnershipTransferred")
        .withArgs((await ethers.getSigners())[0].address, ethers.ZeroAddress);
      expect(await enc.owner()).to.equal(ethers.ZeroAddress);
    });

    it("cannot be called twice — there is no owner left to call it", async () => {
      const { enc, deployer, vesting, sale } = await loadFixture(fixture);
      await enc.mintGenesis(vesting.address, sale.address);
      await expect(enc.mintGenesis(vesting.address, sale.address))
        .to.be.revertedWithCustomError(enc, "OwnableUnauthorizedAccount")
        .withArgs(deployer.address);
      expect(await enc.totalSupply(), "supply is untouched by the failed attempt").to.equal(
        ENC_MAX_SUPPLY,
      );
    });

    it("reverts for a non-owner", async () => {
      const { enc, vesting, sale, outsider } = await loadFixture(fixture);
      await expect(enc.connect(outsider).mintGenesis(vesting.address, sale.address))
        .to.be.revertedWithCustomError(enc, "OwnableUnauthorizedAccount")
        .withArgs(outsider.address);
    });

    it("reverts on a zero vesting recipient", async () => {
      const { enc, sale } = await loadFixture(fixture);
      await expect(
        enc.mintGenesis(ethers.ZeroAddress, sale.address),
      ).to.be.revertedWithCustomError(enc, "ZeroAddress");
      expect(await enc.totalSupply(), "no partial mint escaped").to.equal(0n);
      expect(await enc.genesisMinted()).to.equal(false);
    });

    it("reverts on a zero public sale recipient", async () => {
      const { enc, vesting } = await loadFixture(fixture);
      await expect(
        enc.mintGenesis(vesting.address, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(enc, "ZeroAddress");
      expect(await enc.totalSupply(), "no partial mint escaped").to.equal(0n);
      expect(await enc.genesisMinted()).to.equal(false);
    });
  });

  describe("supply is fixed once minted", () => {
    it("burning lowers the supply and nobody can mint it back", async () => {
      const { enc, vesting, sale } = await loadFixture(fixture);
      await enc.mintGenesis(vesting.address, sale.address);
      await enc.connect(vesting).burn(1_000n);
      expect(await enc.totalSupply()).to.equal(ENC_MAX_SUPPLY - 1_000n);
      await expect(
        enc.connect(vesting).mintGenesis(vesting.address, sale.address),
      ).to.be.revertedWithCustomError(enc, "OwnableUnauthorizedAccount");
    });
  });
});
