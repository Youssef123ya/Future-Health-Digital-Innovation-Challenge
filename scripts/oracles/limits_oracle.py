#!/usr/bin/env python
"""Zill - occupational heat-limit oracle (NIOSH RAL/REL, ACGIH TLV/AL, ISO 7243 TWA, NWS heat index,
TB MED 507, OSHA heat-index risk levels / proposed-rule triggers, acclimatisation schedules).

Spec:   docs/research/limits_and_workrest.md
Output: fixtures/limits.json

Run (project venv):
    python scripts/oracles/limits_oracle.py

What it does
------------
1. Implements, from the primary texts, the closed-form rules the TypeScript engine must port
   (src/engine/limits.ts): NIOSH 2016 RAL/REL (= ACGIH Action Limit/TLV = ISO 7243:2017 Annex A
   equations), ACGIH screening-table construction, the allowed work fraction from a 1-h TWA,
   ISO 7243 Formula (4) time weighting, ACGIH body-mass scaling, NWS heat index (Rothfusz + both
   adjustments + simple formula), TB MED 507 (2022) category and fluid/work-rest lookups,
   OSHA heat-index risk levels, the OSHA 2024 NPRM triggers and the acclimatisation schedules.
2. Cross-checks the independent pieces:
   - re-derives every cell of ACGIH Table 2 (screening criteria) from the log equations and asserts
     equality with the published table (to the published 0.5 degC resolution);
   - asserts pythermalcomfort.work_capacity_niosh == own re-implementation;
   - asserts pythermalcomfort.heat_index_rothfusz == own Rothfusz polynomial (no NWS adjustments)
     converted to degC, and records where the full NWS algorithm differs from pythermalcomfort;
   - asserts published worked examples (ASSP 2022, CCOHS, NIOSH 2016) are reproduced;
   - compares the NWS algorithm with the NOAA chart printed in NIOSH 2016 Appendix C (135 cells) and
     the OSHA 'Heat Hazard Recognition' Table 2 with the RAL/REL equations.
3. Writes >= 15 reference vectors (in practice > 100) to fixtures/limits.json. NaN is written as null.

Only the standard library, numpy and pythermalcomfort are used. No network access.
"""
from __future__ import annotations

import json
import math
import platform
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pythermalcomfort
from pythermalcomfort.models import heat_index_rothfusz, work_capacity_iso, work_capacity_niosh

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "fixtures" / "limits.json"

# ----------------------------------------------------------------------------------------------
# Constants (see docs/research/limits_and_workrest.md "Port-ready constants")
# ----------------------------------------------------------------------------------------------
# NIOSH 2016-106 sec. 8.1 (verbatim): RAL [degC-WBGT] = 59.9 - 14.1 log10 M [W]
#                                      REL [degC-WBGT] = 56.7 - 11.5 log10 M [W]
# Identical to ACGIH Action Limit / TLV and ISO 7243:2017 Annex A reference equations.
RAL_A, RAL_B = 59.9, 14.1  # unacclimatised (NIOSH RAL = ACGIH AL = ISO WBGTref, unacclimatised)
REL_A, REL_B = 56.7, 11.5  # acclimatised   (NIOSH REL = ACGIH TLV = ISO WBGTref, acclimatised)

# ACGIH TLV Table 3 representative metabolic rates [W] (70 kg worker) and rest rate used in Table 2.
ACGIH_M_W = {"rest": 115.0, "light": 180.0, "moderate": 300.0, "heavy": 415.0, "very_heavy": 520.0}
ACGIH_M_REST_W = 115.0
# ACGIH Table 2 rows: allocation range -> work fraction used for the TWA ("upper limit of the range").
ACGIH_ROWS = [("75-100", 1.00), ("50-75", 0.75), ("25-50", 0.50), ("0-25", 0.25)]
ACGIH_CATS = ["light", "moderate", "heavy", "very_heavy"]
# Published ACGIH Table 2 (degC WBGT_eff). None = cell intentionally blank in the TLV booklet.
ACGIH_TABLE2_TLV = {
    "75-100": {"light": 31.0, "moderate": 28.0, "heavy": None, "very_heavy": None},
    "50-75": {"light": 31.0, "moderate": 29.0, "heavy": 27.5, "very_heavy": None},
    "25-50": {"light": 32.0, "moderate": 30.0, "heavy": 29.0, "very_heavy": 28.0},
    "0-25": {"light": 32.5, "moderate": 31.5, "heavy": 30.5, "very_heavy": 30.0},
}
ACGIH_TABLE2_AL = {
    "75-100": {"light": 28.0, "moderate": 25.0, "heavy": None, "very_heavy": None},
    "50-75": {"light": 28.5, "moderate": 26.0, "heavy": 24.0, "very_heavy": None},
    "25-50": {"light": 29.5, "moderate": 27.0, "heavy": 25.5, "very_heavy": 24.5},
    "0-25": {"light": 30.0, "moderate": 29.0, "heavy": 28.0, "very_heavy": 27.0},
}

# Clothing adjustment values (degC added to measured WBGT). ACGIH 2026 TLV Table 1 as reproduced by
# CCOHS (secondary); rows 2-7 also verified in the ACGIH TLV text hosted by Cal/OSHA (older edition).
ACGIH_CAV_C = {
    "short_sleeves_and_pants_woven": -1.0,  # 2026 table only (CCOHS); not in older editions
    "work_clothes_long_sleeve_shirt_and_pants": 0.0,
    "cloth_woven_coveralls": 0.0,
    "sms_polypropylene_coveralls": 0.5,
    "polyolefin_coveralls": 1.0,
    "double_layer_woven_clothing": 3.0,
    "limited_use_vapour_barrier_coveralls": 11.0,
}
ACGIH_HOOD_ADDITION_C = 1.0  # "Adding a hood (full head and neck covering; not face) +1" (ACGIH 2026 via CCOHS)

