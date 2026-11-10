#!/usr/bin/env python
"""ISO 7933 Predicted Heat Strain (PHS) oracle vectors for Zill.

Writes ``fixtures/phs.json`` (path relative to the project root, i.e. two levels
above this file's directory).

What it produces
----------------
* ``vectors``  - single-run oracle vectors. ``engine = "pythermalcomfort"`` rows are
  produced by ``pythermalcomfort.models.phs`` (the oracle the TypeScript engine must
  match); ``engine = "reference:<variant>"`` rows come from ``phs_reference`` below,
  a line-by-line transcription of docs/research/phs_iso7933.md which is asserted to
  reproduce pythermalcomfort to < 1e-9 before anything is written.
  Groups: ISO 7933:2004 Annex F (10 cases), ISO 7933:2023 Annex F (5 cases),
  Abu Dhabi scenarios (>= 10), edge cases.
* ``chains``   - piecewise (segment-by-segment) runs: pythermalcomfort chained calls
  vs. the recommended continuous-state semantics, incl. a 60 min work + 15 min rest
  x 2 worked example.
* ``traces``   - minute-by-minute intermediate variables for two vectors, so a port can
  locate the first diverging minute.
* ``mrt_from_globe`` - Liljegren 2-inch globe -> mean radiant temperature examples.

Run (from anywhere):
    python scripts/oracles/phs_oracle.py
Requires: pythermalcomfort 4.8.1, thermofeel 2.3.0, numpy (numba via pythermalcomfort).
The script is deterministic (no timestamps); re-running reproduces the same JSON on
the same library versions.
"""
from __future__ import annotations

import json
import math
import os
import platform
import sys
import warnings

import numpy as np

import pythermalcomfort
from pythermalcomfort.environment import mean_radiant_tmp
from pythermalcomfort.models import phs
from pythermalcomfort.psychrometrics import p_sat

import thermofeel
from thermofeel import liljegren as lj

warnings.simplefilter("ignore")  # range warnings are recorded explicitly as validity flags

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(ROOT, "fixtures", "phs.json")

MET_TO_WM2 = 58.15  # pythermalcomfort.utilities.met_to_w_m2
OUTPUT_KEYS = [
    "t_re", "t_sk", "t_cr", "t_cr_eq", "t_sk_t_cr_wg", "d_lim_loss_50", "d_lim_loss_95",
    "d_lim_t_re", "sweat_rate_watt", "sweat_loss_g", "evap_load_wm2_min",
]
STATE_KEYS = ["t_sk", "t_cr", "t_re", "t_cr_eq", "t_sk_t_cr_wg", "sweat_rate_watt", "evap_load_wm2_min"]

# --------------------------------------------------------------------------------------
# Reference implementation (transcription of the spec; mirrors pythermalcomfort 4.8.1)
# --------------------------------------------------------------------------------------
C_TEQ = math.exp(-1 / 10)  # core temp as f(M): time constant 10 min
C_TSK = math.exp(-1 / 3)   # skin temperature: time constant 3 min
C_SW = math.exp(-1 / 10)   # sweat rate: time constant 10 min
A_R_DU = {"standing": 0.77, "sitting": 0.7, "crouching": 0.67}


def p_sat_magnus_kpa(t):
    """Saturation vapour pressure [kPa] used by ISO 7933 Annex E (and pythermalcomfort 2023 p_a)."""
    return 0.6105 * math.exp(17.27 * t / (t + 237.3))


def p_sat_pytc_kpa(t):
    """pythermalcomfort.psychrometrics.p_sat (Hyland-Wexler/ASHRAE) in kPa (2004 path p_a)."""
    return float(p_sat(t)) / 1000.0


