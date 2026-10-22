"use strict";
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { baseFixture, readyFixture, deliverLot, kg } = require("./helpers");
const { b32, id, hashJson, coder, eventInput, SourceClass, CertificateStatus } = require("../lib/encoding");
const { assessAggregate, assessMethodology, Limitation } = require("../offchain/methodological-assessment");
const FS = require("../offchain/factor-sets/FS-2026-RECON-01.json");
const plan = require("../offchain/case-study/western-achaia.json");

const baseline = () => structuredClone(plan.farmEvents);
function assessment(events, areaHa = 4.8) {
  return assessMethodology(FS, assessAggregate(FS, "SCOPE", areaHa, events), events);
}

describe("Methodological applicability — group intensities", function () {
  it("returns AggregateLimited for the reference input pattern of the group intensities", function () {
    const a = assessment(baseline());
    expect(a.details.status).to.equal("AggregateLimited");
    expect(a.details.applicability.every(s => s.applicable)).to.equal(true);
    expect(a.flags & 9).to.equal(9);
    expect(a.details.uncertainty.quantitativeInterval).to.equal(null);
    expect(a.assessmentHash).to.equal(hashJson(a.details));
  });

  it("returns AggregateLimited for a common proportional change of all fertilization inputs", function () {
    const events = baseline();
    for (const e of events) if (["FERTILISATION", "FOLIAR_FERTILISATION"].includes(e.activity)) e.quantity *= 2;
    const a = assessment(events);
    expect(a.details.status).to.equal("AggregateLimited");
    expect(a.details.applicability[0].classification).to.equal("proportional_arithmetic_extrapolation");
    expect(a.details.applicability[0].scale).to.equal(2);
  });

  for (const [name, activity, variable] of [
    ["the principal fertilizer alone", "FERTILISATION", "COMPOUND_FERTILISER_KG"],
    ["the foliar fertilizer alone", "FOLIAR_FERTILISATION", "FOLIAR_FERTILISER_KG"],
    ["the foliar diesel alone", "FOLIAR_FERTILISATION", "FIELD_DIESEL_L"],
    ["the spray water alone", "FOLIAR_FERTILISATION", "SPRAY_WATER_M3"],
  ]) {
    it(`requires recalculation after changing ${name}`, function () {
      const events = baseline();
      events.find(e => e.activity === activity && e.variable === variable).quantity *= 1.1;
      const a = assessment(events);
      expect(a.details.status).to.equal("NeedsRecalculation");
      expect(a.flags & Limitation.CalibrationMismatch).to.not.equal(0);
      expect(a.details.numericalUse).to.include("Recalculation required");
    });
  }

  it("requires recalculation when a material code is missing or different", function () {
    for (const materialCode of [undefined, "OTHER_NPK"] ) {
      const events = baseline();
      events[0].materialCode = materialCode;
      const a = assessment(events);
      expect(a.details.status).to.equal("NeedsRecalculation");
      expect(a.flags & Limitation.MaterialIdentityMismatch).to.not.equal(0);
    }
  });

  it("requires recalculation for missing inputs and independent plant-protection changes", function () {
    const missing = baseline().filter(e => e.variable !== "FOLIAR_FERTILISER_KG");
    expect(assessment(missing).details.status).to.equal("NeedsRecalculation");
    const changed = baseline();
    changed.find(e => e.variable === "COPPER_OXYCHLORIDE_KG").quantity += 1;
    expect(assessment(changed).details.status).to.equal("NeedsRecalculation");
  });

  it("checks each orchard before allocation, so offsetting changes cannot cancel in a mixed batch", function () {
    const a = baseline(), b = baseline();
    a[0].quantity += 10; b[0].quantity -= 10;
    const scopes = [...assessAggregate(FS, "A", 4.8, a), ...assessAggregate(FS, "B", 4.8, b)];
    expect(assessMethodology(FS, scopes, [...a, ...b]).details.status).to.equal("NeedsRecalculation");
    expect(scopes.filter(s => s.group === "FERTILISATION").every(s => !s.applicable)).to.equal(true);
  });

  it("keeps a synthetic process example Unassessed", function () {
    const a = assessMethodology({ methodologicalPolicy: { minimumStatus: 0, requiredLimitations: 1024 } }, [], []);
    expect(a.details.status).to.equal("Unassessed");
    expect(a.flags & Limitation.SyntheticProcessExample).to.equal(1024);
  });
});

async function policyFixture() {
  const f = await readyFixture();
  const now = await time.latest();
  const factorSetId = b32("RECON_POLICY_TEST");
  await f.fr.connect(f.actors.methodAuthorityA).propose(factorSetId, 2, id("reconstruction document"), b32("GWP_UNSPECIFIED"), now-10, now+100000, ethers.ZeroHash, [1,31]);
  await f.fr.connect(f.actors.methodAuthorityB).approve(factorSetId);
  return { ...f, reconstructed: { ...f.result, factorSetId, methodologicalStatus: 1, limitationFlags: 31, assessmentHash: id("ASSESSMENT/1") } };
}

