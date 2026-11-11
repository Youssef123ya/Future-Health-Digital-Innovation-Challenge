"""
Zill - physiological strain reference implementation (oracle for the TypeScript port).

Implements, with provenance:
  * ECTemp extended Kalman filter, quadratic observation model
      Buller MJ et al. Physiol Meas 2013;34(7):781-798 (PMID 23780514) and the
      author's own JavaScript (usariem.health.mil/assets/js/estimateTcore.js,
      "Matlab Function Appendix" port, retrieved 2026-11-09). Constants copied verbatim.
  * ECTemp sigmoid (generalized-logistic) observation model
      Looney DP et al. J Meas Phys Behav 2018;1(2):79-86 (doi 10.1123/jmpb.2017-0003);
      constants from US 12,426,839 B2 eq. (10); derivative re-derived here and
      checked against the patent's eq. (11) constants (8.1168, -15.2857, 0.07).
  * Physiological Strain Index (Moran, Shitzer, Pandolf. Am J Physiol 1998;275:R129-R134)
    and adaptive PSI (US 11,564,579 B2; Buller et al. Physiol Meas 2023;44:105001-type aPSI).
  * Minute-level signal-quality index (SQI) for wearable HR and the SQI-scaled
    measurement noise of Li, Mark & Clifford (BioMed Eng Online 2009;8:13, eq. 13):
      R = R0 * exp(psi^-2 - 1)
  * Steady-state / inverse-model analysis used in the spec tables.

Run:  python ectemp_reference.py            -> writes ./out/*.json and prints a report
Deps: standard library only (json, math).
"""
from __future__ import annotations

import json
import math
import os
import sys
from dataclasses import dataclass
from typing import Callable, Iterable, List, Optional, Sequence

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # pragma: no cover
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------------------
# 1. ECTemp constants (Buller 2013; official USARIEM JS).  NOTE the JS names
#    the VARIANCES "gamma" and "sigma": gamma = 0.022^2, sigma = 18.88^2.
# ---------------------------------------------------------------------------
A_TRANSITION = 1.0            # a  (CT_t = a*CT_{t-1})
GAMMA_SD = 0.022              # degC per 1-min step (process-noise SD)
GAMMA2 = GAMMA_SD ** 2        # 0.000484 degC^2 per step  (JS variable "gamma")
B0, B1, B2 = -7887.1, 384.4286, -4.5714   # HR = B2*CT^2 + B1*CT + B0
SIGMA_SD = 18.88              # bpm (observation-noise SD)
SIGMA2 = SIGMA_SD ** 2        # 356.4544 bpm^2              (JS variable "sigma")
CT0_DEFAULT = 37.1            # degC, default start value of the official web app
V0_DEFAULT = 0.0              # initial variance used by Buller 2013 / official app

# Sigmoid (generalized logistic, Richards 1959) observation model, US12426839B2 eq.(10)
SIG_A, SIG_K, SIG_Q, SIG_B, SIG_M, SIG_NU = 41.0, 193.0, 0.06, 0.89, 37.84, 0.07


def hr_quadratic(ct: float) -> float:
    return B2 * (ct ** 2) + B1 * ct + B0


def dhr_quadratic(ct: float) -> float:
    return 2 * B2 * ct + B1


def hr_sigmoid(ct: float) -> float:
    e = math.exp(-SIG_B * (ct - SIG_M))
    return SIG_A + (SIG_K - SIG_A) / (1.0 + SIG_Q * e) ** (1.0 / SIG_NU)


def dhr_sigmoid(ct: float) -> float:
    # d/dCT [A + (K-A)(1+Q e^{-B(CT-M)})^{-1/nu}]
    #   = (K-A)*Q*B/nu * e^{-B(CT-M)} * (1+Q e^{-B(CT-M)})^{-(1/nu)-1}
    e = math.exp(-SIG_B * (ct - SIG_M))
    return (SIG_K - SIG_A) * SIG_Q * SIG_B / SIG_NU * e * (1.0 + SIG_Q * e) ** (-(1.0 / SIG_NU) - 1.0)


def ct_from_hr_quadratic(hr: float) -> Optional[float]:
    """Steady-state CT for a constant HR (lower root of the quadratic). None if HR > vertex."""
    disc = B1 ** 2 - 4 * B2 * (B0 - hr)
    if disc < 0:
        return None
    return (-B1 + math.sqrt(disc)) / (2 * B2)  # B2<0 -> this is the physiological (lower) root


