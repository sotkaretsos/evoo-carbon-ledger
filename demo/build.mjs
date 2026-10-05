// Builds the live demo into ../docs/assets (GitHub Pages) from the compiled contracts.
// Usage (from the repository root):  npx hardhat compile && cd demo && npm ci && npm run build
//        node test:                  cd demo && npm run test:node
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const CONTRACTS = {
  EnvelopeValidation: "contracts/lib/EnvelopeValidation.sol/EnvelopeValidation.json",
  Consortium: "contracts/Consortium.sol/Consortium.json",
  FactorRegistry: "contracts/FactorRegistry.sol/FactorRegistry.json",
  EvidenceRegistry: "contracts/EvidenceRegistry.sol/EvidenceRegistry.json",
  CarbonTraceability: "contracts/CarbonTraceability.sol/CarbonTraceability.json",
  CarbonCertification: "contracts/CarbonCertification.sol/CarbonCertification.json",
};

// Slim copy of the Hardhat artifacts: ABI, creation bytecode and library link references.
const slim = {};
for (const [name, rel] of Object.entries(CONTRACTS)) {
  const file = join(root, "artifacts", rel);
  if (!existsSync(file)) throw new Error(`${file} not found: run "npx hardhat compile" in the repository root first`);
  const a = JSON.parse(readFileSync(file, "utf8"));
  slim[name] = { abi: name === "EnvelopeValidation" ? [] : a.abi, bytecode: a.bytecode, linkReferences: a.linkReferences };
}
mkdirSync(join(here, "build"), { recursive: true });
writeFileSync(join(here, "build", "contracts.json"), JSON.stringify(slim));

const common = {
  bundle: true,
  absWorkingDir: here,
  // One copy of ethers for the demo and for the shared modules in ../lib and ../offchain.
  alias: { ethers: "./node_modules/ethers" },
  // Only used by Hardhat-specific code paths that the demo never calls.
  external: ["hardhat", "@nomicfoundation/hardhat-network-helpers"],
  loader: { ".json": "json" },
  logLevel: "warning",
  legalComments: "none",
};

const target = process.argv[2] ?? "browser";
if (target === "node") {
  await build({ ...common, entryPoints: [join(here, "test", "run-replay.mjs")], platform: "node", format: "esm", outfile: join(here, "build", "run-replay.bundle.mjs"), banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } });
} else {
  await build({ ...common, entryPoints: [join(here, "src", "app.js")], platform: "browser", format: "iife", target: ["es2020"], minify: true, sourcemap: false, outfile: join(root, "docs", "assets", "demo.js") });
}
console.log(`built (${target})`);
