"use strict";
// Input validation, life-cycle edge cases and governance paths that complement the
// requirement-mapped tests.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { b32, id, eventInput, SourceClass, LotState, ResultStatus, CertificateStatus, signReceipt } = require("../lib/encoding");
const { deviceId } = require("../lib/catalogue");
const { kg, baseFixture, readyFixture, fieldEvent, deliverLot, millReading } = require("./helpers");

describe("Edge cases — farm phase", function () {
  it("validates orchard registration", async function () {
    const f = await loadFixture(baseFixture);
    const ct = f.traceability.connect(f.actors.grower);
    await expect(ct.registerOrchard(ethers.ZeroHash, 1000, id("geo"))).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await expect(ct.registerOrchard(b32("O2"), 0, id("geo"))).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await expect(ct.registerOrchard(f.orchardId, 1000, id("geo"))).to.be.revertedWithCustomError(ct, "AlreadyExists");
    await expect(f.traceability.connect(f.actors.mill).registerOrchard(b32("O3"), 1000, id("geo"))).to.be.revertedWithCustomError(ct, "Unauthorized");
    expect((await f.traceability.getOrchard(f.orchardId)).areaM2).to.equal(48000);
  });

  it("validates farm events, lots, closure and verification", async function () {
    const f = await loadFixture(baseFixture);
    const ct = f.traceability.connect(f.actors.grower);
    const e = await fieldEvent();
    await expect(ct.recordFarmEvent(f.orchardId, 0, e, "0x")).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await expect(ct.recordFarmEvent(b32("UNKNOWN"), f.cropYear, e, "0x")).to.be.revertedWithCustomError(ct, "NotFound");
    await expect(ct.registerLot(b32("L1"), f.orchardId, f.cropYear, 0, id("n"))).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await expect(ct.closeFarmPhase(f.orchardId, f.cropYear)).to.be.revertedWithCustomError(ct, "InvalidArgument"); // no events, no lots
    await ct.recordFarmEvent(f.orchardId, f.cropYear, e, "0x");
    await ct.registerLot(b32("L1"), f.orchardId, f.cropYear, kg(100), id("n"));
    await expect(ct.registerLot(b32("L1"), f.orchardId, f.cropYear, kg(100), id("n"))).to.be.revertedWithCustomError(ct, "AlreadyExists");
    const certifier = f.traceability.connect(f.actors.certifier);
    await expect(certifier.verifyFarmPhase(f.orchardId, f.cropYear, id("r"))).to.be.revertedWithCustomError(ct, "PhaseNotClosed");
    await ct.closeFarmPhase(f.orchardId, f.cropYear);
    await expect(ct.closeFarmPhase(f.orchardId, f.cropYear)).to.be.revertedWithCustomError(ct, "PhaseClosed");
    await expect(certifier.verifyFarmPhase(f.orchardId, f.cropYear, ethers.ZeroHash)).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await expect(certifier.verifyFarmPhase(f.orchardId, f.cropYear, id("r")))
      .to.emit(ct, "FarmPhaseVerified")
      .withArgs(f.orchardId, f.cropYear, 0, id("r"), f.actors.certifier.address);
  });
});

