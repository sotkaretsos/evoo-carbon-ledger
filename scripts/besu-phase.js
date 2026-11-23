"use strict";
// Validator-failure experiment on the four-validator Besu QBFT network (driven by besu/fault-test.sh).
// One phase per run:
//   PHASE=<label> npx hardhat run scripts/besu-phase.js --network besu
// The first phase deploys and configures the contracts and stores their addresses in
// reports/besu-fault/deployment.json; later phases reuse them. Each phase
//   1. waits for the next block (block production check, up to PHASE_TIMEOUT_S),
//   2. checks whether transactions left pending by an earlier phase have been included,
//   3. submits N_TX recordFarmEvent transactions one at a time and waits up to PHASE_TIMEOUT_S for
//      each receipt (with EXPECT_HALT=1 it stops after the first transaction that is not included),
//   4. records latencies, inclusion, block intervals, peers and the QBFT validator set.
// Output: reports/besu-fault/phase-<label>.json
// Env: PHASE (required), N_TX (default 20), PHASE_TIMEOUT_S (default 30), EXPECT_HALT (0/1).

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { b32, id, eventInput, SourceClass } = require("../lib/encoding");
const { deployAll, configureConsortium } = require("../lib/deploy");

const PHASE = process.env.PHASE;
const N_TX = Number(process.env.N_TX || 20);
const TIMEOUT_MS = 1000 * Number(process.env.PHASE_TIMEOUT_S || 30);
const EXPECT_HALT = process.env.EXPECT_HALT === "1";
const GAS_LIMIT = 400000n;
const DIR = path.join(__dirname, "../reports/besu-fault");
const DEPLOYMENT = path.join(DIR, "deployment.json");
const PENDING = path.join(DIR, "pending.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = (xs) => {
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length), p50: q(0.5), p95: q(0.95), max: s[s.length - 1] };
};
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => null)]);

async function main() {
  if (!PHASE || !/^[A-Za-z0-9_-]+$/.test(PHASE)) throw new Error("Set PHASE to a label such as all-4 (letters, digits, - and _).");
  const { ethers, network } = hre;
  const provider = ethers.provider;
  const signers = await ethers.getSigners();
  fs.mkdirSync(DIR, { recursive: true });
  const rpc = (m, p = []) => provider.send(m, p).catch(() => null);

  // Contracts: deploy once, then reuse.
  let dep;
  if (fs.existsSync(DEPLOYMENT)) {
    dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
  } else {
    const contracts = await deployAll(ethers, signers[0]);
    const { actors } = await configureConsortium(contracts, signers);
    const orchard = b32(`ORCHARD/FAULT/${Date.now()}`);
    const ct = contracts.traceability.connect(actors.grower);
    await (await ct.registerOrchard(orchard, 48000, id("geo"))).wait();
    dep = { network: network.name, traceability: await contracts.traceability.getAddress(), grower: actors.grower.address, orchard, deployedAt: new Date().toISOString() };
    fs.writeFileSync(DEPLOYMENT, JSON.stringify(dep, null, 2));
  }
  const growerSigner = signers.find((s) => s.address.toLowerCase() === dep.grower.toLowerCase());
  if (!growerSigner) throw new Error("Grower account of the stored deployment is not among the configured accounts.");
  const ct = await ethers.getContractAt("CarbonTraceability", dep.traceability, growerSigner);

  const t0 = performance.now();
  const startBlock = await provider.getBlockNumber();

  // 1. Block production: time until the next block appears.
  let nextBlockMs = null;
  while (performance.now() - t0 < TIMEOUT_MS) {
    if ((await provider.getBlockNumber()) > startBlock) { nextBlockMs = Math.round(performance.now() - t0); break; }
    await sleep(200);
  }

  // 2. Transactions left pending by an earlier phase.
  const earlier = fs.existsSync(PENDING) ? JSON.parse(fs.readFileSync(PENDING, "utf8")) : [];
  const earlierResults = [];
  for (const p of earlier) {
    let r = null;
    while (!r && performance.now() - t0 < TIMEOUT_MS) {
      r = await provider.getTransactionReceipt(p.hash);
      if (!r) await sleep(250);
    }
    earlierResults.push({ hash: p.hash, fromPhase: p.phase, included: !!r, status: r ? r.status : null, blockNumber: r ? r.blockNumber : null, msAfterPhaseStart: r ? Math.round(performance.now() - t0) : null });
  }
  const stillPending = earlier.filter((p) => !earlierResults.find((e) => e.hash === p.hash && e.included));

  // 3. Transactions of this phase, one at a time.
  const latencies = [];
  const pendingNow = [];
  let submitted = 0, included = 0, reverted = 0;
  for (let i = 0; i < N_TX; i++) {
    const latest = await provider.getBlock("latest");
    const e = eventInput({ activity: "SOIL_PREPARATION", variable: "FIELD_DIESEL_L", quantity: 70000n, observedAt: latest.timestamp - 60, source: SourceClass.OperatorEntry, evidenceHash: id(`fault/${PHASE}/${Date.now()}/${i}`) });
    const ts = performance.now();
    const tx = await ct.recordFarmEvent(dep.orchard, 2024, e, "0x", { gasLimit: GAS_LIMIT });
    submitted++;
    const r = await withTimeout(tx.wait().catch((err) => ({ status: 0, err })), TIMEOUT_MS);
    if (!r) {
      pendingNow.push({ hash: tx.hash, phase: PHASE });
      if (EXPECT_HALT) break;
      continue;
    }
    if (r.status === 1) { included++; latencies.push(Math.round(performance.now() - ts)); } else reverted++;
  }
  fs.writeFileSync(PENDING, JSON.stringify([...stillPending, ...pendingNow], null, 2));

  // 4. Blocks produced during the phase.
  const endBlock = await provider.getBlockNumber();
  const intervals = [];
  let prev = null;
  for (let b = startBlock; b <= endBlock; b++) {
    const blk = await provider.getBlock(b);
    if (prev) intervals.push(Number(blk.timestamp - prev.timestamp));
    prev = blk;
  }
  const validators = await rpc("qbft_getValidatorsByBlockNumber", ["latest"]);
  const out = {
    phase: PHASE,
    network: network.name,
    chainId: Number((await provider.getNetwork()).chainId),
    measuredAt: new Date().toISOString(),
    clientVersion: await rpc("web3_clientVersion"),
    peerCount: (await rpc("net_peerCount")) !== null ? Number(await rpc("net_peerCount")) : null,
    validatorCount: Array.isArray(validators) ? validators.length : null,
    timeoutS: TIMEOUT_MS / 1000,
    nextBlockMs,
    blocks: { start: startBlock, end: endBlock, produced: endBlock - startBlock, intervalS: stats(intervals) },
    transactions: { submitted, included, reverted, notIncludedWithinTimeout: pendingNow.length, latencyMs: stats(latencies) },
    earlierPending: earlierResults,
    durationMs: Math.round(performance.now() - t0),
  };
  fs.writeFileSync(path.join(DIR, `phase-${PHASE}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

// Exit explicitly: receipts still being polled after a timeout would otherwise keep the process alive.
main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
