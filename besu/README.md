# Running the prototype on a Hyperledger Besu QBFT network

The contracts are compiled for the London EVM rules, which Besu supports on private QBFT
networks. This folder contains a four-validator network definition that follows the Besu
documentation ([QBFT tutorial](https://besu.hyperledger.org/private-networks/tutorials/qbft),
[free-gas networks](https://besu.hyperledger.org/private-networks/how-to/configure/free-gas)).

> **Status.** These files were prepared but **not executed** in the build environment used for the
> article, which had no access to the Besu container image or binaries. All gas, storage and
> correctness results in `../reports` come from the Hardhat EVM with the same London rules.
> Network latency, finality and throughput still have to be measured with the steps below.

## Network parameters (`qbftConfigFile.json`)

| Parameter | Value | Note |
|---|---|---|
| Consensus | QBFT, 4 validators | tolerates one faulty validator |
| Block period | 2 s | `blockperiodseconds` |
| Request timeout | 4 s | `requesttimeoutseconds` |
| Block gas limit | 30,000,000 | the CarbonTraceability deployment needs 4.7 Mgas |
| Milestones | Berlin and London at block 0, `zeroBaseFee: true` | free-gas network, nodes started with `--min-gas-price=0` |
| Chain ID | 1337 | |
| Funded accounts | the 20 accounts of the public Hardhat test mnemonic | **test only**; never reuse these keys |

## Steps

```bash
cd besu
./setup.sh                      # generates validator keys and genesis.json (Docker)
docker compose up -d            # starts node1..node4; node1 serves JSON-RPC on :8545
# check that the four validators produce blocks
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"qbft_getValidatorsByBlockNumber","params":["latest"],"id":1}' \
  http://127.0.0.1:8545
cd ..
npx hardhat run scripts/deploy.js --network besu             # deploy + configure the consortium
npx hardhat run scripts/benchmark-latency.js --network besu  # latency and throughput
cd besu && docker compose down
```

`deploy.js` writes `deployments/besu.json`; `benchmark-latency.js` writes
`reports/latency-besu.json` with sequential (one operator) and burst (gateway buffer flush)
latency percentiles, throughput and the number of blocks spanned. Pin the Besu image version
(`BESU_IMAGE=hyperledger/besu:<version> ./setup.sh`) and report it with the results.

The case-study replay (`scripts/evaluate-case-study.js`) sets block timestamps to the historical
dates of the 2024 season, which only the Hardhat network allows; it is therefore not run on Besu.
