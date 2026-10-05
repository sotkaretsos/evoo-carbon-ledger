// Browser version of lib/replay.js: the Western Achaia case study replayed through the compiled
// contracts on the in-browser chain, act by act, plus a set of rule-breaking attempts that are
// executed on a snapshot and rolled back. The replay logic, catalogue, encodings and the off-chain
// LCA engine are the same modules as in the repository's tests.

import { ethers } from "ethers";
import encoding from "../../lib/encoding.js";
import catalogue from "../../lib/catalogue.js";
import deployLib from "../../lib/deploy.js";
import recorderLib from "../../lib/recorder.js";
import lcaEngine from "../../offchain/lca-engine.js";
import plan from "../../offchain/case-study/western-achaia.json";
import FS25 from "../../offchain/factor-sets/FS-2025-CONF.json";
import FS26 from "../../offchain/factor-sets/FS-2026-01.json";
import ARTIFACTS from "../build/contracts.json";
import { LocalChain } from "./local-chain.js";

const { b32, id, ts, eventInput, SourceClass, signObservation, signReceipt, farmScopeId, CertificateStatusName, str32, unitStr, deviceWallet } = encoding;
const { deviceId } = catalogue;
const { configureConsortium } = deployLib;
const { Recorder } = recorderLib;
const { computeBatchResult, factorSetContentHash } = lcaEngine;

export const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";
export const GENESIS = "2024-01-01T00:00:00Z";
const milli = (x) => BigInt(Math.round(x * 1000));
const METHOD = { Invoice: "INVOICE", OperatorEntry: "OPERATOR_LOG", Meter: "DEVICE_READING", Estimate: "MILL_ESTIMATE" };
const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

export const ACTOR_LABELS = {
  governor: "Consortium governor",
  methodAuthorityA: "Methodological authority A",
  methodAuthorityB: "Methodological authority B",
  grower: "Grower",
  transporter: "Transporter",
  mill: "Olive mill",
  lcaService: "LCA service",
  certifier: "Certifier",
  auditor: "Auditor",
  growerB: "Grower (other holding)",
  millB: "Mill (other)",
  growerColleague: "Grower (colleague)",
  outsider: "Outsider (not a member)",
};

/** Linking of the EnvelopeValidation library into the traceability bytecode. */
function link(bytecode, linkReferences, libraries) {
  let code = bytecode;
  for (const file of Object.values(linkReferences ?? {})) {
    for (const [name, refs] of Object.entries(file)) {
      const a = libraries[name].toLowerCase().replace(/^0x/, "");
      for (const { start, length } of refs) {
        const at = 2 + start * 2;
        code = code.slice(0, at) + a + code.slice(at + length * 2);
      }
    }
  }
  return code;
}

