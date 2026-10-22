# Gas, storage and ledger-footprint report

Generated 2026-10-21T15:04:27.490Z on the Hardhat EVM (London rules, zero gas price), solc 0.8.28 viaIR, optimizer 200 runs. Gas is a measure of computational and storage load; on a permissioned network with zero gas price it carries no fee.

## Case-study results computed from the ledger

| Result package | kg CO2eq per L EVOO | kg CO2eq per ha | Cultivation | Transport | Mill |
|---|---|---|---|---|---|
| v1 – FS-2026-RECON-01, 1 L EVOO (certified) | 1.8352 | 3400.5 | 1.6095 | 0.0299 | 0.1958 |
| Economic allocation (off-chain variant; 97.2% to oil) | 1.7842 | | | | |
| Wet-mass allocation (off-chain variant; 19.4% to oil at 0.916 kg/L) | 0.3557 | | | | |

Package declaring 1 kg EVOO as functional unit rejected with `FunctionalUnitMismatch` (reported oil output in liters).

Methodological status: **AggregateLimited**, limitation flags **73**. Mill electricity and oil output are signed meter readings; dates, document identifiers and device keys are replay fixtures.

## Certificate timeline

| Step | Date (chain time) | Status | Version | kg CO2eq per FU | Factor set | Functional unit |
|---|---|---|---|---|---|---|
| after submission of v1 (not yet approved) | 2025-03-20 | None | 0 | – | – | – |
| v1 approved | 2025-03-27 | Valid / AggregateLimited | 1 | 1.835188 | FS-2026-RECON-01 | EVOO_1L_MILL_GATE |

## Deployment

| Contract | Deployment gas | Runtime bytecode (bytes) | Share of EIP-170 limit |
|---|---|---|---|
| EnvelopeValidation | 523,942 | 2,179 | 8.9% |
| Consortium | 1,598,763 | 5,701 | 23.2% |
| FactorRegistry | 735,784 | 3,156 | 12.8% |
| EvidenceRegistry | 607,268 | 2,559 | 10.4% |
| CarbonTraceability | 4,927,183 | 22,157 | 90.2% |
| CarbonCertification | 1,934,175 | 8,607 | 35.0% |
| **Total** | **10,327,115** | | |

## Gas and footprint per operation (case-study replay)

| Operation | n | Gas (mean) | Gas (min–max) | Calldata (B) | Log (B) | New storage slots |
|---|---|---|---|---|---|---|
| Consortium.registerActor | 11 | 119,360 | 119,307–119,433 | 132 | 288 | 4 |
| Consortium.defineVariable | 16 | 80,425 | 75,842–120,609 | 228 | 256 | 2.2 |
| CarbonCertification.defineFunctionalUnit | 2 | 53,221 | 53,209–53,233 | 68 | 96 | 1 |
| Consortium.registerDevice | 4 | 120,500 | 120,455–120,527 | 100 | 160 | 4 |
| Consortium.recordCalibration | 4 | 58,491 | 58,455–58,539 | 100 | 160 | 1 |
| CarbonTraceability.registerOrchard | 1 | 102,570 | 102,570–102,570 | 100 | 192 | 3 |
| CarbonTraceability.recordFarmEvent | 25 | 203,399 | 202,570–220,054 | 484 | 576 | 6 |
| CarbonTraceability.registerLot | 10 | 134,168 | 134,157–134,169 | 164 | 224 | 4 |
| CarbonTraceability.initiateTransfer | 10 | 216,641 | 216,631–216,643 | 228 | 288 | 7 |
| CarbonTraceability.recordTransportEvent | 10 | 199,830 | 199,820–199,832 | 452 | 576 | 6 |
| CarbonTraceability.confirmReceipt | 10 | 106,095 | 106,087–106,099 | 292 | 192 | 1 |
| CarbonTraceability.createBatch | 1 | 770,103 | 770,103–770,103 | 836 | 192 | 28 |
| CarbonTraceability.recordMillEvent | 5 | 240,906 | 225,597–266,413 | 490 | 576 | 7.4 |
| CarbonTraceability.closeBatch | 1 | 106,283 | 106,283–106,283 | 68 | 160 | 1 |
| CarbonTraceability.closeFarmPhase | 1 | 43,262 | 43,262–43,262 | 68 | 192 | 0 |
| CarbonTraceability.verifyFarmPhase | 1 | 60,869 | 60,869–60,869 | 100 | 192 | 1 |
| FactorRegistry.propose | 1 | 151,725 | 151,725–151,725 | 292 | 352 | 5 |
| FactorRegistry.approve | 1 | 60,506 | 60,506–60,506 | 36 | 96 | 1 |
| EvidenceRegistry.register | 1 | 125,074 | 125,074–125,074 | 164 | 224 | 4 |
| CarbonCertification.submitResult | 1 | 562,283 | 562,283–562,283 | 580 | 704 | 18 |
| CarbonCertification.approveResult | 1 | 176,457 | 176,457–176,457 | 68 | 128 | 1 |

## Totals by act

| Act | Transactions | Gas | Calldata (B) | Log (B) | New slots (×32 B) |
|---|---|---|---|---|---|
| Consortium configuration | 37 | 3,422,160 | 6,036 | 8,736 | 101 (3,232 B) |
| Act 1 – 2024 season | 75 | 13,939,925 | 27,084 | 31,008 | 401 (12,832 B) |
| Act 2 – calculation and certification | 5 | 1,076,045 | 1,140 | 1,504 | 29 (928 B) |
| **Operational total (acts 1–2)** | **80** | **15,015,970** | **28,224** | **32,512** | **430 (13,760 B)** |

## Scaling with the number of lots per batch

| Lots | createBatch | closeBatch | submitResult | approveResult | getCertificate (view) |
|---|---|---|---|---|---|
| 1 | 269,521 | 106,211 | 494,660 | 109,002 | 85,507 |
| 4 | 435,975 | 106,199 | 517,123 | 131,465 | 107,970 |
| 16 | 1,101,700 | 106,199 | 606,982 | 221,336 | 197,841 |
| 64 | 3,831,475 | 106,211 | 966,752 | 581,094 | 557,599 |
| Marginal gas per lot | 56,539 | 0 | 7,494 | 7,494 | 7,494 |

## Scope

The figures above are execution-level measurements on the Hardhat EVM with London rules. Latency, finality and throughput on the four-validator Besu QBFT network are measured with `scripts/benchmark-latency.js` (see `besu/README.md`).