# TB MED 507 (12 Apr 2022) Table 3-2 / 3-3. WBGT category lower bounds in degF.
TBMED_CAT_LOWER_F = [(5, 90.0), (4, 88.0), (3, 85.0), (2, 82.0), (1, 78.0)]
TBMED_T32 = {  # Table 3-2: work/rest (min work/min rest per hour; "NL" = no limit) and water qt/h
    1: {"easy": ("NL", 0.5), "moderate": ("NL", 0.75), "heavy": ("40/20", 0.75), "very_heavy": ("20/40", 1.0)},
    2: {"easy": ("NL", 0.5), "moderate": ("NL", 0.75), "heavy": ("30/30", 1.0), "very_heavy": ("15/45", 1.0)},
    3: {"easy": ("NL", 0.75), "moderate": ("NL", 0.75), "heavy": ("30/30", 1.0), "very_heavy": ("10/50", 1.0)},
    4: {"easy": ("NL", 0.75), "moderate": ("50/10", 0.75), "heavy": ("20/40", 1.0), "very_heavy": ("10/50", 1.0)},
    5: {"easy": ("NL", 1.0), "moderate": ("20/40", 1.0), "heavy": ("15/45", 1.0), "very_heavy": ("10/50", 1.0)},
}
TBMED_T33 = {  # Table 3-3: continuous work limit (min; "NL") and water qt/h
    1: {"easy": ("NL", 0.5), "moderate": ("NL", 0.75), "heavy": (110, 0.75), "very_heavy": (45, 0.75)},
    2: {"easy": ("NL", 0.5), "moderate": ("NL", 1.0), "heavy": (70, 1.0), "very_heavy": (40, 1.0)},
    3: {"easy": ("NL", 0.75), "moderate": ("NL", 1.0), "heavy": (60, 1.0), "very_heavy": (25, 1.0)},
    4: {"easy": ("NL", 0.75), "moderate": (180, 1.25), "heavy": (50, 1.25), "very_heavy": (20, 1.25)},
    5: {"easy": ("NL", 1.0), "moderate": (70, 1.5), "heavy": (45, 1.5), "very_heavy": (20, 1.5)},
}
TBMED_WORK_W = {"easy": 250.0, "moderate": 425.0, "heavy": 600.0, "very_heavy": 800.0}
TBMED_MAX_QT_PER_H = 1.5
TBMED_MAX_QT_PER_DAY = 12.0

# NOAA heat index chart as printed in NIOSH 2016-106 Appendix C (p. 158, "Adapted from NOAA [2012]"):
# rows = RH %, columns = air temperature 80, 82, ... degF (rows end where the chart ends). degF values.
NOAA_CHART_F = {
    40: [80, 81, 83, 85, 88, 91, 94, 97, 101, 105, 109, 114, 119, 124, 130, 136],
    45: [80, 82, 84, 87, 89, 93, 96, 100, 104, 109, 114, 119, 124, 130, 137],
    50: [80, 83, 85, 88, 91, 95, 99, 103, 108, 113, 118, 124, 131, 137],
    55: [80, 84, 86, 89, 93, 97, 101, 106, 112, 117, 124, 130, 137],
    60: [82, 84, 88, 91, 95, 100, 105, 110, 116, 123, 129, 137],
    65: [82, 85, 89, 93, 98, 103, 108, 114, 121, 128, 136],
    70: [82, 86, 90, 95, 100, 105, 112, 119, 126, 134],
    75: [84, 88, 92, 97, 103, 109, 116, 124, 132],
    80: [84, 89, 94, 100, 106, 113, 121, 129],
    85: [84, 90, 96, 102, 110, 117, 126, 135],
    90: [86, 91, 98, 105, 113, 122, 131],
    95: [86, 93, 100, 108, 117, 127],
    100: [87, 95, 103, 112, 121, 132],
}
# OSHA "Heat Hazard Recognition" Table 2 ("adapted from NIOSH guidelines (2016)"), degC effective WBGT
OSHA_TABLE2_C = {"light": (28.0, 30.0), "moderate": (25.0, 28.0), "heavy": (23.0, 26.0), "very_heavy": (21.0, 25.0)}

US_QUART_L = 0.946352946  # exact: 1 US liquid quart = 57.75 in^3 = 0.946352946 L
US_FL_OZ_ML = 29.5735295625  # exact: 1/32 US quart
KCAL_H_TO_W = 4186.8 / 3600.0  # IT calorie: 1 kcal/h = 1.163 W (NIOSH 2016 text rounds to 1.16)


# ----------------------------------------------------------------------------------------------
# Core functions (port these)
# ----------------------------------------------------------------------------------------------
def ral_c(m_w: float) -> float:
    """NIOSH Recommended Alert Limit (unacclimatised), degC WBGT. M in W (total, not per m2)."""
    return RAL_A - RAL_B * math.log10(m_w)


def rel_c(m_w: float) -> float:
    """NIOSH Recommended Exposure Limit (acclimatised), degC WBGT. M in W."""
    return REL_A - REL_B * math.log10(m_w)


def round_half_up_to_half(x: float) -> float:
    """Round to the nearest 0.5 degC, ties away from -inf (half-up). ACGIH Table 2 resolution."""
    return math.floor(x * 2.0 + 0.5) / 2.0


def twa(values: list[float], minutes: list[float]) -> float:
    """ISO 7243:2017 Formula (4) / ACGIH / NIOSH time-weighted average: sum(p_i t_i) / sum(t_i)."""
    if len(values) != len(minutes) or not values:
        raise ValueError("values and minutes must be non-empty and equal length")
    total = sum(minutes)
    if total <= 0:
        raise ValueError("total time must be > 0")
    return sum(v * t for v, t in zip(values, minutes)) / total


def acgih_screening_cell(category: str, work_fraction: float) -> dict:
    """Re-derive an ACGIH Table 2 cell: TWA-M with rest at 115 W, then TLV/AL, then nearest 0.5 degC."""
    m_twa = work_fraction * ACGIH_M_W[category] + (1.0 - work_fraction) * ACGIH_M_REST_W
    tlv_raw = rel_c(m_twa)
    al_raw = ral_c(m_twa)
    return {
        "mTwaW": m_twa,
        "tlvRawC": tlv_raw,
        "alRawC": al_raw,
        "tlvRoundedC": round_half_up_to_half(tlv_raw),
        "alRoundedC": round_half_up_to_half(al_raw),
    }


def allowed_work_fraction(wbgt_work_c: float, wbgt_rest_c: float, m_work_w: float,
                          m_rest_w: float = ACGIH_M_REST_W, acclimatized: bool = True,
                          tol: float = 1e-12, max_iter: int = 200) -> dict:
    """Largest work fraction f in [0, 1] of each hour such that the 1-h TWA WBGT_eff does not exceed the
    limit evaluated at the 1-h TWA metabolic rate:
        g(f) = Limit(f*Mw + (1-f)*Mr) - (f*Ww + (1-f)*Wr) >= 0
    Limit = REL if acclimatised else RAL. g is convex in f (log10 of a linear function, minus a line),
    so if g(0) >= 0 > g(1) there is exactly one root; it is found by bisection.
    Returns f, the margin at f = 1 (Limit(Mw) - Ww) and the solver branch."""
    lim = rel_c if acclimatized else ral_c

    def g(f: float) -> float:
        return lim(f * m_work_w + (1.0 - f) * m_rest_w) - (f * wbgt_work_c + (1.0 - f) * wbgt_rest_c)

    margin_full = g(1.0)
    if margin_full >= 0.0:
        return {"f": 1.0, "marginAtFullWorkC": margin_full, "branch": "continuous_ok", "iterations": 0}
    if g(0.0) < 0.0:
        return {"f": 0.0, "marginAtFullWorkC": margin_full, "branch": "rest_exceeds_limit", "iterations": 0}
    lo, hi = 0.0, 1.0  # invariant: g(lo) >= 0 > g(hi)
    it = 0
    for it in range(1, max_iter + 1):
        mid = 0.5 * (lo + hi)
        if g(mid) >= 0.0:
            lo = mid
        else:
            hi = mid
        if hi - lo < tol:
            break
    return {"f": lo, "marginAtFullWorkC": margin_full, "branch": "bisection", "iterations": it}


