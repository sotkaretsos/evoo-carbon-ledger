// Node check of the browser demo: runs the two acts on the in-browser chain and every
// rule-breaking attempt, and compares the results with the reports of the Hardhat replay.
import { CaseStudyDemo } from "../src/scenario.js";
import reference from "../../reports/case-study-replay.json";
import assert from "node:assert/strict";

const t0 = Date.now();
const demo = await new CaseStudyDemo({}).init();
await demo.setup();
await demo.act1();
const earlyBlockCount = demo.chain.blocks.length;
const earlyUnitRejection = await demo.attacks().find(a => a.key === "perKg").run();
assert.equal(earlyUnitRejection.name, "FunctionalUnitMismatch", "unit attack is available before certification");
assert.equal(demo.chain.blocks.length, earlyBlockCount, "early unit attack restores blocks");
await demo.act2();
const totals = demo.totals();
const ref = reference.totalsByAct;
const rows = [
  ["setup", totals.setup, ref.setup],
  ["act1", totals.act1, ref.act1],
  ["act2", totals.act2, ref.act2],
  ["operational", totals.operational, reference.operationalTotals],
];
let ok = true;
for (const [name, mine, theirs] of rows) {
  const same = mine.transactions === theirs.transactions && mine.gasUsed === theirs.gasUsed;
  ok &&= same;
  assert.equal(mine.transactions, theirs.transactions, `${name}: transaction count`);
  // Snapshot/report hashes differ across EVM block-header implementations. Their
  // zero-byte distribution can change intrinsic calldata gas by a few bytes.
  assert.ok(Math.abs(mine.gasUsed - theirs.gasUsed) <= 512, `${name}: gas differs by more than 512`);
  console.log(`${name.padEnd(12)} tx ${mine.transactions}/${theirs.transactions} gas ${mine.gasUsed}/${theirs.gasUsed} ${same ? "same" : `within tolerance (${Math.abs(mine.gasUsed - theirs.gasUsed)} gas)`}`);
}
console.log(`deployment gas ${totals.deploymentGas}/${reference.deploymentTotalGas}`);
assert.equal(totals.deploymentGas, reference.deploymentTotalGas, "deployment gas");
const r = demo.results;
console.log("v1 per L", r.v1.report.total.perFU, "per ha", r.v1.report.total.perHa, "reference flow", JSON.stringify(r.v1.report.referenceFlow));
console.log("per-kg package", r.kgRejection.name, "economic", r.economic.report.total.perFU, "wet mass", r.wetMass.report.total.perFU);
console.log("events", r.eventCount);
assert.equal(r.eventCount, reference.eventCount);
assert.ok(Math.abs(r.v1.report.total.perFU - reference.results.v1_certified.perFU) < 1e-12);
assert.equal(r.kgRejection.name, "FunctionalUnitMismatch");
assert.deepEqual(demo.certificateTimeline.map(c => c.status), ["None", "Valid"]);
assert.equal(demo.certificateTimeline.at(-1).methodologicalStatus,"AggregateLimited");
assert.equal(demo.certificateTimeline.at(-1).limitationFlags,73);
assert.equal(demo.certificateTimeline.at(-1).assessmentHash,r.v1.report.assessmentHash);
assert.equal(r.v1.report.events.find(e=>e.variable==="MILL_ELECTRICITY_KWH").source,"Meter");
assert.equal(r.v1.report.events.find(e=>e.variable==="OIL_OUTPUT_L").source,"Meter");
console.log("certificate timeline", demo.certificateTimeline.map((c) => `${c.status} v${c.version} ${c.kgCO2eqPerFU}`).join(" | "));
const before = demo.chain.blocks.length;
const expected = { outsider: "Unauthorized", forged: "InvalidDeviceSignature", duplicate: "DuplicateEvent", range: "OutOfRange", mass: "MassMismatch", selfApproval: "SeparationOfDuties", retired: "FactorSetNotUsable", perKg: "FunctionalUnitMismatch", closed: "PhaseClosed", tampered: "HashMismatch", evidence: "EvidenceNotRetained" };
for (const a of demo.attacks()) {
  const res = await a.run();
  assert.equal(res.accepted, false, `attack ${a.key} must be rejected/detected`);
  assert.equal(res.name, expected[a.key], `attack ${a.key}: error name`);
  assert.equal(demo.chain.blocks.length, before, `attack ${a.key}: blocks restored`);
  console.log(`attack ${a.key.padEnd(12)} ${a.requirement} -> ${res.accepted ? "ACCEPTED" : res.name} ${JSON.stringify(demo.describeArgs(res.name, res.args ?? []))}`);
}
console.log("blocks unchanged after attacks:", demo.chain.blocks.length === before);
assert.equal(demo.chain.blocks.length, before);
console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)} s; gas totals ${ok ? "identical to" : "within the declared 512-gas tolerance of"} the Hardhat replay`);
