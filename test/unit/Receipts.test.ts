import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Cross-token identity checks for all Enishi receipt tokens. Behavioural
 * coverage of the {EnToken} base lives in {EnBTC.test.ts}.
 */
const SPECS = [
  { contract: "EnBTC", name: "Enishi BTC", symbol: "enBTC" },
  { contract: "EnETH", name: "Enishi ETH", symbol: "enETH" },
  { contract: "EnXRP", name: "Enishi XRP", symbol: "enXRP" },
  { contract: "EnBNB", name: "Enishi BNB", symbol: "enBNB" },
  { contract: "EnSOL", name: "Enishi SOL", symbol: "enSOL" },
  { contract: "EnAVAX", name: "Enishi AVAX", symbol: "enAVAX" },
  { contract: "EnLINK", name: "Enishi LINK", symbol: "enLINK" },
] as const;

describe("Enishi receipt tokens — per-token identity", () => {
  for (const spec of SPECS) {
    describe(spec.contract, () => {
      it(`name = "${spec.name}"`, async () => {
        const F = await ethers.getContractFactory(spec.contract);
        const c = await F.deploy();
        expect(await c.name()).to.equal(spec.name);
      });

      it(`symbol = "${spec.symbol}"`, async () => {
        const F = await ethers.getContractFactory(spec.contract);
        const c = await F.deploy();
        expect(await c.symbol()).to.equal(spec.symbol);
      });

      it("decimals = 18 (ERC20 default)", async () => {
        const F = await ethers.getContractFactory(spec.contract);
        const c = await F.deploy();
        expect(await c.decimals()).to.equal(18);
      });
    });
  }
});
