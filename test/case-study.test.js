"use strict";
// Replays the Western Achaia case study through the prototype and checks that the off-chain
// engine, fed only with the recorded event chain, reproduces the results reported in the article
// (Table 5, Section 3.3) and by the source calculation, and that the certificate follows the
// correction history.

const { expect } = require("chai");
const hre = require("hardhat");
const { reset } = require("@nomicfoundation/hardhat-network-helpers");
const { runCaseStudyReplay } = require("../lib/replay");
const { EventStatus, ResultStatus } = require("../lib/encoding");

describe("Case study — Western Achaia replay", function () {
  let r;
  before(async function () {
    await reset();
    r = await runCaseStudyReplay(hre);
  });

  it("records the season as 42 events with ten dual-signature custody transfers", async function () {
    expect(r.eventCount).to.equal(42); // 25 farm + 10 transport + 5 mill + 2 replacements
    for (const lotId of r.ids.lotIds) {
      const t = await r.contracts.traceability.getTransfer(lotId);
      expect(t.confirmedAt).to.be.greaterThan(0n);
      expect(t.receivedMassG).to.equal(4500000n);
    }
    const [batch] = await r.contracts.traceability.getBatch(r.ids.batchId);
    expect(batch.closed).to.equal(true);
    expect(batch.oilOutputMilli).to.equal(8894000n);
  });

  it("reproduces the source-calculation result (1.993 kg CO2eq per kg) under FS-2025-CONF", function () {
    const v1 = r.results.v1.report;
    expect(v1.total.perKgOil).to.be.closeTo(1.993, 0.0005);
    expect(v1.total.perHa).to.be.closeTo(3693.0, 0.5);
    expect(v1.groups.PRUNING_HARVESTING.perHa).to.be.closeTo(233.0, 0.01);
    expect(v1.groups.MILL_PROCESSING.perHa).to.be.closeTo(627.91, 0.01);
  });

  it("rejects the per-liter declaration of the source calculation", function () {
    expect(r.literRejection).to.equal("FunctionalUnitMismatch");
  });

  it("reproduces the baseline of Table 5 (3400.5 kg CO2eq/ha; 1.835 kg CO2eq/kg) under FS-2026-01", function () {
    const v2 = r.results.v2.report;
    expect(v2.total.perHa).to.be.closeTo(3400.5, 0.05);
    expect(v2.total.perKgOil).to.be.closeTo(1.8352, 0.0001);
    const table5 = { SOIL_PREPARATION: 116.5, FERTILISATION: 2615.1, PLANT_PROTECTION: 45.1, PRUNING_HARVESTING: 205.6, TRANSPORT: 55.5, MILL_PROCESSING: 362.7 };
    for (const [group, perHa] of Object.entries(table5)) expect(v2.groups[group].perHa).to.be.closeTo(perHa, 0.051, group);
    expect(v2.phases.cultivation.perKgOil).to.be.closeTo(1.6095, 0.0001);
    expect(v2.phases.transport.perKgOil).to.be.closeTo(0.0299, 0.0001);
    expect(v2.phases.mill.perKgOil).to.be.closeTo(0.1958, 0.0001);
    expect(r.stored.v2.data.totalMg).to.equal(r.results.v2.resultInput.totalMg);
  });

  it("reproduces the allocation variants of Table 7 (economic 1.78; wet mass 0.38)", function () {
    expect(r.results.economic.report.total.perKgOil).to.be.closeTo(1.78, 0.005);
    expect(r.results.wetMass.report.total.perKgOil).to.be.closeTo(0.38, 0.005);
  });

  it("keeps the superseded fuel records and both result versions", async function () {
    const ct = r.contracts.traceability;
    let superseded = 0;
    for (let i = 1; i <= r.eventCount; i++) if (Number((await ct.getActivityEvent(i)).status) === EventStatus.Superseded) superseded++;
    expect(superseded).to.equal(2);
    expect(r.stored.v1.status).to.equal(ResultStatus.Superseded);
    expect(r.stored.v2.status).to.equal(ResultStatus.Approved);
    expect(r.fs25OnCorrectedChain).to.match(/PETROL/);
  });

  it("moves the certificate through Valid (v1), Outdated and Valid (v2)", function () {
    expect(r.certificateTimeline.map((c) => `${c.status}:${c.version}`)).to.deep.equal(["None:0", "Valid:1", "Valid:1", "Outdated:1", "Outdated:1", "Valid:2"]);
  });
});
