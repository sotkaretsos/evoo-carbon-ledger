"use strict";
// Methodological status and limitation flags are declared separately from procedural ledger validity.
const { MethodologicalStatus: Status, MethodologicalStatusName, hashJson, ethers, coder } = require("../lib/encoding");

const Limitation = {
  AggregateProxy: 1, SourceCoverageUnverified: 2, GwpBasisUnspecified: 4,
  UncertaintyUnquantified: 8, SeparateModulesUnharmonized: 16,
  EstimatedActivityInput: 32, ReportedActivityInput: 64,
  CalibrationMismatch: 128, MaterialIdentityMismatch: 256,
  UnassessedMethodology: 512, SyntheticProcessExample: 1024,
};

/** Assess each full farm scope against the reference input pattern of every group intensity
 * (its applicability domain) before allocating its share to lots and batches.
 */
function assessAggregate(fs, scopeId, areaHa, events) {
  return (fs.calibratedAggregates ?? []).map(cal => {
    const totals = cal.inputs.map(input => {
      const matches = events.filter(e => e.activity === input.activity && e.variable === input.variable);
      const quantity = matches.reduce((sum, e) => sum + e.quantity, 0);
      return { ...input, quantity, eventCount: matches.length,
        materialsMatch: !input.materialCode || (matches.length > 0 && matches.every(e => e.materialCode === input.materialCode)) };
    });
    const anchor = totals[0];
    const scale = cal.scaling === "common_proportional" ? anchor.quantity / (anchor.quantityPerHa * areaHa) : 1;
    const checks = totals.map(input => {
      const expectedQuantity = input.quantityPerHa * areaHa * scale;
      // Each recorded event is quantized to 0.001 of its governed unit (numerical tolerance).
      const tolerance = Math.max(input.eventCount, 1) * 0.0005 + 1e-9;
      const quantityMatches = input.eventCount > 0 && Math.abs(input.quantity - expectedQuantity) <= tolerance;
      return { ...input, expectedQuantity, residual: input.quantity - expectedQuantity, tolerance, quantityMatches };
    });
    const applicable = Number.isFinite(scale) && scale > 0 && checks.every(c => c.quantityMatches && c.materialsMatch);
    const materialMismatch = checks.some(c => !c.materialsMatch);
    return { scopeId, group: cal.group, areaHa, scaling: cal.scaling, scale, applicable,
      classification: applicable ? (Math.abs(scale - 1) < 1e-10 ? "calibrated_distribution" : "proportional_arithmetic_extrapolation") : "outside_calibration",
      materialMismatch, checks,
      interpretation: applicable ? "Inputs within the applicability domain of the group intensity." : "Inputs outside the applicability domain; process-level recalculation required." };
  });
}

function assessMethodology(fs, scopeAssessments, events) {
  let flags = fs.methodologicalPolicy?.requiredLimitations ?? Limitation.UnassessedMethodology;
  let status = fs.methodologicalPolicy?.minimumStatus ?? Status.Unassessed;
  flags |= Limitation.UncertaintyUnquantified;
  if (status === Status.Unassessed) flags |= Limitation.UnassessedMethodology;
  if (events.some(e => e.source === "Estimate")) flags |= Limitation.EstimatedActivityInput;
  if (events.some(e => ["OperatorEntry", "Invoice"].includes(e.source))) flags |= Limitation.ReportedActivityInput;
  const mismatch = scopeAssessments.some(s => !s.applicable);
  if (mismatch) { status = Status.NeedsRecalculation; flags |= Limitation.CalibrationMismatch; }
  if (scopeAssessments.some(s => s.materialMismatch)) flags |= Limitation.MaterialIdentityMismatch;
  if (!fs.calibratedAggregates?.length && status === Status.AggregateLimited) {
    status = Status.NeedsRecalculation;
    flags |= Limitation.CalibrationMismatch;
  }
  const details = {
    schema: "evoo-methodological-assessment/1", status: MethodologicalStatusName[status], statusCode: status,
    limitationFlags: flags, limitations: Object.entries(Limitation).filter(([, bit]) => (flags & bit) !== 0).map(([name]) => name),
    factorPolicy: fs.methodologicalPolicy ?? null,
    applicability: scopeAssessments,
    uncertainty: { quantitativeInterval: null, uncertaintyDistribution: "notProvided" },
    sourceQuality: { counts: events.filter(e => e.variable).reduce((a,e) => { a[e.source] = (a[e.source] ?? 0) + 1; return a; }, {}),
      electricity: events.filter(e => e.variable === "MILL_ELECTRICITY_KWH").map(e => ({ eventIndex: e.index, source: e.source, quantity: e.quantity, unit: "kWh" })),
    },
    numericalUse: mismatch ? "Recalculation required for the changed inputs." : "Within the applicability domain of the factor set.",
  };
  return { details, assessmentHash: hashJson(details), status, flags };
}

/** Verify a disclosed report against the public on-chain metadata (consistency and integrity). */
function verifyMethodologicalDisclosure(report, certificate) {
  const a = report.methodologicalAssessment;
  if (!a || hashJson(report) !== certificate.reportHash || hashJson(a) !== certificate.assessmentHash ||
      report.assessmentHash !== certificate.assessmentHash || a.statusCode !== Number(certificate.methodologicalStatus) ||
      a.status !== MethodologicalStatusName[a.statusCode] || a.limitationFlags !== Number(certificate.limitationFlags)) return false;
  const commitment = ethers.keccak256(coder.encode(["bytes32", "uint8", "uint32", "bytes32"],
    [certificate.reportHash, certificate.methodologicalStatus, certificate.limitationFlags, certificate.assessmentHash]));
  return certificate.methodologicalCommitment === commitment;
}

module.exports = { Limitation, assessAggregate, assessMethodology, verifyMethodologicalDisclosure };
