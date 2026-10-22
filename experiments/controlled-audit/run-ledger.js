"use strict";
// Producer under evaluation. Uses the real contracts and production engine.
// The separate Python verifier never imports this module or lca-engine.
// Run from repository root: node node_modules/hardhat/internal/cli/cli.js run experiments/controlled-audit/run-ledger.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const hre = require("hardhat");
const { time, reset } = require("@nomicfoundation/hardhat-network-helpers");
const { deployAll, configureConsortium } = require("../../lib/deploy");
const { deviceId } = require("../../lib/catalogue");
const { b32, id, str32, eventInput, SourceClass, SourceClassName, signObservation,
  signReceipt, farmScopeId, deviceWallet, canonicalJson, CertificateStatusName } = require("../../lib/encoding");
const { computeBatchResult, factorSetContentHash } = require("../../offchain/lca-engine");

const ROOT = __dirname;
const OUT = path.join(ROOT, "results");
const read = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name), "utf8"));
const design = read("design.json");
const factors = read("factors.synthetic.json");
const expectations = read("expectations.json");
const index = read("evidence-index.json");
const sha = (raw) => "0x" + crypto.createHash("sha256").update(raw).digest("hex");
const json = (value) => JSON.stringify(JSON.parse(canonicalJson(value)), null, 2) + "\n";
const save = (name, value) => fs.writeFileSync(path.join(OUT, name), json(value));
const milli = (text) => {
  if (!/^\d+(\.\d{1,3})?$/.test(String(text))) throw new Error("Fixture quantity must have at most 3 decimals: " + text);
  const [whole, decimal = ""] = String(text).split(".");
  return BigInt(whole) * 1000n + BigInt(decimal.padEnd(3, "0"));
};
const byEvidenceId = new Map(index.entries.map((entry) => [entry.evidenceId, entry]));
const byHash = new Map(index.entries.map((entry) => [entry.sha256.toLowerCase(), entry]));
function evidence(name) {
  const entry = byEvidenceId.get(name);
  if (!entry) throw new Error("Unknown evidence: " + name);
  const raw = fs.readFileSync(path.join(ROOT, entry.path));
  if (sha(raw) !== entry.sha256) throw new Error("Fixture integrity failure: " + name);
  return { entry, body: JSON.parse(raw.toString("utf8")) };
}

