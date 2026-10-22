"use strict";
// Requirement-mapped tests: each describe block corresponds to one auditability requirement
// (R1-R9) of Section 2.5 / Table 6 of the article. Every requirement is tested with accepted
// (positive) and rejected (negative) cases.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { b32, id, eventInput, SourceClass, EventStatus, LotState, ResultStatus, CorrectionStatus, CertificateStatus, signObservation, signReceipt, deviceWallet } = require("../lib/encoding");
const { deviceId } = require("../lib/catalogue");
const { kg, nextEvidence, baseFixture, readyFixture, fieldEvent, meterEvent, deliverLot, millReading } = require("./helpers");

describe("R1 — attribution of every quantity to a source class and an actor", function () {
  it("stores the actor, phase and source class and logs the full envelope", async function () {
    const f = await loadFixture(baseFixture);
    const e = await fieldEvent({ locationHash: id("GEO/plot-3"), uncertaintyPermille: 20 });
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, e, "0x"))
      .to.emit(f.traceability, "ActivityRecorded")
      .withArgs(1, f.scopeId, 1, (input) => input.variable === e.variable && input.locationHash === e.locationHash && input.uncertaintyPermille === 20n, f.actors.grower.address, 0, 2);
    const stored = await f.traceability.getActivityEvent(1);
    expect(stored.actor).to.equal(f.actors.grower.address);
    expect(stored.source).to.equal(SourceClass.OperatorEntry);
    expect(stored.status).to.equal(EventStatus.Effective);
    expect(stored.scopeId).to.equal(f.scopeId);
  });

  it("rejects accounts that are not consortium members", async function () {
    const f = await loadFixture(baseFixture);
    const e = await fieldEvent();
    await expect(f.traceability.connect(f.actors.outsider).recordFarmEvent(f.orchardId, f.cropYear, e, "0x"))
      .to.be.revertedWithCustomError(f.traceability, "Unauthorized")
      .withArgs(f.actors.outsider.address);
  });

  it("rejects growers of another organisation on this orchard", async function () {
    const f = await loadFixture(baseFixture);
    const e = await fieldEvent();
    await expect(f.traceability.connect(f.actors.growerB).recordFarmEvent(f.orchardId, f.cropYear, e, "0x")).to.be.revertedWithCustomError(f.traceability, "Unauthorized");
  });

  it("rejects suspended actors without erasing their earlier records", async function () {
    const f = await loadFixture(baseFixture);
    await f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, await fieldEvent(), "0x");
    await f.consortium.connect(f.actors.governor).setActorActive(f.actors.grower.address, false);
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, await fieldEvent(), "0x")).to.be.revertedWithCustomError(f.traceability, "Unauthorized");
    expect((await f.traceability.getActivityEvent(1)).actor).to.equal(f.actors.grower.address);
  });

  it("requires a document identifier for invoice-based quantities", async function () {
    const f = await loadFixture(baseFixture);
    const invoice = await fieldEvent({ activity: "FERTILISATION", variable: "COMPOUND_FERTILISER_KG", quantity: kg(2700), source: SourceClass.Invoice });
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, invoice, "0x")).to.be.revertedWithCustomError(f.traceability, "DocumentIdRequired");
    invoice.sourceId = id("DOCUMENT/INVOICE/2024/0007");
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, invoice, "0x")).to.emit(f.traceability, "ActivityRecorded");
  });

  it("keeps estimates distinguishable from measurements", async function () {
    const f = await loadFixture(baseFixture);
    const est = await fieldEvent({ source: SourceClass.Estimate, uncertaintyPermille: 300 });
    await f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, est, "0x");
    const stored = await f.traceability.getActivityEvent(1);
    expect(stored.source).to.equal(SourceClass.Estimate);
    expect(stored.uncertaintyPermille).to.equal(300);
  });
});

