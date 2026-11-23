# Robustness and security evaluation (release 1.3.0)

Release 1.3.0 adds a robustness and security evaluation of the smart-contract layer and of the separately implemented checker. The contracts are those of release 1.2.0; the release adds tests, evaluation scripts and their reports. All results are on synthetic data and a local Hardhat EVM, except the four-validator Besu QBFT network experiment. Table S2 of the article gives the full results.

## Randomized fault injection on the contracts

`scripts/fault-injection.js` builds 50 random supply chains with a seeded generator (seed 20261123). Each run deploys the contracts on a fresh Hardhat EVM and generates 3–6 orchards of two grower organizations, 2–4 lots per orchard and mixed batches of 2–5 lots. Every valid operation of the chain is executed: orchard registration, farm records, lot registration, custody transfers with signed receipts, mixed batches with signed mill readings, batch and farm-phase closure, verification, a correction, factor-set approval, result submission and approval.

Faults of 27 classes are injected at random targets at the stage where each can occur (two per class and run; F12–F14 with a probability per lot, topped up to two). Each fault is evaluated in an EVM snapshot that is reverted afterwards. A fault is detected when the transaction reverts with the expected custom error (F27: the integrity check returns false). A residual class R01 records a false value inside the admissible range with its own evidence document, which contract logic accepts by design.

| Result | Value |
|---|---:|
| Supply chains / orchards / lots / batches / events | 50 / 222 / 663 / 196 / 1198 |
| Valid operations executed / rejected | 4645 / 0 |
| Faults injected / detected with the expected error | 2936 / 2936 |
| State invariants checked / violated | 1501 / 0 |
| Residual class R01: accepted | 100 of 100 |

Output: `reports/fault-injection.json`.

## Randomized fault injection on the checker

`experiments/controlled-audit/fault-injection-checker.py` applies 1200 single faults of 12 classes to the exported baseline state, claims and evidence of the controlled experiment and runs the checker of release 1.2.0 on the baseline case; 100 unmodified controls are included. File faults act on a temporary copy of the fixture and target the 28 evidence files referred to by the baseline state. All 1200 faults were detected with the expected issue code, and no control raised an alarm. Output: `experiments/controlled-audit/results/checker-fault-injection.json`.

## Systematic mutation analysis

`scripts/mutation-systematic.js` removes, one at a time, every single-line guard (113), every block guard (14) and every role modifier (19) of the five contracts and the validation library, and runs the full test suite against each of the 146 mutants. With the 107 tests of release 1.2.0, 129 mutants were killed. The 17 survivors were 14 role modifiers, the role check of the certification contract and two input checks of the consortium contract, which no test exercised on their own because organization or custody checks rejected the same calls first. `test/role-restrictions.test.js` (eight tests) calls each restricted function from a suspended account or from an account of the right organization with another role, and submits invalid governance inputs. With the 115 tests of release 1.3.0, all 146 mutants are killed, and branch coverage rose from 83.61% to 88.03%. Output: `reports/mutation-systematic.json` and `.txt`; the ten hand-selected mutations of release 1.2.0 remain in `reports/mutation-check.txt`.

## Static analysis

Slither 0.11.6 (102 detectors), third-party libraries excluded:

```text
slither . --hardhat-ignore-compile --filter-paths node_modules --exclude-dependencies --json reports/slither.json
```

No high-impact finding; 8 medium (exact comparisons of hashes or status values, zero-initialized sums, intentionally unused tuple elements), 9 low (block timestamps, a bounded loop over the governed mandatory variables) and 3 informational (complex functions). None is exploitable; the assessment of each finding is in Table S2 (sheet S2d).

## Batch scaling beyond the release cap

`scripts/scaling-extended.js` measures the batch operations for 64–528 lots on a build in which `MAX_LOTS_PER_BATCH` is raised from 64 to 4096 (experiment only), with an explicit gas limit of 30,000,000, the block gas limit of the Besu configuration. Batch creation grows linearly (56,867 gas per lot by least squares over 1–520 lots); 520 lots need 29.8 million gas and 524 lots exceed the limit. Output: `reports/scaling-extended.json`.

## Monte Carlo uncertainty analysis

`experiments/uncertainty/monte-carlo.py` (standard library only) propagates six uncertain inputs of the case footprint with 100,000 independent samples; the distributions are assumptions stated in the script and in Table S1, part 9. With irrigation electricity included: median 1.95 kg CO2eq/L, 95% interval 1.59–2.34; within the boundary of the baseline: 1.85 (1.49–2.22). Output: `experiments/uncertainty/results/monte-carlo.json`.

## Four-validator Besu QBFT network

`besu/fault-test.sh` runs `scripts/besu-phase.js` in five phases on the network of `besu/README.md`: all four validators, node 4 stopped, nodes 3 and 4 stopped (below quorum), node 3 restarted, node 4 restarted. Each phase records block production, transaction latency and inclusion, and whether transactions left pending by an earlier phase are included after recovery. Together with `scripts/benchmark-latency.js` (latency and throughput), the outputs are written to `reports/latency-besu.json` and `reports/besu-fault/`.

The measured run of release 1.3.0 (Besu 26.11.1, four validators on one Windows host, crash stops; details in `besu/README.md`): sequential records were included in the next block (median 2.05 s, maximum 2.09 s); 100 records submitted back to back were included in one block (20.2 Mgas, 67% of the block gas limit), with latencies set by the single submitting client (median 6.94 s). With validator 4 stopped, all 20 records were included (median 2.06 s, maximum 6.12 s). With validators 3 and 4 stopped, no block was produced for 60 s and the submitted record stayed pending. After validator 3 was restarted, block production resumed after 254 s, because the QBFT round-change timeout had doubled to 256 s during the halt, and the pending record was included in the first new block. After validator 4 was restarted, it synchronized and blocks again followed every 2 s. No record was lost or reverted.

## Reproduce

```text
npm ci
npm test                                   # 115 tests
npm run fault-injection                    # FI_RUNS, FI_ATTEMPTS, FI_SEED
npm run mutation:systematic                # about 2 h with solc-js
python3 experiments/controlled-audit/fault-injection-checker.py
npm run uncertainty
```