def ct_from_hr_sigmoid(hr: float) -> Optional[float]:
    if not (SIG_A < hr < SIG_K):
        return None
    u = ((SIG_K - SIG_A) / (hr - SIG_A)) ** SIG_NU - 1.0
    if u <= 0:
        return None
    return SIG_M - math.log(u / SIG_Q) / SIG_B


# ---------------------------------------------------------------------------
# 2. ECTemp step functions
# ---------------------------------------------------------------------------
def ectemp_step_official(tc_prev: float, v_prev: float, hr: float):
    """Line-by-line transcription of estimateTcore.js (same operation order)."""
    a = 1
    gamma = math.pow(0.022, 2)
    b_0 = -7887.1
    b_1 = 384.4286
    b_2 = -4.5714
    sigma = math.pow(18.88, 2)
    x = tc_prev
    v = v_prev
    x_pred = a * x                                   # eq 3
    v_pred = (math.pow(a, 2)) * v + gamma            # eq 4
    z = hr
    c_vc = 2 * b_2 * x_pred + b_1                    # eq 5
    k = (v_pred * c_vc) / (math.pow(c_vc, 2) * v_pred + sigma)          # eq 6
    x = x_pred + k * (z - (b_2 * math.pow(x_pred, 2) + b_1 * x_pred + b_0))  # eq 7
    v = (1 - k * c_vc) * v_pred                      # eq 8
    return x, v


@dataclass
class ObsModel:
    name: str
    h: Callable[[float], float]
    dh: Callable[[float], float]


QUAD = ObsModel("quadratic_buller2013", hr_quadratic, dhr_quadratic)
SIGM = ObsModel("sigmoid_looney2018_US12426839B2", hr_sigmoid, dhr_sigmoid)


def ectemp_step(ct_prev: float, v_prev: float, hr: Optional[float], model: ObsModel = QUAD,
                gamma2: float = GAMMA2, sigma2: float = SIGMA2, r_scale: float = 1.0):
    """Generic EKF step. hr=None -> time update only (missing/invalid minute).
    r_scale multiplies sigma2 (SQI-scaled noise, Li 2009); r_scale=inf -> no update."""
    ct_pred = A_TRANSITION * ct_prev
    v_pred = (A_TRANSITION ** 2) * v_prev + gamma2
    if hr is None or not math.isfinite(r_scale):
        return ct_pred, v_pred, None
    c = model.dh(ct_pred)
    if c <= 0.0:   # guard: beyond the quadratic vertex (CT >= 42.047 degC) the model is non-invertible
        return ct_pred, v_pred, None
    r = sigma2 * r_scale
    k = v_pred * c / (c * c * v_pred + r)
    innov = hr - model.h(ct_pred)
    ct = ct_pred + k * innov
    v = (1.0 - k * c) * v_pred
    return ct, v, {"c": c, "k": k, "innovation": innov}


def run_series(hrs: Sequence[Optional[float]], ct0=CT0_DEFAULT, v0=V0_DEFAULT, model=QUAD,
               gamma2=GAMMA2, sigma2=SIGMA2, r_scales: Optional[Sequence[float]] = None):
    ct, v = ct0, v0
    cts, vs = [], []
    for i, hr in enumerate(hrs):
        rs = 1.0 if r_scales is None else r_scales[i]
        ct, v, _ = ectemp_step(ct, v, hr, model, gamma2, sigma2, rs)
        cts.append(ct)
        vs.append(v)
    return cts, vs


# ---------------------------------------------------------------------------
# 3. Steady-state Kalman analysis (scalar Riccati) at a given operating CT
# ---------------------------------------------------------------------------
def steady_state(c: float, q: float = GAMMA2, r: float = SIGMA2):
    # predicted variance P satisfies c^2 P^2 - q c^2 P - q r = 0
    P = (q * c * c + math.sqrt((q * c * c) ** 2 + 4 * c * c * q * r)) / (2 * c * c)
    k = P * c / (c * c * P + r)
    alpha = k * c                     # fraction of the (CT-equivalent) error removed per minute
    tau = -1.0 / math.log(1.0 - alpha)  # minutes (first-order equivalent time constant)
    return {"P_pred": P, "gain_degC_per_bpm": k, "alpha_per_min": alpha, "tau_min": tau}