describe("Methodological assurance — public certificate and governed floor", function () {
  it("rejects an Unassessed package or missing mandatory limitation flags", async function () {
    const f = await loadFixture(policyFixture);
    for (const change of [{ methodologicalStatus: 0 }, { limitationFlags: 30 }, { limitationFlags: 0 }, { assessmentHash: ethers.ZeroHash }]) {
      await expect(f.cc.connect(f.actors.lcaService).submitResult(f.batchId, { ...f.reconstructed, ...change }))
        .to.be.revertedWithCustomError(f.cc, "MethodologicalPolicyViolation");
    }
  });

  it("preserves AggregateLimited and its report-bound assessment after procedural approval", async function () {
    const f = await loadFixture(policyFixture);
    await f.cc.connect(f.actors.lcaService).submitResult(f.batchId, f.reconstructed);
    await f.cc.connect(f.actors.certifier).approveResult(f.batchId, 1);
    const c = await f.cc.getCertificate(f.batchId);
    expect(c.status).to.equal(CertificateStatus.Valid);
    expect(c.methodologicalStatus).to.equal(1);
    expect(c.limitationFlags).to.equal(31);
    expect(c.assessmentHash).to.equal(f.reconstructed.assessmentHash);
    expect(c.methodologicalCommitment).to.equal(ethers.keccak256(coder.encode(["bytes32","uint8","uint32","bytes32"], [c.reportHash,c.methodologicalStatus,c.limitationFlags,c.assessmentHash])));
  });

  it("preserves NeedsRecalculation restrictions through approval and supersession", async function () {
    const f = await loadFixture(policyFixture);
    await f.cc.connect(f.actors.lcaService).submitResult(f.batchId, f.reconstructed);
    await f.cc.connect(f.actors.certifier).approveResult(f.batchId, 1);
    const restricted = { ...f.reconstructed, methodologicalStatus: 2, limitationFlags: 159, reportHash: id("RESTRICTED/REPORT"), assessmentHash: id("RESTRICTED/ASSESSMENT") };
    await f.cc.connect(f.actors.lcaService).submitResult(f.batchId, restricted);
    await f.cc.connect(f.actors.certifier).approveResult(f.batchId, 2);
    const c = await f.cc.getCertificate(f.batchId);
    expect(c.status).to.equal(CertificateStatus.Valid); // workflow only
    expect(c.version).to.equal(2);
    expect(c.methodologicalStatus).to.equal(2);
    expect(c.limitationFlags).to.equal(159);
    expect(c.assessmentHash).to.equal(restricted.assessmentHash);
    expect((await f.cc.getResult(f.batchId, 1)).data.methodologicalStatus).to.equal(1);
  });

  it("rejects an undefined methodological status in factor governance", async function () {
    const f = await loadFixture(policyFixture), now = await time.latest();
    await expect(f.fr.connect(f.actors.methodAuthorityA).propose(b32("INVALID_METHOD"), 1, id("doc"), b32("GWP"), now, now+1000, ethers.ZeroHash, [3,31]))
      .to.be.revertedWithCustomError(f.fr, "InvalidArgument");
  });
});

describe("Mandatory mill inputs", function () {
  it("requires the mandatory mill inputs and keeps their source classes", async function () {
    const f = await loadFixture(baseFixture);
    for (const code of ["MILL_ELECTRICITY_KWH", "OIL_OUTPUT_L"]) {
      const v = await f.consortium.getVariable(b32(code));
      await f.consortium.connect(f.actors.methodAuthorityA).defineVariable(b32(code), v.unit, v.phase, false, true, v.minQuantity, v.maxQuantity);
    }
    const lot=b32("REPORTED_LOT"), batch=b32("REPORTED_BATCH");
    await deliverLot(f, lot, 1000);
    await f.traceability.connect(f.actors.mill).createBatch(batch,[lot],[1000],ethers.ZeroHash);
    const e = (variable, quantity, source) => eventInput({activity:"MILL_PROCESSING",variable,quantity:kg(quantity),observedAt:1,source,evidenceHash:id(variable),methodCode:"REPORTED"});
    await f.traceability.connect(f.actors.mill).recordMillEvent(batch,e("OIL_OUTPUT_L",200,SourceClass.OperatorEntry),"0x");
    await expect(f.traceability.connect(f.actors.mill).closeBatch(batch,kg(1000)))
      .to.be.revertedWithCustomError(f.traceability,"MissingMandatoryVariable").withArgs(b32("MILL_ELECTRICITY_KWH"));
    await f.traceability.connect(f.actors.mill).recordMillEvent(batch,e("MILL_ELECTRICITY_KWH",111,SourceClass.Estimate),"0x");
    await f.traceability.connect(f.actors.mill).closeBatch(batch,kg(1000));
    expect((await f.traceability.getActivityEvent(2)).source).to.equal(SourceClass.Estimate);
    expect((await f.traceability.getBatch(batch))[0].closed).to.equal(true);
  });
});