describe("R2 — device identity and calibration status", function () {
  it("accepts a meter reading signed by the registered, calibrated device", async function () {
    const f = await loadFixture(baseFixture);
    const { e, sig } = await meterEvent(f);
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, e, sig)).to.emit(f.traceability, "ActivityRecorded");
    expect((await f.traceability.getActivityEvent(1)).source).to.equal(SourceClass.Meter);
  });

  it("rejects readings signed with another key", async function () {
    const f = await loadFixture(baseFixture);
    const { e, sig } = await meterEvent(f, {}, deviceWallet("ROGUE-GATEWAY"));
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, e, sig))
      .to.be.revertedWithCustomError(f.traceability, "InvalidDeviceSignature")
      .withArgs(deviceId("IRRIGATION-METER-01"));
  });

  it("rejects malformed signatures without reverting inside the signature library", async function () {
    const f = await loadFixture(baseFixture);
    const { e } = await meterEvent(f);
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, e, "0x1234")).to.be.revertedWithCustomError(f.traceability, "InvalidDeviceSignature");
  });

  it("rejects readings attributed to a device of another organisation", async function () {
    const f = await loadFixture(baseFixture);
    const { e, sig } = await meterEvent(f, { variable: "IRRIGATION_ELECTRICITY_KWH", sourceId: deviceId("ELEC-SUBMETER-01") }, f.devices["ELEC-SUBMETER-01"]);
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, e, sig)).to.be.revertedWithCustomError(f.traceability, "InvalidDevice");
  });

  it("rejects readings observed after the calibration certificate expired", async function () {
    const f = await loadFixture(baseFixture);
    const now = await time.latest();
    await f.consortium.connect(f.actors.certifier).recordCalibration(deviceId("IRRIGATION-METER-01"), id("CAL/short"), now + 3600);
    await time.increase(7200);
    const { e, sig } = await meterEvent(f);
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, e, sig))
      .to.be.revertedWithCustomError(f.traceability, "InvalidDevice")
      .withArgs(deviceId("IRRIGATION-METER-01"));
  });

  it("rejects readings of a deactivated device", async function () {
    const f = await loadFixture(baseFixture);
    await f.consortium.connect(f.actors.grower).setDeviceActive(deviceId("IRRIGATION-METER-01"), false);
    const { e, sig } = await meterEvent(f);
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, e, sig)).to.be.revertedWithCustomError(f.traceability, "InvalidDevice");
  });

  it("lets only certification bodies record calibration certificates", async function () {
    const f = await loadFixture(baseFixture);
    await expect(f.consortium.connect(f.actors.grower).recordCalibration(deviceId("IRRIGATION-METER-01"), id("CAL/self-issued"), 2000000000))
      .to.be.revertedWithCustomError(f.consortium, "NotActiveMember")
      .withArgs(f.actors.grower.address);
  });

  it("rejects operator entries for variables that must come from a meter", async function () {
    const f = await loadFixture(baseFixture);
    const manual = await fieldEvent({ activity: "IRRIGATION", variable: "IRRIGATION_WATER_M3", quantity: kg(120) });
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, manual, "0x"))
      .to.be.revertedWithCustomError(f.traceability, "MeterRequired")
      .withArgs(b32("IRRIGATION_WATER_M3"));
  });

  it("binds signatures to one scope and rejects re-sent envelopes", async function () {
    const f = await loadFixture(baseFixture);
    const otherScope = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint16"], [f.orchardId, 2025]));
    const { e, sig } = await meterEvent(f, {}, f.devices["IRRIGATION-METER-01"], otherScope);
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, e, sig)).to.be.revertedWithCustomError(f.traceability, "InvalidDeviceSignature");
    await f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, 2025, e, sig);
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, 2025, e, sig)).to.be.revertedWithCustomError(f.traceability, "DuplicateEvent");
    expect(await f.traceability.isRecorded(await f.traceability.envelopeHash(otherScope, e))).to.equal(true);
  });

  it("binds the declared material identity into the signed envelope", async function () {
    const f = await loadFixture(baseFixture);
    const { e, sig } = await meterEvent(f, { materialCode: "ORIGINAL_MATERIAL" });
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, { ...e, materialCode: b32("DIFFERENT_MATERIAL") }, sig))
      .to.be.revertedWithCustomError(f.traceability, "InvalidDeviceSignature");
    await f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, e, sig);
  });
});

describe("R3 — unit and range validation", function () {
  it("rejects quantities outside the governed range", async function () {
    const f = await loadFixture(baseFixture);
    for (const q of [kg(0.05), kg(2000.001)]) {
      const e = await fieldEvent({ quantity: q });
      await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, e, "0x"))
        .to.be.revertedWithCustomError(f.traceability, "OutOfRange")
        .withArgs(b32("FIELD_DIESEL_L"), q);
    }
    const max = await fieldEvent({ quantity: kg(2000) });
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, max, "0x")).to.emit(f.traceability, "ActivityRecorded");
  });

  it("rejects variables that belong to another phase", async function () {
    const f = await loadFixture(baseFixture);
    const e = await fieldEvent({ variable: "TRANSPORT_DIESEL_L" });
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, e, "0x")).to.be.revertedWithCustomError(f.traceability, "WrongPhase");
  });

  it("rejects undefined or deactivated variables", async function () {
    const f = await loadFixture(baseFixture);
    const undefinedVar = await fieldEvent({ variable: "UNDEFINED_INPUT_KG" });
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, undefinedVar, "0x")).to.be.revertedWithCustomError(f.traceability, "VariableInactive");
    await f.consortium.connect(f.actors.methodAuthorityA).deactivateVariable(b32("FIELD_PETROL_L"));
    const petrol = await fieldEvent({ variable: "FIELD_PETROL_L" });
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, petrol, "0x")).to.be.revertedWithCustomError(f.traceability, "VariableInactive");
  });

  it("rejects timestamps beyond the tolerated clock skew", async function () {
    const f = await loadFixture(baseFixture);
    const e = await fieldEvent({ observedAt: (await time.latest()) + 3600 });
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, e, "0x")).to.be.revertedWithCustomError(f.traceability, "FutureTimestamp");
  });

  it("rejects incomplete envelopes", async function () {
    const f = await loadFixture(baseFixture);
    const noEvidence = await fieldEvent({ evidenceHash: ethers.ZeroHash });
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, noEvidence, "0x")).to.be.revertedWithCustomError(f.traceability, "InvalidEnvelope");
    const noActivity = await fieldEvent({ activity: ethers.ZeroHash });
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, noActivity, "0x")).to.be.revertedWithCustomError(f.traceability, "InvalidEnvelope");
  });

  it("rejects an implausible oil yield at batch closure", async function () {
    const f = await loadFixture(baseFixture);
    const lot = b32("LOT/Y/1");
    await deliverLot(f, lot, 4500);
    await f.traceability.connect(f.actors.mill).createBatch(b32("BATCH/Y"), [lot], [1000], ethers.ZeroHash);
    await millReading(f, b32("BATCH/Y"), "MILL_ELECTRICITY_KWH", 500, "ELEC-SUBMETER-01");
    await millReading(f, b32("BATCH/Y"), "OIL_OUTPUT_L", 2000, "OIL-METER-01"); // 44.4 L per 100 kg of olives
    await expect(f.traceability.connect(f.actors.mill).closeBatch(b32("BATCH/Y"), kg(4500)))
      .to.be.revertedWithCustomError(f.traceability, "ImplausibleYield")
      .withArgs(444);
  });

  it("restricts variable definitions to the methodological authority", async function () {
    const f = await loadFixture(baseFixture);
    await expect(f.consortium.connect(f.actors.grower).defineVariable(b32("NEW_KG"), "0x6b67000000000000", 1, false, false, 1, 1000)).to.be.revertedWithCustomError(
      f.consortium,
      "NotActiveMember"
    );
    // A mandatory closure field must belong to the mill phase.
    await expect(f.consortium.connect(f.actors.methodAuthorityA).defineVariable(b32("NEW_KG"), "0x6b67000000000000", 1, false, true, 1, 1000)).to.be.revertedWithCustomError(
      f.consortium,
      "InvalidArgument"
    );
  });

  it("re-checks the oil yield when the oil output of a closed batch is corrected", async function () {
    const f = await loadFixture(readyFixture);
    const oilIndex = Number(await f.ct.eventCount());
    const now = await time.latest();
    const e = eventInput({ activity: "MILL_PROCESSING", variable: "OIL_OUTPUT_L", quantity: kg(4000), observedAt: now - 10, source: SourceClass.Meter, sourceId: deviceId("OIL-METER-01"), evidenceHash: nextEvidence("meter-re-reading"), methodCode: "DEVICE_READING" });
    const sig = await signObservation(f.devices["OIL-METER-01"], f.chainId, f.ledger, f.batchId, e);
    await f.ct.connect(f.actors.mill).proposeCorrection(oilIndex, e, sig, id("flow meter re-read"));
    await expect(f.ct.connect(f.actors.auditor).authorizeCorrection(1))
      .to.be.revertedWithCustomError(f.ct, "ImplausibleYield")
      .withArgs(444);
  });
});

