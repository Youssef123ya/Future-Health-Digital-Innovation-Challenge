#!/usr/bin/env python
"""Gagge two-node oracle vectors for Zill's simulation ground truth (src/sim/gagge.ts, src/sim/truth.ts).

Writes ``fixtures/gagge.json`` (path relative to the project root, two levels above this file's directory).

What it produces
----------------
* ``cases`` - constant-condition runs of the Gagge, Fobelets & Berglund (1986) two-node model as implemented by
  pythermalcomfort 4.8.1 ``two_nodes_gagge`` (``_gagge_two_nodes_optimized``), reported after several durations
  (1 ... 480 one-minute steps) from the model's neutral initial state.

  pythermalcomfort's public function always runs a fixed 59 one-minute iterations (``length_time_simulation = 60``
  with the loop starting at ``n_simulation = 1``). To get other durations this script takes the INSTALLED source of
  ``_gagge_two_nodes_optimized`` with ``inspect.getsource``, removes the numba decorator and replaces only the line
  ``length_time_simulation = 60`` by ``length_time_simulation = <steps> + 1``. Nothing else is touched. Before writing,
  the patched 59-step run is asserted to reproduce the official ``two_nodes_gagge(..., round_output=False)`` to
  < 1e-9 for every case (the difference is recorded in ``meta.self_check``).

* ``mrt`` - human mean radiant temperature from radiation fluxes by thermofeel 2.3.0
  ``calculate_mean_radiant_temperature`` (Di Napoli et al. 2020), used to check the flux formula in
  src/sim/truth.ts ``humanMrtFromFluxesC``.

Run (from anywhere):
    python scripts/oracles/gagge_oracle.py
Requires: pythermalcomfort 4.8.1 (numba, numpy), thermofeel 2.3.0. Deterministic: re-running reproduces the same
JSON on the same library versions.
"""
from __future__ import annotations

import importlib
import inspect
import json
import math
from pathlib import Path

import numpy as np
import pythermalcomfort
import thermofeel
from pythermalcomfort.models import two_nodes_gagge
from pythermalcomfort.psychrometrics import p_sat_torr

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "fixtures" / "gagge.json"

STEPS = [1, 2, 5, 10, 30, 59, 120, 240, 480]

OUTPUT_KEYS = [
    "t_core",
    "t_skin",
    "m_bl",
    "m_rsw",
    "w",
    "w_max",
    "e_skin",
    "e_rsw",
    "e_max",
    "q_sensible",
    "q_skin",
    "q_res",
]

# Index of each output in the tuple returned by _gagge_two_nodes_optimized (see the return statement upstream).
TUPLE_INDEX = {
    "e_skin": 1,
    "e_rsw": 2,
    "e_max": 3,
    "q_sensible": 4,
    "q_skin": 5,
    "q_res": 6,
    "t_core": 7,
    "t_skin": 8,
    "m_bl": 9,
    "m_rsw": 10,
    "w": 11,
    "w_max": 12,
}

BASE = {
    "wme": 0.0,
    "body_surface_area": 1.8258,
    "p_atm": 101325.0,
    "position": "standing",
    "max_skin_blood_flow": 90.0,
    "max_sweating": 500.0,
    "w_max": False,
}