def scale_metabolic_rate_by_mass(m_w: float, mass_kg: float) -> float:
    """ACGIH Table 3 footnote: multiply the estimated rate by actual body weight / 70 kg."""
    return m_w * mass_kg / 70.0


def f_to_c(t_f: float) -> float:
    return (t_f - 32.0) * 5.0 / 9.0


def c_to_f(t_c: float) -> float:
    return t_c * 9.0 / 5.0 + 32.0


def rothfusz_f(t_f: float, rh: float) -> float:
    """Rothfusz (1990, NWS SR 90-23) regression, degF. No adjustments."""
    T, R = t_f, rh
    return (-42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R - 0.00683783 * T * T
            - 0.05481717 * R * R + 0.00122874 * T * T * R + 0.00085282 * T * R * R
            - 0.00000199 * T * T * R * R)


def heat_index_nws_f(t_f: float, rh: float, threshold_rule: str = "text") -> dict:
    """NWS/WPC heat index algorithm (https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml).
    1) simple = 0.5*(T + 61.0 + (T-68.0)*1.2 + RH*0.094)  [already includes averaging with T]
    2) if simple >= 80 ("text" rule; the WPC calculator JavaScript uses simple > 79): Rothfusz, then
       - RH < 13 and 80 <= T <= 112: subtract ((13-RH)/4)*sqrt((17-|T-95|)/17)
       - RH > 85 and 80 <= T <= 87: add ((RH-85)/10)*((87-T)/5)
       else HI = simple."""
    simple = 0.5 * (t_f + 61.0 + (t_f - 68.0) * 1.2 + rh * 0.094)
    use_reg = simple >= 80.0 if threshold_rule == "text" else simple > 79.0
    if not use_reg:
        return {"hiF": simple, "branch": "simple", "simpleF": simple, "adjustmentF": 0.0}
    hi = rothfusz_f(t_f, rh)
    adj = 0.0
    branch = "rothfusz"
    if rh < 13.0 and 80.0 <= t_f <= 112.0:
        adj = -((13.0 - rh) / 4.0) * math.sqrt((17.0 - abs(t_f - 95.0)) / 17.0)
        branch = "rothfusz_low_rh_adj"
    elif rh > 85.0 and 80.0 <= t_f <= 87.0:
        adj = ((rh - 85.0) / 10.0) * ((87.0 - t_f) / 5.0)
        branch = "rothfusz_high_rh_adj"
    return {"hiF": hi + adj, "branch": branch, "simpleF": simple, "adjustmentF": adj}


def heat_index_nws_c(t_c: float, rh: float, threshold_rule: str = "text") -> dict:
    r = heat_index_nws_f(c_to_f(t_c), rh, threshold_rule)
    r = dict(r)
    r["hiC"] = f_to_c(r["hiF"])
    return r


def nws_hi_category(hi_f: float) -> str:
    """NWS classification (weather.gov): Caution 80-90, Extreme Caution 90-103, Danger 103-124,
    Extreme Danger >= 125 degF. Shared boundaries resolved upward (engineering choice)."""
    if hi_f >= 125.0:
        return "extreme_danger"
    if hi_f >= 103.0:
        return "danger"
    if hi_f >= 90.0:
        return "extreme_caution"
    if hi_f >= 80.0:
        return "caution"
    return "none"


def osha_hi_risk_level(hi_f: float) -> str:
    """OSHA heat-index risk levels (NIOSH 2016 Appendix C, Table C-1, adapted from OSHA 2012):
    <91 Lower (caution); 91-103 Moderate; 103-115 High; >115 Very high to extreme.
    Boundary 103 (listed in two bands) resolved to the higher band; 115 belongs to High."""
    if hi_f > 115.0:
        return "very_high_to_extreme"
    if hi_f >= 103.0:
        return "high"
    if hi_f >= 91.0:
        return "moderate"
    return "lower_caution"


def osha_nprm_trigger(hi_f: float | None = None, wbgt_c: float | None = None,
                      m_w: float | None = None) -> str:
    """OSHA NPRM 89 FR 70698 (proposed 29 CFR 1910.148(b)): initial heat trigger = HI 80 degF or WBGT
    equal to the NIOSH RAL; high heat trigger = HI 90 degF or WBGT equal to the NIOSH REL ("at or above").
    The employer chooses ONE metric; with WBGT the trigger depends on the metabolic rate M."""
    if hi_f is not None:
        if hi_f >= 90.0:
            return "high"
        if hi_f >= 80.0:
            return "initial"
        return "none"
    if wbgt_c is None or m_w is None:
        raise ValueError("give hi_f, or wbgt_c and m_w")
    if wbgt_c >= rel_c(m_w):
        return "high"
    if wbgt_c >= ral_c(m_w):
        return "initial"
    return "none"


def tbmed_category_from_f(wbgt_f: float) -> int:
    """TB MED 507 (2022) heat category: 1 = 78-81.9, 2 = 82-84.9, 3 = 85-87.9, 4 = 88-89.9, 5 = >90 degF.
    Implemented as half-open intervals [78,82), [82,85), [85,88), [88,90), [90,inf); 0 = below 78."""
    for cat, lower in TBMED_CAT_LOWER_F:
        if wbgt_f >= lower:
            return cat
    return 0


ACCLIM_SCHEDULES = {
    # fraction of usual exposure duration allowed on day d (1-based); beyond list -> 1.0
    "niosh_new_worker": [0.20, 0.40, 0.60, 0.80, 1.00],  # "no more than 20% ... day 1 and no more than 20% increase each additional day"
    "niosh_experienced_worker": [0.50, 0.60, 0.80, 1.00],
    "msha_new_miner": [0.50, 0.60, 0.70, 0.80, 0.90, 1.00],
    "msha_returning_after_9_days": [0.50, 0.60, 0.90, 1.00],
    "osha_nprm_new_employee": [0.20, 0.40, 0.60, 0.80, 1.00],  # option (B); first week
    "osha_nprm_returning_gt_14_days": [0.50, 0.60, 0.80, 1.00],  # option (B)
}