# ---------------------------------------------------------------------------
# 4. PSI / aPSI
# ---------------------------------------------------------------------------
def psi_moran(ct: float, hr: float, ct0: float, hr0: float, ct_max: float = 39.5, hr_max: float = 180.0):
    if ct0 >= ct_max or hr0 >= hr_max:
        return None
    return 5.0 * (ct - ct0) / (ct_max - ct0) + 5.0 * (hr - hr0) / (hr_max - hr0)


def psi_category(psi: Optional[float]) -> Optional[str]:
    """Moran 1998 Table 1 bands (0-2 no/little, 3-4 low, 5-6 moderate, 7-8 high, 9-10 very high).
    Continuous values are mapped CONSERVATIVELY via ceil() (engineering choice)."""
    if psi is None:
        return None
    p = max(0.0, psi)
    n = math.ceil(round(p, 9))
    if n <= 2:
        return "no_little"
    if n <= 4:
        return "low"
    if n <= 6:
        return "moderate"
    if n <= 8:
        return "high"
    return "very_high"


def apsi(ct: float, hr: float, ct_rest: float, hr_rest: float, age: float, tsk: Optional[float] = None):
    """US 11,564,579 B2: aPSI = 5(CT-CTrest)/(CTcrit-CTrest) + 5(HR-HRrest)/(HRcrit-HRrest);
    HRcrit = 0.90*(220-age); CTcrit = 39.5 + ((CT - Tsk) - 4)/4; Tsk missing -> CTcrit = 39.5."""
    hr_crit = 0.90 * (220.0 - age)
    ct_crit = 39.5 if tsk is None else 39.5 + ((ct - tsk) - 4.0) / 4.0
    if ct_crit <= ct_rest or hr_crit <= hr_rest:
        return None
    return 5.0 * (ct - ct_rest) / (ct_crit - ct_rest) + 5.0 * (hr - hr_rest) / (hr_crit - hr_rest)


# ---------------------------------------------------------------------------
# 5. Minute-level SQI for a wearable HR stream (spec section 3)
# ---------------------------------------------------------------------------
HR_MIN_PLAUSIBLE = 40.0          # bpm (Egbert 2022 worker-study exclusion rule: <40 bpm)
HR_MAX_PLAUSIBLE = 200.0         # bpm (Egbert 2022 worker-study exclusion rule: >200 bpm)
RATIO_WINDOW_S = 10.0            # Orphanidou-type window (s)
RATIO_LIMIT = 2.2                # max/min within window (Orphanidou 2015, via secondary source)
FLATLINE_MIN_SAMPLES = 10        # identical values over >= 10 samples spanning the minute
COVERAGE_MIN = 0.80              # >= 80 % valid samples (Peltola 2012 analogue)
PSI_T = COVERAGE_MIN             # gate: psi below this -> no measurement update


def hrmax_tanaka(age: float) -> float:
    return 208.0 - 0.7 * age


