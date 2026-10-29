import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ENC, ENCLock } from "../../typechain-types";

const DAY = 86400n;
const PLANS = [
  { days: 30,  bps: 2100 },
  { days: 180, bps: 1800 },
  { days: 360, bps: 1500 },
  { days: 720, bps: 1000 },
];
const NO_STAKING_BPS = 2500;
const FORCE_BURN_BPS = 1000n;
const BPS_DENOM      = 10_000n;

const toENC = (n: number) => ethers.parseEther(String(n));

/** Sign an EIP-2612 ENC permit. ENC's EIP-712 domain name is "Enishi". */
async function signEncPermit(
  enc: ENC,
  owner: any,
  spender: string,
  value: bigint,
  deadline: bigint,
) {
  const domain = {
    name: "Enishi",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await enc.getAddress(),
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
  const nonce = await enc.nonces(owner.address);
  const sig = await owner.signTypedData(domain, types, { owner: owner.address, spender, value, nonce, deadline });
  return ethers.Signature.from(sig);
}

describe("ENCLock", () => {
  async function fixture() {
    const [owner, treasury, userA, userB, stranger, enishiMasterWallet] = await ethers.getSigners();

    // ENC
    const ENCFactory = await ethers.getContractFactory("ENC");
    const enc = (await ENCFactory.deploy()) as unknown as ENC;
    await enc.waitForDeployment();
    await enc.mintGenesis(treasury.address, stranger.address);

    // ENCLock — deployer (signers[0]) becomes owner.
    const LockFactory = await ethers.getContractFactory("ENCLock");
    const lock = (await LockFactory.deploy(
      await enc.getAddress(),
      enishiMasterWallet.address
    )) as unknown as ENCLock;
    await lock.waitForDeployment();

    // fund userA and userB from treasury
    await enc.connect(treasury).transfer(userA.address, toENC(10_000));
    await enc.connect(treasury).transfer(userB.address, toENC(10_000));

    // approve lock contract
    await enc.connect(userA).approve(await lock.getAddress(), ethers.MaxUint256);
    await enc.connect(userB).approve(await lock.getAddress(), ethers.MaxUint256);

    return { enc, lock, owner, treasury, userA, userB, stranger, enishiMasterWallet };
  }

  // ─── constructor ────────────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("sets ENC_TOKEN", async () => {
      const { enc, lock } = await loadFixture(fixture);
      expect(await lock.ENC_TOKEN()).to.equal(await enc.getAddress());
    });

    it("registers all plans", async () => {
      const { lock } = await loadFixture(fixture);
      const durations = await lock.getValidDurations();
      expect(durations.map(Number)).to.deep.equal(PLANS.map(p => p.days));
      for (const p of PLANS) {
        expect(await lock.commissionBps(p.days)).to.equal(p.bps);
      }
    });

    it("reverts if enc is zero address", async () => {
      const { enishiMasterWallet } = await loadFixture(fixture);
      const LockFactory = await ethers.getContractFactory("ENCLock");
      await expect(
        LockFactory.deploy(ethers.ZeroAddress, enishiMasterWallet.address)
      ).to.be.revertedWithCustomError(LockFactory, "ZeroAddress");
    });

    it("reverts if enishiMasterWallet is zero address", async () => {
      const { enc } = await loadFixture(fixture);
      const LockFactory = await ethers.getContractFactory("ENCLock");
      await expect(
        LockFactory.deploy(await enc.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(LockFactory, "ZeroAddress");
    });
  });

  // ─── lock ─────────────────────────────────────────────────────────────────────

  describe("lock", () => {
    it("locks ENC and emits Locked event", async () => {
      const { lock, userA } = await loadFixture(fixture);
      await expect(lock.connect(userA).lock(toENC(100), 30))
        .to.emit(lock, "Locked")
        .withArgs(userA.address, toENC(100), 30, (v: bigint) => v > 0n);

      const info = await lock.lockOf(userA.address);
      expect(info.amount).to.equal(toENC(100));
      expect(info.durationDays).to.equal(30);
    });

    it("transfers ENC from user to contract", async () => {
      const { enc, lock, userA } = await loadFixture(fixture);
      const lockAddr = await lock.getAddress();
      await expect(() => lock.connect(userA).lock(toENC(100), 30))
        .to.changeTokenBalances(enc, [userA, lockAddr], [-toENC(100), toENC(100)]);
    });

    it("reverts if already locked", async () => {
      const { lock, userA } = await loadFixture(fixture);
      await lock.connect(userA).lock(toENC(100), 30);
      await expect(lock.connect(userA).lock(toENC(100), 30))
        .to.be.revertedWithCustomError(lock, "AlreadyLocked");
    });

    it("reverts for invalid duration", async () => {
      const { lock, userA } = await loadFixture(fixture);
      await expect(lock.connect(userA).lock(toENC(100), 99))
        .to.be.revertedWithCustomError(lock, "InvalidDuration");
    });

    it("reverts for zero amount", async () => {
      const { lock, userA } = await loadFixture(fixture);
      await expect(lock.connect(userA).lock(0n, 30))
        .to.be.revertedWithCustomError(lock, "ZeroAmount");
    });
  });

  // ─── lockWithPermit ───────────────────────────────────────────────────────────

  describe("lockWithPermit", () => {
    it("locks without prior approve using permit", async () => {
      const { enc, lock, userA } = await loadFixture(fixture);
      // reset allowance to 0 to prove permit is used
      await enc.connect(userA).approve(await lock.getAddress(), 0n);

      const amount   = toENC(100);
      const deadline = BigInt(await time.latest()) + 3600n;
      const nonce    = await enc.nonces(userA.address);
      const domain   = { name: "Enishi", version: "1", chainId: 31337n, verifyingContract: await enc.getAddress() };
      const types    = { Permit: [
        { name: "owner",   type: "address" },
        { name: "spender", type: "address" },
        { name: "value",   type: "uint256" },
        { name: "nonce",   type: "uint256" },
        { name: "deadline",type: "uint256" },
      ]};
      const value = { owner: userA.address, spender: await lock.getAddress(), value: amount, nonce, deadline };
      const sig = await userA.signTypedData(domain, types, value);
      const { v, r, s } = ethers.Signature.from(sig);

      await expect(lock.connect(userA).lockWithPermit(amount, 30, deadline, v, r, s))
        .to.emit(lock, "Locked");
    });

    it("still locks when a front-runner already submitted the permit", async () => {
      const { enc, lock, userA, stranger } = await loadFixture(fixture);
      const lockAddr = await lock.getAddress();
      await enc.connect(userA).approve(lockAddr, 0n);

      const amount = toENC(100);
      const deadline = BigInt(await time.latest()) + 3600n;
      const { v, r, s } = await signEncPermit(enc, userA, lockAddr, amount, deadline);
      // Griefer lifts the signature from the mempool and burns the nonce first.
      await enc.connect(stranger).permit(userA.address, lockAddr, amount, deadline, v, r, s);

      await expect(lock.connect(userA).lockWithPermit(amount, 30, deadline, v, r, s))
        .to.emit(lock, "Locked");
      expect((await lock.lockOf(userA.address)).amount).to.equal(amount);
    });

    it("reverts ERC20InsufficientAllowance when the permit is invalid and nothing is approved", async () => {
      const { enc, lock, userA } = await loadFixture(fixture);
      const lockAddr = await lock.getAddress();
      await enc.connect(userA).approve(lockAddr, 0n);

      const amount = toENC(100);
      const expired = BigInt(await time.latest()) - 1n;
      const { v, r, s } = await signEncPermit(enc, userA, lockAddr, amount, expired);

      await expect(lock.connect(userA).lockWithPermit(amount, 30, expired, v, r, s))
        .to.be.revertedWithCustomError(enc, "ERC20InsufficientAllowance");
    });
  });

  // ─── topUpWithPermit ──────────────────────────────────────────────────────────

  describe("topUpWithPermit", () => {
    async function lockedNoAllowanceFixture() {
      const ctx = await loadFixture(fixture);
      await ctx.lock.connect(ctx.userA).lock(toENC(100), 30);
      await ctx.enc.connect(ctx.userA).approve(await ctx.lock.getAddress(), 0n);
      return ctx;
    }

    it("tops up without prior approve using permit", async () => {
      const { enc, lock, userA } = await lockedNoAllowanceFixture();
      const lockAddr = await lock.getAddress();
      const deadline = BigInt(await time.latest()) + 3600n;
      const { v, r, s } = await signEncPermit(enc, userA, lockAddr, toENC(50), deadline);

      await expect(lock.connect(userA).topUpWithPermit(toENC(50), deadline, v, r, s))
        .to.emit(lock, "ToppedUp");
      expect((await lock.lockOf(userA.address)).amount).to.equal(toENC(150));
    });

    it("still tops up when a front-runner already submitted the permit", async () => {
      const { enc, lock, userA, stranger } = await lockedNoAllowanceFixture();
      const lockAddr = await lock.getAddress();
      const deadline = BigInt(await time.latest()) + 3600n;
      const { v, r, s } = await signEncPermit(enc, userA, lockAddr, toENC(50), deadline);
      await enc.connect(stranger).permit(userA.address, lockAddr, toENC(50), deadline, v, r, s);

      await expect(lock.connect(userA).topUpWithPermit(toENC(50), deadline, v, r, s))
        .to.emit(lock, "ToppedUp");
      expect((await lock.lockOf(userA.address)).amount).to.equal(toENC(150));
    });

    it("reverts ERC20InsufficientAllowance when the permit is invalid and nothing is approved", async () => {
      const { enc, lock, userA } = await lockedNoAllowanceFixture();
      const lockAddr = await lock.getAddress();
      const expired = BigInt(await time.latest()) - 1n;
      const { v, r, s } = await signEncPermit(enc, userA, lockAddr, toENC(50), expired);

      await expect(lock.connect(userA).topUpWithPermit(toENC(50), expired, v, r, s))
        .to.be.revertedWithCustomError(enc, "ERC20InsufficientAllowance");
    });
  });

  // ─── topUp ────────────────────────────────────────────────────────────────────

  describe("topUp", () => {
    async function lockedFixture() {
      const ctx = await loadFixture(fixture);
      await ctx.lock.connect(ctx.userA).lock(toENC(100), 30);
      return ctx;
    }

    it("adds amount and resets expiry", async () => {
      const { lock, userA } = await lockedFixture();
      const before = await lock.lockOf(userA.address);
      await lock.connect(userA).topUp(toENC(50));
      const after = await lock.lockOf(userA.address);

      expect(after.amount).to.equal(before.amount + toENC(50));
      expect(after.expiry).to.be.gte(before.expiry);
    });

    it("emits ToppedUp event", async () => {
      const { lock, userA } = await lockedFixture();
      await expect(lock.connect(userA).topUp(toENC(50)))
        .to.emit(lock, "ToppedUp")
        .withArgs(userA.address, toENC(50), toENC(150), (v: bigint) => v > 0n);
    });

    it("reverts if not locked", async () => {
      const { lock, userA } = await loadFixture(fixture);
      await expect(lock.connect(userA).topUp(toENC(50)))
        .to.be.revertedWithCustomError(lock, "NotLocked");
    });

    it("reverts if lock expired", async () => {
      const { lock, userA } = await lockedFixture();
      await time.increase(31 * Number(DAY));
      await expect(lock.connect(userA).topUp(toENC(50)))
        .to.be.revertedWithCustomError(lock, "LockExpired");
    });

    it("reverts for zero amount", async () => {
      const { lock, userA } = await lockedFixture();
      await expect(lock.connect(userA).topUp(0n))
        .to.be.revertedWithCustomError(lock, "ZeroAmount");
    });
  });

  // ─── changePlan ───────────────────────────────────────────────────────────────

  describe("changePlan", () => {
    async function lockedFixture() {
      const ctx = await loadFixture(fixture);
      await ctx.lock.connect(ctx.userA).lock(toENC(100), 30);
      return ctx;
    }

    it("upgrades plan and resets expiry", async () => {
      const { lock, userA } = await lockedFixture();
      await expect(lock.connect(userA).changePlan(180))
        .to.emit(lock, "PlanChanged")
        .withArgs(userA.address, 180, (v: bigint) => v > 0n);

      const info = await lock.lockOf(userA.address);
      expect(info.durationDays).to.equal(180);
    });

    it("reverts if new plan <= remaining days", async () => {
      const { lock, userA } = await lockedFixture();
      // 29 days remaining, trying to change to 30 days plan — not allowed (30 <= 29 is false, but 30 == 30 is <=)
      await expect(lock.connect(userA).changePlan(30))
        .to.be.revertedWithCustomError(lock, "PlanDowngradeNotAllowed");
    });

    it("reverts if lock expired", async () => {
      const { lock, userA } = await lockedFixture();
      await time.increase(31 * Number(DAY));
      await expect(lock.connect(userA).changePlan(180))
        .to.be.revertedWithCustomError(lock, "LockExpired");
    });

    it("reverts if not locked", async () => {
      const { lock, userA } = await loadFixture(fixture);
      await expect(lock.connect(userA).changePlan(180))
        .to.be.revertedWithCustomError(lock, "NotLocked");
    });
  });

  // ─── unlock ───────────────────────────────────────────────────────────────────

  describe("unlock", () => {
    async function lockedFixture() {
      const ctx = await loadFixture(fixture);
      await ctx.lock.connect(ctx.userA).lock(toENC(100), 30);
      return ctx;
    }

    it("returns full balance after expiry", async () => {
      const { enc, lock, userA } = await lockedFixture();
      await time.increase(31 * Number(DAY));

      await expect(() => lock.connect(userA).unlock())
        .to.changeTokenBalances(enc, [userA, await lock.getAddress()], [toENC(100), -toENC(100)]);
    });

    it("emits Unlocked with zero burned after expiry", async () => {
      const { lock, userA } = await lockedFixture();
      await time.increase(31 * Number(DAY));
      await expect(lock.connect(userA).unlock())
        .to.emit(lock, "Unlocked")
        .withArgs(userA.address, toENC(100), 0n);
    });

    it("burns 10% and returns 90% when unlocking before expiry", async () => {
      const { enc, lock, userA } = await lockedFixture();
      const amount   = toENC(100);
      const burned   = (amount * FORCE_BURN_BPS) / BPS_DENOM;
      const returned = amount - burned;

      await expect(() => lock.connect(userA).unlock())
        .to.changeTokenBalances(enc, [userA, await lock.getAddress()], [returned, -amount]);
    });

    it("emits Unlocked with burned amount when unlocking before expiry", async () => {
      const { lock, userA } = await lockedFixture();
      const amount   = toENC(100);
      const burned   = (amount * FORCE_BURN_BPS) / BPS_DENOM;
      const returned = amount - burned;

      await expect(lock.connect(userA).unlock())
        .to.emit(lock, "Unlocked")
        .withArgs(userA.address, returned, burned);
    });

    it("clears lock state", async () => {
      const { lock, userA } = await lockedFixture();
      await time.increase(31 * Number(DAY));
      await lock.connect(userA).unlock();

      const info = await lock.lockOf(userA.address);
      expect(info.amount).to.equal(0n);
    });

    it("reverts if not locked", async () => {
      const { lock, userB } = await loadFixture(fixture);
      await expect(lock.connect(userB).unlock())
        .to.be.revertedWithCustomError(lock, "NotLocked");
    });

    it("sends the full force-unlock share to enishiMasterWallet regardless of ENC.totalSupply()", async () => {
      const { enc, lock, treasury, userA, stranger, enishiMasterWallet } = await loadFixture(fixture);

      const staked = toENC(100);
      await lock.connect(userA).lock(staked, 30);

      // Drive total supply well below ENCCommission's 990,000,000-ENC burn floor.
      // ENCLock has no such concept — the force-unlock share is a plain transfer,
      // never a burn, so nothing here should be capped. The genesis mint now
      // splits the supply between treasury and stranger (the Public Sale
      // carve-out), so stranger burns its whole balance and treasury burns the
      // rest of the excess, landing totalSupply() exactly at target.
      const target = toENC(500_000);
      const strangerBalance = await enc.balanceOf(stranger.address);
      await enc.connect(stranger).burn(strangerBalance);
      const supply = await enc.totalSupply();
      await enc.connect(treasury).burn(supply - target);
      expect(await enc.totalSupply()).to.equal(target);

      const burnShare = (staked * FORCE_BURN_BPS) / BPS_DENOM;
      const returned  = staked - burnShare;

      const walletBefore = await enc.balanceOf(enishiMasterWallet.address);

      await expect(lock.connect(userA).unlock())
        .to.emit(lock, "Unlocked")
        .withArgs(userA.address, returned, burnShare);

      // totalSupply is unchanged — this was a transfer, not a burn.
      expect(await enc.totalSupply()).to.equal(target);
      expect(await enc.balanceOf(enishiMasterWallet.address) - walletBefore).to.equal(burnShare);
    });

  });

  // ─── restake ──────────────────────────────────────────────────────────────────

  describe("restake", () => {
    async function expiredFixture() {
      const ctx = await loadFixture(fixture);
      await ctx.lock.connect(ctx.userA).lock(toENC(100), 30);
      await time.increase(31 * Number(DAY));
      return ctx;
    }

    it("restakes with new plan after expiry", async () => {
      const { lock, userA } = await expiredFixture();
      await expect(lock.connect(userA).restake(180))
        .to.emit(lock, "Restaked")
        .withArgs(userA.address, toENC(100), 180, (v: bigint) => v > 0n);

      const info = await lock.lockOf(userA.address);
      expect(info.durationDays).to.equal(180);
      expect(info.amount).to.equal(toENC(100));
    });

    it("reverts if lock not yet expired", async () => {
      const { lock, userA } = await loadFixture(fixture);
      await lock.connect(userA).lock(toENC(100), 30);
      await expect(lock.connect(userA).restake(180))
        .to.be.revertedWithCustomError(lock, "LockNotExpired");
    });

    it("reverts for invalid duration", async () => {
      const { lock, userA } = await expiredFixture();
      await expect(lock.connect(userA).restake(99))
        .to.be.revertedWithCustomError(lock, "InvalidDuration");
    });

    it("reverts if not locked", async () => {
      const { lock, userB } = await loadFixture(fixture);
      await expect(lock.connect(userB).restake(30))
        .to.be.revertedWithCustomError(lock, "NotLocked");
    });
  });

  // ─── getCommissionBps ─────────────────────────────────────────────────────────

  describe("getCommissionBps", () => {
    it("returns 2500 if not locked", async () => {
      const { lock, userA } = await loadFixture(fixture);
      expect(await lock.getCommissionBps(userA.address)).to.equal(NO_STAKING_BPS);
    });

    it("returns plan bps when locked", async () => {
      for (const p of PLANS) {
        const ctx = await loadFixture(fixture);
        await ctx.lock.connect(ctx.userA).lock(toENC(100), p.days);
        expect(await ctx.lock.getCommissionBps(ctx.userA.address)).to.equal(p.bps);
      }
    });

    it("returns 2500 after lock expires", async () => {
      const { lock, userA } = await loadFixture(fixture);
      await lock.connect(userA).lock(toENC(100), 30);
      await time.increase(31 * Number(DAY));
      expect(await lock.getCommissionBps(userA.address)).to.equal(NO_STAKING_BPS);
    });
  });

  // ─── getCommissionBpsForAmount ────────────────────────────────────────────────

  describe("getCommissionBpsForAmount", () => {
    it("returns plan bps when amount <= locked balance", async () => {
      const { lock, userA } = await loadFixture(fixture);
      await lock.connect(userA).lock(toENC(100), 30);
      expect(await lock.getCommissionBpsForAmount(userA.address, toENC(100))).to.equal(2100);
      expect(await lock.getCommissionBpsForAmount(userA.address, toENC(50))).to.equal(2100);
    });

    it("returns 2500 when amount > locked balance", async () => {
      const { lock, userA } = await loadFixture(fixture);
      await lock.connect(userA).lock(toENC(100), 30);
      expect(await lock.getCommissionBpsForAmount(userA.address, toENC(101))).to.equal(NO_STAKING_BPS);
    });

    it("returns 2500 if not locked", async () => {
      const { lock, userA } = await loadFixture(fixture);
      expect(await lock.getCommissionBpsForAmount(userA.address, toENC(1))).to.equal(NO_STAKING_BPS);
    });
  });

});
