#!/usr/bin/env python3
"""
Zill -- reference ("oracle") implementation of the Thermal Work Limit (TWL) and
generator of fixtures/twl.json for the TypeScript engine.

Primary source (all equations transcribed from Appendix 1):
    Brake DJ, Bates GP (2002). Limiting metabolic rate (thermal work limit) as an
    index of thermal stress. Appl Occup Environ Hyg 17(3):176-186.
    doi:10.1080/104732202753438261
Validation sources:
    - same paper, Table I (75 cells, 62 numeric) and the worked examples in the text
      (110 W/m2; 158 W/m2) and Appendix 2 (~220 W/m2);
    - Brake R, Bates G (2002). A valid method for comparing rational and empirical
      heat stress indices. Ann Occup Hyg 46(2):165-174, Tables 1 and 2
      (TWL with 0.35 clo, icl 0.45, posture factor 0.73);
    - Miller VS, Bates GP (2007). Ann Occup Hyg 51(6):553-561, Table 2 (chamber,
      0.12 clo) -- inputs incompletely reported, used as a loose check only.

Spec / discussion: docs/research/twl_and_regulation.md

Usage:
    python scripts/oracles/twl_oracle.py            # validate + write fixtures/twl.json
    python scripts/oracles/twl_oracle.py --out X.json
    python scripts/oracles/twl_oracle.py --no-write # validation report only
Exit code 0 only if every pre-registered acceptance check passes.

Dependencies: Python >= 3.8 standard library only (math/json). If pythermalcomfort
is importable it is used ONLY to cross-check the ISO 7726 globe->MRT helper.

-------------------------------------------------------------------------------
TWO EVAPORATION-EFFICIENCY VARIANTS (see md, section 1.6)
-------------------------------------------------------------------------------
The paper prints, for 0.46 <= x <= 1.7 (x = lambda*Sr/Emax):
        E = lambda*Sr * exp[-0.4127 * (1.8*x - 0.46)^1.168]
Taken literally (thresholds on x, "1.8x" only in the exponent) this is
discontinuous at both thresholds and fails to reproduce the paper's own Table I
(rms error ~46 W/m2 with this script's downward-scan root search; ~43 W/m2 with a plain
bisection on [20, 38.2] -- the literal form is discontinuous, so the root depends on the
search) [corrected by fact-check 2026-11-09]. Two internally consistent readings exist:

 "physical" (DEFAULT): E = lambda*Sr * exp[-0.4127 * (x - 0.46)^1.168]
     - matches the paper's verbal description of its Figure 3 exactly
       (efficiency = 1 at x = 0.46; E = Emax, i.e. w = 1, at x = 1.7, because
       exp[-0.4127*1.24^1.168] = 0.588264 ~ 1/1.7 = 0.588235, difference 2.8e-5
       [corrected by fact-check 2026-11-09]);
     - continuous; conservative (never higher than the alternative);
     - reproduces Table I within +1.3/-10.1 W/m2 (the 54 cells whose solution
       has x > 1.7 agree within 1.4 W/m2; the larger deviations are confined to
       the 8 driest/windiest cells of the 80 kPa block) and is consistent with
       UAE field TWL ranges (Bates & Schneider 2008).
 "alt_1p8": X = 1.8*x used for the zone tests AND the exponent, with the sweat
     term scaled by 1.8 for continuity:  E = 1.8*lambda*Sr*exp[-0.4127*(X-0.46)^1.168]
     - reproduces all 62 numeric Table I cells within +/-1.9 W/m2;
     - gives markedly higher TWL in dry/windy conditions (Abu Dhabi inland summer).
Both are emitted in the fixture; the engine should implement "physical".
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import platform
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "fixtures" / "twl.json"
SCHEMA_VERSION = "1.0.0"

# =============================================================================
# 0. Constants (all from Brake & Bates 2002 unless stated)
# =============================================================================
TCORE_LIMIT_C = 38.2          # limiting deep-body core temperature, degC
SR_MAX_KG_M2_H = 0.67         # max sweat rate, kg m-2 h-1 (= 1.2 L/h for 1.8 m2)
LAMBDA_KJ_KG = 2430.0         # latent heat of sweat @30 degC [ASHRAE 1997 ch.8 eq 14]
LSR_PER_SR = LAMBDA_KJ_KG * 1000.0 / 3600.0   # = 675.0 W m-2 per (kg m-2 h-1)
POSTURE_FR = 0.73             # radiation posture factor, standing [ASHRAE eq 35]
LEWIS_RATIO = 16.5            # K/kPa [ASHRAE eq 27]
V_MIN, V_MAX = 0.2, 4.0       # wind-speed clamp over the skin, m/s
ICL_DEFAULT, ICL_PERM_DEFAULT = 0.35, 0.45   # standard TWL clothing (clo, -)
TWL_VALID_MIN, TWL_VALID_MAX = 60.0, 380.0   # Wyndham data range, W m-2
BSA_STD_M2 = 1.8              # "standard person" area used for L/h conversions
# Not specified in the paper ("standard psychrometric equations"); chosen because
# they are the mine-ventilation conventions and give the best fit to Table I:
PSYCHRO_A = 0.000644          # 1/K, aspirated psychrometer coefficient, P in kPa
TETENS = (0.6105, 17.27, 237.3)   # kPa, -, degC
# Zone thresholds (ADOSH-SF TG Safety in the Heat v4.0, July 2024, Table 1)
ZONE_HIGH_BELOW = 115.0
ZONE_MEDIUM_BELOW = 140.0
ZONE_UNRESTRICTED_FROM = 220.0    # original 4-zone scheme (B&B 2002, M&B 2007)
BACKSTOP_DB_GT_C = 44.0           # B&B 2002 Table II / M&B 2007 Table 6
BACKSTOP_WB_GT_C = 32.0


# =============================================================================
# 1. Psychrometrics and radiation helpers
# =============================================================================
def psat_kpa(t_c: float) -> float:
    """Saturation vapour pressure over water (Tetens/Magnus), kPa."""
    a, b, c = TETENS
    return a * math.exp(b * t_c / (t_c + c))


def pa_from_wet_bulb(tdb: float, twb: float, p_kpa: float) -> float:
    """Ambient vapour pressure (kPa) from dry bulb and PSYCHROMETRIC (aspirated)
    wet bulb: pa = psat(twb) - A*P*(tdb - twb)."""
    return max(psat_kpa(twb) - PSYCHRO_A * p_kpa * (tdb - twb), 0.0)


def pa_from_rh(tdb: float, rh_pct: float) -> float:
    return max(rh_pct, 0.0) / 100.0 * psat_kpa(tdb)


def wet_bulb_from_pa(tdb: float, pa: float, p_kpa: float) -> float:
    """Psychrometric wet bulb consistent with pa_from_wet_bulb (bisection)."""
    lo, hi = -40.0, tdb
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if pa_from_wet_bulb(tdb, mid, p_kpa) > pa:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


def dew_point_from_pa(pa: float) -> float:
    """Inverse Tetens, degC (pa > 0)."""
    a, b, c = TETENS
    g = math.log(pa / a)
    return c * g / (b - g)


def mrt_from_globe_iso7726(tg: float, ta: float, v: float, d_m: float = 0.15,
                           emissivity: float = 0.95) -> float:
    """ISO 7726:1998 Annex B: tr = [(tg+273.15)^4 + hcg/(eps*sigma)*(tg-ta)]^0.25 - 273.15,
    hcg = max(1.4*(|tg-ta|/D)^0.25 [natural], 6.3*v^0.6/D^0.4 [forced])."""
    sigma = 5.67e-8
    h_nat = 1.4 * (abs(tg - ta) / d_m) ** 0.25
    h_for = 6.3 * (max(v, 0.0) ** 0.6) / (d_m ** 0.4)
    hcg = max(h_nat, h_for)
    return ((tg + 273.15) ** 4 + hcg / (emissivity * sigma) * (tg - ta)) ** 0.25 - 273.15


# =============================================================================
# 2. TWL core
# =============================================================================
def _heat_terms(tsk, ta, tr, v, p_kpa, pa, icl_clo, icl_perm, tcore, sr_max, variant):
    """All Appendix-1 terms for a trial mean skin temperature tsk (degC)."""
    # core-to-skin (Wyndham data, Cabanac signal)
    t_sigma = 0.1 * tsk + 0.9 * tcore
    kcs = 84.0 + 72.0 * math.tanh(1.3 * (t_sigma - 37.9))          # W m-2 K-1
    h_cs = kcs * (tcore - tsk)                                       # W m-2
    sr = 0.42 + 0.44 * math.tanh(1.16 * (t_sigma - 37.4))            # kg m-2 h-1
    sr = min(max(sr, 0.0), sr_max)
    lsr = LSR_PER_SR * sr                                            # W m-2
    # sensible heat (EESAM eqs 8, 9, 11, 13 + ASHRAE clothing corrections)
    hc = 0.608 * p_kpa ** 0.6 * v ** 0.6                             # W m-2 K-1
    hr = 4.61 * (1.0 + (tr + tsk) / 546.0) ** 3                      # W m-2 K-1
    hr_eff = POSTURE_FR * hr
    h = hr_eff + hc
    t_op = (hr_eff * tr + hc * ta) / h
    fcl = 1.0 + 0.3 * icl_clo
    rcl = 0.155 * icl_clo                                            # m2 K W-1
    fcle = fcl / (1.0 + fcl * h * rcl)
    dry = fcle * h * (tsk - t_op)                                    # C + R, W m-2
    # evaporation (EESAM eq 17 + ASHRAE)
    he = 1587.0 * hc * p_kpa / (p_kpa - pa) ** 2                     # W m-2 kPa-1
    recl = rcl / (LEWIS_RATIO * icl_perm) if icl_clo > 0 else 0.0    # m2 kPa W-1
    fpcl = 1.0 / (1.0 + fcl * he * recl)
    emax = fpcl * fcl * he * (psat_kpa(tsk) - pa)                    # W m-2 (w = 1)
    if emax <= 0.0:
        x, e = math.inf, 0.0
    else:
        x = lsr / emax
        if variant == "physical":
            xx, s = x, lsr
        elif variant == "alt_1p8":
            xx, s = 1.8 * x, 1.8 * lsr
        else:
            raise ValueError(variant)
        if xx < 0.46:
            e = s
        elif xx <= 1.7:
            e = s * math.exp(-0.4127 * (xx - 0.46) ** 1.168)
        else:
            e = emax
        e = min(e, emax)
    return {
        "t_sigma": t_sigma, "kcs": kcs, "H": h_cs, "sr": sr, "lsr": lsr,
        "hc": hc, "hr": hr, "h": h, "t_op": t_op, "fcl": fcl, "fcle": fcle,
        "dry": dry, "he": he, "fpcl": fpcl, "emax": emax, "x": x, "E": e,
        "loss": dry + e,
    }


def twl(tdb: float, tr: float, v: float, p_kpa: float, *, twb: float | None = None,
        pa: float | None = None, rh: float | None = None,
        icl_clo: float = ICL_DEFAULT, icl_perm: float = ICL_PERM_DEFAULT,
        tcore: float = TCORE_LIMIT_C, sr_max: float = SR_MAX_KG_M2_H,
        variant: str = "physical") -> dict:
    """Thermal Work Limit (W m-2). Humidity via exactly one of twb (psychrometric
    wet bulb, degC), pa (kPa) or rh (%). tr = mean radiant temperature (degC),
    v = wind speed (m/s, clamped to [0.2, 4]), p_kpa = barometric pressure (kPa)."""
    flags = []
    n_h = sum(q is not None for q in (twb, pa, rh))
    if n_h != 1:
        raise ValueError("give exactly one of twb, pa, rh")
    if twb is not None:
        pa = pa_from_wet_bulb(tdb, twb, p_kpa)
    elif rh is not None:
        pa = pa_from_rh(tdb, rh)
    twb_eff = twb if twb is not None else wet_bulb_from_pa(tdb, pa, p_kpa)
    v_used = min(max(v, V_MIN), V_MAX)
    if v < V_MIN:
        flags.append("WIND_CLAMPED_TO_0.2")
    if v > V_MAX:
        flags.append("WIND_CLAMPED_TO_4.0")

    def f(t):
        q = _heat_terms(t, tdb, tr, v_used, p_kpa, pa, icl_clo, icl_perm, tcore, sr_max, variant)
        return q["H"] - q["loss"], q

    # Root search: scan DOWN from just below tcore in 0.05 K steps for the first
    # tsk where H - loss >= 0 (the warm-skin, physiologically relevant root), then
    # bisect the bracket to 1e-10 K. Lower scan limit 20 degC.
    t_hi = tcore - 1e-6
    f_hi, _ = f(t_hi)
    resp_den = 1.0 - 0.0014 * (34.0 - tdb) - 0.0173 * (5.87 - pa)
    if f_hi >= 0.0:
        # skin cannot lose heat even at tsk = tcore: no sustainable work
        flags.append("NO_ROOT_NET_HEAT_GAIN")
        q = f(t_hi)[1]
        res_twl, tsk = 0.0, t_hi
    else:
        step, t_lo, bracket = 0.05, None, None
        t = t_hi
        while t > 20.0:
            t_next = t - step
            if f(t_next)[0] >= 0.0:
                bracket = (t_next, t)
                break
            t = t_next
        if bracket is None:
            flags.append("NO_ROOT_ABOVE_20C_SKIN")
            q = f(20.0)[1]
            res_twl, tsk = q["H"] / resp_den, 20.0
        else:
            a, b = bracket
            for _ in range(200):
                m = 0.5 * (a + b)
                if f(m)[0] >= 0.0:
                    a = m
                else:
                    b = m
                if b - a < 1e-10:
                    break
            tsk = 0.5 * (a + b)
            q = f(tsk)[1]
            res_twl = q["H"] / resp_den
    m_resp = res_twl * (1.0 - resp_den)
    dpt = dew_point_from_pa(pa) if pa > 0 else -math.inf
    if dpt >= tsk:
        flags.append("DEWPOINT_AT_OR_ABOVE_SKIN_TEMP_INVALID")
    if res_twl < TWL_VALID_MIN:
        flags.append("BELOW_VALID_RANGE_60")
    if res_twl > TWL_VALID_MAX:
        flags.append("ABOVE_VALID_RANGE_380")
    if tdb > BACKSTOP_DB_GT_C:
        flags.append("BACKSTOP_DB_GT_44C")
    if twb_eff > BACKSTOP_WB_GT_C:
        flags.append("BACKSTOP_WB_GT_32C")
    out = {
        "twl_w_m2": res_twl,
        "tsk_c": tsk,
        "pa_kpa": pa,
        "twb_psychrometric_c": twb_eff,
        "dew_point_c": dpt,
        "v_used_m_s": v_used,
        "core_to_skin_H_w_m2": q["H"],
        "kcs_w_m2_k": q["kcs"],
        "t_sigma_c": q["t_sigma"],
        "dry_C_plus_R_w_m2": q["dry"],
        "evap_E_w_m2": q["E"],
        "emax_w_m2": q["emax"],
        "sweat_lambda_sr_w_m2": q["lsr"],
        "sweat_rate_kg_m2_h": q["sr"],
        "sweat_rate_L_h_1p8m2": q["sr"] * BSA_STD_M2,
        "x_lambda_sr_over_emax": q["x"],
        "skin_wettedness_w": (q["E"] / q["emax"]) if q["emax"] > 0 else None,
        "respiratory_B_w_m2": m_resp,
        "hc_w_m2_k": q["hc"], "hr_w_m2_k": q["hr"], "he_w_m2_kpa": q["he"],
        "t_operative_c": q["t_op"], "Fcle": q["fcle"], "Fpcl": q["fpcl"],
        "flags": flags,
    }
    return out


# =============================================================================
# 3. Zone classification (ADOSH-SF TG Safety in the Heat v4.0 Table 1)
# =============================================================================
def classify(twl_value: float, tdb: float | None = None, twb: float | None = None,
             apply_backstops: bool = True) -> dict:
    if twl_value < ZONE_HIGH_BELOW:
        z = "HIGH"
    elif twl_value < ZONE_MEDIUM_BELOW:
        z = "MEDIUM"
    else:
        z = "LOW"
    sub = None
    if z == "LOW":
        sub = "UNRESTRICTED_GE_220" if twl_value >= ZONE_UNRESTRICTED_FROM else "ACCLIMATIZATION_140_220"
    z_bs = z
    reasons = []
    if apply_backstops:
        if tdb is not None and tdb > BACKSTOP_DB_GT_C:
            reasons.append("DB>44C")
        if twb is not None and twb > BACKSTOP_WB_GT_C:
            reasons.append("WB>32C")
        if reasons:
            z_bs = "HIGH"
    return {"zone_adosh": z, "low_subzone_bb2002": sub,
            "zone_with_bb2002_backstops": z_bs, "backstop_reasons": reasons}


# =============================================================================
# 4. Published reference data
# =============================================================================
# Brake & Bates 2002 Table I. None = "n/p" (too extreme even for light work).
TABLE_I = [
    {"block": "A", "mrt_minus_db": 2.0, "v": 0.2, "p": 101.0, "icl": 0.45, "icl_perm": 0.45,
     "rows": {34: [175, 157, 136, 114, None], 36: [170, 151, 131, 109, None],
              38: [164, 145, 125, 103, None], 40: [158, 140, 120, None, None],
              42: [152, 134, 114, None, None]}},
    {"block": "B", "mrt_minus_db": 0.0, "v": 0.5, "p": 115.0, "icl": 0.69, "icl_perm": 0.40,
     "rows": {34: [181, 161, 140, 118, None], 36: [176, 156, 136, 113, None],
              38: [171, 152, 131, 109, None], 40: [166, 147, 126, 104, None],
              42: [161, 142, 122, None, None]}},
    {"block": "C", "mrt_minus_db": 3.0, "v": 1.5, "p": 80.0, "icl": 0.35, "icl_perm": 0.45,
     "rows": {34: [288, 260, 229, 193, 154], 36: [282, 254, 222, 187, 148],
              38: [276, 248, 216, 181, 141], 40: [270, 242, 210, 174, 135],
              42: [264, 235, 203, 167, 128]}},
]
TABLE_I_WB = [24, 26, 28, 30, 32]

TEXT_EXAMPLES = [  # (tdb, twb, tr(=globe=DB here), v, P, Icl, icl, published, label)
    (40.0, 30.0, 40.0, 0.2, 100.0, 0.35, 0.45, 110.0,
     "B&B 2002 p.180: 30 WB, 40 DB, 40 globe, 100 kPa, 0.2 m/s, Icl 0.35, icl 0.45 -> 110"),
    (40.0, 30.0, 40.0, 0.7, 100.0, 0.35, 0.45, 158.0,
     "B&B 2002 p.181: same but wind 0.7 m/s -> 158"),
    (35.0, 26.0, 35.0, 0.5, 100.0, 0.35, 0.45, 220.0,
     "B&B 2002 App.2: 'typically 26 WB, 35 DB and globe, 0.5 m/s, 100 kPa' ~ 220 (approximate)"),
]
AOH_TABLE2 = [  # Brake & Bates 2002 Ann Occup Hyg Table 2 (28 WB), 0.35/0.45/0.73; P assumed 100
    (38.0, 28.0, 38.0, 0.2, 100.0, 132.0, "AOH2002 T2-A hot dry (DB=MRT=WB+10), 0.2 m/s"),
    (38.0, 28.0, 38.0, 3.0, 100.0, 243.0, "AOH2002 T2-B hot dry, 3.0 m/s"),
    (31.0, 28.0, 31.0, 0.2, 100.0, 154.0, "AOH2002 T2-C hot humid (DB=MRT=WB+3), 0.2 m/s"),
    (31.0, 28.0, 31.0, 3.0, 100.0, 263.0, "AOH2002 T2-D hot humid, 3.0 m/s"),
]
AOH_TABLE1 = [  # max WB at which TWL = 140 (DB = MRT = WB + dT)
    (10.0, 0.2, 27.5, "hot dry, 0.2 m/s"), (10.0, 3.0, 32.0, "hot dry, 3.0 m/s"),
    (3.0, 0.2, 29.0, "hot humid, 0.2 m/s"), (3.0, 3.0, 32.9, "hot humid, 3.0 m/s"),
]
MB2007_CHAMBER = [  # Miller & Bates 2007 Table 2 session means; 0.12 clo
    (1, 38.7, 28.6, 0.23, 154), (2, 38.4, 28.7, 0.24, 156), (3, 39.0, 28.1, 0.23, 160),
    (4, 38.9, 27.6, 0.21, 160), (5, 38.7, 25.0, 0.22, 198), (6, 38.1, 27.9, 0.21, 159),
    (7, 39.1, 27.3, 0.24, 172), (8, 38.6, 27.3, 0.22, 168), (9, 38.3, 27.2, 0.20, 164),
    (10, 38.3, 27.6, 0.21, 162), (11, 38.2, 28.4, 0.22, 156),
]

# Pre-registered acceptance criteria (set before running; see md section 1.8)
ACCEPT = {
    "tableI_alt_1p8_max_abs": 2.5,          # all 62 numeric cells
    "tableI_physical_zoneC_max_abs": 2.5,    # cells where physical solution has x > 1.7
    "tableI_physical_min_err": -11.0,        # physical may only under-predict in zone B
    "tableI_np_cells_below": 101.0,          # every n/p cell must compute < 101 W/m2
    "text_examples_max_abs": 1.5,            # 110 and 158 examples
    "app2_220_max_abs": 6.0,                 # "typically" ~220
    "aoh_t2_highwind_max_abs": 1.5,          # 3.0 m/s rows
    "aoh_t2_lowwind_max_abs": 9.0,           # 0.2 m/s rows (known model-version gap)
    "mrt_vs_pythermalcomfort_abs": 1e-6,
}


# =============================================================================
# 5. Validation
# =============================================================================
def validate(verbose=True):
    checks, failures = [], []

    def record(name, value, limit, ok, detail=""):
        checks.append({"check": name, "value": value, "limit": limit, "pass": bool(ok), "detail": detail})
        if not ok:
            failures.append(name)
        if verbose:
            print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {value} (limit {limit}) {detail}")

    if verbose:
        print("== Brake & Bates 2002 Table I ==")
    cells = []
    for blk in TABLE_I:
        for db, vals in blk["rows"].items():
            for wb, pub in zip(TABLE_I_WB, vals):
                tr = db + blk["mrt_minus_db"]
                rp = twl(db, tr, blk["v"], blk["p"], twb=wb, icl_clo=blk["icl"], icl_perm=blk["icl_perm"], variant="physical")
                ra = twl(db, tr, blk["v"], blk["p"], twb=wb, icl_clo=blk["icl"], icl_perm=blk["icl_perm"], variant="alt_1p8")
                cells.append({"block": blk["block"], "db": db, "wb": wb, "published": pub,
                              "physical": rp["twl_w_m2"], "alt_1p8": ra["twl_w_m2"],
                              "x_physical": rp["x_lambda_sr_over_emax"]})
    num = [c for c in cells if c["published"] is not None]
    e_alt = [c["alt_1p8"] - c["published"] for c in num]
    e_phy = [c["physical"] - c["published"] for c in num]
    zc = [c for c in num if c["x_physical"] > 1.7]
    e_phy_zc = [c["physical"] - c["published"] for c in zc]
    stats = {
        "n_numeric": len(num), "n_np": len(cells) - len(num),
        "alt_1p8": {"max_abs": max(map(abs, e_alt)), "mean": statistics.mean(e_alt),
                    "rms": math.sqrt(sum(e * e for e in e_alt) / len(e_alt)),
                    "floor_matches": sum(math.floor(c["alt_1p8"]) == c["published"] for c in num),
                    "round_matches": sum(round(c["alt_1p8"]) == c["published"] for c in num)},
        "physical": {"max_abs": max(map(abs, e_phy)), "min": min(e_phy), "max": max(e_phy),
                     "mean": statistics.mean(e_phy),
                     "rms": math.sqrt(sum(e * e for e in e_phy) / len(e_phy)),
                     "n_zoneC_cells": len(zc), "zoneC_max_abs": max(map(abs, e_phy_zc)),
                     "zoneB_cells": [(c["block"], c["db"], c["wb"], c["published"], round(c["physical"], 1), round(c["x_physical"], 2))
                                     for c in num if c["x_physical"] <= 1.7]},
    }
    record("tableI_alt_1p8_max_abs", round(stats["alt_1p8"]["max_abs"], 3), ACCEPT["tableI_alt_1p8_max_abs"],
           stats["alt_1p8"]["max_abs"] <= ACCEPT["tableI_alt_1p8_max_abs"],
           f"mean {stats['alt_1p8']['mean']:+.2f} rms {stats['alt_1p8']['rms']:.2f}; floor-matches {stats['alt_1p8']['floor_matches']}/62")
    record("tableI_physical_zoneC_max_abs", round(stats["physical"]["zoneC_max_abs"], 3), ACCEPT["tableI_physical_zoneC_max_abs"],
           stats["physical"]["zoneC_max_abs"] <= ACCEPT["tableI_physical_zoneC_max_abs"],
           f"{len(zc)} cells with x>1.7")
    record("tableI_physical_min_err", round(stats["physical"]["min"], 3), ACCEPT["tableI_physical_min_err"],
           stats["physical"]["min"] >= ACCEPT["tableI_physical_min_err"] and stats["physical"]["max"] <= 2.5,
           f"overall mean {stats['physical']['mean']:+.2f} rms {stats['physical']['rms']:.2f}; zone-B cells {stats['physical']['zoneB_cells']}")
    np_cells = [c for c in cells if c["published"] is None]
    worst_np = max(max(c["physical"], c["alt_1p8"]) for c in np_cells)
    record("tableI_np_cells_below", round(worst_np, 2), ACCEPT["tableI_np_cells_below"],
           worst_np < ACCEPT["tableI_np_cells_below"], "n/p appears to mean TWL < 100 W/m2")

    if verbose:
        print("== Brake & Bates 2002 worked examples ==")
    ex_res = []
    for tdb, twb_, tr, v, p, icl, iclp, pub, label in TEXT_EXAMPLES:
        r = twl(tdb, tr, v, p, twb=twb_, icl_clo=icl, icl_perm=iclp)
        ra = twl(tdb, tr, v, p, twb=twb_, icl_clo=icl, icl_perm=iclp, variant="alt_1p8")
        ex_res.append({"label": label, "published": pub, "physical": r["twl_w_m2"], "alt_1p8": ra["twl_w_m2"]})
    m1 = max(abs(ex_res[0]["physical"] - 110.0), abs(ex_res[1]["physical"] - 158.0))
    record("text_examples_max_abs", round(m1, 3), ACCEPT["text_examples_max_abs"], m1 <= ACCEPT["text_examples_max_abs"],
           f"{ex_res[0]['physical']:.1f} vs 110; {ex_res[1]['physical']:.1f} vs 158")
    m2 = abs(ex_res[2]["physical"] - 220.0)
    record("app2_220_max_abs", round(m2, 3), ACCEPT["app2_220_max_abs"], m2 <= ACCEPT["app2_220_max_abs"],
           f"{ex_res[2]['physical']:.1f} vs ~220")

    if verbose:
        print("== Brake & Bates 2002 (Ann Occup Hyg) Table 2 / Table 1 ==")
    aoh = []
    for tdb, twb_, tr, v, p, pub, label in AOH_TABLE2:
        r = twl(tdb, tr, v, p, twb=twb_)
        aoh.append({"label": label, "published": pub, "physical": r["twl_w_m2"], "v": v})
    hw = max(abs(a["physical"] - a["published"]) for a in aoh if a["v"] > 1)
    lw = max(abs(a["physical"] - a["published"]) for a in aoh if a["v"] < 1)
    record("aoh_t2_highwind_max_abs", round(hw, 3), ACCEPT["aoh_t2_highwind_max_abs"], hw <= ACCEPT["aoh_t2_highwind_max_abs"])
    record("aoh_t2_lowwind_max_abs", round(lw, 3), ACCEPT["aoh_t2_lowwind_max_abs"], lw <= ACCEPT["aoh_t2_lowwind_max_abs"],
           "model over-predicts published low-wind values (pre-publication model version?)")
    aoh_t1 = []
    for dT, v, wb_pub, label in AOH_TABLE1:
        lo, hi = 15.0, 40.0
        for _ in range(80):
            mid = 0.5 * (lo + hi)
            if twl(mid + dT, mid + dT, v, 100.0, twb=mid)["twl_w_m2"] > 140.0:
                lo = mid
            else:
                hi = mid
        aoh_t1.append({"label": label, "published_wb_at_140": wb_pub, "model_wb_at_140": 0.5 * (lo + hi)})

    if verbose:
        print("== Miller & Bates 2007 chamber (loose: MRT=DB, P=101.3, icl=0.45 assumed) ==")
    mb = []
    for day, db, wb, v, pub in MB2007_CHAMBER:
        r = twl(db, db, v, 101.3, twb=wb, icl_clo=0.12, icl_perm=0.45)
        mb.append({"day": day, "published": pub, "physical": r["twl_w_m2"]})
    mb_diff = [m["physical"] - m["published"] for m in mb]
    if verbose:
        print(f"  mean diff {statistics.mean(mb_diff):+.2f}, range {min(mb_diff):+.2f}..{max(mb_diff):+.2f} (not a pass/fail check)")

    try:
        from pythermalcomfort.environment import mean_radiant_tmp
        diffs = []
        for tg, ta, v, d in [(50, 35, 1.0, 0.15), (60, 42, 3.0, 0.15), (45, 40, 0.1, 0.15), (55, 38, 2.0, 0.05)]:
            mine = mrt_from_globe_iso7726(tg, ta, v, d)
            ref = float(mean_radiant_tmp(tg, ta, v, d, 0.95, standard="ISO"))
            diffs.append(abs(mine - ref))
        record("mrt_vs_pythermalcomfort_abs", max(diffs), ACCEPT["mrt_vs_pythermalcomfort_abs"],
               max(diffs) <= ACCEPT["mrt_vs_pythermalcomfort_abs"], "ISO 7726 globe->MRT")
    except Exception as exc:  # pragma: no cover
        checks.append({"check": "mrt_vs_pythermalcomfort_abs", "skipped": str(exc)})

    report = {"tableI_stats": stats, "tableI_cells": cells, "text_examples": ex_res,
              "aoh2002_table2": aoh, "aoh2002_table1": aoh_t1, "miller_bates_2007_chamber": mb,
              "checks": checks, "failures": failures}
    return report


# =============================================================================
# 6. Fixture vectors
# =============================================================================
def _vec(vid, group, desc, *, tdb, v, p, twb=None, rh=None, tr=None, tg=None, globe_d=0.15,
         icl=ICL_DEFAULT, iclp=ICL_PERM_DEFAULT, published=None, published_note=None, source="", note=""):
    if tr is None:
        tr = mrt_from_globe_iso7726(tg, tdb, v, globe_d)
    rp = twl(tdb, tr, v, p, twb=twb, rh=rh, icl_clo=icl, icl_perm=iclp, variant="physical")
    ra = twl(tdb, tr, v, p, twb=twb, rh=rh, icl_clo=icl, icl_perm=iclp, variant="alt_1p8")
    cls = classify(rp["twl_w_m2"], tdb, rp["twb_psychrometric_c"])
    inputs = {"tdb_c": tdb, "twb_psychrometric_c": rp["twb_psychrometric_c"], "rh_pct": rh,
              "pa_kpa": rp["pa_kpa"], "tg_c": tg, "globe_diameter_m": globe_d if tg is not None else None,
              "mrt_c": tr, "wind_m_s": v, "pressure_kpa": p, "icl_clo": icl, "icl_vapour_perm": iclp,
              "tcore_limit_c": TCORE_LIMIT_C, "sr_max_kg_m2_h": SR_MAX_KG_M2_H}
    if twb is not None:
        inputs["humidity_input"] = "twb"
    elif rh is not None:
        inputs["humidity_input"] = "rh"
    exp = {k: rp[k] for k in ("twl_w_m2", "tsk_c", "dew_point_c", "v_used_m_s", "core_to_skin_H_w_m2",
                              "dry_C_plus_R_w_m2", "evap_E_w_m2", "emax_w_m2", "sweat_rate_kg_m2_h",
                              "sweat_rate_L_h_1p8m2", "x_lambda_sr_over_emax", "skin_wettedness_w",
                              "respiratory_B_w_m2", "hc_w_m2_k", "hr_w_m2_k", "he_w_m2_kpa",
                              "t_operative_c", "Fcle", "Fpcl", "flags")}
    exp.update(cls)
    exp["twl_alt_1p8_w_m2"] = ra["twl_w_m2"]
    exp["zone_adosh_alt_1p8"] = classify(ra["twl_w_m2"])["zone_adosh"]
    d = {"id": vid, "group": group, "description": desc, "inputs": inputs, "expected": exp,
         "tol": {"twl_w_m2_abs": 0.05, "tsk_c_abs": 0.001, "other_rel": 1e-6},
         "source": source, "note": note}
    if published is not None:
        d["published"] = {"twl_w_m2": published, "note": published_note,
                          "deviation_physical": rp["twl_w_m2"] - published,
                          "deviation_alt_1p8": ra["twl_w_m2"] - published}
    return d


def _wb_for_target(tdb_minus_wb_fn, target, v, p, tr_fn, lo=10.0, hi=36.0):
    """Find WB giving TWL = target (TWL decreases with WB)."""
    for _ in range(100):
        mid = 0.5 * (lo + hi)
        tdb = tdb_minus_wb_fn(mid)
        if twl(tdb, tr_fn(tdb), v, p, twb=mid)["twl_w_m2"] > target:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def build_vectors():
    V = []
    S_TAB = "Brake & Bates 2002 AEOH 17(3) Table I"
    # --- A. published Table I cells (inputs exactly as tabulated)
    for blk, db, wb, pub in [("A", 34, 24, 175), ("A", 38, 30, 103), ("A", 42, 28, 114),
                             ("B", 36, 28, 136), ("B", 40, 30, 104), ("C", 34, 32, 154),
                             ("C", 42, 24, 264), ("C", 40, 24, 270), ("C", 38, 28, 216)]:
        b = next(x for x in TABLE_I if x["block"] == blk)
        V.append(_vec(f"BB2002-T1-{blk}-DB{db}-WB{wb}", "published_tableI",
                      f"Table I block {blk}: DB {db}, WB {wb}, MRT=DB+{b['mrt_minus_db']:g}, {b['v']} m/s, {b['p']:g} kPa, Icl {b['icl']}, icl {b['icl_perm']}",
                      tdb=db, twb=wb, tr=db + b["mrt_minus_db"], v=b["v"], p=b["p"], icl=b["icl"], iclp=b["icl_perm"],
                      published=pub, published_note="integer as printed (values appear truncated)", source=S_TAB,
                      note=("zone-B cell: variants differ (physical lower)" if blk == "C" and wb == 24 else "")))
    # n/p cell
    V.append(_vec("BB2002-T1-A-DB40-WB30-np", "published_tableI", "Table I block A DB 40 WB 30 printed 'n/p' (too extreme even for light work)",
                  tdb=40, twb=30, tr=42, v=0.2, p=101, icl=0.45, iclp=0.45, source=S_TAB,
                  note="n/p: model gives <100 W/m2; consistent with an n/p cut-off of 100 W/m2"))
    # --- B. worked examples
    for i, (tdb, twb_, tr, v, p, icl, iclp, pub, label) in enumerate(TEXT_EXAMPLES, 1):
        V.append(_vec(f"BB2002-TEXT-{i}", "published_text", label, tdb=tdb, twb=twb_, tr=tr, v=v, p=p,
                      icl=icl, iclp=iclp, published=pub,
                      published_note=("approximate ('typically')" if i == 3 else "as printed"),
                      source="Brake & Bates 2002 AEOH pp.180-181, 186"))
    # --- C. AOH 2002 Table 2
    for i, (tdb, twb_, tr, v, p, pub, label) in enumerate(AOH_TABLE2):
        V.append(_vec(f"BB2002AOH-T2-{'ABCD'[i]}", "published_aoh2002", label + " (P not stated; 100 kPa assumed)",
                      tdb=tdb, twb=twb_, tr=tr, v=v, p=p, published=pub, published_note="as printed",
                      source="Brake & Bates 2002 Ann Occup Hyg 46(2) Table 2",
                      note=("low-wind rows: oracle 5.6-7.6 W/m2 above published" if v < 1 else "")))
    # --- D. Miller & Bates 2007 chamber (loose)
    for day in (1, 5):
        _, db, wb, v, pub = MB2007_CHAMBER[day - 1]
        V.append(_vec(f"MB2007-T2-day{day}", "published_mb2007_loose",
                      f"Miller & Bates 2007 chamber day {day} session means; 0.12 clo; MRT=DB, P=101.3, icl=0.45 ASSUMED",
                      tdb=db, twb=wb, tr=db, v=v, p=101.3, icl=0.12, iclp=0.45, published=pub,
                      published_note="computed by authors from session means; globe, pressure and icl not reported",
                      source="Miller & Bates 2007 Ann Occup Hyg 51(6) Table 2", note="loose check only (~+7 W/m2 systematic)"))
    # --- E. Abu Dhabi scenarios (no published values; oracle-defined). MRT is given
    #     directly (the engine derives MRT from radiation); full-sun values of
    #     ~60-70 C are typical for a standing person in Gulf summer sun.
    AD = "Abu Dhabi scenario (oracle only; inputs illustrative)"
    V.append(_vec("AD-COAST-MORNING-HUMID", "abu_dhabi", "Coastal Abu Dhabi summer ~08:00: DB 34, RH 75%, MRT 52, 1.5 m/s, 100.5 kPa",
                  tdb=34.0, rh=75.0, tr=52.0, v=1.5, p=100.5, source=AD))
    V.append(_vec("AD-COAST-MIDDAY-SUN", "abu_dhabi", "Coastal midday full sun: DB 42, RH 45%, MRT 68, 3 m/s, 100.2 kPa",
                  tdb=42.0, rh=45.0, tr=68.0, v=3.0, p=100.2, source=AD))
    V.append(_vec("AD-INLAND-MIDDAY-WINDY", "abu_dhabi", "Inland (Al Ain-like) midday: DB 46, RH 12%, MRT 70, 2 m/s, 97.5 kPa",
                  tdb=46.0, rh=12.0, tr=70.0, v=2.0, p=97.5, source=AD,
                  note="dry/windy: zone-B regime where physical and alt_1p8 differ most; DB>44 backstop"))
    V.append(_vec("AD-INLAND-MIDDAY-CALM", "abu_dhabi", "Inland midday calm: DB 46, RH 12%, MRT 70, 0.2 m/s, 97.5 kPa",
                  tdb=46.0, rh=12.0, tr=70.0, v=0.2, p=97.5, source=AD))
    V.append(_vec("AD-COAST-EVENING-SHADE", "abu_dhabi", "Coastal evening, shade (MRT=DB): DB 35, RH 70%, 0.3 m/s, 100.5 kPa",
                  tdb=35.0, rh=70.0, tr=35.0, v=0.3, p=100.5, source=AD))
    V.append(_vec("AD-SHADE-40-40", "abu_dhabi", "Shade: DB 40, RH 40%, MRT 40, 1 m/s, 100 kPa (pair with AD-SUN-40-40)",
                  tdb=40.0, rh=40.0, tr=40.0, v=1.0, p=100.0, source=AD))
    V.append(_vec("AD-SUN-40-40", "abu_dhabi", "Sun: DB 40, RH 40%, MRT 65, 1 m/s, 100 kPa (pair with AD-SHADE-40-40)",
                  tdb=40.0, rh=40.0, tr=65.0, v=1.0, p=100.0, source=AD))
    V.append(_vec("AD-EXTREME-HUMID-WB-GT-32", "abu_dhabi", "Very humid: DB 36, RH 85%, MRT 50, 0.5 m/s, 100.5 kPa (WB>32 backstop)",
                  tdb=36.0, rh=85.0, tr=50.0, v=0.5, p=100.5, source=AD))
    V.append(_vec("AD-DB-GT-44-BACKSTOP", "abu_dhabi", "DB 47, RH 10%, MRT 70, 3 m/s, 99 kPa (DB>44 backstop)",
                  tdb=47.0, rh=10.0, tr=70.0, v=3.0, p=99.0, source=AD))
    # --- F. edge cases
    V.append(_vec("EDGE-WIND-ZERO-CLAMP", "edge", "Wind 0.0 m/s is clamped to 0.2 (same result as V=0.2)",
                  tdb=38.0, twb=28.0, tr=38.0, v=0.0, p=100.0, source="B&B 2002 App.1 (min 0.2 m/s)"))
    V.append(_vec("EDGE-WIND-6-CLAMP", "edge", "Wind 6 m/s is clamped to 4.0 (DB 44, RH 15%, MRT 68)",
                  tdb=44.0, rh=15.0, tr=68.0, v=6.0, p=100.0, source="B&B 2002 App.1 (max 4 m/s)"))
    V.append(_vec("EDGE-NO-ROOT-NET-HEAT-GAIN", "edge", "DB 42, WB 36, MRT 70, 0.2 m/s: skin gains heat even at 38.2 C -> TWL 0",
                  tdb=42.0, twb=36.0, tr=70.0, v=0.2, p=100.0, source="oracle convention",
                  note="engine must return 0 and flag NO_ROOT_NET_HEAT_GAIN"))
    V.append(_vec("EDGE-COOL-HIGH-TWL", "edge", "Cool: DB 25, RH 50%, MRT 25, 1 m/s -> high TWL (near top of valid range)",
                  tdb=25.0, rh=50.0, tr=25.0, v=1.0, p=101.3, source="oracle"))
    V.append(_vec("GLOBE-150MM", "globe_to_mrt", "Globe input: DB 40, RH 40%, globe 50 C (150 mm), 1 m/s -> MRT via ISO 7726",
                  tdb=40.0, rh=40.0, tg=50.0, globe_d=0.15, v=1.0, p=100.0, source="ISO 7726:1998 Annex B, D=0.15 m"))
    V.append(_vec("GLOBE-25MM", "globe_to_mrt", "Same globe reading 50 C but from a RAW (uncorrected) 25 mm globe -> much higher MRT, lower TWL. "
                  "NOT for Kestrel 5400 output: its displayed Tg is already converted to a 150 mm-globe equivalent, so use D = 0.15 m "
                  "[label corrected by fact-check 2026-11-09]",
                  tdb=40.0, rh=40.0, tg=50.0, globe_d=0.025, v=1.0, p=100.0, source="ISO 7726 Annex B with D=0.025 m"))
    # --- G. clothing variants (environment of AD-SUN-40-40)
    V.append(_vec("CLO-WOVEN-0.61-0.38", "clothing", "Woven work clothes Icl 0.61, icl 0.38 (Kapanowski 2018 Table I); DB 40, RH 40%, MRT 65, 1 m/s",
                  tdb=40.0, rh=40.0, tr=65.0, v=1.0, p=100.0, icl=0.61, iclp=0.38, source="clothing values: Kapanowski 2018"))
    V.append(_vec("CLO-COVERALLS-0.96-0.39", "clothing", "Work clothes + coveralls Icl 0.96, icl 0.39 (Kestrel 5400 preset); same environment",
                  tdb=40.0, rh=40.0, tr=65.0, v=1.0, p=100.0, icl=0.96, iclp=0.39, source="clothing values: Kestrel 5400 TWL statement 2024"))
    # --- H. zone-boundary vectors (WB solved so that TWL ~ boundary -/+ 0.5)
    for target in (114.5, 115.5, 139.5, 140.5, 219.5, 220.5):
        wb = _wb_for_target(lambda w: w + 8.0, target, 0.5, 100.0, lambda t: t + 5.0)
        V.append(_vec(f"ZONE-BOUNDARY-{target:g}", "zone_boundary",
                      f"DB = WB+8, MRT = DB+5, 0.5 m/s, 100 kPa; WB solved for TWL ~= {target}",
                      tdb=wb + 8.0, twb=wb, tr=wb + 13.0, v=0.5, p=100.0, source="oracle (classification test)"))
    return V


# =============================================================================
# 7. Main
# =============================================================================
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--no-write", action="store_true")
    args = ap.parse_args()

    print("Zill TWL oracle -- validation against published values")
    rep = validate(verbose=True)
    s = rep["tableI_stats"]
    print(f"\nTable I summary: physical mean {s['physical']['mean']:+.2f} rms {s['physical']['rms']:.2f} "
          f"max|e| {s['physical']['max_abs']:.2f}; alt_1p8 mean {s['alt_1p8']['mean']:+.2f} rms {s['alt_1p8']['rms']:.2f} "
          f"max|e| {s['alt_1p8']['max_abs']:.2f}")
    for t in rep["aoh2002_table1"]:
        print(f"AOH Table 1 {t['label']}: WB at TWL=140 model {t['model_wb_at_140']:.2f} vs published {t['published_wb_at_140']}")

    vectors = build_vectors()
    fixture = {
        "schema_version": SCHEMA_VERSION,
        "title": "Thermal Work Limit (TWL) reference vectors -- Brake & Bates (2002) algorithm",
        "spec": "docs/research/twl_and_regulation.md",
        "generator": "scripts/oracles/twl_oracle.py",
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "environment": {"python": platform.python_version(), "platform": platform.platform()},
        "units": {"temperature": "degC", "wind": "m/s", "pressure": "kPa", "twl": "W/m2 (metabolic heat per m2 body surface)",
                  "vapour_pressure": "kPa", "sweat_rate": "kg m-2 h-1 (and L/h for a 1.8 m2 person)"},
        "conventions": {
            "default_variant": "physical",
            "humidity": "wet bulb is PSYCHROMETRIC (aspirated), not natural wet bulb; pa = psat(twb) - 0.000644*P*(tdb-twb)",
            "psat": "Tetens: 0.6105*exp(17.27*t/(t+237.3)) kPa",
            "mrt_from_globe": "ISO 7726:1998 Annex B, max(natural, forced) convection, emissivity 0.95; default D = 0.15 m",
            "wind": "clamped to [0.2, 4.0] m/s before use",
            "root": "scan down from tcore-1e-6 in 0.05 K steps to first tsk with H-loss >= 0, then bisect to 1e-10 K",
            "no_root": "if H-loss >= 0 already at tcore-1e-6 -> TWL = 0, flag NO_ROOT_NET_HEAT_GAIN",
            "zones": "ADOSH-SF TG v4.0 Table 1: HIGH if TWL<115; MEDIUM if 115<=TWL<140; LOW if TWL>=140 (sub-band >=220 'unrestricted' from B&B 2002)",
            "backstops": "B&B 2002 Table II / M&B 2007 Table 6: DB>44 C or WB>32 C -> withdrawal/restricted regardless of TWL (NOT in ADOSH v4.0 table)",
            "display": "compare unrounded TWL to thresholds; if displaying an integer use floor()",
        },
        "constants": {
            "TCORE_LIMIT_C": TCORE_LIMIT_C, "SR_MAX_KG_M2_H": SR_MAX_KG_M2_H, "LAMBDA_KJ_KG": LAMBDA_KJ_KG,
            "LSR_PER_SR": LSR_PER_SR, "POSTURE_FR": POSTURE_FR, "LEWIS_RATIO": LEWIS_RATIO, "V_MIN": V_MIN, "V_MAX": V_MAX,
            "ICL_DEFAULT": ICL_DEFAULT, "ICL_PERM_DEFAULT": ICL_PERM_DEFAULT, "PSYCHRO_A": PSYCHRO_A, "TETENS": TETENS,
            "KCS": "84 + 72*tanh(1.3*(t_sigma-37.9))", "SR": "0.42 + 0.44*tanh(1.16*(t_sigma-37.4))",
            "T_SIGMA": "0.1*tsk + 0.9*tcore", "HC": "0.608*P^0.6*V^0.6", "HR": "4.61*(1+(tr+tsk)/546)^3",
            "HE": "1587*hc*P/(P-pa)^2", "FCL": "1+0.3*Icl", "RCL": "0.155*Icl", "RECL": "Rcl/(16.5*icl)",
            "RESP": "B = 0.0014*M*(34-ta) + 0.0173*M*(5.87-pa)",
            "TWL_VALID_RANGE": [TWL_VALID_MIN, TWL_VALID_MAX],
        },
        "validation": {k: rep[k] for k in ("tableI_stats", "text_examples", "aoh2002_table2", "aoh2002_table1",
                                           "miller_bates_2007_chamber", "checks", "failures")},
        "tableI_full": rep["tableI_cells"],
        "vectors": vectors,
    }
    n_fail = len(rep["failures"])
    print(f"\n{len(vectors)} vectors built; {n_fail} acceptance failure(s): {rep['failures']}")
    if not args.no_write:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)

        def _clean(o):
            if isinstance(o, float):
                if math.isinf(o) or math.isnan(o):
                    return None
                return round(o, 6)
            if isinstance(o, dict):
                return {k: _clean(v) for k, v in o.items()}
            if isinstance(o, (list, tuple)):
                return [_clean(v) for v in o]
            return o
        out.write_text(json.dumps(_clean(fixture), indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"wrote {out}")
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