CASES = [
    # id, overrides. Abu Dhabi-type hot cases plus the branches of the model (sitting, nude, shivering, pressure,
    # user-supplied limits).
    ("comfort_standing", dict(tdb=25.0, tr=25.0, v=0.1, rh=50.0, met=1.2, clo=0.5)),
    ("comfort_sitting", dict(tdb=25.0, tr=25.0, v=0.1, rh=50.0, met=1.2, clo=0.5, position="sitting")),
    ("rest_shade_30", dict(tdb=30.0, tr=33.0, v=0.5, rh=50.0, met=1.1, clo=0.6, body_surface_area=1.9)),
    ("hot_dry_sun_moderate", dict(tdb=42.0, tr=62.0, v=1.0, rh=20.0, met=3.5, clo=0.6, body_surface_area=1.9)),
    ("hot_humid_moderate", dict(tdb=35.0, tr=40.0, v=0.5, rh=70.0, met=3.0, clo=0.6, body_surface_area=1.8)),
    ("heavy_sun_coveralls", dict(tdb=40.0, tr=65.0, v=0.8, rh=30.0, met=5.0, clo=1.0, body_surface_area=2.0)),
    ("extreme_uncompensable", dict(tdb=46.0, tr=70.0, v=0.3, rh=35.0, met=6.0, clo=1.0, body_surface_area=1.85)),
    ("humid_extreme", dict(tdb=36.0, tr=38.0, v=0.3, rh=85.0, met=4.0, clo=0.6)),
    ("cool_shivering", dict(tdb=12.0, tr=12.0, v=1.5, rh=50.0, met=1.0, clo=0.3)),
    ("nude_warm", dict(tdb=38.0, tr=38.0, v=0.2, rh=40.0, met=1.5, clo=0.0)),
    ("low_pressure", dict(tdb=38.0, tr=50.0, v=0.7, rh=30.0, met=3.0, clo=0.6, p_atm=90000.0)),
    (
        "custom_limits",
        dict(tdb=44.0, tr=60.0, v=0.6, rh=25.0, met=4.5, clo=0.6, max_skin_blood_flow=80.0, max_sweating=700.0,
             w_max=0.85),
    ),
]


def patched_gagge(steps: int):
    """Upstream _gagge_two_nodes_optimized with only the simulation length changed (steps one-minute iterations)."""
    mod = importlib.import_module("pythermalcomfort.models.two_nodes_gagge")
    src = inspect.getsource(mod._gagge_two_nodes_optimized.py_func)
    lines = [ln for ln in src.splitlines() if not ln.lstrip().startswith("@")]
    src = "\n".join(lines)
    needle = "length_time_simulation = 60"
    assert src.count(needle) == 1, "upstream source changed: cannot patch the simulation length"
    src = src.replace(needle, f"length_time_simulation = {steps + 1}")
    ns = dict(vars(mod))
    exec(compile(src, f"<patched _gagge_two_nodes_optimized steps={steps}>", "exec"), ns)  # noqa: S102
    return ns["_gagge_two_nodes_optimized"]


def vapour_pressure_torr(tdb: float, rh: float) -> float:
    # Same expression as two_nodes_gagge: rh * p_sat_torr(tdb) / 100, p_sat_torr = exp(18.6686 - 4030.183/(t+235)).
    return float(rh * np.asarray(p_sat_torr(tdb)) / 100.0)


def run_patched(fn, c: dict) -> dict:
    w_max = c["w_max"] if c["w_max"] else None
    out = fn(
        c["tdb"], c["tr"], c["v"], c["met"], c["clo"], vapour_pressure_torr(c["tdb"], c["rh"]), c["wme"],
        c["body_surface_area"], c["p_atm"], c["position"], False, c["max_skin_blood_flow"], c["max_sweating"],
        w_max if w_max is not None else False,
    )
    return {k: float(out[i]) for k, i in TUPLE_INDEX.items()}


def run_official(c: dict) -> dict:
    r = two_nodes_gagge(
        tdb=c["tdb"], tr=c["tr"], v=c["v"], rh=c["rh"], met=c["met"], clo=c["clo"], wme=c["wme"],
        body_surface_area=c["body_surface_area"], p_atm=c["p_atm"], position=c["position"],
        max_skin_blood_flow=c["max_skin_blood_flow"], round_output=False, max_sweating=c["max_sweating"],
        w_max=c["w_max"],
    )
    return {k: float(np.asarray(getattr(r, k))) for k in OUTPUT_KEYS}


def build_cases() -> tuple[list, float]:
    fns = {s: patched_gagge(s) for s in STEPS}
    out = []
    worst = 0.0
    for cid, ov in CASES:
        c = {**BASE, **ov}
        official = run_official(c)
        p59 = run_patched(fns[59], c)
        for k in OUTPUT_KEYS:
            d = abs(official[k] - p59[k])
            worst = max(worst, d)
            assert d < 1e-9, f"{cid}: patched 59-step {k} differs from official by {d}"
        runs = []
        for s in STEPS:
            r = run_patched(fns[s], c)
            for k, v in r.items():
                assert math.isfinite(v), f"{cid} steps={s}: {k} not finite"
            runs.append({"steps": s, **r})
        out.append({"id": cid, "inputs": c, "official_59": official, "runs": runs})
    return out, worst


