"use strict";
// Replay of the Western Achaia case study through the prototype (three acts):
//   Act 1 — the 2024 season is recorded event by event: farm activities, ten harvest lots with
//           dual-signature custody transfer and transport fuel, one mill batch.
//   Act 2 — the conference-version calculation: factor set FS-2025-CONF (diesel for all portable
//           equipment, implied grid factor of about 0.60 kg CO2eq/kWh). A result package that
//           declares 1 L of oil as functional unit is rejected; the per-kg package is certified.
//   Act 3 — the journal-version corrections: two fuel records are reclassified from diesel to
//           petrol through append-only corrections, FS-2026-01 replaces FS-2025-CONF, and the
//           recalculated result is certified.

const path = require("path");
const { b32, id, ts, eventInput, SourceClass, signObservation, signReceipt, farmScopeId, CertificateStatusName, str32 } = require("./encoding");
const { deployAll, configureConsortium } = require("./deploy");
const { Recorder } = require("./recorder");
const { deviceId } = require("./catalogue");
const { computeBatchResult, factorSetContentHash } = require("../offchain/lca-engine");

const plan = require(path.join(__dirname, "../offchain/case-study/western-achaia.json"));
const FS25 = require(path.join(__dirname, "../offchain/factor-sets/FS-2025-CONF.json"));
const FS26 = require(path.join(__dirname, "../offchain/factor-sets/FS-2026-01.json"));

const milli = (x) => BigInt(Math.round(x * 1000));
const METHOD = { Invoice: "INVOICE", OperatorEntry: "OPERATOR_LOG", Meter: "DEVICE_READING", Estimate: "MILL_ESTIMATE" };