def phs_reference(tdb, tr, v, p_a, met, clo, posture, wme=0.0, model="7933-2023", i_mst=0.38,
                  a_p=0.54, drink=1, weight=75.0, height=1.8, walk_sp=0.0, theta=0.0,
                  acclimatized=100, duration=480, f_r=None, t_sk=34.1, t_cr=36.8, t_re=None,
                  t_cr_eq=None, t_sk_t_cr_wg=0.3, sweat_rate_watt=0.0, evap_load_wm2_min=0.0,
                  hc_mode="pytc", minute1_override=None, trace=None, sp_heat_const=MET_TO_WM2,
                  drink0_factor=True):
    """One PHS run. Units: tdb, tr [degC]; v [m/s]; p_a [kPa]; met, wme [W/m2]; clo [clo].

    hc_mode: "pytc"     -> pythermalcomfort 4.8.1 (hc fixed for the run: 2004 from the initial
                           t_sk, 2023 from t_cl = tr + 0.1)
             "tcl_iter" -> 2023 hc = max(z, 2.38*|t_cl - tdb|**0.25) re-evaluated inside the
                           t_cl iteration (jsthermalcomfort behaviour; reproduces ISO 2023 Annex F case 3)
    minute1_override: None -> model default (2023: t_sk = t_sk_eq at minute 1 of this call).
    """
    m2023 = model == "7933-2023"
    if f_r is None:
        f_r = 0.42 if m2023 else 0.97
    if t_re is None:
        t_re = 36.8 if m2023 else t_cr
    if t_cr_eq is None:
        t_cr_eq = 36.8 if m2023 else t_cr
    if minute1_override is None:
        minute1_override = m2023

    a_dubois = 0.202 * (weight ** 0.425) * (height ** 0.725)
    # pythermalcomfort uses 58.15 (its met constant); the 2004 Annex E BASIC transcriptions use
    # 57.83 (= 3470/60) and the 2023 MATLAB transcription 3490/60 - see spec section 6.
    sp_heat = sp_heat_const * weight / a_dubois
    d_lim_t_re = 0
    d_lim_loss_50 = 0
    d_lim_loss_95 = 0
    sw_tot_g = 0.0
    if m2023:
        d_max_50 = (0.03 if drink == 0 else 0.05) * weight * 1000
        d_max_95 = (0.03 if drink == 0 else 0.05) * weight * 1000
    else:
        d_max_50 = 0.075 * weight * 1000
        d_max_95 = 0.05 * weight * 1000
    def_dir = 1 if theta != 0 else 0
    def_speed = 0 if walk_sp == 0 else 1
    a_r_du = A_R_DU[posture]
    if not m2023:
        sw_max = (met - 32) * a_dubois
        sw_max = min(sw_max, 400)
        sw_max = max(sw_max, 250)
        if acclimatized == 100:
            sw_max = sw_max * 1.25
    else:
        sw_max = 400 if acclimatized == 0 else 500
    w_max = 0.85 if acclimatized == 0 else 1
    i_cl_st = clo * 0.155
    fcl = 1 + 0.28 * clo if m2023 else 1 + 0.3 * clo
    i_a_st = 0.111
    i_tot_st = i_cl_st + i_a_st / fcl
    if def_speed > 0:
        if def_dir == 1:
            v_r = abs(v - walk_sp * math.cos(3.14159 * theta / 180))
        elif v < walk_sp:
            v_r = walk_sp
        else:
            v_r = v
    else:
        walk_sp = 0.0052 * (met - 58)
        walk_sp = min(walk_sp, 0.7)
        v_r = v
    v_ux = 3 if v_r > 3 else v_r
    w_a_ux = 1.5 if walk_sp > 1.5 else walk_sp
    corr_cl = 1.044 * math.exp((0.066 * v_ux - 0.398) * v_ux + (0.094 * w_a_ux - 0.378) * w_a_ux)
    corr_cl = min(corr_cl, 1)
    corr_ia = math.exp((0.047 * v_r - 0.472) * v_r + (0.117 * w_a_ux - 0.342) * w_a_ux)
    corr_ia = min(corr_ia, 1)
    corr_tot = corr_cl
    if clo <= 0.6:
        corr_tot = ((0.6 - clo) * corr_ia + clo * corr_cl) / 0.6
    i_tot_dyn = i_tot_st * corr_tot
    i_a_dyn = corr_ia * i_a_st
    i_cl_dyn = i_tot_dyn - i_a_dyn / fcl
    corr_e = (2.6 * corr_tot - 6.5) * corr_tot + 4.9
    im_dyn = min(i_mst * corr_e, 0.9)
    r_t_dyn = i_tot_dyn / im_dyn / 16.7
    t_exp = 28.56 + 0.115 * tdb + 0.641 * p_a
    c_res = 0.001516 * met * (t_exp - tdb)
    e_res = 0.00127 * met * (59.34 + 0.53 * tdb - 11.63 * p_a)
    z = 3.5 + 5.2 * v_r
    if v_r > 1:
        z = 8.7 * v_r ** 0.6
    if not m2023:
        hc_dyn = 2.38 * abs(t_sk - tdb) ** 0.25
    else:
        hc_dyn = 2.38 * abs(tr + 0.1 - tdb) ** 0.25
    hc_dyn = max(hc_dyn, z)
    hc_dyn_initial = hc_dyn
    aux_r = 5.67e-08 * a_r_du
    if m2023:
        f_cl_r = (1 - a_p) * 0.97 + a_p * (1 - f_r)
    else:
        f_cl_r = (1 - a_p) * 0.97 + a_p * f_r
    t_cr_eq_m = 0.0036 * met + 36.6
    t_sk_eq_cl_base = (12.165 + 0.02017 * tdb + 0.04361 * tr + 0.19354 * p_a - 0.25315 * v
                       + 0.005346 * met)
    t_sk_eq_nu_base = 7.191 + 0.064 * tdb + 0.061 * tr + 0.198 * p_a - 0.348 * v

    it_tcl_max = 0
    it_tcr_max = 0
    for time in range(1, duration + 1):
        t_sk0, t_re0, t_cr0, t_cr_eq0, wg0 = t_sk, t_re, t_cr, t_cr_eq, t_sk_t_cr_wg
        t_cr_eq = t_cr_eq0 * C_TEQ + t_cr_eq_m * (1 - C_TEQ)
        d_stored_eq = sp_heat * (t_cr_eq - t_cr_eq0) * (1 - wg0)
        t_sk_eq_cl = t_sk_eq_cl_base + 0.51274 * t_re
        t_sk_eq_nu = t_sk_eq_nu_base + 0.616 * t_re
        if clo >= 0.6:
            t_sk_eq = t_sk_eq_cl
        elif clo <= 0.2:
            t_sk_eq = t_sk_eq_nu
        else:
            t_sk_eq = t_sk_eq_nu + 2.5 * (t_sk_eq_cl - t_sk_eq_nu) * (clo - 0.2)
        t_sk = t_sk0 * C_TSK + t_sk_eq * (1 - C_TSK)
        if time == 1 and minute1_override:
            t_sk = t_sk_eq
        p_sk = 0.6105 * math.exp(17.27 * t_sk / (t_sk + 237.3))
        t_cl = tr + 0.1
        it = 0
        while True:
            it += 1
            if it > 1000:
                raise RuntimeError("t_cl iteration did not converge")
            if hc_mode == "tcl_iter" and m2023:
                hc_dyn = max(2.38 * abs(t_cl - tdb) ** 0.25, z)
            h_r = f_cl_r * aux_r * ((t_cl + 273) ** 4 - (tr + 273) ** 4) / (t_cl - tr)
            t_cl_new = ((fcl * (hc_dyn * tdb + h_r * tr) + t_sk / i_cl_dyn)
                        / (fcl * (hc_dyn + h_r) + 1 / i_cl_dyn))
            if abs(t_cl - t_cl_new) <= 0.001:
                break
            t_cl = (t_cl + t_cl_new) / 2
        it_tcl_max = max(it_tcl_max, it)
        convection = fcl * hc_dyn * (t_cl - tdb)
        radiation = fcl * h_r * (t_cl - tr)
        e_max = (p_sk - p_a) / r_t_dyn
        if e_max == 0:
            e_max = 0.001
        e_req = met - d_stored_eq - wme - c_res - e_res - convection - radiation
        w_req = e_req / e_max
        if e_req <= 0:
            e_req = 0
            sw_req = 0
        elif e_max <= 0:
            e_max = 0
            sw_req = sw_max
        elif w_req >= 1.7:
            sw_req = sw_max
        else:
            e_v_eff = (2 - w_req) ** 2 / 2 if w_req > 1 else 1 - w_req ** 2 / 2
            e_v_eff = max(0.05, e_v_eff)
            sw_req = min(e_req / e_v_eff, sw_max)
        sweat_rate_watt = sweat_rate_watt * C_SW + sw_req * (1 - C_SW)
        if sweat_rate_watt <= 0:
            e_p = 0
            sweat_rate_watt = 0
            w_p = 0.0
        else:
            k = e_max / max(sweat_rate_watt, 1e-6)
            w_p = 1
            if k >= 0.5:
                w_p = -k + math.sqrt(k * k + 2)
            w_p = min(w_p, w_max)
            e_p = w_p * e_max
        d_storage = e_req - e_p + d_stored_eq
        t_cr_new = t_cr0
        it = 0
        while True:
            it += 1
            if it > 1000:
                raise RuntimeError("t_cr iteration did not converge")
            t_sk_t_cr_wg = 0.3 - 0.09 * (t_cr_new - 36.8)
            t_sk_t_cr_wg = min(t_sk_t_cr_wg, 0.3)
            t_sk_t_cr_wg = max(t_sk_t_cr_wg, 0.1)
            t_cr = d_storage / sp_heat + t_sk0 * wg0 / 2 - t_sk * t_sk_t_cr_wg / 2
            t_cr = (t_cr + t_cr0 * (1 - wg0 / 2)) / (1 - t_sk_t_cr_wg / 2)
            if abs(t_cr - t_cr_new) <= 0.001:
                break
            t_cr_new = (t_cr_new + t_cr) / 2
        it_tcr_max = max(it_tcr_max, it)
        t_re = t_re0 + (2 * t_cr - 1.962 * t_re0 - 1.31) / 9
        if d_lim_t_re == 0 and t_re >= 38:
            d_lim_t_re = time
        evap_load_wm2_min = evap_load_wm2_min + sweat_rate_watt + e_res
        sw_tot_g = evap_load_wm2_min * 2.67 * a_dubois / 1.8 / 60
        if d_lim_loss_50 == 0 and sw_tot_g >= d_max_50:
            d_lim_loss_50 = time
        if d_lim_loss_95 == 0 and sw_tot_g >= d_max_95:
            d_lim_loss_95 = time
        if trace is not None:
            trace.append({
                "minute": time, "t_cr_eq": t_cr_eq, "d_stored_eq": d_stored_eq, "t_sk_eq": t_sk_eq,
                "t_sk": t_sk, "p_sk": p_sk, "hc_dyn": hc_dyn, "t_cl": t_cl, "h_r": h_r,
                "convection": convection, "radiation": radiation, "e_max": e_max, "e_req": e_req,
                "w_req": w_req, "sw_req": sw_req, "sweat_rate_watt": sweat_rate_watt, "w_p": w_p,
                "e_p": e_p, "d_storage": d_storage, "t_sk_t_cr_wg": t_sk_t_cr_wg, "t_cr": t_cr,
                "t_re": t_re, "evap_load_wm2_min": evap_load_wm2_min, "sweat_loss_g": sw_tot_g,
            })
    if drink == 0 and drink0_factor:
        d_lim_loss_95 = d_lim_loss_95 * 0.6
        d_lim_loss_50 = d_lim_loss_95
    if d_lim_loss_50 == 0:
        d_lim_loss_50 = duration
    if d_lim_loss_95 == 0:
        d_lim_loss_95 = duration
    if d_lim_t_re == 0:
        d_lim_t_re = duration
    out = {"t_re": t_re, "t_sk": t_sk, "t_cr": t_cr, "t_cr_eq": t_cr_eq, "t_sk_t_cr_wg": t_sk_t_cr_wg,
           "d_lim_loss_50": d_lim_loss_50, "d_lim_loss_95": d_lim_loss_95, "d_lim_t_re": d_lim_t_re,
           "sweat_rate_watt": sweat_rate_watt, "sweat_loss_g": sw_tot_g,
           "evap_load_wm2_min": evap_load_wm2_min}
    derived = {"a_dubois": a_dubois, "sp_heat": sp_heat, "d_max_50": d_max_50, "d_max_95": d_max_95,
               "sw_max": sw_max, "w_max": w_max, "fcl": fcl, "i_cl_st": i_cl_st, "i_tot_st": i_tot_st,
               "v_r": v_r, "walk_sp_effective": walk_sp, "corr_cl": corr_cl, "corr_ia": corr_ia,
               "corr_tot": corr_tot, "i_tot_dyn": i_tot_dyn, "i_a_dyn": i_a_dyn, "i_cl_dyn": i_cl_dyn,
               "corr_e": corr_e, "im_dyn": im_dyn, "r_t_dyn": r_t_dyn, "t_exp": t_exp, "c_res": c_res,
               "e_res": e_res, "z": z, "hc_dyn_initial": hc_dyn_initial, "f_cl_r": f_cl_r,
               "t_cr_eq_m": t_cr_eq_m, "max_iter_t_cl": it_tcl_max, "max_iter_t_cr": it_tcr_max}
    return out, derived


