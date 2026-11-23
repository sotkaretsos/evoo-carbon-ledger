"use strict";
// Each role restriction and governance guard tested on its own. Added in release 1.3.0 after the systematic mutation
// analysis (scripts/mutation-systematic.js) showed that removing several onlyRole modifiers left
// the suite passing, because organization or custody checks rejected the same calls in the
// existing tests. Here the caller passes every other check: it is the legitimate account after
// suspension by the governor, or an account of the right organization with another role.

const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { b32, id, unit8, signReceipt } = require("../lib/encoding");
const { deviceId } = require("../lib/catalogue");
const { kg, baseFixture, readyFixture, fieldEvent, deliverLot, millReading } = require("./helpers");

const suspend = async (f, actor) => (await f.consortium.connect(f.actors.governor).setActorActive(actor.address, false)).wait();

describe("R5 — role restrictions and governance guards enforced on their own (mutation analysis)", function () {
  it("a suspended grower can no longer register orchards, record events, register or transfer lots, or close its farm phase", async function () {
    const f = await loadFixture(baseFixture);
    const { traceability: ct, actors } = f;
    const g = ct.connect(actors.grower);
    await (await g.recordFarmEvent(f.orchardId, f.cropYear, await fieldEvent(), "0x")).wait();
    const lot = b32("LOT/ROLE/1");
    await (await g.registerLot(lot, f.orchardId, f.cropYear, kg(1000), id("note/role/1"))).wait();
    await suspend(f, actors.grower);
    await expect(g.registerOrchard(b32("ORCHARD/ROLE-02"), 1000, id("geo"))).to.be.revertedWithCustomError(ct, "Unauthorized");
    await expect(g.recordFarmEvent(f.orchardId, f.cropYear, await fieldEvent(), "0x")).to.be.revertedWithCustomError(ct, "Unauthorized");
    await expect(g.registerLot(b32("LOT/ROLE/2"), f.orchardId, f.cropYear, kg(500), id("note/role/2"))).to.be.revertedWithCustomError(ct, "Unauthorized");
    await expect(g.initiateTransfer(lot, actors.mill.address, actors.transporter.address, kg(1000), 9500, id("veh"), id("dn"))).to.be.revertedWithCustomError(ct, "Unauthorized");
    await expect(g.closeFarmPhase(f.orchardId, f.cropYear)).to.be.revertedWithCustomError(ct, "Unauthorized");
  });

  it("a suspended mill can no longer confirm receipts or create, record or close batches", async function () {
    const f = await loadFixture(baseFixture);
    const { traceability: ct, actors, devices } = f;
    await (await ct.connect(actors.grower).recordFarmEvent(f.orchardId, f.cropYear, await fieldEvent(), "0x")).wait();
    const [l1, l2, l3, l4] = ["LOT/RM/1", "LOT/RM/2", "LOT/RM/3", "LOT/RM/4"].map(b32);
    await deliverLot(f, l1, 4500);
    await deliverLot(f, l2, 4500);
    await deliverLot(f, l3, 1000, { confirm: false });
    await deliverLot(f, l4, 1000);
    const batch = b32("BATCH/RM/1");
    const m = ct.connect(actors.mill);
    await (await m.createBatch(batch, [l1, l2], [500, 500], b32("MASS_PROPORTIONAL"))).wait();
    await (await millReading(f, batch, "MILL_ELECTRICITY_KWH", 1000, "ELEC-SUBMETER-01")).wait();
    await (await millReading(f, batch, "OIL_OUTPUT_L", 1778.8, "OIL-METER-01")).wait();
    await suspend(f, actors.mill);
    const wb = deviceId("WEIGHBRIDGE-01");
    const t = (await time.latest()) - 10;
    const sig = await signReceipt(devices["WEIGHBRIDGE-01"], f.chainId, f.ledger, l3, kg(1000), t, wb);
    await expect(m.confirmReceipt(l3, kg(1000), wb, t, sig)).to.be.revertedWithCustomError(ct, "Unauthorized");
    await expect(m.createBatch(b32("BATCH/RM/2"), [l4], [1000], b32("MASS_PROPORTIONAL"))).to.be.revertedWithCustomError(ct, "Unauthorized");
    await expect(millReading(f, batch, "MILL_ELECTRICITY_KWH", 10, "ELEC-SUBMETER-01")).to.be.revertedWithCustomError(ct, "Unauthorized");
    await expect(m.closeBatch(batch, kg(9000))).to.be.revertedWithCustomError(ct, "Unauthorized");
  });

  it("a transporter of the mill's organization cannot record mill events or close batches", async function () {
    const f = await loadFixture(baseFixture);
    const { traceability: ct, actors } = f;
    await (await ct.connect(actors.grower).recordFarmEvent(f.orchardId, f.cropYear, await fieldEvent(), "0x")).wait();
    const lots = [b32("LOT/TR/1"), b32("LOT/TR/2")];
    for (const l of lots) await deliverLot(f, l, 4500);
    const batch = b32("BATCH/TR/1");
    await (await ct.connect(actors.mill).createBatch(batch, lots, [500, 500], b32("MASS_PROPORTIONAL"))).wait();
    await (await millReading(f, batch, "MILL_ELECTRICITY_KWH", 1000, "ELEC-SUBMETER-01")).wait();
    await (await millReading(f, batch, "OIL_OUTPUT_L", 1778.8, "OIL-METER-01")).wait();
    const tr = ct.connect(actors.transporter);
    const now = await time.latest();
    const { eventInput, SourceClass } = require("../lib/encoding");
    const e = eventInput({ activity: "MILL_PROCESSING", variable: "MILL_DIESEL_L", quantity: kg(5), observedAt: now - 30, source: SourceClass.OperatorEntry, evidenceHash: id("EVIDENCE/mill-diesel/transporter") });
    await expect(tr.recordMillEvent(batch, e, "0x")).to.be.revertedWithCustomError(ct, "Unauthorized");
    await expect(tr.closeBatch(batch, kg(9000))).to.be.revertedWithCustomError(ct, "Unauthorized");
  });

  it("a suspended certifier cannot verify farm phases or approve results, and a suspended LCA service cannot submit results", async function () {
    const f = await loadFixture(readyFixture);
    const { ct, cc, actors } = f;
    await (await cc.connect(actors.lcaService).submitResult(f.batchId, f.result)).wait();
    await suspend(f, actors.certifier);
    await expect(ct.connect(actors.certifier).verifyFarmPhase(f.orchardId, f.cropYear, id("VERIFICATION-REPORT/2"))).to.be.revertedWithCustomError(ct, "Unauthorized");
    await expect(cc.connect(actors.certifier).approveResult(f.batchId, 1)).to.be.revertedWithCustomError(cc, "Unauthorized");
    await suspend(f, actors.lcaService);
    const snapshot = await (await require("hardhat").ethers.provider).getBlock("latest");
    const [, , , digest] = await ct.certificationStatus(f.batchId);
    const again = { ...f.result, reportHash: id("REPORT/2"), expectedRevisionDigest: digest, snapshotBlockNumber: snapshot.number, snapshotBlockHash: snapshot.hash };
    await expect(cc.connect(actors.lcaService).submitResult(f.batchId, again)).to.be.revertedWithCustomError(cc, "Unauthorized");
  });

  it("a suspended auditor can neither authorize nor reject a correction", async function () {
    const f = await loadFixture(readyFixture);
    const { ct, actors } = f;
    const orig = await ct.getActivityEvent(f.farmEventIndex);
    const replacement = await fieldEvent({ quantity: orig.quantity + kg(5), evidenceHash: id("EVIDENCE/corrected-fuel-log") });
    await (await ct.connect(actors.grower).proposeCorrection(f.farmEventIndex, replacement, "0x", id("REASON/typo"))).wait();
    const correctionId = Number(await ct.correctionCount());
    await suspend(f, actors.auditor);
    await expect(ct.connect(actors.auditor).authorizeCorrection(correctionId)).to.be.revertedWithCustomError(ct, "Unauthorized");
    await expect(ct.connect(actors.auditor).rejectCorrection(correctionId, id("REASON/reject"))).to.be.revertedWithCustomError(ct, "Unauthorized");
  });

  it("a suspended method authority can neither change parameters nor define functional units", async function () {
    const f = await loadFixture(baseFixture);
    const { traceability: ct, certification: cc, actors } = f;
    await suspend(f, actors.methodAuthorityA);
    const ma = actors.methodAuthorityA;
    await expect(ct.connect(ma).setParameters(100, 50, 350, b32("OIL_OUTPUT_L"))).to.be.revertedWithCustomError(ct, "Unauthorized");
    await expect(cc.connect(ma).setParameters(3, 10 * 365 * 86400)).to.be.revertedWithCustomError(cc, "Unauthorized");
    await expect(cc.connect(ma).defineFunctionalUnit(b32("EVOO_1L_ROLE_TEST"), unit8("L"))).to.be.revertedWithCustomError(cc, "Unauthorized");
  });

  it("the consortium rejects a zero governor and actors registered without account, identity or organization", async function () {
    const f = await loadFixture(baseFixture);
    const { consortium, actors, signers } = f;
    const { ethers } = require("hardhat");
    const factory = await ethers.getContractFactory("Consortium", actors.governor);
    await expect(factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(consortium, "InvalidArgument");
    const gov = consortium.connect(actors.governor);
    const who = signers[14].address;
    await expect(gov.registerActor(ethers.ZeroAddress, id("ACTOR/x"), id("ORG/X"), id("GROWER_ROLE"))).to.be.revertedWithCustomError(consortium, "InvalidArgument");
    await expect(gov.registerActor(who, ethers.ZeroHash, id("ORG/X"), id("GROWER_ROLE"))).to.be.revertedWithCustomError(consortium, "InvalidArgument");
    await expect(gov.registerActor(who, id("ACTOR/x"), ethers.ZeroHash, id("GROWER_ROLE"))).to.be.revertedWithCustomError(consortium, "InvalidArgument");
  });

  it("only the governor can register or suspend actors", async function () {
    const f = await loadFixture(baseFixture);
    const { consortium, actors, signers } = f;
    const stranger = signers[13];
    await expect(consortium.connect(actors.methodAuthorityA).registerActor(stranger.address, id("ACTOR/stranger"), id("ORG/X"), id("GROWER_ROLE"))).to.be.reverted;
    await expect(consortium.connect(actors.certifier).setActorActive(actors.grower.address, false)).to.be.reverted;
  });
});