describe("R4 — lot identity across custody and transformation", function () {
  it("changes custody only after the sender's declaration and the receiver's signed weighing", async function () {
    const f = await loadFixture(baseFixture);
    const lot = b32("LOT/C/1");
    await deliverLot(f, lot, 4500, { confirm: false });
    expect((await f.traceability.getLot(lot)).state).to.equal(LotState.InTransit);
    expect((await f.traceability.getLot(lot)).custodian).to.equal(f.actors.grower.address);
    const weighedAt = (await time.latest()) - 5;
    const sig = await signReceipt(f.devices["WEIGHBRIDGE-01"], f.chainId, f.ledger, lot, kg(4480), weighedAt, deviceId("WEIGHBRIDGE-01"));
    await expect(f.traceability.connect(f.actors.mill).confirmReceipt(lot, kg(4480), deviceId("WEIGHBRIDGE-01"), weighedAt, sig))
      .to.emit(f.traceability, "TransferConfirmed")
      .withArgs(lot, f.actors.mill.address, kg(4480), deviceId("WEIGHBRIDGE-01"), weighedAt);
    const l = await f.traceability.getLot(lot);
    expect(l.state).to.equal(LotState.AtMill);
    expect(l.custodian).to.equal(f.actors.mill.address);
    expect(l.receivedMassG).to.equal(kg(4480));
  });

  it("rejects confirmation by a mill other than the designated receiver", async function () {
    const f = await loadFixture(baseFixture);
    const lot = b32("LOT/C/2");
    await deliverLot(f, lot, 4500, { confirm: false });
    await expect(f.traceability.connect(f.actors.millB).confirmReceipt(lot, kg(4500), deviceId("WEIGHBRIDGE-01"), (await time.latest()) - 5, "0x")).to.be.revertedWithCustomError(
      f.traceability,
      "Unauthorized"
    );
  });

  it("rejects received masses outside the tolerance and unsigned weighings", async function () {
    const f = await loadFixture(baseFixture);
    const lot = b32("LOT/C/3");
    await deliverLot(f, lot, 4500, { confirm: false });
    const t = (await time.latest()) - 5;
    const wb = deviceId("WEIGHBRIDGE-01");
    const low = await signReceipt(f.devices["WEIGHBRIDGE-01"], f.chainId, f.ledger, lot, kg(4400), t, wb);
    await expect(f.traceability.connect(f.actors.mill).confirmReceipt(lot, kg(4400), wb, t, low))
      .to.be.revertedWithCustomError(f.traceability, "MassMismatch")
      .withArgs(kg(4500), kg(4400));
    const forged = await signReceipt(deviceWallet("ROGUE"), f.chainId, f.ledger, lot, kg(4500), t, wb);
    await expect(f.traceability.connect(f.actors.mill).confirmReceipt(lot, kg(4500), wb, t, forged)).to.be.revertedWithCustomError(f.traceability, "InvalidDeviceSignature");
  });

  it("does not batch lots that have not been received, nor the same lot twice", async function () {
    const f = await loadFixture(baseFixture);
    const inTransit = b32("LOT/C/4");
    await deliverLot(f, inTransit, 4500, { confirm: false });
    await expect(f.traceability.connect(f.actors.mill).createBatch(b32("BATCH/C/1"), [inTransit], [1000], ethers.ZeroHash))
      .to.be.revertedWithCustomError(f.traceability, "InvalidLotState")
      .withArgs(inTransit);
    const received = b32("LOT/C/5");
    await deliverLot(f, received, 4500);
    await f.traceability.connect(f.actors.mill).createBatch(b32("BATCH/C/2"), [received], [1000], ethers.ZeroHash);
    await expect(f.traceability.connect(f.actors.mill).createBatch(b32("BATCH/C/3"), [received], [1000], ethers.ZeroHash)).to.be.revertedWithCustomError(f.traceability, "InvalidLotState");
  });

  it("requires a declared mixing rule and mass-proportional shares", async function () {
    const f = await loadFixture(baseFixture);
    const a = b32("LOT/M/1");
    const b = b32("LOT/M/2");
    await deliverLot(f, a, 3000);
    await deliverLot(f, b, 1000);
    await expect(f.traceability.connect(f.actors.mill).createBatch(b32("BATCH/M"), [a, b], [750, 250], ethers.ZeroHash)).to.be.revertedWithCustomError(f.traceability, "MixingRuleRequired");
    await expect(f.traceability.connect(f.actors.mill).createBatch(b32("BATCH/M"), [a, b], [500, 500], b32("MASS_PROPORTIONAL"))).to.be.revertedWithCustomError(f.traceability, "SharesMismatch");
    await expect(f.traceability.connect(f.actors.mill).createBatch(b32("BATCH/M"), [a, b], [750, 250], b32("MASS_PROPORTIONAL")))
      .to.emit(f.traceability, "BatchCreated")
      .withArgs(b32("BATCH/M"), f.actors.mill.address, 2, b32("MASS_PROPORTIONAL"), kg(4000));
    expect((await f.traceability.getLot(a)).batchId).to.equal(b32("BATCH/M"));
  });

  it("closes a batch only when mandatory meter fields and the mass balance pass", async function () {
    const f = await loadFixture(baseFixture);
    const lot = b32("LOT/B/1");
    await deliverLot(f, lot, 4500);
    const batch = b32("BATCH/B");
    await f.traceability.connect(f.actors.mill).createBatch(batch, [lot], [1000], ethers.ZeroHash);
    await millReading(f, batch, "OIL_OUTPUT_L", 890, "OIL-METER-01");
    await expect(f.traceability.connect(f.actors.mill).closeBatch(batch, kg(4500)))
      .to.be.revertedWithCustomError(f.traceability, "MissingMandatoryVariable")
      .withArgs(b32("MILL_ELECTRICITY_KWH"));
    await millReading(f, batch, "MILL_ELECTRICITY_KWH", 500, "ELEC-SUBMETER-01");
    await expect(f.traceability.connect(f.actors.mill).closeBatch(batch, kg(4700))).to.be.revertedWithCustomError(f.traceability, "MassMismatch");
    await expect(f.traceability.connect(f.actors.mill).closeBatch(batch, kg(4500)))
      .to.emit(f.traceability, "BatchClosed")
      .withArgs(batch, kg(4500), kg(890), 197);
  });

  it("freezes the harvest basis and the farm record set at farm-phase closure", async function () {
    const f = await loadFixture(baseFixture);
    await f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, await fieldEvent(), "0x");
    await f.traceability.connect(f.actors.grower).registerLot(b32("LOT/F/1"), f.orchardId, f.cropYear, kg(4500), id("note"));
    await f.traceability.connect(f.actors.grower).closeFarmPhase(f.orchardId, f.cropYear);
    await expect(f.traceability.connect(f.actors.grower).registerLot(b32("LOT/F/2"), f.orchardId, f.cropYear, kg(4500), id("note"))).to.be.revertedWithCustomError(
      f.traceability,
      "PhaseClosed"
    );
    await expect(f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, await fieldEvent(), "0x")).to.be.revertedWithCustomError(f.traceability, "PhaseClosed");
    expect((await f.traceability.getFarmScope(f.orchardId, f.cropYear)).harvestedMassG).to.equal(kg(4500));
  });

  it("records transport events only for lots in transit, by the designated transporter", async function () {
    const f = await loadFixture(baseFixture);
    const lot = b32("LOT/T/9");
    await deliverLot(f, lot, 4500, { confirm: false });
    const fuel = await fieldEvent({ activity: "TRANSPORT", variable: "TRANSPORT_DIESEL_L", quantity: kg(10) });
    await expect(f.traceability.connect(f.actors.grower).recordTransportEvent(lot, fuel, "0x")).to.be.revertedWithCustomError(f.traceability, "Unauthorized");
    await expect(f.traceability.connect(f.actors.transporter).recordTransportEvent(lot, fuel, "0x")).to.emit(f.traceability, "ActivityRecorded");
    await expect(f.traceability.connect(f.actors.transporter).recordTransportEvent(b32("LOT/UNKNOWN"), fuel, "0x")).to.be.revertedWithCustomError(f.traceability, "InvalidLotState");
  });
});