def minute_sqi(samples: Sequence[tuple], expected_interval_s: float, age: float):
    """samples: [(t_seconds_within_minute, hr_bpm or None, contact_ok: bool)], 0 <= t < 60.
    Returns dict(psi, valid, hr_mean, flags)."""
    expected = max(1, int(round(60.0 / expected_interval_s)))
    upper = HR_MAX_PLAUSIBLE  # age kept in the signature for an optional Tanaka-based check
    flags = []
    pts = [(t, h, ok) for (t, h, ok) in samples if h is not None]
    valid = [ok and (HR_MIN_PLAUSIBLE <= h <= upper) for (t, h, ok) in pts]
    if any((not (HR_MIN_PLAUSIBLE <= h <= upper)) for (_, h, _) in pts):
        flags.append("out_of_range")
    if any(not ok for (_, _, ok) in pts):
        flags.append("contact_lost")
    # ratio rule inside fixed, non-overlapping 10-s segments [0,10),[10,20),...,[50,60)
    n_seg = int(math.ceil(60.0 / RATIO_WINDOW_S))
    for s in range(n_seg):
        lo, hi_ = s * RATIO_WINDOW_S, (s + 1) * RATIO_WINDOW_S
        idx = [j for j, (t, h, _) in enumerate(pts) if lo <= t < hi_ and h > 0]
        seg = [pts[j][1] for j in idx]
        if len(seg) >= 2 and max(seg) / min(seg) >= RATIO_LIMIT:
            for j in idx:
                valid[j] = False
            if "ratio_jump" not in flags:
                flags.append("ratio_jump")
    # flatline: all values identical across >= FLATLINE_MIN_SAMPLES samples
    hs = [h for (_, h, _) in pts]
    if len(hs) >= FLATLINE_MIN_SAMPLES and max(hs) == min(hs):
        valid = [False] * len(valid)
        flags.append("flatline")
    n_valid = sum(1 for v in valid if v)
    psi = min(1.0, n_valid / expected)
    vals = [h for (v, (_, h, _)) in zip(valid, pts) if v]
    hr_mean = (sum(vals) / len(vals)) if vals else None
    ok = psi >= PSI_T and hr_mean is not None
    if psi < PSI_T:
        flags.append("low_coverage")
    return {"psi": psi, "valid": ok, "hr_mean": hr_mean, "flags": flags,
            "r_scale": (math.exp(psi ** -2 - 1.0) if ok else float("inf"))}


# ---------------------------------------------------------------------------
# 6. Build scenarios & fixtures
# ---------------------------------------------------------------------------
def scenario_profiles():
    sc = {}
    sc["constant_hr_80_60min"] = [80.0] * 60
    sc["constant_hr_120_120min"] = [120.0] * 120
    sc["constant_hr_150_120min"] = [150.0] * 120
    # work-rest shift fragment: 10 rest, 45 work, 15 rest, 30 heavy, 20 recovery
    prof = [75.0] * 10 + [135.0 + 10.0 * math.sin(i / 7.0) for i in range(45)] + [95.0] * 15 \
        + [160.0] * 30 + [100.0 - 0.5 * i for i in range(20)]
    sc["work_rest_mixed_120min"] = [round(h, 3) for h in prof]
    sc["ramp_70_to_170_100min"] = [70.0 + i for i in range(101)]
    sc["extreme_hr_200_30min"] = [200.0] * 30   # above quadratic vertex (~195 bpm)
    sc["low_hr_45_30min"] = [45.0] * 30
    return sc


def finite_diff_check():
    worst = 0.0
    for i in range(0, 61):
        ct = 35.5 + 0.1 * i
        h = 1e-6
        fd = (hr_sigmoid(ct + h) - hr_sigmoid(ct - h)) / (2 * h)
        worst = max(worst, abs(fd - dhr_sigmoid(ct)))
    return worst


