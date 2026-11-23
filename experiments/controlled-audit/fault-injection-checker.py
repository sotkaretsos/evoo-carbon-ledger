"""Randomized fault injection against the separately implemented checker (verify-evidence.py).

Each trial starts from the exported baseline state, claims and retrieved evidence of the
controlled experiment, applies one randomly chosen fault to a randomly chosen target (an
evidence file, an exported ledger record or a published claim) and runs the checker's case
evaluation. A trial counts as detected when the case FAILs with the fault's expected issue
code; unmodified control trials must PASS. Evidence and production sources are not changed:
file faults act on a temporary copy of the fixture, the other faults on in-memory copies.

Usage: python fault-injection-checker.py [--trials-per-class 100] [--seed 20261123]
Output: results/checker-fault-injection.json
"""
import argparse
import copy
import importlib.util
import json
import random
import shutil
import tempfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("reference_verifier", ROOT / "verify-evidence.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

CLASSES = {
    "C00": ("Control: unmodified baseline", None),
    "C01": ("Evidence file missing", "EVIDENCE_MISSING"),
    "C02": ("Evidence file bytes altered", "EVIDENCE_HASH_MISMATCH"),
    "C03": ("Exported event quantity differs from its evidence", "EVIDENCE_LEDGER_MISMATCH"),
    "C04": ("Exported event attributed to another actor or source", "SOURCE_IDENTITY_MISMATCH"),
    "C05": ("Exported lot mass differs from harvest or delivery evidence", "EVIDENCE_LEDGER_MISMATCH"),
    "C06": ("Batch mass or mixing shares inconsistent with delivered lots", "ALLOCATION_MISMATCH"),
    "C07": ("Published result altered", "ARITHMETIC_MISMATCH"),
    "C08": ("Claim missing or duplicated", "CLAIM_MISSING_OR_DUPLICATE"),
    "C09": ("Claim committed to another event revision", "REVISION_MISMATCH"),
    "C10": ("Claim computed with another factor-set version", "FACTOR_VERSION_MISMATCH"),
    "C11": ("Claim declared for another functional unit", "FUNCTIONAL_UNIT_MISMATCH"),
    "C12": ("Methodological status or limitation not disclosed", "METHODOLOGICAL_DISCLOSURE_MISMATCH"),
}


def baseline_case(audit):
    return copy.deepcopy(next(c for c in audit.expected["cases"] if c["id"] == "baseline_complete"))


def referenced_files():
    """Evidence files that the baseline state refers to. The case folder also holds the corrected
    record of the correction case, which is not part of the baseline state; altering or removing it
    leaves the baseline decision unchanged, as it should, so it is not used as a fault target."""
    audit = module.EvidenceAudit(ROOT)
    snap = audit.snapshots["baseline"]
    ids = {e["evidenceId"] for e in snap["events"]} | {o["evidenceId"] for o in snap["orchards"]} | {l["evidenceId"] for l in snap["lots"]}
    return sorted(Path(audit.by_id[i]["path"]).name for i in ids)


def trial(cls, rng):
    """Returns (target description, case result)."""
    if cls in ("C01", "C02"):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "fixture"
            shutil.copytree(ROOT, root, ignore=shutil.ignore_patterns("__pycache__"))
            directory = root / "results" / "case-evidence" / "baseline_complete"
            target = rng.choice(referenced_files())
            path = directory / target
            if cls == "C01":
                path.unlink()
                what = target + " removed"
            else:
                raw = bytearray(path.read_bytes())
                op = rng.choice(["replace", "insert", "truncate"])
                pos = rng.randrange(len(raw))
                if op == "replace":
                    old = raw[pos]
                    raw[pos] = rng.choice([c for c in b"0123456789abcdefghijklmnopqrstuvwxyz ,:" if c != old])
                elif op == "insert":
                    raw[pos:pos] = b" "
                else:
                    del raw[-1]
                path.write_bytes(bytes(raw))
                what = "%s: %s at byte %d" % (target, op, pos)
            audit = module.EvidenceAudit(root)
            return what, audit.case(baseline_case(audit))

    audit = module.EvidenceAudit(ROOT)
    snap = audit.snapshots["baseline"]  # ledger and claims snapshot of the baseline case
    what = "none"
    if cls == "C03":
        e = rng.choice([e for e in snap["events"] if e["status"] == 1])
        q = int(e["quantityMilli"])
        delta = rng.choice([-1, 1]) * rng.randint(1, max(1, q // 5))
        e["quantityMilli"] = str(max(1, q + delta))
        what = "event %s quantity %+d milli" % (e["evidenceId"], int(e["quantityMilli"]) - q)
    elif cls == "C04":
        e = rng.choice([e for e in snap["events"] if e["status"] == 1])
        if rng.random() < 0.5:
            others = [a["address"] for a in snap["actorRegistry"].values() if a["address"].lower() != e["actor"].lower()]
            e["actor"] = rng.choice(others)
            what = "event %s actor replaced" % e["evidenceId"]
        else:
            e["sourceId"] = "0x" + "%064x" % rng.getrandbits(256)
            what = "event %s source identifier replaced" % e["evidenceId"]
    elif cls == "C05":
        lot = rng.choice(snap["lots"])
        field = rng.choice(["harvestedMassG", "receivedMassG"])
        lot[field] = str(int(lot[field]) + rng.choice([-1, 1]) * rng.randint(1000, 500000))
        what = "lot %s %s changed" % (lot["id"], field)
    elif cls == "C06":
        b = rng.choice(snap["batches"])
        if rng.random() < 0.5:
            delta = rng.choice([-1, 1]) * rng.randint(1000, 500000)
            b["receivedMassG"] = str(int(b["receivedMassG"]) + delta)
            b["receptionMassG"] = b["receivedMassG"]
            what = "batch %s mass %+d g" % (b["id"], delta)
        else:
            k = rng.randint(2, 60)
            b["sharesPermille"] = [b["sharesPermille"][0] + k] + [b["sharesPermille"][1] - k] + b["sharesPermille"][2:]
            what = "batch %s shares shifted by %d permille" % (b["id"], k)
    elif cls == "C07":
        c = rng.choice(snap["claims"])
        field = rng.choice(["total.kgCO2eq", "total.perFU", "resultInput.totalMg", "resultInput.phaseMg"])
        if field == "total.kgCO2eq":
            c["report"]["total"]["kgCO2eq"] += round(rng.uniform(0.1, 50), 1)
        elif field == "total.perFU":
            c["report"]["total"]["perFU"] = round(c["report"]["total"]["perFU"] * rng.choice([0.9, 0.95, 1.05, 1.1]), 6)
        elif field == "resultInput.totalMg":
            c["resultInput"]["totalMg"] = str(int(c["resultInput"]["totalMg"]) + rng.randint(1, 5000))
        else:
            i = rng.randrange(3)
            c["resultInput"]["phaseMg"][i] = str(int(c["resultInput"]["phaseMg"][i]) + rng.randint(1, 5000))
        what = "claim %s/%s %s" % (c["batch"], c["allocationRule"], field)
    elif cls == "C08":
        i = rng.randrange(len(snap["claims"]))
        if rng.random() < 0.5:
            removed = snap["claims"].pop(i)
            what = "claim %s/%s removed" % (removed["batch"], removed["allocationRule"])
        else:
            snap["claims"].append(copy.deepcopy(snap["claims"][i]))
            what = "claim %s/%s duplicated" % (snap["claims"][i]["batch"], snap["claims"][i]["allocationRule"])
    elif cls == "C09":
        c = rng.choice(snap["claims"])
        c["report"]["snapshot"]["revisionDigest"] = "0x" + "%064x" % rng.getrandbits(256)
        what = "claim %s/%s revision digest replaced" % (c["batch"], c["allocationRule"])
    elif cls == "C10":
        c = rng.choice(snap["claims"])
        c["report"]["factorSet"]["version"] += rng.randint(1, 3)
        what = "claim %s/%s factor-set version changed" % (c["batch"], c["allocationRule"])
    elif cls == "C11":
        c = rng.choice(snap["claims"])
        c["report"]["functionalUnit"] = "EVOO_1KG_MILL_GATE"
        what = "claim %s/%s functional unit changed" % (c["batch"], c["allocationRule"])
    elif cls == "C12":
        c = rng.choice(snap["claims"])
        op = rng.choice(["status", "flag", "assessment"])
        if op == "status":
            c["resultInput"]["methodologicalStatus"] = 1
        elif op == "flag":
            c["resultInput"]["limitationFlags"] = int(c["resultInput"]["limitationFlags"]) & ~1024
        else:
            c["report"]["methodologicalAssessment"]["status"] = "AggregateLimited"
        what = "claim %s/%s %s" % (c["batch"], c["allocationRule"], op)
    return what, audit.case(baseline_case(audit))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--trials-per-class", type=int, default=100)
    parser.add_argument("--seed", type=int, default=20261123)
    args = parser.parse_args()
    rng = random.Random(args.seed)
    schedule = [c for c in CLASSES for _ in range(args.trials_per_class)]
    rng.shuffle(schedule)
    records = []
    for i, cls in enumerate(schedule, 1):
        what, result = trial(cls, rng)
        expected = CLASSES[cls][1]
        if expected is None:
            outcome = "pass" if result["decision"] == "PASS" else "false_alarm"
        elif result["decision"] == "FAIL" and expected in result["detections"]:
            outcome = "detected"
        elif result["decision"] == "FAIL":
            outcome = "detected_other_code"
        else:
            outcome = "missed"
        records.append({"trial": i, "class": cls, "target": what, "decision": result["decision"],
                        "detections": result["detections"], "outcome": outcome})
        if i % 100 == 0:
            print("%d/%d trials" % (i, len(schedule)))
    by_class = {}
    for cls, (label, expected) in CLASSES.items():
        rs = [r for r in records if r["class"] == cls]
        by_class[cls] = {"label": label, "expectedCode": expected, "trials": len(rs),
                         "outcomes": dict(Counter(r["outcome"] for r in rs)),
                         "coDetections": dict(Counter(code for r in rs for code in r["detections"] if code != expected))}
    faults = [r for r in records if r["class"] != "C00"]
    summary = {"seed": args.seed, "trials": len(records), "faultTrials": len(faults),
               "detected": sum(r["outcome"] == "detected" for r in faults),
               "detectedWithOtherCodeOnly": sum(r["outcome"] == "detected_other_code" for r in faults),
               "missed": sum(r["outcome"] == "missed" for r in faults),
               "controlTrials": len(records) - len(faults),
               "falseAlarms": sum(r["outcome"] == "false_alarm" for r in records),
               "scope": "Randomized single faults on the exported baseline state, claims and evidence of the controlled synthetic experiment; the checker is the one published in release 1.2.0"}
    out = {"summary": summary, "byClass": by_class, "records": records}
    (ROOT / "results" / "checker-fault-injection.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"summary": summary, "byClass": by_class}, indent=2))


if __name__ == "__main__":
    main()
