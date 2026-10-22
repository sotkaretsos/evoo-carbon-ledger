"""Separate reference reconstruction from retrieved evidence using Decimal.

No production engine, engine evaluate(), engine rules, or JavaScript arithmetic
is used here. The source files contain all invented process parameters. SHA-256
checks concern exact evidence bytes committed by the actual ledger events.
"""
import argparse
import csv
import hashlib
import json
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP, getcontext
from pathlib import Path

getcontext().prec = 50
D = Decimal
ROOT = Path(__file__).resolve().parent
PHASES = ("cultivation", "transport", "mill")
UNITS = {"COMPOUND_FERTILISER_KG": "kg", "FOLIAR_FERTILISER_KG": "kg",
         "FIELD_DIESEL_L": "L", "IRRIGATION_ELECTRICITY_KWH": "kWh",
         "TRANSPORT_DIESEL_L": "L", "MILL_ELECTRICITY_KWH": "kWh",
         "MILL_DIESEL_L": "L", "OIL_OUTPUT_L": "L", "POMACE_KG": "kg"}


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def dec(value):
    return D(str(value))


def serial(value):
    if isinstance(value, D):
        return format(value, "f")
    if isinstance(value, dict):
        return {key: serial(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [serial(item) for item in value]
    return value


def sha256(raw):
    return "0x" + hashlib.sha256(raw).hexdigest()


def rounded_mg(value):
    return int((value * D(1000000)).to_integral_value(rounding=ROUND_HALF_UP))


def bytes32_code(text):
    raw = text.encode("ascii")
    if len(raw) > 31:
        raise ValueError("Code exceeds bytes32 ASCII convention")
    return "0x" + raw.hex().ljust(64, "0")


class EvidenceAudit:
    def __init__(self, fixture_root=ROOT):
        self.root = fixture_root
        self.out = self.root / "results"
        self.design = load_json(self.root / "design.json")
        self.factors = load_json(self.root / "factors.synthetic.json")
        self.expected = load_json(self.root / "expectations.json")
        self.index = load_json(self.root / "evidence-index.json")
        self.by_id = {e["evidenceId"]: e for e in self.index["entries"]}
        self.run = load_json(self.out / "ledger-run.json")
        self.snapshots = {name: load_json(self.out / ("snapshot-" + name + ".json"))
                          for name in ("baseline", "corrected", "wrongSource")}
        self.checks = []

    def require(self, condition, label, details=None):
        self.checks.append({"check": label, "pass": bool(condition), "details": serial(details)})

    def check_predeclared(self):
        for filename, digest in self.index["fixtureCommitments"].items():
            actual = hashlib.sha256((self.root / filename).read_bytes()).hexdigest()
            self.require(actual == digest == self.run["predeclaredCommitments"][filename],
                         "predeclared_fixture_commitment:" + filename)

    def process_components(self, body):
        """Recompute processes, not the engine's combined product coefficient."""
        q = dec(body["quantity"])
        variable = body["variable"]
        p = self.factors["syntheticProcessDefinitions"]
        if variable in ("COMPOUND_FERTILISER_KG", "FOLIAR_FERTILISER_KG"):
            material = p["compound" if variable == "COMPOUND_FERTILISER_KG" else "foliar"]
            manufacture = q * dec(material["manufacturing_kgCO2eq_per_kg_product"])
            nitrogen = q * dec(material["N_mass_fraction"])
            n2o_n = nitrogen * dec(p["directEF_N2O_N_per_N"])
            # Multiply the exact decimal numerator before dividing, avoiding an
            # unnecessary recurring 44/28 intermediate in this synthetic model.
            soil = (n2o_n * dec(p["N2O_N_to_N2O_numerator"]) * dec(p["gwp100_N2O"])
                    / dec(p["N2O_N_to_N2O_denominator"]))
            prefix = "COMPOUND" if variable == "COMPOUND_FERTILISER_KG" else "FOLIAR"
            return {prefix + "_MANUFACTURE": manufacture, prefix + "_DIRECT_N2O": soil}
        if variable.endswith("DIESEL_L"):
            return {"DIESEL_COMBUSTION": q * dec(self.factors["densities_kg_per_L"]["DIESEL"])
                    * dec(self.factors["factors"]["SYN_DIESEL"]["value"])}
        if variable.endswith("ELECTRICITY_KWH"):
            return {"ELECTRICITY_SUPPLY": q * dec(self.factors["factors"]["SYN_GRID"]["value"])}
        if variable in ("OIL_OUTPUT_L", "POMACE_KG"):
            return {}
        raise ValueError("Independent model has no formula for " + variable)

    def case(self, case):
        current = self.snapshots[case["ledgerSnapshot"]]
        claimed = self.snapshots[case["claimsSnapshot"]]
        directory = (self.out / "case-evidence" / case["id"]).resolve()
        issues = []
        retrieved = {}
        attempted = set()
        def issue(code, subject, detail):
            item = {"code": code, "subject": str(subject), "detail": detail}
            if item not in issues:
                issues.append(item)

        def evidence(evidence_id, committed_hash):
            if evidence_id in retrieved:
                return retrieved[evidence_id]
            if evidence_id in attempted:
                return None
            attempted.add(evidence_id)
            entry = self.by_id[evidence_id]
            local = (directory / Path(entry["path"]).name).resolve()
            if local.parent != directory:
                issue("PATH_OUTSIDE_REPOSITORY", evidence_id, "Rejected path")
                return None
            if not local.is_file():
                issue("EVIDENCE_MISSING", evidence_id, "Actual retrieval returned no file")
                return None
            raw = local.read_bytes()
            if sha256(raw).lower() != committed_hash.lower() or committed_hash.lower() != entry["sha256"].lower():
                issue("EVIDENCE_HASH_MISMATCH", evidence_id, "Retrieved bytes differ from the event commitment")
                return None
            try:
                body = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeError):
                issue("EVIDENCE_PARSE_FAILURE", evidence_id, "Bytes are not UTF-8 JSON")
                return None
            if body.get("synthetic") is not True or body.get("evidenceId") != evidence_id:
                issue("EVIDENCE_SCHEMA_MISMATCH", evidence_id, "Wrong fixture marker or identity")
                return None
            retrieved[evidence_id] = body
            return body

        orchards = {o["id"]: o for o in current["orchards"]}
        lots = {l["id"]: l for l in current["lots"]}
        actors = current["actorRegistry"]
        sources = current["sourceRegistry"]
        for orchard in current["orchards"]:
            body = evidence(orchard["evidenceId"], orchard["locationHash"])
            if not body:
                continue
            actor = actors.get(body["issuerActorKey"], {})
            if (body["scope"] != orchard["id"] or body["areaM2"] != orchard["areaM2"]
                    or body["cropYear"] != orchard["cropYear"] or actor.get("address", "").lower() != orchard["grower"].lower()
                    or actor.get("organisationId") != orchard["organisationId"]):
                issue("SOURCE_IDENTITY_MISMATCH", body["evidenceId"], "Orchard identity/area does not match mined state")
        for lot in current["lots"]:
            body = evidence(lot["evidenceId"], lot["evidenceHash"])
            if not body:
                continue
            transfer = lot["transfer"]
            orchard = orchards[lot["orchard"]]
            if (body["scope"] != lot["id"] or body["orchard"] != lot["orchard"] or body["cropYear"] != lot["cropYear"]
                    or dec(body["harvestedKg"]) * 1000 != dec(lot["harvestedMassG"])
                    or dec(body["receivedKg"]) * 1000 != dec(lot["receivedMassG"])):
                issue("EVIDENCE_LEDGER_MISMATCH", lot["id"], "Lot identity or mass differs from evidence")
            if (actors[body["issuerActorKey"]]["address"].lower() != orchard["grower"].lower()
                    or transfer["from"].lower() != orchard["grower"].lower()
                    or transfer["to"].lower() != actors["mill"]["address"].lower()
                    or transfer["transporter"].lower() != actors["transporter"]["address"].lower()
                    or transfer["evidenceHash"] != lot["evidenceHash"] or int(transfer["confirmedAt"]) <= 0):
                issue("SOURCE_IDENTITY_MISMATCH", lot["id"], "Custody source does not match orchard/mill/transporter")
        effective = [e for e in current["events"] if e["status"] == 1]
        by_scope = defaultdict(list)
        for event in effective:
            body = evidence(event["evidenceId"], event["evidenceHash"])
            if not body:
                continue
            expected_source = sources.get(body["sourceCode"], {})
            issuer = actors.get(body["issuerActorKey"], {})
            if (body["scope"] != event["scope"] or body["variable"] != event["variable"]
                    or body["activity"] != event["activity"] or body["source"] != event["source"]
                    or body["unit"] != UNITS.get(event["variable"])
                    or dec(body["quantity"]) * 1000 != dec(event["quantityMilli"])):
                issue("EVIDENCE_LEDGER_MISMATCH", event["index"], "Event fields or quantity differ from retrieved bytes")
            if (expected_source.get("sourceId") != event["sourceId"]
                    or issuer.get("address", "").lower() != event["actor"].lower()
                    or expected_source.get("organisationId") != issuer.get("organisationId")):
                issue("SOURCE_IDENTITY_MISMATCH", event["index"], "Source identifier, actor or organisation does not match evidence")
            if event["phase"] == 1 and (event["scope"] not in orchards or issuer.get("organisationId") != orchards[event["scope"]]["organisationId"]):
                issue("SOURCE_IDENTITY_MISMATCH", event["index"], "Farm event attributed to another orchard organisation")
            if body["source"] == "Meter":
                device = expected_source.get("device", {})
                if (device.get("organisationId") != issuer.get("organisationId") or not device.get("active")
                        or int(device.get("calibratedUntil", 0)) < int(event["observedAt"])):
                    issue("SOURCE_IDENTITY_MISMATCH", event["index"], "Meter registration/calibration does not cover this observation")
            by_scope[event["scope"]].append(body)
        source_issues = list(issues)
        reconstructions = []
        claims_checked = 0
        if not source_issues:
            farm_components = {}
            for orchard_id in orchards:
                totals = defaultdict(D)
                for body in by_scope[orchard_id]:
                    for process, kg in self.process_components(body).items():
                        totals[process] += kg
                farm_components[orchard_id] = dict(totals)
                harvested = sum((dec(retrieved[l["evidenceId"]]["harvestedKg"]) for l in lots.values() if l["orchard"] == orchard_id), D(0))
                if harvested * 1000 != dec(orchards[orchard_id]["harvestedMassG"]):
                    issue("ALLOCATION_MISMATCH", orchard_id, "Whole-scope harvest denominator does not equal lots")
            for batch in current["batches"]:
                selected = [lots[l] for l in batch["lotIds"]]
                mass = sum((dec(retrieved[l["evidenceId"]]["receivedKg"]) for l in selected), D(0))
                if mass * 1000 != dec(batch["receivedMassG"]) or batch["receivedMassG"] != batch["receptionMassG"]:
                    issue("ALLOCATION_MISMATCH", batch["id"], "Batch mass does not match delivered evidence")
                if sum(batch["sharesPermille"]) != 1000:
                    issue("ALLOCATION_MISMATCH", batch["id"], "Declared mixing shares do not sum to 1000")
                for lot, declared in zip(selected, batch["sharesPermille"]):
                    share = dec(retrieved[lot["evidenceId"]]["receivedKg"]) / mass * 1000
                    if abs(dec(declared) - share.to_integral_value(rounding=ROUND_HALF_UP)) > 1:
                        issue("ALLOCATION_MISMATCH", lot["id"], "Declared mixing share exceeds contract rounding tolerance")
                scoped_shares = defaultdict(D)
                for lot in selected:
                    scoped_shares[lot["orchard"]] += dec(retrieved[lot["evidenceId"]]["harvestedKg"]) / (dec(orchards[lot["orchard"]]["harvestedMassG"]) / 1000)
                components = defaultdict(D)
                area = D(0)
                for orchard_id, share in scoped_shares.items():
                    area += dec(retrieved[orchards[orchard_id]["evidenceId"]]["areaM2"]) / 10000 * share
                    for process, kg in farm_components[orchard_id].items():
                        components[process] += kg * share
                cultivation = sum(components.values(), D(0))
                transport = sum((sum(self.process_components(body).values(), D(0)) for lot in selected for body in by_scope[lot["id"]]), D(0))
                mill_bodies = by_scope[batch["id"]]
                mill = sum((sum(self.process_components(body).values(), D(0)) for body in mill_bodies), D(0))
                oil = sum((dec(body["quantity"]) for body in mill_bodies if body["variable"] == "OIL_OUTPUT_L"), D(0))
                pomace = sum((dec(body["quantity"]) for body in mill_bodies if body["variable"] == "POMACE_KG"), D(0))
                phases = dict(zip(PHASES, (cultivation, transport, mill)))
                total = cultivation + transport + mill
                groups = {"FERTILIZER_COMPOUND": components["COMPOUND_MANUFACTURE"] + components["COMPOUND_DIRECT_N2O"],
                          "FERTILIZER_FOLIAR": components["FOLIAR_MANUFACTURE"] + components["FOLIAR_DIRECT_N2O"],
                          "FIELD_FUEL": components["DIESEL_COMBUSTION"], "IRRIGATION": components["ELECTRICITY_SUPPLY"],
                          "TRANSPORT": transport, "MILL_PROCESSING": mill}
                for allocation in self.design["allocationScenarios"]:
                    rule = allocation["allocationRule"]
                    if rule == "NONE_UNALLOCATED":
                        oil_share = D(1)
                    elif rule == "ECONOMIC":
                        oil_value = oil * dec(allocation["prices"]["oil"])
                        oil_share = oil_value / (oil_value + pomace * dec(allocation["prices"]["pomace"]))
                    elif rule == "WET_MASS":
                        oil_kg = oil * dec(allocation["oilDensityKgPerL"])
                        oil_share = oil_kg / (oil_kg + pomace)
                    else:
                        raise ValueError("Unknown independent allocation")
                    phase_per_fu = {phase: kg * oil_share / oil for phase, kg in phases.items()}
                    phase_mg = [rounded_mg(phase_per_fu[p]) for p in PHASES]
                    reference = {"batch": batch["id"], "allocationRule": rule, "areaHa": area,
                        "farmScopeShares": dict(scoped_shares), "cultivationProcessesKg": dict(components),
                        "phasesKg": phases, "totalKg": total, "oilL": oil, "pomaceKg": pomace,
                        "oilShare": oil_share, "perFU": total * oil_share / oil,
                        "phasesPerFU": phase_per_fu, "phaseMg": phase_mg, "totalMg": sum(phase_mg)}
                    reconstructions.append(reference)
                    matches = [c for c in claimed["claims"] if c["batch"] == batch["id"] and c["allocationRule"] == rule]
                    if len(matches) != 1:
                        issue("CLAIM_MISSING_OR_DUPLICATE", batch["id"], rule)
                        continue
                    claim = matches[0]
                    report = claim["report"]
                    claims_checked += 1
                    if (report["functionalUnit"] != "EVOO_1L_MILL_GATE" or report["referenceFlow"]["unit"] != "L"
                            or report["allocationRule"] != rule
                            or claim["resultInput"]["functionalUnit"] != bytes32_code("EVOO_1L_MILL_GATE")):
                        issue("FUNCTIONAL_UNIT_MISMATCH", batch["id"], "Claimed functional/output/allocation unit differs from evidence scenario")
                    if (report["factorSet"]["id"] != self.factors["id"] or report["factorSet"]["version"] != self.factors["version"]
                            or claim["resultInput"]["factorSetId"] != bytes32_code(self.factors["id"])):
                        issue("FACTOR_VERSION_MISMATCH", batch["id"], "Claim uses another factor version")
                    if sorted(l["lotId"] for l in report["lots"]) != sorted(bytes32_code(l["id"]) for l in selected):
                        issue("ALLOCATION_MISMATCH", batch["id"], "Report lot identities do not match batch lineage")
                    if report["snapshot"]["revisionDigest"] != batch["revisionDigest"]:
                        issue("REVISION_MISMATCH", batch["id"], "Claim commits a superseded event revision")
                    kg_tolerance = dec(self.expected["comparisonToleranceKg"])
                    fu_tolerance = dec(self.expected["comparisonTolerancePerFU"])
                    comparisons = [("total kg", total, report["total"]["kgCO2eq"], kg_tolerance),
                        ("per FU", reference["perFU"], report["total"]["perFU"], fu_tolerance),
                        ("area", area, report["areaHa"], fu_tolerance),
                        ("oil share", oil_share, report["oilShare"], fu_tolerance),
                        ("oil reference", oil, report["referenceFlow"]["quantity"], kg_tolerance),
                        ("total per ha", total / area, report["total"]["perHa"], kg_tolerance)]
                    for phase in PHASES:
                        comparisons += [(phase + " kg", phases[phase], report["phases"][phase]["kgCO2eq"], kg_tolerance),
                                        (phase + " per FU", phase_per_fu[phase], report["phases"][phase]["perFU"], fu_tolerance)]
                    for group, kg in groups.items():
                        comparisons.append((group + " kg", kg, report["groups"].get(group, {}).get("kgCO2eq", "NaN"), kg_tolerance))
                    bad = [label for label, actual, published, tolerance in comparisons
                           if not dec(published).is_finite() or abs(actual - dec(published)) > tolerance]
                    if phase_mg != list(map(int, claim["resultInput"]["phaseMg"])) or sum(phase_mg) != int(claim["resultInput"]["totalMg"]):
                        bad.append("integer phase/total mg")
                    if bad:
                        issue("ARITHMETIC_MISMATCH", batch["id"] + "/" + rule, ", ".join(bad))
                    assessment = report["methodologicalAssessment"]
                    if (assessment["status"] != "Unassessed" or int(claim["resultInput"]["methodologicalStatus"]) != 0
                            or not int(claim["resultInput"]["limitationFlags"]) & 1024
                            or assessment["uncertainty"]["quantitativeInterval"] is not None):
                        issue("METHODOLOGICAL_DISCLOSURE_MISMATCH", batch["id"], "Synthetic/unassessed/uncertainty disclosure absent")
        actual_codes = sorted({i["code"] for i in issues})
        decision = "PASS" if not issues else "FAIL"
        expected_codes = sorted(case["expectedDetections"])
        matched = decision == case["expectedDecision"] and actual_codes == expected_codes
        return {"id": case["id"], "decision": decision, "expectedDecision": case["expectedDecision"],
            "detections": actual_codes, "expectedDetections": expected_codes, "matchesPredeclaredExpectation": matched,
            "retrievalAttempts": len(attempted), "verifiedFiles": len(retrieved),
            "effectiveEvents": len(effective), "claimsCompared": claims_checked,
            "trustedReconstruction": "blocked by evidence/source failure" if source_issues else "completed",
            "issues": issues, "reconstructions": reconstructions}

    def analytic_checks(self, cases):
        for state, case_id in (("baseline", "baseline_complete"), ("corrected", "corrected_quantity_recomputed")):
            rows = next(c for c in cases if c["id"] == case_id)["reconstructions"]
            gross = [r for r in rows if r["allocationRule"] == "NONE_UNALLOCATED"]
            expected = self.expected[state]
            for row in gross:
                golden = expected[row["batch"]]
                for field, value in (("cultivationKg", row["phasesKg"]["cultivation"]),
                        ("transportKg", row["phasesKg"]["transport"]), ("millKg", row["phasesKg"]["mill"]),
                        ("totalKg", row["totalKg"])):
                    self.require(value == dec(golden[field]), state + ":analytic:" + row["batch"] + ":" + field)
                expected_per_fu = dec(golden["perFU"]) if "perFU" in golden else D(golden["perFUFraction"][0]) / D(golden["perFUFraction"][1])
                self.require(abs(row["perFU"] - expected_per_fu) < D("1e-45"), state + ":analytic:" + row["batch"] + ":perFU")
                self.require(row["phaseMg"] == golden["phaseMg"] and row["totalMg"] == golden["totalMg"], state + ":analytic:" + row["batch"] + ":integer_rounding")
            combined = sum((r["totalKg"] for r in gross), D(0))
            oil = sum((r["oilL"] for r in gross), D(0))
            self.require(combined == dec(expected["combinedTotalKg"]) and oil == dec(expected["combinedOilL"])
                         and combined / oil == dec(expected["weightedPerL"]), state + ":mass_and_burden_conservation")
            for orchard_id in expected["orchardCultivationKg"]:
                # Reconstruct full scopes directly again from validated source bytes, independently of batch shares.
                snapshot = self.snapshots[state]
                scope = [e for e in snapshot["events"] if e["status"] == 1 and e["scope"] == orchard_id]
                full = sum((sum(self.process_components(load_json(self.root / self.by_id[e["evidenceId"]]["path"])).values(), D(0)) for e in scope), D(0))
                self.require(full == dec(expected["orchardCultivationKg"][orchard_id]), state + ":full_orchard:" + orchard_id)
                shares = sum((r["farmScopeShares"].get(orchard_id, D(0)) for r in gross), D(0))
                self.require(shares == 1, state + ":harvest_share_conservation:" + orchard_id)
        base_rows = next(c for c in cases if c["id"] == "baseline_complete")["reconstructions"]
        corrected_rows = next(c for c in cases if c["id"] == "corrected_quantity_recomputed")["reconstructions"]
        for row in corrected_rows:
            if row["allocationRule"] != "NONE_UNALLOCATED":
                continue
            base = next(b for b in base_rows if b["batch"] == row["batch"] and b["allocationRule"] == "NONE_UNALLOCATED")
            self.require(row["totalKg"] - base["totalKg"] == dec(self.expected["corrected"][row["batch"]]["deltaKg"]), "correction_response:" + row["batch"])
        for row in base_rows:
            golden = self.expected["baseline"][row["batch"]]
            key = {"ECONOMIC": "economicOilShareFraction", "WET_MASS": "wetMassOilShareFraction"}.get(row["allocationRule"])
            if key:
                numerator, denominator = golden[key]
                self.require(abs(row["oilShare"] - D(numerator) / D(denominator)) < D("1e-45"), "allocation_fraction:" + row["batch"] + ":" + row["allocationRule"])
        for step, states in self.expected["certificateTimeline"].items():
            actual = [c["status"] for c in self.run["certificateTimeline"][step]]
            self.require(actual == states, "mined_certificate_timeline:" + step)
        for state in ("baseline", "corrected"):
            self.require(all(c["methodologicalStatus"] == 0 and c["limitationFlags"] & 1024 for c in self.snapshots[state]["certificates"]), "certificate_disclosure:" + state)

    def run_all(self):
        self.check_predeclared()
        cases = [self.case(case) for case in self.expected["cases"]]
        self.analytic_checks(cases)
        for case in cases:
            self.require(case["matchesPredeclaredExpectation"], "case_decision:" + case["id"])
        passed = all(c["pass"] for c in self.checks)
        report = {"experiment": self.design["id"], "evaluationType": "controlled synthetic software evaluation",
            "verifier": "Python Decimal reference formulas and SHA-256 exact-byte evidence retrieval; production lca-engine not imported",
            "externalHumanAudit": False, "physicalValidation": False, "fieldTrial": False,
            "pass": passed, "checksPassed": sum(c["pass"] for c in self.checks), "checksTotal": len(self.checks),
            "casesMatchingPredeclaredExpectations": sum(c["matchesPredeclaredExpectation"] for c in cases),
            "casesTotal": len(cases), "cases": cases, "checks": self.checks,
            "scope": "Two invented orchards in distinct organisations, four unequal lots, two mixed batches, three allocation variants, retrieved evidence bytes, two actual append-only corrections.",
            "limitations": ["Test decisions apply to these six predeclared fixtures; no population accuracy/sensitivity estimate",
                "Separately coded checker was authored by the same project team, not an external auditor",
                "Ledger snapshots, registry and certificate captures remain trusted producer exports; this offline verifier does not independently query live RPC or validate consensus or block proofs",
                "Commitment checks detect inconsistencies in disclosed data, not a malicious producer that fully rewrites a coherent export and its commitments",
                "Contracts validate simulated device signatures; this Python checker checks source/actor bindings and exact evidence bytes but does not reimplement ECDSA",
                "Local paths test retrieval and integrity, not long-term remote availability or replication",
                "All activities, product compositions, factors and GWP parameter 280 are invented; none are proposed for the real field",
                "Partial selected-process model, with explicit exclusions; no full agricultural CFP or propagated uncertainty"]}
        self.out.mkdir(exist_ok=True)
        (self.out / "independent-audit-report.json").write_text(json.dumps(serial(report), indent=2) + "\n", encoding="utf-8")
        with (self.out / "case-decisions.csv").open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["case", "expectedDecision", "computedDecision", "computedDetections", "verifiedFiles", "claimsCompared", "matchesExpectation"])
            for c in cases:
                writer.writerow([c["id"], c["expectedDecision"], c["decision"], ";".join(c["detections"]), c["verifiedFiles"], c["claimsCompared"], c["matchesPredeclaredExpectation"]])
        print(json.dumps({k: report[k] for k in ("pass", "checksPassed", "checksTotal", "casesMatchingPredeclaredExpectations", "casesTotal")}))
        return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-root", type=Path, default=ROOT)
    args = parser.parse_args()
    result = EvidenceAudit(args.fixture_root.resolve()).run_all()
    raise SystemExit(0 if result["pass"] else 1)
