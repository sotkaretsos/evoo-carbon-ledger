// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Roles} from "./Roles.sol";
import {IConsortium} from "./interfaces/IConsortium.sol";
import {IFactorRegistry} from "./interfaces/IFactorRegistry.sol";

/// @title FactorRegistry
/// @notice Governed, versioned registry of emission-factor sets (requirement R5).
/// @dev The factor values themselves are kept off-chain; the registry stores the hash of the
///      factor-set document, its validity period, GWP basis and approval status. A factor
///      set must be proposed and approved by two different accounts (separation of duties).
contract FactorRegistry is IFactorRegistry {
    enum Status {
        None,
        Proposed,
        Approved,
        Retired
    }

    struct FactorSet {
        bytes32 contentHash; // hash of the off-chain factor-set document
        bytes32 gwpBasis; // e.g. "GWP100-AR5"
        bytes32 supersedes; // previous factor set, if any
        uint64 validFrom;
        uint64 validTo;
        uint32 version;
        Status status;
        address proposer;
        address approver;
        MethodPolicy policy;
    }

    IConsortium public immutable consortium;
    mapping(bytes32 => FactorSet) private _sets;

    event FactorSetProposed(bytes32 indexed id, uint32 version, bytes32 contentHash, bytes32 gwpBasis, uint64 validFrom, uint64 validTo, bytes32 supersedes, address indexed proposer, MethodPolicy policy);
    event FactorSetApproved(bytes32 indexed id, address indexed approver);
    event FactorSetRetired(bytes32 indexed id, bytes32 reasonHash, address indexed by);

    error Unauthorized(address account);
    error InvalidArgument();
    error FactorSetExists(bytes32 id);
    error InvalidStatus(bytes32 id);
    error SeparationOfDuties();

    constructor(IConsortium consortium_) {
        consortium = consortium_;
    }

    function propose(
        bytes32 id,
        uint32 version,
        bytes32 contentHash,
        bytes32 gwpBasis,
        uint64 validFrom,
        uint64 validTo,
        bytes32 supersedes,
        MethodPolicy calldata policy
    ) external {
        if (!(consortium.isActiveWithRole(msg.sender, Roles.METHOD_AUTHORITY) || consortium.isActiveWithRole(msg.sender, Roles.LCA_SERVICE))) {
            revert Unauthorized(msg.sender);
        }
        if (id == bytes32(0) || contentHash == bytes32(0) || gwpBasis == bytes32(0) || validFrom >= validTo || version == 0 || policy.minimumStatus > 2) {
            revert InvalidArgument();
        }
        if (_sets[id].status != Status.None) revert FactorSetExists(id);
        _sets[id] = FactorSet({
            contentHash: contentHash,
            gwpBasis: gwpBasis,
            supersedes: supersedes,
            validFrom: validFrom,
            validTo: validTo,
            version: version,
            status: Status.Proposed,
            proposer: msg.sender,
            approver: address(0),
            policy: policy
        });
        emit FactorSetProposed(id, version, contentHash, gwpBasis, validFrom, validTo, supersedes, msg.sender, policy);
    }

    function approve(bytes32 id) external {
        if (!consortium.isActiveWithRole(msg.sender, Roles.METHOD_AUTHORITY)) revert Unauthorized(msg.sender);
        FactorSet storage f = _sets[id];
        if (f.status != Status.Proposed) revert InvalidStatus(id);
        if (f.proposer == msg.sender) revert SeparationOfDuties();
        f.status = Status.Approved;
        f.approver = msg.sender;
        emit FactorSetApproved(id, msg.sender);
    }

    function retire(bytes32 id, bytes32 reasonHash) external {
        if (!consortium.isActiveWithRole(msg.sender, Roles.METHOD_AUTHORITY)) revert Unauthorized(msg.sender);
        FactorSet storage f = _sets[id];
        if (f.status != Status.Approved && f.status != Status.Proposed) revert InvalidStatus(id);
        f.status = Status.Retired;
        emit FactorSetRetired(id, reasonHash, msg.sender);
    }

    function factorSetOf(bytes32 id) external view returns (FactorSet memory) {
        return _sets[id];
    }

    function methodologicalPolicy(bytes32 id) external view returns (MethodPolicy memory) {
        return _sets[id].policy;
    }

    /// @inheritdoc IFactorRegistry
    function isUsable(bytes32 id, uint64 at) external view returns (bool) {
        FactorSet storage f = _sets[id];
        return f.status == Status.Approved && at >= f.validFrom && at <= f.validTo;
    }

    /// @inheritdoc IFactorRegistry
    function isRetired(bytes32 id) external view returns (bool) {
        return _sets[id].status == Status.Retired;
    }
}