def acclimatization_fraction(schedule: str, day: int) -> float:
    s = ACCLIM_SCHEDULES[schedule]
    if day < 1:
        raise ValueError("day is 1-based")
    return s[day - 1] if day <= len(s) else 1.0


# ----------------------------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------------------------
def _clean(x):
    """JSON-safe conversion (numpy scalars -> python; NaN/inf -> None)."""
    if isinstance(x, dict):
        return {k: _clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_clean(v) for v in x]
    if isinstance(x, (np.floating, float)):
        xf = float(x)
        if math.isnan(xf) or math.isinf(xf):
            return None
        return 0.0 if xf == 0.0 else xf  # normalise -0.0
    if isinstance(x, np.integer):
        return int(x)
    if isinstance(x, np.ndarray):
        return _clean(x.tolist())
    return x


VECTORS: list[dict] = []
CHECKS: list[dict] = []
VECTOR_SUMMARY: dict = {}


def add(vid: str, group: str, fn: str, inputs: dict, expected: dict, tol: dict, source: str, note: str = "") -> None:
    VECTORS.append({"id": vid, "group": group, "fn": fn, "inputs": inputs, "expected": expected,
                    "tol": tol, "source": source, "note": note})


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append({"check": name, "pass": bool(ok), "detail": detail})
    if not ok:
        raise AssertionError(f"CHECK FAILED: {name} :: {detail}")


# ----------------------------------------------------------------------------------------------
# Vector generation
# ----------------------------------------------------------------------------------------------
def gen_ral_rel() -> None:
    src = "NIOSH 2016-106 sec 8.1: RAL = 59.9 - 14.1 log10 M; REL = 56.7 - 11.5 log10 M (M in W)"
    for m in [100.0, 115.0, 117.0, 180.0, 233.0, 300.0, 348.9, 415.0, 465.0, 520.0, 580.0, 600.0]:
        add(f"ral_rel_{m:g}W", "niosh_ral_rel", "ralC/relC", {"mW": m},
            {"ralC": ral_c(m), "relC": rel_c(m)}, {"abs": 1e-9}, src,
            "348.9 W = 300 kcal/h (NIOSH worked example)." if m == 348.9 else "")
    # NIOSH worked example (sec 1.1.3): text reads 27.8 degC (REL) and 25 degC (RAL) off the figures;
    # the equations give 27.46 and 24.05. The engine must use the equations.
    m = 348.9
    check("niosh_example_vs_equation", abs(rel_c(m) - 27.46) < 0.01 and abs(ral_c(m) - 24.05) < 0.01,
          f"REL(348.9)={rel_c(m):.3f} (doc figure reading 27.8), RAL={ral_c(m):.3f} (doc 25)")
    # ASSP PSJ Aug 2022 Math Toolbox worked answers (TLV/AL formulas stated identical to NIOSH/ISO).
    for name, f, m, pub in [("tlv_270W", rel_c, 270.0, 28.74), ("tlv_481W", rel_c, 481.0, 25.86),
                            ("al_270W", ral_c, 270.0, 25.62), ("al_115W", ral_c, 115.0, 30.84)]:
        val = f(m)
        check(f"assp2022_{name}", abs(val - pub) <= 0.005 + 1e-12, f"{val:.4f} vs published {pub}")
        add(f"assp2022_{name}", "niosh_ral_rel", "relC" if f is rel_c else "ralC", {"mW": m},
            {"valueC": val, "publishedC_2dp": pub}, {"abs": 0.005},
            "ASSP Professional Safety, Aug 2022, Math Toolbox (published worked answer, 2 dp)")


def gen_acgih_table() -> None:
    src = ("ACGIH TLV Heat Stress & Strain, Table 2 + notes (rest 115 W, mid-range Table 3 rate, "
           "work fraction = upper limit of range, nearest 0.5 degC). Published values: ACGIH text via "
           "Cal/OSHA docket; identical in CCOHS reproduction of 2026 TLVs and LBNL (2016 TLVs).")
    for row, frac in ACGIH_ROWS:
        for cat in ACGIH_CATS:
            c = acgih_screening_cell(cat, frac)
            pub_tlv = ACGIH_TABLE2_TLV[row][cat]
            pub_al = ACGIH_TABLE2_AL[row][cat]
            if pub_tlv is not None:
                check(f"acgih_tlv_{row}_{cat}", c["tlvRoundedC"] == pub_tlv,
                      f"derived {c['tlvRawC']:.3f}->{c['tlvRoundedC']} vs published {pub_tlv}")
            if pub_al is not None:
                check(f"acgih_al_{row}_{cat}", c["alRoundedC"] == pub_al,
                      f"derived {c['alRawC']:.3f}->{c['alRoundedC']} vs published {pub_al}")
            add(f"acgih_t2_{row}_{cat}", "acgih_screening_table", "acgihScreeningCell",
                {"category": cat, "allocation": row, "workFraction": frac},
                {**c, "publishedTlvC": pub_tlv, "publishedAlC": pub_al,
                 "screeningAvailable": pub_tlv is not None},
                {"abs": 1e-9}, src,
                "Published cell blank: screening not recommended -> detailed analysis / physiological monitoring."
                if pub_tlv is None else "")


def gen_allowed_fraction() -> None:
    src = ("Derived: NIOSH/ACGIH 1-h TWA of WBGT_eff and M compared with REL/RAL(M_TWA); "
           "rest M = 115 W (ACGIH Table 2 basis). Solved by bisection (tol 1e-12).")
    cases = [
        # (id, Ww, Wr, Mw, acclimatized, note)
        ("mod_accl_same_env_29.05", 29.0509, 29.0509, 300.0, True, "Same WBGT at work/rest: TLV at f=0.75 is 29.05 degC -> f ~ 0.75"),
        ("mod_accl_cont_ok", 27.0, 27.0, 300.0, True, "REL(300)=28.21 >= 27 -> continuous work, margin 1.21 degC"),
        ("mod_unaccl_sun30_shade28", 30.0, 28.0, 300.0, False, "Unacclimatised, rest in shade 2 degC cooler"),
        ("heavy_accl_sun31_shade27", 31.0, 27.0, 415.0, True, "Acclimatised heavy work, shade rest 4 degC cooler"),
        ("vheavy_accl_sun33_shade29", 33.0, 29.0, 520.0, True, "Very heavy, Abu Dhabi-like summer midday"),
        ("light_unaccl_sun34_shade34", 34.0, 34.0, 180.0, False, "Rest WBGT above RAL(115)=30.84 -> f = 0"),
        ("mod_accl_sun32_shade25", 32.0, 25.0, 300.0, True, "Air-conditioned/shaded rest strongly cooler"),
        ("light_accl_sun31_shade31", 31.0, 31.0, 180.0, True, "REL(180)=30.76 < 31 -> partial"),
    ]
    for vid, ww, wr, mw, acc, note in cases:
        r = allowed_work_fraction(ww, wr, mw, acclimatized=acc)
        add(f"awf_{vid}", "allowed_work_fraction", "allowedWorkFraction",
            {"wbgtWorkC": ww, "wbgtRestC": wr, "mWorkW": mw, "mRestW": ACGIH_M_REST_W, "acclimatized": acc},
            {"f": r["f"], "workMinPerHour": 60.0 * r["f"], "marginAtFullWorkC": r["marginAtFullWorkC"],
             "branch": r["branch"]}, {"abs": 1e-6}, src, note)
    r = allowed_work_fraction(29.0509, 29.0509, 300.0, acclimatized=True)
    check("awf_consistent_with_acgih_75pct", abs(r["f"] - 0.75) < 0.001, f"f={r['f']:.5f}")