# --------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------
def a_dubois(weight=75.0, height=1.8):
    return 0.202 * (weight ** 0.425) * (height ** 0.725)


def p_a_for(model, tdb, rh):
    return p_sat_magnus_kpa(tdb) * rh / 100 if model == "7933-2023" else p_sat_pytc_kpa(tdb) * rh / 100


def rh_for_p_a(model, tdb, p_a):
    return 100.0 * p_a / (p_sat_magnus_kpa(tdb) if model == "7933-2023" else p_sat_pytc_kpa(tdb))


def tr_from_globe_iso7726_forced(tg, ta, va, d=0.15, eps=0.95, k=1.1e8, t0=273.0):
    """ISO 7726 forced-convection globe formula (as used by ISO 7933:2023 Annex F; t0=273)."""
    return ((tg + t0) ** 4 + k * va ** 0.6 / (eps * d ** 0.4) * (tg - ta)) ** 0.25 - t0


def full_inputs(model, tdb, tr, v, rh, met_wm2, clo, posture, **kw):
    """Explicit, complete input record (pythermalcomfort names + engine-native units)."""
    m2023 = model == "7933-2023"
    d = {
        "model": model, "tdb": tdb, "tr": tr, "v": v, "rh": rh, "met": met_wm2 / MET_TO_WM2,
        "clo": clo, "posture": posture, "wme": 0.0, "i_mst": 0.38, "a_p": 0.54, "drink": 1,
        "weight": 75.0, "height": 1.8, "walk_sp": 0.0, "theta": 0.0, "acclimatized": 100,
        "duration": 480, "f_r": 0.42 if m2023 else 0.97, "t_sk": 34.1, "t_cr": 36.8,
        "t_re": 36.8, "t_cr_eq": 36.8, "t_sk_t_cr_wg": 0.3, "sweat_rate_watt": 0.0,
        "evap_load_wm2_min": 0.0, "limit_inputs": False, "round_output": False,
    }
    d.update(kw)
    d["met_wm2"] = d["met"] * MET_TO_WM2
    d["wme_wm2"] = d["wme"] * MET_TO_WM2
    d["p_a_kpa"] = p_a_for(model, tdb, rh)
    return d


PYTC_ARGS = ["tdb", "tr", "v", "rh", "met", "clo", "posture", "wme", "model", "i_mst", "a_p", "drink",
             "weight", "height", "walk_sp", "theta", "acclimatized", "duration", "f_r", "t_sk", "t_cr",
             "t_re", "t_cr_eq", "t_sk_t_cr_wg", "sweat_rate_watt", "evap_load_wm2_min", "limit_inputs",
             "round_output"]


def run_pytc(inp):
    kwargs = {k: inp[k] for k in PYTC_ARGS}
    r = phs(**kwargs)
    return {k: float(np.asarray(getattr(r, k))) for k in OUTPUT_KEYS}


def run_ref(inp, **opts):
    return phs_reference(inp["tdb"], inp["tr"], inp["v"], inp["p_a_kpa"], inp["met_wm2"], inp["clo"],
                         inp["posture"], wme=inp["wme_wm2"], model=inp["model"], i_mst=inp["i_mst"],
                         a_p=inp["a_p"], drink=inp["drink"], weight=inp["weight"], height=inp["height"],
                         walk_sp=inp["walk_sp"], theta=inp["theta"], acclimatized=inp["acclimatized"],
                         duration=inp["duration"], f_r=inp["f_r"], t_sk=inp["t_sk"], t_cr=inp["t_cr"],
                         t_re=inp["t_re"], t_cr_eq=inp["t_cr_eq"], t_sk_t_cr_wg=inp["t_sk_t_cr_wg"],
                         sweat_rate_watt=inp["sweat_rate_watt"],
                         evap_load_wm2_min=inp["evap_load_wm2_min"], **opts)


def pytc_round(out):
    """pythermalcomfort rounding (numpy round-half-even on the binary value): 1 dp, wg 2 dp."""
    return {k: float(np.around(v, 2 if k == "t_sk_t_cr_wg" else 1)) for k, v in out.items()}


def validity(inp):
    """ISO 7933 Annex A Table A.1 limits exactly as implemented in pythermalcomfort 4.8.1."""
    m2023 = inp["model"] == "7933-2023"
    checks = {
        "tdb": (inp["tdb"], 15.0, 50.0),
        "tr_minus_tdb": (inp["tr"] - inp["tdb"], 0.0, 60.0),
        "v": (inp["v"], 0.0, 3.0),
        "p_a_kpa": (inp["p_a_kpa"], 0.5 if m2023 else 0.0, 4.5),
        "met_wm2": (inp["met_wm2"], 56.0 if m2023 else 100.0, 250.0 if m2023 else 450.0),
        "clo": (inp["clo"], 0.1, 1.0),
    }
    failing = [k for k, (x, lo, hi) in checks.items() if x < lo or x > hi]
    return {"failing": failing, "within_limits": not failing,
            "pythermalcomfort_limit_inputs_true_returns_null": bool(failing)}


MAX_DIFF = {"value": 0.0, "where": None}


def check_ref_vs_pytc(vid, pytc_out, ref_out):
    for k in OUTPUT_KEYS:
        d = abs(pytc_out[k] - ref_out[k])
        scale = max(1.0, abs(pytc_out[k]))
        if d / scale > MAX_DIFF["value"]:
            MAX_DIFF["value"] = d / scale
            MAX_DIFF["where"] = f"{vid}:{k}"
        if d / scale > 1e-9:
            raise AssertionError(f"reference != pythermalcomfort for {vid} {k}: {pytc_out[k]} vs {ref_out[k]}")


def margins(trace, out, derived):
    """Distance of each D_lim crossing from its threshold (detects fragile +-1 min cases)."""
    res = {}
    for key, var, thr in (("d_lim_t_re", "t_re", 38.0), ("d_lim_loss_95", "sweat_loss_g", derived["d_max_95"])):
        m = None
        for i, row in enumerate(trace):
            if row[var] >= thr:
                after = row[var] - thr
                before = (trace[i - 1][var] - thr) if i > 0 else None
                m = {"minute": row["minute"], "value_minus_threshold_at_crossing": after,
                     "value_minus_threshold_minute_before": before}
                break
        res[key] = m
    return res


VECTORS = []


def add_vector(vid, group, description, inp, iso_published=None, extra_variants=("tcl_iter",),
               notes=None, keep_trace=False):
    pytc_out = run_pytc(inp)
    trace = []
    ref_out, derived = run_ref(inp, trace=trace)
    check_ref_vs_pytc(vid, pytc_out, ref_out)
    vec = {
        "id": vid, "group": group, "description": description, "engine": "pythermalcomfort",
        "inputs": {k: inp[k] for k in PYTC_ARGS + ["met_wm2", "wme_wm2", "p_a_kpa"]},
        "outputs": pytc_out,
        "outputs_rounded_pythermalcomfort": pytc_round(pytc_out),
        "validity": validity(inp),
        "derived": derived,
        "d_lim_margins": margins(trace, ref_out, derived),
    }
    if inp["model"] == "7933-2023" and extra_variants:
        vec["variants"] = {}
        for var in extra_variants:
            o, _ = run_ref(inp, hc_mode=var)
            vec["variants"][f"reference:hc_{var}"] = o
        if inp["drink"] == 0:
            # 2023 semantics per the Annex E transcriptions: 3 % threshold only, no extra x0.6
            o, _ = run_ref(inp, drink0_factor=False)
            vec["variants"]["reference:drink0_threshold_3pct_without_x0.6"] = o
    if inp["model"] == "7933-2004" and group == "iso_7933_2004_annex_f":
        o, _ = run_ref(inp, sp_heat_const=57.83)
        vec.setdefault("variants", {})["reference:sp_heat_57.83_(2004_BASIC)"] = o
    if iso_published is not None:
        vec["iso_published"] = iso_published
    if notes:
        vec["notes"] = notes
    VECTORS.append(vec)
    return vec, trace


