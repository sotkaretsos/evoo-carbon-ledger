"use strict";
// Reference implementation of the off-chain LCA calculation service (Section 2.8 of the article).
// It reads the effective event chain of a mill batch from the ledger, applies a governed factor
// set, and returns the result package to be submitted to CarbonCertification together with the
// calculation report and the evidence manifest whose hashes are committed on-chain.

const { ethers, str32, hashJson, canonicalJson, farmScopeId, EventStatus, SourceClassName } = require("../lib/encoding");

const ENGINE_VERSION = "evoo-lca-engine/1.0.0";
const PHASES = ["cultivation", "transport", "mill"]; // order of phaseMg in the result package

/** keccak256 of the canonical JSON of a factor-set document (registered in FactorRegistry). */
const factorSetContentHash = (fs) => hashJson(fs);

function matchRule(fs, variable, activity) {
  return fs.rules.find((r) => r.variable === variable && (r.activities.includes("*") || r.activities.includes(activity)));
}

function factorValue(fs, name) {
  const f = fs.factors[name];
  if (!f) throw new Error(`Factor ${name} is not defined in factor set ${fs.id}`);
  return f.value;
}

/** Emission (kg CO2eq) of one effective event under a factor set; null if not a carbon flow. */
function evaluate(fs, ev) {
  const rule = matchRule(fs, ev.variable, ev.activity);
  if (!rule) throw new Error(`No rule for ${ev.variable} in activity ${ev.activity} under factor set ${fs.id}`);
  const q = ev.quantity; // in units of the variable
  switch (rule.method) {
    case "fuel": {
      const density = fs.densities_kg_per_L[rule.fuel];
      if (density === undefined) throw new Error(`Density of ${rule.fuel} is not defined in factor set ${fs.id}`);
      return { rule, kgCO2eq: q * density * factorValue(fs, rule.factor) };
    }
    case "linear":
      return { rule, kgCO2eq: q * factorValue(fs, rule.factor) };
    case "subsumed":
    case "inventory_only":
    case "output_flow":
    case "reference_flow":
      return { rule, kgCO2eq: 0 };
    default:
      throw new Error(`Unknown method ${rule.method}`);
  }
}

/** Reads the ActivityRecorded log of a scope and keeps the events that are currently effective. */
async function effectiveEvents(traceability, scopeId) {
  const logs = await traceability.queryFilter(traceability.filters.ActivityRecorded(null, scopeId, null));
  const out = [];
  for (const log of logs) {
    const index = Number(log.args.index);
    const stored = await traceability.getActivityEvent(index);
    if (Number(stored.status) !== EventStatus.Effective) continue;
    const e = log.args.input;
    out.push({
      index,
      phase: Number(log.args.phase),
      activity: str32(e.activity),
      variable: str32(e.variable),
      quantity: Number(e.quantity) / 1000,
      observedAt: Number(e.observedAt),
      source: SourceClassName[Number(e.source)],
      uncertaintyPermille: Number(e.uncertaintyPermille),
      evidenceHash: e.evidenceHash,
      replaces: Number(log.args.replaces),
      actor: log.args.actor,
    });
  }
  return out;
}

/**
 * Computes the result package of a batch.
 * @param {object} opts.allocationRule  "NONE_UNALLOCATED" (baseline), "ECONOMIC" or "WET_MASS"
 * @param {object} opts.prices          {oil, pomace} EUR per kg, for ECONOMIC allocation
 */
