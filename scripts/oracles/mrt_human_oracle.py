#!/usr/bin/env python3
"""
Zill -- oracle vectors for the HUMAN mean radiant temperature of a standing person (the PHS t_r input).

Runs thermofeel 2.3.0 ``calculate_mean_radiant_temperature`` (Di Napoli et al. 2020, Int J Biometeorol 64:1233,
after Thorsson et al. 2007 / Kantor & Unger 2011: shortwave absorptivity 0.7, long-wave emissivity 0.97, angular
factor 0.5 for the upper and lower hemispheres, projected-area factor of a standing person
fp = 0.308*cos(h*(0.998 - h^2/50000)), h = solar elevation in degrees) on Abu-Dhabi-relevant radiation fields and
writes ``fixtures/mrt_human.json`` for ``src/engine/indices.test.ts`` (``humanMrtC``).

Why a human MRT: the Liljegren 2-inch black globe "sees" an MRT of ~94 C in full sun at 44 C / 950 W/m2, a standing
person ~74 C (docs/research/phs_iso7933.md section 10.3). ISO 7933 needs the human value.

Input mapping (Zill radiation field -> thermofeel ERA5 names), all fluxes in W/m2 -- explicit because thermofeel's
``fdir`` is a FLUX while Zill's ``fdir`` is the Liljegren direct-beam FRACTION:
  f      = Liljegren-preprocessed direct-beam fraction: clamp(fdir, 0, 0.9), and 0 when cos z < CZA_MIN = 0.00873
           (thermofeel/Liljegren pre-processing; src/engine/wbgt.ts preprocessFdir)
  ssrd   = GHI                                  surface solar radiation downwards
  fdir   = f * GHI                              total-sky direct solar radiation on the horizontal (thermofeel arg)
  dsrp   = f * GHI / cos z  (0 if f == 0)       direct radiation normal to the beam (DNI) -- the low-sun guard is f = 0
  ssr    = (1 - albedo) * GHI                   net solar  => reflected = ssrd - ssr = albedo * GHI
  strd   = eps_a(Ta, RH) * sigma_L * Ta^4       downward long-wave, Liljegren clear-sky emissivity (thermofeel
                                                liljegren.emis_atm = Oke 0.575*e^0.143), sigma_L = 5.6696e-8
  strr   = strd - eps_sfc * sigma_L * Tsfc^4    net long-wave => upward = eps_sfc*sigma_L*Tsfc^4, eps_sfc = 0.999,
                                                Tsfc = ground temperature (default Ta: Liljegren's surface assumption)
  cossza = cos z
thermofeel then returns  MRT^4 = (1/5.67e-8) * (0.5*strd + 0.5*lur + (0.7/0.97)*(0.5*dsw + 0.5*rsw + fp*dsrp)),
with dsw = ssrd - fdir (diffuse), rsw = ssrd - ssr (reflected), lur = strd - strr (upward long-wave).

Every thermofeel value is cross-checked against an independent scalar transliteration of the same equations
(``human_mrt_scalar`` below) before anything is written (pre-registered tolerance 1e-9 K).

Usage (from anywhere):
    python scripts/oracles/mrt_human_oracle.py              # writes fixtures/mrt_human.json
    python scripts/oracles/mrt_human_oracle.py --out X.json
Requires: numpy, thermofeel==2.3.0. Deterministic (no timestamps). Exit code 0 only if every check passes.
"""
from __future__ import annotations

import argparse
import json
import math
import platform
import sys
from pathlib import Path

import numpy as np
import thermofeel as tf
from thermofeel import liljegren as lj

THERMOFEEL_EXPECTED = "2.3.0"
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "fixtures" / "mrt_human.json"

ACCEPT_SCALAR_VS_THERMOFEEL_K = 1e-9

SIGMA_L = float(lj.STEFANB)  # 5.6696e-8, Liljegren long-wave fluxes
SIGMA_DN = 5.67e-8  # thermofeel / Di Napoli 2020 conversion constant
EMIS_SFC = float(lj.EMIS_SFC)  # 0.999
ALB_SFC = float(lj.ALB_SFC)  # 0.45
CZA_MIN = float(lj.CZA_MIN)  # 0.00873
FDIR_MAX = 0.9

