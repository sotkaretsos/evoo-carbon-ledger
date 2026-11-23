"use strict";
// Scaling beyond the release cap: gas of the batch-level operations for 64-528 lots per batch.
// Release 1.3.0 keeps MAX_LOTS_PER_BATCH = 64. For this measurement only, raise the constant in
// contracts/CarbonTraceability.sol (4096 was used), then run
//   SCALE_GAS_LIMIT=30000000 npx hardhat run scripts/scaling-extended.js
// The explicit gas limit equals the block gas limit of the Besu configuration (besu/qbftConfigFile.json);
// batches that need more gas fail. Writes reports/scaling-extended.json. Restore the constant afterwards.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { measure } = require("./scaling");
const COUNTS = (process.env.SCALE_LOTS || "64,128,256,384,448,512,520,524,526,528").split(",").map(Number);
async function main() {
  const rows = [];
  for (const n of COUNTS) {
    try {
      const row = await measure(n);
      rows.push(row);
      console.log(row);
    } catch (e) {
      const msg = (e.shortMessage || e.message || String(e)).split("\n")[0].slice(0, 200);
      rows.push({ lots: n, failed: msg });
      console.log({ lots: n, failed: msg });
    }
  }
  const ok = rows.filter((r) => !r.failed);
  const a = ok[0], b = ok[ok.length - 1];
  const marginal = {};
  for (const k of Object.keys(a)) if (k !== "lots") marginal[k] = Math.round((b[k] - a[k]) / (b.lots - a.lots));
  const out = { generatedAt: new Date().toISOString(), note: "MAX_LOTS_PER_BATCH raised from 64 to 4096 for this experiment only; explicit gas limit " + (process.env.SCALE_GAS_LIMIT || "none"), rows, marginalGasPerLot: marginal };
  fs.writeFileSync(path.join(__dirname, "../reports/scaling-extended.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ marginal }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