# --------------------------------------------------------------------------------------
# 1) ISO 7933:2004 Annex F (Table F.1) - 10 cases
#    Published values transcribed from the R package 'comf' dataset dfISO7933AppF
#    (secondary transcription of ISO 7933:2004 Annex F; the standard itself is paywalled).
# --------------------------------------------------------------------------------------
ISO2004 = [
    # accl, posture, Ta, Pa[kPa], Tr, Va, M[W/m2], Icl, theta, walk_sp | Tre, SWtotg, Dlimtre, Dlimloss50, Dlimloss95
    (100, "standing", 40, 2.5, 40, 0.3, 150, 0.5, 0, 0, 37.5, 6168, 480, 439, 298),
    (100, "standing", 35, 4.0, 35, 0.3, 150, 0.5, 0, 0, 39.8, 6935, 74, 385, 256),
    (100, "standing", 30, 3.0, 50, 0.3, 150, 0.5, 0, 0, 37.7, 7166, 480, 380, 258),
    (0, "standing", 28, 3.0, 58, 0.3, 150, 0.5, 0, 0, 41.2, 5807, 57, 466, 314),
    (0, "sitting", 35, 3.0, 35, 1.0, 150, 0.5, 0, 0, 37.6, 3892, 480, 480, 463),
    (100, "sitting", 43, 3.0, 43, 0.3, 103, 0.5, 0, 0, 37.3, 6763, 480, 401, 271),
    (0, "standing", 35, 3.0, 35, 0.3, 206, 0.5, 0, 0, 39.2, 7236, 70, 372, 247),
    (0, "standing", 34, 3.0, 34, 0.3, 150, 1.0, 0, 0, 41.0, 5548, 67, 480, 318),
    (100, "standing", 40, 3.0, 40, 0.3, 150, 0.4, 0, 0, 37.5, 6684, 480, 407, 276),
    (100, "standing", 40, 3.0, 40, 0.3, 150, 0.4, 90, 1, 37.6, 5379, 480, 480, 339),
]
ISO2004_WORST = {"t_re": 0.0, "sweat_loss_g": 0.0, "d_lim_t_re": 0.0, "d_lim_loss_50": 0.0, "d_lim_loss_95": 0.0}
ISO2004_WORST_5783 = dict(ISO2004_WORST)
trace_iso = None
for i, c in enumerate(ISO2004, start=1):
    accl, post, ta, pa, tr, va, m, icl, th, ws, e_tre, e_sw, e_dt, e_50, e_95 = c
    model = "7933-2004"
    inp = full_inputs(model, ta, tr, va, rh_for_p_a(model, ta, pa), m, icl, post, acclimatized=accl,
                      theta=float(th), walk_sp=float(ws), a_p=0.54, f_r=0.97)
    pub = {"source": "ISO 7933:2004 Annex F (Table F.1) via R package comf dataset dfISO7933AppF "
                     "(secondary transcription; standard paywalled)",
           "p_a_kpa": pa, "met_wm2": m, "t_re": e_tre, "sweat_loss_g": e_sw, "d_lim_t_re": e_dt,
           "d_lim_loss_50": e_50, "d_lim_loss_95": e_95}
    vec, tr_rows = add_vector(f"ISO2004-F{i:02d}", "iso_7933_2004_annex_f",
                              f"ISO 7933:2004 Annex F case {i}", inp, iso_published=pub)
    o = vec["outputs"]
    vec["delta_vs_iso_published"] = {
        "t_re_rounded": round(o["t_re"], 1) - e_tre, "sweat_loss_g": o["sweat_loss_g"] - e_sw,
        "d_lim_t_re": o["d_lim_t_re"] - e_dt, "d_lim_loss_50": o["d_lim_loss_50"] - e_50,
        "d_lim_loss_95": o["d_lim_loss_95"] - e_95}
    for k, d in vec["delta_vs_iso_published"].items():
        kk = "t_re" if k == "t_re_rounded" else k
        ISO2004_WORST[kk] = max(ISO2004_WORST[kk], abs(d))
    # sensitivity: sp_heat constant 57.83 (= 3470/60, as in the 2004 Annex E BASIC transcriptions)
    o2 = vec["variants"]["reference:sp_heat_57.83_(2004_BASIC)"]
    vec["delta_vs_iso_published_sp_heat_57.83"] = {
        "t_re_rounded": round(o2["t_re"], 1) - e_tre, "sweat_loss_g": o2["sweat_loss_g"] - e_sw,
        "d_lim_t_re": o2["d_lim_t_re"] - e_dt, "d_lim_loss_50": o2["d_lim_loss_50"] - e_50,
        "d_lim_loss_95": o2["d_lim_loss_95"] - e_95}
    for k, d in vec["delta_vs_iso_published_sp_heat_57.83"].items():
        kk = "t_re" if k == "t_re_rounded" else k
        ISO2004_WORST_5783[kk] = max(ISO2004_WORST_5783[kk], abs(d))
    if i == 1:
        trace_iso = tr_rows
# Acceptance of the oracle itself against the published table (pythermalcomfort tolerance
# in its own CI: t_re 0.1, sweat 10 g, D_lim 1 min).
assert ISO2004_WORST["t_re"] <= 0.1 + 1e-9, ISO2004_WORST
assert ISO2004_WORST["sweat_loss_g"] <= 10, ISO2004_WORST
assert max(ISO2004_WORST["d_lim_t_re"], ISO2004_WORST["d_lim_loss_50"], ISO2004_WORST["d_lim_loss_95"]) <= 1
# Spec section 6.2 claim: with sp_heat = 57.83*W/ADu the published table is reproduced exactly
# (t_re to 0.1 degC, every D_lim to the minute, water loss within the 1 g printing resolution).
assert ISO2004_WORST_5783["t_re"] < 1e-9 and ISO2004_WORST_5783["sweat_loss_g"] < 0.5, ISO2004_WORST_5783
assert max(ISO2004_WORST_5783["d_lim_t_re"], ISO2004_WORST_5783["d_lim_loss_50"],
           ISO2004_WORST_5783["d_lim_loss_95"]) == 0, ISO2004_WORST_5783

