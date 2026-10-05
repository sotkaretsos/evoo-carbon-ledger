// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IConsortium} from "../interfaces/IConsortium.sol";
import "./EventTypes.sol";

/// @title EnvelopeValidation
/// @notice Stateless validation of event envelopes and device signatures (requirements R1-R3),
///         deployed once and linked by {CarbonTraceability}.
library EnvelopeValidation {
    uint64 internal constant MAX_CLOCK_SKEW = 300; // seconds tolerated between gateway and ledger clocks

    /// @notice Validates an envelope against the governed variable definition and, for sensor or
    ///         meter data, against the registered device and its calibration and signature.
    /// @param consortiumAddress address of the {Consortium} registry
    /// @param ledger         address of the recording contract (bound into the signed digest)
    /// @param phase          {Phase} code of the event
    /// @param organisationId organisation that must own the device
    /// @return envelope      hash of the scoped envelope, used for idempotency
    function validate(
        address consortiumAddress,
        address ledger,
        uint8 phase,
        bytes32 scopeId,
        bytes32 organisationId,
        EventInput calldata e,
        bytes calldata deviceSig
    ) external view returns (bytes32 envelope) {
        IConsortium consortium = IConsortium(consortiumAddress);
        IConsortium.Variable memory v = consortium.getVariable(e.variable);
        if (!v.active) revert VariableInactive(e.variable);
        if (v.phase != phase) revert WrongPhase(e.variable);
        if (e.quantity < v.minQuantity || e.quantity > v.maxQuantity) revert OutOfRange(e.variable, e.quantity);
        if (e.activity == bytes32(0) || e.observedAt == 0 || e.evidenceHash == bytes32(0)) revert InvalidEnvelope();
        if (e.observedAt > block.timestamp + MAX_CLOCK_SKEW) revert FutureTimestamp(e.observedAt);
        bool deviceSourced = e.source == SourceClass.Sensor || e.source == SourceClass.Meter;
        if (v.meterRequired && !deviceSourced) revert MeterRequired(e.variable);
        envelope = keccak256(abi.encode(scopeId, e));
        if (deviceSourced) {
            address signer = consortium.deviceSignerIfValid(e.sourceId, organisationId, e.observedAt);
            if (signer == address(0)) revert InvalidDevice(e.sourceId);
            // Observation digest signed by the device or edge gateway: chain, ledger, envelope.
            if (!isValidSignature(signer, keccak256(abi.encode(block.chainid, ledger, envelope)), deviceSig)) {
                revert InvalidDeviceSignature(e.sourceId);
            }
        } else if (e.source == SourceClass.Invoice && e.sourceId == bytes32(0)) {
            revert DocumentIdRequired();
        }
    }

    /// @notice EIP-191 ("\x19Ethereum Signed Message:\n32") signature check; never reverts.
    function isValidSignature(address signer, bytes32 digest, bytes calldata sig) public pure returns (bool) {
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(ethSigned, sig);
        return err == ECDSA.RecoverError.NoError && recovered == signer;
    }
}
