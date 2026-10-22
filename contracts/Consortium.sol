// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Roles} from "./Roles.sol";
import {IConsortium} from "./interfaces/IConsortium.sol";

/// @title Consortium
/// @notice Membership, device and measurement-variable registry of the permissioned consortium.
/// @dev Covers requirement R1 (attribution of each quantity to an actor and organisation),
///      R2 (device identity and calibration status) and the configuration needed for R3
///      (units and admissible ranges). Node-level permissioning is configured on the Besu
///      network itself; this contract implements account-level permissioning.
contract Consortium is AccessControl, IConsortium {
    struct Actor {
        bytes32 actorId; // pseudonymous identifier (hash of the off-chain identity record)
        bytes32 organisationId;
        bool active;
    }

    struct Device {
        bytes32 organisationId; // owning organisation
        address signer; // key used by the device or edge gateway to sign observations
        bytes32 accuracyClass;
        bytes32 calibrationCertHash; // hash of the off-chain calibration certificate
        uint64 calibratedUntil; // end of calibration validity (unix time)
        bool active;
    }

    mapping(address => Actor) private _actors;
    mapping(bytes32 => Device) private _devices;
    mapping(bytes32 => Variable) private _variables;
    bytes32[] private _mandatoryMillVariables;

    event ActorRegistered(address indexed account, bytes32 indexed actorId, bytes32 indexed organisationId, bytes32 role);
    event ActorStatusChanged(address indexed account, bool active);
    event DeviceRegistered(bytes32 indexed deviceId, bytes32 indexed organisationId, address signer, bytes32 accuracyClass);
    event CalibrationRecorded(bytes32 indexed deviceId, bytes32 certHash, uint64 calibratedUntil, address indexed certifier);
    event DeviceStatusChanged(bytes32 indexed deviceId, bool active);
    event VariableDefined(bytes32 indexed code, bytes8 unit, uint8 phase, bool meterRequired, bool mandatoryForClosure, uint128 minQuantity, uint128 maxQuantity);
    event VariableDeactivated(bytes32 indexed code);

    error NotActiveMember(address account);
    error UnknownActor(address account);
    error InvalidArgument();
    error DeviceExists(bytes32 deviceId);
    error UnknownDevice(bytes32 deviceId);
    error NotDeviceOwner(bytes32 deviceId);
    error AlreadyRegistered(address account);
    error InvalidRole(bytes32 role);

    constructor(address governor) {
        if (governor == address(0)) revert InvalidArgument();
        _grantRole(DEFAULT_ADMIN_ROLE, governor);
        _grantRole(Roles.GOVERNOR, governor);
        _setRoleAdmin(Roles.GOVERNOR, DEFAULT_ADMIN_ROLE);
        _setRoleAdmin(Roles.GROWER, Roles.GOVERNOR);
        _setRoleAdmin(Roles.TRANSPORTER, Roles.GOVERNOR);
        _setRoleAdmin(Roles.MILL, Roles.GOVERNOR);
        _setRoleAdmin(Roles.LCA_SERVICE, Roles.GOVERNOR);
        _setRoleAdmin(Roles.CERTIFIER, Roles.GOVERNOR);
        _setRoleAdmin(Roles.AUDITOR, Roles.GOVERNOR);
        _setRoleAdmin(Roles.METHOD_AUTHORITY, Roles.GOVERNOR);
        _actors[governor] = Actor({actorId: keccak256("GOVERNOR"), organisationId: keccak256("CONSORTIUM"), active: true});
    }

    // ------------------------------------------------------------------
    // Members (R1)
    // ------------------------------------------------------------------

    /// @notice Admits an account to the consortium and grants it one role.
    function registerActor(address account, bytes32 actorId, bytes32 organisationId, bytes32 role)
        external
        onlyRole(Roles.GOVERNOR)
    {
        if (account == address(0) || actorId == bytes32(0) || organisationId == bytes32(0)) revert InvalidArgument();
        if (_actors[account].actorId != bytes32(0)) revert AlreadyRegistered(account);
        if (!_isOperationalRole(role)) revert InvalidRole(role);
        _actors[account] = Actor({actorId: actorId, organisationId: organisationId, active: true});
        _grantRole(role, account);
        emit ActorRegistered(account, actorId, organisationId, role);
    }

    /// @notice Suspends or reinstates an account without erasing its history.
    function setActorActive(address account, bool active) external onlyRole(Roles.GOVERNOR) {
        if (_actors[account].actorId == bytes32(0)) revert UnknownActor(account);
        _actors[account].active = active;
        emit ActorStatusChanged(account, active);
    }

    function actorOf(address account) external view returns (Actor memory) {
        return _actors[account];
    }

    /// @inheritdoc IConsortium
    function isActiveWithRole(address account, bytes32 role) public view returns (bool) {
        return _actors[account].active && hasRole(role, account);
    }

    /// @inheritdoc IConsortium
    function isActive(address account) external view returns (bool) {
        return _actors[account].active;
    }

    /// @inheritdoc IConsortium
    function organisationOf(address account) external view returns (bytes32) {
        return _actors[account].organisationId;
    }

    // ------------------------------------------------------------------
    // Devices (R2)
    // ------------------------------------------------------------------

    /// @notice Registers a meter, sensor or weighbridge for the caller's organisation.
    function registerDevice(bytes32 deviceId, address signer, bytes32 accuracyClass) external {
        Actor storage a = _actors[msg.sender];
        if (!a.active) revert NotActiveMember(msg.sender);
        if (deviceId == bytes32(0) || signer == address(0)) revert InvalidArgument();
        if (_devices[deviceId].signer != address(0)) revert DeviceExists(deviceId);
        _devices[deviceId] = Device({
            organisationId: a.organisationId,
            signer: signer,
            accuracyClass: accuracyClass,
            calibrationCertHash: bytes32(0),
            calibratedUntil: 0,
            active: true
        });
        emit DeviceRegistered(deviceId, a.organisationId, signer, accuracyClass);
    }

    /// @notice Records a calibration certificate; only certification bodies may do so.
    function recordCalibration(bytes32 deviceId, bytes32 certHash, uint64 calibratedUntil)
        external
    {
        if (!isActiveWithRole(msg.sender, Roles.CERTIFIER)) revert NotActiveMember(msg.sender);
        Device storage d = _devices[deviceId];
        if (d.signer == address(0)) revert UnknownDevice(deviceId);
        if (certHash == bytes32(0)) revert InvalidArgument();
        d.calibrationCertHash = certHash;
        d.calibratedUntil = calibratedUntil;
        emit CalibrationRecorded(deviceId, certHash, calibratedUntil, msg.sender);
    }

    /// @notice Deactivates or reactivates a device (owning organisation or governor).
    function setDeviceActive(bytes32 deviceId, bool active) external {
        Device storage d = _devices[deviceId];
        if (d.signer == address(0)) revert UnknownDevice(deviceId);
        if (!(hasRole(Roles.GOVERNOR, msg.sender) || (_actors[msg.sender].active && _actors[msg.sender].organisationId == d.organisationId))) {
            revert NotDeviceOwner(deviceId);
        }
        d.active = active;
        emit DeviceStatusChanged(deviceId, active);
    }

    function deviceOf(bytes32 deviceId) external view returns (Device memory) {
        return _devices[deviceId];
    }

    /// @inheritdoc IConsortium
    /// @dev Returns the device signer only if the device is active, belongs to the given
    ///      organisation and is calibrated at time `at`; otherwise returns address(0).
    function deviceSignerIfValid(bytes32 deviceId, bytes32 organisationId, uint64 at)
        external
        view
        returns (address)
    {
        Device storage d = _devices[deviceId];
        if (!d.active || d.organisationId != organisationId || d.calibratedUntil < at) return address(0);
        return d.signer;
    }

    // ------------------------------------------------------------------
    // Measurement variables (R3)
    // ------------------------------------------------------------------

    /// @notice Defines or updates a measurement variable with its unit and admissible range.
    function defineVariable(
        bytes32 code,
        bytes8 unit,
        uint8 phase,
        bool meterRequired,
        bool mandatoryForClosure,
        uint128 minQuantity,
        uint128 maxQuantity
    ) external {
        if (!isActiveWithRole(msg.sender, Roles.METHOD_AUTHORITY)) revert NotActiveMember(msg.sender);
        if (code == bytes32(0) || unit == bytes8(0) || phase == 0 || phase > 3 || minQuantity == 0 || minQuantity > maxQuantity) {
            revert InvalidArgument();
        }
        // Mandatory presence and signed-meter provenance are distinct governed policies.
        // Reported/estimated case inputs may be mandatory without pretending to be measurements.
        if (mandatoryForClosure && phase != 3) revert InvalidArgument();
        bool wasMandatory = _variables[code].mandatoryForClosure && _variables[code].active;
        _variables[code] = Variable({
            unit: unit,
            phase: phase,
            meterRequired: meterRequired,
            mandatoryForClosure: mandatoryForClosure,
            active: true,
            minQuantity: minQuantity,
            maxQuantity: maxQuantity
        });
        if (mandatoryForClosure && !wasMandatory) _mandatoryMillVariables.push(code);
        if (!mandatoryForClosure && wasMandatory) _removeMandatory(code);
        emit VariableDefined(code, unit, phase, meterRequired, mandatoryForClosure, minQuantity, maxQuantity);
    }

    function deactivateVariable(bytes32 code) external {
        if (!isActiveWithRole(msg.sender, Roles.METHOD_AUTHORITY)) revert NotActiveMember(msg.sender);
        if (_variables[code].mandatoryForClosure) _removeMandatory(code);
        _variables[code].active = false;
        _variables[code].mandatoryForClosure = false;
        emit VariableDeactivated(code);
    }

    /// @inheritdoc IConsortium
    function getVariable(bytes32 code) external view returns (Variable memory) {
        return _variables[code];
    }

    /// @inheritdoc IConsortium
    function mandatoryMillVariables() external view returns (bytes32[] memory) {
        return _mandatoryMillVariables;
    }

    function _isOperationalRole(bytes32 role) private pure returns (bool) {
        return role == Roles.GROWER || role == Roles.TRANSPORTER || role == Roles.MILL || role == Roles.LCA_SERVICE
            || role == Roles.CERTIFIER || role == Roles.AUDITOR || role == Roles.METHOD_AUTHORITY;
    }

    function _removeMandatory(bytes32 code) private {
        uint256 n = _mandatoryMillVariables.length;
        for (uint256 i = 0; i < n; i++) {
            if (_mandatoryMillVariables[i] == code) {
                _mandatoryMillVariables[i] = _mandatoryMillVariables[n - 1];
                _mandatoryMillVariables.pop();
                return;
            }
        }
    }
}
