// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Roles} from "./Roles.sol";
import {IConsortium} from "./interfaces/IConsortium.sol";
import {IFactorRegistry} from "./interfaces/IFactorRegistry.sol";
import {IEvidenceRegistry} from "./interfaces/IEvidenceRegistry.sol";
import {ICarbonTraceability} from "./interfaces/ICarbonTraceability.sol";

/// @title CarbonCertification
/// @notice LCA result packages, certifier approval and the public certificate of a mill batch.
/// @dev The carbon calculation is performed off-chain by an authorised LCA service. This contract
///      checks mandatory method metadata (R6), the factor-set version (R5), evidence retention (R9),
///      separation of duties and the revision state of the underlying event chain (R7) before a
///      result is recorded or approved (Section 2.5 and Table 3 of the article).
contract CarbonCertification {
    enum ResultStatus {
        None,
        Submitted,
        Approved,
        Superseded
    }

    enum CertificateStatus {
        None,
        Valid,
        Outdated,
        FactorSetRetired
    }

    /// A separate disclosure axis. None of these states asserts physical or scientific validation.
    enum MethodologicalStatus { Unassessed, AggregateLimited, NeedsRecalculation }

    /// LCA result package submitted by the off-chain LCA service.
    struct ResultInput {
        bytes32 boundaryCode;
        bytes32 functionalUnit;
        bytes32 allocationRule;
        bytes32 factorSetId;
        bytes32 engineVersion;
        bytes32 reportHash;
        bytes32 evidenceManifest;
        bytes32 expectedRevisionDigest;
        uint64 snapshotBlockNumber;
        bytes32 snapshotBlockHash;
        uint64[3] phaseMg; // mg CO2eq per functional unit: cultivation and harvesting, transport, mill
        uint64 totalMg;
        MethodologicalStatus methodologicalStatus;
        uint32 limitationFlags;
        bytes32 assessmentHash; // canonical off-chain methodological assessment, included in report
    }

    struct Result {
        ResultInput data;
        bytes32 revisionDigest;
        address submitter;
        address approver;
        uint64 submittedAt;
        uint64 approvedAt;
        ResultStatus status;
    }

    /// Public, selectively disclosed view of a certified batch (e.g. resolved from a QR code).
    struct Certificate {
        CertificateStatus status;
        uint32 version;
        uint64 totalMg;
        uint16[3] phaseSharePermille;
        bytes32 functionalUnit;
        bytes32 boundaryCode;
        bytes32 allocationRule;
        bytes32 factorSetId;
        bytes32 reportHash;
        uint64 approvedAt;
        address approver;
        bool evidenceCheckFailed;
        MethodologicalStatus methodologicalStatus;
        uint32 limitationFlags;
        bytes32 assessmentHash;
        bytes32 methodologicalCommitment; // binds public metadata to the report and assessment
    }

    IConsortium public immutable consortium;
    IFactorRegistry public immutable factorRegistry;
    IEvidenceRegistry public immutable evidenceRegistry;
    ICarbonTraceability public immutable traceability;

    uint8 public minEvidenceReplicas = 2;
    uint64 public minRetentionSeconds = 5 * 365 days;

    mapping(bytes32 => bytes8) private _functionalUnitUnit;
    mapping(bytes32 => uint32) private _resultCount;
    mapping(bytes32 => uint32) private _certifiedVersion;
    mapping(bytes32 => mapping(uint32 => Result)) private _results;

    event ParametersUpdated(uint8 minEvidenceReplicas, uint64 minRetentionSeconds);
    event FunctionalUnitDefined(bytes32 indexed code, bytes8 unit);
    event ResultSubmitted(bytes32 indexed batchId, uint32 indexed version, ResultInput result, bytes32 revisionDigest, address indexed lcaService);
    event ResultApproved(bytes32 indexed batchId, uint32 indexed version, address indexed certifier);

    error Unauthorized(address account);
    error InvalidArgument();
    error PhaseNotClosed(bytes32 batchId);
    error PhaseNotVerified(bytes32 batchId);
    error MissingField(uint8 field);
    error UnknownFunctionalUnit(bytes32 functionalUnit);
    error FunctionalUnitMismatch(bytes8 functionalUnitUnit, bytes8 outputUnit);
    error InconsistentTotal(uint64 sumOfPhases, uint64 total);
    error FactorSetNotUsable(bytes32 factorSetId);
    error EvidenceNotRetained(bytes32 evidenceHash);
    error InvalidStatus();
    error SeparationOfDuties();
    error StaleResult(bytes32 batchId, uint32 version);
    error RevisionMismatch(bytes32 expected, bytes32 actual);
    error InvalidSnapshot(uint64 blockNumber, bytes32 blockHash);
    error MethodologicalPolicyViolation();

    constructor(IConsortium consortium_, IFactorRegistry factorRegistry_, IEvidenceRegistry evidenceRegistry_, ICarbonTraceability traceability_) {
        consortium = consortium_;
        factorRegistry = factorRegistry_;
        evidenceRegistry = evidenceRegistry_;
        traceability = traceability_;
    }

    modifier onlyRole(bytes32 role) {
        if (!consortium.isActiveWithRole(msg.sender, role)) revert Unauthorized(msg.sender);
        _;
    }

    // ------------------------------------------------------------------
    // Governance
    // ------------------------------------------------------------------

    function setParameters(uint8 minEvidenceReplicas_, uint64 minRetentionSeconds_) external onlyRole(Roles.METHOD_AUTHORITY) {
        if (minEvidenceReplicas_ == 0) revert InvalidArgument();
        minEvidenceReplicas = minEvidenceReplicas_;
        minRetentionSeconds = minRetentionSeconds_;
        emit ParametersUpdated(minEvidenceReplicas_, minRetentionSeconds_);
    }

    /// @notice Declares a functional unit and the unit of its reference flow (requirement R6).
    function defineFunctionalUnit(bytes32 code, bytes8 unit) external onlyRole(Roles.METHOD_AUTHORITY) {
        if (code == bytes32(0) || unit == bytes8(0)) revert InvalidArgument();
        _functionalUnitUnit[code] = unit;
        emit FunctionalUnitDefined(code, unit);
    }

    // ------------------------------------------------------------------
    // LCA result packages
    // ------------------------------------------------------------------

    /// @notice Records an LCA result computed off-chain. Accepted only if the batch and its farm
    ///         phases are closed and the system boundary, functional unit, allocation rule,
    ///         factor-set version, engine version, report hash and evidence manifest are present
    ///         and valid. A newer submission supersedes an earlier unapproved one.
    function submitResult(bytes32 batchId, ResultInput calldata r) external onlyRole(Roles.LCA_SERVICE) returns (uint32 version) {
        (bool batchClosed, bool farmClosed,, bytes32 digest) = traceability.certificationStatus(batchId);
        if (!batchClosed || !farmClosed) revert PhaseNotClosed(batchId);
        if (r.boundaryCode == bytes32(0)) revert MissingField(1);
        if (r.functionalUnit == bytes32(0)) revert MissingField(2);
        if (r.allocationRule == bytes32(0)) revert MissingField(3);
        if (r.factorSetId == bytes32(0)) revert MissingField(4);
        if (r.engineVersion == bytes32(0)) revert MissingField(5);
        if (r.reportHash == bytes32(0)) revert MissingField(6);
        if (r.evidenceManifest == bytes32(0)) revert MissingField(7);
        bytes8 fuUnit = _functionalUnitUnit[r.functionalUnit];
        if (fuUnit == bytes8(0)) revert UnknownFunctionalUnit(r.functionalUnit);
        bytes8 outputUnit = consortium.getVariable(traceability.oilOutputVariable()).unit;
        if (fuUnit != outputUnit) revert FunctionalUnitMismatch(fuUnit, outputUnit);
        uint64 sum = r.phaseMg[0] + r.phaseMg[1] + r.phaseMg[2];
        if (sum != r.totalMg || r.totalMg == 0) revert InconsistentTotal(sum, r.totalMg);
        if (!factorRegistry.isUsable(r.factorSetId, uint64(block.timestamp))) revert FactorSetNotUsable(r.factorSetId);
        IFactorRegistry.MethodPolicy memory policy = factorRegistry.methodologicalPolicy(r.factorSetId);
        if (uint8(r.methodologicalStatus) < policy.minimumStatus || r.limitationFlags == 0 ||
            (r.limitationFlags & policy.requiredLimitations) != policy.requiredLimitations || r.assessmentHash == bytes32(0)) {
            revert MethodologicalPolicyViolation();
        }
        if (!evidenceRegistry.isRetained(r.evidenceManifest, uint64(block.timestamp) + minRetentionSeconds, minEvidenceReplicas)) {
            revert EvidenceNotRetained(r.evidenceManifest);
        }
        if (r.expectedRevisionDigest != digest) revert RevisionMismatch(r.expectedRevisionDigest, digest);
        // blockhash is available for the preceding 256 blocks. Recompute older packages.
        if (r.snapshotBlockNumber >= block.number || r.snapshotBlockHash == bytes32(0) || blockhash(r.snapshotBlockNumber) != r.snapshotBlockHash) {
            revert InvalidSnapshot(r.snapshotBlockNumber, r.snapshotBlockHash);
        }
        version = ++_resultCount[batchId];
        if (version > 1 && _results[batchId][version - 1].status == ResultStatus.Submitted) {
            _results[batchId][version - 1].status = ResultStatus.Superseded;
        }
        Result storage res = _results[batchId][version];
        res.data = r;
        res.revisionDigest = digest;
        res.submitter = msg.sender;
        res.submittedAt = uint64(block.timestamp);
        res.status = ResultStatus.Submitted;
        emit ResultSubmitted(batchId, version, r, digest, msg.sender);
    }

    /// @notice Certifier approval. Requires a different account from the submitter, verified farm
    ///         phases, an unchanged event chain since submission and a factor set still usable.
    function approveResult(bytes32 batchId, uint32 version) external onlyRole(Roles.CERTIFIER) {
        Result storage res = _results[batchId][version];
        if (res.status != ResultStatus.Submitted) revert InvalidStatus();
        if (res.submitter == msg.sender) revert SeparationOfDuties();
        (,, bool farmVerified, bytes32 digest) = traceability.certificationStatus(batchId);
        if (res.revisionDigest != digest) revert StaleResult(batchId, version);
        if (!farmVerified) revert PhaseNotVerified(batchId);
        if (!factorRegistry.isUsable(res.data.factorSetId, uint64(block.timestamp))) revert FactorSetNotUsable(res.data.factorSetId);
        if (!evidenceRegistry.isRetained(res.data.evidenceManifest, uint64(block.timestamp) + minRetentionSeconds, minEvidenceReplicas)) {
            revert EvidenceNotRetained(res.data.evidenceManifest);
        }
        uint32 previous = _certifiedVersion[batchId];
        if (previous != 0) _results[batchId][previous].status = ResultStatus.Superseded;
        res.status = ResultStatus.Approved;
        res.approver = msg.sender;
        res.approvedAt = uint64(block.timestamp);
        _certifiedVersion[batchId] = version;
        emit ResultApproved(batchId, version, msg.sender);
    }

    // ------------------------------------------------------------------
    // Public verification (R8)
    // ------------------------------------------------------------------

    /// @notice Selectively disclosed certificate of a batch: total, phase shares, method fields and
    ///         status. Raw activity data are not exposed. The status becomes Outdated as soon as a
    ///         correction is applied to any record set feeding the certified result.
    function getCertificate(bytes32 batchId) external view returns (Certificate memory cert) {
        uint32 version = _certifiedVersion[batchId];
        if (version == 0) return cert;
        Result storage res = _results[batchId][version];
        (,,, bytes32 digest) = traceability.certificationStatus(batchId);
        if (res.revisionDigest != digest) {
            cert.status = CertificateStatus.Outdated;
        } else if (factorRegistry.isRetired(res.data.factorSetId)) {
            cert.status = CertificateStatus.FactorSetRetired;
        } else {
            cert.status = CertificateStatus.Valid;
        }
        cert.version = version;
        cert.totalMg = res.data.totalMg;
        for (uint256 i = 0; i < 3; i++) {
            cert.phaseSharePermille[i] = uint16((uint256(res.data.phaseMg[i]) * 1000 + res.data.totalMg / 2) / res.data.totalMg);
        }
        cert.functionalUnit = res.data.functionalUnit;
        cert.boundaryCode = res.data.boundaryCode;
        cert.allocationRule = res.data.allocationRule;
        cert.factorSetId = res.data.factorSetId;
        cert.reportHash = res.data.reportHash;
        cert.approvedAt = res.approvedAt;
        cert.approver = res.approver;
        cert.evidenceCheckFailed = evidenceRegistry.lastCheckFailed(res.data.evidenceManifest);
        cert.methodologicalStatus = res.data.methodologicalStatus;
        cert.limitationFlags = res.data.limitationFlags;
        cert.assessmentHash = res.data.assessmentHash;
        cert.methodologicalCommitment = keccak256(abi.encode(cert.reportHash, cert.methodologicalStatus, cert.limitationFlags, cert.assessmentHash));
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function functionalUnitUnit(bytes32 code) external view returns (bytes8) {
        return _functionalUnitUnit[code];
    }

    function resultCount(bytes32 batchId) external view returns (uint32) {
        return _resultCount[batchId];
    }

    function certifiedVersion(bytes32 batchId) external view returns (uint32) {
        return _certifiedVersion[batchId];
    }

    function getResult(bytes32 batchId, uint32 version) external view returns (Result memory) {
        return _results[batchId][version];
    }
}
