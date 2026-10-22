// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Roles
/// @notice Role identifiers of the olive-oil carbon-traceability consortium.
/// @dev Roles are granted by the consortium governor in {Consortium}. They correspond to the
///      responsible roles of Table 3 of the article.
library Roles {
    /// Consortium governance (admission of members, role assignment).
    bytes32 internal constant GOVERNOR = keccak256("GOVERNOR_ROLE");
    /// Olive grower: orchard registration, farm activity events, harvest lots.
    bytes32 internal constant GROWER = keccak256("GROWER_ROLE");
    /// Transporter acting on behalf of the lot custodian.
    bytes32 internal constant TRANSPORTER = keccak256("TRANSPORTER_ROLE");
    /// Olive mill: lot reception, processing events, oil batches.
    bytes32 internal constant MILL = keccak256("MILL_ROLE");
    /// Authorised off-chain LCA calculation service.
    bytes32 internal constant LCA_SERVICE = keccak256("LCA_SERVICE_ROLE");
    /// Certification body / agronomist: phase verification, calibration records, result approval.
    bytes32 internal constant CERTIFIER = keccak256("CERTIFIER_ROLE");
    /// Independent auditor: authorises corrections and checks evidence retrieval.
    bytes32 internal constant AUDITOR = keccak256("AUDITOR_ROLE");
    /// Methodological authority: variable definitions, ranges, and emission-factor sets.
    bytes32 internal constant METHOD_AUTHORITY = keccak256("METHOD_AUTHORITY_ROLE");
}