describe("Edge cases — custody transfer", function () {
  it("validates the sender's declaration", async function () {
    const f = await loadFixture(baseFixture);
    const ct = f.traceability.connect(f.actors.grower);
    const lot = b32("L/1");
    await ct.registerLot(lot, f.orchardId, f.cropYear, kg(4500), id("n"));
    const { mill, transporter, grower, growerColleague } = f.actors;
    await expect(f.traceability.connect(growerColleague).initiateTransfer(lot, mill.address, ethers.ZeroAddress, kg(4500), 9500, id("v"), id("d"))).to.be.revertedWithCustomError(ct, "Unauthorized");
    await expect(ct.initiateTransfer(lot, grower.address, ethers.ZeroAddress, kg(4500), 9500, id("v"), id("d"))).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await expect(ct.initiateTransfer(lot, mill.address, mill.address, kg(4500), 9500, id("v"), id("d"))).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await expect(ct.initiateTransfer(lot, mill.address, transporter.address, kg(4500), 0, id("v"), id("d"))).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await expect(ct.initiateTransfer(lot, mill.address, transporter.address, kg(4000), 9500, id("v"), id("d"))).to.be.revertedWithCustomError(ct, "MassMismatch");
    await ct.initiateTransfer(lot, mill.address, ethers.ZeroAddress, kg(4500), 9500, id("v"), id("d"));
    await expect(ct.initiateTransfer(lot, mill.address, ethers.ZeroAddress, kg(4500), 9500, id("v"), id("d"))).to.be.revertedWithCustomError(ct, "InvalidLotState");
    // Without a designated transporter, the sender reports the transport fuel.
    const fuel = await fieldEvent({ activity: "TRANSPORT", variable: "TRANSPORT_DIESEL_L", quantity: kg(10) });
    await expect(ct.recordTransportEvent(lot, fuel, "0x")).to.emit(ct, "ActivityRecorded");
  });

  it("lets the sender cancel an unconfirmed transfer", async function () {
    const f = await loadFixture(baseFixture);
    const lot = b32("L/2");
    await deliverLot(f, lot, 4500, { confirm: false });
    await expect(f.traceability.connect(f.actors.mill).cancelTransfer(lot)).to.be.revertedWithCustomError(f.traceability, "Unauthorized");
    await expect(f.traceability.connect(f.actors.grower).cancelTransfer(lot)).to.emit(f.traceability, "TransferCancelled").withArgs(lot, f.actors.grower.address);
    expect((await f.traceability.getLot(lot)).state).to.equal(LotState.AtFarm);
    await expect(f.traceability.connect(f.actors.grower).cancelTransfer(lot)).to.be.revertedWithCustomError(f.traceability, "InvalidLotState");
    await f.traceability.connect(f.actors.grower).initiateTransfer(lot, f.actors.mill.address, ethers.ZeroAddress, kg(4500), 9500, id("v"), id("d2"));
    expect((await f.traceability.getLot(lot)).state).to.equal(LotState.InTransit);
  });

  it("validates the receiver's weighing", async function () {
    const f = await loadFixture(baseFixture);
    const lot = b32("L/3");
    await deliverLot(f, lot, 4500, { confirm: false });
    const wb = deviceId("WEIGHBRIDGE-01");
    const tooEarly = (await time.latest()) - 3600;
    const sig = await signReceipt(f.devices["WEIGHBRIDGE-01"], f.chainId, f.ledger, lot, kg(4500), tooEarly, wb);
    await expect(f.traceability.connect(f.actors.mill).confirmReceipt(lot, kg(4500), wb, tooEarly, sig)).to.be.revertedWithCustomError(f.traceability, "FutureTimestamp");
    const t = (await time.latest()) - 5;
    const sigB = await signReceipt(f.devices["WEIGHBRIDGE-01"], f.chainId, f.ledger, lot, kg(4500), t, deviceId("NO-SUCH-DEVICE"));
    await expect(f.traceability.connect(f.actors.mill).confirmReceipt(lot, kg(4500), deviceId("NO-SUCH-DEVICE"), t, sigB)).to.be.revertedWithCustomError(f.traceability, "InvalidDevice");
    await expect(f.traceability.connect(f.actors.mill).confirmReceipt(b32("L/NONE"), kg(4500), wb, t, sig)).to.be.revertedWithCustomError(f.traceability, "InvalidLotState");
  });
});