# (id, description, ta_c, rh_pct, ghi_wm2, fdir_fraction, cos_zenith, ground_temp_c | None, albedo | None)
CASES = [
    ("phs_10_3", "phs_iso7933.md 10.3 point: 44 C / 20 % / 950 W/m2, fdir 0.85, cos z 0.95", 44.0, 20.0, 950.0, 0.85, 0.95, None, None),
    ("ad_noon_august", "Abu Dhabi August noon: 42 C / 35 %, 900 W/m2, fdir 0.75, cos z 0.98", 42.0, 35.0, 900.0, 0.75, 0.98, None, None),
    ("inland_noon_extreme", "inland 46.2 C / 13 %, 916 W/m2, fdir 0.73, cos z 0.997", 46.2, 13.0, 916.0, 0.73, 0.997, None, None),
    ("coastal_humid_morning", "coastal 34 C / 70 %, 450 W/m2, fdir 0.6, cos z 0.55", 34.0, 70.0, 450.0, 0.6, 0.55, None, None),
    ("mid_morning", "38 C / 40 %, 700 W/m2, fdir 0.7, cos z 0.8", 38.0, 40.0, 700.0, 0.7, 0.8, None, None),
    ("late_afternoon_low_sun", "low sun 39 C / 30 %, 120 W/m2, fdir 0.45, cos z 0.15", 39.0, 30.0, 120.0, 0.45, 0.15, None, None),
    ("grazing_sun", "grazing sun 33 C / 50 %, 20 W/m2, fdir 0.3, cos z 0.03", 33.0, 50.0, 20.0, 0.3, 0.03, None, None),
    ("below_cza_min", "cos z 0.005 < CZA_MIN: direct beam dropped (low-sun guard)", 32.0, 55.0, 4.0, 0.5, 0.005, None, None),
    ("overcast", "dusty overcast 37 C / 45 %, 350 W/m2, fdir 0.1, cos z 0.85", 37.0, 45.0, 350.0, 0.1, 0.85, None, None),
    ("fdir_clamped", "fdir 0.95 clamped to 0.9", 41.0, 25.0, 880.0, 0.95, 0.97, None, None),
    ("night_clear_dry", "clear night 33 C / 30 %", 33.0, 30.0, 0.0, 0.0, -0.4, None, None),
    ("night_humid", "humid night 31 C / 85 %", 31.0, 85.0, 0.0, 0.0, -0.2, None, None),
    ("hot_ground_60", "hot ground 60 C under strong sun", 44.0, 20.0, 950.0, 0.85, 0.95, 60.0, None),
    ("asphalt_albedo_0_1", "asphalt albedo 0.10, ground 65 C", 43.0, 25.0, 920.0, 0.8, 0.96, 65.0, 0.10),
    ("bright_ground_albedo_0_6", "bright concrete albedo 0.60", 42.0, 30.0, 900.0, 0.8, 0.95, None, 0.60),
    ("mild_november_noon", "mild November noon 29 C / 45 %, 650 W/m2, fdir 0.7, cos z 0.75", 29.0, 45.0, 650.0, 0.7, 0.75, None, None),
    ("winter_morning", "winter morning 22 C / 65 %, 300 W/m2, fdir 0.55, cos z 0.4", 22.0, 65.0, 300.0, 0.55, 0.4, None, None),
    ("cool_ground_night", "night with ground 5 K above air (stored heat)", 32.0, 60.0, 0.0, 0.0, -0.3, 37.0, None),
]


def preprocess_fdir(fdir: float, cza: float) -> float:
    """Liljegren / thermofeel pre-processing of the direct-beam fraction (src/engine/wbgt.ts preprocessFdir)."""
    if not (cza >= CZA_MIN):
        return 0.0
    return min(max(fdir, 0.0), FDIR_MAX)


def thermofeel_inputs(ta_c, rh_pct, ghi, fdir_frac, cza, tsfc_c, albedo):
    """The explicit ERA5-name mapping documented in the module docstring."""
    tk = ta_c + 273.15
    tsfc_k = tsfc_c + 273.15
    f = preprocess_fdir(fdir_frac, cza)
    emis = float(lj.emis_atm(np.array(tk), np.array(rh_pct / 100.0)))
    direct_h = f * ghi
    dni = direct_h / cza if f > 0 else 0.0
    strd = emis * SIGMA_L * tk**4
    lur = EMIS_SFC * SIGMA_L * tsfc_k**4
    return {
        "f_used": f,
        "emis_atm": emis,
        "ssrd": ghi,
        "ssr": (1.0 - albedo) * ghi,
        "dsrp": dni,
        "strd": strd,
        "fdir_flux": direct_h,
        "strr": strd - lur,
        "cossza": cza,
    }


