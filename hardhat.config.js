require("@nomicfoundation/hardhat-toolbox");
const path = require("path");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

const SOLC_VERSION = "0.8.28";

// Use the solc-js compiler shipped with the `solc` npm package, so that
// compilation does not depend on downloading compiler binaries.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === SOLC_VERSION) {
    const solc = require("solc");
    if (!solc.version().startsWith(SOLC_VERSION + "+")) {
      throw new Error(`solc-js ${solc.version()} installed; ${SOLC_VERSION} expected (run npm ci)`);
    }
    return {
      compilerPath: path.join(__dirname, "node_modules", "solc", "soljson.js"),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: solc.version(),
    };
  }
  return runSuper();
});

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: SOLC_VERSION,
    settings: {
      // London rules: supported by Hyperledger Besu (QBFT) and GoQuorum private networks.
      evmVersion: "london",
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      hardfork: "london",
      // The case-study replay records the 2024 season at its historical dates.
      initialDate: "2024-01-01T00:00:00Z",
      // Permissioned consortium networks are typically run with zero gas price.
      initialBaseFeePerGas: 0,
      gasPrice: 0,
    },
    // Local four-validator Besu QBFT network (see besu/README.md). Without BESU_PRIVATE_KEYS the
    // public Hardhat test mnemonic is used; it is funded in besu/qbftConfigFile.json and must
    // never be used outside a local test network.
    besu: {
      url: process.env.BESU_RPC_URL || "http://127.0.0.1:8545",
      chainId: Number(process.env.BESU_CHAIN_ID || 1337),
      gasPrice: 0,
      accounts: process.env.BESU_PRIVATE_KEYS
        ? process.env.BESU_PRIVATE_KEYS.split(",")
        : { mnemonic: "test test test test test test test test test test test junk", count: 20 },
      timeout: 120000,
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "EUR",
    offline: true,
    outputFile: process.env.REPORT_GAS_FILE,
    noColors: !!process.env.REPORT_GAS_FILE,
  },
  mocha: { timeout: 120000 },
};