def gen_twa_and_scaling() -> None:
    # CCOHS worked example: 0.5 h @25, 1.0 h @27, 0.5 h @28 -> 26.75 degC (2-h job)
    v = twa([25.0, 27.0, 28.0], [30.0, 60.0, 30.0])
    check("ccohs_twa_example", abs(v - 26.75) < 1e-12, f"{v}")
    add("twa_ccohs_example", "twa", "twa", {"values": [25.0, 27.0, 28.0], "minutes": [30.0, 60.0, 30.0]},
        {"value": v}, {"abs": 1e-12}, "CCOHS OSH Answers 'Hot Environments - Assessment and Control Measures' TWA example")
    # 1-h TWA of M: 40 min moderate (300 W) + 20 min rest (115 W)
    v = twa([300.0, 115.0], [40.0, 20.0])
    add("twa_metabolic_40_20", "twa", "twa", {"values": [300.0, 115.0], "minutes": [40.0, 20.0]},
        {"value": v, "relAtTwaC": rel_c(v), "ralAtTwaC": ral_c(v)}, {"abs": 1e-9},
        "ISO 7243:2017 Formula (4)/(5) with T = 1 h; NIOSH/ACGIH 1-h TWA")
    # 1-h TWA of WBGT_eff: 45 min in sun 31.2 + 15 min shade 28.4
    v = twa([31.2, 28.4], [45.0, 15.0])
    add("twa_wbgt_45_15", "twa", "twa", {"values": [31.2, 28.4], "minutes": [45.0, 15.0]}, {"value": v},
        {"abs": 1e-12}, "ISO 7243:2017 Formula (4)")
    # ACGIH body-mass scaling, ASSP 2022 worked answers
    for m, kg, pub in [(180.0, 110.0, 282.86), (415.0, 87.0, 515.79)]:
        s = scale_metabolic_rate_by_mass(m, kg)
        check(f"assp2022_mass_{kg:g}", abs(s - pub) <= 0.005 + 1e-12, f"{s:.4f} vs {pub}")
        add(f"mass_scale_{m:g}W_{kg:g}kg", "metabolic_scaling", "scaleMetabolicRateByMass",
            {"mW": m, "massKg": kg}, {"mW": s, "publishedW_2dp": pub}, {"abs": 0.005},
            "ACGIH TLV Table 3 footnote; ASSP PSJ Aug 2022 worked answers")
    # kcal/h -> W
    add("kcalh_300_to_W", "units", "kcalPerHourToW", {"kcalPerH": 300.0}, {"w": 300.0 * KCAL_H_TO_W},
        {"abs": 1e-9}, "1 kcal(IT)/h = 4186.8/3600 W = 1.163 W (NIOSH example: 300 kcal/h = 348.9 W)")
    check("kcal_example", abs(300.0 * KCAL_H_TO_W - 348.9) < 0.01, f"{300.0 * KCAL_H_TO_W:.4f}")


def gen_clothing() -> None:
    src = "ACGIH 2026 TLV Table 1 (CAV) as reproduced by CCOHS; WBGT_eff = WBGT + CAV (ISO 7243:2017 eq. 3)"
    cases = [("double_layer_28", 28.0, "double_layer_woven_clothing", False),
             ("double_layer_30", 30.0, "double_layer_woven_clothing", False),
             ("vapour_barrier_20", 20.0, "limited_use_vapour_barrier_coveralls", False),
             ("polyolefin_hood_25", 25.0, "polyolefin_coveralls", True),
             ("short_sleeves_31", 31.0, "short_sleeves_and_pants_woven", False)]
    for vid, w, cloth, hood in cases:
        cav = ACGIH_CAV_C[cloth] + (ACGIH_HOOD_ADDITION_C if hood else 0.0)
        weff = w + cav
        # screening outcome for moderate work, acclimatised (highest allocation row whose TLV >= WBGT_eff)
        allowed = None
        for row, _frac in ACGIH_ROWS:
            lim = ACGIH_TABLE2_TLV[row]["moderate"]
            if lim is not None and weff <= lim:
                allowed = row
                break
        add(f"cav_{vid}", "clothing", "wbgtEffective", {"wbgtC": w, "clothing": cloth, "hood": hood},
            {"cavC": cav, "wbgtEffC": weff, "acgihModerateAcclimatizedAllocation": allowed}, {"abs": 1e-12}, src,
            "CCOHS example: 28 + 3 = 31 -> 0-25% work; 30 + 3 = 33 -> above all screening values."
            if vid.startswith("double_layer") else "")
    check("ccohs_cav_example", (28.0 + ACGIH_CAV_C["double_layer_woven_clothing"]) == 31.0, "28+3=31")


