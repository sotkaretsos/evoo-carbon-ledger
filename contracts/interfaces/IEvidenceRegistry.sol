// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IEvidenceRegistry
interface IEvidenceRegistry {
    function isRetained(bytes32 evidenceHash, uint64 until, uint8 minReplicas) external view returns (bool);

    function lastCheckFailed(bytes32 evidenceHash) external view returns (bool);
}