# --------------------------------------------------------------------------------------
# 2) ISO 7933:2023 Annex F - 5 working conditions
#    Inputs/expected values as tabulated in pythermalcomfort issue #217 (secondary).
#    tr is derived from the globe temperature tg with the ISO 7726 forced-convection
#    formula (D = 0.15 m, eps_g = 0.95, 1.1e8, 273), which reproduces the tr printed in
#    the annex (40.0, 35.0, 52.0, 30.0, 74.6). M is given in W -> W/m2 via ADu(75 kg, 1.8 m).
# --------------------------------------------------------------------------------------
ISO2023 = [
    # accl, posture, Ta, Tg, Va, RH, M[W], Icl, Ap, Fr | tr, SWp[g/h], SWtot[g], tre, Dlim_loss, Dlim_tcr
    (100, "standing", 40, 40, 0.3, 35, 300, 0.5, 0.0, 0.0, 40.0, 813, 6538, 37.6, 280, None),
    (0, "standing", 35, 35, 0.1, 60, 300, 0.5, 0.0, 0.0, 35.0, 633, 6345, 40.8, 250, 62),
    (0, "standing", 30, 45, 0.1, 35, 300, 0.8, 0.3, 0.85, 52.0, 764, 6419, 38.7, 280, 149),
    (0, "standing", 30, 30, 1.0, 45, 450, 0.5, 0.0, 0.0, 30.0, 547, 4593, 38.0, 400, None),
    (100, "sitting", 35, 50, 1.0, 30, 250, 1.0, 0.2, 0.85, 74.6, 718, 5813, 37.5, 310, None),
]
ADU_STD = a_dubois(75.0, 1.8)
for i, c in enumerate(ISO2023, start=1):
    accl, post, ta, tg, va, rh, m_w, icl, ap, fr, e_tr, e_swp, e_sw, e_tre, e_dl, e_dt = c
    model = "7933-2023"
    tr = tr_from_globe_iso7726_forced(tg, ta, va)
    inp = full_inputs(model, ta, tr, va, float(rh), m_w / ADU_STD, icl, post, acclimatized=accl,
                      a_p=ap, f_r=fr)
    pub = {"source": "ISO 7933:2023 Annex F as tabulated in pythermalcomfort issue #217 "
                     "(secondary; standard paywalled)",
           "tg": tg, "globe_diameter_m": 0.15, "metabolic_rate_W": m_w, "tr": e_tr,
           "sweat_rate_final_g_per_h": e_swp, "sweat_loss_g": e_sw, "t_re": e_tre,
           "d_lim_loss_95": e_dl, "d_lim_t_re": e_dt,
           "d_lim_t_re_note": "null = '-' in the annex table (t_re never reaches 38 degC within 480 min)"}
    vec, _ = add_vector(f"ISO2023-F{i:02d}", "iso_7933_2023_annex_f", f"ISO 7933:2023 Annex F working condition {i}",
                        inp, iso_published=pub,
                        notes="sweat_rate_final_g_per_h(model) = sweat_rate_watt * 2.67 * ADu / 1.8")
    o = vec["outputs"]
    swp_gph = o["sweat_rate_watt"] * 2.67 * ADU_STD / 1.8
    v2 = vec["variants"]["reference:hc_tcl_iter"]
    vec["delta_vs_iso_published"] = {
        "pythermalcomfort": {"tr": tr - e_tr, "sweat_rate_final_g_per_h": swp_gph - e_swp,
                             "sweat_loss_g": o["sweat_loss_g"] - e_sw, "t_re": o["t_re"] - e_tre,
                             "d_lim_loss_95": o["d_lim_loss_95"] - e_dl,
                             "d_lim_t_re": (o["d_lim_t_re"] - e_dt) if e_dt is not None else None},
        "reference:hc_tcl_iter": {"sweat_loss_g": v2["sweat_loss_g"] - e_sw, "t_re": v2["t_re"] - e_tre,
                                  "d_lim_loss_95": v2["d_lim_loss_95"] - e_dl,
                                  "d_lim_t_re": (v2["d_lim_t_re"] - e_dt) if e_dt is not None else None},
    }

# --------------------------------------------------------------------------------------
# 3) Abu Dhabi scenarios (ISO 7933:2023 model unless stated). Scenario inputs are design
#    choices for testing, not measurements. Non-reflective clothing => a_p = 0
#    (f_r is then inert). Metabolic classes (ISO 8996): 65/100/165/230/290 W/m2.
# --------------------------------------------------------------------------------------
SUN = dict(tdb=44.0, tr=60.0, v=0.5, rh=20.0)
SHADE = dict(tdb=44.0, tr=44.0, v=0.5, rh=20.0)


def ad(vid, desc, cond, met_wm2, clo, posture="standing", model="7933-2023", **kw):
    kw.setdefault("a_p", 0.0)
    inp = full_inputs(model, cond["tdb"], cond["tr"], cond["v"], cond["rh"], met_wm2, clo, posture, **kw)
    return add_vector(vid, "abu_dhabi", desc, inp)


trace_ad = None
_, trace_ad = ad("AD01", "Sun, moderate work 165 W/m2, light work clothes 0.6 clo, acclimatized, standing, 480 min",
                 SUN, 165, 0.6)
ad("AD02", "Sun, high work 230 W/m2, 0.6 clo, acclimatized, standing, 480 min", SUN, 230, 0.6)
ad("AD03", "Sun, very high work 290 W/m2 (OUTSIDE ISO 7933:2023 metabolic range as implemented), 0.6 clo, acclimatized, 480 min",
   SUN, 290, 0.6)
ad("AD04", "Sun, moderate 165 W/m2, coveralls 1.0 clo, acclimatized, standing, 480 min", SUN, 165, 1.0)
ad("AD05", "Sun, high 230 W/m2, coveralls 1.0 clo, NOT acclimatized, standing, 120 min", SUN, 230, 1.0,
   acclimatized=0, duration=120)
ad("AD06", "Sun, high 230 W/m2, 0.6 clo, NOT acclimatized, standing, 120 min", SUN, 230, 0.6, acclimatized=0,
   duration=120)
ad("AD07", "Sun, moderate 165 W/m2, 0.6 clo, walking 1.0 m/s, theta=0 (direction not entered => v_r=max(v,walk_sp)), 120 min",
   SUN, 165, 0.6, walk_sp=1.0, theta=0.0, duration=120)
ad("AD08", "Sun, moderate 165 W/m2, 0.6 clo, walking 1.0 m/s across the wind (theta=90 => v_r=|v-walk_sp*cos|), 120 min",
   SUN, 165, 0.6, walk_sp=1.0, theta=90.0, duration=120)
ad("AD09", "Sun, moderate 165 W/m2, 0.6 clo, acclimatized, 60 min", SUN, 165, 0.6, duration=60)
ad("AD10", "Sun, low work 100 W/m2, 0.6 clo, acclimatized, 480 min", SUN, 100, 0.6)
ad("AD11", "Shade rest: resting 65 W/m2, sitting, tr = tdb = 44, 0.6 clo, 60 min", SHADE, 65, 0.6, posture="sitting",
   duration=60)
ad("AD12", "Extreme afternoon: tdb 48, tr 70, rh 15, v 0.5, high 230 W/m2, 0.6 clo, acclimatized, 120 min",
   dict(tdb=48.0, tr=70.0, v=0.5, rh=15.0), 230, 0.6, duration=120)
ad("AD13", "Humid coastal morning: tdb 36, tr 50, rh 60, v 0.5, high 230 W/m2, 0.6 clo, acclimatized, 480 min",
   dict(tdb=36.0, tr=50.0, v=0.5, rh=60.0), 230, 0.6)
ad("AD14", "Low wind sun: v 0.2 m/s, high 230 W/m2, 0.6 clo, acclimatized, 480 min (hc-variant sensitive)",
   dict(tdb=44.0, tr=60.0, v=0.2, rh=20.0), 230, 0.6)
ad("AD15", "No free drinking (drink=0, e.g. fasting): sun, moderate 165 W/m2, 0.6 clo, acclimatized, 480 min",
   SUN, 165, 0.6, drink=0)
ad("AD16", "Smaller worker 62 kg / 1.68 m: sun, high 230 W/m2, 0.6 clo, acclimatized, 480 min", SUN, 230, 0.6,
   weight=62.0, height=1.68)
ad("AD17", "Sun, high 230 W/m2, coveralls 1.0 clo, acclimatized, 480 min", SUN, 230, 1.0)
ad("AD18", "PITFALL: AD02 with pythermalcomfort 2023 reflective defaults a_p=0.54, f_r=0.42 (not ordinary clothing)",
   SUN, 230, 0.6, a_p=0.54)
ad("AD23", "SENSITIVITY: AD17 (coveralls 1.0 clo, 230 W/m2) with lower static permeability i_mst = 0.25 "
           "(illustrative value, not a measured FR-fabric property)", SUN, 230, 1.0, i_mst=0.25)
ad("AD19", "AD01 under ISO 7933:2004 model (comparison)", SUN, 165, 0.6, model="7933-2004", f_r=0.97)
ad("AD20", "AD02 under ISO 7933:2004 model (comparison)", SUN, 230, 0.6, model="7933-2004", f_r=0.97)
ad("AD21", "AD04 under ISO 7933:2004 model (comparison)", SUN, 165, 1.0, model="7933-2004", f_r=0.97)
ad("AD22", "AD06 under ISO 7933:2004 model (comparison)", SUN, 230, 0.6, model="7933-2004", f_r=0.97,
   acclimatized=0, duration=120)