describe("R5 — emission-factor versioning", function () {
  it("requires approval of a factor set by a second methodological authority", async function () {
    const f = await loadFixture(readyFixture);
    const now = await time.latest();
    await f.fr.connect(f.actors.methodAuthorityA).propose(b32("FS-X"), 2, id("doc"), b32("GWP100-AR6"), now, now + 1000000, f.fsId, [0, 0]);
    await expect(f.fr.connect(f.actors.methodAuthorityA).approve(b32("FS-X"))).to.be.revertedWithCustomError(f.fr, "SeparationOfDuties");
    await expect(f.fr.connect(f.actors.lcaService).approve(b32("FS-X"))).to.be.revertedWithCustomError(f.fr, "Unauthorized");
    await f.fr.connect(f.actors.methodAuthorityB).approve(b32("FS-X"));
    expect(await f.fr.isUsable(b32("FS-X"), now + 10)).to.equal(true);
  });

  it("rejects results that reference an unapproved, expired or retired factor set", async function () {
    const f = await loadFixture(readyFixture);
    const now = await time.latest();
    await f.fr.connect(f.actors.methodAuthorityA).propose(b32("FS-PROPOSED"), 2, id("doc2"), b32("GWP100-AR6"), now, now + 1000000, ethers.ZeroHash, [0, 0]);
    const r = { ...f.result, factorSetId: b32("FS-PROPOSED") };
    await expect(f.cc.connect(f.actors.lcaService).submitResult(f.batchId, r))
      .to.be.revertedWithCustomError(f.cc, "FactorSetNotUsable")
      .withArgs(b32("FS-PROPOSED"));
    await f.fr.connect(f.actors.methodAuthorityA).retire(f.fsId, id("withdrawn"));
    await expect(f.cc.connect(f.actors.lcaService).submitResult(f.batchId, f.result)).to.be.revertedWithCustomError(f.cc, "FactorSetNotUsable");
  });

  it("flags certificates whose factor set was later retired", async function () {
    const f = await loadFixture(readyFixture);
    await f.cc.connect(f.actors.lcaService).submitResult(f.batchId, f.result);
    await f.cc.connect(f.actors.certifier).approveResult(f.batchId, 1);
    expect((await f.cc.getCertificate(f.batchId)).status).to.equal(CertificateStatus.Valid);
    await f.fr.connect(f.actors.methodAuthorityA).retire(f.fsId, id("undocumented factor"));
    expect((await f.cc.getCertificate(f.batchId)).status).to.equal(CertificateStatus.FactorSetRetired);
  });

  it("records a recalculation as a new result version and keeps earlier versions", async function () {
    const f = await loadFixture(readyFixture);
    await f.cc.connect(f.actors.lcaService).submitResult(f.batchId, f.result);
    await f.cc.connect(f.actors.certifier).approveResult(f.batchId, 1);
    const now = await time.latest();
    await f.fr.connect(f.actors.methodAuthorityA).propose(b32("FS-TEST-02"), 2, id("doc v2"), b32("GWP100-AR6"), now, now + 1000000, f.fsId, [0, 0]);
    await f.fr.connect(f.actors.methodAuthorityB).approve(b32("FS-TEST-02"));
    const r2 = { ...f.result, factorSetId: b32("FS-TEST-02"), reportHash: id("REPORT/2"), phaseMg: [1500000n, 29940n, 195758n], totalMg: 1725698n };
    await f.cc.connect(f.actors.lcaService).submitResult(f.batchId, r2);
    await f.cc.connect(f.actors.certifier).approveResult(f.batchId, 2);
    expect((await f.cc.getResult(f.batchId, 1)).status).to.equal(ResultStatus.Superseded);
    expect((await f.cc.getResult(f.batchId, 1)).data.factorSetId).to.equal(f.fsId);
    const cert = await f.cc.getCertificate(f.batchId);
    expect(cert.version).to.equal(2);
    expect(cert.factorSetId).to.equal(b32("FS-TEST-02"));
  });
});

