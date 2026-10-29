import { HardhatUserConfig, subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_READ_FILE } from "hardhat/builtin-tasks/task-names";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-verify";
import "@nomicfoundation/hardhat-ledger";
import "@openzeppelin/hardhat-upgrades";
import "hardhat-deploy";
import "hardhat-gas-reporter";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config();

// Vault/SwapContract import `libraries/EnishiAddresses.sol` (mainnet). When
// compiling for a network listed here, that import is served the named
// network-specific library instead, so the contracts are built against that
// network's addresses without editing the mainnet file. The compile cache is
// keyed on file content, so switching networks recompiles automatically.
const ADDRESS_LIBRARY_BY_NETWORK: Record<string, string> = {
  bscTestnet: "EnishiAddressesTestnet.sol",
};
const MAINNET_ADDRESS_LIBRARY = path.join("contracts", "libraries", "EnishiAddresses.sol");

subtask(TASK_COMPILE_SOLIDITY_READ_FILE).setAction(
  async ({ absolutePath }: { absolutePath: string }, hre, runSuper) => {
    const override = ADDRESS_LIBRARY_BY_NETWORK[hre.network.name];
    if (override && absolutePath.endsWith(MAINNET_ADDRESS_LIBRARY)) {
      return runSuper({ absolutePath: path.join(path.dirname(absolutePath), override) });
    }
    return runSuper({ absolutePath });
  },
);

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "0x" + "0".repeat(64);
// bscMainnet deployer signs via Ledger — never a private key. Empty array makes
// `deploy:mainnet` fail fast with "no signer" instead of silently reusing DEPLOYER_PRIVATE_KEY.
const LEDGER_ACCOUNT_MAINNET = process.env.LEDGER_ACCOUNT_MAINNET || "";
const BSC_RPC_MAINNET = process.env.BSC_RPC_MAINNET || "https://bsc-dataseed1.binance.org";
const BSC_RPC_TESTNET = process.env.BSC_RPC_TESTNET || "https://bsc-testnet-rpc.publicnode.com";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || "";

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
          evmVersion: "cancun",
        },
      },
    ],
  },

  networks: {
    hardhat: {
      chainId: 31337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    bscTestnet: {
      url: BSC_RPC_TESTNET,
      chainId: 97,
      accounts: [DEPLOYER_PRIVATE_KEY],
      gasPrice: "auto",
    },
    bscStgMainet: {
      url: BSC_RPC_MAINNET,
      chainId: 56,
      accounts: [DEPLOYER_PRIVATE_KEY],
      gasPrice: "auto", // 3 gwei
    },
    bscMainnet: {
      url: BSC_RPC_MAINNET,
      chainId: 56,
      ledgerAccounts: LEDGER_ACCOUNT_MAINNET ? [LEDGER_ACCOUNT_MAINNET] : [],
      gasPrice: "auto", // 3 gwei
    },
  },

  etherscan: {
    apiKey: BSCSCAN_API_KEY,
    customChains: [
      {
        network: "bscTestnet",
        chainId: 97,
        urls: {
          apiURL: "https://api-testnet.bscscan.com/api",
          browserURL: "https://testnet.bscscan.com",
        },
      },
      {
        network: "bscMainnet",
        chainId: 56,
        urls: {
          apiURL: "https://api.bscscan.com/api",
          browserURL: "https://bscscan.com",
        },
      },
    ],
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    token: "BNB",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
  },

  namedAccounts: {
    deployer: {
      default: 0,
    },
    treasury: {
      default: 1,
    },
    feeCollector: {
      default: 2,
    },
  },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
    deploy: "./deploy",
  },

  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
};

export default config;