async function runCaseStudyReplay(hre, { traceStorage = false, log = () => {} } = {}) {
  const { ethers } = hre;
  const { time } = require("@nomicfoundation/hardhat-network-helpers");
  const signers = await ethers.getSigners();
  const rec = new Recorder(ethers.provider, { traceStorage });
  const contracts = await deployAll(ethers, signers[0], rec);
  const { actors, devices } = await configureConsortium(contracts, signers, rec);
  const { traceability: ct, certification: cc, factorRegistry: fr, evidenceRegistry: er } = contracts;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const ledger = await ct.getAddress();
  const at = async (iso) => {
    const t = ts(iso);
    if (t > (await time.latest())) await time.increaseTo(t);
  };
  const certificateTimeline = [];
  const snapshotCertificate = async (label) => {
    const c = await cc.getCertificate(batchId);
    const entry = {
      label,
      date: new Date((await time.latest()) * 1000).toISOString(),
      status: CertificateStatusName[Number(c.status)],
      version: Number(c.version),
      kgCO2eqPerFU: Number(c.totalMg) / 1e6,
      factorSet: c.factorSetId === ethers.ZeroHash ? null : str32(c.factorSetId),
      functionalUnit: c.functionalUnit === ethers.ZeroHash ? null : str32(c.functionalUnit),
    };
    certificateTimeline.push(entry);
    log(`  certificate: ${entry.status} v${entry.version} ${entry.kgCO2eqPerFU} (${label})`);
    return entry;
  };

  const orchardId = b32("ORCHARD/WESTERN-ACHAIA-01");
  const cropYear = plan.orchard.cropYear;
  const scopeId = farmScopeId(orchardId, cropYear);
  const batchId = b32("BATCH/WA-01/2024");
  const farmLocation = id("GEO/" + plan.orchard.id);
  const millLocation = id("GEO/MILL/WESTERN-ACHAIA-01");
  const eventIndexByKey = {};

  // ------------------------------------------------------------------ Act 1: the 2024 season
  log("Act 1: season 2024");
  await at("2024-01-02T09:00:00Z");
  await rec.send("CarbonTraceability.registerOrchard", "act1", ct.connect(actors.grower).registerOrchard(orchardId, plan.orchard.areaM2, farmLocation));

  const timeline = [];
  for (const fe of plan.farmEvents) timeline.push({ date: fe.date, kind: "farm", fe });
  plan.harvest.days.forEach((day, i) => timeline.push({ date: `${day}T16:00:00Z`, kind: "harvest", day, i }));
  timeline.push({ date: plan.mill.createdAt, kind: "batch" });
  for (const me of plan.mill.events) timeline.push({ date: me.date, kind: "mill", me });
  timeline.push({ date: plan.mill.closedAt, kind: "closeBatch" });
  timeline.sort((a, b) => ts(a.date) - ts(b.date));

  const lotIds = [];
  for (const item of timeline) {
    if (item.kind === "farm") {
      const fe = item.fe;
      await at(fe.date);
      const e = eventInput({
        activity: fe.activity,
        variable: fe.variable,
        quantity: milli(fe.quantity),
        observedAt: ts(fe.date) - 3600,
        source: SourceClass[fe.source],
        sourceId: fe.documentId ? id("DOCUMENT/" + fe.documentId) : undefined,
        evidenceHash: id(`EVIDENCE/${fe.doc}/${fe.date}/${fe.variable}`),
        locationHash: farmLocation,
        methodCode: METHOD[fe.source],
      });
      const receipt = await rec.send("CarbonTraceability.recordFarmEvent", "act1", ct.connect(actors.grower).recordFarmEvent(orchardId, cropYear, e, "0x"), {
        detail: `${fe.activity}/${fe.variable}`,
      });
      const parsed = receipt.logs.map((l) => ct.interface.parseLog(l)).find((l) => l && l.name === "ActivityRecorded");
      eventIndexByKey[`${fe.activity}/${fe.variable}/${fe.date}`] = Number(parsed.args.index);
      fe._index = Number(parsed.args.index);
      fe._input = e;
    } else if (item.kind === "harvest") {
      const lotId = b32(`LOT/WA-01/2024/${String(item.i + 1).padStart(2, "0")}`);
      lotIds.push(lotId);
      const massG = milli(plan.harvest.lotMassKg);
      await at(`${item.day}T16:00:00Z`);
      await rec.send("CarbonTraceability.registerLot", "act1", ct.connect(actors.grower).registerLot(lotId, orchardId, cropYear, massG, id(`EVIDENCE/harvest-note/${item.day}`)));
      await at(`${item.day}T16:10:00Z`);
      await rec.send(
        "CarbonTraceability.initiateTransfer",
        "act1",
        ct
          .connect(actors.grower)
          .initiateTransfer(lotId, actors.mill.address, actors.transporter.address, massG, Math.round(plan.harvest.transport.distanceKm * 1000), id("VEHICLE/MILL-TRUCK-01"), id(`EVIDENCE/delivery-note/${item.day}`))
      );
      await at(`${item.day}T17:30:00Z`);
      const te = eventInput({
        activity: "TRANSPORT",
        variable: "TRANSPORT_DIESEL_L",
        quantity: milli(plan.harvest.transport.dieselLPerDelivery),
        observedAt: ts(`${item.day}T17:20:00Z`),
        source: SourceClass.OperatorEntry,
        evidenceHash: id(`EVIDENCE/vehicle-fuel-log/${item.day}`),
        locationHash: millLocation,
        methodCode: "OPERATOR_LOG",
      });
      await rec.send("CarbonTraceability.recordTransportEvent", "act1", ct.connect(actors.transporter).recordTransportEvent(lotId, te, "0x"));
      await at(`${item.day}T17:45:00Z`);
      const weighedAt = ts(`${item.day}T17:40:00Z`);
      const wb = deviceId("WEIGHBRIDGE-01");
      const sig = await signReceipt(devices["WEIGHBRIDGE-01"], chainId, ledger, lotId, massG, weighedAt, wb);
      await rec.send("CarbonTraceability.confirmReceipt", "act1", ct.connect(actors.mill).confirmReceipt(lotId, massG, wb, weighedAt, sig));
    } else if (item.kind === "batch") {
      await at(item.date);
      const shares = lotIds.map(() => 1000 / lotIds.length);
      await rec.send("CarbonTraceability.createBatch", "act1", ct.connect(actors.mill).createBatch(batchId, lotIds, shares, b32("MASS_PROPORTIONAL")), {
        detail: `${lotIds.length} lots`,
      });
    } else if (item.kind === "mill") {
      const me = item.me;
      await at(me.date);
      const e = eventInput({
        activity: me.activity,
        variable: me.variable,
        quantity: milli(me.quantity),
        observedAt: ts(me.date) - 600,
        source: SourceClass[me.source],
        sourceId: me.device ? deviceId(me.device) : undefined,
        evidenceHash: id(`EVIDENCE/${me.doc}/${me.date}/${me.variable}`),
        locationHash: millLocation,
        methodCode: METHOD[me.source],
      });
      const sig = me.device ? await signObservation(devices[me.device], chainId, ledger, batchId, e) : "0x";
      await rec.send("CarbonTraceability.recordMillEvent", "act1", ct.connect(actors.mill).recordMillEvent(batchId, e, sig), {
        detail: `${me.variable} (${me.source})`,
      });
    } else if (item.kind === "closeBatch") {
      await at(item.date);
      await rec.send("CarbonTraceability.closeBatch", "act1", ct.connect(actors.mill).closeBatch(batchId, milli(plan.mill.receptionMassKg)));
    }
  }
  await at(plan.farmClosure);
  await rec.send("CarbonTraceability.closeFarmPhase", "act1", ct.connect(actors.grower).closeFarmPhase(orchardId, cropYear));
  await at(plan.farmVerification);
  await rec.send("CarbonTraceability.verifyFarmPhase", "act1", ct.connect(actors.certifier).verifyFarmPhase(orchardId, cropYear, id("VERIFICATION-REPORT/2025-02")));

  // ------------------------------------------------------------------ Act 2: conference version
  log("Act 2: conference-version calculation (FS-2025-CONF)");
  await at("2025-03-01T09:00:00Z");
  const fsId25 = b32(FS25.id);
  await rec.send(
    "FactorRegistry.propose",
    "act2",
    fr.connect(actors.methodAuthorityA).propose(fsId25, FS25.version, factorSetContentHash(FS25), b32("GWP100-PRESUMED"), ts(FS25.validFrom), ts(FS25.validTo), ethers.ZeroHash)
  );
  await at("2025-03-02T09:00:00Z");
  await rec.send("FactorRegistry.approve", "act2", fr.connect(actors.methodAuthorityB).approve(fsId25));

  await at(plan.act2.date);
  const v1 = await computeBatchResult(ct, batchId, FS25, { functionalUnit: "EVOO_1KG_MILL_GATE" });
  const v1Litre = await computeBatchResult(ct, batchId, FS25, { functionalUnit: "EVOO_1L_MILL_GATE" });
  const retention = (await time.latest()) + 10 * 365 * 86400;
  await rec.send("EvidenceRegistry.register", "act2", er.connect(actors.lcaService).register(v1.manifestHash, id("hdl:21.T11148/evoo-wa01-2024-v1"), b32("REPO/CONSORTIUM-ARCHIVE"), retention, 3));
  await rec.send("EvidenceRegistry.register", "act2", er.connect(actors.lcaService).register(v1Litre.manifestHash, id("hdl:21.T11148/evoo-wa01-2024-v1L"), b32("REPO/CONSORTIUM-ARCHIVE"), retention, 3));
  // The conference version expressed the result per liter although oil output was weighed in kg.
  let literRejection = null;
  try {
    await cc.connect(actors.lcaService).submitResult.staticCall(batchId, v1Litre.resultInput);
  } catch (err) {
    const parsed = cc.interface.parseError(err.data);
    literRejection = parsed ? parsed.name : String(err.message);
  }
  log(`  per-liter package rejected: ${literRejection}`);
  await rec.send("CarbonCertification.submitResult", "act2", cc.connect(actors.lcaService).submitResult(batchId, v1.resultInput));
  await snapshotCertificate("after submission of v1 (not yet approved)");
  await at(plan.act2.approval);
  await rec.send("CarbonCertification.approveResult", "act2", cc.connect(actors.certifier).approveResult(batchId, 1));
  await snapshotCertificate("v1 approved");

  // ------------------------------------------------------------------ Act 3: journal version
  log("Act 3: journal-version corrections (FS-2026-01)");
  const fsId26 = b32(FS26.id);
  await at(plan.act3.factorSetProposed);
  await rec.send(
    "FactorRegistry.propose",
    "act3",
    fr.connect(actors.methodAuthorityA).propose(fsId26, FS26.version, factorSetContentHash(FS26), b32("GWP100-PRESUMED"), ts(FS26.validFrom), ts(FS26.validTo), fsId25)
  );
  await at(plan.act3.factorSetApproved);
  await rec.send("FactorRegistry.approve", "act3", fr.connect(actors.methodAuthorityB).approve(fsId26));

  await at(plan.act3.correctionsProposed);
  const correctionIds = [];
  for (const fe of plan.farmEvents.filter((x) => x.correction)) {
    const replacement = { ...fe._input, variable: b32(fe.correction.variable), evidenceHash: id(`EVIDENCE/${fe.correction.doc}/${fe.activity}`) };
    const receipt = await rec.send(
      "CarbonTraceability.proposeCorrection",
      "act3",
      ct.connect(actors.grower).proposeCorrection(fe._index, replacement, "0x", id(fe.correction.reason)),
      { detail: `${fe.activity}: ${fe.variable} -> ${fe.correction.variable}` }
    );
    const parsed = receipt.logs.map((l) => ct.interface.parseLog(l)).find((l) => l && l.name === "CorrectionProposed");
    correctionIds.push(Number(parsed.args.correctionId));
  }
  await snapshotCertificate("corrections proposed, pending authorization");
  await at(plan.act3.correctionsAuthorized);
  for (const cid of correctionIds) {
    await rec.send("CarbonTraceability.authorizeCorrection", "act3", ct.connect(actors.auditor).authorizeCorrection(cid));
  }
  await snapshotCertificate("corrections authorised");
  // The superseded factor set cannot evaluate the corrected chain (no petrol factor).
  let fs25OnCorrectedChain = null;
  try {
    await computeBatchResult(ct, batchId, FS25);
  } catch (err) {
    fs25OnCorrectedChain = err.message;
  }
  await at(plan.act3.oldFactorSetRetired);
  await rec.send("FactorRegistry.retire", "act3", fr.connect(actors.methodAuthorityA).retire(fsId25, id("Undocumented grid factor; petrol equipment classified as diesel")));
  await snapshotCertificate("FS-2025-CONF retired");
  await at(plan.act3.reverification);
  await rec.send("CarbonTraceability.verifyFarmPhase", "act3", ct.connect(actors.certifier).verifyFarmPhase(orchardId, cropYear, id("VERIFICATION-REPORT/2026-06")));
  await at(plan.act3.resultSubmitted);
  const v2 = await computeBatchResult(ct, batchId, FS26, { functionalUnit: "EVOO_1KG_MILL_GATE" });
  const retention2 = (await time.latest()) + 10 * 365 * 86400;
  await rec.send("EvidenceRegistry.register", "act3", er.connect(actors.lcaService).register(v2.manifestHash, id("hdl:21.T11148/evoo-wa01-2024-v2"), b32("REPO/CONSORTIUM-ARCHIVE"), retention2, 3));
  await rec.send("CarbonCertification.submitResult", "act3", cc.connect(actors.lcaService).submitResult(batchId, v2.resultInput));
  await at(plan.act3.approval);
  await rec.send("CarbonCertification.approveResult", "act3", cc.connect(actors.certifier).approveResult(batchId, 2));
  await snapshotCertificate("v2 approved");

  // Alternative allocation packages (computed off-chain only; Section 2.6).
  const economic = await computeBatchResult(ct, batchId, FS26, { allocationRule: "ECONOMIC", prices: { oil: 4.0, pomace: 0.03 } });
  const wetMass = await computeBatchResult(ct, batchId, FS26, { allocationRule: "WET_MASS" });

  const v1Stored = await cc.getResult(batchId, 1);
  const v2Stored = await cc.getResult(batchId, 2);
  return {
    rec,
    contracts,
    actors,
    devices,
    ids: { orchardId, cropYear, scopeId, batchId, lotIds, fsId25, fsId26 },
    results: { v1, v1Litre, v2, economic, wetMass },
    stored: { v1: v1Stored, v2: v2Stored },
    literRejection,
    fs25OnCorrectedChain,
    correctionIds,
    certificateTimeline,
    eventCount: Number(await ct.eventCount()),
  };
}

module.exports = { runCaseStudyReplay, plan, FS25, FS26 };
