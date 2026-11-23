"use strict";
// Randomized fault-injection experiment (extends the controlled audit experiment).
// Each run builds a random supply chain on a fresh Hardhat EVM (3-6 orchards of two grower
// organisations, 2-4 lots per orchard, mixed mill batches of 2-5 lots, corrections and a
// certification), executes every valid operation of that chain, and injects faults of 27 classes
// at random targets at the stage where each fault can occur. A fault is "detected" when the
// transaction reverts with the expected custom error (or, for altered evidence, when the
// integrity check returns false), "prevented" when it reverts with another error, and "missed"
// when it is accepted. Faults are evaluated inside an EVM snapshot that is reverted afterwards,
// so the valid chain is never altered. One residual class (a plausible but false value inside the
// admissible range, with its own evidence) is included to show what contract logic cannot detect.
// Usage: npx hardhat run scripts/fault-injection.js
// Event and correction identifiers start at 1 (eventCount() and correctionCount() return the last identifier).
// Env: FI_RUNS (default 20), FI_ATTEMPTS (attempts per class and run, default 2), FI_SEED (default 20261123)
// Output: reports/fault-injection.json

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { reset, time } = require("@nomicfoundation/hardhat-network-helpers");
const { b32, id, eventInput, SourceClass, signObservation, signReceipt, farmScopeId, deviceWallet, ethers: E } = require("../lib/encoding");
const { deployAll, configureConsortium } = require("../lib/deploy");
const { deviceId } = require("../lib/catalogue");

const RUNS = Number(process.env.FI_RUNS || 20);
const ATTEMPTS = Number(process.env.FI_ATTEMPTS || 2);
const SEED = Number(process.env.FI_SEED || 20261123);
const YEAR = 2024;
const kg = (x) => BigInt(Math.round(x * 1000));

// Seeded PRNG (mulberry32) for reproducible supply chains and fault targets.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLASSES = {
  F01: ["Duplicate submission of a recorded event", ["DuplicateEvent"]],
  F02: ["Signed meter reading replayed into another farm scope", ["InvalidDeviceSignature"]],
  F03: ["Write by an unregistered account", ["Unauthorized"]],
  F04: ["Write to an orchard of another organisation", ["Unauthorized"]],
  F05: ["Quantity outside the admissible range", ["OutOfRange"]],
  F06: ["Manual entry of a variable that requires a meter", ["MeterRequired"]],
  F07: ["Reading with a forged device signature", ["InvalidDeviceSignature"]],
  F08: ["Reading signed by a device of another organisation", ["InvalidDevice"]],
  F09: ["Observation time in the future", ["FutureTimestamp"]],
  F10: ["Invoice without a document identifier", ["DocumentIdRequired"]],
  F11: ["Variable recorded in the wrong phase", ["WrongPhase"]],
  F12: ["Conflicting custody transfer", ["InvalidLotState", "Unauthorized"]],
  F13: ["Received mass outside the transfer tolerance", ["MassMismatch"]],
  F14: ["Receipt with a forged weighbridge signature", ["InvalidDeviceSignature"]],
  F15: ["Same lot twice in a mill batch", ["DuplicateLot"]],
  F16: ["Lot not at the mill or already in a batch", ["InvalidLotState"]],
  F17: ["Mixing shares inconsistent with lot masses", ["SharesMismatch"]],
  F18: ["Batch closed with a reception mass outside tolerance", ["MassMismatch"]],
  F19: ["Batch closed without a mandatory meter reading", ["MissingMandatoryVariable"]],
  F20: ["Batch closed with an implausible oil yield", ["ImplausibleYield"]],
  F21: ["Correction that changes the measured variable", ["CorrectionVariableMismatch"]],
  F22: ["Correction proposed by another organisation", ["Unauthorized"]],
  F23: ["Correction authorized by a non-auditor", ["Unauthorized"]],
  F24: ["Farm record after the farm phase was closed", ["PhaseClosed"]],
  F25: ["Result calculated on a superseded revision", ["RevisionMismatch"]],
  F26: ["Factor set approved by its proposer", ["SeparationOfDuties"]],
  F27: ["Evidence document altered after recording", ["IntegrityCheckFalse"]],
  R01: ["Plausible false value inside the admissible range (residual)", []],
};

