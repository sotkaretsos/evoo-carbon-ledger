"use strict";
// Dimensional checks of the frozen inputs and the generated per-liter results.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.join(__dirname, "..");
const read = rel => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
const plan = read("offchain/case-study/western-achaia.json");
const factors = read("offchain/factor-sets/FS-2026-RECON-01.json");
const grid = read("offchain/factor-sets/greek-grid-2022-2024.metadata.json");
const archive = fs.readFileSync(path.join(root, "offchain/factor-sets", grid.archiveFile));
assert.equal(crypto.createHash("sha256").update(archive).digest("hex"), grid.sha256);
const rows = archive.toString("utf8").trim().split(/\r?\n/).slice(1).map(row => Number(row.split(",").at(-1)));
assert.equal(rows.length, 3);
const gridMean = rows.reduce((a,b) => a+b,0)/rows.length;
assert.ok(Math.abs(gridMean - grid.mean_gCO2eq_per_kWh) < 1e-10);
assert.equal(Math.round(gridMean) / 1000, factors.factors.GRID_ELECTRICITY.value);
const areaHa = plan.orchard.areaM2 / 10000;
const sum = (activity,variable) => plan.farmEvents.filter(e => e.activity===activity && e.variable===variable).reduce((a,e)=>a+e.quantity,0);
const dieselPerHa = activity => sum(activity,"FIELD_DIESEL_L") * factors.densities_kg_per_L.DIESEL / areaHa;
assert.ok(Math.abs(dieselPerHa("SOIL_PREPARATION") - 36.75) < 1e-10);
assert.ok(Math.abs(dieselPerHa("FOLIAR_FERTILISATION") - 7.02) <= 0.0001);
assert.ok(Math.abs(dieselPerHa("PLANT_PROTECTION") - 10.5) < 1e-10);
assert.ok(Math.abs(dieselPerHa("HARVESTING") - 12.25) < 1e-10);
const oilL = plan.mill.events.find(e=>e.variable==="OIL_OUTPUT_L").quantity;
const millDieselL = plan.mill.events.find(e=>e.variable==="MILL_DIESEL_L").quantity;
const millDieselKgPerL = millDieselL * factors.densities_kg_per_L.DIESEL / oilL;
assert.ok(Math.abs(millDieselKgPerL - 0.00057) < 0.0000001);
const report = read("reports/lca-report-v1.json");
assert.equal(report.functionalUnit,"EVOO_1L_MILL_GATE");
assert.equal(report.referenceFlow.unit,"L");
assert.equal(report.referenceFlow.quantity,oilL);
assert.ok(Math.abs(report.total.perFU*oilL-report.total.kgCO2eq)<1e-8);
assert.ok(Math.abs(report.total.perHa*areaHa-report.total.kgCO2eq)<1e-8);
assert.ok(Math.abs(report.total.mg/1e6-report.total.perFU)<=0.0000015);
const output = {
  status:"passed", functionalUnit:"1 L EVOO at the mill gate", areaHa, oilOutputL:oilL,
  grid:{sourceMean_gCO2eq_per_kWh:gridMean,applied_kgCO2eq_per_kWh:factors.factors.GRID_ELECTRICITY.value,archiveSha256:grid.sha256},
  diesel_kg_per_ha:{soil:dieselPerHa("SOIL_PREPARATION"),foliar:dieselPerHa("FOLIAR_FERTILISATION"),plantProtection:dieselPerHa("PLANT_PROTECTION"),harvestTractor:dieselPerHa("HARVESTING"),transport:plan.harvest.days.length*plan.harvest.transport.dieselLPerDelivery*factors.densities_kg_per_L.DIESEL/areaHa},
  millDiesel_kg_per_L_oil:millDieselKgPerL,
  oilMassDensityAssumption_kg_per_L:0.916,
  economicPriceAssumptions:{oil_EUR_per_L:4,pomace_EUR_per_kg:0.03},
  kgCO2eq_per_L:report.total.perFU, kgCO2eq_per_ha:report.total.perHa,
  scope:"Checks units, conversions and the arithmetic of the reference factor set."
};
fs.writeFileSync(path.join(root,"reports/input-validation.json"),JSON.stringify(output,null,2)+"\n");
console.log(JSON.stringify(output,null,2));
