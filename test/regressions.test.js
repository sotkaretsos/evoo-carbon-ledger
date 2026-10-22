"use strict";
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine, time } = require("@nomicfoundation/hardhat-network-helpers");
const { baseFixture, readyFixture, deliverLot, fieldEvent, kg, nextEvidence } = require("./helpers");
const { b32, id, eventInput, SourceClass, signObservation, CertificateStatus } = require("../lib/encoding");
const { computeBatchResult } = require("../offchain/lca-engine");
const FS = require("../offchain/factor-sets/FS-2026-RECON-01.json");

describe("R4 regression — unique lots within one batch", function () {
  it("rejects duplicate IDs and rolls back consumption of every lot", async function () {
    const f = await loadFixture(baseFixture);
    const lot = b32("DUPLICATE_LOT");
    await deliverLot(f, lot, 1000);
    const mill = f.traceability.connect(f.actors.mill);
    await expect(mill.createBatch(b32("DUPLICATE_BATCH"), [lot, lot], [500, 500], b32("MASS_PROPORTIONAL")))
      .to.be.revertedWithCustomError(mill, "DuplicateLot").withArgs(lot);
    expect((await f.traceability.getLot(lot)).state).to.equal(3);
    await mill.createBatch(b32("UNIQUE_BATCH"), [lot], [1000], ethers.ZeroHash);
    const [batch, lots] = await f.traceability.getBatch(b32("UNIQUE_BATCH"));
    expect(batch.receivedMassG).to.equal(1000000n);
    expect(lots).to.deep.equal([lot]);
  });
});

describe("R7 regression — calculation snapshots and correction invariants", function () {
  it("rejects a report computed before a correction even when submitted afterwards", async function () {
    const f = await loadFixture(readyFixture);
    const oldBlock = f.result.snapshotBlockNumber;
    const before = await computeBatchResult(f.ct, f.batchId, { ...FS, id: "FS-TEST-01" }, { blockTag: oldBlock });
    const replacement = await fieldEvent({ quantity: kg(75) });
    await f.ct.connect(f.actors.grower).proposeCorrection(1, replacement, "0x", id("updated observation"));
    await f.ct.connect(f.actors.auditor).authorizeCorrection(1);
    await f.ct.connect(f.actors.certifier).verifyFarmPhase(f.orchardId, f.cropYear, id("new verification"));
    await expect(f.cc.connect(f.actors.lcaService).submitResult(f.batchId, f.result))
      .to.be.revertedWithCustomError(f.cc, "RevisionMismatch");
    const historical = await computeBatchResult(f.ct, f.batchId, { ...FS, id: "FS-TEST-01" }, { blockTag: oldBlock });
    expect(historical.reportHash).to.equal(before.reportHash);
    expect(historical.report.events.find(e => e.variable === "FIELD_DIESEL_L").quantity).to.equal(70);
    const current = await computeBatchResult(f.ct, f.batchId, { ...FS, id: "FS-TEST-01" });
    expect(current.report.total.perFU).to.be.greaterThan(before.report.total.perFU);
    expect(current.resultInput.expectedRevisionDigest).to.not.equal(before.resultInput.expectedRevisionDigest);
    await f.er.connect(f.actors.lcaService).register(current.manifestHash, id("new pid"), b32("REPO"), (await time.latest()) + 10 * 365 * 86400, 3);
    await f.cc.connect(f.actors.lcaService).submitResult(f.batchId, current.resultInput);
    await f.cc.connect(f.actors.certifier).approveResult(f.batchId, 1);
    const certificate = await f.cc.getCertificate(f.batchId);
    expect(certificate.status).to.equal(CertificateStatus.Valid);
    expect(certificate.reportHash).to.equal(current.reportHash);
  });

  it("rejects missing, altered and future snapshot block hashes", async function () {
    const f = await loadFixture(readyFixture);
    for (const change of [
      { snapshotBlockHash: ethers.ZeroHash },
      { snapshotBlockHash: id("altered block") },
      { snapshotBlockNumber: 999999999 },
    ]) {
      await expect(f.cc.connect(f.actors.lcaService).submitResult(f.batchId, { ...f.result, ...change }))
        .to.be.revertedWithCustomError(f.cc, "InvalidSnapshot");
    }
  });

  it("requires recomputation after the snapshot blockhash window expires", async function () {
    const f = await loadFixture(readyFixture);
    await mine(257);
    await expect(f.cc.connect(f.actors.lcaService).submitResult(f.batchId, f.result))
      .to.be.revertedWithCustomError(f.cc, "InvalidSnapshot");
  });

  it("cannot replace the mandatory electricity variable with a coproduct", async function () {
    const f = await loadFixture(readyFixture);
    const replacement = eventInput({ activity: "MILL_PROCESSING", variable: "POMACE_KG", quantity: kg(1000), observedAt: (await time.latest()) - 1, source: SourceClass.Estimate, evidenceHash: nextEvidence("pomace"), methodCode: "MILL_ESTIMATE" });
    await expect(f.ct.connect(f.actors.mill).proposeCorrection(2, replacement, "0x", id("reclassify")))
      .to.be.revertedWithCustomError(f.ct, "CorrectionVariableMismatch");
    expect((await f.ct.getActivityEvent(2)).status).to.equal(1);
    expect((await f.ct.getBatch(f.batchId))[0].closed).to.equal(true);
  });

  it("preserves the required signed meter after a legitimate same-variable correction", async function () {
    const f = await loadFixture(readyFixture);
    const replacement = eventInput({ activity: "MILL_PROCESSING", variable: "MILL_ELECTRICITY_KWH", quantity: kg(900), observedAt: (await time.latest()) - 1, source: SourceClass.Meter, sourceId: b32("ELEC-SUBMETER-01"), evidenceHash: nextEvidence("corrected-electricity"), methodCode: "DEVICE_READING" });
    await expect(f.ct.connect(f.actors.mill).proposeCorrection(2, { ...replacement, source: SourceClass.Estimate }, "0x", id("unsigned")))
      .to.be.revertedWithCustomError(f.ct, "MeterRequired");
    const signature = await signObservation(f.devices["ELEC-SUBMETER-01"], f.chainId, f.ledger, f.batchId, replacement);
    await f.ct.connect(f.actors.mill).proposeCorrection(2, replacement, signature, id("meter reread"));
    await f.ct.connect(f.actors.auditor).authorizeCorrection(1);
    expect((await f.ct.getActivityEvent(2)).status).to.equal(3);
    const effective = await f.ct.getActivityEvent(4);
    expect(effective.variable).to.equal(b32("MILL_ELECTRICITY_KWH"));
    expect(effective.source).to.equal(SourceClass.Meter);
    expect(effective.status).to.equal(1);
  });
});

