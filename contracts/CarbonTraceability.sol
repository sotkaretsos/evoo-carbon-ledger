// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Roles} from "./Roles.sol";
import {IConsortium} from "./interfaces/IConsortium.sol";
import {ICarbonTraceability} from "./interfaces/ICarbonTraceability.sol";
import {EnvelopeValidation} from "./lib/EnvelopeValidation.sol";
import {SourceClass, Phase, EventInput, FutureTimestamp, InvalidDevice, InvalidDeviceSignature} from "./lib/EventTypes.sol";

/// @title CarbonTraceability
/// @notice Operational record of phase-specific carbon traceability for extra virgin olive oil
///         (EVOO): farm activity events, dual-signature custody transfer of harvested lots,
///         transport events, mill batches and append-only corrections. LCA result packages and
///         certificates are handled by {CarbonCertification}.
/// @dev Raw observations and documents stay off-chain (Section 2.8 of the article). Contract
///      storage keeps only the fields that later rules depend on; the complete event envelope
///      is emitted in the transaction log.
contract CarbonTraceability is ICarbonTraceability {
    // ------------------------------------------------------------------
    // Constants and types
    // ------------------------------------------------------------------

    uint16 public constant SCHEMA_VERSION = 1;
    uint64 public constant MAX_CLOCK_SKEW = 300; // seconds tolerated between gateway and ledger clocks
    uint256 public constant MAX_LOTS_PER_BATCH = 64;
    bytes32 public constant MASS_PROPORTIONAL = "MASS_PROPORTIONAL";

    enum EventStatus {
        None,
        Effective,
        PendingReplacement,
        Superseded,
        Rejected
    }

    enum LotState {
        None,
        AtFarm,
        InTransit,
        AtMill,
        InBatch
    }

    enum CorrectionStatus {
        None,
        Pending,
        Applied,
        Rejected
    }

    /// Stored part of an activity event (fields used by later contract rules).
    struct ActivityEvent {
        bytes32 scopeId; // farm scope, harvest lot (transport) or mill batch
        bytes32 variable;
        bytes32 evidenceHash;
        uint96 quantity;
        uint64 observedAt;
        uint64 recordedAt;
        uint16 uncertaintyPermille;
        Phase phase;
        SourceClass source;
        EventStatus status;
        address actor;
        uint32 replaces;
        uint32 replacedBy;
    }

    struct Orchard {
        address grower;
        uint64 areaM2;
        bytes32 organisationId;
        bytes32 locationHash;
    }

    /// Farm scope = orchard x crop year (phase 1 record set, "Block 1").
    struct FarmScope {
        uint128 harvestedMassG;
        uint32 revision;
        uint32 eventCount;
        uint32 lotCount;
        bool closed;
        bool verified;
        bytes32 verificationReport;
    }

    struct Lot {
        bytes32 orchardId;
        bytes32 batchId;
        address custodian;
        uint128 harvestedMassG;
        uint128 receivedMassG;
        uint32 revision; // incremented when a transport event of the lot is corrected
        uint16 cropYear;
        LotState state;
    }

    /// Custody transfer record (phase 2, "Block 2").
    struct Transfer {
        address from;
        address to;
        address transporter;
        bytes32 vehicleHash;
        bytes32 evidenceHash;
        bytes32 weighbridgeId;
        uint128 declaredMassG;
        uint128 receivedMassG;
        uint64 distanceM;
        uint64 initiatedAt;
        uint64 weighedAt;
        uint64 confirmedAt;
    }

    /// Mill batch (phase 3, "Block 3").
    struct Batch {
        address mill;
        bytes32 organisationId;
        bytes32 mixingRule;
        uint128 receivedMassG; // sum of masses confirmed at custody transfer
        uint128 receptionMassG; // reception mass declared by the mill at closure
        uint128 oilOutputMilli; // sum of effective oil-output quantities (milli-units, i.e. g for kg)
        uint64 createdAt;
        uint64 closedAt;
        uint32 revision;
        bool closed;
    }

    struct Correction {
        uint32 eventIndex;
        uint32 replacementIndex;
        bytes32 reasonHash;
        address proposer;
        address authorizer;
        CorrectionStatus status;
    }

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    IConsortium public immutable consortium;

    // Governed parameters (methodological authority).
    uint16 public massToleranceBp = 100; // 1.00 %
    uint16 public minYieldPermille = 50; // 5.0 %
    uint16 public maxYieldPermille = 350; // 35.0 %
    bytes32 public oilOutputVariable = "OIL_OUTPUT_KG";

    ActivityEvent[] private _events; // index 0 is a sentinel
    Correction[] private _corrections; // index 0 is a sentinel

    mapping(bytes32 => bool) private _recordedEnvelopes;
    mapping(bytes32 => Orchard) private _orchards;
    mapping(bytes32 => FarmScope) private _farmScopes;
    mapping(bytes32 => Lot) private _lots;
    mapping(bytes32 => Transfer) private _transfers;
    mapping(bytes32 => Batch) private _batches;
    mapping(bytes32 => bytes32[]) private _batchLots;
    mapping(bytes32 => uint16[]) private _batchShares;
    mapping(bytes32 => mapping(bytes32 => bool)) private _batchMetered;

    // ------------------------------------------------------------------
    // Events (ledger log)
    // ------------------------------------------------------------------

    event ParametersUpdated(uint16 massToleranceBp, uint16 minYieldPermille, uint16 maxYieldPermille, bytes32 oilOutputVariable);
    event OrchardRegistered(bytes32 indexed orchardId, address indexed grower, bytes32 indexed organisationId, uint64 areaM2, bytes32 locationHash);
    event ActivityRecorded(uint32 indexed index, bytes32 indexed scopeId, Phase indexed phase, EventInput input, address actor, uint32 replaces, uint16 schemaVersion);
    event FarmPhaseClosed(bytes32 indexed orchardId, uint16 indexed cropYear, uint32 eventCount, uint128 harvestedMassG, address indexed by);
    event FarmPhaseVerified(bytes32 indexed orchardId, uint16 indexed cropYear, uint32 revision, bytes32 reportHash, address indexed certifier);
    event LotRegistered(bytes32 indexed lotId, bytes32 indexed orchardId, uint16 cropYear, uint128 harvestedMassG, bytes32 evidenceHash, address indexed grower);
    event TransferInitiated(bytes32 indexed lotId, address indexed from, address indexed to, address transporter, uint128 declaredMassG, uint64 distanceM, bytes32 vehicleHash, bytes32 evidenceHash);
    event TransferConfirmed(bytes32 indexed lotId, address indexed receiver, uint128 receivedMassG, bytes32 weighbridgeId, uint64 weighedAt);
    event TransferCancelled(bytes32 indexed lotId, address indexed by);
    event BatchCreated(bytes32 indexed batchId, address indexed mill, uint256 lotCount, bytes32 mixingRule, uint128 receivedMassG);
    event BatchClosed(bytes32 indexed batchId, uint128 receptionMassG, uint128 oilOutputMilli, uint32 yieldPermille);
    event CorrectionProposed(uint32 indexed correctionId, uint32 indexed eventIndex, uint32 replacementIndex, bytes32 reasonHash, address indexed proposer);
    event CorrectionApplied(uint32 indexed correctionId, uint32 indexed eventIndex, uint32 replacementIndex, address indexed authorizer);
    event CorrectionRejected(uint32 indexed correctionId, bytes32 reasonHash, address indexed authorizer);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error Unauthorized(address account);
    error InvalidArgument();
    error AlreadyExists(bytes32 id);
    error NotFound(bytes32 id);
    error PhaseClosed(bytes32 scopeId);
    error PhaseNotClosed(bytes32 scopeId);
    error DuplicateEvent(bytes32 envelopeHash);
    error InvalidLotState(bytes32 lotId);
    error MassMismatch(uint256 expected, uint256 actual);
    error MixingRuleRequired();
    error SharesMismatch();
    error MissingMandatoryVariable(bytes32 variable);
    error ImplausibleYield(uint32 yieldPermille);
    error InvalidStatus();
    error SeparationOfDuties();

    // ------------------------------------------------------------------
    // Construction and governance
    // ------------------------------------------------------------------

    constructor(IConsortium consortium_) {
        consortium = consortium_;
        _events.push();
        _corrections.push();
    }

    modifier onlyRole(bytes32 role) {
        if (!consortium.isActiveWithRole(msg.sender, role)) revert Unauthorized(msg.sender);
        _;
    }

    function setParameters(uint16 massToleranceBp_, uint16 minYieldPermille_, uint16 maxYieldPermille_, bytes32 oilOutputVariable_)
        external
        onlyRole(Roles.METHOD_AUTHORITY)
    {
        if (massToleranceBp_ > 1000 || minYieldPermille_ >= maxYieldPermille_ || maxYieldPermille_ > 1000 || oilOutputVariable_ == bytes32(0)) {
            revert InvalidArgument();
        }
        massToleranceBp = massToleranceBp_;
        minYieldPermille = minYieldPermille_;
        maxYieldPermille = maxYieldPermille_;
        oilOutputVariable = oilOutputVariable_;
        emit ParametersUpdated(massToleranceBp_, minYieldPermille_, maxYieldPermille_, oilOutputVariable_);
    }

    // ------------------------------------------------------------------
    // Phase 1: cultivation and harvesting
    // ------------------------------------------------------------------

    function registerOrchard(bytes32 orchardId, uint64 areaM2, bytes32 locationHash) external onlyRole(Roles.GROWER) {
        if (orchardId == bytes32(0) || areaM2 == 0) revert InvalidArgument();
        if (_orchards[orchardId].grower != address(0)) revert AlreadyExists(orchardId);
        bytes32 org = consortium.organisationOf(msg.sender);
        _orchards[orchardId] = Orchard({grower: msg.sender, areaM2: areaM2, organisationId: org, locationHash: locationHash});
        emit OrchardRegistered(orchardId, msg.sender, org, areaM2, locationHash);
    }

    /// @notice Appends a farm activity event (fertilisation, plant protection, fuel, irrigation...).
    /// @param deviceSig EIP-191 signature of the device or edge gateway; empty for non-device sources.
    function recordFarmEvent(bytes32 orchardId, uint16 cropYear, EventInput calldata e, bytes calldata deviceSig)
        external
        onlyRole(Roles.GROWER)
        returns (uint32 index)
    {
        bytes32 org = _requireOrchardMember(orchardId);
        if (cropYear == 0) revert InvalidArgument();
        bytes32 scopeId = farmScopeId(orchardId, cropYear);
        FarmScope storage s = _farmScopes[scopeId];
        if (s.closed) revert PhaseClosed(scopeId);
        index = _appendEvent(Phase.Farm, scopeId, org, e, deviceSig, 0, EventStatus.Effective);
        s.eventCount += 1;
    }

    /// @notice Registers a harvested lot; allowed only while the farm scope is open, so that the
    ///         harvested-mass basis used to allocate farm emissions to lots is final at closure.
    function registerLot(bytes32 lotId, bytes32 orchardId, uint16 cropYear, uint128 harvestedMassG, bytes32 evidenceHash)
        external
        onlyRole(Roles.GROWER)
    {
        _requireOrchardMember(orchardId);
        if (lotId == bytes32(0) || harvestedMassG == 0 || cropYear == 0 || evidenceHash == bytes32(0)) revert InvalidArgument();
        if (_lots[lotId].state != LotState.None) revert AlreadyExists(lotId);
        bytes32 scopeId = farmScopeId(orchardId, cropYear);
        FarmScope storage s = _farmScopes[scopeId];
        if (s.closed) revert PhaseClosed(scopeId);
        s.harvestedMassG += harvestedMassG;
        s.lotCount += 1;
        Lot storage l = _lots[lotId];
        l.orchardId = orchardId;
        l.custodian = msg.sender;
        l.harvestedMassG = harvestedMassG;
        l.cropYear = cropYear;
        l.state = LotState.AtFarm;
        emit LotRegistered(lotId, orchardId, cropYear, harvestedMassG, evidenceHash, msg.sender);
    }

    function closeFarmPhase(bytes32 orchardId, uint16 cropYear) external onlyRole(Roles.GROWER) {
        _requireOrchardMember(orchardId);
        bytes32 scopeId = farmScopeId(orchardId, cropYear);
        FarmScope storage s = _farmScopes[scopeId];
        if (s.closed) revert PhaseClosed(scopeId);
        if (s.eventCount == 0 || s.lotCount == 0) revert InvalidArgument();
        s.closed = true;
        emit FarmPhaseClosed(orchardId, cropYear, s.eventCount, s.harvestedMassG, msg.sender);
    }

    /// @notice Third-party verification of a closed farm phase (agronomist or inspection body).
    ///         A later correction of a farm event resets the verification.
    function verifyFarmPhase(bytes32 orchardId, uint16 cropYear, bytes32 reportHash) external onlyRole(Roles.CERTIFIER) {
        bytes32 scopeId = farmScopeId(orchardId, cropYear);
        FarmScope storage s = _farmScopes[scopeId];
        if (!s.closed) revert PhaseNotClosed(scopeId);
        if (reportHash == bytes32(0)) revert InvalidArgument();
        s.verified = true;
        s.verificationReport = reportHash;
        emit FarmPhaseVerified(orchardId, cropYear, s.revision, reportHash, msg.sender);
    }

    // ------------------------------------------------------------------
    // Phase 2: transport and custody transfer (dual signature)
    // ------------------------------------------------------------------

    /// @notice First signature of a custody transfer: the custodian declares the dispatched lot,
    ///         the receiving mill and, optionally, the transporter that will report fuel data.
    function initiateTransfer(
        bytes32 lotId,
        address to,
        address transporter,
        uint128 declaredMassG,
        uint64 distanceM,
        bytes32 vehicleHash,
        bytes32 evidenceHash
    ) external onlyRole(Roles.GROWER) {
        Lot storage l = _lots[lotId];
        if (l.state != LotState.AtFarm) revert InvalidLotState(lotId);
        if (msg.sender != l.custodian) revert Unauthorized(msg.sender);
        if (!consortium.isActiveWithRole(to, Roles.MILL)) revert InvalidArgument();
        if (transporter != address(0) && !consortium.isActiveWithRole(transporter, Roles.TRANSPORTER)) revert InvalidArgument();
        if (declaredMassG == 0 || distanceM == 0 || evidenceHash == bytes32(0)) revert InvalidArgument();
        if (!_withinTolerance(l.harvestedMassG, declaredMassG)) revert MassMismatch(l.harvestedMassG, declaredMassG);
        _transfers[lotId] = Transfer({
            from: msg.sender,
            to: to,
            transporter: transporter,
            vehicleHash: vehicleHash,
            evidenceHash: evidenceHash,
            weighbridgeId: bytes32(0),
            declaredMassG: declaredMassG,
            receivedMassG: 0,
            distanceM: distanceM,
            initiatedAt: uint64(block.timestamp),
            weighedAt: 0,
            confirmedAt: 0
        });
        l.state = LotState.InTransit;
        emit TransferInitiated(lotId, msg.sender, to, transporter, declaredMassG, distanceM, vehicleHash, evidenceHash);
    }

    /// @notice Transport activity event of a lot (fuel, telematics), reported by the transporter
    ///         or, if none was designated, by the sender.
    function recordTransportEvent(bytes32 lotId, EventInput calldata e, bytes calldata deviceSig) external returns (uint32 index) {
        Lot storage l = _lots[lotId];
        LotState st = l.state;
        if (!(st == LotState.InTransit || st == LotState.AtMill || (st == LotState.InBatch && !_batches[l.batchId].closed))) {
            revert InvalidLotState(lotId);
        }
        Transfer storage t = _transfers[lotId];
        address reporter = t.transporter == address(0) ? t.from : t.transporter;
        bytes32 role = t.transporter == address(0) ? Roles.GROWER : Roles.TRANSPORTER;
        if (msg.sender != reporter || !consortium.isActiveWithRole(msg.sender, role)) revert Unauthorized(msg.sender);
        index = _appendEvent(Phase.Transport, lotId, consortium.organisationOf(msg.sender), e, deviceSig, 0, EventStatus.Effective);
    }

    /// @notice Second signature: the receiving mill confirms the mass measured on its calibrated
    ///         weighbridge. Custody changes only if both declarations agree within the tolerance.
    function confirmReceipt(bytes32 lotId, uint128 receivedMassG, bytes32 weighbridgeId, uint64 weighedAt, bytes calldata weighbridgeSig)
        external
        onlyRole(Roles.MILL)
    {
        Lot storage l = _lots[lotId];
        Transfer storage t = _transfers[lotId];
        if (l.state != LotState.InTransit) revert InvalidLotState(lotId);
        if (msg.sender != t.to) revert Unauthorized(msg.sender);
        if (weighedAt > block.timestamp + MAX_CLOCK_SKEW || weighedAt + MAX_CLOCK_SKEW < t.initiatedAt) revert FutureTimestamp(weighedAt);
        address signer = consortium.deviceSignerIfValid(weighbridgeId, consortium.organisationOf(msg.sender), weighedAt);
        if (signer == address(0)) revert InvalidDevice(weighbridgeId);
        // Receipt digest signed by the weighbridge (EIP-191): chain, contract, lot, mass, time, device.
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), lotId, receivedMassG, weighedAt, weighbridgeId));
        if (!EnvelopeValidation.isValidSignature(signer, digest, weighbridgeSig)) {
            revert InvalidDeviceSignature(weighbridgeId);
        }
        if (!_withinTolerance(t.declaredMassG, receivedMassG)) revert MassMismatch(t.declaredMassG, receivedMassG);
        t.receivedMassG = receivedMassG;
        t.weighbridgeId = weighbridgeId;
        t.weighedAt = weighedAt;
        t.confirmedAt = uint64(block.timestamp);
        l.custodian = msg.sender;
        l.receivedMassG = receivedMassG;
        l.state = LotState.AtMill;
        emit TransferConfirmed(lotId, msg.sender, receivedMassG, weighbridgeId, weighedAt);
    }

    /// @notice Cancels an unconfirmed transfer; the lot returns to the sender's custody.
    function cancelTransfer(bytes32 lotId) external {
        Lot storage l = _lots[lotId];
        if (l.state != LotState.InTransit) revert InvalidLotState(lotId);
        if (msg.sender != _transfers[lotId].from) revert Unauthorized(msg.sender);
        l.state = LotState.AtFarm;
        emit TransferCancelled(lotId, msg.sender);
    }

    // ------------------------------------------------------------------
    // Phase 3: mill processing
    // ------------------------------------------------------------------

    /// @notice Forms a processing batch from received lots. Mixing several lots requires a declared
    ///         rule; under MASS_PROPORTIONAL the declared shares must match the received masses.
    function createBatch(bytes32 batchId, bytes32[] calldata lotIds, uint16[] calldata sharesPermille, bytes32 mixingRule)
        external
        onlyRole(Roles.MILL)
    {
        uint256 n = lotIds.length;
        if (batchId == bytes32(0) || n == 0 || n > MAX_LOTS_PER_BATCH || sharesPermille.length != n) revert InvalidArgument();
        if (_batches[batchId].mill != address(0)) revert AlreadyExists(batchId);
        if (n > 1 && mixingRule == bytes32(0)) revert MixingRuleRequired();
        uint256 shareSum;
        uint256 massSum;
        for (uint256 i = 0; i < n; i++) {
            Lot storage l = _lots[lotIds[i]];
            if (l.state != LotState.AtMill || l.custodian != msg.sender) revert InvalidLotState(lotIds[i]);
            shareSum += sharesPermille[i];
            massSum += l.receivedMassG;
        }
        if (shareSum != 1000) revert SharesMismatch();
        if (mixingRule == MASS_PROPORTIONAL) {
            for (uint256 i = 0; i < n; i++) {
                uint256 expected = (uint256(_lots[lotIds[i]].receivedMassG) * 1000 + massSum / 2) / massSum;
                uint256 s = sharesPermille[i];
                if ((s > expected ? s - expected : expected - s) > 1) revert SharesMismatch();
            }
        }
        for (uint256 i = 0; i < n; i++) {
            Lot storage l = _lots[lotIds[i]];
            l.state = LotState.InBatch;
            l.batchId = batchId;
        }
        Batch storage b = _batches[batchId];
        b.mill = msg.sender;
        b.organisationId = consortium.organisationOf(msg.sender);
        b.mixingRule = mixingRule;
        b.receivedMassG = uint128(massSum);
        b.createdAt = uint64(block.timestamp);
        _batchLots[batchId] = lotIds;
        _batchShares[batchId] = sharesPermille;
        emit BatchCreated(batchId, msg.sender, n, mixingRule, uint128(massSum));
    }

    function recordMillEvent(bytes32 batchId, EventInput calldata e, bytes calldata deviceSig)
        external
        onlyRole(Roles.MILL)
        returns (uint32 index)
    {
        Batch storage b = _batches[batchId];
        if (b.mill == address(0)) revert NotFound(batchId);
        if (consortium.organisationOf(msg.sender) != b.organisationId) revert Unauthorized(msg.sender);
        if (b.closed) revert PhaseClosed(batchId);
        index = _appendEvent(Phase.Mill, batchId, b.organisationId, e, deviceSig, 0, EventStatus.Effective);
        if (e.source == SourceClass.Sensor || e.source == SourceClass.Meter) _batchMetered[batchId][e.variable] = true;
        if (e.variable == oilOutputVariable) b.oilOutputMilli += e.quantity;
    }

    /// @notice Closes a batch when the input-lot mass balance and the mandatory meter fields pass.
    function closeBatch(bytes32 batchId, uint128 receptionMassG) external onlyRole(Roles.MILL) {
        Batch storage b = _batches[batchId];
        if (b.mill == address(0)) revert NotFound(batchId);
        if (consortium.organisationOf(msg.sender) != b.organisationId) revert Unauthorized(msg.sender);
        if (b.closed) revert PhaseClosed(batchId);
        if (receptionMassG == 0) revert InvalidArgument();
        bytes32[] memory mandatory = consortium.mandatoryMillVariables();
        for (uint256 i = 0; i < mandatory.length; i++) {
            if (!_batchMetered[batchId][mandatory[i]]) revert MissingMandatoryVariable(mandatory[i]);
        }
        if (!_withinTolerance(b.receivedMassG, receptionMassG)) revert MassMismatch(b.receivedMassG, receptionMassG);
        uint32 yieldPermille = uint32((uint256(b.oilOutputMilli) * 1000) / receptionMassG);
        if (yieldPermille < minYieldPermille || yieldPermille > maxYieldPermille) revert ImplausibleYield(yieldPermille);
        b.receptionMassG = receptionMassG;
        b.closed = true;
        b.closedAt = uint64(block.timestamp);
        emit BatchClosed(batchId, receptionMassG, b.oilOutputMilli, yieldPermille);
    }

    // ------------------------------------------------------------------
    // Append-only corrections (R7)
    // ------------------------------------------------------------------

    /// @notice Proposes the correction of an effective event. The replacement is validated with the
    ///         same rules as a new event and appended as a pending replacement; the original stays
    ///         effective until an auditor authorises the correction.
    function proposeCorrection(uint32 eventIndex, EventInput calldata replacement, bytes calldata deviceSig, bytes32 reasonHash)
        external
        returns (uint32 correctionId)
    {
        if (eventIndex == 0 || eventIndex >= _events.length || reasonHash == bytes32(0)) revert InvalidArgument();
        ActivityEvent storage orig = _events[eventIndex];
        if (orig.status != EventStatus.Effective) revert InvalidStatus();
        bytes32 org = consortium.organisationOf(msg.sender);
        if (org == bytes32(0) || !consortium.isActive(msg.sender) || org != consortium.organisationOf(orig.actor)) {
            revert Unauthorized(msg.sender);
        }
        uint32 replacementIndex = _appendEvent(orig.phase, orig.scopeId, org, replacement, deviceSig, eventIndex, EventStatus.PendingReplacement);
        correctionId = uint32(_corrections.length);
        _corrections.push(
            Correction({
                eventIndex: eventIndex,
                replacementIndex: replacementIndex,
                reasonHash: reasonHash,
                proposer: msg.sender,
                authorizer: address(0),
                status: CorrectionStatus.Pending
            })
        );
        emit CorrectionProposed(correctionId, eventIndex, replacementIndex, reasonHash, msg.sender);
    }

    /// @notice Applies a correction: the original event remains visible but is marked as superseded,
    ///         the replacement becomes effective and the affected scope's revision is incremented,
    ///         which outdates certificates computed from the earlier event chain.
    function authorizeCorrection(uint32 correctionId) external onlyRole(Roles.AUDITOR) {
        if (correctionId == 0 || correctionId >= _corrections.length) revert InvalidArgument();
        Correction storage c = _corrections[correctionId];
        if (c.status != CorrectionStatus.Pending) revert InvalidStatus();
        if (c.proposer == msg.sender) revert SeparationOfDuties();
        ActivityEvent storage orig = _events[c.eventIndex];
        ActivityEvent storage repl = _events[c.replacementIndex];
        if (orig.status != EventStatus.Effective) revert InvalidStatus();
        orig.status = EventStatus.Superseded;
        orig.replacedBy = c.replacementIndex;
        repl.status = EventStatus.Effective;
        bytes32 scopeId = orig.scopeId;
        if (orig.phase == Phase.Farm) {
            FarmScope storage s = _farmScopes[scopeId];
            s.revision += 1;
            s.verified = false; // verification must be renewed for the corrected record set
        } else if (orig.phase == Phase.Transport) {
            _lots[scopeId].revision += 1;
        } else {
            Batch storage b = _batches[scopeId];
            b.revision += 1;
            bytes32 oil = oilOutputVariable;
            if (orig.variable == oil) b.oilOutputMilli -= orig.quantity;
            if (repl.variable == oil) b.oilOutputMilli += repl.quantity;
            if (repl.source == SourceClass.Sensor || repl.source == SourceClass.Meter) _batchMetered[scopeId][repl.variable] = true;
            // A corrected oil output of a closed batch must still give a plausible yield.
            if (b.closed && (orig.variable == oil || repl.variable == oil)) {
                uint32 yieldPermille = uint32((uint256(b.oilOutputMilli) * 1000) / b.receptionMassG);
                if (yieldPermille < minYieldPermille || yieldPermille > maxYieldPermille) revert ImplausibleYield(yieldPermille);
            }
        }
        c.status = CorrectionStatus.Applied;
        c.authorizer = msg.sender;
        emit CorrectionApplied(correctionId, c.eventIndex, c.replacementIndex, msg.sender);
    }

    function rejectCorrection(uint32 correctionId, bytes32 reasonHash) external onlyRole(Roles.AUDITOR) {
        if (correctionId == 0 || correctionId >= _corrections.length) revert InvalidArgument();
        Correction storage c = _corrections[correctionId];
        if (c.status != CorrectionStatus.Pending) revert InvalidStatus();
        _events[c.replacementIndex].status = EventStatus.Rejected;
        c.status = CorrectionStatus.Rejected;
        c.authorizer = msg.sender;
        emit CorrectionRejected(correctionId, reasonHash, msg.sender);
    }

    // ------------------------------------------------------------------
    // Integrity verification (R8) and certification interface
    // ------------------------------------------------------------------

    /// @notice Checks whether a document presented off-chain matches the hash recorded for an event.
    function matchesEvidence(uint32 eventIndex, bytes32 documentHash) external view returns (bool) {
        return eventIndex != 0 && eventIndex < _events.length && _events[eventIndex].evidenceHash == documentHash;
    }

    /// @inheritdoc ICarbonTraceability
    function certificationStatus(bytes32 batchId)
        external
        view
        returns (bool batchClosed, bool farmPhasesClosed, bool farmPhasesVerified, bytes32 digest)
    {
        Batch storage b = _batches[batchId];
        if (b.mill == address(0)) revert NotFound(batchId);
        batchClosed = b.closed;
        farmPhasesClosed = true;
        farmPhasesVerified = true;
        digest = keccak256(abi.encode(batchId, b.revision));
        bytes32[] storage lotIds = _batchLots[batchId];
        for (uint256 i = 0; i < lotIds.length; i++) {
            Lot storage l = _lots[lotIds[i]];
            FarmScope storage s = _farmScopes[farmScopeId(l.orchardId, l.cropYear)];
            farmPhasesClosed = farmPhasesClosed && s.closed;
            farmPhasesVerified = farmPhasesVerified && s.verified;
            digest = keccak256(abi.encode(digest, l.revision, s.revision));
        }
    }

    // ------------------------------------------------------------------
    // Views and helpers
    // ------------------------------------------------------------------

    function farmScopeId(bytes32 orchardId, uint16 cropYear) public pure returns (bytes32) {
        return keccak256(abi.encode(orchardId, cropYear));
    }

    /// @notice Hash of a scoped event envelope; used for idempotency (a re-sent envelope is rejected).
    function envelopeHash(bytes32 scopeId, EventInput calldata e) external pure returns (bytes32) {
        return keccak256(abi.encode(scopeId, e));
    }


    function isRecorded(bytes32 envelope) external view returns (bool) {
        return _recordedEnvelopes[envelope];
    }

    function eventCount() external view returns (uint256) {
        return _events.length - 1;
    }

    function getActivityEvent(uint32 index) external view returns (ActivityEvent memory) {
        return _events[index];
    }

    function getOrchard(bytes32 orchardId) external view returns (Orchard memory) {
        return _orchards[orchardId];
    }

    function getFarmScope(bytes32 orchardId, uint16 cropYear) external view returns (FarmScope memory) {
        return _farmScopes[farmScopeId(orchardId, cropYear)];
    }

    function getLot(bytes32 lotId) external view returns (Lot memory) {
        return _lots[lotId];
    }

    function getTransfer(bytes32 lotId) external view returns (Transfer memory) {
        return _transfers[lotId];
    }

    function getBatch(bytes32 batchId) external view returns (Batch memory, bytes32[] memory lotIds, uint16[] memory sharesPermille) {
        return (_batches[batchId], _batchLots[batchId], _batchShares[batchId]);
    }

    function getCorrection(uint32 correctionId) external view returns (Correction memory) {
        return _corrections[correctionId];
    }

    function correctionCount() external view returns (uint256) {
        return _corrections.length - 1;
    }

    function _requireOrchardMember(bytes32 orchardId) private view returns (bytes32 org) {
        org = _orchards[orchardId].organisationId;
        if (org == bytes32(0)) revert NotFound(orchardId);
        if (consortium.organisationOf(msg.sender) != org) revert Unauthorized(msg.sender);
    }

    /// Validates an envelope (R1-R3, see {EnvelopeValidation}), rejects re-sent envelopes and appends
    /// the event to the log.
    function _appendEvent(
        Phase phase,
        bytes32 scopeId,
        bytes32 organisationId,
        EventInput calldata e,
        bytes calldata deviceSig,
        uint32 replaces,
        EventStatus status
    ) private returns (uint32 index) {
        bytes32 envelope = EnvelopeValidation.validate(address(consortium), address(this), uint8(phase), scopeId, organisationId, e, deviceSig);
        if (_recordedEnvelopes[envelope]) revert DuplicateEvent(envelope);
        _recordedEnvelopes[envelope] = true;
        index = uint32(_events.length);
        _events.push(
            ActivityEvent({
                scopeId: scopeId,
                variable: e.variable,
                evidenceHash: e.evidenceHash,
                quantity: e.quantity,
                observedAt: e.observedAt,
                recordedAt: uint64(block.timestamp),
                uncertaintyPermille: e.uncertaintyPermille,
                phase: phase,
                source: e.source,
                status: status,
                actor: msg.sender,
                replaces: replaces,
                replacedBy: 0
            })
        );
        emit ActivityRecorded(index, scopeId, phase, e, msg.sender, replaces, SCHEMA_VERSION);
    }

    function _withinTolerance(uint128 expected, uint128 actual) private view returns (bool) {
        uint256 diff = expected > actual ? expected - actual : actual - expected;
        return diff * 10000 <= uint256(expected) * massToleranceBp;
    }
}