async function main() {
  const started = process.hrtime.bigint();
  for (const [name, digest] of Object.entries(index.fixtureCommitments)) {
    if (sha(fs.readFileSync(path.join(ROOT, name))) !== "0x" + digest) throw new Error("Predeclared fixture changed: " + name);
  }
  fs.mkdirSync(OUT, { recursive: true });
  await reset();
  const { ethers } = hre;
  const signers = await ethers.getSigners();
  const contracts = await deployAll(ethers, signers[0]);
  const { actors, devices } = await configureConsortium(contracts, signers);
  const { traceability: ct, certification: cc, factorRegistry: fr, evidenceRegistry: er, consortium } = contracts;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const ledger = await ct.getAddress();
  const actorRegistry = {};
  for (const key of ["grower", "growerB", "transporter", "mill", "lcaService", "certifier", "auditor"]) {
    const onchain = await consortium.actorOf(actors[key].address);
    actorRegistry[key] = { address: actors[key].address, organisationId: onchain.organisationId };
  }
  devices["SYN-IRRIGATION-B"] = deviceWallet("SYN-IRRIGATION-B");
  await (await consortium.connect(actors.growerB).registerDevice(deviceId("SYN-IRRIGATION-B"), devices["SYN-IRRIGATION-B"].address, b32("SYN-TEST-ONLY"))).wait();
  await (await consortium.connect(actors.certifier).recordCalibration(deviceId("SYN-IRRIGATION-B"), id("SYNTHETIC-NOT-REAL-CALIBRATION"), 1830297599)).wait();
  const sourceRegistry = {};
  for (const entry of index.entries) {
    const body = evidence(entry.evidenceId).body;
    if (body.recordType !== "Activity") continue;
    const sourceId = body.source === "Meter" ? deviceId(body.sourceCode) : id("SYN-SOURCE/" + body.sourceCode);
    sourceRegistry[body.sourceCode] = { sourceId, source: body.source, actorKey: body.issuerActorKey,
      organisationId: actorRegistry[body.issuerActorKey].organisationId };
    if (body.source === "Meter") {
      const device = await consortium.deviceOf(sourceId);
      sourceRegistry[body.sourceCode].device = { signer: device.signer, organisationId: device.organisationId,
        calibratedUntil: String(device.calibratedUntil), active: device.active };
    }
  }
  const scopeNames = {};
  for (const orchard of design.orchards) scopeNames[farmScopeId(b32(orchard.id), design.cropYear)] = orchard.id;
  for (const item of [...design.lots, ...design.batches]) scopeNames[b32(item.id)] = item.id;
  const eventIndexes = {};
  async function input(evidenceId, scopeId, overrides = {}) {
    const { entry, body } = evidence(evidenceId);
    const e = eventInput({ activity: body.activity, variable: body.variable, quantity: milli(body.quantity),
      observedAt: (await time.latest()) - 1, source: SourceClass[body.source], uncertaintyPermille: 0,
      sourceId: sourceRegistry[body.sourceCode].sourceId, evidenceHash: entry.sha256,
      methodCode: body.source === "Meter" ? "DEVICE_READING" : body.source === "Invoice" ? "INVOICE" : body.source === "Estimate" ? "SYN_ESTIMATE" : "OPERATOR_LOG",
      ...overrides });
    const sig = body.source === "Meter" ? await signObservation(devices[body.sourceCode], chainId, ledger, scopeId, e) : "0x";
    return { e, sig, body };
  }
  for (const orchard of design.orchards) {
    const oId = b32(orchard.id);
    const oDoc = evidence("orchard-" + orchard.id.split("/").pop());
    await (await ct.connect(actors[orchard.actor]).registerOrchard(oId, oDoc.body.areaM2, oDoc.entry.sha256)).wait();
    for (const spec of orchard.events) {
      const scope = farmScopeId(oId, design.cropYear);
      const { e, sig } = await input(spec.id, scope);
      await (await ct.connect(actors[orchard.actor]).recordFarmEvent(oId, design.cropYear, e, sig)).wait();
      eventIndexes[spec.id] = Number(await ct.eventCount());
    }
  }
  for (const lot of design.lots) {
    const lotId = b32(lot.id);
    const suffix = lot.id.split("/").pop();
    const harvest = evidence("lot-" + suffix);
    const owner = actors[harvest.body.issuerActorKey];
    await (await ct.connect(owner).registerLot(lotId, b32(harvest.body.orchard), design.cropYear, milli(harvest.body.harvestedKg), harvest.entry.sha256)).wait();
    await (await ct.connect(owner).initiateTransfer(lotId, actors.mill.address, actors.transporter.address,
      milli(harvest.body.harvestedKg), 10000, id("SYN-VEHICLE"), harvest.entry.sha256)).wait();
    const { e, sig } = await input("transport-" + suffix, lotId);
    await (await ct.connect(actors.transporter).recordTransportEvent(lotId, e, sig)).wait();
    const weighedAt = (await time.latest()) - 1;
    const wb = deviceId("WEIGHBRIDGE-01");
    const signature = await signReceipt(devices["WEIGHBRIDGE-01"], chainId, ledger, lotId, milli(harvest.body.receivedKg), weighedAt, wb);
    await (await ct.connect(actors.mill).confirmReceipt(lotId, milli(harvest.body.receivedKg), wb, weighedAt, signature)).wait();
  }
  for (const batch of design.batches) {
    const batchId = b32(batch.id);
    await (await ct.connect(actors.mill).createBatch(batchId, batch.lots.map(b32), batch.sharesPermille, b32("MASS_PROPORTIONAL"))).wait();
    for (const label of ["electricity", "oil", "pomace", "diesel"]) {
      const { e, sig } = await input("mill-" + batch.id.split("/").pop() + "-" + label, batchId);
      await (await ct.connect(actors.mill).recordMillEvent(batchId, e, sig)).wait();
    }
    await (await ct.connect(actors.mill).closeBatch(batchId, milli(batch.receivedKg))).wait();
  }
  for (const orchard of design.orchards) {
    await (await ct.connect(actors[orchard.actor]).closeFarmPhase(b32(orchard.id), design.cropYear)).wait();
    await (await ct.connect(actors.certifier).verifyFarmPhase(b32(orchard.id), design.cropYear, id("SYNTHETIC-TEST-VERIFICATION/" + orchard.id))).wait();
  }
  const now = await time.latest();
  await (await fr.connect(actors.methodAuthorityA).propose(b32(factors.id), factors.version,
    factorSetContentHash(factors), b32("SYNTHETIC-GWP100-280"), now - 1, 1924991999,
    ethers.ZeroHash, factors.methodologicalPolicy)).wait();
  await (await fr.connect(actors.methodAuthorityB).approve(b32(factors.id))).wait();

  async function claimsAndCertify(approve) {
    const claims = [];
    for (const batch of design.batches) {
      for (const opts of design.allocationScenarios) {
        const calculated = await computeBatchResult(ct, b32(batch.id), factors, opts);
        claims.push({ batch: batch.id, allocationRule: opts.allocationRule, ...calculated });
        if (approve && opts.allocationRule === "NONE_UNALLOCATED") {
          await (await er.connect(actors.lcaService).register(calculated.manifestHash, id("SYN-LOCAL-MANIFEST/" + calculated.manifestHash), b32("SYN-LOCAL-REPOSITORY"), (await time.latest()) + 10 * 365 * 86400, 2)).wait();
          await (await cc.connect(actors.lcaService).submitResult(b32(batch.id), calculated.resultInput)).wait();
          const version = await cc.resultCount(b32(batch.id));
          await (await cc.connect(actors.certifier).approveResult(b32(batch.id), version)).wait();
        }
      }
    }
    return claims;
  }
  async function certificates() {
    const out = [];
    for (const batch of design.batches) {
      const c = await cc.getCertificate(b32(batch.id));
      out.push({ batch: batch.id, status: CertificateStatusName[Number(c.status)], version: Number(c.version),
        totalMg: String(c.totalMg), methodologicalStatus: Number(c.methodologicalStatus), limitationFlags: Number(c.limitationFlags),
        assessmentHash: c.assessmentHash, methodologicalCommitment: c.methodologicalCommitment });
    }
    return out;
  }
  async function snapshot(label, claims) {
    const block = await ethers.provider.getBlock("latest");
    const events = [];
    for (const log of await ct.queryFilter(ct.filters.ActivityRecorded())) {
      const s = await ct.getActivityEvent(log.args.index);
      const e = log.args.input;
      const entry = byHash.get(e.evidenceHash.toLowerCase());
      events.push({ index: Number(log.args.index), status: Number(s.status), replaces: Number(s.replaces),
        replacedBy: Number(s.replacedBy), scopeId: log.args.scopeId, scope: scopeNames[log.args.scopeId],
        phase: Number(log.args.phase), activity: str32(e.activity), variable: str32(e.variable), quantityMilli: String(e.quantity),
        source: SourceClassName[Number(e.source)], sourceId: e.sourceId, uncertaintyPermille: Number(e.uncertaintyPermille),
        evidenceHash: e.evidenceHash, evidenceId: entry?.evidenceId, actor: log.args.actor,
        observedAt: String(e.observedAt), blockNumber: log.blockNumber, transactionHash: log.transactionHash });
    }
    const orchards = [];
    for (const spec of design.orchards) {
      const o = await ct.getOrchard(b32(spec.id));
      const s = await ct.getFarmScope(b32(spec.id), design.cropYear);
      orchards.push({ id: spec.id, scopeId: farmScopeId(b32(spec.id), design.cropYear), cropYear: design.cropYear,
        areaM2: String(o.areaM2), grower: o.grower, organisationId: o.organisationId, locationHash: o.locationHash,
        harvestedMassG: String(s.harvestedMassG), revision: Number(s.revision), closed: s.closed, verified: s.verified,
        evidenceId: "orchard-" + spec.id.split("/").pop() });
    }
    const lots = [];
    for (const spec of design.lots) {
      const l = await ct.getLot(b32(spec.id));
      const transfer = await ct.getTransfer(b32(spec.id));
      const registrationLogs = await ct.queryFilter(ct.filters.LotRegistered(b32(spec.id)));
      lots.push({ id: spec.id, orchard: str32(l.orchardId), cropYear: Number(l.cropYear),
        harvestedMassG: String(l.harvestedMassG), receivedMassG: String(l.receivedMassG), batch: str32(l.batchId),
        evidenceHash: registrationLogs[0].args.evidenceHash, evidenceId: "lot-" + spec.id.split("/").pop(),
        transfer: { from: transfer.from, to: transfer.to, transporter: transfer.transporter,
          declaredMassG: String(transfer.declaredMassG), receivedMassG: String(transfer.receivedMassG),
          evidenceHash: transfer.evidenceHash, weighbridgeId: transfer.weighbridgeId, confirmedAt: String(transfer.confirmedAt) } });
    }
    const batches = [];
    for (const spec of design.batches) {
      const [b, lotIds, shares] = await ct.getBatch(b32(spec.id));
      const [,,, revisionDigest] = await ct.certificationStatus(b32(spec.id));
      batches.push({ id: spec.id, lotIds: lotIds.map(str32), sharesPermille: shares.map(Number),
        receivedMassG: String(b.receivedMassG), receptionMassG: String(b.receptionMassG), oilOutputMilli: String(b.oilOutputMilli),
        revisionDigest, closed: b.closed, mixingRule: str32(b.mixingRule), mill: b.mill });
    }
    const data = { label, snapshot: { blockNumber: block.number, blockHash: block.hash },
      chainId: String(chainId), ledger, actorRegistry, sourceRegistry, orchards, lots, batches, events, claims,
      certificates: await certificates() };
    save("snapshot-" + label + ".json", data);
    return data;
  }
  const baseline = await snapshot("baseline", await claimsAndCertify(true));
  const oldIndex = eventIndexes[design.correction.originalEvidenceId];
  const aScope = farmScopeId(b32(design.orchards[0].id), design.cropYear);
  const replacement = await input(design.correction.replacementEvidenceId, aScope);
  await (await ct.connect(actors.grower).proposeCorrection(oldIndex, replacement.e, replacement.sig, id(design.correction.reason))).wait();
  await (await ct.connect(actors.auditor).authorizeCorrection(await ct.correctionCount())).wait();
  const afterCorrectionCertificates = await certificates();
  await (await ct.connect(actors.certifier).verifyFarmPhase(b32(design.orchards[0].id), design.cropYear, id("SYNTHETIC-REVERIFICATION-A"))).wait();
  const corrected = await snapshot("corrected", await claimsAndCertify(true));

  // Valid bytes + unchanged quantity, but the declared invoice identifier is wrong.
  // This is an authorized append-only correction in the synthetic ledger, not a forged JSON export.
  const wrong = await input("A-foliar", aScope, { sourceId: sourceRegistry["SYN-DOC-B-FOLIAR"].sourceId });
  await (await ct.connect(actors.grower).proposeCorrection(eventIndexes["A-foliar"], wrong.e, wrong.sig, id("SYNTHETIC-WRONG-SOURCE-CASE"))).wait();
  await (await ct.connect(actors.auditor).authorizeCorrection(await ct.correctionCount())).wait();
  await (await ct.connect(actors.certifier).verifyFarmPhase(b32(design.orchards[0].id), design.cropYear, id("SYNTHETIC-WRONG-SOURCE-REVERIFICATION"))).wait();
  await snapshot("wrongSource", await claimsAndCertify(false));

  // Materialize actual retrieval directories; failure cases alter repository bytes/availability.
  for (const testCase of expectations.cases) {
    const directory = path.join(OUT, "case-evidence", testCase.id);
    fs.mkdirSync(directory, { recursive: true });
    for (const entry of index.entries) fs.copyFileSync(path.join(ROOT, entry.path), path.join(directory, path.basename(entry.path)));
    if (testCase.mutation) {
      const target = path.join(directory, path.basename(byEvidenceId.get(testCase.mutation.evidenceId).path));
      if (testCase.mutation.type === "missing") fs.unlinkSync(target);
      else if (testCase.mutation.type === "corrupt") fs.appendFileSync(target, "\nSYNTHETIC CORRUPTION\n");
      else throw new Error("Unknown predefined mutation");
    }
  }
  const run = { experiment: design.id, synthetic: true, completedAt: new Date().toISOString(),
    runtime: { node: process.version, hardhat: require("hardhat/package.json").version, network: "Hardhat in-process EVM; not Besu multi-node or a field deployment" },
    predeclaredCommitments: index.fixtureCommitments, factorSetContentHash: factorSetContentHash(factors),
    baselineEvents: baseline.events.length, finalEvents: Number(await ct.eventCount()),
    certificateTimeline: { baseline: baseline.certificates, afterCorrection: afterCorrectionCertificates, recomputed: corrected.certificates },
    machineWallSeconds: Number(process.hrtime.bigint() - started) / 1e9,
    timingScope: "Actual local machine elapsed producer execution, including deployment/configuration/transactions; not human audit time or network latency.",
    limitations: ["All evidence and factors are invented test fixtures", "Same-team separately implemented arithmetic verifier, not an external human audit", "Local retrieval only; no repository uptime or replication test", "No physical observation validation", "No complete environmental footprint or uncertainty quantification"] };
  save("ledger-run.json", run);
  console.log(JSON.stringify({ experiment: design.id, baselineEvents: run.baselineEvents, finalEvents: run.finalEvents,
    cases: expectations.cases.length, certificateStatuses: Object.fromEntries(Object.entries(run.certificateTimeline).map(([key, values]) => [key, values.map((v) => v.status)])) }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
