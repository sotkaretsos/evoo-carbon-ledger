// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Data-source class of an observation (Appendix A, Table A1 of the article).
enum SourceClass {
    Sensor,
    Meter,
    Invoice,
    OperatorEntry,
    Estimate
}

/// Life-cycle phase of an activity event; equals the `phase` code of a governed variable.
enum Phase {
    None,
    Farm,
    Transport,
    Mill
}

/// Common event envelope (Section 2.8) supplied by the edge gateway or the operator.
struct EventInput {
    bytes32 activity; // business step, e.g. "FERTILISATION" (EPCIS bizStep)
    bytes32 variable; // governed variable code carrying unit and admissible range
    uint96 quantity; // milli-units of the variable's unit
    uint64 observedAt; // observation time (unix seconds)
    SourceClass source; // data-source class
    uint16 uncertaintyPermille; // declared relative uncertainty (data-quality flag); 0 = not declared
    bytes32 sourceId; // registered device (Sensor/Meter) or document identifier (Invoice)
    bytes32 evidenceHash; // hash of the off-chain evidence package
    bytes32 locationHash; // hash of the georeference (read point / business location)
    bytes32 methodCode; // measurement or estimation method
}

// Validation errors raised by {EnvelopeValidation} (requirements R1-R3).
error InvalidEnvelope();
error VariableInactive(bytes32 variable);
error WrongPhase(bytes32 variable);
error OutOfRange(bytes32 variable, uint256 quantity);
error FutureTimestamp(uint64 timestamp);
error MeterRequired(bytes32 variable);
error InvalidDevice(bytes32 deviceId);
error InvalidDeviceSignature(bytes32 deviceId);
error DocumentIdRequired();