def gen_work_capacity_pythermalcomfort() -> None:
    src_n = f"pythermalcomfort {pythermalcomfort.__version__} work_capacity_niosh (Brode et al. 2018 NIOSH-based)"
    src_i = f"pythermalcomfort {pythermalcomfort.__version__} work_capacity_iso (Brode et al. 2018 linear ISO fit)"
    pts = [(26.0, 300.0), (28.0, 300.0), (30.0, 300.0), (32.0, 300.0), (30.0, 180.0), (29.0, 415.0),
           (31.0, 520.0), (33.5, 300.0)]
    for wbgt, met in pts:
        cn = float(work_capacity_niosh(wbgt=wbgt, met=met).capacity)
        ci = float(work_capacity_iso(wbgt=wbgt, met=met).capacity)
        # own re-implementation (rest 117 W as in pythermalcomfort)
        lim, lim_r = rel_c(met), rel_c(117.0)
        own_n = min(100.0, max(0.0, (lim_r - wbgt) / (lim_r - lim) * 100.0))
        lim_i, lim_ri = 34.9 - met / 46.0, 34.9 - 117.0 / 46.0
        own_i = min(100.0, max(0.0, (lim_ri - wbgt) / (lim_ri - lim_i) * 100.0))
        check(f"wc_niosh_{wbgt}_{met}", abs(cn - own_n) < 1e-9, f"ptc {cn} own {own_n}")
        check(f"wc_iso_{wbgt}_{met}", abs(ci - own_i) < 1e-9, f"ptc {ci} own {own_i}")
        add(f"wc_niosh_{wbgt:g}C_{met:g}W", "work_capacity_pythermalcomfort", "workCapacityNiosh",
            {"wbgtC": wbgt, "mW": met}, {"capacityPct": cn}, {"abs": 1e-9}, src_n,
            "capacity = clip((REL(117)-WBGT)/(REL(117)-REL(M))*100, 0, 100)")
        add(f"wc_iso_{wbgt:g}C_{met:g}W", "work_capacity_pythermalcomfort", "workCapacityIsoBrode",
            {"wbgtC": wbgt, "mW": met}, {"capacityPct": ci}, {"abs": 1e-9}, src_i,
            "limit = 34.9 - M/46 (NOT an ISO 7243 equation; linear fit used by Brode et al. 2018)")


def gen_heat_index() -> None:
    src = "NWS/WPC heat index equation page (Rothfusz 1990 SR 90-23 + adjustments + Steadman simple formula)"
    cases_f = [
        ("simple_70F_50", 70.0, 50.0, "simple branch (<80)"),
        ("rothfusz_90F_50", 90.0, 50.0, ""),
        ("rothfusz_96F_65", 96.0, 65.0, ""),
        ("rothfusz_104F_40", 104.0, 40.0, ""),
        ("lowrh_100F_10", 100.0, 10.0, "low-RH adjustment subtracted"),
        ("lowrh_112F_5", 112.0, 5.0, "low-RH adjustment; T at upper bound 112 (inclusive)"),
        ("highrh_82F_95", 82.0, 95.0, "high-RH adjustment added"),
        ("highrh_87F_90", 87.0, 90.0, "high-RH adjustment = 0 at T = 87 (inclusive bound)"),
        ("abudhabi_113F_15", 113.0, 15.0, "45 degC / 15% RH: outside low-RH adj range (T > 112)"),
        ("abudhabi_104F_45", 104.0, 45.0, "40 degC / 45% RH"),
        ("humid_95F_70", 95.0, 70.0, ""),
        ("edge_80F_40", 80.0, 40.0, "simple = 79.88 -> simple branch under both rules"),
    ]
    for vid, t, rh, note in cases_f:
        r = heat_index_nws_f(t, rh)
        add(f"hi_nws_{vid}", "heat_index_nws", "heatIndexNwsF", {"tF": t, "rhPct": rh},
            {"hiF": r["hiF"], "hiC": f_to_c(r["hiF"]), "branch": r["branch"], "simpleF": r["simpleF"],
             "adjustmentF": r["adjustmentF"], "nwsCategory": nws_hi_category(r["hiF"]),
             "oshaRiskLevel": osha_hi_risk_level(r["hiF"])}, {"abs": 1e-9}, src, note)
    # threshold-rule disagreement case: simple between 79 and 80
    t, rh = 78.0, 86.0
    a = heat_index_nws_f(t, rh, "text")
    b = heat_index_nws_f(t, rh, "js")
    check("hi_threshold_rules_differ", a["branch"] == "simple" and b["branch"].startswith("rothfusz"),
          f"text {a} js {b}")
    add("hi_nws_threshold_variant_78F_86", "heat_index_nws", "heatIndexNwsF", {"tF": t, "rhPct": rh},
        {"hiF_textRule": a["hiF"], "hiF_jsRule": b["hiF"], "simpleF": a["simpleF"],
         "branch_textRule": a["branch"], "branch_jsRule": b["branch"]}, {"abs": 1e-9}, src,
        "Equation page: regression if simple >= 80; WPC calculator JS: if simple > 79. Engine uses the text rule.")
    # degC inputs (engine-facing)
    for t_c, rh in [(27.0, 40.0), (30.0, 60.0), (35.0, 50.0), (38.0, 30.0), (40.0, 20.0), (42.0, 10.0),
                    (45.0, 8.0), (28.0, 90.0), (33.0, 75.0), (46.0, 15.0)]:
        r = heat_index_nws_c(t_c, rh)
        ptc = float(heat_index_rothfusz(tdb=t_c, rh=rh, round_output=False, limit_inputs=True).hi)
        cat_ptc = str(heat_index_rothfusz(tdb=t_c, rh=rh, round_output=False, limit_inputs=True).stress_category)
        roth_only_c = f_to_c(rothfusz_f(c_to_f(t_c), rh))
        check(f"ptc_equals_rothfusz_only_{t_c}_{rh}", abs(ptc - roth_only_c) < 2e-5,
              f"ptc {ptc} vs rothfusz-only {roth_only_c}")
        add(f"hi_c_{t_c:g}C_{rh:g}", "heat_index_nws", "heatIndexNwsC", {"tC": t_c, "rhPct": rh},
            {"hiC": r["hiC"], "hiF": r["hiF"], "branch": r["branch"],
             "rothfuszOnlyC": roth_only_c, "pythermalcomfortHiC": ptc,
             "pythermalcomfortCategory": cat_ptc,
             "nwsMinusPythermalcomfortC": r["hiC"] - ptc,
             "nwsCategory": nws_hi_category(r["hiF"]), "oshaRiskLevel": osha_hi_risk_level(r["hiF"])},
            {"abs": 1e-6}, src + f"; pythermalcomfort {pythermalcomfort.__version__} heat_index_rothfusz",
            "pythermalcomfort = Rothfusz polynomial in degC WITHOUT NWS adjustments/simple branch; "
            "valid only tdb >= 27 degC (else NaN). Do not port pythermalcomfort's version as 'NWS HI'.")
    # pythermalcomfort below 27 degC -> NaN (it emits a UserWarning by design; silenced here)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        ptc_low = float(heat_index_rothfusz(tdb=25.0, rh=50.0, round_output=False).hi)
    check("ptc_nan_below_27C", math.isnan(ptc_low), f"{ptc_low}")
    r = heat_index_nws_c(25.0, 50.0)
    add("hi_c_25C_50_ptc_nan", "heat_index_nws", "heatIndexNwsC", {"tC": 25.0, "rhPct": 50.0},
        {"hiC": r["hiC"], "branch": r["branch"], "pythermalcomfortHiC": None}, {"abs": 1e-9}, src,
        "pythermalcomfort returns NaN (limit_inputs=True, tdb < 27 degC); NWS simple formula still defined.")


