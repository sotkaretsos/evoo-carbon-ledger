# Gas, storage and ledger-footprint report

Generated 2026-10-14T13:24:16.991Z on the Hardhat EVM (London rules, zero gas price), solc 0.8.28 viaIR, optimizer 200 runs. Gas is a measure of computational and storage load; on a permissioned network with zero gas price it carries no fee.

## Case-study results computed from the ledger

| Result package | kg CO2eq per kg EVOO | kg CO2eq per ha | Cultivation | Transport | Mill |
|---|---|---|---|---|---|
| v1 – FS-2025-CONF (source calculation) | 1.9931 | 3693.1 | 1.6243 | 0.0299 | 0.3389 |
| v2 – FS-2026-01 (article) | 1.8352 | 3400.5 | 1.6095 | 0.0299 | 0.1958 |

Per-liter package of the source calculation rejected with `FunctionalUnitMismatch`. FS-2025-CONF on the corrected chain: “No rule for FIELD_PETROL_L in activity PRUNING under factor set FS-2025-CONF”.

## Certificate timeline

| Step | Date (chain time) | Status | Version | kg CO2eq/kg | Factor set |
|---|---|---|---|---|---|
| after submission of v1 (not yet approved) | 2025-03-20 | None | 0 | – | – |
| v1 approved | 2025-03-27 | Valid | 1 | 1.99311 | FS-2025-CONF |
| corrections proposed, pending authorization | 2026-06-15 | Valid | 1 | 1.99311 | FS-2025-CONF |
| corrections authorised | 2026-06-18 | Outdated | 1 | 1.99311 | FS-2025-CONF |
| FS-2025-CONF retired | 2026-06-22 | Outdated | 1 | 1.99311 | FS-2025-CONF |
| v2 approved | 2026-07-03 | Valid | 2 | 1.835206 | FS-2026-01 |

## Deployment

| Contract | Deployment gas | Runtime bytecode (bytes) | Share of EIP-170 limit |
|---|---|---|---|
| EnvelopeValidation | 521,764 | 2,169 | 8.8% |
| Consortium | 1,603,299 | 5,722 | 23.3% |
| FactorRegistry | 613,365 | 2,589 | 10.5% |
| EvidenceRegistry | 607,280 | 2,559 | 10.4% |
| CarbonTraceability | 4,738,745 | 21,285 | 86.6% |
| CarbonCertification | 1,598,060 | 7,050 | 28.7% |
| **Total** | **9,682,513** | | |

## Gas and footprint per operation (case-study replay)

| Operation | n | Gas (mean) | Gas (min–max) | Calldata (B) | Log (B) | New storage slots |
|---|---|---|---|---|---|---|
| Consortium.registerActor | 11 | 119,360 | 119,307–119,433 | 132 | 288 | 4 |
| Consortium.defineVariable | 16 | 80,443 | 75,853–120,665 | 228 | 256 | 2.2 |
| CarbonCertification.defineFunctionalUnit | 2 | 53,221 | 53,209–53,233 | 68 | 96 | 1 |
| Consortium.registerDevice | 4 | 120,497 | 120,455–120,527 | 100 | 160 | 4 |
| Consortium.recordCalibration | 4 | 58,488 | 58,443–58,539 | 100 | 160 | 1 |
| CarbonTraceability.registerOrchard | 1 | 102,572 | 102,572–102,572 | 100 | 192 | 3 |
| CarbonTraceability.recordFarmEvent | 25 | 202,998 | 202,175–219,801 | 452 | 544 | 6 |
| CarbonTraceability.registerLot | 10 | 134,148 | 134,137–134,149 | 164 | 224 | 4 |
| CarbonTraceability.initiateTransfer | 10 | 216,625 | 216,615–216,627 | 228 | 288 | 7 |
| CarbonTraceability.recordTransportEvent | 10 | 199,303 | 199,293–199,305 | 420 | 544 | 6 |
| CarbonTraceability.confirmReceipt | 10 | 106,077 | 106,069–106,081 | 292 | 192 | 1 |
| CarbonTraceability.createBatch | 1 | 772,440 | 772,440–772,440 | 836 | 192 | 28 |
| CarbonTraceability.recordMillEvent | 5 | 218,667 | 203,360–244,177 | 458 | 544 | 6.4 |
| CarbonTraceability.closeBatch | 1 | 88,053 | 88,053–88,053 | 68 | 160 | 1 |
| CarbonTraceability.closeFarmPhase | 1 | 43,242 | 43,242–43,242 | 68 | 192 | 0 |
| CarbonTraceability.verifyFarmPhase | 2 | 52,343 | 43,793–60,893 | 100 | 192 | 0.5 |
| FactorRegistry.propose | 2 | 138,067 | 128,063–148,071 | 228 | 288 | 4.5 |
| FactorRegistry.approve | 2 | 60,412 | 60,400–60,424 | 36 | 96 | 1 |
| EvidenceRegistry.register | 3 | 125,086 | 125,074–125,098 | 164 | 224 | 4 |
| CarbonCertification.submitResult | 2 | 458,017 | 450,649–465,384 | 388 | 512 | 13.5 |
| CarbonCertification.approveResult | 2 | 157,936 | 151,980–163,891 | 68 | 128 | 0.5 |
| CarbonTraceability.proposeCorrection | 2 | 297,348 | 297,324–297,372 | 452 | 736 | 10 |
| CarbonTraceability.authorizeCorrection | 2 | 65,930 | 65,930–65,930 | 36 | 160 | 0 |
| FactorRegistry.retire | 1 | 36,858 | 36,858–36,858 | 68 | 128 | 0 |

## Totals by act

| Act | Transactions | Gas | Calldata (B) | Log (B) | New slots (×32 B) |
|---|---|---|---|---|---|
| Consortium configuration | 37 | 3,422,426 | 6,036 | 8,736 | 101 (3,232 B) |
| Act 1 – 2024 season | 75 | 13,797,012 | 25,804 | 29,728 | 396 (12,672 B) |
| Act 2 – source-calculation result | 6 | 1,067,922 | 1,048 | 1,472 | 28 (896 B) |
| Act 3 – revisions of the article | 11 | 1,743,405 | 2,028 | 3,360 | 43 (1,376 B) |
| **Operational total (acts 1–3)** | **92** | **16,608,339** | **28,880** | **34,560** | **467 (14,944 B)** |

## Scaling with the number of lots per batch

| Lots | createBatch | closeBatch | submitResult | approveResult | getCertificate (view) |
|---|---|---|---|---|---|
| 1 | 269,779 | 87,981 | 397,809 | 96,436 | 82,612 |
| 4 | 436,926 | 87,969 | 420,272 | 118,899 | 105,075 |
| 16 | 1,105,423 | 87,969 | 510,143 | 208,770 | 194,946 |
| 64 | 3,846,286 | 87,981 | 869,901 | 568,528 | 554,704 |
| Marginal gas per lot | 56,770 | 0 | 7,494 | 7,494 | 7,494 |

## Not measured

Network latency, finality time and throughput of a multi-node Besu QBFT network were not measured; the figures above are execution-level measurements on a single in-process EVM with the same London rules.
