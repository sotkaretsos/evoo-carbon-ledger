// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IFactorRegistry
/// @notice Read interface of the governed emission-factor registry (requirement R5).
interface IFactorRegistry {
    struct MethodPolicy {
        uint8 minimumStatus; // 0 Unassessed, 1 AggregateLimited, 2 NeedsRecalculation; no validated class
        uint32 requiredLimitations;
    }

    /// @notice Irreducible methodological restrictions of the registered document.
    function methodologicalPolicy(bytes32 factorSetId) external view returns (MethodPolicy memory);
    /// @notice True if the factor set is approved and `at` lies within its validity window.
    function isUsable(bytes32 factorSetId, uint64 at) external view returns (bool);

    /// @notice True if the factor set has been withdrawn by the methodological authority.
    function isRetired(bytes32 factorSetId) external view returns (bool);
}
