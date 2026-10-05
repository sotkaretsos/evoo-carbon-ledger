// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IConsortium
/// @notice Read interface of the consortium registry used by the other contracts.
interface IConsortium {
    struct Variable {
        bytes8 unit; // unit of the recorded quantity, e.g. "kg", "L", "kWh"
        uint8 phase; // 1 = cultivation and harvesting, 2 = transport, 3 = mill processing
        bool meterRequired; // quantity must come from a registered sensor or meter
        bool mandatoryForClosure; // must be present before a mill batch can be closed
        bool active;
        uint128 minQuantity; // inclusive, in milli-units of `unit`
        uint128 maxQuantity; // inclusive, in milli-units of `unit`
    }

    function isActiveWithRole(address account, bytes32 role) external view returns (bool);

    function isActive(address account) external view returns (bool);

    function organisationOf(address account) external view returns (bytes32);

    function deviceSignerIfValid(bytes32 deviceId, bytes32 organisationId, uint64 at)
        external
        view
        returns (address signer);

    function getVariable(bytes32 code) external view returns (Variable memory);

    function mandatoryMillVariables() external view returns (bytes32[] memory);
}
