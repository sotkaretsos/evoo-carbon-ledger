// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IFactorRegistry
/// @notice Read interface of the governed emission-factor registry (requirement R5).
interface IFactorRegistry {
    /// @notice True if the factor set is approved and `at` lies within its validity window.
    function isUsable(bytes32 factorSetId, uint64 at) external view returns (bool);

    /// @notice True if the factor set has been withdrawn by the methodological authority.
    function isRetired(bytes32 factorSetId) external view returns (bool);
}