describe("R9 regression — evidence remains usable at approval", function () {
  it("rejects approval after failed retrieval and accepts it after retrieval recovers", async function () {
    const f = await loadFixture(readyFixture);
    await f.cc.connect(f.actors.lcaService).submitResult(f.batchId, f.result);
    await f.er.connect(f.actors.auditor).logRetrievalCheck(f.manifest, false);
    await expect(f.cc.connect(f.actors.certifier).approveResult(f.batchId, 1)).to.be.revertedWithCustomError(f.cc, "EvidenceNotRetained");
    expect((await f.cc.getCertificate(f.batchId)).status).to.equal(CertificateStatus.None);
    await f.er.connect(f.actors.auditor).logRetrievalCheck(f.manifest, true);
    await f.cc.connect(f.actors.certifier).approveResult(f.batchId, 1);
    expect((await f.cc.getCertificate(f.batchId)).status).to.equal(CertificateStatus.Valid);
  });

  it("rejects approval when replica metadata falls below the required minimum", async function () {
    const f = await loadFixture(readyFixture);
    await f.cc.connect(f.actors.lcaService).submitResult(f.batchId, f.result);
    const evidence = await f.er.evidenceOf(f.manifest);
    await f.er.connect(f.actors.lcaService).extendRetention(f.manifest, evidence.retentionUntil, 1);
    await expect(f.cc.connect(f.actors.certifier).approveResult(f.batchId, 1)).to.be.revertedWithCustomError(f.cc, "EvidenceNotRetained");
  });

  it("rechecks the retention horizon at approval rather than only at submission", async function () {
    const f = await loadFixture(readyFixture);
    const now = await time.latest();
    const manifest = id("near retention threshold");
    await f.er.connect(f.actors.lcaService).register(manifest, id("pid"), b32("REPO"), now + 5 * 365 * 86400 + 20, 3);
    await f.cc.connect(f.actors.lcaService).submitResult(f.batchId, { ...f.result, evidenceManifest: manifest });
    await time.increase(30);
    await expect(f.cc.connect(f.actors.certifier).approveResult(f.batchId, 1)).to.be.revertedWithCustomError(f.cc, "EvidenceNotRetained");
  });
});

describe("LCA units and snapshot consistency", function () {
  it("keeps milligrams, liters and hectare totals dimensionally consistent", async function () {
    const f = await loadFixture(readyFixture);
    const result = await computeBatchResult(f.ct, f.batchId, FS);
    expect(result.report.referenceFlow).to.deep.equal({ variable: "OIL_OUTPUT_L", unit: "L", quantity: 1778.8 });
    expect(result.report.total.perFU * 1778.8).to.be.closeTo(result.report.total.kgCO2eq, 1e-9);
    expect(result.report.total.perHa * 4.8).to.be.closeTo(result.report.total.kgCO2eq, 1e-9);
    expect(Number(result.resultInput.totalMg) / 1e6).to.be.closeTo(result.report.total.perFU, 0.0000015);
    expect(result.resultInput.phaseMg.reduce((a,b) => a+b, 0n)).to.equal(result.resultInput.totalMg);
    expect(result.report.snapshot.blockHash).to.equal(result.resultInput.snapshotBlockHash);
    expect(result.report.snapshot.revisionDigest).to.equal(result.resultInput.expectedRevisionDigest);
  });

  it("does not compute a per-kilogram result from a volumetric reference flow", async function () {
    const f = await loadFixture(readyFixture);
    await expect(computeBatchResult(f.ct, f.batchId, FS, { functionalUnit: "EVOO_1KG_MILL_GATE" }))
      .to.be.rejectedWith("does not match the measured output unit L");
  });
});
