"use strict";
// Hash/ABI verification only, separate from the production engine and Decimal arithmetic.
// Uses the standard ethers Keccak/ABI primitives; does not import lib/encoding or lca-engine.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const ROOT = __dirname;
const OUT = path.join(ROOT, "results");
const read = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name), "utf8"));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const hash = value => ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(canonical(value))));
const expectedFactor = hash(read("factors.synthetic.json"));
const checks = [];
const check = (label, pass) => checks.push({ label, pass: Boolean(pass) });
const snapshotHashes = {};
for (const state of ["baseline", "corrected", "wrongSource"]) {
  const name = "snapshot-" + state + ".json";
  const raw = fs.readFileSync(path.join(OUT, name));
  snapshotHashes[name] = crypto.createHash("sha256").update(raw).digest("hex");
  const snapshot = JSON.parse(raw);
  for (const claim of snapshot.claims) {
    const label = state + "/" + claim.batch + "/" + claim.allocationRule;
    check(label + ":factor", claim.report.factorSet.contentHash === expectedFactor && claim.manifest.factorSetContentHash === expectedFactor);
    check(label + ":report", hash(claim.report) === claim.reportHash && claim.resultInput.reportHash === claim.reportHash);
    check(label + ":manifest", hash(claim.manifest) === claim.manifestHash && claim.resultInput.evidenceManifest === claim.manifestHash && claim.manifest.reportHash === claim.reportHash);
    check(label + ":assessment", hash(claim.report.methodologicalAssessment) === claim.resultInput.assessmentHash);
    check(label + ":revision", claim.report.snapshot.revisionDigest === claim.resultInput.expectedRevisionDigest);
    const expectedEvidence = claim.report.events.filter(e => e.evidenceHash).map(e => [e.index, e.evidenceHash]);
    const manifestEvidence = claim.manifest.evidence.map(e => [e.eventIndex, e.evidenceHash]);
    check(label + ":manifest_events", JSON.stringify(expectedEvidence) === JSON.stringify(manifestEvidence));
  }
  if (state !== "wrongSource") for (const cert of snapshot.certificates) {
    const claim = snapshot.claims.find(c => c.batch === cert.batch && c.allocationRule === "NONE_UNALLOCATED");
    const expected = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint8", "uint32", "bytes32"],
      [claim.reportHash, cert.methodologicalStatus, cert.limitationFlags, cert.assessmentHash]));
    check(state + "/" + cert.batch + ":public_method_commitment", expected === cert.methodologicalCommitment && cert.assessmentHash === claim.resultInput.assessmentHash);
  }
}
const output = { algorithm: "Keccak-256 canonical sorted-key JSON; public commitment ABI bytes32,uint8,uint32,bytes32",
  arithmeticRole: "None; arithmetic is independently reconstructed by Python Decimal",
  sharedPrimitive: "ethers cryptographic library, not the production engine",
  trustBoundary: "Snapshots, registry and certificate captures are trusted producer exports; no independent RPC/consensus/block-proof validation. These checks detect disclosed-data inconsistencies, not a malicious fully rewritten coherent producer export.",
  pass: checks.every(c => c.pass), checksPassed: checks.filter(c => c.pass).length,
  checksTotal: checks.length, snapshotSha256: snapshotHashes, checks };
fs.writeFileSync(path.join(OUT, "commitment-verification.json"), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ pass: output.pass, checksPassed: output.checksPassed, checksTotal: output.checksTotal }));
if (!output.pass) process.exitCode = 1;
