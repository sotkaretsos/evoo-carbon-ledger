# Controlled experiment with mixed batches

The experiment tests whether the prototype preserves two orchard sources through unequal lots and mixed mill batches, and whether a separately implemented checker detects predefined evidence failures and reconstructs the numerical results. All observations, identities, products, process factors, calibration documents and signatures are synthetic.

The producer side uses the contracts and `computeBatchResult` of release 1.2.0 on the Hardhat EVM. A separate Python checker retrieves the evidence files, verifies their SHA-256 hashes and source identities, and reconstructs the process calculations with 50-digit Decimal arithmetic without importing the calculation engine. Keccak and ABI commitments are verified in a separate step with the ethers library.

## Design and process model

`design.json`, `factors.synthetic.json` and `expectations.json` in `experiments/controlled-audit/` declare the inputs, the process model and the expected case decisions before the producer runs; their SHA-256 digests are fixed in `evidence-index.json`.

| Source | Area (ha) | Harvest (kg) | Lots (kg) | Compound fertilizer (kg) | Foliar fertilizer (kg) | Field diesel (L) | Foliar diesel (L) | Irrigation electricity (kWh) |
|---|---:|---:|---|---:|---:|---:|---:|---:|
| Orchard A, grower A | 2 | 10,000 | A1: 3000; A2: 7000 | 400 | 10 | 100 | 20 | 200 |
| Orchard B, grower B | 3 | 15,000 | B1: 9000; B2: 6000 | 450 | 20 | 180 | 15 | 400 |

| Process parameter | Value |
|---|---|
| Compound fertilizer C20 | 0.20 kg N per kg; manufacture 1.12 kg CO2eq per kg |
| Foliar fertilizer F10 | 0.10 kg N per kg; manufacture 1.16 kg CO2eq per kg |
| Direct soil emissions | 0.01 kg N2O-N per kg N; 44/28 N2O-N to N2O; GWP100 of N2O set to 280 for the experiment |
| Diesel | 0.8 kg per L; 3 kg CO2 per kg |
| Electricity | 0.4 kg CO2eq per kWh |

The checker computes fertilizer manufacture and direct soil N2O separately (`product kg × N fraction × 0.01 × 44/28 × 280`), giving 1.12 + 0.88 = 2.00 kg CO2eq per kg of compound fertilizer and 1.16 + 0.44 = 1.60 kg CO2eq per kg of foliar fertilizer. The producer engine uses the combined coefficients, because its rule interface admits one coefficient per event.

## Evidence and allocation

The 29 JSON evidence files comprise two orchard declarations, four harvest and delivery records, 22 activity records and one corrected activity record. Each activity file states its scope, issuer, source class, source identifier, variable, quantity and unit; the SHA-256 hash of its exact bytes is the evidence hash recorded on the ledger. Growers A and B belong to different organisations.

| Mill batch | Input lots | Mixing shares (‰) | Electricity (kWh) | Diesel (L) | Oil (L) | Pomace (kg) |
|---|---|---|---:|---:|---:|---:|
| Batch 1 | A1 3000 kg + B1 9000 kg | 250 / 750 | 1200 | 5 | 2400 | 6000 |
| Batch 2 | A2 7000 kg + B2 6000 kg | 538 / 462 | 1000 | 6 | 2600 | 8000 |

Farm burdens are allocated by the fraction of each orchard's harvest that enters a batch: batch 1 receives 0.3 of orchard A and 0.6 of orchard B, and batch 2 the remaining 0.7 and 0.4. Economic allocation uses EUR 4 per L of oil and EUR 0.04 per kg of pomace; wet-mass allocation uses an oil density of 0.9 kg per L.

| Result | Cultivation (kg CO2eq) | Transport (kg CO2eq) | Mill (kg CO2eq) | Total (kg CO2eq) | kg CO2eq per L (unallocated) |
|---|---:|---:|---:|---:|---:|
| Batch 1 | 1291.2 | 33.6 | 492.0 | 1816.8 | 0.757 |
| Batch 2 | 1452.8 | 36.0 | 414.4 | 1903.2 | 0.732 |

The per-liter results are 0.757, 0.7385 and 0.2004 for batch 1 and 0.732, 0.7101 and 0.1657 for batch 2 (unallocated, economic and wet mass). The result package rounds each phase to mg CO2eq per functional unit and then sums the phases; the checker verifies both the analytical and the packaged values.

## Cases and outcomes

| Case | Controlled change | Decision | Detection |
|---|---|---|---|
| `baseline_complete` | Complete evidence and current claims | PASS | – |
| `missing_evidence` | Foliar invoice of orchard A removed | FAIL | `EVIDENCE_MISSING` |
| `corrupt_evidence` | Bytes appended to the electricity file of batch 1 | FAIL | `EVIDENCE_HASH_MISMATCH` |
| `corrected_quantity_stale_claim` | Authorized correction of the foliar diesel of orchard A from 20 to 30 L; previous claims checked | FAIL | `REVISION_MISMATCH`, `ARITHMETIC_MISMATCH` |
| `corrected_quantity_recomputed` | Recalculation and approval after the correction | PASS | – |
| `wrong_source_identity` | Correct invoice bytes of orchard A declared with the invoice identifier of orchard B | FAIL | `SOURCE_IDENTITY_MISMATCH` |

The correction adds 10 × 0.8 × 3 = 24 kg CO2eq to orchard A, of which 7.2 kg are allocated to batch 1 and 16.8 kg to batch 2 (new totals 1824.0 and 1920.0 kg CO2eq). Both certificates change from `Valid` to `Outdated` when the correction is authorized and return to `Valid` after the recalculated versions are approved; the original events and results remain in the history. The certificates carry the methodological status `Unassessed` with flag 1024 (SyntheticProcessExample).

## Results

- All six case decisions and detections match the predeclared expectations.
- The checker passes 54 checks of predeclaration, arithmetic, allocation, conservation, correction, certificate disclosure and case decisions.
- The commitment checker passes 112 Keccak/ABI checks of the report, manifest, factor-set, assessment and certificate commitments of the 18 batch and allocation claims.
- The eight checker tests pass; they perturb a published total, an exported quantity and the claim multiplicity, test the phase-rounding boundary and the source-mismatch detection, and confirm that the fertilizer reference arithmetic does not use the engine's combined coefficient.

The checker works on the exported ledger snapshots, registry entries and certificate captures; it does not query a live node or verify consensus proofs. Outputs are in `experiments/controlled-audit/results/`.

## Reproduction

Node.js 22 or later and Python 3.10 or later (standard library only). From the repository root:

```text
node node_modules/hardhat/internal/cli/cli.js compile
node node_modules/hardhat/internal/cli/cli.js run --no-compile experiments/controlled-audit/run-ledger.js
node experiments/controlled-audit/verify-commitments.js
python experiments/controlled-audit/verify-evidence.py
python experiments/controlled-audit/test-verifier.py
```

`prepare-evidence.py` generates the evidence files and their index; the committed files are used for verification.
