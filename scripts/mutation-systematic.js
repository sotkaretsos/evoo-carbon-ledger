"use strict";
// Systematic mutation analysis of the contracts (extends scripts/mutation-check.js, whose ten
// mutations were chosen by hand). Every guard and every role restriction is removed in turn and the
// full test suite is run against the mutant:
//   GUARD     a single-line guard            if (<condition>) revert <Error>(...);
//   GUARD_ML  a block guard                  if (<condition>) { revert <Error>(...); }
//   ROLE      a role modifier on a function  onlyRole(Roles.<ROLE>)
// A mutant is "killed" when at least one test fails, "survived" when all tests pass, and "invalid"
// when it does not compile. Sources are restored after each mutant.
// Usage: node scripts/mutation-systematic.js   (writes reports/mutation-systematic.json and .txt)
// Optional: MUTATION_FILTER=<substring of file name> to restrict the files.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FILES = ["CarbonTraceability.sol", "CarbonCertification.sol", "Consortium.sol", "FactorRegistry.sol", "EvidenceRegistry.sol", "lib/EnvelopeValidation.sol"]
  .filter((f) => !process.env.MUTATION_FILTER || f.includes(process.env.MUTATION_FILTER))
  .map((f) => path.join("contracts", f));

const PATTERNS = [
  ["GUARD", /^[ \t]*if \((?:[^;{}\n]|\n)*?\) revert [A-Za-z_][A-Za-z0-9_]*\([^;]*\);[ \t]*$/gm],
  ["GUARD_ML", /^[ \t]*if \((?:[^;{}])*?\)\s*\{\s*revert [A-Za-z_][A-Za-z0-9_]*\([^;]*\);\s*\}[ \t]*$/gm],
  ["ROLE", /\bonlyRole\(Roles\.[A-Z_]+\)/g],
];

function functionAt(src, index) {
  const before = src.slice(0, index);
  const m = [...before.matchAll(/\b(function|modifier)\s+([A-Za-z0-9_]+)|\b(constructor)\b/g)].pop();
  return m ? (m[3] || `${m[1]} ${m[2]}`) : "?";
}

function runTests() {
  try {
    const log = execFileSync(process.execPath, [require.resolve("hardhat/internal/cli/cli"), "test"], { cwd: ROOT, env: { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" }, encoding: "utf8", stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    return { log, compiled: true };
  } catch (e) {
    const log = `${e.stdout || ""}${e.stderr || ""}`;
    return { log, compiled: !/HH600|Compilation failed|CompilerError|DeclarationError|TypeError:/.test(log) };
  }
}

const mutants = [];
for (const file of FILES) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  for (const [op, re] of PATTERNS) {
    for (const m of src.matchAll(re)) {
      const line = src.slice(0, m.index).split("\n").length;
      mutants.push({ op, file, line, fn: functionAt(src, m.index), start: m.index, end: m.index + m[0].length, text: m[0].trim().replace(/\s+/g, " ") });
    }
  }
}
// A block guard is also matched by GUARD when it fits on one line; keep one mutant per location.
const seen = new Set();
const unique = mutants.filter((m) => { const k = `${m.file}:${m.start}`; if (seen.has(k)) return false; seen.add(k); return true; });

// Optional: MUTATION_ONLY=<file:line:op,...> to re-run selected mutants (e.g. the survivors of a previous run).
const only = process.env.MUTATION_ONLY ? new Set(process.env.MUTATION_ONLY.split(",")) : null;
if (only) unique.splice(0, unique.length, ...unique.filter((m) => only.has(`${m.file}:${m.line}:${m.op}`)));

if (process.env.DRY) {
  for (const m of unique) console.log(`${m.op.padEnd(8)} ${m.file}:${m.line} ${m.fn} :: ${m.text.slice(0, 90)}`);
  console.log(unique.length, "mutants");
  process.exit(0);
}

const results = [];
const t0 = Date.now();
unique.forEach((m, i) => {
  const p = path.join(ROOT, m.file);
  const original = fs.readFileSync(p, "utf8");
  try {
    fs.writeFileSync(p, original.slice(0, m.start) + original.slice(m.end));
    const { log, compiled } = runTests();
    const clean = log.replace(/\x1b\[[0-9;]*m/g, "");
    const failing = Number((clean.match(/(\d+) failing/) || [null, "0"])[1]);
    const passing = Number((clean.match(/(\d+) passing/) || [null, "0"])[1]);
    const outcome = !compiled || passing + failing === 0 ? "invalid" : failing > 0 ? "killed" : "survived";
    const titles = [...new Set(clean.split("\n").filter((l) => /^\s+\d+\) /.test(l)).map((l) => l.trim().replace(/^\d+\)\s*/, "")))].slice(0, 6);
    results.push({ id: i + 1, op: m.op, file: m.file, line: m.line, function: m.fn, removed: m.text, outcome, passing, failing, failingTests: titles });
    process.stdout.write(`${String(i + 1).padStart(3)}/${unique.length} ${outcome.padEnd(8)} ${m.op.padEnd(8)} ${m.file}:${m.line} ${m.fn}\n`);
  } finally {
    fs.writeFileSync(p, original);
  }
});

const count = (o, op) => results.filter((r) => r.outcome === o && (!op || r.op === op)).length;
const valid = results.length - count("invalid");
const summary = {
  generatedAt: new Date().toISOString(),
  files: FILES,
  mutants: results.length,
  valid,
  killed: count("killed"),
  survived: count("survived"),
  invalid: count("invalid"),
  mutationScore: valid ? +(count("killed") / valid).toFixed(4) : null,
  byOperator: Object.fromEntries(PATTERNS.map(([op]) => [op, { mutants: results.filter((r) => r.op === op).length, killed: count("killed", op), survived: count("survived", op), invalid: count("invalid", op) }])),
  minutes: +((Date.now() - t0) / 60000).toFixed(1),
};
fs.mkdirSync(path.join(ROOT, "reports"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "reports/mutation-systematic.json"), JSON.stringify({ summary, results }, null, 2));
const lines = [
  "Systematic mutation analysis: each guard and role restriction removed in turn; the test suite must fail.",
  JSON.stringify(summary, null, 2),
  "",
  "Survived mutants:",
  ...results.filter((r) => r.outcome === "survived").map((r) => `  #${r.id} ${r.op} ${r.file}:${r.line} (${r.function}): ${r.removed}`),
  "",
  "Invalid mutants:",
  ...results.filter((r) => r.outcome === "invalid").map((r) => `  #${r.id} ${r.op} ${r.file}:${r.line} (${r.function}): ${r.removed}`),
];
fs.writeFileSync(path.join(ROOT, "reports/mutation-systematic.txt"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
execFileSync(process.execPath, [require.resolve("hardhat/internal/cli/cli"), "compile"], { cwd: ROOT, stdio: "inherit" });