describe("R6 — functional unit, system boundary and allocation rule", function () {
  it("rejects result packages with missing method fields", async function () {
    const f = await loadFixture(readyFixture);
    const fields = ["boundaryCode", "functionalUnit", "allocationRule", "factorSetId", "engineVersion", "reportHash", "evidenceManifest"];
    for (let i = 0; i < fields.length; i++) {
      const r = { ...f.result, [fields[i]]: ethers.ZeroHash };
      await expect(f.cc.connect(f.actors.lcaService).submitResult(f.batchId, r))
        .to.be.revertedWithCustomError(f.cc, "MissingField")
        .withArgs(i + 1);
    }
  });

  it("rejects unknown functional units and units that differ from the measured output", async function () {
    const f = await loadFixture(readyFixture);
    await expect(f.cc.connect(f.actors.lcaService).submitResult(f.batchId, { ...f.result, functionalUnit: b32("EVOO_1_BOTTLE") })).to.be.revertedWithCustomError(
      f.cc,
      "UnknownFunctionalUnit"
    );
    await expect(f.cc.connect(f.actors.lcaService).submitResult(f.batchId, { ...f.result, functionalUnit: b32("EVOO_1KG_MILL_GATE") }))
      .to.be.revertedWithCustomError(f.cc, "FunctionalUnitMismatch")
      .withArgs("0x6b67000000000000", "0x4c00000000000000");
  });

  it("rejects totals that differ from the sum of the phase results", async function () {
    const f = await loadFixture(readyFixture);
    await expect(f.cc.connect(f.actors.lcaService).submitResult(f.batchId, { ...f.result, totalMg: 1835000n }))
      .to.be.revertedWithCustomError(f.cc, "InconsistentTotal")
      .withArgs(1835206n, 1835000n);
  });

  it("does not accept results before the batch and its farm phases are closed", async function () {
    const f = await loadFixture(baseFixture);
    const lot = b32("LOT/O/1");
    await deliverLot(f, lot, 4500);
    await f.traceability.connect(f.actors.mill).createBatch(b32("BATCH/O"), [lot], [1000], ethers.ZeroHash);
    await expect(f.certification.connect(f.actors.lcaService).submitResult(b32("BATCH/O"), (await readyFixtureResult()).result)).to.be.revertedWithCustomError(
      f.certification,
      "PhaseNotClosed"
    );
  });

  it("exposes boundary, functional unit, allocation rule and factor set on the certificate", async function () {
    const f = await loadFixture(readyFixture);
    await f.cc.connect(f.actors.lcaService).submitResult(f.batchId, f.result);
    await f.cc.connect(f.actors.certifier).approveResult(f.batchId, 1);
    const c = await f.cc.getCertificate(f.batchId);
    expect(c.boundaryCode).to.equal(b32("PARTIAL_CRADLE_TO_MILL_GATE"));
    expect(c.functionalUnit).to.equal(b32("EVOO_1L_MILL_GATE"));
    expect(c.allocationRule).to.equal(b32("NONE_UNALLOCATED"));
    expect(c.factorSetId).to.equal(f.fsId);
    expect(c.totalMg).to.equal(1835206n);
  });
});

async function readyFixtureResult() {
  return { result: { boundaryCode: b32("B"), functionalUnit: b32("EVOO_1L_MILL_GATE"), allocationRule: b32("A"), factorSetId: b32("F"), engineVersion: b32("E"), reportHash: id("R"), evidenceManifest: id("M"), expectedRevisionDigest: ethers.ZeroHash, snapshotBlockNumber: 0, snapshotBlockHash: ethers.ZeroHash, methodologicalStatus: 0, limitationFlags: 512, assessmentHash: id("SYNTHETIC/UNASSESSED"), phaseMg: [1n, 1n, 1n], totalMg: 3n } };
}

