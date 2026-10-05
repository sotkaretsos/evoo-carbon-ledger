// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ICarbonTraceability
/// @notice Interface used by the certification contract to read the state of a mill batch.
interface ICarbonTraceability {
    // Envelope-validation errors raised through the linked {EnvelopeValidation} library; declared
    // here so that they are part of the traceability contract's ABI.
    error InvalidEnvelope();
    error VariableInactive(bytes32 variable);
    error WrongPhase(bytes32 variable);
    error OutOfRange(bytes32 variable, uint256 quantity);
    error MeterRequired(bytes32 variable);
    error DocumentIdRequired();

    /// @notice State of the record sets that feed a batch result.
    /// @return batchClosed       mill batch closed (mass balance and mandatory meter fields passed)
    /// @return farmPhasesClosed  every farm scope supplying the batch is closed
    /// @return farmPhasesVerified every farm scope supplying the batch is verified by a certifier
    /// @return digest            digest of the revision counters of the batch, its lots and farm scopes;
    ///                           it changes whenever a correction is applied to any of them
    function certificationStatus(bytes32 batchId)
        external
        view
        returns (bool batchClosed, bool farmPhasesClosed, bool farmPhasesVerified, bytes32 digest);

    /// @notice Governed code of the variable that records the batch's oil output (reference flow).
    function oilOutputVariable() external view returns (bytes32);
}
