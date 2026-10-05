"use strict";
// Deploys the library and the five contracts and configures the prototype consortium
// (actors, governed variables, functional units, calibrated devices).
// Usage: npx hardhat run scripts/deploy.js --network besu
// Writes deployments/<network>.json with addresses, actor accounts and deployment gas.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { deployAll, configureConsortium } = require("../lib/deploy");
const { Recorder } = require("../lib/recorder");

async function main() {
  const { ethers, network } = hre;
  const signers = await ethers.getSigners();
  if (signers.length < 13) throw new Error("13 accounts are needed (governor and 12 consortium actors); see hardhat.config.js");
  const rec = new Recorder(ethers.provider);
  const contracts = await deployAll(ethers, signers[0], rec);
  const { actors } = await configureConsortium(contracts, signers, rec);
  const addresses = {};
  for (const [k, c] of Object.entries(contracts)) addresses[k] = await c.getAddress();
  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    contracts: addresses,
    actors: Object.fromEntries(Object.entries(actors).map(([k, s]) => [k, s.address])),
    deployments: rec.deployments,
    configuration: rec.totals(),
  };
  const dir = path.join(__dirname, "../deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