# --------------------------------------------------------------------------------------
# 4) Edge cases (branch coverage for the port)
# --------------------------------------------------------------------------------------
def edge(vid, desc, model, tdb, tr, v, rh, met_wm2, clo, posture="standing", **kw):
    kw.setdefault("a_p", 0.0)
    inp = full_inputs(model, tdb, tr, v, rh, met_wm2, clo, posture, **kw)
    return add_vector(vid, "edge", desc, inp)


edge("E01", "Cool: E_req <= 0 branch (no sweating), 2023", "7933-2023", 20.0, 20.0, 1.0, 50.0, 100, 0.5,
     duration=120)
edge("E02", "Near-nude clo 0.15 (nude t_sk_eq branch), 2023", "7933-2023", 38.0, 45.0, 0.5, 30.0, 165, 0.15,
     duration=120)
edge("E03", "Crouching posture (A_r/A_Du 0.67), 2023", "7933-2023", 40.0, 50.0, 0.3, 30.0, 165, 0.6,
     posture="crouching", duration=120)
edge("E04", "Walking 1.2 m/s into the wind (theta=180 => v_r = v + walk_sp), 2023", "7933-2023", 40.0, 55.0, 0.5,
     25.0, 230, 0.6, walk_sp=1.2, theta=180.0, duration=120)
edge("E05", "Very humid: w_req >= 1.7 (SW_req = SW_max) branch, 2023", "7933-2023", 34.0, 34.0, 0.3, 80.0, 230, 1.0,
     duration=120)
edge("E06", "Air speed 2.0 m/s (z = 8.7*v_r^0.6 branch), 2023", "7933-2023", 42.0, 55.0, 2.0, 20.0, 230, 0.6,
     duration=120)
edge("E07", "Duration 1 min with t_sk0 = 20 (2023 minute-1 override t_sk = t_sk_eq)", "7933-2023", 40.0, 40.0, 0.3,
     35.0, 150, 0.5, duration=1, t_sk=20.0)
edge("E08", "Duration 1 min with t_sk0 = 20 under 2004 (exponential lag kept)", "7933-2004", 40.0, 40.0, 0.3, 35.0,
     150, 0.5, duration=1, t_sk=20.0, f_r=0.97)
edge("E09", "drink=0 under 2004: thresholds 7.5%/5% then D_lim_loss_95 *= 0.6", "7933-2004", 44.0, 60.0, 0.5, 20.0,
     165, 0.6, drink=0, f_r=0.97)
edge("E10", "drink=0 under 2004 where 5% is never reached but 3% is (x0.6 rule misses it)", "7933-2004", 35.0, 35.0,
     1.0, 30.0, 150, 0.5, drink=0, f_r=0.97, posture="sitting")
edge("E11", "Carried-over warm start state (t_re 37.6, t_cr 37.7, t_sk 35.8, SW 180, load 20000), 2023",
     "7933-2023", 44.0, 60.0, 0.5, 20.0, 165, 0.6, duration=60, t_re=37.6, t_cr=37.7, t_sk=35.8,
     t_cr_eq=37.2, t_sk_t_cr_wg=0.21, sweat_rate_watt=180.0, evap_load_wm2_min=20000.0)
edge("E12", "Non-zero external work wme = 0.5 met, 2023", "7933-2023", 40.0, 50.0, 0.5, 30.0, 230, 0.6,
     wme=0.5, duration=120)

# --------------------------------------------------------------------------------------
# 5) Chains (piecewise simulation)
# --------------------------------------------------------------------------------------
def state_of(out):
    return {k: out[k] for k in STATE_KEYS}


def chain_pytc(segments, init_state=None):
    """pythermalcomfort chained calls, carrying the 7 state variables (round_output=False)."""
    state = dict(init_state or {})
    res = []
    t0 = 0
    for seg in segments:
        inp = dict(seg)
        inp.update(state)
        out = run_pytc(inp)
        res.append({"t_start_min": t0, "duration": inp["duration"], "outputs": out})
        state = state_of(out)
        t0 += inp["duration"]
    return res


def chain_reference(segments, init_state=None, override_each_segment=False):
    """Continuous-state piecewise run with the reference kernel.

    override_each_segment=False is the recommended semantics: the 2023 minute-1 skin
    override is applied only at minute 1 of the whole shift and D_lim are counted from
    shift start. override_each_segment=True reproduces pythermalcomfort chained calls.
    """
    state = dict(init_state or {})
    segs = []
    rows = []
    t0 = 0
    for j, seg in enumerate(segments):
        inp = dict(seg)
        inp.update(state)
        tr_rows = []
        mo = None if (override_each_segment or j == 0) else False
        out, _ = run_ref(inp, trace=tr_rows, minute1_override=mo)
        for r in tr_rows:
            rows.append({"minute": t0 + r["minute"], "t_re": r["t_re"], "sweat_loss_g": r["sweat_loss_g"],
                         "t_sk": r["t_sk"], "t_cr": r["t_cr"]})
        segs.append({"t_start_min": t0, "duration": inp["duration"], "outputs": out})
        state = state_of(out)
        t0 += inp["duration"]
    m = segments[0]
    weight = m["weight"]
    dmax = (0.03 if m["drink"] == 0 else 0.05) * weight * 1000 if m["model"] == "7933-2023" else 0.05 * weight * 1000
    first_tre = next((r["minute"] for r in rows if r["t_re"] >= 38.0), None)
    first_loss = next((r["minute"] for r in rows if r["sweat_loss_g"] >= dmax), None)
    return segs, {"shift_minutes": t0, "first_minute_t_re_ge_38": first_tre,
                  "first_minute_sweat_loss_ge_dmax95": first_loss, "dmax95_g": dmax,
                  "max_t_re": max(r["t_re"] for r in rows),
                  "t_re_by_minute_every_15": [[r["minute"], r["t_re"]] for r in rows if r["minute"] % 15 == 0]}


def seg(model, cond, met_wm2, clo, duration, posture="standing", **kw):
    kw.setdefault("a_p", 0.0)
    return full_inputs(model, cond["tdb"], cond["tr"], cond["v"], cond["rh"], met_wm2, clo, posture,
                       duration=duration, **kw)


