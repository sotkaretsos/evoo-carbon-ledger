# EVOO Carbon Ledger 1.3.0

Supplementary File S1 of *An IoT-Ready Blockchain Architecture for Auditable Carbon Footprint Traceability in Extra Virgin Olive Oil* (*Blockchains*). The release contains the smart contracts, the off-chain calculation service, the tests, the case-study replay and its reports, the controlled experiment with its checker, the robustness and security evaluation added in release 1.3.0 and the browser demonstration. The contracts are unchanged from release 1.2.0. The SHA-256 checksums of all files are listed in `SHA256SUMS`; the release is tagged `v1.3.0` in the repository.

## Contents

| Folder | Content |
|---|---|
| `contracts/` | Consortium, FactorRegistry, EvidenceRegistry, CarbonTraceability and CarbonCertification contracts and the EnvelopeValidation library (Solidity 0.8.28) |
| `offchain/` | Calculation service (`lca-engine.js`), methodological assessment, case inventory and factor set FS-2026-RECON-01 |
| `lib/`, `scripts/` | Deployment, replay, evaluation, scaling, input validation, mutation analysis, fault injection and Besu benchmarks |
| `test/` | Requirement, edge-case, regression, methodological-status, case-study and role-restriction tests |
| `reports/` | Test, coverage, mutation, fault-injection, static-analysis, gas, scaling, replay and calculation reports |
| `experiments/controlled-audit/` | Controlled experiment: synthetic evidence, ledger run, Python checker and its fault injection |
| `experiments/uncertainty/` | Monte Carlo uncertainty analysis of the case footprint |
| `demo/`, `docs/` | Browser demonstration (source and built site) and documentation |
| `besu/` | Four-validator Hyperledger Besu QBFT network configuration, validator-failure experiment and the Windows scripts of the measured run |

## Case study

The replay enters the farm and mill records of a 4.8 ha Koroneiki orchard in Western Achaia, Greece (means of the 2022–2024 seasons: 45,000 kg of olives and 8894 L of oil), as one season with ten harvest lots of 4500 kg and one mill batch. Mill electricity (5000 kWh) and oil output are signed readings of calibrated mill meters; the farm and other mill records are operator entries with document references. Dates, document identifiers and device keys were generated for the replay.

Factor set FS-2026-RECON-01 contains the diesel, petrol and grid-electricity factors and the fertilization and plant-protection group intensities of the reference assessment. The unallocated result is 3400.5 kg CO2eq/ha, or 1.835 kg CO2eq/L (reported as 1.84); economic and wet-mass allocation give 1.78 and 0.36 kg CO2eq/L.

## Certificate status

The certificate records the procedural status (`Valid`, `Outdated`, `FactorSetRetired`) separately from the methodological status:

| Methodological status | Meaning |
|---|---|
| `Unassessed` | The methodology of the result has not been assessed. |
| `AggregateLimited` | The inputs of every farm scope match the reference input pattern of each group intensity or scale it proportionally (applicability domain). |
| `NeedsRecalculation` | An input quantity or material code differs from the reference pattern; a process-level recalculation is required. |

The case result is `AggregateLimited` with limitation flags 73. See [methodological status](docs/methodological-assurance.md).

## Results

| Evaluation | Result |
|---|---|
| Tests | 115 passing (107 in release 1.2.0) |
| Solidity coverage | statements, functions and lines 100%; branches 88.03% (83.61% in release 1.2.0) |
| Safeguard removals (mutation check) | 10/10 detected |
| Systematic mutation analysis | 146/146 mutants killed (129/146 with the 107 tests of release 1.2.0) |
| Randomized fault injection, contracts | 2936/2936 faults of 27 classes detected in 50 random supply chains; 0 of 4645 valid operations rejected |
| Randomized fault injection, checker | 1200/1200 faults of 12 classes detected; 0 false alarms in 100 controls |
| Static analysis (Slither 0.11.6) | no high-impact finding; 8 medium, 9 low, 3 informational, none exploitable |
| Case replay | 80 transactions, 15,015,970 gas, 40 events |
| Replay footprint | 28,224 B calldata, 32,512 B logs, 430 new 32-byte storage slots |
| Deployment | 10,327,115 gas; largest contract 22,157 bytes (90.2% of the EIP-170 limit) |
| Batch scaling (1–64 lots) | createBatch +56,539 gas per lot; submitResult and approveResult +7494 gas per lot |
| Batch scaling beyond the cap (cap raised for the test) | linear to 520 lots (29.8 Mgas); 524 lots exceed the 30 Mgas block gas limit |
| QBFT network, 4 validators (Besu 26.11.1, one host) | median latency 2.05 s; 100 back-to-back records in one block; continues with 3 validators (max latency 6.1 s), halts with 2, resumes 254 s after quorum is restored; no record lost |
| Monte Carlo (100,000 samples) | median 1.95 kg CO2eq/L, 95% interval 1.59–2.34 with irrigation; 1.85 (1.49–2.22) without |
| Controlled experiment | 54/54 reconstruction checks, 112/112 commitment checks, 6/6 predeclared cases, 8/8 checker tests |
| Browser replay (Node) | 11/11 rule checks; gas totals within the 512-gas tolerance of the Hardhat replay |

## Reproduce

Node.js 22 or later; Python 3.10 or later for the checker.

```text
npm ci
npm test
npm run coverage
npm run compile -- --force
npm run evaluate
npm run validate:inputs
node scripts/mutation-check.js
npm run fault-injection
npm run mutation:systematic
npm run uncertainty
python experiments/controlled-audit/fault-injection-checker.py
```

Coverage instruments the contracts; compile again with `--force` before measuring bytecode or generating reports. The mutation check restores the sources and recompiles. The controlled experiment is run as described in [its documentation](docs/controlled-audit-experiment.md). For the demonstration, run `npm ci`, `npm run build` and `npm run test:node` in `demo/`; the built site is in `docs/`.

## Documentation

- [Methodological status and applicability domain](docs/methodological-assurance.md)
- [Requirement mapping R1–R9](docs/requirements-mapping.md)
- [Requirement sources and policy parameters](docs/requirements-provenance.md)
- [Controlled experiment](docs/controlled-audit-experiment.md)
- [Robustness and security evaluation (release 1.3.0)](docs/robustness-evaluation.md)
- [Comparison with a signed central log](docs/governance-comparison.md)
- [Related carbon-accounting systems](docs/related-work-evidence.json)
- [Besu QBFT network](besu/README.md)

## License

Project code is [MIT licensed](LICENSE). Bundled dependencies retain their own licenses; see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) and, for the demonstration, [docs/THIRD_PARTY_NOTICES.txt](docs/THIRD_PARTY_NOTICES.txt).