MRT_CASES = [
    # id, ssrd (GHI), albedo, fdir (direct horizontal), strd (LW down), lw_up, cossza
    ("noon_summer_hot_ground", 1000.0, 0.30, 860.0, 480.0, 690.0, 0.99),
    ("morning_low_sun", 450.0, 0.30, 330.0, 440.0, 560.0, 0.45),
    ("afternoon_mid_sun", 750.0, 0.25, 600.0, 470.0, 640.0, 0.70),
    ("overcast_diffuse", 300.0, 0.30, 20.0, 450.0, 520.0, 0.80),
    ("grazing_sun", 60.0, 0.30, 25.0, 420.0, 470.0, 0.05),
    ("night", 0.0, 0.30, 0.0, 400.0, 450.0, -0.20),
]


def build_mrt() -> list:
    out = []
    for cid, ghi, alb, fdir_h, strd, lw_up, cz in MRT_CASES:
        ssr = ghi * (1.0 - alb)  # net shortwave
        strr = strd - lw_up  # net thermal (down - up)
        dni = fdir_h / cz if cz > 0.01 else 0.0
        mrt_k = float(
            np.asarray(
                thermofeel.calculate_mean_radiant_temperature(
                    np.array([ghi]), np.array([ssr]), np.array([dni]), np.array([strd]), np.array([fdir_h]),
                    np.array([strr]), np.array([cz]),
                )
            )[0]
        )
        out.append(
            {
                "id": cid,
                "thermofeel_inputs": {"ssrd": ghi, "ssr": ssr, "dsrp": dni, "strd": strd, "fdir": fdir_h, "strr": strr,
                                      "cossza": cz},
                "fluxes": {"lwDownWm2": strd, "lwUpWm2": lw_up, "diffuseWm2": ghi - fdir_h, "reflectedWm2": ghi - ssr,
                           "dniWm2": dni, "cosZenith": cz},
                "mrt_k": mrt_k,
                "mrt_c": mrt_k - 273.15,
            }
        )
    return out


def main() -> None:
    cases, worst = build_cases()
    data = {
        "meta": {
            "generator": "scripts/oracles/gagge_oracle.py",
            "model": "Gagge, Fobelets & Berglund 1986 two-node model via pythermalcomfort two_nodes_gagge",
            "pythermalcomfort": pythermalcomfort.__version__,
            "thermofeel": getattr(thermofeel, "__version__", "unknown"),
            "numpy": np.__version__,
            "steps": STEPS,
            "official_steps": 59,
            "self_check": {
                "description": "max |patched 59-step - official two_nodes_gagge(round_output=False)| over all cases and outputs",
                "max_abs_diff": worst,
            },
            "units": {
                "t_core": "degC", "t_skin": "degC", "m_bl": "L/(m2 h)", "m_rsw": "g/(m2 h) evaporated regulatory sweat",
                "w": "-", "w_max": "-", "e_skin": "W/m2", "e_rsw": "W/m2", "e_max": "W/m2", "q_sensible": "W/m2",
                "q_skin": "W/m2", "q_res": "W/m2", "met": "met (x 58.2 W/m2)", "p_atm": "Pa",
            },
            "notes": [
                "Initial state is the model's neutral state: t_core 36.8, t_skin 33.7, m_bl 6.3, alfa 0.1, e_skin = 0.1*met, h_r 4.7.",
                "wme = 0 in every case: pythermalcomfort subtracts wme (in met) from a W/m2 balance, which src/sim/gagge.ts does not reproduce.",
                "mrt: thermofeel calculate_mean_radiant_temperature; dsrp = direct normal = fdir/cossza when cossza > 0.01.",
            ],
        },
        "cases": cases,
        "mrt": build_mrt(),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(cases)} cases x {len(STEPS)} durations, {len(data['mrt'])} MRT vectors); "
          f"self-check max diff {worst:.3e}")


if __name__ == "__main__":
    main()
