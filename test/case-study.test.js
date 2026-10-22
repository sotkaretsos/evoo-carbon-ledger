"use strict";
// Replays the Western Achaia case study through the prototype and checks that the off-chain
// engine, fed only with the recorded event chain, reproduces the results reported in the article
// (Tables 4 and 5), and that only a result package in the unit of the measured output
// (1 L EVOO) is certified.

const { expect } = require("chai");
const hre = require("hardhat");
const { reset } = require("@nomicfoundation/hardhat-network-helpers");
const { runCaseStudyReplay } = require("../lib/replay");
const { ResultStatus, b32, id, eventInput, SourceClass } = require("../lib/encoding");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { computeBatchResult } = require("../offchain/lca-engine");
const FS = require("../offchain/factor-sets/FS-2026-RECON-01.json");
const { verifyMethodologicalDisclosure } = require("../offchain/methodological-assessment");

describe("Case study — Western Achaia replay", function () {
  let r;
  before(async function () {
    await reset();
    r = await runCaseStudyReplay(hre);
  });

  it("records the season as 40 events with ten dual-signature custody transfers", async function () {
    expect(r.eventCount).to.equal(40); // 25 farm + 10 transport + 5 mill
    for (const lotId of r.ids.lotIds) {
      const t = await r.contracts.traceability.getTransfer(lotId);
      expect(t.confirmedAt).to.be.greaterThan(0n);
      expect(t.receivedMassG).to.equal(4500000n);
    }
    const [batch] = await r.contracts.traceability.getBatch(r.ids.batchId);
    expect(batch.closed).to.equal(true);
    expect(batch.oilOutputMilli).to.equal(8894000n); // mL
  });

  it("records petrol for chainsaws and olive beaters and diesel for the harvesting tractor", function () {
    const fuel = r.results.v1.report.events
      .filter((e) => (e.activity === "PRUNING" || e.activity === "HARVESTING") && e.variable)
      .map((e) => `${e.activity}:${e.variable}:${e.quantity}`)
      .sort();
    expect(fuel).to.deep.equal(["HARVESTING:FIELD_DIESEL_L:70", "HARVESTING:FIELD_PETROL_L:300", "PRUNING:FIELD_PETROL_L:50"]);
    expect(r.results.v1.report.groups.PRUNING_HARVESTING.perHa).to.be.closeTo(205.6, 0.05);
  });

  it("rejects a per-kilogram declaration because the oil output is reported in liters", function () {
    expect(r.kgRejection).to.equal("FunctionalUnitMismatch");
  });

  it("reproduces the baseline of Table 4 (3400.5 kg CO2eq/ha; 1.835 kg CO2eq/L) under FS-2026-RECON-01", function () {
    const v1 = r.results.v1.report;
    expect(v1.referenceFlow).to.deep.equal({ variable: "OIL_OUTPUT_L", unit: "L", quantity: 8894 });
    expect(v1.total.perHa).to.be.closeTo(3400.5, 0.05);
    expect(v1.total.perFU).to.be.closeTo(1.8352, 0.0001);
    const table5 = { SOIL_PREPARATION: 116.5, FERTILISATION: 2615.1, PLANT_PROTECTION: 45.1, PRUNING_HARVESTING: 205.6, TRANSPORT: 55.5, MILL_PROCESSING: 362.7 };
    for (const [group, perHa] of Object.entries(table5)) expect(v1.groups[group].perHa).to.be.closeTo(perHa, 0.05, group);
    expect(v1.phases.cultivation.perFU).to.be.closeTo(1.6095, 0.0001);
    expect(v1.phases.transport.perFU).to.be.closeTo(0.0299, 0.0001);
    expect(v1.phases.mill.perFU).to.be.closeTo(0.1958, 0.0001);
  });

  it("reproduces the allocation variants of Table 5 (economic 1.78; wet mass 0.36)", function () {
    expect(r.results.economic.report.total.perFU).to.be.closeTo(1.78, 0.005);
    expect(r.results.wetMass.report.oilShare).to.be.closeTo(0.194, 0.0005);
    expect(r.results.wetMass.report.total.perFU).to.be.closeTo(0.36, 0.005);
  });

  it("certifies the per-liter result package as version 1", async function () {
    expect(r.stored.v1.status).to.equal(ResultStatus.Approved);
    expect(r.stored.v1.data.totalMg).to.equal(r.results.v1.resultInput.totalMg);
    const c = await r.contracts.certification.getCertificate(r.ids.batchId);
    expect(c.functionalUnit).to.equal(b32("EVOO_1L_MILL_GATE"));
    expect(c.factorSetId).to.equal(b32("FS-2026-RECON-01"));
  });

  it("moves the certificate from no certificate to Valid (v1)", function () {
    expect(r.certificateTimeline.map((c) => `${c.status}:${c.version}`)).to.deep.equal(["None:0", "Valid:1"]);
  });

  it("records mill electricity and oil output as signed readings of calibrated mill meters", async function () {
    const report = r.results.v1.report;
    expect(report.events.find(e => e.variable === "MILL_ELECTRICITY_KWH").source).to.equal("Meter");
    expect(report.events.find(e => e.variable === "OIL_OUTPUT_L").source).to.equal("Meter");
    expect(report.events.some(e => e.source === "Estimate")).to.equal(false);
    expect((await r.contracts.consortium.getVariable(b32("MILL_ELECTRICITY_KWH"))).mandatoryForClosure).to.equal(true);
    expect((await r.contracts.consortium.getVariable(b32("MILL_ELECTRICITY_KWH"))).meterRequired).to.equal(true);
  });

  it("retains the methodological status and limitation flags in the approved public certificate", async function () {
    const a = r.results.v1.report.methodologicalAssessment;
    expect(a.status).to.equal("AggregateLimited");
    expect(a.limitationFlags).to.equal(73);
    const c = await r.contracts.certification.getCertificate(r.ids.batchId);
    expect(c.methodologicalStatus).to.equal(1);
    expect(Number(c.limitationFlags)).to.equal(a.limitationFlags);
    expect(c.assessmentHash).to.equal(r.results.v1.report.assessmentHash);
    expect(verifyMethodologicalDisclosure(r.results.v1.report, c)).to.equal(true);
    const publicFields = { reportHash:c.reportHash,methodologicalStatus:c.methodologicalStatus,limitationFlags:c.limitationFlags,assessmentHash:c.assessmentHash,methodologicalCommitment:c.methodologicalCommitment };
    expect(verifyMethodologicalDisclosure(r.results.v1.report, { ...publicFields, limitationFlags:31 })).to.equal(false);
    expect(verifyMethodologicalDisclosure(r.results.v1.report, { ...publicFields, methodologicalStatus:0 })).to.equal(false);
    const alteredReport=structuredClone(r.results.v1.report);
    alteredReport.methodologicalAssessment.uncertainty.quantitativeInterval=[0,1];
    expect(verifyMethodologicalDisclosure(alteredReport,c)).to.equal(false);
  });

  it("keeps NeedsRecalculation after a correction of the principal fertilizer alone", async function () {
    const { traceability: ct, certification: cc, evidenceRegistry: er } = r.contracts;
    const replacement = eventInput({ activity:"FERTILISATION",variable:"COMPOUND_FERTILISER_KG",quantity:2800000n,observedAt:(await time.latest())-1,source:SourceClass.OperatorEntry,evidenceHash:id("synthetic corrected quantity"),methodCode:"OPERATOR_LOG",materialCode:"NPK_21_7_14_PLAIN" });
    await ct.connect(r.actors.grower).proposeCorrection(1,replacement,"0x",id("synthetic independent principal change"));
    await ct.connect(r.actors.auditor).authorizeCorrection(1);
    await ct.connect(r.actors.certifier).verifyFarmPhase(r.ids.orchardId,r.ids.cropYear,id("renewed verification"));
    const corrected=await computeBatchResult(ct,r.ids.batchId,FS);
    expect(corrected.report.methodologicalAssessment.status).to.equal("NeedsRecalculation");
    expect(corrected.report.total.perFU).to.be.greaterThan(r.results.v1.report.total.perFU);
    await er.connect(r.actors.lcaService).register(corrected.manifestHash,id("synthetic corrected manifest"),b32("REPO"),(await time.latest())+10*365*86400,3);
    await cc.connect(r.actors.lcaService).submitResult(r.ids.batchId,corrected.resultInput);
    await cc.connect(r.actors.certifier).approveResult(r.ids.batchId,2);
    const c=await cc.getCertificate(r.ids.batchId);
    expect(c.status).to.equal(1);
    expect(c.methodologicalStatus).to.equal(2);
    expect(c.limitationFlags).to.equal(201);
    expect(c.reportHash).to.equal(corrected.reportHash);
    expect(c.assessmentHash).to.equal(corrected.resultInput.assessmentHash);
    expect((await cc.getResult(r.ids.batchId,1)).data.methodologicalStatus).to.equal(1);
  });
});