def human_mrt_scalar(ta_c, rh_pct, ghi, fdir_frac, cza, tsfc_c, albedo):
    """Independent scalar transliteration (Thorsson 2007 / Di Napoli 2020) used to guard the mapping."""
    tk = ta_c + 273.15
    tsfc_k = tsfc_c + 273.15
    f = preprocess_fdir(fdir_frac, cza)
    e_hpa = (rh_pct / 100.0) * float(lj.esat(np.array(tk)))
    eps_a = 0.575 * e_hpa**0.143
    l_down = eps_a * SIGMA_L * tk**4
    l_up = EMIS_SFC * SIGMA_L * tsfc_k**4
    diffuse = (1.0 - f) * ghi
    reflected = albedo * ghi
    dni = f * ghi / cza if f > 0 else 0.0
    h = math.degrees(math.asin(max(-1.0, min(1.0, cza))))
    fp = 0.308 * math.cos(math.radians(h * (0.998 - h * h / 50000.0)))
    s = 0.5 * l_down + 0.5 * l_up + (0.7 / 0.97) * (0.5 * diffuse + 0.5 * reflected + fp * dni)
    return (s / SIGMA_DN) ** 0.25 - 273.15, fp


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()

    version = getattr(tf, "__version__", "unknown")
    if version != THERMOFEEL_EXPECTED:
        print(f"WARNING: thermofeel {version} != expected {THERMOFEEL_EXPECTED}", file=sys.stderr)

    cases = []
    worst = 0.0
    for cid, desc, ta, rh, ghi, fdir, cza, tsfc, alb in CASES:
        tsfc_c = ta if tsfc is None else tsfc
        albedo = ALB_SFC if alb is None else alb
        m = thermofeel_inputs(ta, rh, ghi, fdir, cza, tsfc_c, albedo)
        mrt_k = float(
            tf.calculate_mean_radiant_temperature(
                np.array(m["ssrd"]),
                np.array(m["ssr"]),
                np.array(m["dsrp"]),
                np.array(m["strd"]),
                np.array(m["fdir_flux"]),
                np.array(m["strr"]),
                np.array(m["cossza"]),
            )
        )
        mrt_c = mrt_k - 273.15
        scalar_c, fp = human_mrt_scalar(ta, rh, ghi, fdir, cza, tsfc_c, albedo)
        diff = abs(scalar_c - mrt_c)
        worst = max(worst, diff)
        inputs = {"ta_c": ta, "rh_pct": rh, "ghi_wm2": ghi, "fdir": fdir, "cos_zenith": cza}
        if tsfc is not None:
            inputs["ground_temp_c"] = tsfc
        if alb is not None:
            inputs["albedo"] = alb
        cases.append(
            {
                "id": cid,
                "desc": desc,
                "inputs": inputs,
                "thermofeel_args": {k: m[k] for k in ("ssrd", "ssr", "dsrp", "strd", "fdir_flux", "strr", "cossza")},
                "intermediates": {
                    "fdir_used": m["f_used"],
                    "emis_atm": m["emis_atm"],
                    "dni_wm2": m["dsrp"],
                    "fp": fp,
                    "ground_temp_used_c": tsfc_c,
                    "albedo_used": albedo,
                },
                "outputs": {"mrt_c": round(mrt_c, 9)},
                "abs_diff_vs_scalar_c": diff,
            }
        )

    if worst > ACCEPT_SCALAR_VS_THERMOFEEL_K:
        print(f"FAIL: scalar vs thermofeel max |diff| {worst:.3e} K > {ACCEPT_SCALAR_VS_THERMOFEEL_K}", file=sys.stderr)
        return 1

    doc = {
        "meta": {
            "title": "Zill human mean radiant temperature (standing person) oracle vectors",
            "generator": "scripts/oracles/mrt_human_oracle.py",
            "oracle": "thermofeel.calculate_mean_radiant_temperature (Di Napoli et al. 2020; Thorsson et al. 2007)",
            "consumer": "src/engine/indices.ts humanMrtC",
            "spec": "docs/research/phs_iso7933.md section 10.3 item 3",
            "environment": {
                "python": platform.python_version(),
                "numpy": np.__version__,
                "thermofeel": version,
            },
            "mapping": {
                "f": "clamp(fdir, 0, 0.9); 0 when cos z < 0.00873 (Liljegren low-sun guard)",
                "ssrd": "GHI",
                "fdir_flux": "f * GHI (thermofeel 'fdir' is a horizontal FLUX)",
                "dsrp": "f * GHI / cos z (DNI); 0 when f = 0",
                "ssr": "(1 - albedo) * GHI; albedo default 0.45 (Liljegren ground)",
                "strd": "emis_atm(Ta, RH) * 5.6696e-8 * Ta^4 (Liljegren sky)",
                "strr": "strd - 0.999 * 5.6696e-8 * Tsfc^4; Tsfc default Ta (Liljegren)",
                "cossza": "cos z",
            },
            "constants": {
                "sigma_longwave_fluxes": SIGMA_L,
                "sigma_mrt_conversion": SIGMA_DN,
                "emis_sfc": EMIS_SFC,
                "albedo_default": ALB_SFC,
                "cza_min": CZA_MIN,
                "fdir_max": FDIR_MAX,
                "shortwave_absorptivity": 0.7,
                "longwave_emissivity": 0.97,
                "angular_factor": 0.5,
            },
            "tolerance_c": 1e-6,
            "scalar_crosscheck_max_abs_diff_c": worst,
        },
        "cases": cases,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out} ({len(cases)} cases; scalar cross-check max |diff| {worst:.2e} K)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
