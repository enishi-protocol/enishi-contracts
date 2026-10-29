# Enishi Protocol — Smart Contracts

[![Solidity](https://img.shields.io/badge/Solidity-0.8.24-363636?logo=solidity)](https://docs.soliditylang.org/en/v0.8.24/)
[![Hardhat](https://img.shields.io/badge/Hardhat-2.x-fff100?logo=hardhat)](https://hardhat.org)
[![OpenZeppelin](https://img.shields.io/badge/OpenZeppelin-5.x-4E5EE4?logo=openzeppelin)](https://docs.openzeppelin.com/contracts/5.x/)
[![Network](https://img.shields.io/badge/network-BNB%20Smart%20Chain-F0B90B?logo=binance)](https://www.bnbchain.org)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](#license)

Enishi is a DeFi vault protocol on BNB Smart Chain. Users deposit USDT, the
deposit is allocated across up to seven crypto strategy slots, and realised
profit is settled on-chain and shared between the user, the fund, referrers
and the ENC token economy. Swaps are executed by controlled operator wallets
(SEOAs) through per-user minimal-proxy swap contracts.

This repository contains the Solidity contracts and Hardhat deploy pipeline for
the protocol. The Graph subgraphs and the TypeScript SDK live in the
`enishi-blockchain` repository.

> **Architecture deep-dive:** [`docs/system-architecture.md`](docs/system-architecture.md) ·
> **Public Sale spec:** [`docs/specs/`](docs/specs/)

---

## Table of Contents

- [Contracts](#contracts)
- [Repository Layout](#repository-layout)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Post-Deploy Wiring](#post-deploy-wiring)
- [Security](#security)
- [License](#license)

---

## Contracts

| Contract | Path | Purpose | Access model |
|---|---|---|---|
| `Vault` | `contracts/Vault.sol` | Deposits, profit settlement, two-step exits | `Ownable` |
| `SwapContract` | `contracts/SwapContract.sol` | Per-user strategy position; executes SEOA swaps | Clone immutables (Vault, SEOA, tokens) |
| `SwapContractFactory` | `contracts/SwapContractFactory.sol` | Deploys `SwapContract` minimal proxies (`createBatch`) | `Ownable` |
| `WhiteList` | `contracts/WhiteList.sol` | SEOA pool and assignment (`registerSEOAs`, `pick`) | `AccessControl` |
| `ReferralRegistry` | `contracts/ReferralRegistry.sol` | One-time referrer binding per user | `AccessControl` |
| `ENC` | `contracts/token/ENC.sol` | ERC-20 (Permit, Burnable), fixed 3B supply, one-shot genesis mint | `Ownable` (renounced at mint) |
| `ENCVesting` | `contracts/token/ENCVesting.sol` | Holds and releases every non-sale ENC allocation | `AccessControl` |
| `EnishiPublicSale` | `contracts/EnishiPublicSale.sol` | Fixed-price ENC sale for USDT with locked, tranche-released lots; for 1090 days a lot's unclaimed ENC pays the buyer's commission at 10% | `AccessControl` |
| `ENCLock` | `contracts/token/ENCLock.sol` | ENC staking that lowers the user's ENC commission rate | `Ownable` |
| `ENCStakeRouter` | `contracts/token/ENCStakeRouter.sol` | The Vault's `STAKE_ROUTER` and commission policy: charges active Public Sale lots first, then `ENCLock`, from one DEX quote; the Vault falls back to 25% in USDT | `Ownable` |
| `ENCCommission` | `contracts/token/ENCCommission.sol` | Splits ENC commission: referrer / master wallet / burn | `Ownable` |
| `EnToken` (×7) | `contracts/token/receipts/` | Receipt tokens `EnBTC`, `EnETH`, `EnXRP`, `EnBNB`, `EnSOL`, `EnAVAX`, `EnLINK` | `Ownable` + Vault operator |

Supporting code: `contracts/interfaces/` (one interface per contract),
`contracts/libraries/` (`EnishiConstants`, per-network `EnishiAddresses*`,
Universal Router command guard) and `contracts/mocks/` (test doubles plus the
`*Testnet` variants described under [Networks](#networks)).

---

## Repository Layout

```
contracts/            Solidity sources (see Contracts)
deploy/               hardhat-deploy scripts 01 → 11 (see Deployment)
scripts/              Single-purpose wiring fix-up scripts
test/                 unit/, integration/, helpers/ (Hardhat + Chai)
helpers/              Shared TS constants for deploy scripts
deployments/          hardhat-deploy records per network (source of truth for addresses)
docs/                 Architecture and specifications
```

---

## Getting Started

**Prerequisites**

- Node.js 20+ and npm
- A BscScan API key (contract verification)
- A deployer wallet funded with BNB — a Ledger for production, a private key
  for staging/testnet/local

**Install, compile and test**

```bash
npm install
cp .env.example .env        # then fill in the values — see Configuration
npm run compile
npm test
```

| Command | Description |
|---|---|
| `npm run compile` | Compile contracts and generate TypeChain bindings |
| `npm test` | Run the full unit and integration suite |
| `npm run test:gas` | Run tests with the gas reporter |
| `npm run coverage` | Generate a Solidity coverage report |
| `npm run deploy:local` | Deploy everything to a local Hardhat node |
| `npm run verify -- --network <net> <address> <args…>` | Verify a contract on BscScan |

---

## Configuration

### Networks

| Network | Chain ID | Signer | Purpose |
|---|---|---|---|
| `bscMainnet` | 56 | Ledger (`LEDGER_ACCOUNT_MAINNET`) | Production |
| `bscStgMainet` | 56 | `DEPLOYER_PRIVATE_KEY` | Staging on mainnet, isolated in `deployments/bscStgMainet/` |
| `bscTestnet` | 97 | `DEPLOYER_PRIVATE_KEY` | Testnet |
| `localhost` / `hardhat` | 31337 | Hardhat accounts | Local development |

- `bscTestnet` deploys `ENCVestingTestnet`, `EnishiPublicSaleTestnet` and
  `VaultTestnet` under the standard deployment names. These variants add an
  operator-controlled clock (`warpBy` / `warpTo`) so schedules and exit delays
  can be fast-forwarded; they are never deployed to chain 56.
- `Vault` and `SwapContract` resolve external addresses (PancakeSwap, USDT,
  strategy tokens, receipt tokens) from `libraries/EnishiAddresses.sol` at
  compile time. When compiling for `bscTestnet`, `hardhat.config.ts`
  transparently substitutes `EnishiAddressesTestnet.sol`; no import changes
  are needed.

### Environment Variables

`.env.example` is the authoritative list. Deploy scripts fail fast if a
required variable is missing.

**Contract addresses are never read from `.env`.** Every script resolves the
contracts it depends on from `deployments/<network>/<Name>.json`, so
addresses flow from one step to the next without manual copying. `.env` holds
only signers, endpoints and wallet-type constructor arguments.

| Variable | Purpose | Used by |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | Signer for staging, testnet and local | Hardhat config |
| `LEDGER_ACCOUNT_MAINNET` | Ledger signer address for production | Hardhat config |
| `BSC_RPC_MAINNET`, `BSC_RPC_TESTNET` | RPC endpoints | Hardhat config |
| `BSCSCAN_API_KEY` | Contract verification | All deploy scripts |
| `REFER_ROOT` | Root referrer | `01` ReferralRegistry |
| `ENC_VESTING_TEAM_WALLET` | Team beneficiary | `02` ENCVesting |
| `ENC_VESTING_TREASURY_WALLET` | Treasury beneficiary | `02` ENCVesting |
| `ENC_VESTING_PUBLIC_WALLET` | Public beneficiary; operator of ENCVesting and EnishiPublicSale | `02`, `02d`, `02e` |
| `BSC_USDT` | USDT address for the Public Sale (mainnet USDT on chain 56) | `02d` EnishiPublicSale |
| `ENISHI_MASTER_WALLET` | Operating wallet; Public Sale treasury | `02d`, `03`, `04` |
| `FUND_WALLET` | Receives the 20% fund commission | `08` Vault |
| `SEOA_MNEMONIC`, `SEOA_HD_INDEX`, `SEOA_COUNT`, `SEOA_OUTPUT`, `SEOA_BATCH_SIZE` | SEOA generation and registration | `10`, `11` |
| `REPORT_GAS`, `COINMARKETCAP_API_KEY` | Optional gas reporter | Tests |

> [!CAUTION]
> Constructor wallets are immutable once deployed. Before every deploy,
> confirm that the wallet variables in `.env` belong to the target network —
> staging and testnet use different wallet sets from production.

---

## Deployment

### Deploy Order

Scripts in `deploy/` are numbered in dependency order and individually
tagged. All of them are idempotent (`skipIfAlreadyDeployed`), so re-running a
completed step is a no-op.

| # | Script | Tag | Depends on |
|---|---|---|---|
| 1 | `01_deploy_referral_registry.ts` | `ReferralRegistry` | — |
| 2 | `02_deploy_enc_vesting.ts` | `ENCVesting` | ReferralRegistry |
| 3 | `02c_deploy_enc.ts` | `ENC` | ENCVesting |
| 4 | `02d_deploy_public_sale.ts` | `PublicSale` | ENC |
| 5 | `02e_wire_vesting.ts` | `WireVesting` | ReferralRegistry, ENCVesting, ENC, PublicSale |
| 6 | `03_deploy_enc_lock.ts` | `ENCLock` | ENC |
| 7 | `04_deploy_enc_commission.ts` | `ENCCommission` | ENC, ReferralRegistry |
| 8 | `04b_deploy_enc_stake_router.ts` | `ENCStakeRouter` | ENCLock, PublicSale, ENCCommission |
| 9 | `05_deploy_whitelist.ts` | `WhiteList` | — |
| 10 | `06_deploy_swap_contract_factory.ts` | `SwapContractFactory` | — |
| 11 | `07_deploy_entokens.ts` | `EnTokens` | — |
| 12 | `08_deploy_vault.ts` | `Vault` | WhiteList, SwapContractFactory, ReferralRegistry, ENCCommission, ENCStakeRouter, ENC |
| 13 | `09_wire_all.ts` | `Wire` | Steps 4 and 6–12, ReferralRegistry, ENC |
| 14 | `10_generate_swc_config.ts` | `GenerateSEOAs` | — (offline) |
| 15 | `11_register_swc_config.ts` | `RegisterSEOAs` | WhiteList |

Steps 1–5 are the **vesting / public-sale release** and do not depend on the
Vault stack, so they can ship on their own. The `02*` and `03`–`08` scripts
only deploy, with two deliberate exceptions:

- **`02d` (PublicSale)** calls the one-shot `setEncToken(enc)` and grants
  `OPERATOR_ROLE` to `ENC_VESTING_PUBLIC_WALLET`.
- **`04b` (ENCStakeRouter)** is skipped while the network has no
  `EnishiPublicSale`, and refuses a sale deployed before the commission API
  (no `stakeRouter()`). `08` needs the router, so deploy the sale first. To
  replace an old sale, remove its `deployments/<network>/EnishiPublicSale.json`
  record (`02d` skips an existing one).
- **`07` (EnTokens)** writes the new receipt-token addresses into the
  network's address library and recompiles, so `Vault` (step 12) is built
  against them. Commit the updated library afterwards.

### Running a Deploy

Deploy one tag at a time and confirm each address before moving on.
Tags can be combined with commas.

```bash
# Vesting / public-sale release
npx hardhat deploy --network <network> --tags ReferralRegistry
npx hardhat deploy --network <network> --tags ENCVesting,ENC,PublicSale
npx hardhat deploy --network <network> --tags WireVesting

# Vault stack
npx hardhat deploy --network <network> --tags ENCLock,ENCCommission,ENCStakeRouter
npx hardhat deploy --network <network> --tags WhiteList,SwapContractFactory,EnTokens
npx hardhat deploy --network <network> --tags Vault
npx hardhat deploy --network <network> --tags Wire
```

> [!WARNING]
> `npm run deploy:mainnet` without `--tags` runs **every** script, including
> `WireVesting`, `Wire` and `RegisterSEOAs`, which send irreversible transactions. Use it only
> for a first-time deploy with a fully verified `.env`.

### Production Deploys with a Ledger

`bscMainnet` signs exclusively with a Ledger; `DEPLOYER_PRIVATE_KEY` is never
used for production.

1. Connect the Ledger, open the **Ethereum** app and enable **Blind signing**
   (deploy transactions carry calldata the app cannot decode).
2. Set `LEDGER_ACCOUNT_MAINNET` to the Ledger address.
3. Run any `--network bscMainnet` command. Confirm every transaction on the
   device and check that the **from** address matches `LEDGER_ACCOUNT_MAINNET`.
   Multi-transaction steps such as `Wire` require one confirmation per transaction.

### Contract Verification

Deploy scripts verify on BscScan automatically on live networks. To retry
manually:

```bash
npx hardhat verify --network <network> <address> <constructor-args…>
```

---

## Post-Deploy Wiring

Both wiring scripts read every address from `deployments/<network>/` and, for
each link, check on-chain state first and skip it if already correct. Both are
safe to re-run, and both end by re-reading every link from chain and failing
if any is wrong.

### Vesting / Public Sale (`WireVesting`)

```bash
npx hardhat deploy --network <network> --tags WireVesting
```

| Order | Action (`02e_wire_vesting.ts`) |
|---|---|
| 1 | `ENC.mintGenesis(ENCVesting, EnishiPublicSale)` — one-shot; renounces ENC ownership |
| 2 | `ENCVesting.start(ENC)` — anchors the TGE |
| 3 | `ENCVesting.grantRole(OPERATOR_ROLE, ENC_VESTING_PUBLIC_WALLET)` |
| 4 | `ReferralRegistry.grantRole(OPERATOR_ROLE, ENCVesting)` |

Before minting, `WireVesting` refuses to continue if `ENCVesting` is bound to a
different `ReferralRegistry`, has already started with a different ENC, or if
`EnishiPublicSale` pays out a different ENC, since the genesis mint cannot be
repeated.

### Vault Stack (`Wire`)

```bash
npx hardhat deploy --network <network> --tags Wire
```

Read-only preflight checks run first (the sale supports and is not bound to
another router, the router's constructor arguments, ReferralRegistry access),
so a failing run sends no transaction.

| Order | Action (`09_wire_all.ts`) |
|---|---|
| 1 | `ENCStakeRouter.setVault(Vault)` and `Vault.setStakeRouter(ENCStakeRouter)` |
| 2 | `EnishiPublicSale.setStakeRouter(ENCStakeRouter, ENCCommission)` — one-shot |
| 3 | `ENCLock.setVault(ENCStakeRouter)` |
| 4 | `ENCCommission.setAuthorizedCaller(Vault, true)` |
| 5 | `SwapContractFactory.setVault(Vault)` |
| 6 | `WhiteList.grantRole(OPERATOR_ROLE, Vault)` and revoke the deployer |
| 7 | `ReferralRegistry.grantRole(OPERATOR_ROLE, Vault)` |
| 8 | `setOperator(Vault)` on all seven receipt tokens |

**Manual follow-ups (not performed by either script):**

- `EnishiPublicSale.setSaleOpen(true)` — sent by `ENC_VESTING_PUBLIC_WALLET`
  when the sale should open.
- `transferOwnership` / admin-role hand-over to the production multisig.

**Targeted fix-ups.** To repair a single link after a partial redeploy, use the
matching script instead of re-running `Wire` / `WireVesting`:

| Script | Effect |
|---|---|
| `scripts/setup_whitelist_vault.ts` | `WhiteList` → grant `OPERATOR_ROLE` to Vault |
| `scripts/setup_swap_factory_vault.ts` | `SwapContractFactory.setVault(Vault)` |
| `scripts/setup_entokens_vault.ts` | `setOperator(Vault)` on all receipt tokens |
| `scripts/setup_enc_commission_vault.ts` | `ENCCommission.setAuthorizedCaller(Vault, true)` |
| `scripts/setup_enc_lock_vault.ts` | `ENCLock.setVault(ENCStakeRouter)` |
| `scripts/setup_referral_registry_vault.ts` | `ReferralRegistry` → grant `OPERATOR_ROLE` to Vault and ENCVesting |
| `scripts/setup_enc_vesting_operator.ts` | `ENCVesting` → grant `OPERATOR_ROLE` to `ENC_VESTING_PUBLIC_WALLET` |

```bash
npx hardhat run scripts/setup_whitelist_vault.ts --network <network>
```

---

## Security

- Contracts build on OpenZeppelin Contracts 5.x (`AccessControl`, `Ownable`,
  `ReentrancyGuardTransient`, `SafeERC20`) and use custom errors throughout.
- Value-moving entry points are `nonReentrant` and follow
  checks-effects-interactions.
- ENC has no mint path after genesis; ENCVesting and the Public Sale must stay
  fully backed by the ENC they hold.
- Public Sale lots can lose unclaimed ENC to commission only through
  `ENCStakeRouter`, set once on the sale. The router's owner chooses which
  Vault may pull, so hold that ownership in a multisig.
- Production deploys are Ledger-signed; secrets live only in `.env`
  (gitignored).
- Run static analysis (for example [Slither](https://github.com/crytic/slither))
  and the full test suite before any production deploy.

Please report suspected vulnerabilities privately to the maintainers rather
than opening a public issue.

---

## License

ISC