def gen_noaa_chart_crosscheck() -> None:
    """The NOAA chart printed in NIOSH 2016 App. C matches the bare Rothfusz polynomial (no NWS
    adjustments) to +/-1 degF in every cell; the full NWS algorithm differs by 2 degF in the two
    80 degF / RH >= 95 % cells (high-RH adjustment)."""
    src = "NIOSH 2016-106 Appendix C chart (adapted from NOAA 2012) vs NWS algorithm"
    n = roth_within1 = full_within1 = roth_exact = full_exact = 0
    worst_full = (0.0, None)
    for rh, row in NOAA_CHART_F.items():
        for i, chart_val in enumerate(row):
            t = 80.0 + 2.0 * i
            full = heat_index_nws_f(t, rh)["hiF"]
            roth = rothfusz_f(t, rh)
            n += 1
            roth_exact += int(round(roth) == chart_val)
            full_exact += int(round(full) == chart_val)
            roth_within1 += int(abs(round(roth) - chart_val) <= 1)
            full_within1 += int(abs(round(full) - chart_val) <= 1)
            d = abs(full - chart_val)
            if d > worst_full[0]:
                worst_full = (d, (t, rh, chart_val, full))
    check("noaa_chart_rothfusz_within_1F", roth_within1 == n, f"{roth_within1}/{n} cells (exact {roth_exact})")
    check("noaa_chart_full_nws_within_1F_except_highRH", full_within1 >= n - 2,
          f"{full_within1}/{n} cells (exact {full_exact}); worst {worst_full}")
    for t, rh in [(90.0, 50.0), (96.0, 65.0), (104.0, 40.0), (100.0, 50.0), (86.0, 85.0), (80.0, 100.0),
                  (80.0, 95.0), (110.0, 40.0)]:
        chart_val = NOAA_CHART_F[int(rh)][int((t - 80) / 2)]
        full = heat_index_nws_f(t, rh)
        add(f"noaa_chart_{t:g}F_{rh:g}", "heat_index_chart_crosscheck", "heatIndexNwsF", {"tF": t, "rhPct": rh},
            {"chartF": chart_val, "nwsFullF": full["hiF"], "nwsBranch": full["branch"],
             "rothfuszOnlyF": rothfusz_f(t, rh)}, {"abs": 1e-9, "chartAbsAfterRounding": 1.0}, src,
            "Chart omits the high-RH adjustment" if full["branch"] == "rothfusz_high_rh_adj" else "")
    VECTOR_SUMMARY["noaa_chart"] = {"cells": n, "rothfusz_exact": roth_exact, "rothfusz_within_1F": roth_within1,
                                    "nws_full_exact": full_exact, "nws_full_within_1F": full_within1}


def gen_osha_table2_reference() -> None:
    """OSHA 'Heat Hazard Recognition' Table 2 (adapted from NIOSH 2016) vs the RAL/REL equations at the
    ACGIH representative rates. The published whole-degree values are neither a consistent floor nor a
    consistent round of the equation values -> the engine must compute from the equations."""
    src = "OSHA Heat Hazard Recognition page, Table 2 'adapted from NIOSH guidelines (2016)' (accessed 2026-11-09)"
    for cat, (al_pub, tlv_pub) in OSHA_TABLE2_C.items():
        m = ACGIH_M_W[cat]
        ral, rel = ral_c(m), rel_c(m)
        check(f"osha_table2_{cat}_within_1C", abs(ral - al_pub) < 1.0 and abs(rel - tlv_pub) < 1.0,
              f"RAL {ral:.2f} vs {al_pub}; REL {rel:.2f} vs {tlv_pub}")
        add(f"osha_table2_{cat}", "osha_table2_reference", "ralC/relC", {"category": cat, "mW": m},
            {"ralC": ral, "relC": rel, "oshaPublishedActionLimitC": al_pub, "oshaPublishedTlvC": tlv_pub},
            {"abs": 1e-9}, src, "Published values are whole-degree simplifications; use the equations.")


def gen_lookups() -> None:
    src_tb = "TB MED 507 (12 Apr 2022) Table 3-2/3-3 and Figure 3-3"
    for wf in [77.9, 78.0, 81.9, 81.95, 82.0, 84.9, 85.0, 87.9, 88.0, 89.9, 89.95, 90.0, 95.0]:
        add(f"tbmed_cat_{wf:g}F", "tbmed507", "tbmed507Category", {"wbgtF": wf, "wbgtC": f_to_c(wf)},
            {"category": tbmed_category_from_f(wf)}, {"exact": True}, src_tb,
            "Gap values (e.g. 81.95, 89.95) resolved by half-open intervals [78,82),[82,85),[85,88),[88,90),[90,inf)."
            if wf in (81.95, 89.95) else "")
    for wc in [25.0, 25.6, 27.8, 29.4, 31.1, 32.2, 35.0]:
        add(f"tbmed_cat_{wc:g}C", "tbmed507", "tbmed507Category", {"wbgtC": wc, "wbgtF": c_to_f(wc)},
            {"category": tbmed_category_from_f(c_to_f(wc))}, {"exact": True}, src_tb, "Convert degC -> degF first.")
    for cat, lvl in [(1, "heavy"), (3, "moderate"), (4, "moderate"), (5, "easy"), (5, "very_heavy")]:
        wr, qt = TBMED_T32[cat][lvl]
        cw, cqt = TBMED_T33[cat][lvl]
        add(f"tbmed_guidance_cat{cat}_{lvl}", "tbmed507", "tbmed507Guidance", {"category": cat, "work": lvl},
            {"workRest": wr, "waterQtPerH": qt, "waterLPerH": qt * US_QUART_L,
             "continuousWorkMin": cw, "continuousWaterQtPerH": cqt, "continuousWaterLPerH": cqt * US_QUART_L,
             "workW": TBMED_WORK_W[lvl]}, {"abs": 1e-9}, src_tb,
            "Caps: <= 1.5 qt/h and <= 12 qt/day regardless of table.")
    add("fluid_caps", "hydration", "fluidCaps", {},
        {"tbmedMaxLPerH": TBMED_MAX_QT_PER_H * US_QUART_L, "tbmedMaxLPerDay": TBMED_MAX_QT_PER_DAY * US_QUART_L,
         "nioshMaxLPerH_48oz": 48.0 * US_FL_OZ_ML / 1000.0, "nioshCupMl_8oz": 8.0 * US_FL_OZ_ML,
         "nioshPerHourRangeL": [24.0 * US_FL_OZ_ML / 1000.0, 32.0 * US_FL_OZ_ML / 1000.0]},
        {"abs": 1e-9}, "TB MED 507 Table 3-2 notes 5-6; NIOSH 2017-126 Hydration fact sheet")
    src_osha = "NIOSH 2016-106 Appendix C Table C-1 (adapted from OSHA 2012)"
    for hi in [85.0, 90.9, 91.0, 102.9, 103.0, 110.0, 115.0, 115.1, 125.0]:
        add(f"osha_hi_risk_{hi:g}F", "osha_hi_risk", "oshaHeatIndexRiskLevel", {"hiF": hi},
            {"level": osha_hi_risk_level(hi), "nwsCategory": nws_hi_category(hi)}, {"exact": True}, src_osha,
            "103 degF appears in two bands; resolved to 'high' (conservative)." if hi == 103.0 else "")
    src_nprm = "OSHA NPRM 89 FR 70698 (30 Aug 2024), proposed 29 CFR 1910.148(b),(e),(f)"
    for hi in [79.9, 80.0, 89.9, 90.0, 104.0]:
        add(f"nprm_trigger_hi_{hi:g}F", "osha_nprm", "oshaNprmTrigger", {"hiF": hi},
            {"trigger": osha_nprm_trigger(hi_f=hi)}, {"exact": True}, src_nprm, "'at or above' -> >=")
    for w, m in [(24.0, 300.0), (25.5, 300.0), (28.5, 300.0), (29.0, 180.0), (31.0, 180.0)]:
        add(f"nprm_trigger_wbgt_{w:g}C_{m:g}W", "osha_nprm", "oshaNprmTrigger", {"wbgtC": w, "mW": m},
            {"trigger": osha_nprm_trigger(wbgt_c=w, m_w=m), "ralC": ral_c(m), "relC": rel_c(m)}, {"exact": True},
            src_nprm, "WBGT metric: initial at WBGT >= RAL(M); high at WBGT >= REL(M).")
    src_ac = ("NIOSH 2016 Table 4-1 / sec 6.2.3; MSHA via NIOSH Table 8-2; "
              "OSHA NPRM 1910.148(e)(7)(i)(B) and (ii)(B)")
    for sched in ACCLIM_SCHEDULES:
        for day in (1, 2, 3, 4, 5, 7):
            add(f"acclim_{sched}_d{day}", "acclimatization", "acclimatizationFraction",
                {"schedule": sched, "day": day}, {"fraction": acclimatization_fraction(sched, day)},
                {"abs": 1e-12}, src_ac, "Fraction of the usual shift exposure duration allowed (maximum).")


