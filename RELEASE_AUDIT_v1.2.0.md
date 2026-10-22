# v1.2.0 reproducibility release checklist

**Status: incomplete — do not publish the `v1.2.0` tag yet.**

This audit compares the GitHub `main` branch at `ed3441f674b2` (22 October 2026) against the author-supplied `File_S1_evoo-carbon-ledger.zip` supplementary archive and the manuscript *An IoT-Enabled Blockchain Architecture for Auditable Carbon Footprint Traceability in Extra Virgin Olive Oil*.

## Confirmed

- The public README agrees with the manuscript for 107 tests, 83.61% branch coverage, ten safeguard mutations, 80 replay transactions, 15,015,970 replay gas, and the carbon-footprint results.
- Checked Git blob SHA-1 identities match the submitted archive for the README, SHA256SUMS, core contracts, case study, replay and gas reports, and controlled-audit documentation.
- The submitted ZIP contains 300 files, including 219 under `experiments/controlled-audit/`; the public checkout currently has **none** of those 219 files.
- `docs/.nojekyll` is also in the ZIP but missing from the checkout.
- Four files in the public checkout do not occur in this ZIP: `offchain/factor-sets/FS-2025-CONF.json`, `offchain/factor-sets/FS-2026-01.json`, `reports/evidence-manifest-v2.json`, and `reports/lca-report-v2.json`. Do not delete them without checking whether they are intentionally retained historical examples.
- The documented Git tag `v1.2.0` is not available on GitHub.
- The submitted `evoo-carbon-ledger_v1.2.0.bundle` passes `git bundle verify` in an initialized repository but **fails an independent `git clone`** because a parent commit object is missing. It must not be distributed as a portable clone until recreated and tested.

## Before release

1. Restore the complete `experiments/controlled-audit/` directory from the exact submitted supplementary ZIP into this review branch, maintaining relative paths and file bytes. Restore `docs/.nojekyll` if GitHub Pages needs it.
2. From the repository root, verify the archive manifest: `sha256sum -c SHA256SUMS` (or the equivalent on Windows). Verify or update it **only** when the restored files are intentionally modified.
3. Repeat the published checks: `npm ci`, `npm test`, `npm run coverage`, `npm run compile -- --force`, `npm run evaluate`, `npm run validate:inputs`, and `node scripts/mutation-check.js`.
4. Run the controlled experiment: `node node_modules/hardhat/internal/cli/cli.js run --no-compile experiments/controlled-audit/run-ledger.js`; `node experiments/controlled-audit/verify-commitments.js`; `python experiments/controlled-audit/verify-evidence.py`; `python experiments/controlled-audit/test-verifier.py`.
5. Compare regenerated values with the manuscript, particularly 54/54 reconstruction checks, 112/112 commitment checks, six predeclared decisions, and eight checker tests. Keep the unit as **kg CO2eq per litre**, not per kg.
6. When this branch contains the complete, verified release, merge into `main`; then create the annotated or lightweight `v1.2.0` tag at that final commit. Check that the manuscript's GitHub URL resolves to the tag.
7. If distributing a Git bundle, recreate it from a complete local repository with all reachable objects and **clone it into a fresh empty directory** as a final verification.

This checklist is an audit artifact, **not** a claim that the GitHub release is complete. Keep the existing `main` branch unchanged until the data restoration and test verification are finished.