describe("Edge cases — mill batches", function () {
  async function twoLots() {
    const f = await baseFixture();
    await deliverLot(f, b32("L/A"), 4500);
    await deliverLot(f, b32("L/B"), 4500);
    return f;
  }

  it("validates batch composition", async function () {
    const f = await loadFixture(twoLots);
    const ct = f.traceability.connect(f.actors.mill);
    const lots = [b32("L/A"), b32("L/B")];
    await expect(ct.createBatch(ethers.ZeroHash, lots, [500, 500], b32("MASS_PROPORTIONAL"))).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await expect(ct.createBatch(b32("B"), lots, [1000], b32("MASS_PROPORTIONAL"))).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await expect(ct.createBatch(b32("B"), Array(65).fill(lots[0]), Array(65).fill(15), b32("X"))).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await expect(ct.createBatch(b32("B"), lots, [400, 500], b32("DECLARED"))).to.be.revertedWithCustomError(ct, "SharesMismatch");
    await expect(f.traceability.connect(f.actors.millB).createBatch(b32("B"), lots, [500, 500], b32("DECLARED"))).to.be.revertedWithCustomError(ct, "InvalidLotState");
    await ct.createBatch(b32("B"), lots, [600, 400], b32("DECLARED")); // a declared, non-proportional rule
    await expect(ct.createBatch(b32("B"), lots, [500, 500], b32("DECLARED"))).to.be.revertedWithCustomError(ct, "AlreadyExists");
    const [, ids, shares] = await f.traceability.getBatch(b32("B"));
    expect(ids).to.deep.equal(lots);
    expect(shares.map(Number)).to.deep.equal([600, 400]);
  });

  it("validates mill events and closure", async function () {
    const f = await loadFixture(twoLots);
    const ct = f.traceability.connect(f.actors.mill);
    const batch = b32("B2");
    await ct.createBatch(batch, [b32("L/A"), b32("L/B")], [500, 500], b32("MASS_PROPORTIONAL"));
    const e = eventInput({ activity: "BY_PRODUCT_HANDLING", variable: "MILL_DIESEL_L", quantity: kg(1.2), observedAt: (await time.latest()) - 10, source: SourceClass.Estimate, evidenceHash: id("est"), methodCode: "MILL_ESTIMATE" });
    await expect(ct.recordMillEvent(b32("NONE"), e, "0x")).to.be.revertedWithCustomError(ct, "NotFound");
    await expect(f.traceability.connect(f.actors.millB).recordMillEvent(batch, e, "0x")).to.be.revertedWithCustomError(ct, "Unauthorized");
    await ct.recordMillEvent(batch, e, "0x");
    await millReading(f, batch, "MILL_ELECTRICITY_KWH", 1000, "ELEC-SUBMETER-01");
    await millReading(f, batch, "OIL_OUTPUT_L", 1778.8, "OIL-METER-01");
    await expect(ct.closeBatch(b32("NONE"), kg(9000))).to.be.revertedWithCustomError(ct, "NotFound");
    await expect(f.traceability.connect(f.actors.millB).closeBatch(batch, kg(9000))).to.be.revertedWithCustomError(ct, "Unauthorized");
    await expect(ct.closeBatch(batch, 0)).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await ct.closeBatch(batch, kg(9000));
    await expect(ct.closeBatch(batch, kg(9000))).to.be.revertedWithCustomError(ct, "PhaseClosed");
    await expect(ct.recordMillEvent(batch, { ...e, evidenceHash: id("est2") }, "0x")).to.be.revertedWithCustomError(ct, "PhaseClosed");
    await expect(f.traceability.certificationStatus(b32("NONE"))).to.be.revertedWithCustomError(ct, "NotFound");
    // Transport events are no longer accepted once the batch is closed.
    const fuel = await fieldEvent({ activity: "TRANSPORT", variable: "TRANSPORT_DIESEL_L", quantity: kg(10) });
    await expect(f.traceability.connect(f.actors.transporter).recordTransportEvent(b32("L/A"), fuel, "0x")).to.be.revertedWithCustomError(ct, "InvalidLotState");
  });

  it("applies governed plausibility parameters", async function () {
    const f = await loadFixture(baseFixture);
    const ct = f.traceability;
    await expect(ct.connect(f.actors.grower).setParameters(100, 50, 350, b32("OIL_OUTPUT_L"))).to.be.revertedWithCustomError(ct, "Unauthorized");
    await expect(ct.connect(f.actors.methodAuthorityA).setParameters(1001, 50, 350, b32("OIL_OUTPUT_L"))).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await expect(ct.connect(f.actors.methodAuthorityA).setParameters(200, 100, 300, b32("OIL_OUTPUT_L")))
      .to.emit(ct, "ParametersUpdated")
      .withArgs(200, 100, 300, b32("OIL_OUTPUT_L"));
    expect(await ct.massToleranceBp()).to.equal(200);
    const cc = f.certification;
    await expect(cc.connect(f.actors.methodAuthorityA).setParameters(0, 0)).to.be.revertedWithCustomError(cc, "InvalidArgument");
    await expect(cc.connect(f.actors.methodAuthorityA).setParameters(3, 10 * 365 * 86400)).to.emit(cc, "ParametersUpdated");
    expect(await cc.minEvidenceReplicas()).to.equal(3);
    await expect(cc.connect(f.actors.methodAuthorityA).defineFunctionalUnit(ethers.ZeroHash, "0x6b67000000000000")).to.be.revertedWithCustomError(cc, "InvalidArgument");
    expect(await cc.functionalUnitUnit(b32("EVOO_1KG_MILL_GATE"))).to.equal("0x6b67000000000000");
  });
});

