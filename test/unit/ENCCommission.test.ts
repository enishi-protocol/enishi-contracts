import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { ENC, ENCCommission, ReferralRegistry } from "../../typechain-types";

const BPS_DENOM = 10_000n;
const DEFAULT_REFERRAL_BPS = 4000n;
const DEFAULT_OPERATING_BPS = 1000n;
const DEFAULT_CSR_BPS = 2000n;
const DEFAULT_BURN_BPS = 3000n;

const toENC = (n: number) => ethers.parseEther(String(n));

describe("ENCCommission", () => {
  async function fixture() {
    const [
      owner,
      treasury,
      operator,
      root,
      userA,
      userB,
      vault,
      enishiMaster,
      stranger,
    ] = await ethers.getSigners();

    const ENCFactory = await ethers.getContractFactory("ENC");
    const enc = (await ENCFactory.deploy()) as unknown as ENC;
    await enc.waitForDeployment();
    await enc.mintGenesis(treasury.address, stranger.address);

    const RegFactory = await ethers.getContractFactory("ReferralRegistry");
    const registry = (await RegFactory.connect(owner).deploy(
      root.address,
    )) as unknown as ReferralRegistry;
    await registry.waitForDeployment();
    // OPERATOR_ROLE is granted after deploy, never in the constructor.
    await registry.connect(owner).grantRole(await registry.OPERATOR_ROLE(), operator.address);

    const CommissionFactory = await ethers.getContractFactory("ENCCommission");
    // deployer (signers[0]) becomes owner.
    const commission = (await CommissionFactory.deploy(
      await enc.getAddress(),
      await registry.getAddress(),
      enishiMaster.address,
    )) as unknown as ENCCommission;
    await commission.waitForDeployment();

    // userA has a referrer (root); userB does not.
    await registry.connect(operator).registerWithReferrer(userA.address, root.address);

    // Vault holds ENC and is authorized to call distribute.
    // No approve needed — push pattern (vault transfers ENC to commission before distribute).
    await enc.connect(treasury).transfer(vault.address, toENC(10_000));
    await commission.connect(owner).setAuthorizedCaller(vault.address, true);

    return {
      enc,
      registry,
      commission,
      owner,
      treasury,
      operator,
      root,
      userA,
      userB,
      vault,
      enishiMaster,
      stranger,
    };
  }

  // ─── constructor ────────────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("sets ENC_TOKEN, REFERRAL_REGISTRY and enishiMasterWallet", async () => {
      const { enc, registry, commission, enishiMaster } = await loadFixture(
        fixture,
      );
      expect(await commission.ENC_TOKEN()).to.equal(await enc.getAddress());
      expect(await commission.REFERRAL_REGISTRY()).to.equal(
        await registry.getAddress(),
      );
      expect(await commission.enishiMasterWallet()).to.equal(
        enishiMaster.address,
      );
    });

    it("sets default 40/10/20/30 split", async () => {
      const { commission } = await loadFixture(fixture);
      expect(await commission.referralBps()).to.equal(DEFAULT_REFERRAL_BPS);
      expect(await commission.operatingBps()).to.equal(DEFAULT_OPERATING_BPS);
      expect(await commission.csrBps()).to.equal(DEFAULT_CSR_BPS);
      expect(await commission.burnBps()).to.equal(DEFAULT_BURN_BPS);
    });

    it("sets owner", async () => {
      const { commission, owner } = await loadFixture(fixture);
      expect(await commission.owner()).to.equal(owner.address);
    });

    it("reverts if enc is zero address", async () => {
      const { registry, enishiMaster } = await loadFixture(fixture);
      const CommissionFactory = await ethers.getContractFactory(
        "ENCCommission",
      );
      await expect(
        CommissionFactory.deploy(
          ethers.ZeroAddress,
          await registry.getAddress(),
          enishiMaster.address,
        ),
      ).to.be.revertedWithCustomError(CommissionFactory, "ZeroAddress");
    });

    it("reverts if registry is zero address", async () => {
      const { enc, enishiMaster } = await loadFixture(fixture);
      const CommissionFactory = await ethers.getContractFactory(
        "ENCCommission",
      );
      await expect(
        CommissionFactory.deploy(
          await enc.getAddress(),
          ethers.ZeroAddress,
          enishiMaster.address,
        ),
      ).to.be.revertedWithCustomError(CommissionFactory, "ZeroAddress");
    });

    it("reverts if enishiMasterWallet is zero address", async () => {
      const { enc, registry } = await loadFixture(fixture);
      const CommissionFactory = await ethers.getContractFactory(
        "ENCCommission",
      );
      await expect(
        CommissionFactory.deploy(
          await enc.getAddress(),
          await registry.getAddress(),
          ethers.ZeroAddress,
        ),
      ).to.be.revertedWithCustomError(CommissionFactory, "ZeroAddress");
    });

    it("exposes BPS_DENOMINATOR constant as 10_000", async () => {
      const { commission } = await loadFixture(fixture);
      expect(await commission.BPS_DENOMINATOR()).to.equal(10_000);
    });
  });

  // ─── setSplit ─────────────────────────────────────────────────────────────────

  describe("setSplit", () => {
    it("owner can update split", async () => {
      const { commission, owner } = await loadFixture(fixture);
      await commission.connect(owner).setSplit(5000, 1000, 1000, 3000);
      expect(await commission.referralBps()).to.equal(5000);
      expect(await commission.operatingBps()).to.equal(1000);
      expect(await commission.csrBps()).to.equal(1000);
      expect(await commission.burnBps()).to.equal(3000);
    });

    it("emits SplitChanged", async () => {
      const { commission, owner } = await loadFixture(fixture);
      await expect(commission.connect(owner).setSplit(5000, 1000, 1000, 3000))
        .to.emit(commission, "SplitChanged")
        .withArgs(5000, 1000, 1000, 3000);
    });

    it("reverts if sum is below 10000", async () => {
      const { commission, owner } = await loadFixture(fixture);
      await expect(commission.connect(owner).setSplit(5000, 1000, 1000, 1000))
        .to.be.revertedWithCustomError(commission, "InvalidSplit")
        .withArgs(8000);
    });

    it("reverts if sum is above 10000", async () => {
      const { commission, owner } = await loadFixture(fixture);
      await expect(commission.connect(owner).setSplit(5000, 1000, 1000, 4000))
        .to.be.revertedWithCustomError(commission, "InvalidSplit")
        .withArgs(11000);
    });

    it("reverts if non-owner", async () => {
      const { commission, stranger } = await loadFixture(fixture);
      await expect(
        commission.connect(stranger).setSplit(5000, 1000, 1000, 3000),
      ).to.be.revertedWithCustomError(commission, "OwnableUnauthorizedAccount");
    });

    it("allows 100% to a single bucket", async () => {
      const { commission, owner } = await loadFixture(fixture);
      await commission.connect(owner).setSplit(10000, 0, 0, 0);
      expect(await commission.referralBps()).to.equal(10000);
      expect(await commission.burnBps()).to.equal(0);
    });

    it("reverts when all splits are zero", async () => {
      const { commission, owner } = await loadFixture(fixture);
      await expect(commission.connect(owner).setSplit(0, 0, 0, 0))
        .to.be.revertedWithCustomError(commission, "InvalidSplit")
        .withArgs(0);
    });
  });

  // ─── setEnishiMasterWallet ────────────────────────────────────────────────────

  describe("setEnishiMasterWallet", () => {
    it("owner can update wallet", async () => {
      const { commission, owner, stranger } = await loadFixture(fixture);
      await commission.connect(owner).setEnishiMasterWallet(stranger.address);
      expect(await commission.enishiMasterWallet()).to.equal(stranger.address);
    });

    it("emits EnishiMasterWalletChanged with previous and new", async () => {
      const { commission, owner, enishiMaster, stranger } = await loadFixture(
        fixture,
      );
      await expect(
        commission.connect(owner).setEnishiMasterWallet(stranger.address),
      )
        .to.emit(commission, "EnishiMasterWalletChanged")
        .withArgs(enishiMaster.address, stranger.address);
    });

    it("reverts on zero address", async () => {
      const { commission, owner } = await loadFixture(fixture);
      await expect(
        commission.connect(owner).setEnishiMasterWallet(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(commission, "ZeroAddress");
    });

    it("reverts if non-owner", async () => {
      const { commission, stranger } = await loadFixture(fixture);
      await expect(
        commission.connect(stranger).setEnishiMasterWallet(stranger.address),
      ).to.be.revertedWithCustomError(commission, "OwnableUnauthorizedAccount");
    });
  });

  // ─── setAuthorizedCaller ──────────────────────────────────────────────────────

  describe("setAuthorizedCaller", () => {
    it("owner can authorize and revoke", async () => {
      const { commission, owner, stranger } = await loadFixture(fixture);
      await commission
        .connect(owner)
        .setAuthorizedCaller(stranger.address, true);
      expect(await commission.isAuthorizedCaller(stranger.address)).to.equal(
        true,
      );
      await commission
        .connect(owner)
        .setAuthorizedCaller(stranger.address, false);
      expect(await commission.isAuthorizedCaller(stranger.address)).to.equal(
        false,
      );
    });

    it("emits AuthorizedCallerChanged", async () => {
      const { commission, owner, stranger } = await loadFixture(fixture);
      await expect(
        commission.connect(owner).setAuthorizedCaller(stranger.address, true),
      )
        .to.emit(commission, "AuthorizedCallerChanged")
        .withArgs(stranger.address, true);
    });

    it("reverts on zero address", async () => {
      const { commission, owner } = await loadFixture(fixture);
      await expect(
        commission.connect(owner).setAuthorizedCaller(ethers.ZeroAddress, true),
      ).to.be.revertedWithCustomError(commission, "ZeroAddress");
    });

    it("reverts if non-owner", async () => {
      const { commission, stranger } = await loadFixture(fixture);
      await expect(
        commission
          .connect(stranger)
          .setAuthorizedCaller(stranger.address, true),
      ).to.be.revertedWithCustomError(commission, "OwnableUnauthorizedAccount");
    });

    it("revoking authorization blocks subsequent distribute calls", async () => {
      const { commission, owner, vault, userA } = await loadFixture(fixture);
      await commission.connect(owner).setAuthorizedCaller(vault.address, false);
      await expect(
        commission.connect(vault).distribute(userA.address, toENC(100)),
      ).to.be.revertedWithCustomError(commission, "NotAuthorized");
    });

    it("re-authorizing an already-authorized caller still works", async () => {
      const { commission, owner, vault } = await loadFixture(fixture);
      await expect(
        commission.connect(owner).setAuthorizedCaller(vault.address, true),
      )
        .to.emit(commission, "AuthorizedCallerChanged")
        .withArgs(vault.address, true);
      expect(await commission.isAuthorizedCaller(vault.address)).to.equal(true);
    });
  });

  // ─── distribute (push pattern) ────────────────────────────────────────────────

  /// Helper: push amount to commission then call distribute.
  /// Production vault would do this atomically in a single function (see MockVault).
  async function pushAndDistribute(
    enc: ENC,
    commission: ENCCommission,
    vault: any,
    user: string,
    amount: bigint,
  ) {
    await enc.connect(vault).transfer(await commission.getAddress(), amount);
    return commission.connect(vault).distribute(user, amount);
  }

  /// Helper: snapshot balances of multiple addresses, run a function, return deltas.
  /// Use when an action spans multiple txs (changeTokenBalances only supports 1 tx).
  async function balanceChanges(
    token: ENC,
    addresses: string[],
    fn: () => Promise<any>,
  ): Promise<bigint[]> {
    const before = await Promise.all(addresses.map((a) => token.balanceOf(a)));
    await fn();
    const after = await Promise.all(addresses.map((a) => token.balanceOf(a)));
    return after.map((bal, i) => bal - before[i]);
  }

  describe("distribute", () => {
    it("distributes 40/30/30 across referrer / master / burn", async () => {
      const { enc, commission, vault, userA, root, enishiMaster } =
        await loadFixture(fixture);
      const amount = toENC(1000);
      const referralAmt = (amount * DEFAULT_REFERRAL_BPS) / BPS_DENOM; // 400
      const operatingAmt = (amount * DEFAULT_OPERATING_BPS) / BPS_DENOM; // 100
      const csrAmt = (amount * DEFAULT_CSR_BPS) / BPS_DENOM; // 200
      const masterAmt = operatingAmt + csrAmt; // 300
      const burnAmt = amount - referralAmt - masterAmt; // 300

      const supplyBefore = await enc.totalSupply();
      const commissionAddr = await commission.getAddress();

      const [dVault, dRoot, dMaster, dCommission] = await balanceChanges(
        enc,
        [vault.address, root.address, enishiMaster.address, commissionAddr],
        () => pushAndDistribute(enc, commission, vault, userA.address, amount),
      );

      expect(dVault).to.equal(-amount);
      expect(dRoot).to.equal(referralAmt);
      expect(dMaster).to.equal(masterAmt);
      expect(dCommission).to.equal(0n);
      expect(supplyBefore - (await enc.totalSupply())).to.equal(burnAmt);
    });

    it("emits Distributed with the four shares", async () => {
      const { enc, commission, vault, userA, root } = await loadFixture(
        fixture,
      );
      const amount = toENC(1000);
      const referralAmt = (amount * DEFAULT_REFERRAL_BPS) / BPS_DENOM;
      const operatingAmt = (amount * DEFAULT_OPERATING_BPS) / BPS_DENOM;
      const csrAmt = (amount * DEFAULT_CSR_BPS) / BPS_DENOM;
      const burnAmt = amount - referralAmt - operatingAmt - csrAmt;

      await enc.connect(vault).transfer(await commission.getAddress(), amount);
      await expect(commission.connect(vault).distribute(userA.address, amount))
        .to.emit(commission, "Distributed")
        .withArgs(
          userA.address,
          root.address,
          amount,
          referralAmt,
          operatingAmt,
          csrAmt,
          burnAmt,
        );
    });

    it("burn share is the remainder — four parts sum exactly to amount", async () => {
      const { enc, commission, vault, userA } = await loadFixture(fixture);
      // Odd amount forces rounding; remainder goes to burn.
      const amount = 9999n;
      await pushAndDistribute(enc, commission, vault, userA.address, amount);
      // Contract holds nothing after distribution → all amount was distributed.
      expect(await enc.balanceOf(await commission.getAddress())).to.equal(0n);
    });

    it("contract holds 0 ENC after distribution", async () => {
      const { enc, commission, vault, userA } = await loadFixture(fixture);
      await pushAndDistribute(
        enc,
        commission,
        vault,
        userA.address,
        toENC(1000),
      );
      expect(await enc.balanceOf(await commission.getAddress())).to.equal(0n);
    });

    it("reverts if caller is not authorized", async () => {
      const { commission, stranger, userA } = await loadFixture(fixture);
      await expect(
        commission.connect(stranger).distribute(userA.address, toENC(100)),
      ).to.be.revertedWithCustomError(commission, "NotAuthorized");
    });

    it("reverts on zero amount", async () => {
      const { commission, vault, userA } = await loadFixture(fixture);
      await expect(
        commission.connect(vault).distribute(userA.address, 0n),
      ).to.be.revertedWithCustomError(commission, "ZeroAmount");
    });

    it("redirects referral share to enishiMasterWallet when user has no referrer", async () => {
      const { enc, commission, vault, userB, enishiMaster } = await loadFixture(fixture);
      const amount = toENC(100);
      const referralAmt = (amount * DEFAULT_REFERRAL_BPS) / BPS_DENOM; // 40 ENC
      const operatingAmt = (amount * DEFAULT_OPERATING_BPS) / BPS_DENOM; // 10 ENC
      const csrAmt = (amount * DEFAULT_CSR_BPS) / BPS_DENOM; // 20 ENC
      const expectedMaster = referralAmt + operatingAmt + csrAmt; // 70 ENC

      const [dMaster] = await balanceChanges(
        enc,
        [enishiMaster.address],
        () => pushAndDistribute(enc, commission, vault, userB.address, amount),
      );
      // No referrer: referral share goes to enishiMasterWallet too.
      expect(dMaster).to.equal(expectedMaster);
    });

    it("reverts if commission balance is insufficient (no push beforehand)", async () => {
      const { commission, vault, userA } = await loadFixture(fixture);
      // No push — commission balance is 0
      await expect(
        commission.connect(vault).distribute(userA.address, toENC(100)),
      )
        .to.be.revertedWithCustomError(commission, "InsufficientBalance")
        .withArgs(toENC(100), 0n);
    });

    it("reverts if push amount < distribute amount", async () => {
      const { enc, commission, vault, userA } = await loadFixture(fixture);
      // Push only 50 but ask to distribute 100
      await enc
        .connect(vault)
        .transfer(await commission.getAddress(), toENC(50));
      await expect(
        commission.connect(vault).distribute(userA.address, toENC(100)),
      )
        .to.be.revertedWithCustomError(commission, "InsufficientBalance")
        .withArgs(toENC(100), toENC(50));
    });

    it("uses the updated split after setSplit", async () => {
      const { enc, commission, owner, vault, userA, root, enishiMaster } =
        await loadFixture(fixture);
      await commission.connect(owner).setSplit(5000, 0, 0, 5000);
      const amount = toENC(100);
      const referralAmt = (amount * 5000n) / BPS_DENOM;
      const burnAmt = amount - referralAmt;

      const supplyBefore = await enc.totalSupply();
      const [dVault, dRoot, dMaster] = await balanceChanges(
        enc,
        [vault.address, root.address, enishiMaster.address],
        () => pushAndDistribute(enc, commission, vault, userA.address, amount),
      );
      expect(dVault).to.equal(-amount);
      expect(dRoot).to.equal(referralAmt);
      expect(dMaster).to.equal(0n);
      expect(await enc.totalSupply()).to.equal(supplyBefore - burnAmt);
    });

    it("skips burn when burnBps is 0", async () => {
      const { enc, commission, owner, vault, userA } = await loadFixture(
        fixture,
      );
      await commission.connect(owner).setSplit(4000, 1000, 5000, 0);
      const supplyBefore = await enc.totalSupply();
      await pushAndDistribute(
        enc,
        commission,
        vault,
        userA.address,
        toENC(100),
      );
      expect(await enc.totalSupply()).to.equal(supplyBefore);
    });

    it("routes to updated enishiMasterWallet after setEnishiMasterWallet", async () => {
      const { enc, commission, owner, vault, userA, enishiMaster, stranger } =
        await loadFixture(fixture);
      await commission.connect(owner).setEnishiMasterWallet(stranger.address);
      const amount = toENC(1000);
      const masterAmt =
        (amount * (DEFAULT_OPERATING_BPS + DEFAULT_CSR_BPS)) / BPS_DENOM;

      const [dOldMaster, dNewMaster] = await balanceChanges(
        enc,
        [enishiMaster.address, stranger.address],
        () => pushAndDistribute(enc, commission, vault, userA.address, amount),
      );
      expect(dOldMaster).to.equal(0n);
      expect(dNewMaster).to.equal(masterAmt);
    });

    it("works when master wallet == referrer (single recipient gets both)", async () => {
      const { enc, commission, owner, vault, userA, root } = await loadFixture(
        fixture,
      );
      await commission.connect(owner).setEnishiMasterWallet(root.address);
      const amount = toENC(1000);
      const referralAmt = (amount * DEFAULT_REFERRAL_BPS) / BPS_DENOM;
      const masterAmt =
        (amount * (DEFAULT_OPERATING_BPS + DEFAULT_CSR_BPS)) / BPS_DENOM;

      const [dRoot] = await balanceChanges(enc, [root.address], () =>
        pushAndDistribute(enc, commission, vault, userA.address, amount),
      );
      expect(dRoot).to.equal(referralAmt + masterAmt);
    });

    it("handles 1 wei (all rounded to burn)", async () => {
      const { enc, commission, vault, userA, root, enishiMaster } =
        await loadFixture(fixture);
      const supplyBefore = await enc.totalSupply();
      const commissionAddr = await commission.getAddress();
      const [dVault, dRoot, dMaster, dCommission] = await balanceChanges(
        enc,
        [vault.address, root.address, enishiMaster.address, commissionAddr],
        () => pushAndDistribute(enc, commission, vault, userA.address, 1n),
      );
      expect(dVault).to.equal(-1n);
      expect(dRoot).to.equal(0n);
      expect(dMaster).to.equal(0n);
      expect(dCommission).to.equal(0n);
      expect(supplyBefore - (await enc.totalSupply())).to.equal(1n);
    });

    it("all-burn split (0/0/0/10000) burns full amount", async () => {
      const { enc, commission, owner, vault, userA, root, enishiMaster } =
        await loadFixture(fixture);
      await commission.connect(owner).setSplit(0, 0, 0, 10000);
      const amount = toENC(100);
      const supplyBefore = await enc.totalSupply();

      const [dVault, dRoot, dMaster] = await balanceChanges(
        enc,
        [vault.address, root.address, enishiMaster.address],
        () => pushAndDistribute(enc, commission, vault, userA.address, amount),
      );
      expect(dVault).to.equal(-amount);
      expect(dRoot).to.equal(0n);
      expect(dMaster).to.equal(0n);
      expect(supplyBefore - (await enc.totalSupply())).to.equal(amount);
    });

    it("supports back-to-back distributes in same fixture", async () => {
      const { enc, commission, vault, userA } = await loadFixture(fixture);
      await pushAndDistribute(
        enc,
        commission,
        vault,
        userA.address,
        toENC(100),
      );
      await enc
        .connect(vault)
        .transfer(await commission.getAddress(), toENC(50));
      await expect(
        commission.connect(vault).distribute(userA.address, toENC(50)),
      ).to.emit(commission, "Distributed");
    });

    it("works when user == caller (vault distributes its own commission)", async () => {
      const { enc, registry, commission, vault, root } = await loadFixture(
        fixture,
      );
      // Vault registers a parent → can be a `user` itself.
      const { operator } = await loadFixture(fixture);
      await registry.connect(operator).registerWithReferrer(vault.address, root.address);
      await enc
        .connect(vault)
        .transfer(await commission.getAddress(), toENC(100));
      await expect(
        commission.connect(vault).distribute(vault.address, toENC(100)),
      )
        .to.emit(commission, "Distributed")
        .withArgs(
          vault.address,
          root.address,
          toENC(100),
          anyValue,
          anyValue,
          anyValue,
          anyValue,
        );
    });

    it("distributes only `amount`, leaving any pre-existing dust untouched", async () => {
      const { enc, commission, vault, userA } = await loadFixture(fixture);
      const commissionAddr = await commission.getAddress();

      // Pre-existing dust (e.g., someone accidentally sent 5 ENC earlier)
      await enc.connect(vault).transfer(commissionAddr, toENC(5));
      expect(await enc.balanceOf(commissionAddr)).to.equal(toENC(5));

      // Now push + distribute 100 — dust must NOT be included
      const amount = toENC(100);
      await enc.connect(vault).transfer(commissionAddr, amount);
      await commission.connect(vault).distribute(userA.address, amount);

      // Dust remains
      expect(await enc.balanceOf(commissionAddr)).to.equal(toENC(5));
    });
  });

  // ─── Reentrancy ──────────────────────────────────────────────────────────────

  describe("reentrancy", () => {
    it("blocks a token callback that re-enters distribute", async () => {
      const { registry, owner, vault, enishiMaster, userA } = await loadFixture(fixture);

      const attackToken = await (
        await ethers.getContractFactory("ReentrantENC")
      ).deploy();
      await attackToken.waitForDeployment();

      const commission = await (
        await ethers.getContractFactory("ENCCommission")
      ).deploy(
        await attackToken.getAddress(),
        await registry.getAddress(),
        enishiMaster.address,
      );
      await commission.waitForDeployment();
      await commission.connect(owner).setAuthorizedCaller(vault.address, true);

      const amount = toENC(1000);
      await attackToken.mint(await commission.getAddress(), amount * 2n);
      // The first outbound transfer inside _distribute calls back into distribute.
      await attackToken.arm(await commission.getAddress(), userA.address, amount);

      await expect(
        commission.connect(vault).distribute(userA.address, amount),
      ).to.be.revertedWithCustomError(commission, "ReentrancyGuardReentrantCall");
    });
  });

  // ─── Burn limit ──────────────────────────────────────────────────────────────

  describe("burn limit (990M ENC floor)", () => {
    const PUBLIC_ALLOCATION = ethers.parseEther("990000000"); // 990M

    it("isBurnFinished() is false at deploy (full supply)", async () => {
      const { commission } = await loadFixture(fixture);
      expect(await commission.isBurnFinished()).to.equal(false);
    });

    it("remainingBurnCap() equals totalSupply − 990M at deploy", async () => {
      const { enc, commission } = await loadFixture(fixture);
      const supply = await enc.totalSupply();
      expect(await commission.remainingBurnCap()).to.equal(supply - PUBLIC_ALLOCATION);
    });

    it("isBurnFinished() becomes true once supply reaches 990M", async () => {
      const { enc, commission, treasury } = await loadFixture(fixture);
      const supply = await enc.totalSupply();
      await enc.connect(treasury).burn(supply - PUBLIC_ALLOCATION);
      expect(await commission.isBurnFinished()).to.equal(true);
      expect(await commission.remainingBurnCap()).to.equal(0n);
    });

    it("distribute: 30% burn share fully redirected to master wallet when burn limit reached", async () => {
      const { enc, commission, vault, treasury, enishiMaster, userA, root } =
        await loadFixture(fixture);

      // Burn supply down to exactly 990M floor.
      const supply = await enc.totalSupply();
      await enc.connect(treasury).burn(supply - PUBLIC_ALLOCATION);
      expect(await commission.isBurnFinished()).to.equal(true);

      // Treasury holds remaining 990M; give vault some to distribute.
      const amount = toENC(1000);
      await enc.connect(treasury).transfer(vault.address, amount);

      const supplyBefore = await enc.totalSupply();
      const referralAmt = (amount * DEFAULT_REFERRAL_BPS) / BPS_DENOM;   // 400
      const operatingAmt = (amount * DEFAULT_OPERATING_BPS) / BPS_DENOM; // 100
      const csrAmt       = (amount * DEFAULT_CSR_BPS) / BPS_DENOM;       // 200
      const burnAmt      = amount - referralAmt - operatingAmt - csrAmt;  // 300 (redirected)
      const expectedMaster = operatingAmt + csrAmt + burnAmt;             // 600

      const [dRoot, dMaster] = await balanceChanges(
        enc,
        [root.address, enishiMaster.address],
        () => pushAndDistribute(enc, commission, vault, userA.address, amount),
      );

      expect(dRoot).to.equal(referralAmt);
      expect(dMaster).to.equal(expectedMaster);
      // Supply must not decrease (no burn occurred).
      expect(await enc.totalSupply()).to.equal(supplyBefore);
    });

    it("distribute: partial burn — only remaining cap is burned, rest goes to master", async () => {
      const { enc, commission, vault, treasury, enishiMaster, userA, root } =
        await loadFixture(fixture);

      // Leave only 100 ENC above the floor so only 100 ENC can be burned.
      const supply = await enc.totalSupply();
      const partialHeadroom = toENC(100);
      await enc.connect(treasury).burn(supply - PUBLIC_ALLOCATION - partialHeadroom);

      const remainCap = await commission.remainingBurnCap();
      expect(remainCap).to.equal(partialHeadroom);

      // distribute 1000 ENC; burn share = 300 ENC but cap = 100 ENC.
      const amount = toENC(1000);
      await enc.connect(treasury).transfer(vault.address, amount);

      const referralAmt = (amount * DEFAULT_REFERRAL_BPS) / BPS_DENOM;   // 400
      const operatingAmt = (amount * DEFAULT_OPERATING_BPS) / BPS_DENOM; // 100
      const csrAmt       = (amount * DEFAULT_CSR_BPS) / BPS_DENOM;       // 200
      const rawBurnAmt   = amount - referralAmt - operatingAmt - csrAmt;  // 300
      const actualBurn   = partialHeadroom;                               // 100
      const redirected   = rawBurnAmt - actualBurn;                       // 200
      const expectedMaster = operatingAmt + csrAmt + redirected;         // 500

      const supplyBefore = await enc.totalSupply();

      const [dRoot, dMaster] = await balanceChanges(
        enc,
        [root.address, enishiMaster.address],
        () => pushAndDistribute(enc, commission, vault, userA.address, amount),
      );

      expect(dRoot).to.equal(referralAmt);
      expect(dMaster).to.equal(expectedMaster);
      expect(supplyBefore - (await enc.totalSupply())).to.equal(actualBurn);
    });

    it("MIN_SUPPLY is the 990M public allocation floor", async () => {
      const { commission } = await loadFixture(fixture);
      expect(await commission.MIN_SUPPLY()).to.equal(PUBLIC_ALLOCATION);
    });

    it("no redirect happens while supply is comfortably above the floor", async () => {
      const { enc, commission, vault, userA, enishiMaster } = await loadFixture(fixture);
      const amount = toENC(1000);
      const burnAmt = (amount * DEFAULT_BURN_BPS) / BPS_DENOM;
      const masterAmt =
        (amount * (DEFAULT_OPERATING_BPS + DEFAULT_CSR_BPS)) / BPS_DENOM;
      const supplyBefore = await enc.totalSupply();

      const [dMaster] = await balanceChanges(enc, [enishiMaster.address], () =>
        pushAndDistribute(enc, commission, vault, userA.address, amount),
      );

      // Master gets only operating + CSR — the burn share is genuinely burned.
      expect(dMaster).to.equal(masterAmt);
      expect(supplyBefore - (await enc.totalSupply())).to.equal(burnAmt);
    });

    it("boundary: headroom exactly equals the burn share — burns it all, redirects nothing, lands exactly on 990M", async () => {
      const { enc, commission, vault, treasury, enishiMaster, userA, root } =
        await loadFixture(fixture);

      const amount = toENC(1000);
      const referralAmt = (amount * DEFAULT_REFERRAL_BPS) / BPS_DENOM;
      const operatingAmt = (amount * DEFAULT_OPERATING_BPS) / BPS_DENOM;
      const csrAmt = (amount * DEFAULT_CSR_BPS) / BPS_DENOM;
      const burnAmt = amount - referralAmt - operatingAmt - csrAmt; // 300

      // Leave headroom == burnAmt exactly.
      const supply = await enc.totalSupply();
      await enc.connect(treasury).burn(supply - PUBLIC_ALLOCATION - burnAmt);
      expect(await commission.remainingBurnCap()).to.equal(burnAmt);
      expect(await commission.isBurnFinished()).to.equal(false);

      await enc.connect(treasury).transfer(vault.address, amount);

      const [dRoot, dMaster] = await balanceChanges(
        enc,
        [root.address, enishiMaster.address],
        () => pushAndDistribute(enc, commission, vault, userA.address, amount),
      );

      expect(dRoot).to.equal(referralAmt);
      // Nothing redirected: master still receives only operating + CSR.
      expect(dMaster).to.equal(operatingAmt + csrAmt);
      // Supply lands exactly on the floor.
      expect(await enc.totalSupply()).to.equal(PUBLIC_ALLOCATION);
      expect(await commission.isBurnFinished()).to.equal(true);
      expect(await commission.remainingBurnCap()).to.equal(0n);
    });

    it("boundary: headroom one wei short — burns the headroom, redirects exactly one wei", async () => {
      const { enc, commission, vault, treasury, enishiMaster, userA } =
        await loadFixture(fixture);

      const amount = toENC(1000);
      const operatingAmt = (amount * DEFAULT_OPERATING_BPS) / BPS_DENOM;
      const csrAmt = (amount * DEFAULT_CSR_BPS) / BPS_DENOM;
      const burnAmt = (amount * DEFAULT_BURN_BPS) / BPS_DENOM;
      const headroom = burnAmt - 1n;

      const supply = await enc.totalSupply();
      await enc.connect(treasury).burn(supply - PUBLIC_ALLOCATION - headroom);
      await enc.connect(treasury).transfer(vault.address, amount);

      const supplyBefore = await enc.totalSupply();
      const [dMaster] = await balanceChanges(enc, [enishiMaster.address], () =>
        pushAndDistribute(enc, commission, vault, userA.address, amount),
      );

      expect(supplyBefore - (await enc.totalSupply())).to.equal(headroom);
      expect(dMaster).to.equal(operatingAmt + csrAmt + 1n);
      expect(await enc.totalSupply()).to.equal(PUBLIC_ALLOCATION);
    });

    it("effective operating share is 40% of the settled amount once burning stops", async () => {
      const { enc, commission, vault, treasury, enishiMaster, userA } =
        await loadFixture(fixture);

      const supply = await enc.totalSupply();
      await enc.connect(treasury).burn(supply - PUBLIC_ALLOCATION);

      const amount = toENC(1000);
      await enc.connect(treasury).transfer(vault.address, amount);

      const [dMaster] = await balanceChanges(enc, [enishiMaster.address], () =>
        pushAndDistribute(enc, commission, vault, userA.address, amount),
      );

      // Spec: burn 30% is added to operating 10% → operating becomes 40%.
      const operatingEffective =
        (amount * (DEFAULT_OPERATING_BPS + DEFAULT_BURN_BPS)) / BPS_DENOM;
      const csrAmt = (amount * DEFAULT_CSR_BPS) / BPS_DENOM;
      expect(dMaster - csrAmt).to.equal(operatingEffective);
      expect(dMaster - csrAmt).to.equal((amount * 4000n) / BPS_DENOM);
    });

    it("Distributed event reports the capped burn and the inflated operating share", async () => {
      const { enc, commission, vault, treasury, userA, root } =
        await loadFixture(fixture);

      const amount = toENC(1000);
      const referralAmt = (amount * DEFAULT_REFERRAL_BPS) / BPS_DENOM;
      const operatingAmt = (amount * DEFAULT_OPERATING_BPS) / BPS_DENOM;
      const csrAmt = (amount * DEFAULT_CSR_BPS) / BPS_DENOM;
      const rawBurn = amount - referralAmt - operatingAmt - csrAmt;
      const headroom = toENC(100);

      const supply = await enc.totalSupply();
      await enc.connect(treasury).burn(supply - PUBLIC_ALLOCATION - headroom);
      await enc.connect(treasury).transfer(vault.address, amount);
      await enc.connect(vault).transfer(await commission.getAddress(), amount);

      await expect(commission.connect(vault).distribute(userA.address, amount))
        .to.emit(commission, "Distributed")
        .withArgs(
          userA.address,
          root.address,
          amount,
          referralAmt,
          operatingAmt + (rawBurn - headroom), // redirected excess folded into operating
          csrAmt,
          headroom, // capped burn
        );
    });

    it("conserves the settled amount exactly when the burn share is partially redirected", async () => {
      const { enc, commission, vault, treasury, enishiMaster, userA, root } =
        await loadFixture(fixture);

      // Amount deliberately not divisible by the bps splits.
      const amount = 1_000_000_000_000_000_001n; // 1 ENC + 1 wei
      const headroom = 7n;

      const supply = await enc.totalSupply();
      await enc.connect(treasury).burn(supply - PUBLIC_ALLOCATION - headroom);
      await enc.connect(treasury).transfer(vault.address, amount);

      const supplyBefore = await enc.totalSupply();
      const commissionAddr = await commission.getAddress();
      const [dRoot, dMaster, dCommission] = await balanceChanges(
        enc,
        [root.address, enishiMaster.address, commissionAddr],
        () => pushAndDistribute(enc, commission, vault, userA.address, amount),
      );
      const burned = supplyBefore - (await enc.totalSupply());

      expect(burned).to.equal(headroom);
      expect(dCommission).to.equal(0n);
      // Nothing created, nothing stranded: the four shares sum to `amount`.
      expect(dRoot + dMaster + burned).to.equal(amount);
      expect(await enc.totalSupply()).to.equal(PUBLIC_ALLOCATION);
    });

    it("no referrer and burn finished: the master wallet receives 100% of the settled amount", async () => {
      const { enc, commission, vault, treasury, enishiMaster, userB } =
        await loadFixture(fixture);

      const supply = await enc.totalSupply();
      await enc.connect(treasury).burn(supply - PUBLIC_ALLOCATION);

      const amount = toENC(1000);
      await enc.connect(treasury).transfer(vault.address, amount);

      const supplyBefore = await enc.totalSupply();
      const [dMaster] = await balanceChanges(enc, [enishiMaster.address], () =>
        pushAndDistribute(enc, commission, vault, userB.address, amount),
      );

      expect(dMaster).to.equal(amount);
      expect(await enc.totalSupply()).to.equal(supplyBefore);
    });

    it("burnBps set to 0: nothing is burned even with headroom available", async () => {
      const { enc, commission, owner, vault, enishiMaster, userA } =
        await loadFixture(fixture);

      // referral 40% / operating 40% / csr 20% / burn 0%
      await commission.connect(owner).setSplit(4000, 4000, 2000, 0);

      const amount = toENC(1000);
      const supplyBefore = await enc.totalSupply();
      const [dMaster] = await balanceChanges(enc, [enishiMaster.address], () =>
        pushAndDistribute(enc, commission, vault, userA.address, amount),
      );

      expect(await enc.totalSupply()).to.equal(supplyBefore);
      expect(dMaster).to.equal((amount * 6000n) / BPS_DENOM);
    });

    it("repeated settlements can never push supply below the 990M floor", async () => {
      const { enc, commission, vault, treasury, userA } = await loadFixture(fixture);

      // Sit 250 ENC above the floor, then settle 1000 ENC five times over
      // (burn share 300 each → would overshoot on the first press alone).
      const supply = await enc.totalSupply();
      await enc.connect(treasury).burn(supply - PUBLIC_ALLOCATION - toENC(250));
      await enc.connect(treasury).transfer(vault.address, toENC(5000));

      let previousCap = await commission.remainingBurnCap();
      for (let i = 0; i < 5; i++) {
        await pushAndDistribute(enc, commission, vault, userA.address, toENC(1000));
        const cap = await commission.remainingBurnCap();
        expect(await enc.totalSupply()).to.be.gte(PUBLIC_ALLOCATION);
        expect(cap).to.be.lte(previousCap); // monotonically non-increasing
        previousCap = cap;
      }

      expect(await enc.totalSupply()).to.equal(PUBLIC_ALLOCATION);
      expect(await commission.isBurnFinished()).to.equal(true);
      expect(await commission.remainingBurnCap()).to.equal(0n);
    });

    it("supply already below the floor: cap is 0, burning stays off and distribution still settles", async () => {
      const { enc, commission, vault, treasury, enishiMaster, userA, root } =
        await loadFixture(fixture);

      // An outside burn (e.g. ENCLock force-unlock) drags supply under the floor.
      const supply = await enc.totalSupply();
      await enc.connect(treasury).burn(supply - PUBLIC_ALLOCATION + toENC(1_000_000));

      expect(await enc.totalSupply()).to.be.lt(PUBLIC_ALLOCATION);
      expect(await commission.remainingBurnCap()).to.equal(0n);
      expect(await commission.isBurnFinished()).to.equal(true);

      const amount = toENC(1000);
      await enc.connect(treasury).transfer(vault.address, amount);
      const supplyBefore = await enc.totalSupply();

      const [dRoot, dMaster] = await balanceChanges(
        enc,
        [root.address, enishiMaster.address],
        () => pushAndDistribute(enc, commission, vault, userA.address, amount),
      );

      expect(dRoot).to.equal((amount * DEFAULT_REFERRAL_BPS) / BPS_DENOM);
      expect(dMaster).to.equal((amount * 6000n) / BPS_DENOM);
      expect(await enc.totalSupply()).to.equal(supplyBefore);
    });

    it("commission contract holds 0 ENC after distribution even at burn cap", async () => {
      const { enc, commission, vault, treasury, userA } =
        await loadFixture(fixture);
      const supply = await enc.totalSupply();
      await enc.connect(treasury).burn(supply - PUBLIC_ALLOCATION);
      await enc.connect(treasury).transfer(vault.address, toENC(1000));
      await pushAndDistribute(enc, commission, vault, userA.address, toENC(1000));
      expect(await enc.balanceOf(await commission.getAddress())).to.equal(0n);
    });
  });
});
