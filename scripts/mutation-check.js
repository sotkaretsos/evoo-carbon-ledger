"use strict";
// Mutation check: removes one safeguard at a time and confirms that the test suite fails.
// Usage: node scripts/mutation-check.js   (writes reports/mutation-check.txt; sources are restored)

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const MUTATIONS = [
  ["separation-of-duties", "contracts/CarbonCertification.sol", "if (res.submitter == msg.sender) revert SeparationOfDuties();"],
  ["functional-unit-check", "contracts/CarbonCertification.sol", "if (fuUnit != outputUnit) revert FunctionalUnitMismatch(fuUnit, outputUnit);"],
  ["envelope-idempotency", "contracts/CarbonTraceability.sol", "if (_recordedEnvelopes[envelope]) revert DuplicateEvent(envelope);"],
  ["verification-reset", "contracts/CarbonTraceability.sol", "s.verified = false; // verification must be renewed for the corrected record set"],
  ["lot-consumption", "contracts/CarbonTraceability.sol", "l.state = LotState.InBatch;\n            l.batchId = batchId;"],
  ["calculation-revision", "contracts/CarbonCertification.sol", "if (r.expectedRevisionDigest != digest) revert RevisionMismatch(r.expectedRevisionDigest, digest);"],
  ["correction-variable", "contracts/CarbonTraceability.sol", "if (replacement.variable != orig.variable) revert CorrectionVariableMismatch(orig.variable, replacement.variable);"],
  ["approval-evidence-check", "contracts/CarbonCertification.sol", "if (!evidenceRegistry.isRetained(res.data.evidenceManifest, uint64(block.timestamp) + minRetentionSeconds, minEvidenceReplicas)) {\n            revert EvidenceNotRetained(res.data.evidenceManifest);\n        }"],
  ["methodological-policy-floor", "contracts/CarbonCertification.sol", "if (uint8(r.methodologicalStatus) < policy.minimumStatus || r.limitationFlags == 0 ||\n            (r.limitationFlags & policy.requiredLimitations) != policy.requiredLimitations || r.assessmentHash == bytes32(0)) {\n            revert MethodologicalPolicyViolation();\n        }"],
  ["aggregate-applicability-status", "offchain/methodological-assessment.js", "if (mismatch) { status = Status.NeedsRecalculation; flags |= Limitation.CalibrationMismatch; }"],
];

function runTests() {
  try {
    return execFileSync(process.execPath, [require.resolve("hardhat/internal/cli/cli"), "test"], { cwd: ROOT, env: { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" }, encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    return `${e.stdout || ""}${e.stderr || ""}`;
  }
}

const out = ["Mutation check: each safeguard removed separately; the test suite must fail.", ""];
let allDetected = true;
for (const [name, file, statement] of MUTATIONS) {
  const p = path.join(ROOT, file);
  const original = fs.readFileSync(p, "utf8");
  if (!original.includes(statement)) throw new Error(`statement for ${name} not found`);
  try {
    fs.writeFileSync(p, original.replace(statement, ""));
    const log = runTests().replace(/\x1b\[[0-9;]*m/g, "");
    const failing = (log.match(/(\d+) failing/) || [null, "0"])[1];
    const passing = (log.match(/(\d+) passing/) || [null, "0"])[1];
    const titles = [...new Set(log.split("\n").filter((l) => /^\s+\d+\) /.test(l)).map((l) => l.trim()))];
    out.push(`## ${name}`, `${passing} passing, ${failing} failing`, ...titles.map((t) => `  ${t}`), "");
    if (Number(failing) === 0) allDetected = false;
  } finally {
    fs.writeFileSync(p, original);
  }
}
out.push(allDetected ? "All mutations detected." : "WARNING: at least one mutation was not detected.");
fs.writeFileSync(path.join(ROOT, "reports/mutation-check.txt"), out.join("\n") + "\n");
console.log(out.join("\n"));
// Leave artifacts consistent with the restored source, and make CI failures observable.
execFileSync(process.execPath, [require.resolve("hardhat/internal/cli/cli"), "compile"], { cwd: ROOT, stdio: "inherit" });
if (!allDetected) process.exitCode = 1;