describe("Edge cases — corrections and results", function () {
  it("validates correction identifiers and competing proposals", async function () {
    const f = await loadFixture(readyFixture);
    const ct = f.ct;
    const e = await fieldEvent({ quantity: kg(65) });
    await expect(ct.connect(f.actors.grower).proposeCorrection(0, e, "0x", id("r"))).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await expect(ct.connect(f.actors.grower).proposeCorrection(999, e, "0x", id("r"))).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await expect(ct.connect(f.actors.grower).proposeCorrection(1, e, "0x", ethers.ZeroHash)).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await expect(ct.connect(f.actors.auditor).authorizeCorrection(1)).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await expect(ct.connect(f.actors.auditor).rejectCorrection(1, id("r"))).to.be.revertedWithCustomError(ct, "InvalidArgument");
    await ct.connect(f.actors.grower).proposeCorrection(1, e, "0x", id("first"));
    await ct.connect(f.actors.growerColleague).proposeCorrection(1, { ...e, quantity: kg(66) }, "0x", id("second"));
    expect(await ct.correctionCount()).to.equal(2);
    await ct.connect(f.actors.auditor).authorizeCorrection(1);
    await expect(ct.connect(f.actors.auditor).authorizeCorrection(2)).to.be.revertedWithCustomError(ct, "InvalidStatus");
    await ct.connect(f.actors.auditor).rejectCorrection(2, id("superseded by correction 1"));
    await expect(ct.connect(f.actors.auditor).rejectCorrection(2, id("again"))).to.be.revertedWithCustomError(ct, "InvalidStatus");
  });

  it("handles result versions, approvals and empty certificates", async function () {
    const f = await loadFixture(readyFixture);
    const cc = f.cc;
    expect((await cc.getCertificate(f.batchId)).status).to.equal(CertificateStatus.None);
    await expect(cc.connect(f.actors.certifier).approveResult(f.batchId, 1)).to.be.revertedWithCustomError(cc, "InvalidStatus");
    await cc.connect(f.actors.lcaService).submitResult(f.batchId, f.result);
    await cc.connect(f.actors.lcaService).submitResult(f.batchId, { ...f.result, reportHash: id("REPORT/1b") });
    expect((await cc.getResult(f.batchId, 1)).status).to.equal(ResultStatus.Superseded);
    expect(await cc.resultCount(f.batchId)).to.equal(2);
    await f.fr.connect(f.actors.methodAuthorityA).retire(f.fsId, id("withdrawn"));
    await expect(cc.connect(f.actors.certifier).approveResult(f.batchId, 2)).to.be.revertedWithCustomError(cc, "FactorSetNotUsable");
    expect(await cc.certifiedVersion(f.batchId)).to.equal(0);
  });
});

