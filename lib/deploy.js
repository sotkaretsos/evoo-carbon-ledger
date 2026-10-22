"use strict";
// Deployment and consortium configuration, shared by tests, the case-study replay and the
// deployment script for a Besu QBFT network.

const { b32, unit8, id, ts, ROLES, deviceWallet } = require("./encoding");
const { VARIABLES, FUNCTIONAL_UNITS, ORGANISATIONS, ACTORS, DEVICES, deviceId } = require("./catalogue");

/**
 * Deploys the validation library and the five contracts.
 * @param {object} hreEthers  the `ethers` object of the Hardhat runtime environment
 * @param {object} governor   signer that becomes consortium governor
 * @param {object} [recorder] optional {@link Recorder} for deployment gas
 */
async function deployAll(hreEthers, governor, recorder) {
  const deploy = async (name, args = [], libraries) => {
    let factory;
    if (name === "EnvelopeValidation") {
      // Library ABIs use Solidity type names that ethers cannot parse; only the bytecode is needed.
      const artifact = await require("hardhat").artifacts.readArtifact(name);
      factory = await hreEthers.getContractFactory([], artifact.bytecode, governor);
    } else {
      factory = await hreEthers.getContractFactory(name, libraries ? { signer: governor, libraries } : governor);
    }
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    if (recorder) await recorder.deployment(name, contract);
    return contract;
  };
  const envelopeLib = await deploy("EnvelopeValidation");
  const consortium = await deploy("Consortium", [governor.address]);
  const factorRegistry = await deploy("FactorRegistry", [await consortium.getAddress()]);
  const evidenceRegistry = await deploy("EvidenceRegistry", [await consortium.getAddress()]);
  const traceability = await deploy("CarbonTraceability", [await consortium.getAddress()], {
    EnvelopeValidation: await envelopeLib.getAddress(),
  });
  const certification = await deploy("CarbonCertification", [
    await consortium.getAddress(),
    await factorRegistry.getAddress(),
    await evidenceRegistry.getAddress(),
    await traceability.getAddress(),
  ]);
  return { envelopeLib, consortium, factorRegistry, evidenceRegistry, traceability, certification };
}

/**
 * Registers actors, variables, functional units and calibrated devices.
 * @returns {{actors: object, devices: object}} signer map and device wallets
 */
async function configureConsortium(contracts, signers, recorder, options = {}) {
  const { consortium, certification } = contracts;
  const send = async (label, txp) => (recorder ? recorder.send(label, "setup", txp) : (await txp).wait());
  const governor = signers[0];
  const actors = { governor, outsider: signers[11] };
  for (const a of ACTORS) {
    const signer = signers[a.index];
    actors[a.key] = signer;
    await send(
      "Consortium.registerActor",
      consortium.connect(governor).registerActor(signer.address, id("ACTOR/" + a.key), id(ORGANISATIONS[a.org]), ROLES[a.role])
    );
  }
  for (const v of VARIABLES) {
    await send(
      "Consortium.defineVariable",
      consortium.connect(actors.methodAuthorityA).defineVariable(b32(v.code), unit8(v.unit), v.phase, (options.reportedMillInputs && ["MILL_ELECTRICITY_KWH", "OIL_OUTPUT_L"].includes(v.code)) ? false : v.meterRequired, v.mandatory, v.min, v.max)
    );
  }
  for (const fu of FUNCTIONAL_UNITS) {
    await send("CarbonCertification.defineFunctionalUnit", certification.connect(actors.methodAuthorityA).defineFunctionalUnit(b32(fu.code), unit8(fu.unit)));
  }
  const devices = {};
  for (const d of DEVICES) {
    const wallet = deviceWallet(d.code);
    devices[d.code] = wallet;
    await send("Consortium.registerDevice", consortium.connect(actors[d.ownerKey]).registerDevice(deviceId(d.code), wallet.address, b32(d.accuracyClass)));
    await send(
      "Consortium.recordCalibration",
      consortium.connect(actors.certifier).recordCalibration(deviceId(d.code), id("CALIBRATION-CERTIFICATE/" + d.code), options.calibratedUntil ?? ts(d.calibratedUntil))
    );
  }
  return { actors, devices };
}

module.exports = { deployAll, configureConsortium };
