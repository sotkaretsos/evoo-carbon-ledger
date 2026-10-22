"""Deterministically materialize the invented evidence, before the ledger run.

This fixture authoring tool does not compute expected carbon results and does
not import the production engine or the independent verifier.
"""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    design = json.loads((ROOT / "design.json").read_text(encoding="utf-8"))
    out = ROOT / "evidence"
    out.mkdir(exist_ok=True)
    entries = []

    def put(evidence_id, record):
        body = {"evidenceId": evidence_id, "synthetic": True,
                "notice": "Invented test record; not empirical evidence or a real device export.", **record}
        relative = "evidence/" + evidence_id + ".json"
        raw = (json.dumps(body, indent=2, sort_keys=True, ensure_ascii=True) + "\n").encode()
        (ROOT / relative).write_bytes(raw)
        entries.append({"evidenceId": evidence_id, "path": relative,
                        "sha256": "0x" + hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})

    for orchard in design["orchards"]:
        put("orchard-" + orchard["id"].split("/")[-1], {
            "recordType": "OrchardDeclaration", "scope": orchard["id"],
            "issuerActorKey": orchard["actor"], "areaM2": str(orchard["areaM2"]),
            "cropYear": design["cropYear"]})
        for event in orchard["events"]:
            put(event["id"], {"recordType": "Activity", "scope": orchard["id"],
                "scopeType": "farm", "issuerActorKey": orchard["actor"],
                "cropYear": design["cropYear"], **{key: event[key] for key in
                ("activity", "variable", "quantity", "unit", "source", "sourceCode")}})
    original = next(e for e in design["orchards"][0]["events"]
                    if e["id"] == design["correction"]["originalEvidenceId"])
    put(design["correction"]["replacementEvidenceId"], {
        "recordType": "Activity", "scope": design["orchards"][0]["id"], "scopeType": "farm",
        "issuerActorKey": design["orchards"][0]["actor"], "cropYear": design["cropYear"],
        **{key: original[key] for key in ("activity", "variable", "unit", "source", "sourceCode")},
        "quantity": design["correction"]["newQuantity"],
        "replacesEvidenceId": original["id"], "reason": design["correction"]["reason"]})
    for lot in design["lots"]:
        suffix = lot["id"].split("/")[-1]
        orchard = next(o for o in design["orchards"] if o["id"] == lot["orchard"])
        put("lot-" + suffix, {"recordType": "HarvestAndDelivery", "scope": lot["id"],
            "orchard": lot["orchard"], "issuerActorKey": orchard["actor"],
            "harvestedKg": lot["harvestKg"], "receivedKg": lot["harvestKg"],
            "cropYear": design["cropYear"]})
        put("transport-" + suffix, {"recordType": "Activity", "scope": lot["id"],
            "scopeType": "transport", "issuerActorKey": "transporter", "activity": "TRANSPORT",
            "variable": "TRANSPORT_DIESEL_L", "quantity": lot["transportDieselL"], "unit": "L",
            "source": "OperatorEntry", "sourceCode": "SYN-TRUCK-LOG-" + suffix})
    for batch in design["batches"]:
        suffix = batch["id"].split("/")[-1]
        for label, activity, variable, field, unit, source, source_code in [
            ("electricity", "MILL_PROCESSING", "MILL_ELECTRICITY_KWH", "electricityKWh", "kWh", "Meter", "ELEC-SUBMETER-01"),
            ("oil", "MILL_PROCESSING", "OIL_OUTPUT_L", "oilL", "L", "Meter", "OIL-METER-01"),
            ("pomace", "MILL_PROCESSING", "POMACE_KG", "pomaceKg", "kg", "Estimate", "SYN-POMACE-" + suffix),
            ("diesel", "BY_PRODUCT_HANDLING", "MILL_DIESEL_L", "byproductDieselL", "L", "OperatorEntry", "SYN-MILL-FUEL-" + suffix)]:
            put("mill-" + suffix + "-" + label, {"recordType": "Activity", "scope": batch["id"],
                "scopeType": "mill", "issuerActorKey": "mill", "activity": activity,
                "variable": variable, "quantity": batch[field], "unit": unit,
                "source": source, "sourceCode": source_code})
    index = {"algorithm": "sha256", "entries": entries, "fixtureCommitments": {}}
    for name in ("design.json", "factors.synthetic.json", "expectations.json"):
        raw = (ROOT / name).read_bytes()
        index["fixtureCommitments"][name] = hashlib.sha256(raw).hexdigest()
    (ROOT / "evidence-index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"syntheticEvidenceFiles": len(entries), "bytes": sum(e["bytes"] for e in entries)}))


if __name__ == "__main__":
    main()