CHAINS = []
for model in ("7933-2004", "7933-2023"):
    fr = 0.97 if model == "7933-2004" else 0.42
    # A) constant conditions: 2 x 60 min chained vs one 120 min call
    s60 = seg(model, SUN, 230, 0.6, 60, f_r=fr)
    s120 = seg(model, SUN, 230, 0.6, 120, f_r=fr)
    single = run_pytc(s120)
    chained = chain_pytc([s60, s60])
    ref_cont, ref_summary = chain_reference([s60, s60])
    ref_pytc_like, _ = chain_reference([s60, s60], override_each_segment=True)
    for a, b in zip(chained, ref_pytc_like):
        check_ref_vs_pytc(f"chainA-{model}", a["outputs"], b["outputs"])
    # recommended continuous semantics must equal a single call for constant conditions
    for k in STATE_KEYS + ["sweat_loss_g"]:
        d = abs(single[k] - ref_cont[-1]["outputs"][k]) / max(1.0, abs(single[k]))
        assert d < 1e-9, (model, k, single[k], ref_cont[-1]["outputs"][k])
    exp_tre = single["d_lim_t_re"] if single["d_lim_t_re"] < 120 else None
    exp_loss = single["d_lim_loss_95"] if single["d_lim_loss_95"] < 120 else None
    assert ref_summary["first_minute_t_re_ge_38"] == exp_tre, (ref_summary, single)
    assert ref_summary["first_minute_sweat_loss_ge_dmax95"] == exp_loss, (ref_summary, single)
    CHAINS.append({
        "id": f"CHAIN-A-{model}", "model": model,
        "description": "Constant sun conditions (AD02 inputs): one 120-min call vs two chained 60-min calls",
        "segments_inputs": [{k: s60[k] for k in PYTC_ARGS + ["met_wm2", "p_a_kpa"]}] * 2,
        "single_call_120min": {"inputs": {k: s120[k] for k in PYTC_ARGS + ["met_wm2", "p_a_kpa"]}, "outputs": single},
        "pythermalcomfort_chained": chained,
        "reference_continuous_recommended": ref_cont,
        "reference_continuous_summary": ref_summary,
        "difference_chained_minus_single_final": {k: chained[-1]["outputs"][k] - single[k]
                                                  for k in ("t_re", "t_sk", "t_cr", "sweat_loss_g")},
    })
    # B) work/rest: 60 min work in sun + 15 min rest in shade, twice
    work = seg(model, SUN, 230, 0.6, 60, posture="standing", f_r=fr)
    rest = seg(model, SHADE, 65, 0.6, 15, posture="sitting", f_r=fr)
    segs_b = [work, rest, work, rest]
    chained_b = chain_pytc(segs_b)
    ref_b, ref_b_summary = chain_reference(segs_b)
    ref_b_pytc_like, _ = chain_reference(segs_b, override_each_segment=True)
    for a, b in zip(chained_b, ref_b_pytc_like):
        check_ref_vs_pytc(f"chainB-{model}", a["outputs"], b["outputs"])
    # comparators: continuous work without rest (150 min), and a time-weighted-average single call
    nowork_rest = run_pytc(seg(model, SUN, 230, 0.6, 150, f_r=fr))
    twa_m = (2 * 60 * 230 + 2 * 15 * 65) / 150
    twa_tr = (2 * 60 * 60 + 2 * 15 * 44) / 150
    twa_inp = full_inputs(model, 44.0, twa_tr, 0.5, 20.0, twa_m, 0.6, "standing", duration=150, a_p=0.0, f_r=fr)
    twa = run_pytc(twa_inp)
    CHAINS.append({
        "id": f"CHAIN-B-{model}", "model": model,
        "description": "Work/rest: [60 min work in sun 230 W/m2 standing] + [15 min rest in shade 65 W/m2 sitting], x2",
        "segments_inputs": [{k: s[k] for k in PYTC_ARGS + ["met_wm2", "p_a_kpa"]} for s in segs_b],
        "pythermalcomfort_chained": chained_b,
        "reference_continuous_recommended": ref_b,
        "reference_continuous_summary": ref_b_summary,
        "comparator_continuous_work_150min_no_rest": nowork_rest,
        "comparator_time_weighted_average_single_call": {
            "inputs": {k: twa_inp[k] for k in PYTC_ARGS + ["met_wm2", "p_a_kpa"]}, "outputs": twa,
            "note": "Illustration only: ISO 7933 does not prescribe TWA inputs for PHS."},
    })

# --------------------------------------------------------------------------------------
# 6) Traces
# --------------------------------------------------------------------------------------
def compact_trace(rows):
    return [{k: (v if isinstance(v, int) else float(f"{v:.12g}")) for k, v in r.items()} for r in rows]


TRACES = [
    {"vector_id": "ISO2004-F01", "model": "7933-2004", "engine": "reference (== pythermalcomfort to <1e-9)",
     "note": "values rounded to 12 significant digits; all 480 minutes", "rows": compact_trace(trace_iso)},
    {"vector_id": "AD01", "model": "7933-2023", "engine": "reference (== pythermalcomfort to <1e-9)",
     "note": "values rounded to 12 significant digits; all 480 minutes", "rows": compact_trace(trace_ad)},
]

# --------------------------------------------------------------------------------------
# 7) MRT from a Liljegren 2-inch globe temperature
# --------------------------------------------------------------------------------------
SIGMA_LJ = lj.STEFANB  # 5.6696e-8 (Liljegren)
MRT_EXAMPLES = []
for (ta_c, rh_pct, v2m, solar, fdir, cza) in [
    (44.0, 20.0, 0.5, 950.0, 0.85, 0.95),
    (44.0, 20.0, 1.0, 950.0, 0.85, 0.95),
    (44.0, 20.0, 2.0, 950.0, 0.85, 0.95),
    (40.0, 40.0, 0.5, 700.0, 0.75, 0.70),
    (36.0, 60.0, 1.0, 300.0, 0.30, 0.40),
]:
    ta_k = ta_c + 273.15
    pair = 1005.0
    tg_c = float(lj.solve_globe(np.array(ta_k), np.array(rh_pct / 100), np.array(pair), np.array(v2m),
                                np.array(solar), np.array(fdir), np.array(cza)))
    tg_k = tg_c + 273.15
    # forcing that the Liljegren globe model actually used (its "globe MRT")
    emis = float(lj.emis_atm(np.array(ta_k), np.array(rh_pct / 100)))
    beam = fdir * (1.0 / (2.0 * cza) - 1.0) if fdir > 0 else 0.0
    t_force4 = (0.5 * (emis * ta_k ** 4 + lj.EMIS_SFC * ta_k ** 4)
                + solar / (2.0 * SIGMA_LJ * lj.EMIS_GLOBE) * (1.0 - lj.ALB_GLOBE) * (beam + 1.0 + lj.ALB_SFC))
    mrt_force = t_force4 ** 0.25 - 273.15
    # (a) self-consistent inversion with the Liljegren sphere convection coefficient
    h_lj = float(lj.h_sphere_in_air(np.array(0.5 * (tg_k + ta_k)), np.array(pair), np.array(v2m)))
    mrt_lj = (tg_k ** 4 + h_lj / (SIGMA_LJ * lj.EMIS_GLOBE) * (tg_k - ta_k)) ** 0.25 - 273.15
    # (b) ISO 7726 forced convection with D = 0.0508 m
    mrt_iso_f_2in = tr_from_globe_iso7726_forced(tg_c, ta_c, v2m, d=0.0508, t0=273.15)
    # (c) ISO 7726 max(natural, forced) with D = 0.0508 (pythermalcomfort 'ISO')
    mrt_iso_2in = float(mean_radiant_tmp(tg_c, ta_c, v2m, d=0.0508, emissivity=0.95, standard="ISO"))
    # (d) WRONG diameter: ISO 7726 forced with D = 0.15 m
    mrt_iso_f_150 = tr_from_globe_iso7726_forced(tg_c, ta_c, v2m, d=0.15, t0=273.15)
    # (e) thermofeel.calculate_mrt_from_bgt (assumes D=0.15 m and a 10 m wind it rescales to 1.1 m)
    mrt_tf_misuse = float(thermofeel.calculate_mrt_from_bgt(np.array(ta_k), np.array(tg_k), np.array(v2m))) - 273.15
    # (f) pythermalcomfort 'Mixed Convection' (Teitelbaum et al. 2022) with D = 0.0508
    mrt_mixed = float(mean_radiant_tmp(tg_c, ta_c, v2m, d=0.0508, emissivity=0.95, standard="Mixed Convection"))
    # (g) illustrative HUMAN mean radiant temperature from the same radiation field
    #     (Di Napoli et al. 2020 via thermofeel: shortwave absorptivity 0.7, emissivity 0.97,
    #     projected-area factor of a standing person), using the Liljegren sky/ground terms.
    fdir_h = fdir * solar                      # direct beam on the horizontal [W/m2]
    dsrp = fdir_h / cza                        # direct normal irradiance [W/m2]
    ssr = solar * (1.0 - lj.ALB_SFC)           # net shortwave at the surface [W/m2]
    strd = emis * SIGMA_LJ * ta_k ** 4         # downward longwave [W/m2]
    strr = strd - lj.EMIS_SFC * SIGMA_LJ * ta_k ** 4  # net longwave (surface at air temperature)
    mrt_human = float(thermofeel.calculate_mean_radiant_temperature(
        np.array(solar), np.array(ssr), np.array(dsrp), np.array(strd), np.array(fdir_h), np.array(strr),
        np.array(cza))) - 273.15
    MRT_EXAMPLES.append({
        "inputs": {"ta_c": ta_c, "rh_pct": rh_pct, "wind_2m_ms": v2m, "solar_wm2": solar, "fdir": fdir,
                   "cos_zenith": cza, "pressure_hpa": pair},
        "liljegren_globe_tg_c": tg_c,
        "h_liljegren_sphere_wm2k": h_lj,
        "mrt_c": {
            "globe_forcing_used_by_liljegren_model": mrt_force,
            "a_invert_liljegren_h_D0.0508_recommended": mrt_lj,
            "b_iso7726_forced_D0.0508": mrt_iso_f_2in,
            "c_iso7726_max_natural_forced_D0.0508_pythermalcomfort": mrt_iso_2in,
            "d_iso7726_forced_D0.15_WRONG_for_2in_globe": mrt_iso_f_150,
            "e_thermofeel_calculate_mrt_from_bgt_with_2m_wind_WRONG": mrt_tf_misuse,
            "f_mixed_convection_Teitelbaum2022_D0.0508": mrt_mixed,
            "g_human_mrt_DiNapoli2020_same_radiation_illustrative": mrt_human,
        },
    })