async function main() {
  const { ethers, network, artifacts } = hre;
  // Error decoder over all contracts and the validation library.
  const errorFragments = [];
  for (const name of ["CarbonTraceability", "CarbonCertification", "Consortium", "FactorRegistry", "EvidenceRegistry", "EnvelopeValidation"]) {
    for (const f of (await artifacts.readArtifact(name)).abi) if (f.type === "error") errorFragments.push(f);
  }
  const seen = new Set();
  const iface = new E.Interface(errorFragments.filter((f) => { const k = f.name + JSON.stringify(f.inputs.map((i) => i.type)); if (seen.has(k)) return false; seen.add(k); return true; }));
  const revertData = (e) => {
    for (const d of [e && e.data, e && e.error && e.error.data, e && e.info && e.info.error && e.info.error.data]) {
      if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) return d;
      if (d && typeof d.data === "string") return d.data;
    }
    return null;
  };
  const errorName = (e) => {
    const d = revertData(e);
    if (!d) return `UNDECODED:${(e && e.shortMessage) || e}`;
    try { return iface.parseError(d).name; } catch { return `UNKNOWN:${d.slice(0, 10)}`; }
  };

  const records = [];
  const validOps = { executed: 0, rejected: 0, rejections: [] };
  const invariants = { checked: 0, failed: 0, failures: [] };
  const chains = [];
  const rand = prng(SEED);
  const randInt = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  for (let run = 1; run <= RUNS; run++) {
    await reset();
    const signers = await ethers.getSigners();
    const contracts = await deployAll(ethers, signers[0]);
    const { actors, devices } = await configureConsortium(contracts, signers);
    const { traceability: ct, certification: cc, factorRegistry: fr, evidenceRegistry: er } = contracts;
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const ledger = await ct.getAddress();
    const now = async () => Number(await time.latest());
    let evSeq = 0;
    const ev = (label) => id(`FI/${run}/${label}/${++evSeq}`);

    const ok = async (label, fn) => {
      try { const tx = await fn(); const r = await tx.wait(); validOps.executed++; return r; }
      catch (e) { validOps.executed++; validOps.rejected++; validOps.rejections.push({ run, label, error: errorName(e) }); return null; }
    };
    // Evaluates a fault inside a snapshot. `fn` returns a transaction promise, or {view: boolean}.
    const fault = async (cls, target, fn) => {
      const snap = await network.provider.send("evm_snapshot");
      let outcome, error = null;
      try {
        const res = await fn();
        if (res && typeof res === "object" && "view" in res) {
          outcome = res.view ? "missed" : "detected";
          error = res.view ? null : "IntegrityCheckFalse";
        } else {
          await (await res).wait();
          outcome = "missed";
        }
      } catch (e) {
        error = errorName(e);
        outcome = CLASSES[cls][1].includes(error) ? "detected" : "prevented";
      } finally {
        await network.provider.send("evm_revert", [snap]);
      }
      records.push({ run, cls, target, outcome, error });
    };

    // ---------------- supply chain ----------------
    const nOrch = randInt(3, 6);
    const orchards = [];
    for (let i = 0; i < nOrch; i++) {
      const owner = i === 0 ? "grower" : i === 1 ? "growerB" : pick(["grower", "growerB"]);
      const oid = b32(`ORCH/${run}/${i}`);
      await ok("registerOrchard", () => ct.connect(actors[owner]).registerOrchard(oid, randInt(10000, 60000), id(`geo/${run}/${i}`)));
      orchards.push({ id: oid, owner, scope: farmScopeId(oid, YEAR), events: [], lots: [] });
    }
    const manual = () => {
      const t = pick([
        ["SOIL_PREPARATION", "FIELD_DIESEL_L", SourceClass.OperatorEntry, [20, 400]],
        ["PRUNING", "FIELD_PETROL_L", SourceClass.OperatorEntry, [5, 120]],
        ["FERTILISATION", "COMPOUND_FERTILISER_KG", SourceClass.Invoice, [100, 3000]],
        ["FOLIAR_FERTILISATION", "FOLIAR_FERTILISER_KG", SourceClass.Invoice, [1, 50]],
      ]);
      return { activity: t[0], variable: t[1], source: t[2], qty: randInt(t[3][0], t[3][1]) };
    };
    const farmEvent = async (o, spec, overrides = {}) =>
      eventInput({ activity: spec.activity, variable: spec.variable, quantity: kg(spec.qty), observedAt: (await now()) - 60, source: spec.source, sourceId: spec.source === SourceClass.Invoice ? id(`INV/${run}/${evSeq}`) : E.ZeroHash, evidenceHash: ev("doc"), ...overrides });
    const meterReading = async (o, wallet = devices["IRRIGATION-METER-01"], scope = o.scope, overrides = {}) => {
      const e = eventInput({ activity: "IRRIGATION", variable: "IRRIGATION_ELECTRICITY_KWH", quantity: kg(randInt(100, 900)), observedAt: (await now()) - 60, source: SourceClass.Meter, sourceId: deviceId("IRRIGATION-METER-01"), evidenceHash: ev("meter"), ...overrides });
      return { e, sig: await signObservation(wallet, chainId, ledger, scope, e) };
    };
    for (const o of orchards) {
      const k = randInt(2, 4);
      for (let j = 0; j < k; j++) {
        const spec = manual();
        const e = await farmEvent(o, spec);
        const r = await ok("recordFarmEvent", () => ct.connect(actors[o.owner]).recordFarmEvent(o.id, YEAR, e, "0x"));
        if (r) o.events.push({ index: Number(await ct.eventCount()), e, sig: "0x", spec });
      }
      if (o.owner === "grower") {
        const { e, sig } = await meterReading(o);
        const r = await ok("recordFarmEvent(meter)", () => ct.connect(actors.grower).recordFarmEvent(o.id, YEAR, e, sig));
        if (r) o.events.push({ index: Number(await ct.eventCount()), e, sig, meter: true });
      }
    }
    const growerOrchards = orchards.filter((o) => o.owner === "grower");
    const bOrchards = orchards.filter((o) => o.owner === "growerB");

    // ---------------- farm-phase faults ----------------
    for (let a = 0; a < ATTEMPTS; a++) {
      const o = pick(orchards);
      const x = pick(o.events);
      await fault("F01", "recordFarmEvent", () => ct.connect(actors[o.owner]).recordFarmEvent(o.id, YEAR, x.e, x.sig));

      const og = pick(growerOrchards);
      const others = growerOrchards.filter((z) => z !== og);
      const m = og.events.find((z) => z.meter);
      if (!m) { /* no signed reading recorded for this orchard */ }
      else if (others.length) await fault("F02", "recordFarmEvent", () => ct.connect(actors.grower).recordFarmEvent(pick(others).id, YEAR, m.e, m.sig));
      else { // replay into the same orchard's scope of another crop year
        await fault("F02", "recordFarmEvent(other year)", () => ct.connect(actors.grower).recordFarmEvent(og.id, YEAR + 1, m.e, m.sig));
      }

      const oo = pick(orchards);
      const outsiderCall = pick([
        async () => ct.connect(actors.outsider).recordFarmEvent(oo.id, YEAR, await farmEvent(oo, manual()), "0x"),
        async () => ct.connect(actors.outsider).registerLot(b32(`X/${run}/${a}`), oo.id, YEAR, kg(1000), ev("note")),
        async () => ct.connect(actors.outsider).registerOrchard(b32(`XO/${run}/${a}`), 1000, id("geo")),
        async () => cc.connect(actors.outsider).defineFunctionalUnit(b32("X_UNIT"), "0x6b67000000000000"),
      ]);
      await fault("F03", "outsider", outsiderCall);

      const victim = pick(orchards);
      const intruder = victim.owner === "grower" ? "growerB" : "grower";
      await fault("F04", "recordFarmEvent", async () => ct.connect(actors[intruder]).recordFarmEvent(victim.id, YEAR, await farmEvent(victim, manual()), "0x"));

      const o5 = pick(orchards);
      const big = rand() < 0.5;
      await fault("F05", big ? "above max" : "below min", async () => ct.connect(actors[o5.owner]).recordFarmEvent(o5.id, YEAR, await farmEvent(o5, { activity: "SOIL_PREPARATION", variable: "FIELD_DIESEL_L", source: SourceClass.OperatorEntry, qty: big ? randInt(2001, 50000) : 0.05 }), "0x"));

      const o6 = pick(orchards);
      await fault("F06", "IRRIGATION_ELECTRICITY_KWH manual", async () => ct.connect(actors[o6.owner]).recordFarmEvent(o6.id, YEAR, await farmEvent(o6, { activity: "IRRIGATION", variable: "IRRIGATION_ELECTRICITY_KWH", source: SourceClass.OperatorEntry, qty: 300 }), "0x"));

      const o7 = pick(growerOrchards);
      await fault("F07", "random key", async () => { const { e, sig } = await meterReading(o7, E.Wallet.createRandom()); return ct.connect(actors.grower).recordFarmEvent(o7.id, YEAR, e, sig); });

      const o8 = pick(bOrchards);
      await fault("F08", "grower meter on growerB orchard", async () => { const { e, sig } = await meterReading(o8, devices["IRRIGATION-METER-01"], o8.scope); return ct.connect(actors.growerB).recordFarmEvent(o8.id, YEAR, e, sig); });

      const o9 = pick(orchards);
      await fault("F09", "+1 h", async () => ct.connect(actors[o9.owner]).recordFarmEvent(o9.id, YEAR, await farmEvent(o9, manual(), { observedAt: BigInt((await now()) + 3600) }), "0x"));

      const o10 = pick(orchards);
      await fault("F10", "invoice", async () => ct.connect(actors[o10.owner]).recordFarmEvent(o10.id, YEAR, await farmEvent(o10, { activity: "FERTILISATION", variable: "COMPOUND_FERTILISER_KG", source: SourceClass.Invoice, qty: 500 }, { sourceId: E.ZeroHash }), "0x"));

      const o11 = pick(orchards);
      await fault("F11", "mill variable on farm", async () => ct.connect(actors[o11.owner]).recordFarmEvent(o11.id, YEAR, await farmEvent(o11, { activity: "MILL_PROCESSING", variable: "MILL_DIESEL_L", source: SourceClass.OperatorEntry, qty: 10 }), "0x"));

      const oR = pick(orchards);
      const base = pick(oR.events.filter((z) => !z.meter));
      if (base) {
        const s = base.spec;
        await fault("R01", s.variable, async () => ct.connect(actors[oR.owner]).recordFarmEvent(oR.id, YEAR, await farmEvent(oR, { ...s, qty: Math.max(1, Math.round(s.qty * (1 + (rand() < 0.5 ? -0.3 : 0.3)))) }), "0x"));
      }
    }

    // ---------------- lots, custody and receipt ----------------
    const allLots = [];
    for (const o of orchards) {
      const n = randInt(2, 4);
      for (let j = 0; j < n; j++) {
        const lot = { id: b32(`LOT/${run}/${allLots.length}`), mass: randInt(800, 6000), orchard: o };
        await ok("registerLot", () => ct.connect(actors[o.owner]).registerLot(lot.id, o.id, YEAR, kg(lot.mass), ev("harvest")));
        o.lots.push(lot); allLots.push(lot);
      }
    }
    const spare = { id: b32(`LOT/${run}/spare`), mass: 1000, orchard: orchards[0] };
    await ok("registerLot(spare)", () => ct.connect(actors[orchards[0].owner]).registerLot(spare.id, orchards[0].id, YEAR, kg(1000), ev("harvest")));
    const wb = deviceId("WEIGHBRIDGE-01");
    for (const lot of allLots) {
      const owner = actors[lot.orchard.owner];
      if (rand() < 0.15) { // conflicting transfer by a non-custodian before the real one
        await fault("F12", "transfer by non-custodian", () => ct.connect(actors[lot.orchard.owner === "grower" ? "growerB" : "grower"]).initiateTransfer(lot.id, actors.mill.address, actors.transporter.address, kg(lot.mass), 9500, id("veh"), ev("dn")));
      }
      await ok("initiateTransfer", () => ct.connect(owner).initiateTransfer(lot.id, actors.mill.address, actors.transporter.address, kg(lot.mass), randInt(2000, 30000), id("veh"), ev("dn")));
      lot.received = Math.round(lot.mass * (1 + (rand() - 0.5) * 0.01) * 1000) / 1000; // within the 1 % tolerance
      if (rand() < 0.25) {
        const t = (await now()) - 5;
        const bad = Math.round(lot.mass * (rand() < 0.5 ? 1.05 : 0.93) * 1000) / 1000;
        await fault("F13", "received mass", async () => ct.connect(actors.mill).confirmReceipt(lot.id, kg(bad), wb, t, await signReceipt(devices["WEIGHBRIDGE-01"], chainId, ledger, lot.id, kg(bad), t, wb)));
      }
      if (rand() < 0.25) {
        const t = (await now()) - 5;
        await fault("F14", "forged weighbridge", async () => ct.connect(actors.mill).confirmReceipt(lot.id, kg(lot.received), wb, t, await signReceipt(E.Wallet.createRandom(), chainId, ledger, lot.id, kg(lot.received), t, wb)));
      }
      const t = (await now()) - 5;
      const sig = await signReceipt(devices["WEIGHBRIDGE-01"], chainId, ledger, lot.id, kg(lot.received), t, wb);
      await ok("confirmReceipt", () => ct.connect(actors.mill).confirmReceipt(lot.id, kg(lot.received), wb, t, sig));
      if (rand() < 0.15) await fault("F12", "second transfer of a received lot", () => ct.connect(owner).initiateTransfer(lot.id, actors.mill.address, actors.transporter.address, kg(lot.mass), 9500, id("veh"), ev("dn")));
    }
    // top up F12-F14 to ATTEMPTS per run with fresh lots kept in transit
    const topUp = async (cls) => {
      while (records.filter((r) => r.run === run && r.cls === cls).length < ATTEMPTS) {
        const o = pick(orchards);
        const lot = b32(`LOT/${run}/extra/${evSeq}`);
        const snap = await network.provider.send("evm_snapshot");
        await (await ct.connect(actors[o.owner]).registerLot(lot, o.id, YEAR, kg(2000), ev("harvest"))).wait();
        await (await ct.connect(actors[o.owner]).initiateTransfer(lot, actors.mill.address, actors.transporter.address, kg(2000), 9500, id("veh"), ev("dn"))).wait();
        const t = (await now()) - 5;
        if (cls === "F12") await fault("F12", "second transfer of a lot in transit", () => ct.connect(actors[o.owner]).initiateTransfer(lot, actors.mill.address, actors.transporter.address, kg(2000), 9500, id("veh"), ev("dn")));
        if (cls === "F13") await fault("F13", "received mass", async () => ct.connect(actors.mill).confirmReceipt(lot, kg(2100), wb, t, await signReceipt(devices["WEIGHBRIDGE-01"], chainId, ledger, lot, kg(2100), t, wb)));
        if (cls === "F14") await fault("F14", "forged weighbridge", async () => ct.connect(actors.mill).confirmReceipt(lot, kg(2000), wb, t, await signReceipt(E.Wallet.createRandom(), chainId, ledger, lot, kg(2000), t, wb)));
        await network.provider.send("evm_revert", [snap]);
      }
    };
    for (const c of ["F12", "F13", "F14"]) await topUp(c);

    // ---------------- mill batches ----------------
    const shares = (lots) => {
      const total = lots.reduce((a, l) => a + BigInt(kg(l.received)), 0n);
      const exp = lots.map((l) => Number((BigInt(kg(l.received)) * 1000n + total / 2n) / total));
      let diff = 1000 - exp.reduce((a, b) => a + b, 0);
      for (let i = 0; diff !== 0; i = (i + 1) % exp.length) { const s = Math.sign(diff); exp[i] += s; diff -= s; }
      return exp;
    };
    const order = shuffle(allLots);
    const batches = [];
    while (order.length) {
      let n = Math.min(order.length, randInt(2, 5));
      if (order.length - n === 1) n = order.length; // no single-lot remainder
      batches.push({ id: b32(`BATCH/${run}/${batches.length}`), lots: order.splice(0, n) });
    }
    const MP = b32("MASS_PROPORTIONAL");
    let batchFaults = 0;
    for (const b of batches) {
      const ids = b.lots.map((l) => l.id);
      const sh = shares(b.lots);
      const doFaults = batchFaults < ATTEMPTS;
      if (doFaults) {
        const i = randInt(0, ids.length - 1);
        await fault("F15", "duplicate lot id", () => ct.connect(actors.mill).createBatch(b.id, [...ids, ids[i]], [...sh, 0], MP));
        const consumed = batches.filter((z) => z.created).flatMap((z) => z.lots);
        const wrongLot = consumed.length && rand() < 0.5 ? pick(consumed).id : spare.id;
        await fault("F16", consumed.length && wrongLot !== spare.id ? "lot already batched" : "lot still at farm", () => ct.connect(actors.mill).createBatch(b.id, [...ids.slice(0, -1), wrongLot], sh, MP));
        const bad = [...sh];
        if (rand() < 0.5) { bad[0] += 5; bad[bad.length - 1] -= 5; } else bad[0] += 2;
        await fault("F17", "shares", () => ct.connect(actors.mill).createBatch(b.id, ids, bad, MP));
      }
      await ok("createBatch", () => ct.connect(actors.mill).createBatch(b.id, ids, sh, MP));
      b.created = true;
      b.receivedKg = b.lots.reduce((a, l) => a + l.received, 0);
      if (doFaults) await fault("F19", "no meter readings", () => ct.connect(actors.mill).closeBatch(b.id, kg(b.receivedKg)));
      const reading = async (variable, device, qty) => {
        const e = eventInput({ activity: "MILL_PROCESSING", variable, quantity: kg(qty), observedAt: (await now()) - 30, source: SourceClass.Meter, sourceId: deviceId(device), evidenceHash: ev(device) });
        return { e, sig: await signObservation(devices[device], chainId, ledger, b.id, e) };
      };
      const elec = await reading("MILL_ELECTRICITY_KWH", "ELEC-SUBMETER-01", Math.round(b.receivedKg * 0.05));
      await ok("recordMillEvent(electricity)", () => ct.connect(actors.mill).recordMillEvent(b.id, elec.e, elec.sig));
      const oilL = Math.round(b.receivedKg * (0.15 + rand() * 0.05) * 10) / 10;
      const oil = await reading("OIL_OUTPUT_L", "OIL-METER-01", oilL);
      await ok("recordMillEvent(oil)", () => ct.connect(actors.mill).recordMillEvent(b.id, oil.e, oil.sig));
      if (doFaults) {
        await fault("F18", "reception mass", () => ct.connect(actors.mill).closeBatch(b.id, kg(b.receivedKg * (rand() < 0.5 ? 1.03 : 0.96))));
        await fault("F20", "oil yield", async () => {
          const extra = await reading("OIL_OUTPUT_L", "OIL-METER-01", Math.round(b.receivedKg * 0.6));
          await (await ct.connect(actors.mill).recordMillEvent(b.id, extra.e, extra.sig)).wait();
          return ct.connect(actors.mill).closeBatch(b.id, kg(b.receivedKg));
        });
        batchFaults++;
      }
      await ok("closeBatch", () => ct.connect(actors.mill).closeBatch(b.id, kg(b.receivedKg)));
    }

    // ---------------- farm phase closure and verification ----------------
    for (const o of orchards) {
      await ok("closeFarmPhase", () => ct.connect(actors[o.owner]).closeFarmPhase(o.id, YEAR));
      await ok("verifyFarmPhase", () => ct.connect(actors.certifier).verifyFarmPhase(o.id, YEAR, ev("verification")));
    }
    for (let a = 0; a < ATTEMPTS; a++) {
      const o = pick(orchards);
      await fault("F24", "recordFarmEvent after closure", async () => ct.connect(actors[o.owner]).recordFarmEvent(o.id, YEAR, await farmEvent(o, manual()), "0x"));
    }

    // ---------------- factor set, evidence manifest ----------------
    const t0 = await now();
    const fsId = b32(`FS/${run}`);
    await ok("FactorRegistry.propose", () => fr.connect(actors.methodAuthorityA).propose(fsId, 1, id(`fs-content/${run}`), b32("GWP100-AR5"), t0 - 86400, t0 + 3 * 365 * 86400, E.ZeroHash, [0, 0]));
    for (let a = 0; a < ATTEMPTS; a++) await fault("F26", "self-approval", () => fr.connect(actors.methodAuthorityA).approve(fsId));
    await ok("FactorRegistry.approve", () => fr.connect(actors.methodAuthorityB).approve(fsId));
    const manifest = id(`MANIFEST/${run}`);
    await ok("EvidenceRegistry.register", () => er.connect(actors.lcaService).register(manifest, id(`pid/${run}`), b32("REPO/ARCHIVE"), t0 + 10 * 365 * 86400, 3));

    // ---------------- corrections and stale results ----------------
    const target = pick(batches.filter((b) => b.lots.some((l) => l.orchard.owner === "grower")));
    const corrOrchard = target.lots.find((l) => l.orchard.owner === "grower").orchard;
    const original = corrOrchard.events.find((z) => !z.meter) || corrOrchard.events[0];
    const [, , , staleDigest] = await ct.certificationStatus(target.id);
    const resultInput = async (digest) => {
      const snapBlock = await ethers.provider.getBlock("latest");
      return { boundaryCode: b32("PARTIAL_CRADLE_TO_MILL_GATE"), functionalUnit: b32("EVOO_1L_MILL_GATE"), allocationRule: b32("NONE_UNALLOCATED"), factorSetId: fsId, engineVersion: b32("evoo-lca-engine/1.2.0"), reportHash: ev("report"), evidenceManifest: manifest, expectedRevisionDigest: digest, snapshotBlockNumber: snapBlock.number, snapshotBlockHash: snapBlock.hash, methodologicalStatus: 0, limitationFlags: 512, assessmentHash: id("FI/UNASSESSED"), phaseMg: [1500000n, 30000n, 200000n], totalMg: 1730000n };
    };
    const replacement = (overrides = {}) => eventInput({ ...{ activity: E.decodeBytes32String(original.e.activity), variable: E.decodeBytes32String(original.e.variable), quantity: original.e.quantity + 1000n, observedAt: original.e.observedAt, source: original.e.source, sourceId: original.e.sourceId, evidenceHash: ev("corrected") }, ...overrides });
    for (let a = 0; a < ATTEMPTS; a++) {
      await fault("F21", "variable changed", () => ct.connect(actors.grower).proposeCorrection(original.index, replacement({ variable: original.spec && original.spec.variable === "FIELD_DIESEL_L" ? "FIELD_PETROL_L" : "FIELD_DIESEL_L", activity: "SOIL_PREPARATION", source: SourceClass.OperatorEntry, sourceId: E.ZeroHash }), original.sig, ev("reason")));
      await fault("F22", "growerB proposes", () => ct.connect(actors.growerB).proposeCorrection(original.index, replacement(), original.sig, ev("reason")));
    }
    const proposer = rand() < 0.5 ? "grower" : "growerColleague";
    const pr = await ok("proposeCorrection", () => ct.connect(actors[proposer]).proposeCorrection(original.index, replacement(), original.sig, ev("reason")));
    const correctionId = pr ? Number(await ct.correctionCount()) : 0;
    for (let a = 0; a < ATTEMPTS; a++) { const who = pick(["mill", "certifier", "growerB"]); await fault("F23", who, () => ct.connect(actors[who]).authorizeCorrection(correctionId)); }
    await ok("authorizeCorrection", () => ct.connect(actors.auditor).authorizeCorrection(correctionId));
    for (let a = 0; a < ATTEMPTS; a++) await fault("F25", "stale revision digest", async () => cc.connect(actors.lcaService).submitResult(target.id, await resultInput(staleDigest)));
    await ok("verifyFarmPhase(after correction)", () => ct.connect(actors.certifier).verifyFarmPhase(corrOrchard.id, YEAR, ev("re-verification")));
    const [, , , digest] = await ct.certificationStatus(target.id);
    await ok("submitResult", async () => cc.connect(actors.lcaService).submitResult(target.id, await resultInput(digest)));
    await ok("approveResult", () => cc.connect(actors.certifier).approveResult(target.id, 1));

    // ---------------- evidence integrity ----------------
    for (let a = 0; a < ATTEMPTS; a++) {
      const o = pick(orchards);
      const x = pick(o.events);
      const altered = E.keccak256(E.concat([x.e.evidenceHash, E.toUtf8Bytes(" ")]));
      await fault("F27", "document bytes changed", async () => ({ view: await ct.matchesEvidence(x.index, altered) }));
      invariants.checked++;
      if (!(await ct.matchesEvidence(x.index, x.e.evidenceHash))) { invariants.failed++; invariants.failures.push({ run, check: "original evidence matches" }); }
    }

    // ---------------- invariants of the valid chain ----------------
    const inv = (cond, check) => { invariants.checked++; if (!cond) { invariants.failed++; invariants.failures.push({ run, check }); } };
    for (const b of batches) {
      const [batch, lotIds] = await ct.getBatch(b.id);
      inv(batch.closed, `batch ${b.id} closed`);
      inv(lotIds.length === b.lots.length, "batch lot count");
      let sum = 0n;
      for (const l of b.lots) {
        const lot = await ct.getLot(l.id);
        inv(Number(lot.state) === 4 && lot.batchId === b.id, "lot consumed exactly once by its batch");
        sum += lot.receivedMassG;
      }
      inv(sum === batch.receivedMassG, "batch mass equals the sum of its received lots");
    }
    const cert = await cc.getCertificate(target.id);
    inv(Number(cert.status) === 1, "certificate of the corrected batch is Valid after recalculation");
    const corr = await ct.getCorrection(correctionId);
    inv(Number(corr.status) === 2, "correction applied");
    const origEv = await ct.getActivityEvent(original.index);
    inv(Number(origEv.status) === 3, "original event kept and marked superseded");

    chains.push({ run, orchards: orchards.length, growerOrchards: growerOrchards.length, lots: allLots.length, batches: batches.length, events: Number(await ct.eventCount()) });
    process.stdout.write(`run ${run}/${RUNS}: ${orchards.length} orchards, ${allLots.length} lots, ${batches.length} batches, ${records.filter((r) => r.run === run).length} faults\n`);
  }

  // ---------------- summary ----------------
  const byClass = {};
  for (const [cls, [label, expected]] of Object.entries(CLASSES)) {
    const rs = records.filter((r) => r.cls === cls);
    byClass[cls] = { label, expected, attempts: rs.length, detected: rs.filter((r) => r.outcome === "detected").length, prevented: rs.filter((r) => r.outcome === "prevented").length, missed: rs.filter((r) => r.outcome === "missed").length, otherErrors: [...new Set(rs.filter((r) => r.outcome === "prevented").map((r) => r.error))] };
  }
  const det = records.filter((r) => r.cls !== "R01");
  const sum = (k) => chains.reduce((a, c) => a + c[k], 0);
  const out = {
    generatedAt: new Date().toISOString(),
    seed: SEED, runs: RUNS, attemptsPerClassAndRun: ATTEMPTS,
    supplyChains: { orchards: sum("orchards"), lots: sum("lots"), batches: sum("batches"), events: sum("events"), perRun: chains },
    validOperations: validOps,
    faults: { attempts: det.length, detected: det.filter((r) => r.outcome === "detected").length, prevented: det.filter((r) => r.outcome === "prevented").length, missed: det.filter((r) => r.outcome === "missed").length },
    residual: byClass.R01,
    invariants,
    byClass,
    records,
  };
  fs.mkdirSync(path.join(__dirname, "../reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "../reports/fault-injection.json"), JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  const { records: _r, ...brief } = out;
  console.log(JSON.stringify(brief, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
