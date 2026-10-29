import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { WhiteList } from "../../typechain-types";

describe("WhiteList", () => {
  let whitelist: WhiteList;
  let admin: SignerWithAddress;
  let operator: SignerWithAddress;
  let userA: SignerWithAddress;
  let userB: SignerWithAddress;
  let stranger: SignerWithAddress;
  let seoas: string[];

  let OPERATOR_ROLE: string;
  let DEFAULT_ADMIN_ROLE: string;

  const makeAddrs = (n: number) => seoas.slice(0, n);

  beforeEach(async () => {
    const signers = await ethers.getSigners();
    [admin, operator, userA, userB, stranger] = signers;
    seoas = Array.from(
      { length: 64 },
      () => ethers.Wallet.createRandom().address,
    );

    const Factory = await ethers.getContractFactory("WhiteList");
    whitelist = (await Factory.connect(admin).deploy(
      operator.address,
    )) as unknown as WhiteList;
    await whitelist.waitForDeployment();

    OPERATOR_ROLE = await whitelist.OPERATOR_ROLE();
    DEFAULT_ADMIN_ROLE = await whitelist.DEFAULT_ADMIN_ROLE();
  });

  // ─── Deployment ─────────────────────────────────────────────────────────────

  describe("Deployment", () => {
    it("grants DEFAULT_ADMIN_ROLE to deployer and OPERATOR_ROLE to operator", async () => {
      expect(await whitelist.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await whitelist.hasRole(OPERATOR_ROLE, operator.address)).to.be.true;

      // Admin should NOT have OPERATOR_ROLE by default.
      expect(await whitelist.hasRole(OPERATOR_ROLE, admin.address)).to.be.false;
      // Operator should NOT have DEFAULT_ADMIN_ROLE.
      expect(await whitelist.hasRole(DEFAULT_ADMIN_ROLE, operator.address)).to.be.false;
    });

    it("sets constants correctly", async () => {
      expect(await whitelist.SEOAS_PER_USER()).to.equal(7);
      expect(await whitelist.poolSize()).to.equal(0);
      expect(await whitelist.cursor()).to.equal(0);
    });

    it("reverts if operator is zero address", async () => {
      const Factory = await ethers.getContractFactory("WhiteList");
      await expect(
        Factory.deploy(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(whitelist, "ZeroAddress");
    });
  });

  // ─── Role management (AccessControl native API) ─────────────────────────────

  describe("Role management", () => {
    it("admin can grant OPERATOR_ROLE to another address", async () => {
      await whitelist.connect(admin).grantRole(OPERATOR_ROLE, stranger.address);
      expect(await whitelist.hasRole(OPERATOR_ROLE, stranger.address)).to.be.true;
    });

    it("admin can revoke OPERATOR_ROLE", async () => {
      await whitelist.connect(admin).revokeRole(OPERATOR_ROLE, operator.address);
      expect(await whitelist.hasRole(OPERATOR_ROLE, operator.address)).to.be.false;
    });

    it("non-admin cannot grant OPERATOR_ROLE", async () => {
      await expect(
        whitelist.connect(stranger).grantRole(OPERATOR_ROLE, stranger.address),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("multiple operators can hold the role simultaneously", async () => {
      await whitelist.connect(admin).grantRole(OPERATOR_ROLE, stranger.address);
      expect(await whitelist.hasRole(OPERATOR_ROLE, operator.address)).to.be.true;
      expect(await whitelist.hasRole(OPERATOR_ROLE, stranger.address)).to.be.true;
    });

    it("emits RoleGranted / RoleRevoked", async () => {
      await expect(
        whitelist.connect(admin).grantRole(OPERATOR_ROLE, stranger.address),
      )
        .to.emit(whitelist, "RoleGranted")
        .withArgs(OPERATOR_ROLE, stranger.address, admin.address);

      await expect(
        whitelist.connect(admin).revokeRole(OPERATOR_ROLE, stranger.address),
      )
        .to.emit(whitelist, "RoleRevoked")
        .withArgs(OPERATOR_ROLE, stranger.address, admin.address);
    });
  });

  // ─── registerSEOAs ───────────────────────────────────────────────────────────

  describe("registerSEOAs", () => {
    it("admin registers SEOAs into the pool", async () => {
      const addrs = makeAddrs(3);
      await whitelist.connect(admin).registerSEOAs(addrs);

      expect(await whitelist.poolSize()).to.equal(3);
      expect(await whitelist.availableInPool()).to.equal(3);
      expect(await whitelist.isWhitelisted(addrs[0])).to.be.true;
      expect(await whitelist.isWhitelisted(addrs[2])).to.be.true;
    });

    it("appends across multiple calls", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(2));
      await whitelist.connect(admin).registerSEOAs(seoas.slice(2, 5));
      expect(await whitelist.poolSize()).to.equal(5);
    });

    it("reverts if non-admin", async () => {
      await expect(
        whitelist.connect(stranger).registerSEOAs(makeAddrs(1)),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("operator alone cannot register SEOAs", async () => {
      await expect(
        whitelist.connect(operator).registerSEOAs(makeAddrs(1)),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts on empty input", async () => {
      await expect(
        whitelist.connect(admin).registerSEOAs([]),
      ).to.be.revertedWithCustomError(whitelist, "EmptyInput");
    });

    it("reverts on zero address entry", async () => {
      await expect(
        whitelist.connect(admin).registerSEOAs([ethers.ZeroAddress]),
      ).to.be.revertedWithCustomError(whitelist, "ZeroAddress");
    });

    it("reverts on duplicate across calls", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(1));
      await expect(
        whitelist.connect(admin).registerSEOAs(makeAddrs(1)),
      ).to.be.revertedWithCustomError(whitelist, "SEOAAlreadyRegistered");
    });

    it("reverts on duplicate within same batch", async () => {
      const dup = [seoas[0], seoas[0]];
      await expect(
        whitelist.connect(admin).registerSEOAs(dup),
      ).to.be.revertedWithCustomError(whitelist, "SEOAAlreadyRegistered");
    });
  });

  // ─── pick ───────────────────────────────────────────────────────────────────

  describe("pick", () => {
    beforeEach(async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(21));
    });

    it("assigns exactly 7 SEOAs and records mapping", async () => {
      const assigned = await whitelist
        .connect(operator)
        .pick.staticCall(userA.address);
      expect(assigned).to.deep.equal(makeAddrs(7));

      await whitelist.connect(operator).pick(userA.address);

      expect(await whitelist.cursor()).to.equal(7);
      expect(await whitelist.userPicked(userA.address)).to.be.true;
      expect(await whitelist.getUserSEOAs(userA.address)).to.deep.equal(
        makeAddrs(7),
      );
      expect(await whitelist.seoaToUser(seoas[0])).to.equal(userA.address);
      expect(await whitelist.seoaToUser(seoas[6])).to.equal(userA.address);
    });

    it("two users get disjoint SEOAs", async () => {
      await whitelist.connect(operator).pick(userA.address);
      await whitelist.connect(operator).pick(userB.address);

      const aSEOAs = await whitelist.getUserSEOAs(userA.address);
      const bSEOAs = await whitelist.getUserSEOAs(userB.address);
      expect(aSEOAs).to.deep.equal(seoas.slice(0, 7));
      expect(bSEOAs).to.deep.equal(seoas.slice(7, 14));
      for (const a of aSEOAs) expect(bSEOAs).to.not.include(a);
    });

    it("three users get fully disjoint SEOAs (no overlap)", async () => {
      await whitelist.connect(operator).pick(userA.address);
      await whitelist.connect(operator).pick(userB.address);
      await whitelist.connect(operator).pick(stranger.address);

      const aSEOAs = await whitelist.getUserSEOAs(userA.address);
      const bSEOAs = await whitelist.getUserSEOAs(userB.address);
      const cSEOAs = await whitelist.getUserSEOAs(stranger.address);

      const all = [...aSEOAs, ...bSEOAs, ...cSEOAs];
      expect(new Set(all).size).to.equal(21);
      expect(await whitelist.cursor()).to.equal(21);
    });

    it("emits SEOAsPicked with full list", async () => {
      await expect(whitelist.connect(operator).pick(userA.address))
        .to.emit(whitelist, "SEOAsPicked")
        .withArgs(userA.address, makeAddrs(7));
    });

    it("reverts if caller does not have OPERATOR_ROLE", async () => {
      await expect(
        whitelist.connect(stranger).pick(userA.address),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );
      // Admin without OPERATOR_ROLE also reverts.
      await expect(
        whitelist.connect(admin).pick(userA.address),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("works after admin grants OPERATOR_ROLE to a new address", async () => {
      await whitelist.connect(admin).grantRole(OPERATOR_ROLE, stranger.address);
      await whitelist.connect(stranger).pick(userA.address);
      expect(await whitelist.userPicked(userA.address)).to.be.true;
    });

    it("stops working after admin revokes OPERATOR_ROLE", async () => {
      await whitelist.connect(admin).revokeRole(OPERATOR_ROLE, operator.address);
      await expect(
        whitelist.connect(operator).pick(userA.address),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts on zero user", async () => {
      await expect(
        whitelist.connect(operator).pick(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(whitelist, "ZeroAddress");
    });

    it("reverts if user already picked", async () => {
      await whitelist.connect(operator).pick(userA.address);
      await expect(
        whitelist.connect(operator).pick(userA.address),
      ).to.be.revertedWithCustomError(whitelist, "UserAlreadyPicked");
    });

    it("reverts on every subsequent pick for same user", async () => {
      await whitelist.connect(operator).pick(userA.address);
      for (let attempt = 2; attempt <= 4; attempt++) {
        await expect(
          whitelist.connect(operator).pick(userA.address),
          `pick attempt #${attempt} should revert`,
        ).to.be.revertedWithCustomError(whitelist, "UserAlreadyPicked");
      }
      // State unchanged.
      expect(await whitelist.userPicked(userA.address)).to.be.true;
      expect(await whitelist.getUserSEOAs(userA.address)).to.deep.equal(
        makeAddrs(7),
      );
      expect(await whitelist.cursor()).to.equal(7);
    });

    it("getUserSEOAs returns same 7 SEOAs across multiple calls (reuse pattern)", async () => {
      await whitelist.connect(operator).pick(userA.address);
      const first = await whitelist.getUserSEOAs(userA.address);
      const second = await whitelist.getUserSEOAs(userA.address);
      expect(first).to.deep.equal(makeAddrs(7));
      expect(second).to.deep.equal(first);
    });

    it("getUserSEOAs returns empty for unpicked user", async () => {
      expect(await whitelist.getUserSEOAs(userA.address)).to.deep.equal([]);
    });

    it("succeeds at exact pool boundary (cursor + 7 == poolLength)", async () => {
      await whitelist.connect(operator).pick(userA.address);
      await whitelist.connect(operator).pick(userB.address);
      await whitelist.connect(operator).pick(stranger.address);
      expect(await whitelist.cursor()).to.equal(21);
      expect(await whitelist.availableInPool()).to.equal(0);
    });

    it("availableInPool decreases by 7 after each pick", async () => {
      expect(await whitelist.availableInPool()).to.equal(21);
      await whitelist.connect(operator).pick(userA.address);
      expect(await whitelist.availableInPool()).to.equal(14);
      await whitelist.connect(operator).pick(userB.address);
      expect(await whitelist.availableInPool()).to.equal(7);
      await whitelist.connect(operator).pick(stranger.address);
      expect(await whitelist.availableInPool()).to.equal(0);
    });

    it("PoolExhausted error reports correct requested/available", async () => {
      await whitelist.connect(operator).pick(userA.address);
      await whitelist.connect(operator).pick(userB.address);
      await whitelist.connect(operator).pick(stranger.address);
      const extraUser = (await ethers.getSigners())[6];
      await expect(whitelist.connect(operator).pick(extraUser.address))
        .to.be.revertedWithCustomError(whitelist, "PoolExhausted")
        .withArgs(7, 0);
    });
  });

  // ─── Lookups & invariants ───────────────────────────────────────────────────

  describe("Lookups & invariants", () => {
    beforeEach(async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(14));
    });

    it("isWhitelisted returns false for unregistered address", async () => {
      const random = ethers.Wallet.createRandom().address;
      expect(await whitelist.isWhitelisted(random)).to.be.false;
      expect(await whitelist.isWhitelisted(ethers.ZeroAddress)).to.be.false;
    });

    it("seoaToUser returns zero for unpicked SEOA", async () => {
      for (let i = 0; i < 14; i++) {
        expect(await whitelist.seoaToUser(seoas[i])).to.equal(
          ethers.ZeroAddress,
        );
      }
    });

    it("seoaToUser returns owner only for picked SEOAs", async () => {
      await whitelist.connect(operator).pick(userA.address);
      for (let i = 0; i < 7; i++) {
        expect(await whitelist.seoaToUser(seoas[i])).to.equal(userA.address);
      }
      for (let i = 7; i < 14; i++) {
        expect(await whitelist.seoaToUser(seoas[i])).to.equal(
          ethers.ZeroAddress,
        );
      }
    });

    it("userPicked is consistent with getUserSEOAs", async () => {
      expect(await whitelist.userPicked(userA.address)).to.be.false;
      expect(await whitelist.getUserSEOAs(userA.address)).to.deep.equal([]);

      await whitelist.connect(operator).pick(userA.address);

      expect(await whitelist.userPicked(userA.address)).to.be.true;
      expect(await whitelist.getUserSEOAs(userA.address)).to.have.lengthOf(7);
    });
  });

  // ─── Pausable ───────────────────────────────────────────────────────────────

  describe("Pausable", () => {
    beforeEach(async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(14));
    });

    it("admin can pause and unpause", async () => {
      await expect(whitelist.connect(admin).pause()).to.emit(whitelist, "Paused");
      expect(await whitelist.paused()).to.be.true;

      await expect(whitelist.connect(admin).unpause()).to.emit(
        whitelist,
        "Unpaused",
      );
      expect(await whitelist.paused()).to.be.false;
    });

    it("non-admin cannot pause", async () => {
      await expect(
        whitelist.connect(stranger).pause(),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("non-admin cannot unpause", async () => {
      await whitelist.connect(admin).pause();
      await expect(
        whitelist.connect(stranger).unpause(),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("pick reverts when paused", async () => {
      await whitelist.connect(admin).pause();
      await expect(
        whitelist.connect(operator).pick(userA.address),
      ).to.be.revertedWithCustomError(whitelist, "EnforcedPause");
    });

    it("registerSEOAs reverts when paused", async () => {
      await whitelist.connect(admin).pause();
      await expect(
        whitelist.connect(admin).registerSEOAs(seoas.slice(14, 17)),
      ).to.be.revertedWithCustomError(whitelist, "EnforcedPause");
    });

    it("operations resume after unpause", async () => {
      await whitelist.connect(admin).pause();
      await whitelist.connect(admin).unpause();
      await whitelist.connect(operator).pick(userA.address);
      expect(await whitelist.userPicked(userA.address)).to.be.true;
    });

    it("views remain functional while paused", async () => {
      await whitelist.connect(operator).pick(userA.address);
      await whitelist.connect(admin).pause();

      expect(await whitelist.userPicked(userA.address)).to.be.true;
      expect(await whitelist.getUserSEOAs(userA.address)).to.have.lengthOf(7);
      expect(await whitelist.cursor()).to.equal(7);
      expect(await whitelist.isWhitelisted(seoas[0])).to.be.true;
    });

    it("role management still works while paused", async () => {
      await whitelist.connect(admin).pause();
      await whitelist.connect(admin).grantRole(OPERATOR_ROLE, stranger.address);
      expect(await whitelist.hasRole(OPERATOR_ROLE, stranger.address)).to.be.true;
    });
  });

  // ─── Large batch ────────────────────────────────────────────────────────────

  describe("Large batch", () => {
    it("registers 200 SEOAs in a single batch without breaking invariants", async () => {
      const huge = Array.from(
        { length: 200 },
        () => ethers.Wallet.createRandom().address,
      );

      await whitelist.connect(admin).registerSEOAs(huge);

      expect(await whitelist.poolSize()).to.equal(200);
      expect(await whitelist.availableInPool()).to.equal(200);
      expect(await whitelist.isWhitelisted(huge[0])).to.be.true;
      expect(await whitelist.isWhitelisted(huge[199])).to.be.true;

      await whitelist.connect(operator).pick(userA.address);
      expect(await whitelist.getUserSEOAs(userA.address)).to.deep.equal(
        huge.slice(0, 7),
      );
    });
  });

  // ─── Boundary cases ─────────────────────────────────────────────────────────

  describe("Boundary cases", () => {
    it("pool of exactly 7 → 1 pick succeeds, 2nd reverts PoolExhausted(7, 0)", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(7));
      await whitelist.connect(operator).pick(userA.address);

      expect(await whitelist.cursor()).to.equal(7);
      expect(await whitelist.availableInPool()).to.equal(0);

      await expect(whitelist.connect(operator).pick(userB.address))
        .to.be.revertedWithCustomError(whitelist, "PoolExhausted")
        .withArgs(7, 0);
    });

    it("pool of 6 → 1st pick reverts PoolExhausted(7, 6)", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(6));
      await expect(whitelist.connect(operator).pick(userA.address))
        .to.be.revertedWithCustomError(whitelist, "PoolExhausted")
        .withArgs(7, 6);
    });

    it("pool of 8 → 1 pick succeeds (uses first 7), 2nd reverts PoolExhausted(7, 1)", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(8));
      await whitelist.connect(operator).pick(userA.address);
      expect(await whitelist.cursor()).to.equal(7);
      expect(await whitelist.availableInPool()).to.equal(1);

      await expect(whitelist.connect(operator).pick(userB.address))
        .to.be.revertedWithCustomError(whitelist, "PoolExhausted")
        .withArgs(7, 1);
    });

    it("17th SEOA remains available but unowned after first pick", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(8));
      await whitelist.connect(operator).pick(userA.address);

      expect(await whitelist.isWhitelisted(seoas[7])).to.be.true;
      expect(await whitelist.seoaToUser(seoas[7])).to.equal(ethers.ZeroAddress);
    });

    it("can extend pool after exhaustion to unblock further picks", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(7));
      await whitelist.connect(operator).pick(userA.address);
      // Pool exhausted, then admin adds more.
      await whitelist.connect(admin).registerSEOAs(seoas.slice(7, 14));
      await whitelist.connect(operator).pick(userB.address);
      expect(await whitelist.getUserSEOAs(userB.address)).to.deep.equal(
        seoas.slice(7, 14),
      );
    });
  });

  // ─── State consistency after revert ─────────────────────────────────────────

  describe("State consistency after revert", () => {
    it("registerSEOAs revert on dup does NOT increase poolLength", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(3));
      const before = await whitelist.poolLength();

      await expect(
        whitelist.connect(admin).registerSEOAs([seoas[2], seoas[3]]),
      ).to.be.revertedWithCustomError(whitelist, "SEOAAlreadyRegistered");

      expect(await whitelist.poolLength()).to.equal(before);
      // SEOA after the failing one must NOT be registered.
      expect(await whitelist.isWhitelisted(seoas[3])).to.be.false;
    });

    it("registerSEOAs revert on zero-address does NOT register any SEOA from the batch", async () => {
      const batch = [seoas[0], seoas[1], ethers.ZeroAddress, seoas[2]];
      await expect(
        whitelist.connect(admin).registerSEOAs(batch),
      ).to.be.revertedWithCustomError(whitelist, "ZeroAddress");

      expect(await whitelist.poolLength()).to.equal(0);
      expect(await whitelist.isWhitelisted(seoas[0])).to.be.false;
      expect(await whitelist.isWhitelisted(seoas[1])).to.be.false;
      expect(await whitelist.isWhitelisted(seoas[2])).to.be.false;
    });

    it("pick revert on UserAlreadyPicked does NOT advance cursor", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(21));
      await whitelist.connect(operator).pick(userA.address);
      const cursorBefore = await whitelist.cursor();

      await expect(
        whitelist.connect(operator).pick(userA.address),
      ).to.be.revertedWithCustomError(whitelist, "UserAlreadyPicked");

      expect(await whitelist.cursor()).to.equal(cursorBefore);
    });

    it("pick revert on PoolExhausted does NOT mark user as picked", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(5));
      await expect(
        whitelist.connect(operator).pick(userA.address),
      ).to.be.revertedWithCustomError(whitelist, "PoolExhausted");

      expect(await whitelist.userPicked(userA.address)).to.be.false;
      expect(await whitelist.cursor()).to.equal(0);
    });

    it("pick revert on zero address does NOT change cursor or pool", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(14));
      await expect(
        whitelist.connect(operator).pick(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(whitelist, "ZeroAddress");

      expect(await whitelist.cursor()).to.equal(0);
    });
  });

  // ─── Event args across multiple batches ─────────────────────────────────────

  describe("Event arg verification", () => {
    it("poolLength accumulates across multiple register batches", async () => {
      const b1 = seoas.slice(0, 5);
      const b2 = seoas.slice(5, 12);
      const b3 = seoas.slice(12, 13);

      await whitelist.connect(admin).registerSEOAs(b1);
      expect(await whitelist.poolSize()).to.equal(5);

      await whitelist.connect(admin).registerSEOAs(b2);
      expect(await whitelist.poolSize()).to.equal(12);

      await whitelist.connect(admin).registerSEOAs(b3);
      expect(await whitelist.poolSize()).to.equal(13);
    });

    it("SEOAsPicked emits SEOAs in cursor order, not arbitrary order", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(14));
      await whitelist.connect(operator).pick(userA.address);

      await expect(whitelist.connect(operator).pick(userB.address))
        .to.emit(whitelist, "SEOAsPicked")
        .withArgs(userB.address, seoas.slice(7, 14));
    });
  });

  // ─── Multi-batch ordering ───────────────────────────────────────────────────

  describe("Multi-batch ordering", () => {
    it("pick respects registration order across batches", async () => {
      // Register in 3 separate batches, then pick must consume in order.
      await whitelist.connect(admin).registerSEOAs(seoas.slice(0, 5));
      await whitelist.connect(admin).registerSEOAs(seoas.slice(5, 21));
      await whitelist.connect(admin).registerSEOAs(seoas.slice(21, 40));

      await whitelist.connect(operator).pick(userA.address);
      expect(await whitelist.getUserSEOAs(userA.address)).to.deep.equal(
        seoas.slice(0, 7),
      );

      await whitelist.connect(operator).pick(userB.address);
      expect(await whitelist.getUserSEOAs(userB.address)).to.deep.equal(
        seoas.slice(7, 14),
      );
    });
  });

  // ─── Renounce / brick scenarios ─────────────────────────────────────────────

  describe("Renounce scenarios", () => {
    it("operator renouncing OPERATOR_ROLE can no longer pick", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(7));
      await whitelist
        .connect(operator)
        .renounceRole(OPERATOR_ROLE, operator.address);

      expect(await whitelist.hasRole(OPERATOR_ROLE, operator.address)).to.be
        .false;

      await expect(
        whitelist.connect(operator).pick(userA.address),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("admin renouncing DEFAULT_ADMIN_ROLE can no longer register or pause (brick warning)", async () => {
      await whitelist
        .connect(admin)
        .renounceRole(DEFAULT_ADMIN_ROLE, admin.address);

      expect(await whitelist.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be
        .false;

      await expect(
        whitelist.connect(admin).registerSEOAs(makeAddrs(1)),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );

      await expect(
        whitelist.connect(admin).pause(),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );

      await expect(
        whitelist.connect(admin).grantRole(OPERATOR_ROLE, stranger.address),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("renounceRole reverts if not called by the account itself", async () => {
      await expect(
        whitelist
          .connect(admin)
          .renounceRole(OPERATOR_ROLE, operator.address),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlBadConfirmation",
      );
    });

    it("after operator renounce, admin can re-grant a new operator", async () => {
      await whitelist
        .connect(operator)
        .renounceRole(OPERATOR_ROLE, operator.address);
      await whitelist
        .connect(admin)
        .grantRole(OPERATOR_ROLE, stranger.address);

      await whitelist.connect(admin).registerSEOAs(makeAddrs(7));
      await whitelist.connect(stranger).pick(userA.address);
      expect(await whitelist.userPicked(userA.address)).to.be.true;
    });
  });

  // ─── Role admin relationships ───────────────────────────────────────────────

  describe("Role admin relationships", () => {
    it("DEFAULT_ADMIN_ROLE is admin of OPERATOR_ROLE", async () => {
      const roleAdmin = await whitelist.getRoleAdmin(OPERATOR_ROLE);
      expect(roleAdmin).to.equal(DEFAULT_ADMIN_ROLE);
    });

    it("DEFAULT_ADMIN_ROLE is admin of itself", async () => {
      const roleAdmin = await whitelist.getRoleAdmin(DEFAULT_ADMIN_ROLE);
      expect(roleAdmin).to.equal(DEFAULT_ADMIN_ROLE);
    });

    it("re-granting an already-held role is idempotent (no event)", async () => {
      // OZ 5.x: grantRole only emits RoleGranted if account didn't already have role.
      const tx = await whitelist
        .connect(admin)
        .grantRole(OPERATOR_ROLE, operator.address);
      const receipt = await tx.wait();
      const grantedLog = receipt?.logs.find((l) => {
        try {
          const parsed = whitelist.interface.parseLog({
            topics: [...l.topics],
            data: l.data,
          });
          return parsed?.name === "RoleGranted";
        } catch {
          return false;
        }
      });
      expect(grantedLog).to.be.undefined;
      expect(await whitelist.hasRole(OPERATOR_ROLE, operator.address)).to.be
        .true;
    });

    it("revoking a not-held role is idempotent (no event)", async () => {
      const tx = await whitelist
        .connect(admin)
        .revokeRole(OPERATOR_ROLE, stranger.address);
      const receipt = await tx.wait();
      const revokedLog = receipt?.logs.find((l) => {
        try {
          const parsed = whitelist.interface.parseLog({
            topics: [...l.topics],
            data: l.data,
          });
          return parsed?.name === "RoleRevoked";
        } catch {
          return false;
        }
      });
      expect(revokedLog).to.be.undefined;
    });

    it("supportsInterface returns true for AccessControl interface", async () => {
      // IAccessControl interfaceId per OZ 5.x = 0x7965db0b
      expect(await whitelist.supportsInterface("0x7965db0b")).to.be.true;
    });

    it("supportsInterface returns false for random interfaceId", async () => {
      expect(await whitelist.supportsInterface("0xdeadbeef")).to.be.false;
    });
  });

  // ─── Admin role transitivity ────────────────────────────────────────────────

  describe("Admin role transitivity", () => {
    it("admin can grant DEFAULT_ADMIN_ROLE to another address (2 admins coexist)", async () => {
      await expect(
        whitelist
          .connect(admin)
          .grantRole(DEFAULT_ADMIN_ROLE, stranger.address),
      )
        .to.emit(whitelist, "RoleGranted")
        .withArgs(DEFAULT_ADMIN_ROLE, stranger.address, admin.address);

      expect(await whitelist.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be
        .true;
      expect(await whitelist.hasRole(DEFAULT_ADMIN_ROLE, stranger.address)).to
        .be.true;
    });

    it("newly granted admin can grant OPERATOR_ROLE", async () => {
      await whitelist
        .connect(admin)
        .grantRole(DEFAULT_ADMIN_ROLE, stranger.address);

      await whitelist
        .connect(stranger)
        .grantRole(OPERATOR_ROLE, userA.address);
      expect(await whitelist.hasRole(OPERATOR_ROLE, userA.address)).to.be.true;
    });

    it("newly granted admin can call admin functions (registerSEOAs, pause)", async () => {
      await whitelist
        .connect(admin)
        .grantRole(DEFAULT_ADMIN_ROLE, stranger.address);

      await whitelist.connect(stranger).registerSEOAs(makeAddrs(3));
      expect(await whitelist.poolSize()).to.equal(3);

      await whitelist.connect(stranger).pause();
      expect(await whitelist.paused()).to.be.true;
    });

    it("admin can revoke another admin's DEFAULT_ADMIN_ROLE", async () => {
      await whitelist
        .connect(admin)
        .grantRole(DEFAULT_ADMIN_ROLE, stranger.address);

      await expect(
        whitelist
          .connect(admin)
          .revokeRole(DEFAULT_ADMIN_ROLE, stranger.address),
      )
        .to.emit(whitelist, "RoleRevoked")
        .withArgs(DEFAULT_ADMIN_ROLE, stranger.address, admin.address);

      expect(await whitelist.hasRole(DEFAULT_ADMIN_ROLE, stranger.address)).to
        .be.false;
    });

    it("admin can revoke their own DEFAULT_ADMIN_ROLE (brick risk)", async () => {
      // Self-revoke (different from renounce — uses revokeRole instead of renounceRole).
      await whitelist
        .connect(admin)
        .revokeRole(DEFAULT_ADMIN_ROLE, admin.address);

      expect(await whitelist.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be
        .false;
      // Contract now bricked — admin functions unreachable.
      await expect(
        whitelist.connect(admin).pause(),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("operator cannot revoke another operator (lacks admin role)", async () => {
      await whitelist
        .connect(admin)
        .grantRole(OPERATOR_ROLE, stranger.address);

      await expect(
        whitelist
          .connect(operator)
          .revokeRole(OPERATOR_ROLE, stranger.address),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );

      // stranger still has the role
      expect(await whitelist.hasRole(OPERATOR_ROLE, stranger.address)).to.be
        .true;
    });

    it("operator cannot revoke their own role via revokeRole (must use renounceRole)", async () => {
      // OZ 5.x: revokeRole requires admin role; renounceRole requires self.
      await expect(
        whitelist
          .connect(operator)
          .revokeRole(OPERATOR_ROLE, operator.address),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("operator cannot grant DEFAULT_ADMIN_ROLE", async () => {
      await expect(
        whitelist
          .connect(operator)
          .grantRole(DEFAULT_ADMIN_ROLE, stranger.address),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("operator cannot pause or unpause", async () => {
      await expect(
        whitelist.connect(operator).pause(),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );

      await whitelist.connect(admin).pause();
      await expect(
        whitelist.connect(operator).unpause(),
      ).to.be.revertedWithCustomError(
        whitelist,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("contract address can hold OPERATOR_ROLE and msg.sender check works for EOAs", async () => {
      // Grant a non-EOA-controlled address (the contract itself for simplicity).
      const wlAddr = await whitelist.getAddress();
      await whitelist.connect(admin).grantRole(OPERATOR_ROLE, wlAddr);
      expect(await whitelist.hasRole(OPERATOR_ROLE, wlAddr)).to.be.true;

      // The granted address is just a bytes value — `hasRole` doesn't validate it's a contract.
      // EOA operator still works as before.
      await whitelist.connect(admin).registerSEOAs(makeAddrs(7));
      await whitelist.connect(operator).pick(userA.address);
      expect(await whitelist.userPicked(userA.address)).to.be.true;
    });

    it("granting OPERATOR_ROLE to zero address does not revert (OZ does not check)", async () => {
      // Documents OZ AccessControl behavior — caller responsibility to validate.
      await expect(
        whitelist
          .connect(admin)
          .grantRole(OPERATOR_ROLE, ethers.ZeroAddress),
      ).to.not.be.reverted;
      expect(await whitelist.hasRole(OPERATOR_ROLE, ethers.ZeroAddress)).to.be
        .true;
    });
  });

  // ─── Re-grant after revoke ──────────────────────────────────────────────────

  describe("Operator rotation", () => {
    it("revoke + grant same operator works (rotation pattern)", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(14));

      await whitelist
        .connect(admin)
        .revokeRole(OPERATOR_ROLE, operator.address);
      await whitelist
        .connect(admin)
        .grantRole(OPERATOR_ROLE, operator.address);

      await whitelist.connect(operator).pick(userA.address);
      expect(await whitelist.userPicked(userA.address)).to.be.true;
    });

    it("rotated-out operator's previous picks remain valid", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(14));
      await whitelist.connect(operator).pick(userA.address);

      // Rotate: revoke old, grant new
      await whitelist
        .connect(admin)
        .revokeRole(OPERATOR_ROLE, operator.address);
      await whitelist
        .connect(admin)
        .grantRole(OPERATOR_ROLE, stranger.address);

      // userA's picks remain
      expect(await whitelist.userPicked(userA.address)).to.be.true;
      expect(await whitelist.getUserSEOAs(userA.address)).to.deep.equal(
        seoas.slice(0, 7),
      );

      // New operator can pick the next user
      await whitelist.connect(stranger).pick(userB.address);
      expect(await whitelist.getUserSEOAs(userB.address)).to.deep.equal(
        seoas.slice(7, 14),
      );
    });
  });

  // ─── Property / fuzz-style invariants ───────────────────────────────────────

  describe("Property invariants", () => {
    it("invariant: cursor == sum of SEOAs assigned across all users", async () => {
      const N_USERS = 5;
      const pool = Array.from(
        { length: 7 * N_USERS },
        () => ethers.Wallet.createRandom().address,
      );
      await whitelist.connect(admin).registerSEOAs(pool);
      const users = (await ethers.getSigners()).slice(5, 5 + N_USERS);

      let total = 0;
      for (const u of users) {
        await whitelist.connect(operator).pick(u.address);
        const list = await whitelist.getUserSEOAs(u.address);
        total += list.length;
      }

      expect(total).to.equal(Number(await whitelist.cursor()));
      expect(total).to.equal(7 * N_USERS);
    });

    it("invariant: every assigned SEOA maps back to its owner exactly", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(21));
      const users = (await ethers.getSigners()).slice(5, 8);

      for (const u of users) {
        await whitelist.connect(operator).pick(u.address);
        const list = await whitelist.getUserSEOAs(u.address);
        for (const s of list) {
          expect(await whitelist.seoaToUser(s)).to.equal(u.address);
        }
      }
    });

    it("invariant: no SEOA is assigned to two different users (5-user stress)", async () => {
      const N = 5;
      const pool = Array.from(
        { length: 7 * N },
        () => ethers.Wallet.createRandom().address,
      );
      await whitelist.connect(admin).registerSEOAs(pool);
      const users = (await ethers.getSigners()).slice(5, 5 + N);

      const seen = new Map<string, string>();
      for (const u of users) {
        await whitelist.connect(operator).pick(u.address);
        const list = await whitelist.getUserSEOAs(u.address);
        for (const s of list) {
          const key = s.toLowerCase();
          expect(seen.has(key), `SEOA ${s} double-assigned`).to.be.false;
          seen.set(key, u.address);
        }
      }
      expect(seen.size).to.equal(7 * N);
    });

    it("invariant: poolLength only ever increases", async () => {
      let prev = await whitelist.poolLength();
      for (let i = 0; i < 4; i++) {
        await whitelist
          .connect(admin)
          .registerSEOAs(seoas.slice(i * 4, (i + 1) * 4));
        const now = await whitelist.poolLength();
        expect(now).to.be.gt(prev);
        prev = now;
      }
    });

    it("invariant: cursor never exceeds poolLength", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(21));
      const users = (await ethers.getSigners()).slice(5, 8);
      for (const u of users) {
        await whitelist.connect(operator).pick(u.address);
        expect(await whitelist.cursor()).to.be.lte(
          await whitelist.poolLength(),
        );
      }
    });

    it("invariant: isWhitelisted iff seoa is in registered set (no false positives)", async () => {
      await whitelist.connect(admin).registerSEOAs(seoas.slice(0, 10));

      for (let i = 0; i < 10; i++) {
        expect(await whitelist.isWhitelisted(seoas[i])).to.be.true;
      }
      for (let i = 10; i < 20; i++) {
        expect(await whitelist.isWhitelisted(seoas[i])).to.be.false;
      }
      // Random external addresses
      for (let i = 0; i < 5; i++) {
        const random = ethers.Wallet.createRandom().address;
        expect(await whitelist.isWhitelisted(random)).to.be.false;
      }
    });
  });

  // ─── Gas snapshot (informational) ───────────────────────────────────────────

  describe("Gas snapshot", () => {
    it("pick gas stays within sane budget (< 600k)", async () => {
      await whitelist.connect(admin).registerSEOAs(makeAddrs(14));
      const tx = await whitelist.connect(operator).pick(userA.address);
      const receipt = await tx.wait();
      const gasUsed = Number(receipt!.gasUsed);
      // Soft ceiling — flag any future regression that blows past it.
      expect(gasUsed).to.be.lt(600_000, `pick gas = ${gasUsed}`);
    });

    it("registerSEOAs(64) gas stays within sane budget (< 3M)", async () => {
      const batch = Array.from(
        { length: 64 },
        () => ethers.Wallet.createRandom().address,
      );
      const tx = await whitelist.connect(admin).registerSEOAs(batch);
      const receipt = await tx.wait();
      const gasUsed = Number(receipt!.gasUsed);
      expect(gasUsed).to.be.lt(3_000_000, `register64 gas = ${gasUsed}`);
    });
  });

  // ─── Random fuzz-lite ───────────────────────────────────────────────────────

  describe("Random fuzz-lite", () => {
    it("100 random batches of varying size + 10 picks maintain all invariants", async () => {
      const allRegistered: string[] = [];
      let rng = 42;
      const nextSize = () => {
        // Deterministic PRNG so failures are reproducible.
        rng = (rng * 1103515245 + 12345) & 0x7fffffff;
        return (rng % 8) + 1; // 1..8
      };

      for (let i = 0; i < 20; i++) {
        const size = nextSize();
        const batch = Array.from(
          { length: size },
          () => ethers.Wallet.createRandom().address,
        );
        await whitelist.connect(admin).registerSEOAs(batch);
        allRegistered.push(...batch);
      }

      expect(await whitelist.poolLength()).to.equal(allRegistered.length);

      // Pick as many users as the pool allows.
      const signers = await ethers.getSigners();
      const maxPicks = Math.min(
        10,
        Math.floor(allRegistered.length / 7),
        signers.length - 5,
      );

      const assigned = new Set<string>();
      for (let i = 0; i < maxPicks; i++) {
        const user = signers[5 + i];
        await whitelist.connect(operator).pick(user.address);
        const list = await whitelist.getUserSEOAs(user.address);
        expect(list).to.have.lengthOf(7);
        for (const s of list) {
          expect(assigned.has(s.toLowerCase())).to.be.false;
          assigned.add(s.toLowerCase());
        }
      }

      expect(await whitelist.cursor()).to.equal(maxPicks * 7);
    });
  });
});