# --------------------------------------------------------------------------------------
# Assemble and write
# --------------------------------------------------------------------------------------
doc = {
    "schema_version": "1.0.0",
    "title": "Zill PHS (ISO 7933) oracle vectors",
    "spec": "docs/research/phs_iso7933.md",
    "generator": "scripts/oracles/phs_oracle.py",
    "environment": {
        "python": platform.python_version(), "numpy": np.__version__,
        "pythermalcomfort": pythermalcomfort.__version__, "thermofeel": getattr(thermofeel, "__version__", "2.3.0"),
        "platform": platform.platform(),
    },
    "units": {
        "tdb": "degC (air temperature)", "tr": "degC (mean radiant temperature)",
        "v": "m/s (air speed at the person; NOT 10 m wind)", "rh": "% (0-100)",
        "p_a_kpa": "kPa (water vapour partial pressure actually used by the model)",
        "met": "met (pythermalcomfort input; 1 met = 58.15 W/m2)", "met_wm2": "W/m2 (metabolic rate per DuBois area)",
        "wme": "met", "wme_wm2": "W/m2", "clo": "clo (static intrinsic clothing insulation; 1 clo = 0.155 m2K/W)",
        "posture": "standing | sitting | crouching", "i_mst": "dimensionless static moisture permeability index",
        "a_p": "fraction of body surface covered by reflective clothing (0 for ordinary clothing)",
        "f_r": "2004: emissivity of reflective clothing; 2023 (pythermalcomfort): reflection coefficient (uses 1-f_r)",
        "drink": "1 = can drink freely, 0 = cannot", "weight": "kg", "height": "m",
        "walk_sp": "m/s (0 => not entered; estimated from met internally)", "theta": "degrees (0 => direction not entered)",
        "acclimatized": "100 = acclimatized, 0 = not", "duration": "min (integer, 1-minute steps)",
        "t_sk/t_cr/t_re/t_cr_eq": "degC initial state", "t_sk_t_cr_wg": "dimensionless initial skin-core weighting",
        "sweat_rate_watt": "W/m2 initial predicted sweat rate (state)",
        "evap_load_wm2_min": "W*min/m2 initial accumulated evaporative load (state)",
        "outputs.t_re/t_sk/t_cr/t_cr_eq": "degC at end of run", "outputs.t_sk_t_cr_wg": "dimensionless at end",
        "outputs.d_lim_t_re": "min from START OF THIS CALL until t_re >= 38 degC (duration if not reached)",
        "outputs.d_lim_loss_50/95": "min from START OF THIS CALL until sweat_loss_g >= D_max (duration if not reached; x0.6 if drink=0)",
        "outputs.sweat_rate_watt": "W/m2 predicted sweat rate at the last minute",
        "outputs.sweat_loss_g": "g cumulative water loss (sweat + respiratory) for the whole body, incl. carried-over load",
        "outputs.evap_load_wm2_min": "W*min/m2 cumulative (carry to next segment)",
    },
    "conventions": {
        "outputs": "unrounded IEEE-754 doubles from pythermalcomfort 4.8.1 (limit_inputs=False, round_output=False)",
        "outputs_rounded_pythermalcomfort": "numpy.around (round-half-even on the binary value), 1 dp (t_sk_t_cr_wg 2 dp). Do NOT test a port against these with Math.round; compare unrounded values.",
        "validity": "ISO 7933 Annex A Table A.1 limits as implemented by pythermalcomfort 4.8.1 (inclusive bounds). If failing is non-empty, pythermalcomfort with limit_inputs=True returns NaN for every output.",
        "variants": "reference-implementation results for alternative, documented choices (not pythermalcomfort).",
        "recommended_tolerances_for_port": {
            "temperatures_degC": 1e-6, "t_sk_t_cr_wg": 1e-8, "sweat_rate_watt": 1e-6, "sweat_loss_g": 1e-4,
            "evap_load_wm2_min": 1e-3, "d_lim_minutes": 0,
            "note": "observed reference-vs-pythermalcomfort max relative diff is recorded in self_checks; D_lim must match exactly unless d_lim_margins shows |margin| < 1e-9"},
    },
    "self_checks": {
        "reference_vs_pythermalcomfort_max_rel_diff": MAX_DIFF["value"],
        "reference_vs_pythermalcomfort_worst_location": MAX_DIFF["where"],
        "iso2004_annex_f_worst_abs_deviation_pythermalcomfort": ISO2004_WORST,
        "iso2004_annex_f_worst_abs_deviation_reference_sp_heat_57.83": ISO2004_WORST_5783,
        "max_iterations_observed": {
            "t_cl": max(v["derived"]["max_iter_t_cl"] for v in VECTORS),
            "t_cr": max(v["derived"]["max_iter_t_cr"] for v in VECTORS),
        },
    },
    "pythermalcomfort_4_8_1_defaults": {
        "7933-2004": {"i_mst": 0.38, "a_p": 0.54, "drink": 1, "weight": 75, "height": 1.8, "walk_sp": 0,
                      "theta": 0, "acclimatized": 100, "duration": 480, "f_r": 0.97, "t_sk": 34.1,
                      "t_cr": 36.8, "t_re": "= t_cr", "t_cr_eq": "= t_cr", "t_sk_t_cr_wg": 0.3,
                      "sweat_rate_watt": 0, "evap_load_wm2_min": 0, "wme": 0, "limit_inputs": True,
                      "round_output": True},
        "7933-2023": {"i_mst": 0.38, "a_p": 0.54, "drink": 1, "weight": 75, "height": 1.8, "walk_sp": 0,
                      "theta": 0, "acclimatized": 100, "duration": 480, "f_r": 0.42, "t_sk": 34.1,
                      "t_cr": 36.8, "t_re": 36.8, "t_cr_eq": 36.8, "t_sk_t_cr_wg": 0.3,
                      "sweat_rate_watt": 0, "evap_load_wm2_min": 0, "wme": 0, "limit_inputs": True,
                      "round_output": True,
                      "WARNING": "a_p=0.54 with f_r=0.42 gives clothing emissivity 0.759 (partly reflective); use a_p=0 for ordinary clothing"},
    },
    "chaining_state_variables": STATE_KEYS,
    "vectors": VECTORS,
    "chains": CHAINS,
    "traces": TRACES,
    "mrt_from_globe": {
        "note": "Liljegren 2-inch (0.0508 m) globe solved with thermofeel.liljegren.solve_globe; MRT recovered by several methods. thermofeel.calculate_mrt_from_bgt assumes a 0.15 m globe and a 10 m wind (rescaled to 1.1 m) and must not be used for a 2-inch globe.",
        "diameter_factor_forced_convection_(0.15/0.0508)^0.4": (0.15 / 0.0508) ** 0.4,
        "examples": MRT_EXAMPLES,
    },
}


def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.floating,)):
        o = float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, float) and not math.isfinite(o):
        return None
    return o


os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    json.dump(_clean(doc), f, indent=1, allow_nan=False)
    f.write("\n")

print(f"wrote {OUT}")
print(f"  vectors: {len(VECTORS)}  chains: {len(CHAINS)}  traces: {len(TRACES)}  mrt examples: {len(MRT_EXAMPLES)}")
print(f"  reference vs pythermalcomfort max rel diff: {MAX_DIFF['value']:.3e} at {MAX_DIFF['where']}")
print(f"  ISO 2004 Annex F worst abs deviation (pythermalcomfort): {ISO2004_WORST}")
print(f"  ISO 2004 Annex F worst abs deviation (reference, sp_heat 57.83): {ISO2004_WORST_5783}")
