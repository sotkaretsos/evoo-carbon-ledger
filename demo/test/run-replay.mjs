// Node check of the browser demo: runs the three acts on the in-browser chain and every
// rule-breaking attempt, and compares the results with the reports of the Hardhat replay.
import { CaseStudyDemo } from "../src/scenario.js";
import reference from "../../reports/case-study-replay.json";

const t0 = Date.now();
const demo = await new CaseStudyDemo({}).init();
await demo.setup();
for (const act of ["act1", "act2", "act3"]) await demo[act]();
const totals = demo.totals();
const ref = reference.totalsByAct;
const rows = [
  ["setup", totals.setup, ref.setup],
  ["act1", totals.act1, ref.act1],
  ["act2", totals.act2, ref.act2],
  ["act3", totals.act3, ref.act3],
  ["operational", totals.operational, reference.operationalTotals],
];
let ok = true;
for (const [name, mine, theirs] of rows) {
  const same = mine.transactions === theirs.transactions && mine.gasUsed === theirs.gasUsed;
  ok &&= same;
  console.log(`${name.padEnd(12)} tx ${mine.transactions}/${theirs.transactions} gas ${mine.gasUsed}/${theirs.gasUsed} ${same ? "same" : "DIFFERENT"}`);
}
console.log(`deployment gas ${totals.deploymentGas}/${reference.deploymentTotalGas}`);
const r = demo.results;
console.log("v1 per kg", r.v1.report.total.perKgOil, "v2 per kg", r.v2.report.total.perKgOil, "per ha", r.v2.report.total.perHa);
console.log("per-liter", r.literRejection, "economic", r.economic.report.total.perKgOil, "wet mass", r.wetMass.report.total.perKgOil);
console.log("events", r.eventCount, "fs25 on corrected chain:", r.fs25OnCorrectedChain);
console.log("certificate timeline", demo.certificateTimeline.map((c) => `${c.status} v${c.version} ${c.kgCO2eqPerFU}`).join(" | "));
const before = demo.chain.blocks.length;
for (const a of demo.attacks()) {
  const res = await a.run();
  console.log(`attack ${a.key.padEnd(12)} ${a.requirement} -> ${res.accepted ? "ACCEPTED" : res.name} ${JSON.stringify(demo.describeArgs(res.name, res.args ?? []))}`);
}
console.log("blocks unchanged after attacks:", demo.chain.blocks.length === before);
console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)} s; gas totals ${ok ? "identical to" : "differ from"} the Hardhat replay`);