describe("R7 — correction without deletion of history", function () {
  async function correctedFixture() {
    const f = await readyFixture();
    await f.cc.connect(f.actors.lcaService).submitResult(f.batchId, f.result);
    await f.cc.connect(f.actors.certifier).approveResult(f.batchId, 1);
    const original = await f.ct.getActivityEvent(1);
    const now = await time.latest();
    const replacement = eventInput({
      activity: "SOIL_PREPARATION",
      variable: "FIELD_DIESEL_L",
      quantity: original.quantity + kg(5),
      observedAt: now - 3600,
      source: SourceClass.OperatorEntry,
      evidenceHash: nextEvidence("corrected-fuel-log"),
      methodCode: "OPERATOR_LOG",
    });
    const replacementIndex = Number(await f.ct.eventCount()) + 1; // next index in the event log
    return { ...f, replacement, replacementIndex };
  }

  it("keeps the original event, links the replacement and records reason and authoriser", async function () {
    const f = await loadFixture(correctedFixture);
    const r = f.replacementIndex;
    await expect(f.ct.connect(f.actors.grower).proposeCorrection(1, f.replacement, "0x", id("quantity transcribed incorrectly")))
      .to.emit(f.ct, "CorrectionProposed")
      .withArgs(1, 1, r, id("quantity transcribed incorrectly"), f.actors.grower.address);
    expect((await f.ct.getActivityEvent(r)).status).to.equal(EventStatus.PendingReplacement);
    await expect(f.ct.connect(f.actors.auditor).authorizeCorrection(1)).to.emit(f.ct, "CorrectionApplied").withArgs(1, 1, r, f.actors.auditor.address);
    const original = await f.ct.getActivityEvent(1);
    const replacement = await f.ct.getActivityEvent(r);
    expect(original.status).to.equal(EventStatus.Superseded);
    expect(original.replacedBy).to.equal(r);
    expect(replacement.status).to.equal(EventStatus.Effective);
    expect(replacement.replaces).to.equal(1);
    const c = await f.ct.getCorrection(1);
    expect(c.status).to.equal(CorrectionStatus.Applied);
    expect(c.authorizer).to.equal(f.actors.auditor.address);
    expect(c.reasonHash).to.equal(id("quantity transcribed incorrectly"));
    expect(await f.ct.eventCount()).to.equal(r); // nothing was deleted: original and replacement coexist
  });

  it("requires authorization by an auditor other than the proposer", async function () {
    const f = await loadFixture(correctedFixture);
    await f.ct.connect(f.actors.grower).proposeCorrection(1, f.replacement, "0x", id("reason"));
    await expect(f.ct.connect(f.actors.grower).authorizeCorrection(1)).to.be.revertedWithCustomError(f.ct, "Unauthorized");
    await f.consortium.connect(f.actors.governor).grantRole(ethers.id("AUDITOR_ROLE"), f.actors.grower.address);
    await expect(f.ct.connect(f.actors.grower).authorizeCorrection(1)).to.be.revertedWithCustomError(f.ct, "SeparationOfDuties");
  });

  it("rejects corrections proposed by another organisation", async function () {
    const f = await loadFixture(correctedFixture);
    await expect(f.ct.connect(f.actors.growerB).proposeCorrection(1, f.replacement, "0x", id("reason"))).to.be.revertedWithCustomError(f.ct, "Unauthorized");
    await expect(f.ct.connect(f.actors.growerColleague).proposeCorrection(1, f.replacement, "0x", id("reason"))).to.emit(f.ct, "CorrectionProposed");
  });

  it("outdates the certificate and invalidates results computed from the earlier chain", async function () {
    const f = await loadFixture(correctedFixture);
    const r2 = { ...f.result, reportHash: id("REPORT/stale") };
    await f.cc.connect(f.actors.lcaService).submitResult(f.batchId, r2);
    await f.ct.connect(f.actors.grower).proposeCorrection(1, f.replacement, "0x", id("reason"));
    expect((await f.cc.getCertificate(f.batchId)).status).to.equal(CertificateStatus.Valid);
    await f.ct.connect(f.actors.auditor).authorizeCorrection(1);
    expect((await f.cc.getCertificate(f.batchId)).status).to.equal(CertificateStatus.Outdated);
    await expect(f.cc.connect(f.actors.certifier).approveResult(f.batchId, 2))
      .to.be.revertedWithCustomError(f.cc, "StaleResult")
      .withArgs(f.batchId, 2);
  });

  it("requires renewed farm verification after a farm correction", async function () {
    const f = await loadFixture(correctedFixture);
    await f.ct.connect(f.actors.grower).proposeCorrection(1, f.replacement, "0x", id("reason"));
    await f.ct.connect(f.actors.auditor).authorizeCorrection(1);
    expect((await f.ct.getFarmScope(f.orchardId, f.cropYear)).verified).to.equal(false);
    const snapshot = await ethers.provider.getBlock("latest");
    const [,,, expectedRevisionDigest] = await f.ct.certificationStatus(f.batchId);
    await f.cc.connect(f.actors.lcaService).submitResult(f.batchId, { ...f.result, reportHash: id("REPORT/v2"), expectedRevisionDigest, snapshotBlockNumber: snapshot.number, snapshotBlockHash: snapshot.hash });
    await expect(f.cc.connect(f.actors.certifier).approveResult(f.batchId, 2)).to.be.revertedWithCustomError(f.cc, "PhaseNotVerified");
    await f.ct.connect(f.actors.certifier).verifyFarmPhase(f.orchardId, f.cropYear, id("VERIFICATION-REPORT/2"));
    await f.cc.connect(f.actors.certifier).approveResult(f.batchId, 2);
    expect((await f.cc.getCertificate(f.batchId)).status).to.equal(CertificateStatus.Valid);
  });

  it("leaves the original effective when a correction is rejected", async function () {
    const f = await loadFixture(correctedFixture);
    await f.ct.connect(f.actors.grower).proposeCorrection(1, f.replacement, "0x", id("reason"));
    await expect(f.ct.connect(f.actors.auditor).rejectCorrection(1, id("insufficient evidence"))).to.emit(f.ct, "CorrectionRejected");
    expect((await f.ct.getActivityEvent(1)).status).to.equal(EventStatus.Effective);
    expect((await f.ct.getActivityEvent(f.replacementIndex)).status).to.equal(EventStatus.Rejected);
    expect((await f.cc.getCertificate(f.batchId)).status).to.equal(CertificateStatus.Valid);
    await expect(f.ct.connect(f.actors.auditor).authorizeCorrection(1)).to.be.revertedWithCustomError(f.ct, "InvalidStatus");
  });

  it("does not correct a superseded event again and validates replacements like new events", async function () {
    const f = await loadFixture(correctedFixture);
    await f.ct.connect(f.actors.grower).proposeCorrection(1, f.replacement, "0x", id("reason"));
    await f.ct.connect(f.actors.auditor).authorizeCorrection(1);
    await expect(f.ct.connect(f.actors.grower).proposeCorrection(1, { ...f.replacement, quantity: kg(49) }, "0x", id("again"))).to.be.revertedWithCustomError(f.ct, "InvalidStatus");
    const r = f.replacementIndex; // the replacement itself can be corrected, subject to the same rules
    await expect(f.ct.connect(f.actors.grower).proposeCorrection(r, { ...f.replacement, quantity: kg(9999) }, "0x", id("range"))).to.be.revertedWithCustomError(f.ct, "OutOfRange");
    await expect(f.ct.connect(f.actors.grower).proposeCorrection(r, { ...f.replacement, variable: b32("TRANSPORT_DIESEL_L") }, "0x", id("phase"))).to.be.revertedWithCustomError(f.ct, "CorrectionVariableMismatch");
    await expect(f.ct.connect(f.actors.grower).proposeCorrection(r, f.replacement, "0x", id("duplicate"))).to.be.revertedWithCustomError(f.ct, "DuplicateEvent");
  });

  it("outdates the certificate when a transport record of one lot is corrected", async function () {
    const f = await loadFixture(baseFixture);
    const ct = f.traceability;
    await ct.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, await fieldEvent(), "0x");
    const lot = b32("LOT/TR/1");
    await deliverLot(f, lot, 4500, { confirm: false });
    const fuel = await fieldEvent({ activity: "TRANSPORT", variable: "TRANSPORT_DIESEL_L", quantity: kg(10) });
    await ct.connect(f.actors.transporter).recordTransportEvent(lot, fuel, "0x");
    const fuelIndex = Number(await ct.eventCount());
    const t = (await time.latest()) - 5;
    const sig = await signReceipt(f.devices["WEIGHBRIDGE-01"], f.chainId, f.ledger, lot, kg(4500), t, deviceId("WEIGHBRIDGE-01"));
    await ct.connect(f.actors.mill).confirmReceipt(lot, kg(4500), deviceId("WEIGHBRIDGE-01"), t, sig);
    await ct.connect(f.actors.mill).createBatch(b32("BATCH/TR"), [lot], [1000], ethers.ZeroHash);
    const digestBefore = (await ct.certificationStatus(b32("BATCH/TR"))).digest;
    await ct.connect(f.actors.transporter).proposeCorrection(fuelIndex, { ...fuel, quantity: kg(12) }, "0x", id("fuel log transcription error"));
    await ct.connect(f.actors.auditor).authorizeCorrection(1);
    expect((await ct.getLot(lot)).revision).to.equal(1);
    expect((await ct.certificationStatus(b32("BATCH/TR"))).digest).to.not.equal(digestBefore);
  });

  it("keeps the mill reference flow consistent when an oil-output reading is corrected", async function () {
    const f = await loadFixture(readyFixture);
    const oilIndex = Number(await f.ct.eventCount()); // last mill event = oil output
    const now = await time.latest();
    const e = eventInput({ activity: "MILL_PROCESSING", variable: "OIL_OUTPUT_L", quantity: kg(1800), observedAt: now - 10, source: SourceClass.Meter, sourceId: deviceId("OIL-METER-01"), evidenceHash: nextEvidence("meter-re-reading"), methodCode: "DEVICE_READING" });
    const sig = await signObservation(f.devices["OIL-METER-01"], f.chainId, f.ledger, f.batchId, e);
    await f.ct.connect(f.actors.mill).proposeCorrection(oilIndex, e, sig, id("flow meter re-read"));
    await f.ct.connect(f.actors.auditor).authorizeCorrection(1);
    const [batch] = await f.ct.getBatch(f.batchId);
    expect(batch.oilOutputMilli).to.equal(kg(1800));
    expect(batch.revision).to.equal(1);
  });
});

