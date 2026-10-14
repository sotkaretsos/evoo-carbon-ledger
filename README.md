# EVOO Carbon Ledger

Prototype smart contracts, off-chain LCA engine and evaluation for the article
*An IoT-Enabled Blockchain Architecture for Auditable Carbon Footprint Traceability in Extra
Virgin Olive Oil* by Sotirios Karetsos, Maria Stavropoulou, Constantina
Costopoulou and Konstantinos Demestichas (Informatics Laboratory, Agricultural University of
Athens). The same code is provided as Supplementary File S1 of the article.

The prototype implements the event model and smart-contract controls of the article for a
permissioned Ethereum-compatible ledger (Hyperledger Besu with QBFT consensus), and replays the
Western Achaia case study through them.

## Live demo

**https://sotkaretsos.github.io/evoo-carbon-ledger/**

The compiled contracts run in the browser on an in-memory EVM (EthereumJS, London rules, zero gas
price). The page replays the case study step by step, shows the public certificate as it changes,
and lets visitors try eleven rule-breaking attempts (wrong functional unit, forged meter
signature, duplicate envelope, out-of-range quantity, short delivery, self-approved factor set,
retired factor set, edits to a closed season, tampered evidence, unarchived evidence, non-member
writes), each on a snapshot that is rolled back afterwards. The in-browser replay reproduces the
transaction count and gas of the Hardhat replay exactly: 92 transactions and 16,608,363 gas for
the season, 9,682,513 gas for deployment. Source: `demo/`; built site: `docs/`.

## Contents

| Path | Content |
|---|---|
| `contracts/` | Solidity 0.8.28 contracts (London EVM rules) |
| `offchain/lca-engine.js` | Reference off-chain LCA calculation service |
| `offchain/factor-sets/` | Factor-set documents FS-2025-CONF (conference version) and FS-2026-01 (journal version) |
| `offchain/case-study/western-achaia.json` | Replay plan built from Tables 1–2 of the article and the source thesis |
| `lib/` | Encoding helpers, consortium catalogue, deployment, replay and gas/storage recorder |
| `test/` | 77 tests: requirement-mapped (R1–R9), edge cases and case-study replay |
| `scripts/` | Evaluation, scaling, deployment and network benchmark scripts |
| `reports/` | Generated results: gas report, scaling, replay results, LCA reports, test and coverage output |
| `besu/` | Four-validator QBFT network definition (not executed by the authors; see `besu/README.md`) |
| `docs/requirements-mapping.md` | Requirement-by-requirement mapping to functions, tests and residual risks |
| `demo/` | Source of the live demo: in-browser chain (`src/local-chain.js`), browser replay and rule-breaking attempts (`src/scenario.js`), page logic, build script |
| `docs/` | GitHub Pages site: the built live demo (`index.html`, `assets/`) |

## Architecture

| Contract | Responsibility | Requirements |
|---|---|---|
| `Consortium` | Members (pseudonymous actor IDs, organisations, roles), devices (signing key, accuracy class, calibration), governed variables (unit, phase, admissible range, meter requirement, mandatory closure fields) | R1, R2, R3 |
| `FactorRegistry` | Versioned emission-factor sets: content hash, GWP basis, validity window; proposal and approval by two different methodological-authority accounts; retirement | R5 |
| `EvidenceRegistry` | Evidence packages: persistent-identifier hash, repository, retention period, replicas, auditor retrieval checks | R8, R9 |
| `CarbonTraceability` | Farm events per orchard and crop year, harvest lots, dual-signature custody transfer, transport events, mill batches with mass balance and mixing rule, append-only corrections | R1–R4, R7, R8 |
| `CarbonCertification` | LCA result packages, method-field checks, certifier approval, public certificate | R5–R9 |
| `EnvelopeValidation` (library) | Envelope checks against the variable definition; device and calibration checks; EIP-191 signature verification | R1–R3 |

Every event carries the common envelope of Section 2.8: activity (business step), governed
variable (with its unit), quantity, observation time, source class, declared uncertainty, device or
document identifier, evidence hash, location hash, method code, actor and schema version. Fields
that later rules depend on are kept in contract storage; the whole envelope is emitted in the
`ActivityRecorded` log. Raw observations and documents stay off-chain.

The LCA calculation itself is off-chain (`offchain/lca-engine.js`): it reads the effective event
chain of a batch from the ledger, applies a registered factor set, and produces the result package,
the calculation report and the evidence manifest whose hashes are submitted on-chain.

## Case-study replay

`lib/replay.js` records the Western Achaia season (three-year average inventory replayed as crop
year 2024; ten illustrative harvest lots of 4500 kg) in three acts:

1. **Season 2024** – 25 farm events, 10 custody transfers with transport fuel and signed weighbridge
   readings, one mill batch with signed electricity and oil-scale readings and mill estimates.
2. **Conference version** – factor set FS-2025-CONF (all portable equipment as diesel, implied grid
   factor of about 0.60 kg CO2eq/kWh). The per-liter result package is rejected
   (`FunctionalUnitMismatch`: oil output was weighed in kg); the per-kg package is certified.
3. **Journal version** – the chainsaw and olive-beater fuel records are reclassified from diesel to
   petrol by two audited corrections (the certificate becomes `Outdated`), FS-2026-01 replaces
   FS-2025-CONF, and the recalculated result is certified.

| Result package | kg CO2eq/kg EVOO | kg CO2eq/ha | Article |
|---|---|---|---|
| v1, FS-2025-CONF | 1.993 | 3693.1 | conference version: 1.993 |
| v2, FS-2026-01 | 1.835 | 3400.5 | Table 5: 1.84 (1.835) and 3400.5 |
| v2, economic / wet-mass allocation (off-chain variants) | 1.78 / 0.38 | – | Table 7: 1.78 / 0.38 |

All six activity-group results of Table 5 are reproduced to within 0.05 kg CO2eq/ha.

## Measurements (Hardhat EVM, London rules)

Full tables: `reports/gas-report.md`, `reports/scaling.json`, `reports/transactions.csv`.

| Operation | Gas (mean) | New storage slots |
|---|---|---|
| Farm event, operator entry | 202,998 | 6 |
| Mill event, signed meter reading | 238,934–244,177 | 7 |
| Custody transfer (declaration + signed receipt) | 216,625 + 106,077 | 7 + 1 |
| Batch of 10 lots | 772,440 | 28 |
| Result submission / approval | 458,023 / 157,936 | 13.5 / 0.5 |
| Correction (proposal + authorization) | 297,348 + 65,930 | 10 + 0 |
| Deployment (five contracts and the library) | 9,682,513 | – |

The operational record of the whole season (92 transactions, from orchard registration to the
second certified result) used 16.6 Mgas, 14.9 kB of new contract storage, 28.9 kB of calldata and
34.6 kB of logs. Batch creation, result submission and approval grow approximately linearly with
the number of lots (56,770 gas per lot at batch creation; 7,494 gas per lot at submission and
approval), while batch closure does not depend on it. Network latency, finality and throughput on a multi-node QBFT network were **not**
measured; `scripts/benchmark-latency.js` measures them on such a network.

Tests: 77 passing; coverage 100% of statements, functions and lines and 82.3% of branches
(`reports/coverage-summary.txt`). Mutation check: removing any one of four safeguards (separation
of duties at approval, functional-unit check, envelope idempotency, verification reset) makes at
least one test fail (`reports/mutation-check.txt`).

## Usage

Requires Node.js 18 or later (tested with Node 22.22, npm 10.9).

```bash
npm ci
npm run compile          # solc 0.8.28 (solc-js), London, viaIR, optimizer 200 runs
npm test                 # 77 tests
npm run coverage
npm run evaluate         # scaling + case-study replay -> reports/
node scripts/mutation-check.js   # removes four safeguards one at a time
npm run deploy:besu      # see besu/README.md
npm run bench:besu
```

The compiler is taken from the `solc` npm package (solc-js), so compilation does not download
binaries.

Live demo (after `npm run compile` in the repository root):

```bash
cd demo
npm ci
npm run test:node        # replay + rule-breaking attempts in Node; compares gas with reports/
npm run build            # writes docs/assets/demo.js
python3 -m http.server --directory ../docs 8000   # then open http://localhost:8000
```

## Design limits

- Ledger logic attributes and constrains data but cannot prove that a physical measurement is
  true (oracle problem); device keys in the replay are test keys standing in for edge gateways.
- The off-chain LCA engine is trusted to compute correctly; the ledger fixes its inputs, factor
  set, report hash and approval, so that an auditor can recompute the result.
- Consortium members can read on-chain quantities; private transactions (e.g. Besu privacy
  groups) are not used. The governor is a single account in the prototype and should be a
  multi-signature or on-chain governance contract in a deployment.
- Contracts are not upgradeable; a new version would be deployed alongside the old one.
- The replay uses three-year average quantities split into illustrative events and lots; it
  demonstrates the mechanisms, not lot-specific claims.

## Versions

Solidity 0.8.28 (solc-js), Hardhat 2.29.1, hardhat-toolbox 5.0.0, ethers 6.17.0,
OpenZeppelin Contracts 5.6.1 (AccessControl, ECDSA).

## License

MIT. See `LICENSE`.
