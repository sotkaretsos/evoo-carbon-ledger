"use strict";
// Encoding helpers shared by the tests, the case-study replay, the off-chain LCA engine and the
// edge-gateway simulation. They mirror the Solidity encodings exactly.

const { ethers } = require("ethers");

const coder = ethers.AbiCoder.defaultAbiCoder();

/** Short ASCII code -> left-aligned bytes32 (variable, activity, method, rule codes...). */
const b32 = (s) => ethers.encodeBytes32String(s);
/** bytes32 -> ASCII code (inverse of b32). */
const str32 = (h) => ethers.decodeBytes32String(h);
/** Unit symbol -> left-aligned bytes8, e.g. "kg" -> 0x6b67000000000000. */
const unit8 = (s) => ethers.zeroPadBytes(ethers.toUtf8Bytes(s), 8);
/** bytes8 -> unit symbol. */
const unitStr = (h) => ethers.toUtf8String(ethers.getBytes(h)).replace(/\0+$/, "");
/** keccak256 of a UTF-8 string (role identifiers, pseudonymous IDs, document hashes). */
const id = (s) => ethers.id(s);

const ROLES = {
  GOVERNOR: id("GOVERNOR_ROLE"),
  GROWER: id("GROWER_ROLE"),
  TRANSPORTER: id("TRANSPORTER_ROLE"),
  MILL: id("MILL_ROLE"),
  LCA_SERVICE: id("LCA_SERVICE_ROLE"),
  CERTIFIER: id("CERTIFIER_ROLE"),
  AUDITOR: id("AUDITOR_ROLE"),
  METHOD_AUTHORITY: id("METHOD_AUTHORITY_ROLE"),
};

const SourceClass = { Sensor: 0, Meter: 1, Invoice: 2, OperatorEntry: 3, Estimate: 4 };
const SourceClassName = ["Sensor", "Meter", "Invoice", "OperatorEntry", "Estimate"];
const Phase = { None: 0, Farm: 1, Transport: 2, Mill: 3 };
const EventStatus = { None: 0, Effective: 1, PendingReplacement: 2, Superseded: 3, Rejected: 4 };
const LotState = { None: 0, AtFarm: 1, InTransit: 2, AtMill: 3, InBatch: 4 };
const ResultStatus = { None: 0, Submitted: 1, Approved: 2, Superseded: 3 };
const CorrectionStatus = { None: 0, Pending: 1, Applied: 2, Rejected: 3 };
const CertificateStatus = { None: 0, Valid: 1, Outdated: 2, FactorSetRetired: 3 };
const CertificateStatusName = ["None", "Valid", "Outdated", "FactorSetRetired"];

const EVENT_INPUT_TYPE =
  "tuple(bytes32 activity,bytes32 variable,uint96 quantity,uint64 observedAt,uint8 source," +
  "uint16 uncertaintyPermille,bytes32 sourceId,bytes32 evidenceHash,bytes32 locationHash,bytes32 methodCode)";

/** Builds an EventInput struct with defaults for the optional fields. */
function eventInput({
  activity,
  variable,
  quantity,
  observedAt,
  source,
  uncertaintyPermille = 0,
  sourceId = ethers.ZeroHash,
  evidenceHash,
  locationHash = ethers.ZeroHash,
  methodCode = ethers.ZeroHash,
}) {
  return {
    activity: activity.startsWith("0x") ? activity : b32(activity),
    variable: variable.startsWith("0x") ? variable : b32(variable),
    quantity: BigInt(quantity),
    observedAt: BigInt(observedAt),
    source,
    uncertaintyPermille,
    sourceId,
    evidenceHash,
    locationHash,
    methodCode: methodCode.startsWith && methodCode.startsWith("0x") ? methodCode : b32(methodCode),
  };
}

const asTuple = (e) => [e.activity, e.variable, e.quantity, e.observedAt, e.source, e.uncertaintyPermille, e.sourceId, e.evidenceHash, e.locationHash, e.methodCode];

/** keccak256(abi.encode(scopeId, e)) — idempotency key of a scoped envelope. */
function envelopeHash(scopeId, e) {
  return ethers.keccak256(coder.encode(["bytes32", EVENT_INPUT_TYPE], [scopeId, asTuple(e)]));
}

/** keccak256(abi.encode(chainId, ledger, envelopeHash)) — digest signed by a device (EIP-191). */
function observationDigest(chainId, ledger, scopeId, e) {
  return ethers.keccak256(coder.encode(["uint256", "address", "bytes32"], [chainId, ledger, envelopeHash(scopeId, e)]));
}

/** Device / edge-gateway signature of an observation (EIP-191 personal_sign of the digest). */
async function signObservation(deviceWallet, chainId, ledger, scopeId, e) {
  return deviceWallet.signMessage(ethers.getBytes(observationDigest(chainId, ledger, scopeId, e)));
}

/** keccak256(abi.encode(chainId, ledger, lotId, receivedMassG, weighedAt, weighbridgeId)). */
function receiptDigest(chainId, ledger, lotId, receivedMassG, weighedAt, weighbridgeId) {
  return ethers.keccak256(
    coder.encode(["uint256", "address", "bytes32", "uint128", "uint64", "bytes32"], [chainId, ledger, lotId, receivedMassG, weighedAt, weighbridgeId])
  );
}

async function signReceipt(weighbridgeWallet, chainId, ledger, lotId, receivedMassG, weighedAt, weighbridgeId) {
  return weighbridgeWallet.signMessage(ethers.getBytes(receiptDigest(chainId, ledger, lotId, receivedMassG, weighedAt, weighbridgeId)));
}

/** keccak256(abi.encode(orchardId, cropYear)) — identifier of a farm scope. */
function farmScopeId(orchardId, cropYear) {
  return ethers.keccak256(coder.encode(["bytes32", "uint16"], [orchardId, cropYear]));
}

/** Deterministic test key for a simulated device (reproducible signatures). */
function deviceWallet(deviceCode) {
  return new ethers.Wallet(ethers.id("evoo-carbon-ledger/device-key/" + deviceCode));
}

/** Canonical JSON (sorted keys) so that report and manifest hashes are reproducible. */
function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.keys(v)
        .sort()
        .reduce((o, k) => {
          o[k] = sort(v[k]);
          return o;
        }, {});
    }
    if (typeof v === "bigint") return v.toString();
    return v;
  };
  return JSON.stringify(sort(value));
}

const hashJson = (value) => ethers.keccak256(ethers.toUtf8Bytes(canonicalJson(value)));

/** Unix seconds of an ISO date-time string (UTC). */
const ts = (iso) => Math.floor(Date.parse(iso) / 1000);

module.exports = {
  ethers,
  coder,
  b32,
  str32,
  unit8,
  unitStr,
  id,
  ROLES,
  SourceClass,
  SourceClassName,
  Phase,
  EventStatus,
  LotState,
  ResultStatus,
  CorrectionStatus,
  CertificateStatus,
  CertificateStatusName,
  EVENT_INPUT_TYPE,
  eventInput,
  envelopeHash,
  observationDigest,
  signObservation,
  receiptDigest,
  signReceipt,
  farmScopeId,
  deviceWallet,
  canonicalJson,
  hashJson,
  ts,
};