def main():
    report = {}
    # (a) constants
    report["constants"] = {
        "a": A_TRANSITION, "gamma_sd": GAMMA_SD, "gamma2": GAMMA2, "b0": B0, "b1": B1, "b2": B2,
        "sigma_sd": SIGMA_SD, "sigma2": SIGMA2, "ct0_default": CT0_DEFAULT, "v0_default": V0_DEFAULT,
        "quadratic_vertex_ct": -B1 / (2 * B2), "quadratic_vertex_hr": hr_quadratic(-B1 / (2 * B2)),
        "sigmoid": {"A": SIG_A, "K": SIG_K, "Q": SIG_Q, "B": SIG_B, "M": SIG_M, "nu": SIG_NU},
        "sigmoid_derivative_patent_constants": {
            "(K-A)*Q*B": (SIG_K - SIG_A) * SIG_Q * SIG_B, "-(1/nu)-1": -(1 / SIG_NU) - 1, "nu": SIG_NU},
        "sigmoid_derivative_max_abs_err_vs_finite_diff": finite_diff_check(),
    }
    # (b) observation model table and inverse
    table = []
    for ct10 in range(355, 412, 5):
        ct = ct10 / 10.0
        table.append({"ct": ct, "hr_quadratic": round(hr_quadratic(ct), 3), "hr_sigmoid": round(hr_sigmoid(ct), 3),
                      "dhr_quadratic": round(dhr_quadratic(ct), 4), "dhr_sigmoid": round(dhr_sigmoid(ct), 4)})
    report["observation_model_table"] = table
    inv = []
    for hr in [45, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 195, 200]:
        q = ct_from_hr_quadratic(hr)
        s = ct_from_hr_sigmoid(hr)
        inv.append({"hr": hr, "ct_ss_quadratic": None if q is None else round(q, 4),
                    "ct_ss_sigmoid": None if s is None else round(s, 4)})
    report["steady_state_ct_for_constant_hr"] = inv
    # (c) steady-state filter dynamics
    ssd = []
    for ct in [37.0, 37.5, 38.0, 38.5, 39.0, 39.5, 40.0]:
        d = steady_state(dhr_quadratic(ct))
        d2 = steady_state(dhr_sigmoid(ct))
        ssd.append({"ct": ct, "quadratic": {k: round(v, 6) for k, v in d.items()},
                    "sigmoid": {k: round(v, 6) for k, v in d2.items()}})
    report["steady_state_dynamics"] = ssd
    # (d) beta-blocker style HR offset illustration (steady state)
    bb = []
    for hr in [120, 140, 160]:
        for off in [15, 20, 27]:
            a_ = ct_from_hr_quadratic(hr)
            b_ = ct_from_hr_quadratic(hr - off)
            bb.append({"true_hr": hr, "hr_reduction_bpm": off, "ct_ss_true": round(a_, 3),
                       "ct_ss_blunted": round(b_, 3), "underestimate_degC": round(a_ - b_, 3)})
    report["hr_blunting_effect_quadratic"] = bb

    # (e) scenario vectors (quadratic + sigmoid), with missing data variants
    scen = scenario_profiles()
    vectors = []
    for name, hrs in scen.items():
        cts, vs = run_series(hrs)
        cts_o, vs_o = [], []
        ct, v = CT0_DEFAULT, V0_DEFAULT
        for hr in hrs:
            ct, v = ectemp_step_official(ct, v, hr)
            cts_o.append(ct)
            vs_o.append(v)
        max_diff = max(abs(a - b) for a, b in zip(cts, cts_o))
        s_cts, s_vs = run_series(hrs, model=SIGM)
        vectors.append({"name": name, "ct0": CT0_DEFAULT, "v0": V0_DEFAULT, "hr": hrs,
                        "ct_quadratic": cts, "v_quadratic": vs,
                        "ct_sigmoid": s_cts, "v_sigmoid": s_vs,
                        "generic_vs_transcribed_js_max_abs_diff": max_diff})
    # missing-data variant: minutes 20-34 missing in the mixed profile
    hrs = list(scen["work_rest_mixed_120min"])
    hrs_m = [None if 20 <= i < 35 else h for i, h in enumerate(hrs)]
    cts, vs = run_series(hrs_m)
    vectors.append({"name": "work_rest_mixed_120min_missing_20_34", "ct0": CT0_DEFAULT, "v0": V0_DEFAULT,
                    "hr": hrs_m, "ct_quadratic": cts, "v_quadratic": vs,
                    "note": "null HR => time update only (ct unchanged, v += gamma2)"})
    # SQI-scaled R variant: psi = 0.85 for all minutes
    psi = 0.85
    rs = [math.exp(psi ** -2 - 1.0)] * len(hrs)
    cts, vs = run_series(hrs, r_scales=rs)
    vectors.append({"name": "work_rest_mixed_120min_psi_0.85", "ct0": CT0_DEFAULT, "v0": V0_DEFAULT,
                    "hr": hrs, "psi": psi, "r_scale": rs[0], "ct_quadratic": cts, "v_quadratic": vs})
    # alternative initialisations used in the literature
    for ct0, v0, model, tag in [(37.0, 0.02, SIGM, "deKorte2022_sigmoid_ct0_37.0_v0_0.02"),
                                (37.1, 0.01, SIGM, "Lignier2026_sigmoid_ct0_37.1_v0_0.01")]:
        cts, vs = run_series(hrs, ct0=ct0, v0=v0, model=model)
        vectors.append({"name": "work_rest_mixed_120min_" + tag, "ct0": ct0, "v0": v0, "hr": hrs,
                        "ct_" + ("sigmoid" if model is SIGM else "quadratic"): cts,
                        "v_" + ("sigmoid" if model is SIGM else "quadratic"): vs})
    report["max_abs_diff_generic_vs_js_transcription"] = max(
        v.get("generic_vs_transcribed_js_max_abs_diff", 0.0) for v in vectors)

    # (f) PSI vectors
    psi_cases = []
    for (ct, hr, ct0, hr0) in [(37.1, 75, 37.1, 75), (37.8, 120, 37.1, 75), (38.4, 150, 37.1, 70),
                               (39.0, 165, 37.0, 70), (39.5, 180, 37.0, 60), (38.0, 140, 36.9, 80),
                               (37.6, 110, 37.1, 85)]:
        p = psi_moran(ct, hr, ct0, hr0)
        psi_cases.append({"ct": ct, "hr": hr, "ct0": ct0, "hr0": hr0, "psi": round(p, 6),
                          "category": psi_category(p)})
    apsi_cases = []
    for (ct, hr, ctr, hrr, age, tsk) in [(38.4, 150, 37.1, 70, 30, None), (38.4, 150, 37.1, 70, 30, 37.4),
                                         (38.4, 150, 37.1, 70, 30, 34.4), (39.0, 160, 37.0, 70, 45, 36.0)]:
        apsi_cases.append({"ct": ct, "hr": hr, "ct_rest": ctr, "hr_rest": hrr, "age": age, "tsk": tsk,
                           "hr_crit": 0.9 * (220 - age),
                           "ct_crit": 39.5 if tsk is None else 39.5 + ((ct - tsk) - 4) / 4,
                           "apsi": round(apsi(ct, hr, ctr, hrr, age, tsk), 6)})
    # (g) SQI vectors
    sqi_cases = []

    def mk(vals, interval=1.0, contact=None):
        out = []
        for i, h in enumerate(vals):
            ok = True if contact is None else contact[i]
            out.append((i * interval, h, ok))
        return out
    clean = [100 + (i % 5) for i in range(60)]
    sqi_cases.append(("clean_1hz", mk(clean), 1.0, 40))
    gappy = [h if (i % 4) else None for i, h in enumerate(clean)]  # 25 % missing
    sqi_cases.append(("25pct_missing_1hz", mk(gappy), 1.0, 40))
    doubled = list(clean)
    for i in range(20, 26):
        doubled[i] = 2.2 * clean[i]   # harmonic lock at 2.2x
    sqi_cases.append(("harmonic_jump_6s", mk(doubled), 1.0, 40))
    halved = list(clean)
    for i in range(41, 46):
        halved[i] = 0.45 * clean[i]   # half-rate lock, still inside the plausible range
    sqi_cases.append(("harmonic_halving_5s", mk(halved), 1.0, 40))
    flat = [88.0] * 60
    sqi_cases.append(("flatline_60s", mk(flat), 1.0, 40))
    contact = [False if 10 <= i < 30 else True for i in range(60)]
    sqi_cases.append(("contact_lost_20s", mk(clean, contact=contact), 1.0, 40))
    high = [215.0] * 12
    sqi_cases.append(("implausible_high_5s_interval", mk(high, interval=5.0), 5.0, 40))
    sqi_out = []
    for name, samples, interval, age in sqi_cases:
        r = minute_sqi(samples, interval, age)
        sqi_out.append({"name": name, "expected_interval_s": interval, "age": age,
                        "samples": [[t, h, ok] for (t, h, ok) in samples],
                        "psi": round(r["psi"], 6), "valid": r["valid"],
                        "hr_mean": None if r["hr_mean"] is None else round(r["hr_mean"], 6),
                        "flags": r["flags"],
                        "r_scale": None if not math.isfinite(r["r_scale"]) else round(r["r_scale"], 6)})

    fixtures = {
        "_meta": {
            "generated_by": "ectemp_reference.py",
            "units": {"ct": "degC", "hr": "beats/min", "v": "degC^2", "time_step": "1 minute"},
            "sources": {
                "ectemp_quadratic": "Buller 2013 Physiol Meas 34:781 + USARIEM estimateTcore.js",
                "ectemp_sigmoid": "Looney 2018 JMPB 1:79; US12426839B2 eq.10/11",
                "psi": "Moran 1998 Am J Physiol 275:R129; bands per Moran Table 1 as reproduced in US11564579B2",
                "apsi": "US11564579B2",
                "sqi_noise_scaling": "Li, Mark, Clifford 2009 BioMed Eng Online 8:13 eq.13"},
            "tolerance_recommendation": {"ct_abs": 1e-9, "v_abs": 1e-12, "psi_abs": 1e-6}},
        "constants": report["constants"],
        "ectemp_vectors": vectors,
        "psi_vectors": psi_cases,
        "apsi_vectors": apsi_cases,
        "sqi_vectors": sqi_out,
        "observation_model_table": report["observation_model_table"],
        "steady_state_ct_for_constant_hr": report["steady_state_ct_for_constant_hr"],
        "steady_state_dynamics": report["steady_state_dynamics"],
        "hr_blunting_effect_quadratic": report["hr_blunting_effect_quadratic"],
    }
    with open(os.path.join(OUT, "physio_fixtures.json"), "w", encoding="utf-8") as f:
        json.dump(fixtures, f, indent=1)
    # JS cross-check input
    with open(os.path.join(OUT, "js_crosscheck_input.json"), "w", encoding="utf-8") as f:
        json.dump({k: v for k, v in scen.items()}, f)

    # ---------------- printed report ----------------
    c = report["constants"]
    print("== ECTemp constants ==")
    print(f"gamma2={c['gamma2']:.6f} sigma2={c['sigma2']:.4f} vertex CT={c['quadratic_vertex_ct']:.4f} "
          f"vertex HR={c['quadratic_vertex_hr']:.3f}")
    print("sigmoid derivative constants:", c["sigmoid_derivative_patent_constants"],
          "max |analytic-FD| =", f"{c['sigmoid_derivative_max_abs_err_vs_finite_diff']:.2e}")
    print("max |generic EKF - transcribed JS| over scenarios =", report["max_abs_diff_generic_vs_js_transcription"])
    print("\n== HR(CT) table ==")
    for r in table:
        print(f"CT {r['ct']:.1f}: HRquad {r['hr_quadratic']:8.3f}  HRsig {r['hr_sigmoid']:8.3f}  "
              f"dHRquad {r['dhr_quadratic']:8.3f}  dHRsig {r['dhr_sigmoid']:8.3f}")
    print("\n== Steady-state CT for constant HR ==")
    for r in inv:
        print(r)
    print("\n== Steady-state filter dynamics (tau = equivalent first-order time constant, min) ==")
    for r in ssd:
        q, s = r["quadratic"], r["sigmoid"]
        print(f"CT {r['ct']}: quad k={q['gain_degC_per_bpm']:.6f} tau={q['tau_min']:.1f} | "
              f"sig k={s['gain_degC_per_bpm']:.6f} tau={s['tau_min']:.1f}")
    print("\n== HR blunting (e.g. beta-blockade) steady-state underestimate ==")
    for r in bb:
        print(r)
    print("\n== Scenario end values ==")
    for v in vectors:
        key = "ct_quadratic" if "ct_quadratic" in v else "ct_sigmoid"
        arr = v[key]
        mx = max(arr)
        print(f"{v['name']:<60s} {key}: end={arr[-1]:.4f} max={mx:.4f} (t_max={arr.index(mx)+1} min)"
              + (f" | sigmoid end={v['ct_sigmoid'][-1]:.4f} max={max(v['ct_sigmoid']):.4f}"
                 if key == "ct_quadratic" and "ct_sigmoid" in v else ""))
    print("\n== PSI ==")
    for p in psi_cases:
        print(p)
    print("\n== aPSI ==")
    for p in apsi_cases:
        print(p)
    print("\n== SQI ==")
    for s in sqi_out:
        print({k: s[k] for k in ("name", "psi", "valid", "hr_mean", "flags", "r_scale")})
    # time-to-threshold for constant HR scenarios (quadratic)
    print("\n== Minutes to reach thresholds from CT0=37.1, v0=0 (quadratic) ==")
    for hr in [120, 140, 150, 160, 170]:
        cts, _ = run_series([float(hr)] * 360)
        res = {}
        for thr in (38.0, 38.4, 38.5, 39.0):
            res[thr] = next((i + 1 for i, x in enumerate(cts) if x >= thr), None)
        print(f"HR {hr}: ct_ss={ct_from_hr_quadratic(hr):.3f}  minutes to 38.0/38.4/38.5/39.0 = {res}")


if __name__ == "__main__":
    main()