describe("R8 — confidentiality with integrity verification", function () {
  it("stores only the evidence hash and verifies presented documents against it", async function () {
    const f = await loadFixture(baseFixture);
    const document = ethers.toUtf8Bytes("Fuel log 2024-04-12: weed cutting, 70 L diesel, tractor T-2");
    const e = await fieldEvent({ evidenceHash: ethers.keccak256(document) });
    await f.traceability.connect(f.actors.grower).recordFarmEvent(f.orchardId, f.cropYear, e, "0x");
    expect(await f.traceability.matchesEvidence(1, ethers.keccak256(document))).to.equal(true);
    const altered = ethers.toUtf8Bytes("Fuel log 2024-04-12: weed cutting, 40 L diesel, tractor T-2");
    expect(await f.traceability.matchesEvidence(1, ethers.keccak256(altered))).to.equal(false);
  });

  it("discloses totals, phase shares and method fields on the public certificate only", async function () {
    const f = await loadFixture(readyFixture);
    await f.cc.connect(f.actors.lcaService).submitResult(f.batchId, f.result);
    await f.cc.connect(f.actors.certifier).approveResult(f.batchId, 1);
    const c = await f.cc.connect(f.actors.outsider).getCertificate(f.batchId);
    expect(c.phaseSharePermille.map(Number)).to.deep.equal([877, 16, 107]);
    const fragment = f.cc.interface.getFunction("getCertificate");
    const fieldNames = fragment.outputs[0].components.map((x) => x.name);
    expect(fieldNames).to.not.include.members(["quantity", "phaseMg", "evidenceManifest"]);
    expect(fieldNames).to.include.members(["status", "totalMg", "phaseSharePermille", "functionalUnit", "factorSetId", "reportHash"]);
  });
});