export class CaseStudyDemo {
  /**
   * @param {object} hooks  UI callbacks: onTx(entry), onReject(entry), onCertificate(entry),
   *                        onNote(text), onPhase(name)
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.state = { act: 0 };
  }

  emit(name, payload) {
    return this.hooks[name] ? this.hooks[name](payload) : undefined;
  }

  async init() {
    const root = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, "", "m/44'/60'/0'/0");
    const keys = Array.from({ length: 20 }, (_, i) => ethers.getBytes(root.deriveChild(i).privateKey));
    this.chain = await new LocalChain({ privateKeys: keys, chainId: 31337, genesisTime: ts(GENESIS) }).init();
    this.provider = new ethers.BrowserProvider(this.chain, { chainId: 31337, name: "evoo-demo" }, { staticNetwork: true, cacheTimeout: -1 });
    this.signers = [];
    for (const a of this.chain.accounts) this.signers.push(await this.provider.getSigner(a));
    this.rec = new Recorder(this.provider, { traceStorage: false });
    this.actorByAddress = new Map();
    const send = this.rec.send.bind(this.rec);
    this.rec.send = async (label, act, txPromise, meta = {}) => {
      const receipt = await send(label, act, txPromise, meta);
      const entry = this.rec.entries[this.rec.entries.length - 1];
      await this.emit("onTx", { ...entry, actor: this.actorByAddress.get(receipt.from.toLowerCase()) ?? "governor" });
      await yieldToUi();
      return receipt;
    };
    return this;
  }

  latest() {
    return this.chain.latestTimestamp();
  }

  async at(iso) {
    const t = ts(iso);
    if (t > this.latest()) this.chain.increaseTo(t);
  }

  // ------------------------------------------------------------------ deployment and consortium

  async setup() {
    const governor = this.signers[0];
    const deploy = async (name, args = [], libraries) => {
      const art = ARTIFACTS[name];
      const bytecode = libraries ? link(art.bytecode, art.linkReferences, libraries) : art.bytecode;
      const factory = new ethers.ContractFactory(name === "EnvelopeValidation" ? [] : art.abi, bytecode, governor);
      const contract = await factory.deploy(...args);
      await contract.waitForDeployment();
      await this.rec.deployment(name, contract);
      const d = this.rec.deployments[this.rec.deployments.length - 1];
      await this.emit("onTx", { label: `deploy ${name}`, act: "deploy", gasUsed: d.gasUsed, detail: `${d.runtimeBytes.toLocaleString("en-US")} bytes`, timestamp: this.latest(), actor: "governor" });
      await yieldToUi();
      return contract;
    };
    const envelopeLib = await deploy("EnvelopeValidation");
    const consortium = await deploy("Consortium", [governor.address]);
    const factorRegistry = await deploy("FactorRegistry", [await consortium.getAddress()]);
    const evidenceRegistry = await deploy("EvidenceRegistry", [await consortium.getAddress()]);
    const traceability = await deploy("CarbonTraceability", [await consortium.getAddress()], { EnvelopeValidation: await envelopeLib.getAddress() });
    const certification = await deploy("CarbonCertification", [
      await consortium.getAddress(),
      await factorRegistry.getAddress(),
      await evidenceRegistry.getAddress(),
      await traceability.getAddress(),
    ]);
    this.contracts = { envelopeLib, consortium, factorRegistry, evidenceRegistry, traceability, certification };
    for (const a of catalogue.ACTORS) this.actorByAddress.set(this.signers[a.index].address.toLowerCase(), a.key);
    this.actorByAddress.set(this.signers[0].address.toLowerCase(), "governor");
    const { actors, devices } = await configureConsortium(this.contracts, this.signers, this.rec);
    this.actors = actors;
    this.devices = devices;
    this.chainId = (await this.provider.getNetwork()).chainId;
    this.ledger = await traceability.getAddress();
    this.ids = {
      orchardId: b32("ORCHARD/WESTERN-ACHAIA-01"),
      cropYear: plan.orchard.cropYear,
      batchId: b32("BATCH/WA-01/2024"),
      fsId25: b32(FS25.id),
      fsId26: b32(FS26.id),
      lotIds: [],
    };
    this.ids.scopeId = farmScopeId(this.ids.orchardId, this.ids.cropYear);
    this.farmLocation = id("GEO/" + plan.orchard.id);
    this.millLocation = id("GEO/MILL/WESTERN-ACHAIA-01");
    this.certificateTimeline = [];
    this.results = {};
    this.state.act = 0;
  }

  async snapshotCertificate(label) {
    const c = await this.contracts.certification.getCertificate(this.ids.batchId);
    const entry = {
      label,
      timestamp: this.latest(),
      status: CertificateStatusName[Number(c.status)],
      version: Number(c.version),
      kgCO2eqPerFU: Number(c.totalMg) / 1e6,
      phaseSharePermille: [...c.phaseSharePermille].map(Number),
      factorSet: c.factorSetId === ethers.ZeroHash ? null : str32(c.factorSetId),
      functionalUnit: c.functionalUnit === ethers.ZeroHash ? null : str32(c.functionalUnit),
      approvedAt: Number(c.approvedAt),
      approver: c.approver,
      evidenceCheckFailed: c.evidenceCheckFailed,
    };
    this.certificateTimeline.push(entry);
    this.emit("onCertificate", entry);
    return entry;
  }

  // ------------------------------------------------------------------ Act 1: the 2024 season

  async act1() {
    const { traceability: ct } = this.contracts;
    const { actors, devices } = this;
    const { orchardId, cropYear, batchId, lotIds } = this.ids;
    const rec = this.rec;
    await this.at("2024-01-02T09:00:00Z");
    await rec.send("CarbonTraceability.registerOrchard", "act1", ct.connect(actors.grower).registerOrchard(orchardId, plan.orchard.areaM2, this.farmLocation), { detail: `${plan.orchard.areaM2 / 10000} ha` });

    this.farmEvents = plan.farmEvents.map((fe) => ({ ...fe }));
    const timeline = [];
    for (const fe of this.farmEvents) timeline.push({ date: fe.date, kind: "farm", fe });
    plan.harvest.days.forEach((day, i) => timeline.push({ date: `${day}T16:00:00Z`, kind: "harvest", day, i }));
    timeline.push({ date: plan.mill.createdAt, kind: "batch" });
    for (const me of plan.mill.events) timeline.push({ date: me.date, kind: "mill", me });
    timeline.push({ date: plan.mill.closedAt, kind: "closeBatch" });
    timeline.sort((a, b) => ts(a.date) - ts(b.date));

    for (const item of timeline) {
      if (item.kind === "farm") {
        const fe = item.fe;
        await this.at(fe.date);
        const e = eventInput({
          activity: fe.activity,
          variable: fe.variable,
          quantity: milli(fe.quantity),
          observedAt: ts(fe.date) - 3600,
          source: SourceClass[fe.source],
          sourceId: fe.documentId ? id("DOCUMENT/" + fe.documentId) : undefined,
          evidenceHash: id(`EVIDENCE/${fe.doc}/${fe.date}/${fe.variable}`),
          locationHash: this.farmLocation,
          methodCode: METHOD[fe.source],
        });
        const receipt = await rec.send("CarbonTraceability.recordFarmEvent", "act1", ct.connect(actors.grower).recordFarmEvent(orchardId, cropYear, e, "0x"), {
          detail: `${fe.activity} · ${fe.variable} ${fe.quantity}`,
        });
        const parsed = receipt.logs.map((l) => ct.interface.parseLog(l)).find((l) => l && l.name === "ActivityRecorded");
        fe._index = Number(parsed.args.index);
        fe._input = e;
      } else if (item.kind === "harvest") {
        const lotId = b32(`LOT/WA-01/2024/${String(item.i + 1).padStart(2, "0")}`);
        lotIds.push(lotId);
        const massG = milli(plan.harvest.lotMassKg);
        await this.at(`${item.day}T16:00:00Z`);
        await rec.send("CarbonTraceability.registerLot", "act1", ct.connect(actors.grower).registerLot(lotId, orchardId, cropYear, massG, id(`EVIDENCE/harvest-note/${item.day}`)), {
          detail: `lot ${item.i + 1} · ${plan.harvest.lotMassKg} kg`,
        });
        await this.at(`${item.day}T16:10:00Z`);
        await rec.send(
          "CarbonTraceability.initiateTransfer",
          "act1",
          ct
            .connect(actors.grower)
            .initiateTransfer(lotId, actors.mill.address, actors.transporter.address, massG, Math.round(plan.harvest.transport.distanceKm * 1000), id("VEHICLE/MILL-TRUCK-01"), id(`EVIDENCE/delivery-note/${item.day}`)),
          { detail: `lot ${item.i + 1} → mill · ${plan.harvest.lotMassKg} kg declared` }
        );
        await this.at(`${item.day}T17:30:00Z`);
        const te = eventInput({
          activity: "TRANSPORT",
          variable: "TRANSPORT_DIESEL_L",
          quantity: milli(plan.harvest.transport.dieselLPerDelivery),
          observedAt: ts(`${item.day}T17:20:00Z`),
          source: SourceClass.OperatorEntry,
          evidenceHash: id(`EVIDENCE/vehicle-fuel-log/${item.day}`),
          locationHash: this.millLocation,
          methodCode: "OPERATOR_LOG",
        });
        await rec.send("CarbonTraceability.recordTransportEvent", "act1", ct.connect(actors.transporter).recordTransportEvent(lotId, te, "0x"), {
          detail: `lot ${item.i + 1} · ${plan.harvest.transport.distanceKm} km · ${plan.harvest.transport.dieselLPerDelivery} L diesel`,
        });
        await this.at(`${item.day}T17:45:00Z`);
        const weighedAt = ts(`${item.day}T17:40:00Z`);
        const wb = deviceId("WEIGHBRIDGE-01");
        const sig = await signReceipt(devices["WEIGHBRIDGE-01"], this.chainId, this.ledger, lotId, massG, weighedAt, wb);
        await rec.send("CarbonTraceability.confirmReceipt", "act1", ct.connect(actors.mill).confirmReceipt(lotId, massG, wb, weighedAt, sig), {
          detail: `lot ${item.i + 1} · signed weighbridge reading`,
        });
      } else if (item.kind === "batch") {
        await this.at(item.date);
        const shares = lotIds.map(() => 1000 / lotIds.length);
        await rec.send("CarbonTraceability.createBatch", "act1", ct.connect(actors.mill).createBatch(batchId, lotIds, shares, b32("MASS_PROPORTIONAL")), {
          detail: `${lotIds.length} lots · mass-proportional mixing`,
        });
      } else if (item.kind === "mill") {
        const me = item.me;
        await this.at(me.date);
        const e = eventInput({
          activity: me.activity,
          variable: me.variable,
          quantity: milli(me.quantity),
          observedAt: ts(me.date) - 600,
          source: SourceClass[me.source],
          sourceId: me.device ? deviceId(me.device) : undefined,
          evidenceHash: id(`EVIDENCE/${me.doc}/${me.date}/${me.variable}`),
          locationHash: this.millLocation,
          methodCode: METHOD[me.source],
        });
        const sig = me.device ? await signObservation(devices[me.device], this.chainId, this.ledger, batchId, e) : "0x";
        await rec.send("CarbonTraceability.recordMillEvent", "act1", ct.connect(actors.mill).recordMillEvent(batchId, e, sig), {
          detail: `${me.variable} ${me.quantity}${me.device ? " · signed by " + me.device : " · mill estimate"}`,
        });
      } else if (item.kind === "closeBatch") {
        await this.at(item.date);
        await rec.send("CarbonTraceability.closeBatch", "act1", ct.connect(actors.mill).closeBatch(batchId, milli(plan.mill.receptionMassKg)), {
          detail: `${plan.mill.receptionMassKg.toLocaleString("en-US")} kg received · mass balance and yield checked`,
        });
      }
    }
    await this.at(plan.farmClosure);
    await rec.send("CarbonTraceability.closeFarmPhase", "act1", ct.connect(actors.grower).closeFarmPhase(orchardId, cropYear), { detail: "crop year 2024" });
    await this.at(plan.farmVerification);
    await rec.send("CarbonTraceability.verifyFarmPhase", "act1", ct.connect(actors.certifier).verifyFarmPhase(orchardId, cropYear, id("VERIFICATION-REPORT/2025-02")), {
      detail: "farm records verified",
    });
    this.state.act = 1;
  }

  // ------------------------------------------------------------------ Act 2: conference version

  async act2() {
    const { traceability: ct, certification: cc, factorRegistry: fr, evidenceRegistry: er } = this.contracts;
    const { actors, rec } = this;
    const { batchId, fsId25 } = this.ids;
    await this.at("2025-03-01T09:00:00Z");
    await rec.send(
      "FactorRegistry.propose",
      "act2",
      fr.connect(actors.methodAuthorityA).propose(fsId25, FS25.version, factorSetContentHash(FS25), b32("GWP100-PRESUMED"), ts(FS25.validFrom), ts(FS25.validTo), ethers.ZeroHash),
      { detail: "FS-2025-CONF proposed" }
    );
    await this.at("2025-03-02T09:00:00Z");
    await rec.send("FactorRegistry.approve", "act2", fr.connect(actors.methodAuthorityB).approve(fsId25), { detail: "FS-2025-CONF approved by a second authority" });

    await this.at(plan.act2.date);
    const v1 = await computeBatchResult(ct, batchId, FS25, { functionalUnit: "EVOO_1KG_MILL_GATE" });
    const v1Litre = await computeBatchResult(ct, batchId, FS25, { functionalUnit: "EVOO_1L_MILL_GATE" });
    const retention = this.latest() + 10 * 365 * 86400;
    await rec.send("EvidenceRegistry.register", "act2", er.connect(actors.lcaService).register(v1.manifestHash, id("hdl:21.T11148/evoo-wa01-2024-v1"), b32("REPO/CONSORTIUM-ARCHIVE"), retention, 3), {
      detail: "evidence manifest v1 · 3 replicas",
    });
    await rec.send("EvidenceRegistry.register", "act2", er.connect(actors.lcaService).register(v1Litre.manifestHash, id("hdl:21.T11148/evoo-wa01-2024-v1L"), b32("REPO/CONSORTIUM-ARCHIVE"), retention, 3), {
      detail: "evidence manifest v1 (per liter) · 3 replicas",
    });
    const rejection = await this.attempt(() => cc.connect(actors.lcaService).submitResult.staticCall(batchId, v1Litre.resultInput));
    this.emit("onReject", {
      label: "CarbonCertification.submitResult",
      act: "act2",
      actor: "lcaService",
      timestamp: this.latest(),
      detail: "result package declaring 1 L EVOO as functional unit",
      ...rejection,
    });
    await rec.send("CarbonCertification.submitResult", "act2", cc.connect(actors.lcaService).submitResult(batchId, v1.resultInput), {
      detail: `v1 · ${v1.report.total.perKgOil.toFixed(3)} kg CO2eq per kg EVOO`,
    });
    await this.snapshotCertificate("v1 submitted, awaiting approval");
    await this.at(plan.act2.approval);
    await rec.send("CarbonCertification.approveResult", "act2", cc.connect(actors.certifier).approveResult(batchId, 1), { detail: "v1 approved" });
    await this.snapshotCertificate("v1 approved");
    this.results.v1 = v1;
    this.results.v1Litre = v1Litre;
    this.results.literRejection = rejection;
    this.state.act = 2;
  }

  // ------------------------------------------------------------------ Act 3: journal version

  async act3() {
    const { traceability: ct, certification: cc, factorRegistry: fr, evidenceRegistry: er } = this.contracts;
    const { actors, rec } = this;
    const { orchardId, cropYear, batchId, fsId25, fsId26 } = this.ids;
    await this.at(plan.act3.factorSetProposed);
    await rec.send(
      "FactorRegistry.propose",
      "act3",
      fr.connect(actors.methodAuthorityA).propose(fsId26, FS26.version, factorSetContentHash(FS26), b32("GWP100-PRESUMED"), ts(FS26.validFrom), ts(FS26.validTo), fsId25),
      { detail: "FS-2026-01 proposed (supersedes FS-2025-CONF)" }
    );
    await this.at(plan.act3.factorSetApproved);
    await rec.send("FactorRegistry.approve", "act3", fr.connect(actors.methodAuthorityB).approve(fsId26), { detail: "FS-2026-01 approved by a second authority" });

    await this.at(plan.act3.correctionsProposed);
    const correctionIds = [];
    for (const fe of this.farmEvents.filter((x) => x.correction)) {
      const replacement = { ...fe._input, variable: b32(fe.correction.variable), evidenceHash: id(`EVIDENCE/${fe.correction.doc}/${fe.activity}`) };
      const receipt = await rec.send("CarbonTraceability.proposeCorrection", "act3", ct.connect(actors.grower).proposeCorrection(fe._index, replacement, "0x", id(fe.correction.reason)), {
        detail: `event #${fe._index} ${fe.activity}: ${fe.variable} → ${fe.correction.variable}`,
      });
      const parsed = receipt.logs.map((l) => ct.interface.parseLog(l)).find((l) => l && l.name === "CorrectionProposed");
      correctionIds.push(Number(parsed.args.correctionId));
    }
    await this.snapshotCertificate("corrections proposed, pending authorization");
    await this.at(plan.act3.correctionsAuthorized);
    for (const cid of correctionIds) {
      await rec.send("CarbonTraceability.authorizeCorrection", "act3", ct.connect(actors.auditor).authorizeCorrection(cid), { detail: `correction ${cid} authorized` });
    }
    await this.snapshotCertificate("corrections authorized");
    try {
      await computeBatchResult(ct, batchId, FS25);
      this.results.fs25OnCorrectedChain = null;
    } catch (err) {
      this.results.fs25OnCorrectedChain = err.message;
      this.emit("onNote", { act: "act3", timestamp: this.latest(), text: `Off-chain LCA service: FS-2025-CONF cannot evaluate the corrected chain (${err.message}).` });
    }
    await this.at(plan.act3.oldFactorSetRetired);
    await rec.send("FactorRegistry.retire", "act3", fr.connect(actors.methodAuthorityA).retire(fsId25, id("Undocumented grid factor; petrol equipment classified as diesel")), {
      detail: "FS-2025-CONF retired",
    });
    await this.snapshotCertificate("FS-2025-CONF retired");
    await this.at(plan.act3.reverification);
    await rec.send("CarbonTraceability.verifyFarmPhase", "act3", ct.connect(actors.certifier).verifyFarmPhase(orchardId, cropYear, id("VERIFICATION-REPORT/2026-06")), {
      detail: "corrected farm records re-verified",
    });
    await this.at(plan.act3.resultSubmitted);
    const v2 = await computeBatchResult(ct, batchId, FS26, { functionalUnit: "EVOO_1KG_MILL_GATE" });
    const retention2 = this.latest() + 10 * 365 * 86400;
    await rec.send("EvidenceRegistry.register", "act3", er.connect(actors.lcaService).register(v2.manifestHash, id("hdl:21.T11148/evoo-wa01-2024-v2"), b32("REPO/CONSORTIUM-ARCHIVE"), retention2, 3), {
      detail: "evidence manifest v2 · 3 replicas",
    });
    await rec.send("CarbonCertification.submitResult", "act3", cc.connect(actors.lcaService).submitResult(batchId, v2.resultInput), {
      detail: `v2 · ${v2.report.total.perKgOil.toFixed(3)} kg CO2eq per kg EVOO`,
    });
    await this.at(plan.act3.approval);
    await rec.send("CarbonCertification.approveResult", "act3", cc.connect(actors.certifier).approveResult(batchId, 2), { detail: "v2 approved" });
    await this.snapshotCertificate("v2 approved");
    this.results.v2 = v2;
    this.results.economic = await computeBatchResult(ct, batchId, FS26, { allocationRule: "ECONOMIC", prices: { oil: 4.0, pomace: 0.03 } });
    this.results.wetMass = await computeBatchResult(ct, batchId, FS26, { allocationRule: "WET_MASS" });
    this.results.eventCount = Number(await ct.eventCount());
    this.state.act = 3;
  }

  // ------------------------------------------------------------------ rejected transactions

  decodeError(err) {
    if (err && err.revert && err.revert.name) return { name: err.revert.name, args: [...err.revert.args] };
    const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
      for (const c of Object.values(this.contracts)) {
        if (!c.interface || !c.interface.fragments.length) continue;
        try {
          const parsed = c.interface.parseError(data);
          if (parsed) return { name: parsed.name, args: [...parsed.args] };
        } catch (_) {
          /* try the next interface */
        }
      }
      return { name: "Reverted", args: [data.slice(0, 10)] };
    }
    return { name: "Error", args: [String(err?.shortMessage ?? err?.message ?? err)] };
  }

  /** Runs `fn`; resolves to {accepted:true} or {accepted:false, name, args}. */
  async attempt(fn) {
    try {
      await fn();
      return { accepted: true };
    } catch (err) {
      return { accepted: false, ...this.decodeError(err) };
    }
  }

  /** Runs `fn` on a snapshot of the chain and rolls the chain back afterwards. */
  async sandbox(fn) {
    const snap = await this.provider.send("evm_snapshot", []);
    const silent = this.hooks;
    this.hooks = {};
    try {
      return await fn();
    } finally {
      this.hooks = silent;
      await this.provider.send("evm_revert", [snap]);
    }
  }

  farmEvent2025({ variable, quantity, source, device, activity = "FERTILISATION", evidence = "demo" }) {
    const observedAt = this.latest() - 60;
    return eventInput({
      activity,
      variable,
      quantity: milli(quantity),
      observedAt,
      source: SourceClass[source],
      sourceId: device ? deviceId(device) : source === "Invoice" ? id("DOCUMENT/DEMO-INVOICE") : undefined,
      evidenceHash: id(`EVIDENCE/${evidence}/${observedAt}/${variable}`),
      locationHash: this.farmLocation,
      methodCode: METHOD[source],
    });
  }

  /** Rule-breaking attempts shown in the "Try to break the rules" panel. */
  attacks() {
    const self = this;
    const ct = () => this.contracts.traceability;
    const cc = () => this.contracts.certification;
    const fr = () => this.contracts.factorRegistry;
    const scope2025 = () => [this.ids.orchardId, 2025];
    return [
      {
        key: "outsider",
        requirement: "R1",
        title: "Write to the ledger without membership",
        story: "An account that is not a consortium member records a fertilizer application for the orchard.",
        needs: 1,
        run: () =>
          this.sandbox(() =>
            this.attempt(() => ct().connect(this.actors.outsider).recordFarmEvent.staticCall(...scope2025(), this.farmEvent2025({ variable: "COMPOUND_FERTILISER_KG", quantity: 100, source: "OperatorEntry" }), "0x"))
          ),
      },
      {
        key: "forged",
        requirement: "R2",
        title: "Forge a meter reading",
        story: "The irrigation electricity meter reading is signed with a key that does not belong to the registered device.",
        needs: 1,
        run: () =>
          this.sandbox(async () => {
            const e = this.farmEvent2025({ activity: "IRRIGATION", variable: "IRRIGATION_ELECTRICITY_KWH", quantity: 1800, source: "Meter", device: "IRRIGATION-METER-01" });
            const sig = await signObservation(deviceWallet("SOMEONE-ELSE"), this.chainId, this.ledger, farmScopeId(this.ids.orchardId, 2025), e);
            return this.attempt(() => ct().connect(this.actors.grower).recordFarmEvent.staticCall(...scope2025(), e, sig));
          }),
      },
      {
        key: "duplicate",
        requirement: "R2",
        title: "Send the same reading twice",
        story: "An edge gateway re-sends a buffered fuel record after a connectivity loss. The first copy is recorded; the second is the same envelope.",
        needs: 1,
        run: () =>
          this.sandbox(async () => {
            const e = this.farmEvent2025({ activity: "SOIL_PREPARATION", variable: "FIELD_DIESEL_L", quantity: 25, source: "OperatorEntry" });
            await (await ct().connect(this.actors.grower).recordFarmEvent(...scope2025(), e, "0x")).wait();
            return this.attempt(() => ct().connect(this.actors.grower).recordFarmEvent.staticCall(...scope2025(), e, "0x"));
          }),
      },
      {
        key: "range",
        requirement: "R3",
        title: "Enter an implausible quantity",
        story: "The grower records 50 t of compound fertilizer for the 4.8 ha orchard; the governed range ends at 20 t.",
        needs: 1,
        run: () =>
          this.sandbox(() =>
            this.attempt(() =>
              ct().connect(this.actors.grower).recordFarmEvent.staticCall(...scope2025(), this.farmEvent2025({ variable: "COMPOUND_FERTILISER_KG", quantity: 50000, source: "Invoice" }), "0x")
            )
          ),
      },
      {
        key: "mass",
        requirement: "R4",
        title: "Deliver less than was declared",
        story: "A new 4500 kg lot leaves the farm, but the mill's signed weighbridge reading shows 4400 kg (2.2% less).",
        needs: 1,
        run: () =>
          this.sandbox(async () => {
            const { grower, mill, transporter } = this.actors;
            const lotId = b32("LOT/WA-01/2025/DEMO");
            const declared = milli(4500);
            const received = milli(4400);
            await (await ct().connect(grower).registerLot(lotId, this.ids.orchardId, 2025, declared, id("EVIDENCE/demo-harvest-note"))).wait();
            await (await ct().connect(grower).initiateTransfer(lotId, mill.address, transporter.address, declared, 9500, id("VEHICLE/MILL-TRUCK-01"), id("EVIDENCE/demo-delivery-note"))).wait();
            const weighedAt = this.latest();
            const wb = deviceId("WEIGHBRIDGE-01");
            const sig = await signReceipt(this.devices["WEIGHBRIDGE-01"], this.chainId, this.ledger, lotId, received, weighedAt, wb);
            return this.attempt(() => ct().connect(mill).confirmReceipt.staticCall(lotId, received, wb, weighedAt, sig));
          }),
      },
      {
        key: "selfApproval",
        requirement: "R5",
        title: "Approve your own factor set",
        story: "Methodological authority A proposes a new emission-factor set and then tries to approve it alone.",
        needs: 0,
        run: () =>
          this.sandbox(async () => {
            const fsId = b32("FS-DEMO");
            const a = this.actors.methodAuthorityA;
            const now = this.latest();
            await (await fr().connect(a).propose(fsId, 1, id("FS-DEMO content"), b32("GWP100"), now, now + 365 * 86400, ethers.ZeroHash)).wait();
            return this.attempt(() => fr().connect(a).approve.staticCall(fsId));
          }),
      },
      {
        key: "retired",
        requirement: "R5",
        title: "Re-submit with the retired factor set",
        story: "After FS-2025-CONF was retired, the LCA service re-submits the certified conference-version package.",
        needs: 3,
        run: () => this.sandbox(() => this.attempt(() => cc().connect(this.actors.lcaService).submitResult.staticCall(this.ids.batchId, this.results.v1.resultInput))),
      },
      {
        key: "perLiter",
        requirement: "R6",
        title: "Declare the result per liter",
        story: "The result package states 1 L of EVOO as functional unit, although the mill weighed the oil in kilograms.",
        needs: 1,
        run: () =>
          this.sandbox(async () => {
            const pkg = await computeBatchResult(ct(), this.ids.batchId, FS26, { functionalUnit: "EVOO_1L_MILL_GATE" });
            return this.attempt(() => cc().connect(this.actors.lcaService).submitResult.staticCall(this.ids.batchId, pkg.resultInput));
          }),
      },
      {
        key: "closed",
        requirement: "R7",
        title: "Edit the closed season directly",
        story: "Someone adds a fertilizer record to crop year 2024 after the farm records were closed and verified, instead of proposing a correction.",
        needs: 1,
        run: () =>
          this.sandbox(() =>
            this.attempt(() =>
              ct().connect(this.actors.grower).recordFarmEvent.staticCall(this.ids.orchardId, 2024, this.farmEvent2025({ variable: "COMPOUND_FERTILISER_KG", quantity: 100, source: "Invoice" }), "0x")
            )
          ),
      },
      {
        key: "tampered",
        requirement: "R8",
        title: "Show a tampered invoice to an auditor",
        story: "The fertilizer invoice is compared with the hash on the ledger, once as archived and once with an edited quantity.",
        needs: 1,
        run: () =>
          this.sandbox(async () => {
            const fe = this.farmEvents[0];
            const original = `EVIDENCE/${fe.doc}/${fe.date}/${fe.variable}`;
            const edited = original.replace("fertiliser invoice", "fertiliser invoice (edited: 1900 kg)");
            const okOriginal = await ct().matchesEvidence(fe._index, id(original));
            const okEdited = await ct().matchesEvidence(fe._index, id(edited));
            return { accepted: false, view: true, name: okOriginal && !okEdited ? "HashMismatch" : "Unexpected", args: [okOriginal, okEdited], eventIndex: fe._index };
          }),
      },
      {
        key: "evidence",
        requirement: "R9",
        title: "Certify without archived evidence",
        story: "A result package points to an evidence manifest that was never registered in the evidence registry.",
        needs: 2,
        run: () =>
          this.sandbox(async () => {
            const fs = self.state.act >= 3 ? FS26 : FS25;
            const pkg = await computeBatchResult(ct(), this.ids.batchId, fs, { functionalUnit: "EVOO_1KG_MILL_GATE" });
            const input = { ...pkg.resultInput, evidenceManifest: id("MANIFEST/NOT-ARCHIVED") };
            return this.attempt(() => cc().connect(this.actors.lcaService).submitResult.staticCall(this.ids.batchId, input));
          }),
      },
    ];
  }

  /** Decodes error arguments for display. */
  describeArgs(name, args) {
    const short = (h) => (typeof h === "string" && h.startsWith("0x") && h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h);
    const asText = (h) => {
      try {
        return str32(h);
      } catch (_) {
        return short(h);
      }
    };
    switch (name) {
      case "FunctionalUnitMismatch":
        return [`declared unit: ${unitStr(args[0])}`, `measured output: ${unitStr(args[1])}`];
      case "OutOfRange":
        return [`variable: ${asText(args[0])}`, `quantity: ${(Number(args[1]) / 1000).toLocaleString("en-US")}`];
      case "MassMismatch":
        return [`declared: ${(Number(args[0]) / 1000).toLocaleString("en-US")} kg`, `received: ${(Number(args[1]) / 1000).toLocaleString("en-US")} kg`];
      case "InvalidDeviceSignature":
      case "InvalidDevice":
      case "MeterRequired":
        return [`device or variable: ${asText(args[0])}`];
      case "FactorSetNotUsable":
        return [`factor set: ${asText(args[0])}`];
      case "PhaseClosed":
        return [`scope: ${short(args[0])}`];
      case "DuplicateEvent":
        return [`envelope: ${short(args[0])}`];
      case "EvidenceNotRetained":
        return [`manifest: ${short(args[0])}`];
      case "Unauthorized":
        return [`account: ${short(args[0])}`];
      case "HashMismatch":
        return [`archived invoice: ${args[0] ? "matches" : "does not match"}`, `edited invoice: ${args[1] ? "matches" : "does not match"}`];
      default:
        return (args ?? []).map((a) => String(short(typeof a === "bigint" ? a.toString() : a)));
    }
  }

  totals() {
    const acts = ["setup", "act1", "act2", "act3"];
    const out = Object.fromEntries(acts.map((a) => [a, this.rec.totals((e) => e.act === a)]));
    out.operational = this.rec.totals((e) => e.act !== "setup");
    out.deploymentGas = this.rec.deployments.reduce((s, d) => s + d.gasUsed, 0);
    return out;
  }
}
