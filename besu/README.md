# Running the prototype on a Hyperledger Besu QBFT network

The contracts are compiled for the London EVM rules, which Besu supports on private QBFT
networks. This folder contains a four-validator network definition that follows the Besu
documentation ([QBFT tutorial](https://besu.hyperledger.org/private-networks/tutorials/qbft),
[free-gas networks](https://besu.hyperledger.org/private-networks/how-to/configure/free-gas)).

> The gas, storage and correctness results in `../reports` come from the Hardhat EVM with the same
> London rules. The steps below deploy the contracts on the QBFT network and measure latency,
> finality and throughput. The measured run of release 1.3.0 is described at the end of this file.

## Network parameters (`qbftConfigFile.json`)

| Parameter | Value | Note |
|---|---|---|
| Consensus | QBFT, 4 validators | tolerates one faulty validator |
| Block period | 2 s | `blockperiodseconds` |
| Request timeout | 4 s | `requesttimeoutseconds` |
| Block gas limit | 30,000,000 | the CarbonTraceability deployment needs about 4.9 Mgas |
| Milestones | Berlin and London at block 0, `zeroBaseFee: true` | free-gas network, nodes started with `--min-gas-price=0` |
| Chain ID | 1337 | |
| Funded accounts | the 20 accounts of the public Hardhat test mnemonic | **test only**; never reuse these keys |

## Steps

```bash
cd besu
export BESU_IMAGE=hyperledger/besu:<explicitly-tested-version-or-digest>
./setup.sh                      # generates validator keys and genesis.json (Docker)
docker compose up -d            # starts node1..node4; node1 serves JSON-RPC on :8545
# check that the four validators produce blocks
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"qbft_getValidatorsByBlockNumber","params":["latest"],"id":1}' \
  http://127.0.0.1:8545
cd ..
npx hardhat run scripts/deploy.js --network besu             # deploy + configure the consortium
npx hardhat run scripts/benchmark-latency.js --network besu  # latency and throughput
cd besu && ./fault-test.sh          # validators stopped and restarted (release 1.3.0)
docker compose down
```

`fault-test.sh` stops node 4, then nodes 3 and 4 (below quorum), and restarts them, running `scripts/besu-phase.js` in each phase; results are written to `reports/besu-fault/`. `deploy.js` writes `deployments/besu.json`; `benchmark-latency.js` writes
`reports/latency-besu.json` with sequential (one operator) and burst (gateway buffer flush)
latency percentiles, throughput and the number of blocks spanned. The image is deliberately
required rather than defaulting to a moving tag. Select and record a version or immutable digest
tested with the installed Docker/Besu environment.
`setup.sh` refuses to overwrite an existing genesis, validator keys or `.env`.

The RPC port is published on `127.0.0.1` only, with a restricted host allowlist and no permissive
browser CORS configuration. Node and account permissioning, TLS and key management are configured
separately for a production network; contract role checks implement application access control.

The case-study replay (`scripts/evaluate-case-study.js`) sets block timestamps to the dates of the
replayed season, which only the Hardhat network allows; it therefore runs on the Hardhat network.

## Measured run (release 1.3.0)

The four-validator network was run on 23 November 2026 with `windows/run-besu-experiment.ps1`
(started by `windows/run-besu-experiment.bat`), which performs the same steps natively on Windows,
without Docker or WSL: it generates the keys and genesis from `qbftConfigFile.json`, starts the four
validators as separate processes on 127.0.0.1, runs `scripts/benchmark-latency.js` and then the five
phases of `fault-test.sh` with `scripts/besu-phase.js`. A validator is stopped by terminating its
process tree (`taskkill /F`, a crash stop) and restarted from its data directory.

| Item | Value |
|---|---|
| Client | Besu 26.11.1 (`besu/v26.11.1/windows-x86_64/openjdk-java-25`), Temurin JDK 25.0.5.1, Node.js 22.23.5 |
| Host | Windows 11 Pro, Intel Core i7-10700 (8 cores, 16 threads), 15.8 GB RAM; 768 MB heap per validator |
| Node options | `--min-gas-price=0`, `--target-gas-limit=30000000` (keeps the 30 Mgas block gas limit of the genesis), `--rpc-http-max-active-connections=1000` (the default of 80 is exceeded when 100 receipts are polled at once), static nodes instead of `--bootnodes` (Besu 26.11 on Windows rejects enode URLs there), discovery disabled |
| Outputs | `../reports/latency-besu.json`, `../reports/besu-fault/` (phase results, `environment.txt`, `events.log` with stop and start times, validator logs) |

To repeat the run, put the two Windows scripts, the extracted release folder
`evoo-carbon-ledger-1.3.0` and a folder `tools` with
[besu-26.11.1.tar.gz](https://github.com/besu-eth/besu/releases/download/26.11.1/besu-26.11.1.tar.gz)
(SHA-256 `28336f46c44d6660e203546b51b8c81eea0cd3499ceff0d3e716f6b029e5e4f7`) and
[OpenJDK25U-jdk_x64_windows_hotspot_25.0.5.1_2.zip](https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5.1%2B2/OpenJDK25U-jdk_x64_windows_hotspot_25.0.5.1_2.zip)
(SHA-256 `849d380ab0a64d9098e7d3a2de28beb73841c3b255c8284f019ccd8748c5eb5b`) into one folder whose
path contains no spaces, and run the `.bat` file. Node.js 22 is used if installed and otherwise
downloaded and verified against the published checksums. Progress is written to `run.log`.

Results (all validators on one host, so delays between sites are not included; crash faults only):

| Phase | Blocks | Records included | Latency (median / max) | Note |
|---|---|---|---|---|
| Benchmark, 30 sequential records | 30 | 30/30 | 2.05 s / 2.09 s | one record per block |
| Benchmark, 100 records back to back | 1 | 100/100 | 6.94 s / 11.69 s | 20.2 Mgas (67% of the limit) in one block; latency set by sequential signing and submission from one client (8.6 tx/s) |
| All four validators | 21 | 20/20 | 2.05 s / 2.06 s | block interval 2 s |
| Validator 4 stopped | 21 | 20/20 | 2.06 s / 6.12 s | interval up to 6 s when the stopped validator was due to propose |
| Validators 3 and 4 stopped | 0 | 0/1 within 60 s | – | halted (quorum is 3 of 4) |
| Validator 3 restarted | 21 | 20/20, and the pending record | 2.08 s / 6.20 s | first block 254 s after the restart: the round-change timeout doubles in every round without a block (4 s, 8 s, ...) and had reached 256 s during the halt |
| Validator 4 restarted | 21 | 20/20 | 2.06 s / 2.14 s | validator 4 synchronized the missed blocks and proposed again |

No record was lost or reverted. Because the round-change timeout keeps growing while quorum is
lost, the recovery delay of a deployment depends on how long the halt lasted; it should be
considered when the request timeout is configured and monitored.

