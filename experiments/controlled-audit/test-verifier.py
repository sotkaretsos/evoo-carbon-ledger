"""Targeted falsification tests for the separate evidence/arithmetic checker.

These alter an in-memory copy of actual exported claims/state, leaving fixture
evidence and production sources unchanged. They are not extra empirical cases.
"""
import copy
import importlib.util
import json
import unittest
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("reference_verifier", ROOT / "verify-evidence.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class VerifierFalsificationTests(unittest.TestCase):
    def setUp(self):
        self.audit = module.EvidenceAudit(ROOT)
        self.baseline = copy.deepcopy(self.audit.expected["cases"][0])

    def test_retrieved_complete_case_passes(self):
        result = self.audit.case(self.baseline)
        self.assertEqual((result["decision"], result["claimsCompared"]), ("PASS", 6))

    def test_published_total_perturbation_detected(self):
        self.audit.snapshots["baseline"]["claims"][0]["report"]["total"]["kgCO2eq"] += 1
        self.assertIn("ARITHMETIC_MISMATCH", self.audit.case(self.baseline)["detections"])

    def test_exported_quantity_disagrees_with_actual_bytes(self):
        event = self.audit.snapshots["baseline"]["events"][0]
        event["quantityMilli"] = str(int(event["quantityMilli"]) + 1000)
        result = self.audit.case(self.baseline)
        self.assertIn("EVIDENCE_LEDGER_MISMATCH", result["detections"])
        self.assertEqual(result["claimsCompared"], 0)

    def test_combined_engine_factor_is_not_reference_oracle(self):
        self.audit.factors["factors"]["SYN_COMPOUND"]["value"] = 999
        processes = self.audit.process_components({"quantity": "1", "variable": "COMPOUND_FERTILISER_KG"})
        self.assertEqual(processes["COMPOUND_MANUFACTURE"], Decimal("1.12"))
        self.assertEqual(processes["COMPOUND_DIRECT_N2O"], Decimal("0.88"))
        self.assertEqual(sum(processes.values()), Decimal("2"))

    def test_duplicate_claim_is_not_accepted(self):
        self.audit.snapshots["baseline"]["claims"].append(copy.deepcopy(self.audit.snapshots["baseline"]["claims"][0]))
        self.assertIn("CLAIM_MISSING_OR_DUPLICATE", self.audit.case(self.baseline)["detections"])

    def test_fractional_mg_rounds_up_at_half(self):
        self.assertEqual(module.rounded_mg(Decimal("0.0000005")), 1)
        self.assertEqual(module.rounded_mg(Decimal("0.000000499999")), 0)

    def test_corrected_evidence_changes_both_batch_burdens(self):
        case = next(c for c in self.audit.expected["cases"] if c["id"] == "corrected_quantity_recomputed")
        result = self.audit.case(case)
        rows = [r for r in result["reconstructions"] if r["allocationRule"] == "NONE_UNALLOCATED"]
        self.assertEqual([r["totalKg"] for r in rows], [Decimal("1824"), Decimal("1920")])

    def test_hash_correct_source_wrong_is_rejected(self):
        case = next(c for c in self.audit.expected["cases"] if c["id"] == "wrong_source_identity")
        result = self.audit.case(case)
        self.assertEqual(result["detections"], ["SOURCE_IDENTITY_MISMATCH"])
        self.assertEqual(result["verifiedFiles"], 28)


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(VerifierFalsificationTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    summary = {"testsRun": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
               "pass": result.wasSuccessful(), "scope": "Targeted checker falsification tests; not additional field observations or evaluation cases",
               "tests": unittest.defaultTestLoader.getTestCaseNames(VerifierFalsificationTests)}
    (ROOT / "results" / "verifier-tests.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    raise SystemExit(0 if result.wasSuccessful() else 1)
