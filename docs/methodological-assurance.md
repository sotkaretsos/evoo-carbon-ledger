# Methodological status and limitation flags

`Certificate.status` is the procedural status: `Valid` means that the approved result matches the current ledger revisions and cites a usable factor set; it changes to `Outdated` after a correction and to `FactorSetRetired` when the factor set is withdrawn. The methodological status is recorded separately and is not changed by approval.

| Code | Methodological status | Meaning |
|---|---|---|
| 0 | Unassessed | The methodology of the result has not been assessed. Synthetic process examples use this status. |
| 1 | AggregateLimited | The recorded inputs of every farm scope match the reference input pattern of each group intensity, or scale it proportionally. |
| 2 | NeedsRecalculation | An input quantity or material code differs from the reference pattern; a process-level recalculation is required. |

## Factor-set policy

`FactorRegistry.propose` takes a `MethodPolicy { minimumStatus, requiredLimitations }` that cannot be changed after the proposal. Factor set `FS-2026-RECON-01` (version 2) requires minimum status 1 and the limitation flags 9 (AggregateProxy and UncertaintyUnquantified). `CarbonCertification.submitResult` rejects an `Unassessed` result for this factor set, missing mandatory flags, zero flags and a zero assessment hash. Approval preserves the declared status, flags and assessment hash; a result can be approved while `NeedsRecalculation` remains visible.

`ResultInput` and the public certificate contain `methodologicalStatus:uint8`, `limitationFlags:uint32` and `assessmentHash:bytes32`, and the certificate exposes

```
methodologicalCommitment = keccak256(abi.encode(
    reportHash, methodologicalStatus, limitationFlags, assessmentHash
))
```

`verifyMethodologicalDisclosure(report, certificate)` checks the report hash, assessment hash, status, flags and commitment; the browser replay runs this check after approval.

| Bit | Limitation flag | Meaning |
|---|---|---|
| 1 | AggregateProxy | Group-level intensity instead of process-level factors |
| 2 | SourceCoverageUnverified | Process coverage of an intensity not decomposed |
| 4 | GwpBasisUnspecified | GWP basis not specified |
| 8 | UncertaintyUnquantified | No quantitative uncertainty interval |
| 16 | SeparateModulesUnharmonized | Process modules not harmonized |
| 32 | EstimatedActivityInput | At least one input with source class Estimate |
| 64 | ReportedActivityInput | At least one operator entry or invoice |
| 128 | CalibrationMismatch | Inputs outside the applicability domain |
| 256 | MaterialIdentityMismatch | Missing or different material code |
| 512 | UnassessedMethodology | Methodology not assessed |
| 1024 | SyntheticProcessExample | Synthetic process example |

The case result is `AggregateLimited` with flags 73 (AggregateProxy, UncertaintyUnquantified and ReportedActivityInput). Mill electricity (5000 kWh) and oil output (8894 L) are signed meter readings; the other 38 records are operator entries. An event with `uncertaintyPermille = 0` has no specified uncertainty, and the assessment declares `uncertaintyDistribution = notProvided`.

## Applicability domain

A group intensity applies to the input pattern from which it was derived. The calculation service checks every complete farm scope against the reference pattern of each group before the farm burden is allocated to lots, so offsetting changes in a mixed batch cannot cancel out. The contracts enforce the factor-set policy and store the declared status; they do not recompute the applicability check. In the code, the reference patterns are named `calibratedAggregates`.

| Group | Reference input pattern per hectare | Admissible change |
|---|---|---|
| Fertilization | principal fertilizer 562.5 kg (`NPK_21_7_14_PLAIN`); foliar fertilizer 1.0417 kg (`NPK_20_20_20`); foliar diesel 8.357 L; spray water 0.208 m3 | common proportional change of all four inputs |
| Plant protection | copper oxychloride 1.625 kg; pyrethroid 0.0625 kg; diesel 12.5 L; spray water 0.3125 m3 | none |

A change of an individual input, a missing input or a missing or different material code returns `NeedsRecalculation` with flag 128 (and 256 for material codes). Quantities are compared with a tolerance of 0.0005 of the governed unit per recorded event, which corresponds to the ledger quantization of 0.001.

Event schema version 2 carries an optional `materialCode:bytes32`, covered by the envelope hash and the device signature. Activity and fuel combinations without a rule in the factor set are rejected by the calculation service.