describe("R9 — retention of off-chain evidence", function () {
  it("rejects results whose evidence manifest is unregistered, too short-lived or under-replicated", async function () {
    const f = await loadFixture(readyFixture);
    await expect(f.cc.connect(f.actors.lcaService).submitResult(f.batchId, { ...f.result, evidenceManifest: id("MANIFEST/unregistered") }))
      .to.be.revertedWithCustomError(f.cc, "EvidenceNotRetained")
      .withArgs(id("MANIFEST/unregistered"));
    const now = await time.latest();
    await f.er.connect(f.actors.lcaService).register(id("MANIFEST/short"), id("hdl:short"), b32("REPO/ARCHIVE"), now + 365 * 86400, 3);
    await expect(f.cc.connect(f.actors.lcaService).submitResult(f.batchId, { ...f.result, evidenceManifest: id("MANIFEST/short") })).to.be.revertedWithCustomError(f.cc, "EvidenceNotRetained");
    await f.er.connect(f.actors.lcaService).register(id("MANIFEST/single"), id("hdl:single"), b32("REPO/ARCHIVE"), now + 10 * 365 * 86400, 1);
    await expect(f.cc.connect(f.actors.lcaService).submitResult(f.batchId, { ...f.result, evidenceManifest: id("MANIFEST/single") })).to.be.revertedWithCustomError(f.cc, "EvidenceNotRetained");
  });

  it("flags failed retrieval checks on the certificate and blocks new results until resolved", async function () {
    const f = await loadFixture(readyFixture);
    await f.cc.connect(f.actors.lcaService).submitResult(f.batchId, f.result);
    await f.cc.connect(f.actors.certifier).approveResult(f.batchId, 1);
    await expect(f.er.connect(f.actors.grower).logRetrievalCheck(f.manifest, false)).to.be.revertedWithCustomError(f.er, "Unauthorized");
    await f.er.connect(f.actors.auditor).logRetrievalCheck(f.manifest, false);
    expect((await f.cc.getCertificate(f.batchId)).evidenceCheckFailed).to.equal(true);
    await expect(f.cc.connect(f.actors.lcaService).submitResult(f.batchId, { ...f.result, reportHash: id("REPORT/9") })).to.be.revertedWithCustomError(f.cc, "EvidenceNotRetained");
    await f.er.connect(f.actors.auditor).logRetrievalCheck(f.manifest, true);
    expect((await f.cc.getCertificate(f.batchId)).evidenceCheckFailed).to.equal(false);
    expect((await f.er.evidenceOf(f.manifest)).failedChecks).to.equal(1);
  });

  it("allows retention to be extended but never shortened", async function () {
    const f = await loadFixture(readyFixture);
    const e = await f.er.evidenceOf(f.manifest);
    await expect(f.er.connect(f.actors.lcaService).extendRetention(f.manifest, e.retentionUntil - 1n, 3)).to.be.revertedWithCustomError(f.er, "InvalidArgument");
    await expect(f.er.connect(f.actors.lcaService).extendRetention(f.manifest, e.retentionUntil + 86400n, 4)).to.emit(f.er, "RetentionExtended");
  });
});

describe("Separation of duties and consortium governance", function () {
  it("prevents an account holding both roles from approving its own result", async function () {
    const f = await loadFixture(readyFixture);
    await f.consortium.connect(f.actors.governor).grantRole(ethers.id("CERTIFIER_ROLE"), f.actors.lcaService.address);
    await f.cc.connect(f.actors.lcaService).submitResult(f.batchId, f.result);
    await expect(f.cc.connect(f.actors.lcaService).approveResult(f.batchId, 1)).to.be.revertedWithCustomError(f.cc, "SeparationOfDuties");
  });

  it("admits members only through the governor and only with operational roles", async function () {
    const f = await loadFixture(baseFixture);
    const newcomer = f.signers[15];
    await expect(f.consortium.connect(f.actors.grower).registerActor(newcomer.address, id("A"), id("ORG"), ethers.id("GROWER_ROLE"))).to.be.revertedWithCustomError(
      f.consortium,
      "AccessControlUnauthorizedAccount"
    );
    await expect(f.consortium.connect(f.actors.governor).registerActor(newcomer.address, id("A"), id("ORG"), ethers.ZeroHash)).to.be.revertedWithCustomError(f.consortium, "InvalidRole");
    await expect(f.consortium.connect(f.actors.governor).registerActor(f.actors.grower.address, id("A"), id("ORG"), ethers.id("MILL_ROLE"))).to.be.revertedWithCustomError(
      f.consortium,
      "AlreadyRegistered"
    );
  });
});