def main() -> None:
    gen_ral_rel()
    gen_acgih_table()
    gen_allowed_fraction()
    gen_twa_and_scaling()
    gen_clothing()
    gen_work_capacity_pythermalcomfort()
    gen_heat_index()
    gen_noaa_chart_crosscheck()
    gen_osha_table2_reference()
    gen_lookups()

    out = {
        "schema_version": "1.0.0",
        "title": "Zill occupational heat-limit oracle vectors (NIOSH/ACGIH/ISO 7243/NWS HI/TB MED 507/OSHA)",
        "spec": "docs/research/limits_and_workrest.md",
        "generator": "scripts/oracles/limits_oracle.py",
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "environment": {"python": platform.python_version(), "numpy": np.__version__,
                        "pythermalcomfort": pythermalcomfort.__version__, "platform": platform.platform()},
        "units": {
            "mW": "W, whole-body metabolic rate (NOT W/m2); ACGIH/NIOSH values assume a 70 kg worker",
            "wbgtC / *C": "degC (WBGT_eff = measured WBGT + clothing adjustment value)",
            "tF / hiF / wbgtF": "degF",
            "rhPct": "% (0-100)",
            "workFraction / f": "fraction of each hour spent working (0-1)",
            "qt": "US liquid quart = 0.946352946 L",
        },
        "conventions": {
            "limit_comparison": "exceedance means WBGT_eff > limit (strict); WBGT_eff == limit is within the limit",
            "acgih_rounding": "nearest 0.5 degC, half-up: floor(2x + 0.5)/2 (no ties occur in the table)",
            "nws_threshold": "regression used when simple formula >= 80 degF (equation-page text rule)",
            "tbmed_intervals": "[78,82) cat1, [82,85) cat2, [85,88) cat3, [88,90) cat4, >= 90 cat5 (degF)",
            "osha_hi_levels": "<91 lower; [91,103) moderate; [103,115] high; >115 very high to extreme (degF)",
            "nprm_triggers": "initial: HI >= 80 degF or WBGT >= RAL(M); high: HI >= 90 degF or WBGT >= REL(M)",
            "rest_metabolic_rate_W": ACGIH_M_REST_W,
        },
        "constants": {
            "ral": {"a": RAL_A, "b": RAL_B, "form": "a - b*log10(M_W)"},
            "rel": {"a": REL_A, "b": REL_B, "form": "a - b*log10(M_W)"},
            "acgih_metabolic_W": ACGIH_M_W,
            "acgih_table2_tlv_C": ACGIH_TABLE2_TLV,
            "acgih_table2_al_C": ACGIH_TABLE2_AL,
            "acgih_cav_C": ACGIH_CAV_C,
            "acgih_hood_addition_C": ACGIH_HOOD_ADDITION_C,
            "tbmed507_table3_2": {str(k): v for k, v in TBMED_T32.items()},
            "tbmed507_table3_3": {str(k): v for k, v in TBMED_T33.items()},
            "tbmed507_work_W": TBMED_WORK_W,
            "tbmed507_caps_qt": {"per_hour": TBMED_MAX_QT_PER_H, "per_day": TBMED_MAX_QT_PER_DAY},
            "acclimatization_schedules": ACCLIM_SCHEDULES,
            "noaa_chart_F_niosh2016_appC": {str(k): v for k, v in NOAA_CHART_F.items()},
            "osha_table2_C_action_limit_tlv": OSHA_TABLE2_C,
            "us_quart_L": US_QUART_L,
            "us_fl_oz_mL": US_FL_OZ_ML,
            "kcal_per_h_to_W": KCAL_H_TO_W,
        },
        "summary": VECTOR_SUMMARY,
        "checks": CHECKS,
        "vectors": VECTORS,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(_clean(out), fh, indent=1, ensure_ascii=False, allow_nan=False)
        fh.write("\n")
    groups: dict[str, int] = {}
    for v in VECTORS:
        groups[v["group"]] = groups.get(v["group"], 0) + 1
    print(f"wrote {OUT} : {len(VECTORS)} vectors, {len(CHECKS)} checks passed")
    for g, n in groups.items():
        print(f"  {g:34s} {n}")


if __name__ == "__main__":
    sys.exit(main())
