"""Monte Carlo propagation of the uncertain parameters of the case footprint.

The model reproduces Table S1 (parts 1-3 and 6): group results of the reference assessment for
soil preparation, fertilization, plant protection and transport; pruning and harvesting and mill
processing calculated from the recorded fuel and electricity. The uncertain inputs and their
distributions are stated in DISTRIBUTIONS; they are assumptions, documented with their basis,
because the case records give three-year means and the reference assessment reports no
uncertainty. Inputs are sampled independently.

Usage: python monte-carlo.py [--n 100000] [--seed 20261123]
Output: results/monte-carlo.json (next to this script)
Standard library only.
"""
import argparse
import json
import math
import random
import statistics
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Fixed inputs (Table S1, part 1)
A = 4.8                 # ha
OIL_L = 8894.0          # L per season (three-year mean)
RHO_D = 0.84            # kg L-1 diesel
V_PR, V_HV, V_TR = 50.0, 300.0, 70.0      # L petrol (chainsaws, beaters), L diesel (tractor)
V_SP, V_TM = 210.0, 100.0                  # L diesel, soil preparation and transport
EF_P = 69.3 * 44.3 / 1000                  # kg CO2 per kg petrol (IPCC 2006 defaults)
E_MILL = 5000.0         # kWh per season
Q_HAND = 0.00057        # kg diesel per L oil (by-product handling)
G_SP, G_FERT, G_PP, G_TR = 116.47, 2615.05, 45.13, 55.48   # group results, kg CO2eq ha-1 [26]
EF_GRID_REF = 0.345     # kg CO2eq kWh-1 (2022-2024 mean)
RHO_P_REF = 0.745

DISTRIBUTIONS = {
    "fertilization_multiplier": {"dist": "triangular", "low": 0.7, "mode": 1.0, "high": 1.3,
        "basis": "Group result without reported uncertainty; the +-30% stress-test bounds of Section 2.3 are used as the range, with the reference value most likely"},
    "grid_factor": {"dist": "triangular", "low": 0.30, "mode": 0.345, "high": 0.45, "unit": "kg CO2eq kWh-1",
        "basis": "Scenario range of Section 2.3; mode at the 2022-2024 mean of the Greek generation-based intensity"},
    "irrigation_kwh_per_ha": {"dist": "uniform", "low": 377.0, "high": 687.0, "unit": "kWh ha-1",
        "basis": "Orchard irrigated, pumping electricity not recorded; range between smart and conventional irrigation of Fotia et al. [10]"},
    "oil_yield_multiplier": {"dist": "triangular", "low": 0.9, "mode": 1.0, "high": 1.1,
        "basis": "Representativeness of the three-year mean oil output; season-level records were not used (assumption)"},
    "minor_group_multiplier": {"dist": "triangular", "low": 0.9, "mode": 1.0, "high": 1.1,
        "basis": "Soil preparation, plant protection and transport group results (5.5% of the total), varied together (assumption)"},
    "petrol_density": {"dist": "uniform", "low": 0.720, "high": 0.775, "unit": "kg L-1",
        "basis": "EN 228 range [27]"},
}


def sample(rng, d):
    if d["dist"] == "uniform":
        return rng.uniform(d["low"], d["high"])
    return rng.triangular(d["low"], d["high"], d["mode"])


def footprint(p, irrigation=True):
    d_int = (G_SP + G_TR) / ((V_SP + V_TM) * RHO_D / A)          # derived diesel intensity, kg CO2eq kg-1
    y_oil = OIL_L / A * p["oil_yield_multiplier"]                 # L ha-1
    minor = (G_SP + G_PP + G_TR) * p["minor_group_multiplier"]
    fert = G_FERT * p["fertilization_multiplier"]
    pruning_harvest = (V_PR + V_HV) * p["petrol_density"] / A * EF_P + V_TR * RHO_D / A * d_int
    mill = E_MILL / A * p["grid_factor"] + Q_HAND * y_oil * d_int
    irr = p["irrigation_kwh_per_ha"] * p["grid_factor"] if irrigation else 0.0
    return (minor + fert + pruning_harvest + mill + irr) / y_oil


def percentile(sorted_xs, q):
    k = (len(sorted_xs) - 1) * q
    f, c = math.floor(k), math.ceil(k)
    return sorted_xs[f] + (sorted_xs[c] - sorted_xs[f]) * (k - f)


