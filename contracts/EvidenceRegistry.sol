// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Roles} from "./Roles.sol";
import {IConsortium} from "./interfaces/IConsortium.sol";
import {IEvidenceRegistry} from "./interfaces/IEvidenceRegistry.sol";

/// @title EvidenceRegistry
/// @notice Retention metadata and retrieval log for off-chain evidence packages (requirement R9).
/// @dev Only hashes and identifiers are stored on-chain (requirement R8). An evidence package
///      is registered with its persistent identifier, repository, retention period and number
///      of replicas; auditors log periodic retrieval checks (hash re-computed off-chain).
contract EvidenceRegistry is IEvidenceRegistry {
    struct Evidence {
        address registrant;
        bytes32 persistentIdHash; // hash of the persistent identifier (e.g. handle, DOI or URI)
        bytes32 repositoryId;
        uint64 registeredAt;
        uint64 retentionUntil;
        uint8 replicas;
        uint64 lastCheckAt;
        bool lastCheckOk;
        uint32 failedChecks;
    }

    IConsortium public immutable consortium;
    mapping(bytes32 => Evidence) private _evidence;

    event EvidenceRegistered(bytes32 indexed evidenceHash, bytes32 persistentIdHash, bytes32 indexed repositoryId, uint64 retentionUntil, uint8 replicas, address indexed registrant);
    event RetentionExtended(bytes32 indexed evidenceHash, uint64 retentionUntil, uint8 replicas);
    event RetrievalChecked(bytes32 indexed evidenceHash, bool ok, address indexed auditor);

    error Unauthorized(address account);
    error InvalidArgument();
    error EvidenceExists(bytes32 evidenceHash);
    error UnknownEvidence(bytes32 evidenceHash);

    constructor(IConsortium consortium_) {
        consortium = consortium_;
    }

    function register(bytes32 evidenceHash, bytes32 persistentIdHash, bytes32 repositoryId, uint64 retentionUntil, uint8 replicas)
        external
    {
        if (consortium.organisationOf(msg.sender) == bytes32(0) || !consortium.isActive(msg.sender)) revert Unauthorized(msg.sender);
        if (evidenceHash == bytes32(0) || persistentIdHash == bytes32(0) || repositoryId == bytes32(0) || replicas == 0 || retentionUntil <= block.timestamp) {
            revert InvalidArgument();
        }
        if (_evidence[evidenceHash].registrant != address(0)) revert EvidenceExists(evidenceHash);
        _evidence[evidenceHash] = Evidence({
            registrant: msg.sender,
            persistentIdHash: persistentIdHash,
            repositoryId: repositoryId,
            registeredAt: uint64(block.timestamp),
            retentionUntil: retentionUntil,
            replicas: replicas,
            lastCheckAt: 0,
            lastCheckOk: true,
            failedChecks: 0
        });
        emit EvidenceRegistered(evidenceHash, persistentIdHash, repositoryId, retentionUntil, replicas, msg.sender);
    }

    function extendRetention(bytes32 evidenceHash, uint64 retentionUntil, uint8 replicas) external {
        Evidence storage e = _evidence[evidenceHash];
        if (e.registrant == address(0)) revert UnknownEvidence(evidenceHash);
        if (e.registrant != msg.sender) revert Unauthorized(msg.sender);
        if (retentionUntil < e.retentionUntil || replicas == 0) revert InvalidArgument();
        e.retentionUntil = retentionUntil;
        e.replicas = replicas;
        emit RetentionExtended(evidenceHash, retentionUntil, replicas);
    }

    /// @notice Records the outcome of an auditor's retrieval check (file retrieved and hash matched).
    function logRetrievalCheck(bytes32 evidenceHash, bool ok) external {
        if (!consortium.isActiveWithRole(msg.sender, Roles.AUDITOR)) revert Unauthorized(msg.sender);
        Evidence storage e = _evidence[evidenceHash];
        if (e.registrant == address(0)) revert UnknownEvidence(evidenceHash);
        e.lastCheckAt = uint64(block.timestamp);
        e.lastCheckOk = ok;
        if (!ok) e.failedChecks += 1;
        emit RetrievalChecked(evidenceHash, ok, msg.sender);
    }

    function evidenceOf(bytes32 evidenceHash) external view returns (Evidence memory) {
        return _evidence[evidenceHash];
    }

    /// @inheritdoc IEvidenceRegistry
    function isRetained(bytes32 evidenceHash, uint64 until, uint8 minReplicas) external view returns (bool) {
        Evidence storage e = _evidence[evidenceHash];
        return e.registrant != address(0) && e.retentionUntil >= until && e.replicas >= minReplicas && e.lastCheckOk;
    }

    /// @inheritdoc IEvidenceRegistry
    function lastCheckFailed(bytes32 evidenceHash) external view returns (bool) {
        Evidence storage e = _evidence[evidenceHash];
        return e.registrant != address(0) && !e.lastCheckOk;
    }
}
