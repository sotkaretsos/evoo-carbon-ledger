"use strict";
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { b32, id, eventInput, SourceClass, signObservation, signReceipt, farmScopeId, deviceWallet } = require("../lib/encoding");
const { deployAll, configureConsortium } = require("../lib/deploy");
const { deviceId } = require("../lib/catalogue");
const { factorSetContentHash } = require("../offchain/lca-engine");

const kg = (x) => BigInt(Math.round(x * 1000)); // kg -> g ; L -> mL ; kWh -> Wh (milli-units)
const ORCHARD = b32("ORCHARD/TEST-01");
const CROP_YEAR = 2024;
const BATCH = b32("BATCH/TEST-01");
let seq = 0; // deterministic evidence identifiers
const nextEvidence = (label) => id(`EVIDENCE/${label}/${++seq}`);

/** Deployed and configured consortium with one registered orchard. */
async function baseFixture() {
  const signers = await ethers.getSigners();
  const contracts = await deployAll(ethers, signers[0]);
  const { actors, devices } = await configureConsortium(contracts, signers);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const ledger = await contracts.traceability.getAddress();
  await contracts.traceability.connect(actors.grower).registerOrchard(ORCHARD, 48000, id("GEO/TEST-01"));
  return { ...contracts, actors, devices, chainId, ledger, signers, orchardId: ORCHARD, cropYear: CROP_YEAR, scopeId: farmScopeId(ORCHARD, CROP_YEAR) };
}

/** Operator-entered field diesel event (valid by default). */
async function fieldEvent(overrides = {}) {
  const now = await time.latest();
  return eventInput({
    activity: "SOIL_PREPARATION",
    variable: "FIELD_DIESEL_L",
    quantity: kg(70),
    observedAt: now - 60,
    source: SourceClass.OperatorEntry,
    evidenceHash: nextEvidence("fuel-log"),
    methodCode: "OPERATOR_LOG",
    ...overrides,
  });
}

/** Irrigation-meter reading signed by the grower's registered meter. */
async function meterEvent(f, overrides = {}, signer = f.devices["IRRIGATION-METER-01"], scopeId = f.scopeId) {
  const now = await time.latest();
  const e = eventInput({
    activity: "IRRIGATION",
    variable: "IRRIGATION_WATER_M3",
    quantity: kg(120),
    observedAt: now - 60,
    source: SourceClass.Meter,
    sourceId: deviceId("IRRIGATION-METER-01"),
    evidenceHash: nextEvidence("meter-export"),
    methodCode: "DEVICE_READING",
    ...overrides,
  });
  const sig = await signObservation(signer, f.chainId, f.ledger, scopeId, e);
  return { e, sig };
}

/** Registers a lot and moves it to the mill with a dual-signature transfer. */
async function deliverLot(f, lotId, massKg, { receivedKg = massKg, confirm = true } = {}) {
  const { traceability: ct, actors, devices } = f;
  const g = kg(massKg);
  await ct.connect(actors.grower).registerLot(lotId, f.orchardId, f.cropYear, g, id("EVIDENCE/harvest-note"));
  await ct.connect(actors.grower).initiateTransfer(lotId, actors.mill.address, actors.transporter.address, g, 9500, id("VEHICLE/1"), id("EVIDENCE/delivery-note"));
  if (!confirm) return;
  const weighedAt = (await time.latest()) - 10;
  const wb = deviceId("WEIGHBRIDGE-01");
  const r = kg(receivedKg);
  const sig = await signReceipt(devices["WEIGHBRIDGE-01"], f.chainId, f.ledger, lotId, r, weighedAt, wb);
  await ct.connect(actors.mill).confirmReceipt(lotId, r, wb, weighedAt, sig);
}

/** Signed mill reading (electricity sub-meter or oil scale). */
async function millReading(f, batchId, variable, quantity, device) {
  const now = await time.latest();
  const e = eventInput({
    activity: "MILL_PROCESSING",
    variable,
    quantity: kg(quantity),
    observedAt: now - 30,
    source: SourceClass.Meter,
    sourceId: deviceId(device),
    evidenceHash: nextEvidence(device),
    methodCode: "DEVICE_READING",
  });
  const sig = await signObservation(f.devices[device], f.chainId, f.ledger, batchId, e);
  return f.traceability.connect(f.actors.mill).recordMillEvent(batchId, e, sig);
}

/**
 * Complete chain ready for certification: one farm event, two lots (2 x 4500 kg) delivered,
 * a closed mill batch (1778.8 kg oil from 9000 kg olives), farm phase closed and verified,
 * an approved factor set and a registered evidence manifest.
 */
async function readyFixture() {
  const f = await baseFixture();
  const { traceability: ct, certification: cc, factorRegistry: fr, evidenceRegistry: er, actors } = f;
  const ev = await fieldEvent();
  await ct.connect(actors.grower).recordFarmEvent(f.orchardId, f.cropYear, ev, "0x");
  const lots = [b32("LOT/T/1"), b32("LOT/T/2")];
  for (const l of lots) await deliverLot(f, l, 4500);
  await ct.connect(actors.mill).createBatch(BATCH, lots, [500, 500], b32("MASS_PROPORTIONAL"));
  await millReading(f, BATCH, "MILL_ELECTRICITY_KWH", 1000, "ELEC-SUBMETER-01");
  await millReading(f, BATCH, "OIL_OUTPUT_KG", 1778.8, "OIL-SCALE-01");
  await ct.connect(actors.mill).closeBatch(BATCH, kg(9000));
  await ct.connect(actors.grower).closeFarmPhase(f.orchardId, f.cropYear);
  await ct.connect(actors.certifier).verifyFarmPhase(f.orchardId, f.cropYear, id("VERIFICATION-REPORT"));
  const now = await time.latest();
  const fsId = b32("FS-TEST-01");
  await fr.connect(actors.methodAuthorityA).propose(fsId, 1, factorSetContentHash({ id: "FS-TEST-01" }), b32("GWP100-AR5"), now - 86400, now + 3 * 365 * 86400, ethers.ZeroHash);
  await fr.connect(actors.methodAuthorityB).approve(fsId);
  const manifest = id("MANIFEST/1");
  await er.connect(actors.lcaService).register(manifest, id("hdl:test/1"), b32("REPO/ARCHIVE"), now + 10 * 365 * 86400, 3);
  const result = {
    boundaryCode: b32("PARTIAL_CRADLE_TO_MILL_GATE"),
    functionalUnit: b32("EVOO_1KG_MILL_GATE"),
    allocationRule: b32("NONE_UNALLOCATED"),
    factorSetId: fsId,
    engineVersion: b32("evoo-lca-engine/1.0.0"),
    reportHash: id("REPORT/1"),
    evidenceManifest: manifest,
    phaseMg: [1609508n, 29940n, 195758n],
    totalMg: 1835206n,
  };
  return { ...f, farmEventIndex: 1, lots, batchId: BATCH, fsId, manifest, result, cc, ct, fr, er };
}

module.exports = { kg, nextEvidence, ORCHARD, CROP_YEAR, BATCH, baseFixture, readyFixture, fieldEvent, meterEvent, deliverLot, millReading, deviceWallet };
