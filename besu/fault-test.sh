#!/usr/bin/env bash
# Validator-failure experiment on the four-validator QBFT network (see besu/README.md).
# Run after ./setup.sh and `docker compose up -d`, from the besu folder:  ./fault-test.sh
# Node 1 serves JSON-RPC, so only nodes 3 and 4 are stopped. QBFT with four validators tolerates
# one faulty validator (quorum 3 of 4); with two stopped, block production is expected to halt.
# Results: ../reports/besu-fault/phase-*.json
set -euo pipefail
cd "$(dirname "$0")"
if [[ -e ../reports/besu-fault ]]; then
  echo "../reports/besu-fault exists; move it away to start a fresh experiment." >&2
  exit 1
fi
phase() { (cd .. && PHASE="$1" npx hardhat run scripts/besu-phase.js --network besu); }

echo "== Phase 1: all four validators"
docker compose start node1 node2 node3 node4
sleep 20
phase all-4

echo "== Phase 2: node4 stopped (3 of 4 validators)"
docker compose stop node4
sleep 15
phase 3-of-4

echo "== Phase 3: node3 and node4 stopped (2 of 4, below quorum)"
docker compose stop node3
sleep 15
N_TX=3 PHASE_TIMEOUT_S=60 EXPECT_HALT=1 phase 2-of-4

echo "== Phase 4: node3 restarted (3 of 4)"
docker compose start node3
PHASE_TIMEOUT_S=300 phase recovered-3-of-4   # round-change timeouts double while the chain is halted

echo "== Phase 5: node4 restarted (4 of 4)"
docker compose start node4
sleep 30
phase recovered-4-of-4

docker compose ps
echo "Done. Send the files in ../reports/besu-fault and ../reports/latency-besu.json."
