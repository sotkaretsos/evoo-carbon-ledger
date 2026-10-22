"use strict";
// Gas of the batch-level operations as a function of the number of lots in a mill batch.
// Usage: npx hardhat run scripts/scaling.js   (writes reports/scaling.json)

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { reset, time } = require("@nomicfoundation/hardhat-network-helpers");
const { b32, id, eventInput, SourceClass, signReceipt, signObservation } = require("../lib/encoding");
const { deployAll, configureConsortium } = require("../lib/deploy");
const { deviceId } = require("../lib/catalogue");

const LOT_COUNTS = [1, 4, 16, 64];
const kg = (x) => BigInt(Math.round(x * 1000));

async function measure(n) {
  const { ethers } = hre;
  await reset();
  const signers = await ethers.getSigners();
  const contracts = await deployAll(ethers, signers[0]);
  const { actors, devices } = await configureConsortium(contracts, signers);
  const { traceability: ct, certification: cc, factorRegistry: fr, evidenceRegistry: er } = contracts;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const ledger = await ct.getAddress();
  const orchard = b32("ORCHARD/SCALE");
  await ct.connect(actors.grower).registerOrchard(orchard, 48000, id("geo"));
  const now0 = await time.latest();
  await ct
    .connect(actors.grower)
    .recordFarmEvent(orchard, 2024, eventInput({ activity: "SOIL_PREPARATION", variable: "FIELD_DIESEL_L", quantity: kg(70), observedAt: now0 - 60, source: SourceClass.OperatorEntry, evidenceHash: id("ev") }), "0x");
  const lots = [];
  for (let i = 0; i < n; i++) {
    const lot = b32(`LOT/S/${i}`);
    lots.push(lot);
    await ct.connect(actors.grower).registerLot(lot, orchard, 2024, kg(1000), id(`note${i}`));
    await ct.connect(actors.grower).initiateTransfer(lot, actors.mill.address, ethers.ZeroAddress, kg(1000), 9500, id("v"), id(`dn${i}`));
    const t = (await time.latest()) - 1;
    const sig = await signReceipt(devices["WEIGHBRIDGE-01"], chainId, ledger, lot, kg(1000), t, deviceId("WEIGHBRIDGE-01"));
    await ct.connect(actors.mill).confirmReceipt(lot, kg(1000), deviceId("WEIGHBRIDGE-01"), t, sig);
  }
  const base = Math.floor(1000 / n);
  const shares = lots.map((_, i) => (i < 1000 - base * n ? base + 1 : base));
  const batch = b32("BATCH/SCALE");
  const gas = {};
  const g = async (label, txp) => {
    const r = await (await txp).wait();
    gas[label] = Number(r.gasUsed);
  };
  await g("createBatch", ct.connect(actors.mill).createBatch(batch, lots, shares, b32("MASS_PROPORTIONAL")));
  for (const [variable, q, device] of [
    ["MILL_ELECTRICITY_KWH", 111 * n, "ELEC-SUBMETER-01"],
    ["OIL_OUTPUT_L", 198 * n, "OIL-METER-01"],
  ]) {
    const e = eventInput({ activity: "MILL_PROCESSING", variable, quantity: kg(q), observedAt: (await time.latest()) - 1, source: SourceClass.Meter, sourceId: deviceId(device), evidenceHash: id(variable) });
    await ct.connect(actors.mill).recordMillEvent(batch, e, await signObservation(devices[device], chainId, ledger, batch, e));
  }
  await g("closeBatch", ct.connect(actors.mill).closeBatch(batch, kg(1000 * n)));
  await ct.connect(actors.grower).closeFarmPhase(orchard, 2024);
  await ct.connect(actors.certifier).verifyFarmPhase(orchard, 2024, id("report"));
  const now = await time.latest();
  await fr.connect(actors.methodAuthorityA).propose(b32("FS"), 1, id("doc"), b32("GWP100"), now - 10, now + 1e8, ethers.ZeroHash, [0, 0]);
  await fr.connect(actors.methodAuthorityB).approve(b32("FS"));
  await er.connect(actors.lcaService).register(id("manifest"), id("pid"), b32("REPO"), now + 10 * 365 * 86400, 3);
  const snapshot = await ethers.provider.getBlock("latest");
  const [,,, expectedRevisionDigest] = await ct.certificationStatus(batch);
  const result = {
    boundaryCode: b32("PARTIAL_CRADLE_TO_MILL_GATE"),
    functionalUnit: b32("EVOO_1L_MILL_GATE"),
    allocationRule: b32("NONE_UNALLOCATED"),
    factorSetId: b32("FS"),
    engineVersion: b32("evoo-lca-engine/1.2.0"),
    reportHash: id("report"),
    evidenceManifest: id("manifest"),
    expectedRevisionDigest,
    snapshotBlockNumber: snapshot.number,
    snapshotBlockHash: snapshot.hash,
    methodologicalStatus: 0, limitationFlags: 512, assessmentHash: id("SYNTHETIC/UNASSESSED"),
    phaseMg: [1609508n, 29940n, 195758n],
    totalMg: 1835206n,
  };
  await g("submitResult", cc.connect(actors.lcaService).submitResult(batch, result));
  await g("approveResult", cc.connect(actors.certifier).approveResult(batch, 1));
  gas.getCertificate_view = Number(await cc.getCertificate.estimateGas(batch));
  return { lots: n, ...gas };
}

async function main() {
  const rows = [];
  for (const n of LOT_COUNTS) {
    const row = await measure(n);
    rows.push(row);
    console.log(row);
  }
  // Marginal gas per additional lot from the smallest and largest batch.
  const first = rows[0];
  const last = rows[rows.length - 1];
  const marginal = {};
  for (const k of Object.keys(first)) if (k !== "lots") marginal[k] = Math.round((last[k] - first[k]) / (last.lots - first.lots));
  const out = { generatedAt: new Date().toISOString(), lotCounts: LOT_COUNTS, rows, marginalGasPerLot: marginal };
  fs.mkdirSync(path.join(__dirname, "../reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "../reports/scaling.json"), JSON.stringify(out, null, 2));
  console.log("marginal gas per lot", marginal);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { measure, LOT_COUNTS };
