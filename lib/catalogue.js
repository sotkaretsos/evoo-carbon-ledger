"use strict";
// Governed configuration of the prototype consortium: measurement variables (unit, phase,
// admissible range, meter requirement), functional units, organisations and devices.
// Quantities are expressed in milli-units of the variable's unit (e.g. g for kg, mL for L).

const { b32, unit8, id } = require("./encoding");

const k = (x) => BigInt(Math.round(x * 1000)); // units -> milli-units

/** Phase codes: 1 = cultivation and harvesting, 2 = transport, 3 = mill processing. */
const VARIABLES = [
  // Phase 1 — cultivation and harvesting (Table 1 of the article)
  { code: "COMPOUND_FERTILISER_KG", unit: "kg", phase: 1, meterRequired: false, mandatory: false, min: k(0.001), max: k(20000) },
  { code: "FOLIAR_FERTILISER_KG", unit: "kg", phase: 1, meterRequired: false, mandatory: false, min: k(0.001), max: k(1000) },
  { code: "COPPER_OXYCHLORIDE_KG", unit: "kg", phase: 1, meterRequired: false, mandatory: false, min: k(0.001), max: k(500) },
  { code: "PYRETHROID_KG", unit: "kg", phase: 1, meterRequired: false, mandatory: false, min: k(0.001), max: k(50) },
  { code: "SPRAY_WATER_M3", unit: "m3", phase: 1, meterRequired: false, mandatory: false, min: k(0.001), max: k(100) },
  { code: "FIELD_DIESEL_L", unit: "L", phase: 1, meterRequired: false, mandatory: false, min: k(0.1), max: k(2000) },
  { code: "FIELD_PETROL_L", unit: "L", phase: 1, meterRequired: false, mandatory: false, min: k(0.1), max: k(2000) },
  // Irrigation must come from meters (Section 4.3); defined although the case study has no records.
  { code: "IRRIGATION_WATER_M3", unit: "m3", phase: 1, meterRequired: true, mandatory: false, min: k(0.001), max: k(50000) },
  { code: "IRRIGATION_ELECTRICITY_KWH", unit: "kWh", phase: 1, meterRequired: true, mandatory: false, min: k(0.001), max: k(100000) },
  // Phase 2 — transport to the mill
  { code: "TRANSPORT_DIESEL_L", unit: "L", phase: 2, meterRequired: false, mandatory: false, min: k(0.1), max: k(500) },
  // Phase 3 — mill processing
  { code: "MILL_ELECTRICITY_KWH", unit: "kWh", phase: 3, meterRequired: true, mandatory: true, min: k(0.001), max: k(1000000) },
  // Volumetric reference flow (1 L EVOO). Default synthetic policy requires a signed meter;
  // the case replay explicitly permits reported volume without claiming an empirical measurement.
  { code: "OIL_OUTPUT_L", unit: "L", phase: 3, meterRequired: true, mandatory: true, min: k(0.001), max: k(1000000) },
  { code: "PROCESS_WATER_M3", unit: "m3", phase: 3, meterRequired: true, mandatory: false, min: k(0.001), max: k(100000) },
  { code: "OMW_WASTEWATER_L", unit: "L", phase: 3, meterRequired: false, mandatory: false, min: k(1), max: k(10000000) },
  { code: "POMACE_KG", unit: "kg", phase: 3, meterRequired: false, mandatory: false, min: k(1), max: k(10000000) },
  { code: "MILL_DIESEL_L", unit: "L", phase: 3, meterRequired: false, mandatory: false, min: k(0.001), max: k(1000) },
];

const FUNCTIONAL_UNITS = [
  { code: "EVOO_1KG_MILL_GATE", unit: "kg" },
  { code: "EVOO_1L_MILL_GATE", unit: "L" },
];

const ORGANISATIONS = {
  GROWER: "ORG/GROWER/WESTERN-ACHAIA-01",
  GROWER_B: "ORG/GROWER/OTHER-HOLDING",
  MILL: "ORG/MILL/WESTERN-ACHAIA-01",
  MILL_B: "ORG/MILL/OTHER-MILL",
  LCA: "ORG/LCA-SERVICE",
  CERT: "ORG/CERTIFICATION-BODY",
  AUDIT: "ORG/INDEPENDENT-AUDITOR",
  METHOD: "ORG/METHOD-AUTHORITY",
};

/**
 * Accounts of the prototype consortium, by index of the Hardhat (or Besu) signer list.
 * The transporter belongs to the mill: in the case study the mill's staff collect the olives.
 */
const ACTORS = [
  { key: "methodAuthorityA", index: 1, role: "METHOD_AUTHORITY", org: "METHOD" },
  { key: "methodAuthorityB", index: 2, role: "METHOD_AUTHORITY", org: "METHOD" },
  { key: "grower", index: 3, role: "GROWER", org: "GROWER" },
  { key: "transporter", index: 4, role: "TRANSPORTER", org: "MILL" },
  { key: "mill", index: 5, role: "MILL", org: "MILL" },
  { key: "lcaService", index: 6, role: "LCA_SERVICE", org: "LCA" },
  { key: "certifier", index: 7, role: "CERTIFIER", org: "CERT" },
  { key: "auditor", index: 8, role: "AUDITOR", org: "AUDIT" },
  { key: "growerB", index: 9, role: "GROWER", org: "GROWER_B" },
  { key: "millB", index: 10, role: "MILL", org: "MILL_B" },
  { key: "growerColleague", index: 12, role: "GROWER", org: "GROWER" },
];

/** Devices: owner organisation key, accuracy class, calibration validity (ISO date). */
const DEVICES = [
  { code: "WEIGHBRIDGE-01", ownerKey: "mill", accuracyClass: "OIML-R76-III", calibratedUntil: "2027-12-31T23:59:59Z" },
  { code: "ELEC-SUBMETER-01", ownerKey: "mill", accuracyClass: "MID-B", calibratedUntil: "2027-12-31T23:59:59Z" },
  { code: "OIL-METER-01", ownerKey: "mill", accuracyClass: "OIML-R117-0.5", calibratedUntil: "2027-12-31T23:59:59Z" },
  { code: "IRRIGATION-METER-01", ownerKey: "grower", accuracyClass: "MID-R160", calibratedUntil: "2027-12-31T23:59:59Z" },
];

const deviceId = (code) => b32(code);
const orgId = (key) => id(ORGANISATIONS[key]);

module.exports = { k, VARIABLES, FUNCTIONAL_UNITS, ORGANISATIONS, ACTORS, DEVICES, deviceId, orgId, b32, unit8 };
