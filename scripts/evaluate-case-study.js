"use strict";
// Runs the Western Achaia replay with storage tracing and writes the evaluation reports:
//   reports/case-study-replay.json   results, certificate timeline, totals
//   reports/lca-report-v1.json, reports/lca-report-v2.json   off-chain calculation reports
//   reports/transactions.csv          footprint of every transaction
//   reports/gas-report.md             summary tables
// Usage: npx hardhat run scripts/evaluate-case-study.js

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { reset } = require("@nomicfoundation/hardhat-network-helpers");
const { runCaseStudyReplay } = require("../lib/replay");
const { canonicalJson } = require("../lib/encoding");

const OUT = path.join(__dirname, "../reports");
const fmt = (n) => (n === null || n === undefined ? "–" : Number(n).toLocaleString("en-US"));

async function main() {
  await reset();
  const r = await runCaseStudyReplay(hre, { traceStorage: true, log: console.log });
  fs.mkdirSync(OUT, { recursive: true });

  const acts = { setup: "Consortium configuration", act1: "Act 1 – 2024 season", act2: "Act 2 – conference-version result", act3: "Act 3 – journal-version corrections" };
  const totalsByAct = Object.fromEntries(Object.keys(acts).map((a) => [a, r.rec.totals((e) => e.act === a)]));
  const operational = r.rec.totals((e) => e.act !== "setup");
  const summarize = (x) => ({
    perKgOil: x.report.total.perKgOil,
    perHa: x.report.total.perHa,
    phasesPerKgOil: Object.fromEntries(Object.entries(x.report.phases).map(([k, v]) => [k, v.perKgOil])),
    groupsPerHa: Object.fromEntries(Object.entries(x.report.groups).map(([k, v]) => [k, v.perHa])),
    resultPackage: { ...x.resultInput, phaseMg: x.resultInput.phaseMg.map(String), totalMg: String(x.resultInput.totalMg) },
    reportHash: x.reportHash,
    manifestHash: x.manifestHash,
  });
  const out = {
    generatedAt: new Date().toISOString(),
    network: "Hardhat EVM (London rules, zero gas price), solc 0.8.28 viaIR, optimizer 200 runs",
    eventCount: r.eventCount,
    results: {
      v1_conferenceVersion: summarize(r.results.v1),
      v2_journalVersion: summarize(r.results.v2),
      allocationVariants: { economic: r.results.economic.report.total.perKgOil, wetMass: r.results.wetMass.report.total.perKgOil },
    },
    literPackageRejection: r.literRejection,
    fs2025OnCorrectedChain: r.fs25OnCorrectedChain,
    certificateTimeline: r.certificateTimeline,
    deployments: r.rec.deployments,
    deploymentTotalGas: r.rec.deployments.reduce((a, d) => a + d.gasUsed, 0),
    totalsByAct,
    operationalTotals: operational,
    perOperation: r.rec.summary(),
  };
  fs.writeFileSync(path.join(OUT, "case-study-replay.json"), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(OUT, "lca-report-v1.json"), JSON.stringify(JSON.parse(canonicalJson(r.results.v1.report)), null, 2));
  fs.writeFileSync(path.join(OUT, "lca-report-v2.json"), JSON.stringify(JSON.parse(canonicalJson(r.results.v2.report)), null, 2));
  fs.writeFileSync(path.join(OUT, "evidence-manifest-v2.json"), JSON.stringify(JSON.parse(canonicalJson(r.results.v2.manifest)), null, 2));

  const header = "act,label,detail,gasUsed,calldataBytes,logBytes,newSlots,updatedSlots,block,timestamp,txHash";
  const rows = r.rec.entries.map((e) =>
    [e.act, e.label, JSON.stringify(e.detail ?? ""), e.gasUsed, e.calldataBytes, e.logBytes, e.newSlots, e.updatedSlots, e.block, new Date(e.timestamp * 1000).toISOString(), e.hash].join(",")
  );
  fs.writeFileSync(path.join(OUT, "transactions.csv"), [header, ...rows].join("\n") + "\n");

  const scalingPath = path.join(OUT, "scaling.json");
  const scaling = fs.existsSync(scalingPath) ? JSON.parse(fs.readFileSync(scalingPath, "utf8")) : null;
  const md = [];
  md.push("# Gas, storage and ledger-footprint report", "");
  md.push(`Generated ${out.generatedAt} on the ${out.network}. Gas is a measure of computational and storage load; on a permissioned network with zero gas price it carries no fee.`, "");
  md.push("## Case-study results computed from the ledger", "");
  md.push("| Result package | kg CO2eq per kg EVOO | kg CO2eq per ha | Cultivation | Transport | Mill |", "|---|---|---|---|---|---|");
  for (const [k, v] of [["v1 – FS-2025-CONF (conference version)", out.results.v1_conferenceVersion], ["v2 – FS-2026-01 (journal version)", out.results.v2_journalVersion]]) {
    md.push(`| ${k} | ${v.perKgOil.toFixed(4)} | ${v.perHa.toFixed(1)} | ${v.phasesPerKgOil.cultivation.toFixed(4)} | ${v.phasesPerKgOil.transport.toFixed(4)} | ${v.phasesPerKgOil.mill.toFixed(4)} |`);
  }
  md.push("", `Per-liter package of the conference version rejected with \`${out.literPackageRejection}\`. FS-2025-CONF on the corrected chain: “${out.fs2025OnCorrectedChain}”.`, "");
  md.push("## Certificate timeline", "", "| Step | Date (chain time) | Status | Version | kg CO2eq/kg | Factor set |", "|---|---|---|---|---|---|");
  for (const c of out.certificateTimeline) md.push(`| ${c.label} | ${c.date.slice(0, 10)} | ${c.status} | ${c.version} | ${c.kgCO2eqPerFU || "–"} | ${c.factorSet ?? "–"} |`);
  md.push("", "## Deployment", "", "| Contract | Deployment gas | Runtime bytecode (bytes) | Share of EIP-170 limit |", "|---|---|---|---|");
  for (const d of out.deployments) md.push(`| ${d.name} | ${fmt(d.gasUsed)} | ${fmt(d.runtimeBytes)} | ${((d.runtimeBytes / 24576) * 100).toFixed(1)}% |`);
  md.push(`| **Total** | **${fmt(out.deploymentTotalGas)}** | | |`, "");
  md.push("## Gas and footprint per operation (case-study replay)", "", "| Operation | n | Gas (mean) | Gas (min–max) | Calldata (B) | Log (B) | New storage slots |", "|---|---|---|---|---|---|---|");
  for (const s of out.perOperation) md.push(`| ${s.label} | ${s.count} | ${fmt(s.gasMean)} | ${fmt(s.gasMin)}–${fmt(s.gasMax)} | ${fmt(s.calldataBytesMean)} | ${fmt(s.logBytesMean)} | ${s.newSlotsMean ?? "–"} |`);
  md.push("", "## Totals by act", "", "| Act | Transactions | Gas | Calldata (B) | Log (B) | New slots (×32 B) |", "|---|---|---|---|---|---|");
  for (const [a, t] of Object.entries(totalsByAct)) md.push(`| ${acts[a]} | ${t.transactions} | ${fmt(t.gasUsed)} | ${fmt(t.calldataBytes)} | ${fmt(t.logBytes)} | ${fmt(t.newSlots)} (${fmt(t.newSlots * 32)} B) |`);
  md.push(`| **Operational total (acts 1–3)** | **${operational.transactions}** | **${fmt(operational.gasUsed)}** | **${fmt(operational.calldataBytes)}** | **${fmt(operational.logBytes)}** | **${fmt(operational.newSlots)} (${fmt(operational.newSlots * 32)} B)** |`, "");
  if (scaling) {
    md.push("## Scaling with the number of lots per batch", "", "| Lots | createBatch | closeBatch | submitResult | approveResult | getCertificate (view) |", "|---|---|---|---|---|---|");
    for (const row of scaling.rows) md.push(`| ${row.lots} | ${fmt(row.createBatch)} | ${fmt(row.closeBatch)} | ${fmt(row.submitResult)} | ${fmt(row.approveResult)} | ${fmt(row.getCertificate_view)} |`);
    const m = scaling.marginalGasPerLot;
    md.push(`| Marginal gas per lot | ${fmt(m.createBatch)} | ${fmt(m.closeBatch)} | ${fmt(m.submitResult)} | ${fmt(m.approveResult)} | ${fmt(m.getCertificate_view)} |`, "");
  }
  md.push("## Not measured", "", "Network latency, finality time and throughput of a multi-node Besu QBFT network were not measured; the figures above are execution-level measurements on a single in-process EVM with the same London rules.", "");
  fs.writeFileSync(path.join(OUT, "gas-report.md"), md.join("\n"));
  console.log("reports written to", OUT);
  console.log(JSON.stringify({ operational, deploymentTotalGas: out.deploymentTotalGas }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
