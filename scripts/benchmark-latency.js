"use strict";
// Network-level benchmark: submission-to-receipt latency and throughput of recordFarmEvent.
// Intended for a multi-node Besu QBFT network (it was not run on one by the authors):
//   npx hardhat run scripts/benchmark-latency.js --network besu
// Environment: BENCH_SEQUENTIAL (default 30), BENCH_BURST (default 100), BENCH_GAS_LIMIT.
// Writes reports/latency-<network>.json. On the in-process Hardhat network the figures only
// reflect automining and are not meaningful.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { b32, id, eventInput, SourceClass } = require("../lib/encoding");
const { deployAll, configureConsortium } = require("../lib/deploy");

const N_SEQ = Number(process.env.BENCH_SEQUENTIAL || 30);
const N_BURST = Number(process.env.BENCH_BURST || 100);
const GAS_LIMIT = BigInt(process.env.BENCH_GAS_LIMIT || 400000);

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const stats = (xs) => ({ n: xs.length, meanMs: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), p50Ms: pct(xs, 50), p95Ms: pct(xs, 95), maxMs: Math.max(...xs) });

async function main() {
  const { ethers, network } = hre;
  const signers = await ethers.getSigners();
  const { traceability: ct, ...rest } = await deployAll(ethers, signers[0]);
  const { actors } = await configureConsortium({ traceability: ct, ...rest }, signers);
  const grower = ct.connect(actors.grower);
  const orchard = b32(`ORCHARD/BENCH/${Date.now()}`);
  await (await grower.registerOrchard(orchard, 48000, id("geo"))).wait();
  const event = async (i) => {
    const latest = await ethers.provider.getBlock("latest");
    return eventInput({ activity: "SOIL_PREPARATION", variable: "FIELD_DIESEL_L", quantity: 70000n, observedAt: latest.timestamp - 60, source: SourceClass.OperatorEntry, evidenceHash: id(`bench/${orchard}/${i}`) });
  };

  // Sequential: one transaction at a time (interactive use by a single operator).
  const sequential = [];
  const seqBlocks = [];
  for (let i = 0; i < N_SEQ; i++) {
    const e = await event(i);
    const t0 = performance.now();
    const tx = await grower.recordFarmEvent(orchard, 2024, e, "0x", { gasLimit: GAS_LIMIT });
    const r = await tx.wait();
    sequential.push(Math.round(performance.now() - t0));
    seqBlocks.push(r.blockNumber);
  }

  // Burst: N transactions submitted back to back with explicit nonces (gateway flushing a buffer).
  const prepared = [];
  for (let i = 0; i < N_BURST; i++) prepared.push(await event(N_SEQ + i));
  let nonce = await actors.grower.getNonce("pending");
  const sent = [];
  const tStart = performance.now();
  for (const e of prepared) {
    const t0 = performance.now();
    const tx = await grower.recordFarmEvent(orchard, 2024, e, "0x", { gasLimit: GAS_LIMIT, nonce: nonce++ });
    sent.push({ tx, t0 });
  }
  const receipts = await Promise.all(sent.map(async ({ tx, t0 }) => ({ r: await tx.wait(), latency: Math.round(performance.now() - t0) })));
  const tEnd = performance.now();
  const blocks = [...new Set(receipts.map((x) => x.r.blockNumber))].sort((a, b) => a - b);
  const first = await ethers.provider.getBlock(blocks[0]);
  const last = await ethers.provider.getBlock(blocks[blocks.length - 1]);
  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    measuredAt: new Date().toISOString(),
    clientVersion: await ethers.provider.send("web3_clientVersion", []).catch(() => null),
    sequential: { ...stats(sequential), blocks: new Set(seqBlocks).size },
    burst: {
      ...stats(receipts.map((x) => x.latency)),
      wallClockMs: Math.round(tEnd - tStart),
      throughputTxPerS: +(N_BURST / ((tEnd - tStart) / 1000)).toFixed(2),
      blocksSpanned: blocks.length,
      chainTimeSpanS: last.timestamp - first.timestamp,
      gasUsedTotal: receipts.reduce((a, x) => a + Number(x.r.gasUsed), 0),
    },
  };
  fs.mkdirSync(path.join(__dirname, "../reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, `../reports/latency-${network.name}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