describe("Edge cases — registries", function () {
  it("validates device registration and calibration", async function () {
    const f = await loadFixture(baseFixture);
    const c = f.consortium;
    const wallet = ethers.Wallet.createRandom();
    await expect(c.connect(f.actors.outsider).registerDevice(b32("D1"), wallet.address, b32("C"))).to.be.revertedWithCustomError(c, "NotActiveMember");
    await expect(c.connect(f.actors.grower).registerDevice(b32("D1"), ethers.ZeroAddress, b32("C"))).to.be.revertedWithCustomError(c, "InvalidArgument");
    await expect(c.connect(f.actors.grower).registerDevice(deviceId("IRRIGATION-METER-01"), wallet.address, b32("C"))).to.be.revertedWithCustomError(c, "DeviceExists");
    await expect(c.connect(f.actors.certifier).recordCalibration(b32("NONE"), id("cal"), 1)).to.be.revertedWithCustomError(c, "UnknownDevice");
    await expect(c.connect(f.actors.certifier).recordCalibration(deviceId("IRRIGATION-METER-01"), ethers.ZeroHash, 1)).to.be.revertedWithCustomError(c, "InvalidArgument");
    await expect(c.connect(f.actors.millB).setDeviceActive(deviceId("IRRIGATION-METER-01"), false)).to.be.revertedWithCustomError(c, "NotDeviceOwner");
    await expect(c.connect(f.actors.grower).setDeviceActive(b32("NONE"), false)).to.be.revertedWithCustomError(c, "UnknownDevice");
    await c.connect(f.actors.governor).setDeviceActive(deviceId("IRRIGATION-METER-01"), false);
    expect((await c.deviceOf(deviceId("IRRIGATION-METER-01"))).active).to.equal(false);
    await expect(c.connect(f.actors.governor).setActorActive(f.actors.outsider.address, false)).to.be.revertedWithCustomError(c, "UnknownActor");
    expect((await c.actorOf(f.actors.grower.address)).organisationId).to.equal(id("ORG/GROWER/WESTERN-ACHAIA-01"));
  });

  it("maintains the list of mandatory mill fields", async function () {
    const f = await loadFixture(baseFixture);
    const c = f.consortium.connect(f.actors.methodAuthorityA);
    expect((await f.consortium.mandatoryMillVariables()).length).to.equal(2);
    await expect(c.defineVariable(b32("X"), "0x6b67000000000000", 0, false, false, 1, 10)).to.be.revertedWithCustomError(c, "InvalidArgument");
    await expect(c.defineVariable(b32("X"), "0x6b67000000000000", 1, false, false, 10, 1)).to.be.revertedWithCustomError(c, "InvalidArgument");
    await c.defineVariable(b32("PROCESS_WATER_M3"), "0x6d33000000000000", 3, true, true, 1, 100000000); // becomes mandatory
    expect((await f.consortium.mandatoryMillVariables()).length).to.equal(3);
    await c.defineVariable(b32("PROCESS_WATER_M3"), "0x6d33000000000000", 3, true, false, 1, 100000000); // no longer mandatory
    expect((await f.consortium.mandatoryMillVariables()).length).to.equal(2);
    await c.deactivateVariable(b32("OIL_OUTPUT_L"));
    expect(await f.consortium.mandatoryMillVariables()).to.deep.equal([b32("MILL_ELECTRICITY_KWH")]);
    await expect(f.consortium.connect(f.actors.grower).deactivateVariable(b32("FIELD_DIESEL_L"))).to.be.revertedWithCustomError(c, "NotActiveMember");
  });

  it("validates factor-set governance", async function () {
    const f = await loadFixture(baseFixture);
    const fr = f.factorRegistry;
    const now = await time.latest();
    await expect(fr.connect(f.actors.grower).propose(b32("FS"), 1, id("d"), b32("GWP"), now, now + 10, ethers.ZeroHash, [0, 0])).to.be.revertedWithCustomError(fr, "Unauthorized");
    await expect(fr.connect(f.actors.lcaService).propose(b32("FS"), 1, id("d"), b32("GWP"), now + 10, now, ethers.ZeroHash, [0, 0])).to.be.revertedWithCustomError(fr, "InvalidArgument");
    await fr.connect(f.actors.lcaService).propose(b32("FS"), 1, id("d"), b32("GWP"), now, now + 1000, ethers.ZeroHash, [0, 0]);
    await expect(fr.connect(f.actors.lcaService).propose(b32("FS"), 1, id("d"), b32("GWP"), now, now + 1000, ethers.ZeroHash, [0, 0])).to.be.revertedWithCustomError(fr, "FactorSetExists");
    await expect(fr.connect(f.actors.methodAuthorityA).approve(b32("NONE"))).to.be.revertedWithCustomError(fr, "InvalidStatus");
    await expect(fr.connect(f.actors.methodAuthorityA).retire(b32("NONE"), id("r"))).to.be.revertedWithCustomError(fr, "InvalidStatus");
    await expect(fr.connect(f.actors.grower).retire(b32("FS"), id("r"))).to.be.revertedWithCustomError(fr, "Unauthorized");
    await fr.connect(f.actors.methodAuthorityA).approve(b32("FS"));
    expect((await fr.factorSetOf(b32("FS"))).approver).to.equal(f.actors.methodAuthorityA.address);
    expect(await fr.isUsable(b32("FS"), now + 2000)).to.equal(false); // outside the validity window
  });

  it("validates evidence registration and retention", async function () {
    const f = await loadFixture(baseFixture);
    const er = f.evidenceRegistry;
    const now = await time.latest();
    await expect(er.connect(f.actors.outsider).register(id("E"), id("p"), b32("R"), now + 1000, 2)).to.be.revertedWithCustomError(er, "Unauthorized");
    await expect(er.connect(f.actors.grower).register(id("E"), id("p"), b32("R"), now - 1, 2)).to.be.revertedWithCustomError(er, "InvalidArgument");
    await er.connect(f.actors.grower).register(id("E"), id("p"), b32("R"), now + 1000, 2);
    await expect(er.connect(f.actors.grower).register(id("E"), id("p"), b32("R"), now + 1000, 2)).to.be.revertedWithCustomError(er, "EvidenceExists");
    await expect(er.connect(f.actors.grower).extendRetention(id("NONE"), now + 2000, 2)).to.be.revertedWithCustomError(er, "UnknownEvidence");
    await expect(er.connect(f.actors.mill).extendRetention(id("E"), now + 2000, 2)).to.be.revertedWithCustomError(er, "Unauthorized");
    await expect(er.connect(f.actors.auditor).logRetrievalCheck(id("NONE"), true)).to.be.revertedWithCustomError(er, "UnknownEvidence");
    await f.consortium.connect(f.actors.governor).setActorActive(f.actors.mill.address, false);
    await expect(er.connect(f.actors.mill).register(id("E2"), id("p"), b32("R"), now + 1000, 2)).to.be.revertedWithCustomError(er, "Unauthorized");
    expect(await er.isRetained(id("E"), now + 500, 2)).to.equal(true);
    expect(await er.isRetained(id("E"), now + 5000, 2)).to.equal(false);
  });
});