def first_order_indices(inputs, ys, bins=50):
    """First-order sensitivity indices, Var(E[Y|X_i]) / Var(Y), estimated by quantile binning."""
    var_y = statistics.pvariance(ys)
    mean_y = statistics.fmean(ys)
    out = {}
    for name, xs in inputs.items():
        order = sorted(range(len(xs)), key=xs.__getitem__)
        size = len(order) // bins
        between = 0.0
        for b in range(bins):
            idx = order[b * size:(b + 1) * size if b < bins - 1 else len(order)]
            m = statistics.fmean(ys[i] for i in idx)
            between += len(idx) * (m - mean_y) ** 2
        out[name] = round(between / len(ys) / var_y, 4)
    return out


def summarize(ys, baseline):
    s = sorted(ys)
    return {"mean": round(statistics.fmean(s), 4), "median": round(percentile(s, 0.5), 4),
            "sd": round(statistics.pstdev(s), 4),
            "p2_5": round(percentile(s, 0.025), 4), "p5": round(percentile(s, 0.05), 4),
            "p95": round(percentile(s, 0.95), 4), "p97_5": round(percentile(s, 0.975), 4),
            "shareAboveBaseline": round(sum(y > baseline for y in s) / len(s), 4)}


def run(n, seed, dists, irrigation=True):
    rng = random.Random(seed)
    inputs = {k: [] for k in dists}
    ys = []
    for _ in range(n):
        p = {k: sample(rng, d) for k, d in dists.items()}
        for k in dists:
            inputs[k].append(p[k])
        ys.append(footprint(p, irrigation))
    return inputs, ys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=100000)
    ap.add_argument("--seed", type=int, default=20261123)
    args = ap.parse_args()
    ref = {"fertilization_multiplier": 1.0, "grid_factor": EF_GRID_REF, "irrigation_kwh_per_ha": 0.0,
           "oil_yield_multiplier": 1.0, "minor_group_multiplier": 1.0, "petrol_density": RHO_P_REF}
    baseline = footprint(ref, irrigation=False)
    results = {"baselineKgPerL": round(baseline, 4), "n": args.n, "seed": args.seed, "distributions": DISTRIBUTIONS,
               "independence": "Inputs sampled independently", "variants": {}}
    # Main analysis: irrigation electricity included (the orchard is irrigated).
    inputs, ys = run(args.n, args.seed, DISTRIBUTIONS, irrigation=True)
    results["variants"]["main_with_irrigation"] = {"description": "All uncertain inputs, including the unrecorded irrigation electricity",
        "kgCO2eqPerL": summarize(ys, baseline), "firstOrderIndices": first_order_indices(inputs, ys)}
    # Boundary as in the baseline (no irrigation electricity).
    d0 = {k: v for k, v in DISTRIBUTIONS.items() if k != "irrigation_kwh_per_ha"}
    inputs0, ys0 = run(args.n, args.seed, d0 | {"irrigation_kwh_per_ha": {"dist": "uniform", "low": 0.0, "high": 0.0}}, irrigation=False)
    results["variants"]["baseline_boundary"] = {"description": "Same distributions, irrigation electricity excluded as in the baseline",
        "kgCO2eqPerL": summarize(ys0, baseline), "firstOrderIndices": first_order_indices({k: v for k, v in inputs0.items() if k != "irrigation_kwh_per_ha"}, ys0)}
    # Distribution choice: uniform instead of triangular for the fertilization multiplier.
    du = DISTRIBUTIONS | {"fertilization_multiplier": {"dist": "uniform", "low": 0.7, "high": 1.3}}
    inputsu, ysu = run(args.n, args.seed, du, irrigation=True)
    results["variants"]["uniform_fertilization"] = {"description": "As main, fertilization multiplier uniform on 0.7-1.3",
        "kgCO2eqPerL": summarize(ysu, baseline), "firstOrderIndices": first_order_indices(inputsu, ysu)}
    out = HERE / "results"
    out.mkdir(exist_ok=True)
    (out / "monte-carlo.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: (v if k != "distributions" else "...") for k, v in results.items()}, indent=2))


if __name__ == "__main__":
    main()