async function computeBatchResult(traceability, batchId, fs, opts = {}) {
  const functionalUnit = opts.functionalUnit ?? "EVOO_1KG_MILL_GATE";
  const boundary = opts.boundary ?? "PARTIAL_CRADLE_TO_MILL_GATE";
  const allocationRule = opts.allocationRule ?? "NONE_UNALLOCATED";
  const [, lotIds] = await traceability.getBatch(batchId);

  // Farm scopes and the share of each scope's harvest that entered this batch.
  const scopes = new Map();
  const lots = [];
  for (const lotId of lotIds) {
    const lot = await traceability.getLot(lotId);
    const scopeId = farmScopeId(lot.orchardId, lot.cropYear);
    if (!scopes.has(scopeId)) {
      const scope = await traceability.getFarmScope(lot.orchardId, lot.cropYear);
      const orchard = await traceability.getOrchard(lot.orchardId);
      scopes.set(scopeId, { scopeId, orchardId: lot.orchardId, cropYear: Number(lot.cropYear), harvestedKg: Number(scope.harvestedMassG) / 1000, areaHa: Number(orchard.areaM2) / 10000, lotKg: 0 });
    }
    scopes.get(scopeId).lotKg += Number(lot.harvestedMassG) / 1000;
    lots.push({ lotId, scopeId, harvestedKg: Number(lot.harvestedMassG) / 1000, receivedKg: Number(lot.receivedMassG) / 1000 });
  }

  const groups = {};
  const phaseKg = [0, 0, 0];
  const usedEvents = [];
  const addGroup = (group, phase, kg) => {
    if (!group) return; // reference, output and inventory-only flows carry no emission
    groups[group] = (groups[group] ?? 0) + kg;
    phaseKg[phase] += kg;
  };

  // Phase 1: farm scopes, allocated to the batch in proportion to harvested mass.
  let areaHa = 0;
  for (const s of scopes.values()) {
    const share = s.lotKg / s.harvestedKg;
    areaHa += s.areaHa * share;
    const events = await effectiveEvents(traceability, s.scopeId);
    for (const ev of events) {
      const { rule, kgCO2eq } = evaluate(fs, ev);
      addGroup(rule.group, 0, kgCO2eq * share);
      usedEvents.push({ ...ev, method: rule.method, group: rule.group ?? null, kgCO2eq: kgCO2eq * share });
    }
    for (const ag of fs.areaGroups ?? []) {
      if (events.some((ev) => ev.activity === ag.whenActivity)) {
        const kg = s.areaHa * factorValue(fs, ag.factor) * share;
        addGroup(ag.group, 0, kg);
        usedEvents.push({ areaGroup: ag.group, scopeId: s.scopeId, areaHa: s.areaHa, factor: ag.factor, kgCO2eq: kg });
      }
    }
  }
  // Phase 2: transport events of each lot.
  for (const lot of lots) {
    for (const ev of await effectiveEvents(traceability, lot.lotId)) {
      const { rule, kgCO2eq } = evaluate(fs, ev);
      addGroup(rule.group, 1, kgCO2eq);
      usedEvents.push({ ...ev, method: rule.method, group: rule.group ?? null, kgCO2eq });
    }
  }
  // Phase 3: mill batch events; reference flow and co-product flows.
  let oilKg = 0;
  let pomaceKg = 0;
  for (const ev of await effectiveEvents(traceability, batchId)) {
    const { rule, kgCO2eq } = evaluate(fs, ev);
    if (rule.method === "reference_flow") oilKg += ev.quantity;
    if (ev.variable === "POMACE_KG") pomaceKg += ev.quantity;
    addGroup(rule.group, 2, kgCO2eq);
    usedEvents.push({ ...ev, method: rule.method, group: rule.group ?? null, kgCO2eq });
  }
  if (!(oilKg > 0)) throw new Error("No effective oil-output (reference flow) event in the batch");

  // Co-product allocation (Section 2.6): share of the burden assigned to the oil.
  let oilShare = 1;
  if (allocationRule === "ECONOMIC") {
    const { oil, pomace } = opts.prices ?? { oil: 4.0, pomace: 0.03 };
    oilShare = (oilKg * oil) / (oilKg * oil + pomaceKg * pomace);
  } else if (allocationRule === "WET_MASS") {
    oilShare = oilKg / (oilKg + pomaceKg);
  } else if (allocationRule !== "NONE_UNALLOCATED") {
    throw new Error(`Unsupported allocation rule ${allocationRule}`);
  }

  const totalKg = phaseKg.reduce((a, b) => a + b, 0);
  const perKg = (kg) => (kg * oilShare) / oilKg;
  const phaseMg = phaseKg.map((kg) => Math.round(perKg(kg) * 1e6));
  const totalMg = phaseMg.reduce((a, b) => a + b, 0);

  const report = {
    engine: ENGINE_VERSION,
    batchId,
    ledger: await traceability.getAddress(),
    factorSet: { id: fs.id, version: fs.version, contentHash: factorSetContentHash(fs) },
    functionalUnit,
    boundary,
    allocationRule,
    oilShare,
    referenceFlow: { variable: "OIL_OUTPUT_KG", kg: oilKg },
    coProducts: { pomaceKg },
    areaHa,
    lots,
    groups: Object.fromEntries(
      Object.entries(groups).map(([g, kg]) => [g, { label: fs.groups[g] ?? g, kgCO2eq: kg, perHa: areaHa ? kg / areaHa : null, perKgOil: perKg(kg) }])
    ),
    phases: Object.fromEntries(PHASES.map((p, i) => [p, { kgCO2eq: phaseKg[i], perKgOil: perKg(phaseKg[i]), mg: phaseMg[i] }])),
    total: { kgCO2eq: totalKg, perHa: areaHa ? totalKg / areaHa : null, perKgOil: perKg(totalKg), mg: totalMg },
    events: usedEvents,
  };
  const reportHash = hashJson(report);
  const manifest = {
    batchId,
    reportHash,
    factorSetContentHash: report.factorSet.contentHash,
    evidence: usedEvents.filter((e) => e.evidenceHash).map((e) => ({ eventIndex: e.index, evidenceHash: e.evidenceHash })),
  };
  const manifestHash = hashJson(manifest);

  const resultInput = {
    boundaryCode: ethers.encodeBytes32String(boundary),
    functionalUnit: ethers.encodeBytes32String(functionalUnit),
    allocationRule: ethers.encodeBytes32String(allocationRule),
    factorSetId: ethers.encodeBytes32String(fs.id),
    engineVersion: ethers.encodeBytes32String(ENGINE_VERSION),
    reportHash,
    evidenceManifest: manifestHash,
    phaseMg: phaseMg.map(BigInt),
    totalMg: BigInt(totalMg),
  };
  return { resultInput, report, reportHash, manifest, manifestHash };
}

module.exports = { ENGINE_VERSION, PHASES, computeBatchResult, effectiveEvents, evaluate, factorSetContentHash, canonicalJson };
