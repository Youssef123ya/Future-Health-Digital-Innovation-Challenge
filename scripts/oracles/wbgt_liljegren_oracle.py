#!/usr/bin/env python3
"""
Zill -- oracle test vectors for the Liljegren et al. (2008) outdoor WBGT model.

Runs thermofeel 2.3.0's Liljegren implementation (the oracle) on Abu-Dhabi-relevant
cases and writes fixtures/wbgt_liljegren.json for the TypeScript engine's tests.
Every thermofeel result is cross-checked against an INDEPENDENT scalar
transliteration of Liljegren's original C code (wbgt.c v1.1, Argonne 2008, as
mirrored in github.com/mdljts/wbgt/src/wbgt.c.original) embedded below, and the
NOAA solar-position algorithm embedded below is checked against pvlib's NREL SPA.

Spec: docs/research/wbgt_liljegren.md (schema, units, tolerances, rationale).

Usage (from anywhere):
    python scripts/oracles/wbgt_liljegren_oracle.py            # writes the fixture
    python scripts/oracles/wbgt_liljegren_oracle.py --out X.json
Exit code 0 only if every pre-registered acceptance check passes.

Requires: numpy, thermofeel==2.3.0, pvlib (for the solar check). No network.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import platform
import sys
from pathlib import Path

import numpy as np
import thermofeel as tf
from thermofeel import liljegren as TL

THERMOFEEL_EXPECTED = "2.3.0"
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "fixtures" / "wbgt_liljegren.json"

# ----------------------------------------------------------------------------
# Pre-registered acceptance criteria (fixed before running; see the md, section 15)
# ----------------------------------------------------------------------------
ACCEPT = {
    "thermofeel_vs_c_transliteration_degC": 1e-9,     # float64, identical algorithm
    "api_vs_components_degC": 1e-9,                   # public API == 0.1Ta+0.2Tg+0.7Tnwb
    "wind_tf_vs_c_ms": 1e-12,
    "noaa_vs_spa_zenith_deg": 0.03,                   # sun above horizon
    "noaa_vs_spa_cos_zenith": 5e-4,
    "lemke_S0_point_degC": 0.10,                      # geometry-free published point
    "lemke_rms_degC": 0.15,                           # all points with u2 >= 0.13 m/s
    "lemke_max_degC": 0.25,
    "bom_brisbane_degC": 0.5,                         # BoM: "a WBGT of about 30 degC"
}

# ============================================================================
# 1. Independent reference: transliteration of Liljegren's wbgt.c (scalar)
#    `rnd` emulates C `float` storage (f32) or not (f64). Written from the C
#    source, not from thermofeel.
# ============================================================================
def f64(x):
    return float(x)


def f32(x):
    return float(np.float32(x))


C = dict(
    PI=3.1415926535897932, DEG_RAD=0.017453292519943295, SOLAR_CONST=1367.0,
    STEFANB=5.6696e-8, Cp=1003.5, M_AIR=28.97, M_H2O=18.015, R_GAS=8314.34,
    EMIS_WICK=0.95, ALB_WICK=0.4, D_WICK=0.007, L_WICK=0.0254,
    EMIS_GLOBE=0.95, ALB_GLOBE=0.05, D_GLOBE=0.0508, EMIS_SFC=0.999, ALB_SFC=0.45,
    CZA_MIN=0.00873, NORMSOLAR_MAX=0.85, REF_HEIGHT=2.0, MIN_SPEED=0.13, CONVERGENCE=0.02,
)
C["R_AIR"] = C["R_GAS"] / C["M_AIR"]
C["RATIO"] = C["Cp"] * C["M_AIR"] / C["M_H2O"]
C["Pr"] = C["Cp"] / (C["Cp"] + 1.25 * C["R_AIR"])
URBAN_EXP = [0.15, 0.15, 0.20, 0.25, 0.30, 0.30]
RURAL_EXP = [0.07, 0.07, 0.10, 0.15, 0.35, 0.55]
LSRDT = [[1, 1, 2, 4, 0, 5, 6, 0], [1, 2, 3, 4, 0, 5, 6, 0], [2, 2, 3, 4, 0, 4, 4, 0],
         [3, 3, 4, 4, 0, 0, 0, 0], [3, 4, 4, 4, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]]


class CRef:
    """Liljegren wbgt.c transliteration. Temperatures in K inside, as in C."""

    def __init__(self, rnd=f64, max_iter=500):
        self.r, self.max_iter = rnd, max_iter
        r = rnd
        self.sigma, self.epsk = r(3.617), r(97.0)              # static float in C
        self.a, self.b, self.c = r(0.56), r(0.281), r(0.4)
        self.pca, self.pcw, self.tca, self.tcw = r(36.4), r(218.0), r(132.0), r(647.3)
        self.da, self.db = r(3.640e-4), r(2.334)
        self.iters = {}

    def esat(self, tk):                       # hPa, over liquid water (phase 0)
        r = self.r; tk = r(tk)
        y = r((tk - 273.15) / (tk - 32.18))
        return r(1.004 * r(6.1121 * math.exp(17.502 * y)))

    def dew_point(self, e):                   # K
        r = self.r; z = r(math.log(r(e) / (6.1121 * 1.004)))
        return r(273.15 + 240.97 * z / (17.502 - z))

    def viscosity(self, T):                   # kg m-1 s-1
        r = self.r; T = r(T); Tr = r(T / self.epsk)
        omega = r((Tr - 2.9) / 0.4 * (-0.034) + 1.048)
        return r(2.6693e-6 * math.sqrt(C["M_AIR"] * T) / (self.sigma * self.sigma * omega))

    def thermal_cond(self, T):                # W m-1 K-1
        return self.r((C["Cp"] + 1.25 * C["R_AIR"]) * self.viscosity(T))

    def diffusivity(self, T, P):              # m2 s-1 ; P in hPa
        r = self.r; T, P = r(T), r(P)
        pc13 = r((self.pca * self.pcw) ** (1.0 / 3.0)); tc512 = r((self.tca * self.tcw) ** (5.0 / 12.0))
        tc12 = r(math.sqrt(self.tca * self.tcw)); mmix = r(math.sqrt(1.0 / C["M_AIR"] + 1.0 / C["M_H2O"]))
        patm = r(P / 1013.25)
        return r(self.da * (T / tc12) ** self.db * pc13 * tc512 * mmix / patm * 1e-4)

    def evap(self, T):                        # J kg-1
        return self.r((313.15 - self.r(T)) / 30.0 * (-71100.0) + 2.4073e6)

    def emis_atm(self, T, rh):
        r = self.r; e = r(r(rh) * self.esat(T))
        return r(0.575 * e ** 0.143)

    def h_sphere(self, T, P, u):
        r = self.r; T, P, u = r(T), r(P), r(u)
        rho = r(P * 100.0 / (C["R_AIR"] * T))
        Re = r(max(u, C["MIN_SPEED"]) * rho * C["D_GLOBE"] / self.viscosity(T))
        Nu = r(2.0 + 0.6 * math.sqrt(Re) * C["Pr"] ** 0.3333)
        return r(Nu * self.thermal_cond(T) / C["D_GLOBE"])

    def h_cylinder(self, T, P, u):
        r = self.r; T, P, u = r(T), r(P), r(u)
        rho = r(P * 100.0 / (C["R_AIR"] * T))
        Re = r(max(u, C["MIN_SPEED"]) * rho * C["D_WICK"] / self.viscosity(T))
        Nu = r(self.b * Re ** (1.0 - self.c) * C["Pr"] ** (1.0 - self.a))
        return r(Nu * self.thermal_cond(T) / C["D_WICK"])

    def tglobe(self, tk, rh, P, u, S, fdir, cza, trace=None):
        """Returns degC, or None if not converged within max_iter (C returns -9999)."""
        r = self.r
        tk, rh, P, u, S, fdir, cza = map(r, (tk, rh, P, u, S, fdir, cza))
        prev, it, new = tk, 0, float("nan")
        beam = fdir * (1.0 / (2.0 * cza) - 1.0) if fdir > 0.0 else 0.0   # fdir=0 guard (avoids 0*inf)
        while True:
            it += 1
            tref = r(0.5 * (prev + tk))
            h = self.h_sphere(tref, P, u)
            arg = (0.5 * (self.emis_atm(tk, rh) * tk ** 4 + C["EMIS_SFC"] * tk ** 4)
                   - h / (C["STEFANB"] * C["EMIS_GLOBE"]) * (prev - tk)
                   + S / (2.0 * C["STEFANB"] * C["EMIS_GLOBE"]) * (1.0 - C["ALB_GLOBE"]) * (beam + 1.0 + C["ALB_SFC"]))
            new = r(arg ** 0.25) if arg >= 0 else float("nan")
            conv = abs(new - prev) < C["CONVERGENCE"]
            if trace is not None:
                trace.append(dict(iter=it, prev_K=prev, tref_K=tref, h_W_m2K=h, new_K=new))
            prev = r(0.9 * prev + 0.1 * new)
            if conv or it >= self.max_iter:
                break
        self.iters["tg"] = it
        return r(new - 273.15) if conv else None

    def twb(self, tk, rh, P, u, S, fdir, cza, rad, trace=None):
        """Natural (rad=1) or psychrometric (rad=0) wet bulb, degC or None."""
        r = self.r
        tk, rh, P, u, S, fdir, cza = map(r, (tk, rh, P, u, S, fdir, cza))
        sza = r(math.acos(max(-1.0, min(1.0, cza))))
        eair = r(rh * self.esat(tk))
        prev, it, new = self.dew_point(eair), 0, float("nan")
        dwl = 0.25 * C["D_WICK"] / C["L_WICK"]
        while True:
            it += 1
            tref = r(0.5 * (prev + tk))
            h = self.h_cylinder(tref, P, u)
            beam = fdir * (math.tan(sza) / C["PI"] + dwl) if fdir > 0.0 else 0.0
            fatm = r(C["STEFANB"] * C["EMIS_WICK"] * (0.5 * (self.emis_atm(tk, rh) * tk ** 4 + C["EMIS_SFC"] * tk ** 4) - prev ** 4)
                     + (1.0 - C["ALB_WICK"]) * S * ((1.0 - fdir) * (1.0 + dwl) + beam + C["ALB_SFC"]))
            ewick = self.esat(prev)
            rho = r(P * 100.0 / (C["R_AIR"] * tref))
            sc = r(self.viscosity(tref) / (rho * self.diffusivity(tref, P)))
            new = r(tk - self.evap(tref) / C["RATIO"] * (ewick - eair) / (P - ewick) * (C["Pr"] / sc) ** self.a
                    + fatm / h * rad)
            conv = abs(new - prev) < C["CONVERGENCE"]
            if trace is not None:
                trace.append(dict(iter=it, prev_K=prev, tref_K=tref, h_W_m2K=h, fatm_W_m2=fatm,
                                  ewick_hPa=ewick, schmidt=sc, new_K=new))
            prev = r(0.9 * prev + 0.1 * new)
            if conv or it >= self.max_iter:
                break
        self.iters["tnwb" if rad else "tpsy"] = it
        return r(new - 273.15) if conv else None

    @staticmethod
    def stability_class(daytime, u10, S, dT=-1.0):
        if daytime:
            j = 0 if S >= 925.0 else 1 if S >= 675.0 else 2 if S >= 175.0 else 3
            i = 4 if u10 >= 6.0 else 3 if u10 >= 5.0 else 2 if u10 >= 3.0 else 1 if u10 >= 2.0 else 0
        else:
            j = 6 if dT >= 0.0 else 5
            i = 2 if u10 >= 2.5 else 1 if u10 >= 2.0 else 0
        return LSRDT[i][j]

    def est_wind(self, u, z, cls, urban=True):
        r = self.r
        p = r(URBAN_EXP[cls - 1] if urban else RURAL_EXP[cls - 1])
        return r(max(r(r(u) * (C["REF_HEIGHT"] / r(z)) ** p), C["MIN_SPEED"]))


# ---- Larson (PNNL 1992) solar position, as embedded in wbgt.c ---------------
def _daynum(year, month, day):
    beg = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
    leap = (year % 4 == 0 and year % 100 != 0) or year % 400 == 0
    return beg[month] + day + (1 if leap and month > 2 else 0)


def larson_solarposition(year, month, day, lat, lon):
    """day = day.fraction of month (month 1-12) or of year (month 0), UT.
    Returns (refracted altitude deg, refraction deg, distance AU)."""
    TW, D2R, R2D = 6.2831853071795864, 0.017453292519943295, 57.295779513082323
    dn = _daynum(year, month, int(day)) if month != 0 else int(day)
    dy = year - 2000
    dd = dy * 365 + int(dy / 4) + dn + (1 if year > 2000 else 0)          # C integer division truncates
    dj = dd - 1.5
    cent = dj / 36525.0
    ut = math.modf(day)[0]
    dj += ut
    ut *= 24.0
    ma = math.modf((357.528 + 0.9856003 * dj) / 360.0)[0] * TW
    ml = math.modf((280.460 + 0.9856474 * dj) / 360.0)[0] * TW
    obl = (23.439 - 4.0e-7 * dj) * D2R
    el = (1.915 * math.sin(ma) + 0.020 * math.sin(2 * ma)) * D2R + ml
    dist = 1.00014 - 0.01671 * math.cos(ma) - 0.00014 * math.cos(2 * ma)
    ra = math.atan2(math.cos(obl) * math.sin(el), math.cos(el))
    if ra < 0:
        ra += TW
    ra = math.modf(ra / TW)[0] * 24.0
    dec = math.asin(math.sin(obl) * math.sin(el))
    g0 = 24110.54841 + cent * (8640184.812866 + cent * (0.093104 - cent * 6.2e-6))
    g0 = math.modf(g0 / 3600.0 / 24.0)[0] * 24.0
    g0 = g0 + 24.0 if g0 < 0 else g0
    lmst = math.modf((g0 + ut * 1.00273790934 + lon / 15.0) / 24.0)[0] * 24.0
    lmst = lmst + 24.0 if lmst < 0 else lmst
    ha = lmst - ra
    ha = ha + 24.0 if ha < -12.0 else ha - 24.0 if ha > 12.0 else ha
    ha = ha / 24.0 * TW
    alt = math.asin(math.sin(dec) * math.sin(lat * D2R) + math.cos(dec) * math.cos(ha) * math.cos(lat * D2R))
    tan_alt = math.tan(alt) if abs(alt) < 1.57079615 else 6.0e6
    alt *= R2D
    if alt < -1.0 or tan_alt == 6.0e6:
        refr = 0.0
    elif alt < 19.225:
        refr = (0.1594 + alt * (0.0196 + 0.00002 * alt)) * 1013.25 / ((1.0 + alt * (0.505 + 0.0845 * alt)) * (273.0 + 15.0))
    else:
        refr = 0.00452 * (1013.25 / (273.0 + 15.0)) / tan_alt
    return alt + refr, refr, dist


def c_calc_wbgt(cref, t_end_utc, avg_min, lat, lon, S, P, Ta, RH, u, zu=10.0, dT=-1.0, urban=True):
    """Original calc_wbgt() semantics: zenith via Larson at the centre of the averaging
    period, Liljegren fdir + solar cap, stability-class wind conversion without the
    KNMI floor, solvers with cref.max_iter. Returns dict (None where not converged)."""
    t_mid = t_end_utc - dt.timedelta(minutes=0.5 * avg_min)
    dayfrac = t_mid.timetuple().tm_yday + (t_mid.hour + t_mid.minute / 60.0 + t_mid.second / 3600.0) / 24.0
    elev, _, dist = larson_solarposition(t_mid.year, 0, dayfrac, lat, lon)
    cza = math.cos((90.0 - elev) * C["DEG_RAD"])
    toa = C["SOLAR_CONST"] * max(0.0, cza) / dist ** 2
    if cza < C["CZA_MIN"]:
        toa = 0.0
    fdir = 0.0
    if toa > 0.0:
        ns = min(S / toa, C["NORMSOLAR_MAX"]); S = ns * toa
        fdir = max(min(math.exp(3.0 - 1.34 * ns - 1.65 / ns), 0.9), 0.0) if ns > 0.0 else 0.0
    if zu != C["REF_HEIGHT"]:
        cls = cref.stability_class(cza > 0.0, u, S, dT)
        u = cref.est_wind(u, zu, cls, urban)
    tk, rh = Ta + 273.15, RH / 100.0
    tg = cref.tglobe(tk, rh, P, u, S, fdir, cza)
    tw = cref.twb(tk, rh, P, u, S, fdir, cza, 1)
    tp = cref.twb(tk, rh, P, u, S, fdir, cza, 0)
    w = None if (tg is None or tw is None) else 0.1 * Ta + 0.2 * tg + 0.7 * tw
    return dict(cos_zenith=cza, fdir=fdir, ghi_used=S, u2=u, tg_c=tg, tnwb_c=tw, tpsy_c=tp, wbgt_c=w,
                status=0 if w is not None else -1)


# ============================================================================
# 2. NOAA solar position (NOAA GML Solar Calculator spreadsheet equations)
# ============================================================================
D2R, R2D = math.pi / 180.0, 180.0 / math.pi


def julian_day(t_utc: dt.datetime) -> float:
    return t_utc.timestamp() / 86400.0 + 2440587.5


def noaa_solar(jd: float, lat: float, lon: float) -> dict:
    T = (jd - 2451545.0) / 36525.0
    L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360.0
    M = 357.52911 + T * (35999.05029 - 0.0001537 * T)
    e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T)
    Cc = (math.sin(D2R * M) * (1.914602 - T * (0.004817 + 0.000014 * T))
          + math.sin(D2R * 2 * M) * (0.019993 - 0.000101 * T) + math.sin(D2R * 3 * M) * 0.000289)
    true_anom = M + Cc
    R = (1.000001018 * (1 - e * e)) / (1 + e * math.cos(D2R * true_anom))
    omega = 125.04 - 1934.136 * T
    lam = L0 + Cc - 0.00569 - 0.00478 * math.sin(D2R * omega)
    eps0 = 23.0 + (26.0 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60.0) / 60.0
    eps = eps0 + 0.00256 * math.cos(D2R * omega)
    decl = R2D * math.asin(math.sin(D2R * eps) * math.sin(D2R * lam))
    y = math.tan(D2R * eps / 2.0) ** 2
    eot = 4.0 * R2D * (y * math.sin(2 * D2R * L0) - 2 * e * math.sin(D2R * M)
                       + 4 * e * y * math.sin(D2R * M) * math.cos(2 * D2R * L0)
                       - 0.5 * y * y * math.sin(4 * D2R * L0) - 1.25 * e * e * math.sin(2 * D2R * M))
    tst = (((jd + 0.5) % 1.0) * 1440.0 + eot + 4.0 * lon) % 1440.0
    ha = tst / 4.0 - 180.0
    cz = (math.sin(D2R * lat) * math.sin(D2R * decl)
          + math.cos(D2R * lat) * math.cos(D2R * decl) * math.cos(D2R * ha))
    cz = max(-1.0, min(1.0, cz))
    zen = R2D * math.acos(cz)
    elev = 90.0 - zen
    if elev > 85.0:
        refr = 0.0
    else:
        te = math.tan(D2R * elev)
        if elev > 5.0:
            refr = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5
        elif elev > -0.575:
            refr = 1735.0 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)))
        else:
            refr = -20.772 / te
        refr /= 3600.0
    app = elev + refr
    return dict(julian_day=jd, declination_deg=decl, eot_min=eot, hour_angle_deg=ha,
                zenith_deg=zen, refraction_deg=refr, apparent_zenith_deg=90.0 - app,
                cos_zenith=cz, cos_apparent_zenith=math.sin(D2R * app), earth_sun_au=R)


def sunlit_mean_cos_zenith(t_end, lat, lon, minutes=60, n=60):
    """Mean cos(apparent zenith) over the sunlit part of (t_end-minutes, t_end] and the sunlit fraction."""
    vals = []
    for k in range(n):
        t = t_end - dt.timedelta(minutes=minutes) + dt.timedelta(minutes=(k + 0.5) * minutes / n)
        vals.append(noaa_solar(julian_day(t), lat, lon)["cos_apparent_zenith"])
    v = np.array(vals); lit = v > 0
    return (float(v[lit].mean()) if lit.any() else 0.0), float(lit.mean())


# ============================================================================
# 3. Model helpers shared by the pipeline
# ============================================================================
def liljegren_fdir(ghi, toa):
    """calc_solar_parameters(): returns (ghi_used, fdir, clearness_before_cap)."""
    if toa <= 0.0:
        return ghi, 0.0, None
    kt = ghi / toa
    ns = min(kt, C["NORMSOLAR_MAX"])
    used = ns * toa
    if ns <= 0.0:
        return used, 0.0, kt
    return used, max(min(math.exp(3.0 - 1.34 * ns - 1.65 / ns), 0.9), 0.0), kt


def esat_liljegren_c(tc):
    tk = tc + 273.15
    return 1.004 * 6.1121 * math.exp(17.502 * (tk - 273.15) / (tk - 32.18))


def rh_from_td(ta_c, td_c):
    return max(1.0, min(100.0, 100.0 * esat_liljegren_c(td_c) / esat_liljegren_c(ta_c)))


def bom_wbgt(ta_c, rh_pct):
    """Australian BoM shade approximation (NOT the Liljegren model)."""
    e = rh_pct / 100.0 * 6.105 * math.exp(17.27 * ta_c / (237.7 + ta_c))
    return 0.567 * ta_c + 0.393 * e + 3.94, e


def tf_components(ta_c, rh_pct, p_hpa, u2, ghi, fdir, cza):
    """thermofeel solvers with exactly the preprocessing of thermofeel.liljegren.wbgt()."""
    a = lambda v: np.atleast_1d(np.asarray(v, dtype=float))
    tk = a(ta_c) + 273.15; rh = a(rh_pct) / 100.0; p = a(p_hpa); u = a(u2); s = a(ghi); cz = a(cza)
    fd = np.clip(a(fdir), 0.0, 0.9)
    fd = np.where(cz < TL.CZA_MIN, 0.0, fd)
    tg = TL.solve_globe(tk, rh, p, u, s, fd, cz)
    tw = TL.solve_wetbulb(tk, rh, p, u, s, fd, cz, 1.0)
    tp = TL.solve_wetbulb(tk, rh, p, u, s, fd, cz, 0.0)
    wb = 0.1 * (tk - 273.15) + 0.2 * tg + 0.7 * tw
    return tg, tw, tp, wb, fd


def tf_api(ta_c, rh_pct, p_hpa, u10, ghi, fdir, cza):
    a = lambda v: np.atleast_1d(np.asarray(v, dtype=float))
    return tf.calculate_wbgt_liljegren(a(ta_c) + 273.15, a(rh_pct), a(p_hpa), a(u10), a(ghi), a(fdir), a(cza)) - 273.15


def num(x, nd=9):
    if x is None:
        return None
    x = float(x)
    return None if not math.isfinite(x) else round(x, nd)


FAILS: list[str] = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} {detail}")
    if not ok:
        FAILS.append(f"{name} {detail}")
    return ok


# ============================================================================
# 4. Case definitions
# ============================================================================
SITES = {
    "abu_dhabi_city": (24.4539, 54.3773),
    "madinat_zayed": (23.6833, 53.7000),
    "al_ain": (24.2075, 55.7447),
    "ruwais": (24.1100, 52.7300),
    "liwa": (23.1300, 53.7700),
}

# Core (solver-level) cases: inputs already at 2 m, with GHI/fdir/cos(zenith) given.
CORE = [
    ("inland_noon_extreme", "46 C / 13 % / 2 m wind 1.0 / strong sun", 46.2, 13.0, 983.7, 1.0, 916.0, 0.73, 0.997),
    ("humid_coastal_morning", "35 C / 70 % / 1.5 m/s / morning sun", 35.0, 70.0, 997.0, 1.5, 300.0, 0.30, 0.45),
    ("night_humid", "33 C / 60 % / no sun", 33.0, 60.0, 996.0, 1.5, 0.0, 0.0, -0.40),
    ("calm_floor_0p13", "2 m wind at Liljegren floor 0.13 m/s", 40.0, 30.0, 1000.0, 0.13, 800.0, 0.65, 0.90),
    ("below_floor_0p05", "0.05 m/s -> treated as 0.13 inside Re", 40.0, 30.0, 1000.0, 0.05, 800.0, 0.65, 0.90),
    ("low_wind_0p5", "0.5 m/s", 44.0, 20.0, 995.0, 0.5, 850.0, 0.69, 0.97),
    ("strong_wind_6", "6 m/s at 2 m", 40.0, 35.0, 998.0, 6.0, 700.0, 0.62, 0.85),
    ("winter_noon", "25 C / 50 % / winter noon", 25.0, 50.0, 1018.0, 2.5, 650.0, 0.60, 0.67),
    ("dust_low_ghi_diffuse", "dusty: GHI 350, fdir 0.15", 42.0, 30.0, 996.0, 4.0, 350.0, 0.15, 0.95),
    ("overcast_fdir0", "overcast, all diffuse", 34.0, 65.0, 1000.0, 2.0, 200.0, 0.0, 0.80),
    ("low_sun_direct", "low sun cos z 0.15, fdir 0.09", 34.5, 70.0, 994.4, 2.0, 64.0, 0.09, 0.15),
    ("max_fdir_overhead", "fdir 0.9 at cos z 1.0", 45.0, 15.0, 990.0, 1.0, 1000.0, 0.9, 1.0),
    ("very_dry_rh1", "RH 1 % (lower clamp used by Zill)", 48.0, 1.0, 985.0, 2.0, 870.0, 0.70, 0.95),
    ("saturated_rh100", "RH 100 %", 30.0, 100.0, 1005.0, 1.0, 500.0, 0.5, 0.8),
    ("hot_humid_extreme", "40 C / 60 % / 1 m/s / 800 W", 40.0, 60.0, 1000.0, 1.0, 800.0, 0.68, 0.90),
    ("high_altitude_like_P950", "P 950 hPa sensitivity", 38.0, 20.0, 950.0, 2.0, 900.0, 0.7, 0.95),
    ("cool_night", "18 C / 75 % / night", 18.0, 75.0, 1018.0, 1.0, 0.0, 0.0, -0.6),
    ("lemke_fig1_S0", "Lemke & Kjellstrom 2012 Fig.1 S=0 point (geometry-free)", 30.0, 55.0, 1013.25, 1.0, 0.0, 0.0, 1.0),
    ("cza_below_min_guard", "cos z 0.005 < CZA_MIN: fdir forced to 0 (GHI kept as diffuse)", 33.0, 60.0, 995.0, 2.0, 15.0, 0.5, 0.005),
    ("fdir_above_0p9_clamped", "fdir 1.0 supplied -> clamped to 0.9", 45.0, 15.0, 990.0, 1.0, 1000.0, 1.0, 1.0),
]

# Full-pipeline cases (Open-Meteo-like hourly records; t_end = end of the 60-min averaging period).
# rh given directly or derived from td via the Liljegren esat. ghi = shortwave_radiation (hour mean).
FULL = [
    dict(id="inland_summer_noon_extreme", site="madinat_zayed", t_end="2025-07-15T09:00", ta=46.2, td=11.5, p=983.7, u10=1.38, ghi=916.0, direct=633.0,
         desc="Open-Meteo snapshot 13:00 GST: 46.2 C, ~13 % RH, strong sun"),
    dict(id="inland_noon_low_wind_0p5", site="madinat_zayed", t_end="2025-07-15T09:00", ta=46.2, td=11.5, p=983.7, u10=0.5, ghi=916.0,
         desc="same as above with 10 m wind 0.5 m/s (below KNMI floor 0.62)"),
    dict(id="humid_coastal_morning", site="abu_dhabi_city", t_end="2025-08-10T04:00", ta=35.0, rh=70.0, p=997.0, u10=2.5, ghi=300.0,
         desc="08:00 GST humid coastal morning 35 C / 70 %"),
    dict(id="night_humid_no_sun", site="abu_dhabi_city", t_end="2025-07-15T20:00", ta=33.0, rh=60.0, p=996.3, u10=2.26, ghi=0.0,
         desc="midnight GST 33 C / 60 %, no sun"),
    dict(id="coastal_strong_wind_6", site="abu_dhabi_city", t_end="2025-06-10T10:00", ta=40.0, rh=35.0, p=995.0, u10=6.0, ghi=700.0,
         desc="14:00 GST shamal 6 m/s"),
    dict(id="winter_noon", site="abu_dhabi_city", t_end="2025-01-15T09:00", ta=25.0, rh=50.0, p=1018.0, u10=3.5, ghi=650.0,
         desc="13:00 GST winter 25 C"),
    dict(id="dust_overcast_low_ghi", site="abu_dhabi_city", t_end="2025-07-20T09:00", ta=42.0, rh=30.0, p=995.0, u10=7.0, ghi=350.0,
         desc="13:00 GST dust event, GHI 350 (clear-sky ~900)"),
    dict(id="dust_haze_moderate", site="abu_dhabi_city", t_end="2025-07-20T08:00", ta=44.0, rh=25.0, p=995.0, u10=4.0, ghi=600.0,
         desc="12:00 GST haze, GHI 600"),
    dict(id="sunrise_hour", site="abu_dhabi_city", t_end="2025-07-15T02:00", ta=32.4, td=26.7, p=995.6, u10=1.86, ghi=2.0,
         desc="06:00 GST, sun rose during the hour (mid-hour sun below horizon)"),
    dict(id="low_sun_evening", site="abu_dhabi_city", t_end="2025-07-15T15:00", ta=34.5, td=28.3, p=994.4, u10=4.91, ghi=64.0, direct=13.0,
         desc="19:00 GST low sun"),
    dict(id="al_ain_inland_elevated", site="al_ain", t_end="2025-06-20T09:00", ta=45.0, rh=10.0, p=965.0, u10=3.0, ghi=950.0,
         desc="Al Ain 13:00 GST, ~290 m elevation"),
    dict(id="ruwais_humid_heat", site="ruwais", t_end="2025-08-15T07:00", ta=40.0, rh=60.0, p=996.0, u10=2.0, ghi=800.0,
         desc="industrial coast 11:00 GST, very humid heat"),
    dict(id="calm_humid_night", site="abu_dhabi_city", t_end="2025-08-20T23:00", ta=31.0, rh=85.0, p=997.0, u10=0.3, ghi=0.0,
         desc="03:00 GST calm humid night (wind floored)"),
    dict(id="spring_morning", site="abu_dhabi_city", t_end="2025-04-15T05:00", ta=30.0, rh=45.0, p=1010.0, u10=4.0, ghi=600.0,
         desc="09:00 GST spring"),
    dict(id="autumn_afternoon", site="abu_dhabi_city", t_end="2025-10-15T11:00", ta=36.0, rh=40.0, p=1008.0, u10=3.0, ghi=450.0,
         desc="15:00 GST autumn"),
    dict(id="solar_cap_cloud_enhancement", site="abu_dhabi_city", t_end="2025-06-21T09:00", ta=44.0, rh=20.0, p=994.0, u10=2.0, ghi=1150.0,
         desc="GHI above 0.85*TOA -> normsolar cap rescales GHI"),
    dict(id="liwa_very_dry", site="liwa", t_end="2025-06-25T10:00", ta=48.0, rh=6.0, p=990.0, u10=2.0, ghi=870.0,
         desc="Liwa 14:00 GST, 48 C / 6 %"),
    dict(id="winter_night", site="abu_dhabi_city", t_end="2025-01-15T22:00", ta=18.0, rh=75.0, p=1019.0, u10=1.5, ghi=0.0,
         desc="02:00 GST winter night"),
    dict(id="openmeteo_snapshot_peak", site="abu_dhabi_city", t_end="2025-07-15T07:00", ta=43.3, td=16.6, p=995.9, u10=0.87, ghi=754.0, direct=509.0,
         desc="Open-Meteo snapshot 11:00 GST (Abu Dhabi peak hour)"),
    dict(id="openmeteo_snapshot_shamal_10", site="abu_dhabi_city", t_end="2025-07-15T07:00", ta=43.3, td=16.6, p=995.9, u10=10.0, ghi=754.0,
         desc="as above with 10 m/s wind"),
]

LEMKE = {
    "source": "Lemke B, Kjellstrom T. Calculating workplace WBGT from meteorological data: a tool for climate change assessment. "
              "Ind Health 2012;50(4):267-278, Figs 1-4 (Liljegren series, filled squares). Digitized from the open-access PDF at 400 dpi "
              "(gridline-calibrated, square-template detection); reading uncertainty ~ +/-0.05 degC.",
    "fixed_conditions": {"fig1": "wind 1 m/s, RH 55 %, Ta 30 C; x = solar W/m2",
                         "fig2": "solar 500, wind 1 m/s, Ta 30 C; x = RH % (markers at 1 C dew-point steps)",
                         "fig3": "solar 500, RH 55 %, Ta 30 C; x = wind m/s", "fig4": "RH 55 %, solar 500, wind 1 m/s; x = Ta C"},
    "fig1": ([0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 850, 900, 950, 1000, 1050, 1100],
             [24.83, 25.17, 25.51, 25.84, 26.18, 26.48, 26.77, 27.09, 27.4, 27.74, 28.06, 28.32, 28.68, 28.97, 29.3, 29.61, 29.94, 30.22, 30.5, 30.81, 31.13, 31.44, 31.72]),
    "fig2": ([20.71, 22.14, 23.73, 25.36, 27.23, 29.1, 31.05, 33.11, 35.36, 37.75, 40.3, 42.96, 45.73, 48.73, 51.84, 55.13, 58.61, 62.25, 66.22, 70.26, 74.61, 79.07, 83.86, 94.26, 99.78],
             [23.2, 23.44, 23.72, 23.96, 24.23, 24.52, 24.82, 25.11, 25.43, 25.78, 26.13, 26.48, 26.85, 27.25, 27.66, 28.06, 28.49, 28.92, 29.36, 29.85, 30.33, 30.81, 31.3, 32.33, 32.87]),
    "fig3": ([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3.0],
             [32.32, 30.75, 29.96, 29.44, 29.03, 28.75, 28.55, 28.35, 28.2, 28.07, 27.94, 27.83, 27.75, 27.67, 27.59, 27.5, 27.4, 27.38, 27.31, 27.26, 27.22, 27.16, 27.12, 27.1, 27.05, 27.02, 27.0, 26.95, 26.92, 26.88]),
    "fig4": ([22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43],
             [21.14, 21.99, 22.85, 23.7, 24.54, 25.39, 26.31, 27.21, 28.13, 28.99, 29.83, 30.69, 31.57, 32.44, 33.32, 34.18, 35.04, 35.97, 36.91, 37.8, 38.67, 39.58]),
}


# ============================================================================
# 5. Builders
# ============================================================================
def build_constants():
    return {
        "STEFANB_W_m2K4": C["STEFANB"], "Cp_J_kgK": C["Cp"], "M_AIR_g_mol": C["M_AIR"], "M_H2O_g_mol": C["M_H2O"],
        "R_GAS_J_kmolK": C["R_GAS"], "R_AIR_J_kgK": C["R_AIR"], "Pr": C["Pr"], "RATIO_Cp_Mair_over_Mh2o": C["RATIO"],
        "EMIS_GLOBE": C["EMIS_GLOBE"], "ALB_GLOBE": C["ALB_GLOBE"], "D_GLOBE_m": C["D_GLOBE"],
        "EMIS_WICK": C["EMIS_WICK"], "ALB_WICK": C["ALB_WICK"], "D_WICK_m": C["D_WICK"], "L_WICK_m": C["L_WICK"],
        "EMIS_SFC": C["EMIS_SFC"], "ALB_SFC": C["ALB_SFC"], "SOLAR_CONST_W_m2": C["SOLAR_CONST"],
        "CZA_MIN": C["CZA_MIN"], "NORMSOLAR_MAX": C["NORMSOLAR_MAX"], "MIN_SPEED_ms": C["MIN_SPEED"],
        "CONVERGENCE_K": C["CONVERGENCE"], "MAX_ITER_thermofeel": TL.MAX_ITER, "MAX_ITER_original_C": 50,
        "DAMPING_new_weight": 0.1, "MIN_WIND_10M_KNMI_ms": TL.MIN_WIND_10M,
        "URBAN_EXP_by_class_1to6": URBAN_EXP, "RURAL_EXP_by_class_1to6_original_C_only": RURAL_EXP,
        "LSRDT_table_rows_wind_cols_radiation": LSRDT,
    }


def build_property_cases(cref):
    out = []
    for tk in (283.15, 293.15, 303.15, 313.15, 323.15):
        for p in (1013.25, 980.0):
            row = dict(T_K=tk, P_hPa=p,
                       esat_hPa=float(TL.esat(tk)), viscosity_kg_ms=float(TL.viscosity(tk)),
                       thermal_cond_W_mK=float(TL.thermal_cond(tk)), diffusivity_m2_s=float(TL.diffusivity(tk, p)),
                       evap_J_kg=float(TL.evap(tk)), emis_atm_rh30=float(TL.emis_atm(tk, 0.30)), emis_atm_rh70=float(TL.emis_atm(tk, 0.70)),
                       dew_point_K_of_half_esat=float(TL.dew_point(0.5 * TL.esat(tk))),
                       h_sphere_u0p13=float(TL.h_sphere_in_air(tk, p, 0.13)), h_sphere_u1=float(TL.h_sphere_in_air(tk, p, 1.0)),
                       h_sphere_u4=float(TL.h_sphere_in_air(tk, p, 4.0)),
                       h_cylinder_u0p13=float(TL.h_cylinder_in_air(tk, p, 0.13)), h_cylinder_u1=float(TL.h_cylinder_in_air(tk, p, 1.0)),
                       h_cylinder_u4=float(TL.h_cylinder_in_air(tk, p, 4.0)))
            ref = dict(esat_hPa=cref.esat(tk), viscosity_kg_ms=cref.viscosity(tk), thermal_cond_W_mK=cref.thermal_cond(tk),
                       diffusivity_m2_s=cref.diffusivity(tk, p), evap_J_kg=cref.evap(tk), emis_atm_rh30=cref.emis_atm(tk, 0.3),
                       emis_atm_rh70=cref.emis_atm(tk, 0.7), dew_point_K_of_half_esat=cref.dew_point(0.5 * cref.esat(tk)),
                       h_sphere_u0p13=cref.h_sphere(tk, p, 0.13), h_sphere_u1=cref.h_sphere(tk, p, 1.0), h_sphere_u4=cref.h_sphere(tk, p, 4.0),
                       h_cylinder_u0p13=cref.h_cylinder(tk, p, 0.13), h_cylinder_u1=cref.h_cylinder(tk, p, 1.0), h_cylinder_u4=cref.h_cylinder(tk, p, 4.0))
            rel = max(abs(row[k] - v) / max(abs(v), 1e-300) for k, v in ref.items())
            row["max_rel_diff_vs_c_transliteration"] = rel
            out.append({k: (v if isinstance(v, float) and k in ("T_K", "P_hPa") else (float(f"{v:.12g}") if isinstance(v, float) else v)) for k, v in row.items()})
    return out


def build_core_cases(cref):
    out, maxd = [], 0.0
    for cid, desc, ta, rh, p, u2, s, fd, cz in CORE:
        tg, tw, tp, wb, fd_used = tf_components(ta, rh, p, u2, s, fd, cz)
        tg, tw, tp, wb, fd_used = float(tg[0]), float(tw[0]), float(tp[0]), float(wb[0]), float(fd_used[0])
        fdc = fd_used
        rtg = cref.tglobe(ta + 273.15, rh / 100, p, u2, s, fdc, cz)
        rtw = cref.twb(ta + 273.15, rh / 100, p, u2, s, fdc, cz, 1)
        rtp = cref.twb(ta + 273.15, rh / 100, p, u2, s, fdc, cz, 0)
        its = dict(cref.iters)
        d = max(abs(tg - rtg), abs(tw - rtw), abs(tp - rtp))
        maxd = max(maxd, d)
        eair = rh / 100 * cref.esat(ta + 273.15)
        out.append(dict(
            id=cid, desc=desc,
            inputs=dict(ta_c=ta, rh_pct=rh, p_hpa=p, u2_ms=u2, ghi_wm2=s, fdir_supplied=fd, cos_zenith=cz),
            preprocessing=dict(fdir_used=fdc, note="fdir clamped to [0,0.9]; set to 0 when cos_zenith < CZA_MIN"),
            intermediates=dict(eair_hPa=num(eair), tdew_c=num(cref.dew_point(eair) - 273.15) if eair > 0 else None,
                               emis_atm=num(cref.emis_atm(ta + 273.15, rh / 100))),
            outputs=dict(tg_c=num(tg), tnwb_c=num(tw), tpsy_c=num(tp), wbgt_outdoor_c=num(wb),
                         wbgt_indoor_formula_c=num(0.7 * tw + 0.3 * tg)),
            iterations=dict(tg=its.get("tg"), tnwb=its.get("tnwb"), tpsy=its.get("tpsy")),
            max_abs_diff_vs_c_transliteration_c=d))
    return out, maxd


def build_traces(cref):
    traces = {}
    for cid in ("inland_noon_extreme", "night_humid"):
        cid_, desc, ta, rh, p, u2, s, fd, cz = next(c for c in CORE if c[0] == cid)
        fd = 0.0 if cz < C["CZA_MIN"] else min(max(fd, 0.0), 0.9)
        tg_tr, tw_tr = [], []
        cref.tglobe(ta + 273.15, rh / 100, p, u2, s, fd, cz, trace=tg_tr)
        cref.twb(ta + 273.15, rh / 100, p, u2, s, fd, cz, 1, trace=tw_tr)
        clean = lambda tr: [{k: num(v, 9) if isinstance(v, float) else v for k, v in row.items()} for row in tr]
        traces[cid] = dict(globe_first3=clean(tg_tr[:3]), globe_last=clean(tg_tr[-1:]), globe_iterations=len(tg_tr),
                           wetbulb_first3=clean(tw_tr[:3]), wetbulb_last=clean(tw_tr[-1:]), wetbulb_iterations=len(tw_tr))
    return traces


def build_wind_cases(cref):
    rows, maxd = [], 0.0
    for u10 in (0.0, 0.3, 0.62, 1.0, 1.99, 2.0, 2.49, 2.5, 2.99, 3.0, 4.99, 5.0, 5.99, 6.0, 8.0, 12.0):
        for s in (0.0, 100.0, 175.0, 674.9, 675.0, 924.9, 925.0, 1100.0):
            for cz in (-0.3, 0.0, 0.5):
                tf_u2 = float(TL.wind_speed_2m(u10, cz, s))                     # no 10 m floor
                cls = cref.stability_class(cz > 0.0, u10, s, -1.0)
                c_u2 = cref.est_wind(u10, 10.0, cls, True)
                maxd = max(maxd, abs(tf_u2 - c_u2))
                u10f = max(u10, TL.MIN_WIND_10M)
                api_u2 = float(TL.wind_speed_2m(u10f, cz, s))
                if s in (0.0, 175.0, 675.0, 925.0) and cz in (-0.3, 0.5) and u10 in (0.0, 0.62, 1.0, 2.0, 2.5, 3.0, 5.0, 6.0, 12.0):
                    if cz < 0 and s > 0:
                        continue
                    rows.append(dict(u10_ms=u10, ghi_wm2=s, cos_zenith=cz, daytime=cz > 0.0, stability_class=cls,
                                     exponent_urban=URBAN_EXP[cls - 1], u2_urban_no_floor_ms=num(tf_u2),
                                     u10_after_knmi_floor_ms=u10f, u2_thermofeel_api_ms=num(api_u2),
                                     u2_rural_original_C_dT_lt0_ms=num(cref.est_wind(u10, 10.0, cls, False)),
                                     u2_rural_original_C_dT_ge0_ms=num(cref.est_wind(u10, 10.0, cref.stability_class(cz > 0.0, u10, s, 0.0), False))))
    return rows, maxd


SOLAR_POINTS = [
    ("abu_dhabi_city", "2025-06-21T08:20"), ("abu_dhabi_city", "2025-07-15T08:30"), ("abu_dhabi_city", "2025-12-21T08:30"),
    ("abu_dhabi_city", "2025-03-20T03:00"), ("abu_dhabi_city", "2025-07-15T01:45"), ("abu_dhabi_city", "2025-07-15T14:30"),
    ("abu_dhabi_city", "2025-09-23T20:00"), ("al_ain", "2025-01-15T05:00"), ("liwa", "2025-08-01T10:00"),
    ("sydney_check", "2025-01-15T02:00"), ("phoenix_check", "2025-07-15T19:00"), ("tromso_check", "2025-06-21T10:00"),
]
EXTRA_SITES = {"sydney_check": (-33.8688, 151.2093), "phoenix_check": (33.4484, -112.0740), "tromso_check": (69.6492, 18.9553)}


def build_solar_cases():
    try:
        import pandas as pd
        import pvlib
    except Exception as exc:                                                  # pragma: no cover
        print("  pvlib unavailable:", exc)
        return [], None
    rows = []
    for site, ts in SOLAR_POINTS:
        lat, lon = SITES.get(site) or EXTRA_SITES[site]
        t = dt.datetime.fromisoformat(ts).replace(tzinfo=dt.timezone.utc)
        n = noaa_solar(julian_day(t), lat, lon)
        s = pvlib.solarposition.get_solarposition(pd.DatetimeIndex([pd.Timestamp(t)]), lat, lon, altitude=0,
                                                  pressure=101325, temperature=15, method="nrel_numpy").iloc[0]
        la_alt, la_refr, la_dist = larson_solarposition(t.year, 0, t.timetuple().tm_yday + (t.hour + t.minute / 60) / 24, lat, lon)
        rows.append(dict(site=site, lat=lat, lon=lon, time_utc=ts + "Z", julian_day=num(n["julian_day"], 6),
                         noaa=dict(declination_deg=num(n["declination_deg"]), eot_min=num(n["eot_min"]), hour_angle_deg=num(n["hour_angle_deg"]),
                                   zenith_deg=num(n["zenith_deg"]), refraction_deg=num(n["refraction_deg"]),
                                   apparent_zenith_deg=num(n["apparent_zenith_deg"]), cos_zenith=num(n["cos_zenith"]),
                                   cos_apparent_zenith=num(n["cos_apparent_zenith"]), earth_sun_au=num(n["earth_sun_au"])),
                         pvlib_spa=dict(zenith_deg=num(s["zenith"]), apparent_zenith_deg=num(s["apparent_zenith"])),
                         larson_original_C=dict(apparent_zenith_deg=num(90 - la_alt), earth_sun_au=num(la_dist)),
                         diff_noaa_minus_spa_zenith_deg=num(n["zenith_deg"] - s["zenith"])))
    # year-long statistics at Abu Dhabi, hourly 2025
    lat, lon = SITES["abu_dhabi_city"]
    times = pd.date_range("2025-01-01 00:00", "2025-12-31 23:00", freq="1h", tz="UTC")
    sp = pvlib.solarposition.get_solarposition(times, lat, lon, altitude=0, pressure=101325, temperature=15, method="nrel_numpy")
    nz, naz, lz = [], [], []
    for t in times.to_pydatetime():
        n = noaa_solar(julian_day(t), lat, lon); nz.append(n["zenith_deg"]); naz.append(n["apparent_zenith_deg"])
        la_alt, la_refr, _ = larson_solarposition(t.year, 0, t.timetuple().tm_yday + t.hour / 24.0, lat, lon); lz.append(90 - (la_alt - la_refr))
    nz, naz, lz = np.array(nz), np.array(naz), np.array(lz)
    up = sp["apparent_zenith"].values < 90.0
    up5 = (90.0 - sp["apparent_zenith"].values) > 5.0
    dz = np.abs(nz - sp["zenith"].values)[up]
    dcz = np.abs(np.cos(np.radians(nz)) - np.cos(np.radians(sp["zenith"].values)))[up]
    daz = np.abs(naz - sp["apparent_zenith"].values)[up5]
    dlz = np.abs(lz - sp["zenith"].values)[up]
    stats = dict(site="abu_dhabi_city", period="2025 hourly UTC", n_sun_up=int(up.sum()),
                 noaa_vs_spa_max_abs_zenith_deg=float(dz.max()), noaa_vs_spa_max_abs_cos_zenith=float(dcz.max()),
                 noaa_vs_spa_max_abs_apparent_zenith_deg_elev_gt5=float(daz.max()),
                 larson_vs_spa_max_abs_zenith_deg=float(dlz.max()))
    return rows, stats


def build_fdir_cases():
    out = []
    for kt in (0.0, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.8251, 0.85, 0.9, 1.0, 1.2):
        used, fd, k = liljegren_fdir(kt * 1000.0, 1000.0)
        out.append(dict(toa_wm2=1000.0, ghi_wm2=kt * 1000.0, clearness_kt=kt, ghi_used_wm2=num(used), fdir=num(fd)))
    out.append(dict(toa_wm2=0.0, ghi_wm2=20.0, clearness_kt=None, ghi_used_wm2=20.0, fdir=0.0,
                    note="sun below CZA_MIN: TOA=0 -> fdir 0, GHI unchanged (treated as diffuse)"))
    return out


def run_full_case(c, cref_c50):
    lat, lon = SITES[c["site"]]
    t_end = dt.datetime.fromisoformat(c["t_end"]).replace(tzinfo=dt.timezone.utc)
    avg = 60
    t_eval = t_end - dt.timedelta(minutes=avg / 2)
    sol = noaa_solar(julian_day(t_eval), lat, lon)
    cza = sol["cos_apparent_zenith"]
    rh = c["rh"] if "rh" in c else rh_from_td(c["ta"], c["td"])
    toa = C["SOLAR_CONST"] * max(cza, 0.0) / sol["earth_sun_au"] ** 2 if cza >= C["CZA_MIN"] else 0.0
    ghi_used, fdir, kt = liljegren_fdir(c["ghi"], toa)
    u10f = max(c["u10"], TL.MIN_WIND_10M)
    cls = CRef.stability_class(cza > 0.0, u10f, ghi_used)
    u2_tf = float(TL.wind_speed_2m(u10f, cza, ghi_used))
    u2_ref = max(u10f * 0.2 ** URBAN_EXP[cls - 1], C["MIN_SPEED"])
    w_api = float(tf_api(c["ta"], rh, c["p"], c["u10"], ghi_used, fdir, cza)[0])
    tg, tw, tp, wb, fd_used = (float(x[0]) for x in tf_components(c["ta"], rh, c["p"], u2_tf, ghi_used, fdir, cza))
    cr = CRef(f64, 500)
    rtg = cr.tglobe(c["ta"] + 273.15, rh / 100, c["p"], u2_tf, ghi_used, fd_used, cza)
    rtw = cr.twb(c["ta"] + 273.15, rh / 100, c["p"], u2_tf, ghi_used, fd_used, cza, 1)
    rtp = cr.twb(c["ta"] + 273.15, rh / 100, c["p"], u2_tf, ghi_used, fd_used, cza, 0)
    its = dict(cr.iters)
    # shade: same atmosphere and 2 m wind, sensors shielded from sun (GHI=0)
    stg, stw, stp, swb, _ = (float(x[0]) for x in tf_components(c["ta"], rh, c["p"], u2_tf, 0.0, 0.0, cza))
    bom, e_bom = bom_wbgt(c["ta"], rh)
    czl, flit = sunlit_mean_cos_zenith(t_end, lat, lon)
    orig = c_calc_wbgt(cref_c50, t_end, avg, lat, lon, c["ghi"], c["p"], c["ta"], rh, c["u10"])
    alt = None
    if "direct" in c and c["ghi"] > 0:
        f_om = c["direct"] / c["ghi"]
        w_om = float(tf_api(c["ta"], rh, c["p"], c["u10"], c["ghi"], f_om, cza)[0])
        alt = dict(fdir_openmeteo_direct_over_ghi=num(f_om), wbgt_c=num(w_om), delta_vs_primary_c=num(w_om - w_api),
                   note="sensitivity only: Open-Meteo direct_radiation/shortwave_radiation, no normsolar cap")
    rec = dict(
        id=c["id"], desc=c["desc"], site=c["site"],
        inputs=dict(lat=lat, lon=lon, time_end_utc=c["t_end"] + "Z", avg_minutes=avg, ta_c=c["ta"],
                    rh_pct=c.get("rh"), td_c=c.get("td"), p_hpa=c["p"], u10_ms=c["u10"], wind_height_m=10.0,
                    ghi_wm2=c["ghi"], direct_wm2=c.get("direct"), site_type="urban (thermofeel/KNMI exponents)"),
        derived=dict(rh_used_pct=num(rh), time_eval_utc=t_eval.strftime("%Y-%m-%dT%H:%MZ"), julian_day=num(sol["julian_day"], 6),
                     zenith_deg=num(sol["zenith_deg"]), apparent_zenith_deg=num(sol["apparent_zenith_deg"]), cos_zenith=num(cza),
                     earth_sun_au=num(sol["earth_sun_au"]), toa_wm2=num(toa), clearness_before_cap=num(kt) if kt is not None else None,
                     ghi_used_wm2=num(ghi_used), fdir=num(fdir), u10_after_floor_ms=u10f, daytime=cza > 0.0,
                     stability_class=cls, wind_exponent=URBAN_EXP[cls - 1], u2_ms=num(u2_tf),
                     cos_zenith_sunlit_mean_info=num(czl), sunlit_fraction_info=num(flit)),
        outputs=dict(tg_c=num(tg), tnwb_c=num(tw), tpsy_c=num(tp), wbgt_c=num(w_api)),
        iterations=dict(tg=its.get("tg"), tnwb=its.get("tnwb"), tpsy=its.get("tpsy")),
        shade_variant=dict(note="same Ta/RH/P/u2, GHI=0 (OSHA 'shade' convention). Indoor formula is 0.7*Tnwb+0.3*Tg.",
                           tg_c=num(stg), tnwb_c=num(stw), wbgt_outdoor_formula_c=num(swb), wbgt_indoor_formula_c=num(0.7 * stw + 0.3 * stg)),
        bom_approximation_NOT_LILJEGREN=dict(e_hpa=num(e_bom), wbgt_c=num(bom), delta_vs_liljegren_c=num(bom - w_api)),
        original_c_pipeline_reference=dict(note="wbgt.c semantics: Larson solar, no KNMI 10 m floor, MAX_ITER=50, urban, dT<0",
                                           cos_zenith=num(orig["cos_zenith"]), fdir=num(orig["fdir"]), u2_ms=num(orig["u2"]),
                                           wbgt_c=num(orig["wbgt_c"]), status=orig["status"],
                                           delta_vs_primary_c=num(orig["wbgt_c"] - w_api) if orig["wbgt_c"] is not None else None),
        sensitivity_fdir_openmeteo=alt,
        checks=dict(api_vs_components_c=abs(w_api - wb), c_transliteration_max_abs_c=max(abs(tg - rtg), abs(tw - rtw), abs(tp - rtp)),
                    u2_tf_vs_ref_ms=abs(u2_tf - u2_ref)))
    return rec


def build_formula_cases():
    out = []
    for tnwb, tg, ta in ((25.0, 45.0, 35.0), (28.5, 52.3, 46.2), (30.0, 30.0, 30.0), (22.894, 28.983, 30.0), (27.0, 60.0, 40.0), (20.0, 25.0, 25.0)):
        out.append(dict(tnwb_c=tnwb, tg_c=tg, ta_c=ta, wbgt_outdoor_c=num(0.7 * tnwb + 0.2 * tg + 0.1 * ta),
                        wbgt_indoor_shade_c=num(0.7 * tnwb + 0.3 * tg)))
    return out


def build_bom_cases():
    out = []
    for ta, rh, note in ((29.4, 59.0, "BoM worked example (Brisbane January): 'a WBGT of about 30 degC'"),
                         (30.0, 55.0, "Lemke & Kjellstrom 2012 Fig.1 ABM line (~30.1)"),
                         (46.2, 13.0, ""), (35.0, 70.0, ""), (33.0, 60.0, ""), (25.0, 50.0, ""), (40.0, 60.0, ""), (18.0, 75.0, "")):
        w, e = bom_wbgt(ta, rh)
        out.append(dict(ta_c=ta, rh_pct=rh, e_hpa=num(e), wbgt_bom_c=num(w), note=note))
    return out


def grid_cross_check():
    import itertools
    Ta = [20, 30, 40, 46, 50]; RH = [5, 15, 40, 70, 95]; U = [0.13, 0.5, 1.0, 2.0, 5.0]
    S = [0, 200, 500, 800, 1000]; FD = [0.0, 0.5, 0.9]; CZ = [0.1, 0.4, 0.7, 1.0]; P = 1000.0
    cases = np.array(list(itertools.product(Ta, RH, U, S, FD, CZ)), dtype=float)
    tk = cases[:, 0] + 273.15; pp = np.full(len(cases), P)
    tg = TL.solve_globe(tk, cases[:, 1] / 100, pp, cases[:, 2], cases[:, 3], cases[:, 4], cases[:, 5])
    tw = TL.solve_wetbulb(tk, cases[:, 1] / 100, pp, cases[:, 2], cases[:, 3], cases[:, 4], cases[:, 5], 1.0)
    phys = cases[:, 3] <= 0.85 * C["SOLAR_CONST"] * cases[:, 5] / 0.983 ** 2
    r64, r50, r32 = CRef(f64, 500), CRef(f64, 50), CRef(f32, 50)
    d64, it_g, it_w, n50, n50_phys, d32 = 0.0, [], [], 0, 0, []
    for i, (a, b, u, s, f, cz) in enumerate(cases):
        g = r64.tglobe(a + 273.15, b / 100, P, u, s, f, cz); w = r64.twb(a + 273.15, b / 100, P, u, s, f, cz, 1)
        it_g.append(r64.iters["tg"]); it_w.append(r64.iters["tnwb"])
        if g is not None and np.isfinite(tg[i]):
            d64 = max(d64, abs(g - tg[i]))
        if w is not None and np.isfinite(tw[i]):
            d64 = max(d64, abs(w - tw[i]))
        if r50.tglobe(a + 273.15, b / 100, P, u, s, f, cz) is None or r50.twb(a + 273.15, b / 100, P, u, s, f, cz, 1) is None:
            n50 += 1; n50_phys += int(phys[i])
        g32 = r32.tglobe(f32(a + 273.15), f32(b / 100), P, u, s, f, cz); w32 = r32.twb(f32(a + 273.15), f32(b / 100), P, u, s, f, cz, 1)
        if g32 is not None and w32 is not None and np.isfinite(tg[i]) and np.isfinite(tw[i]):
            d32.append(abs((0.2 * g32 + 0.7 * w32) - (0.2 * tg[i] + 0.7 * tw[i])))
    it_g, it_w = np.array(it_g), np.array(it_w)
    return dict(n_cases=len(cases), grid=dict(Ta_C=Ta, RH_pct=RH, u2_ms=U, GHI_Wm2=S, fdir=FD, cos_zenith=CZ, P_hPa=P),
                thermofeel_vs_c_f64_max_abs_degC=d64,
                thermofeel_nan_tg=int(np.isnan(tg).sum()), thermofeel_nan_tnwb=int(np.isnan(tw).sum()),
                n_physically_consistent=int(phys.sum()),
                iterations_tg_max_all=int(it_g.max()), iterations_tnwb_max_all=int(it_w.max()),
                iterations_tg_max_physical=int(it_g[phys].max()), iterations_tnwb_max_physical=int(it_w[phys].max()),
                iterations_tg_median=float(np.median(it_g)), iterations_tnwb_median=float(np.median(it_w)),
                original_c_maxiter50_nonconverged_all=n50, original_c_maxiter50_nonconverged_physical=n50_phys,
                float32_original_vs_thermofeel_wbgt_max_abs_degC=float(np.max(d32)),
                float32_original_vs_thermofeel_wbgt_p99_abs_degC=float(np.percentile(d32, 99)))


def lemke_check():
    res, alld = {}, []
    for fig in ("fig1", "fig2", "fig3", "fig4"):
        xs, ys = LEMKE[fig]
        preds = []
        for x in xs:
            if fig == "fig1":
                args = (30.0, 55.0, 1013.25, 1.0, float(x))
            elif fig == "fig2":
                args = (30.0, float(x), 1013.25, 1.0, 500.0)
            elif fig == "fig3":
                args = (30.0, 55.0, 1013.25, float(x), 500.0)
            else:
                args = (float(x), 55.0, 1013.25, 1.0, 500.0)
            ta, rh, p, u2, s = args
            preds.append(float(tf_components(ta, rh, p, u2, s, 0.8, 1.0)[3][0]))
        d = np.array(preds) - np.array(ys)
        mask = np.ones(len(xs), bool) if fig != "fig3" else np.array(xs) >= 0.13
        alld.extend(d[mask].tolist())
        res[fig] = dict(n=len(xs), x=xs, digitized_wbgt_c=ys, thermofeel_wbgt_c=[num(v, 3) for v in preds],
                        max_abs_diff_c=float(np.abs(d[mask]).max()), rms_diff_c=float(np.sqrt((d[mask] ** 2).mean())),
                        excluded_points="u2 < 0.13 m/s (below Liljegren MIN_SPEED)" if fig == "fig3" else None)
    s0 = float(tf_components(30.0, 55.0, 1013.25, 1.0, 0.0, 0.0, 1.0)[3][0])
    alld = np.array(alld)
    res["S0_geometry_free"] = dict(digitized_c=LEMKE["fig1"][1][0], thermofeel_c=num(s0, 4), diff_c=num(s0 - LEMKE["fig1"][1][0], 4))
    res["all_points_u_ge_0p13"] = dict(n=int(len(alld)), rms_c=float(np.sqrt((alld ** 2).mean())), max_abs_c=float(np.abs(alld).max()))
    res["assumptions"] = ("P = 1013.25 hPa; wind is the 2 m wind; solar-dependent points need geometry the paper does not state: "
                          "fdir = 0.8 and cos(zenith) = 1 assumed (fdir 0.8 = 'propDirect' of the Lemke VBA lineage, see HeatStress R "
                          "wbgt.Liljegren). The S = 0 point is geometry-free.")
    res["source"] = LEMKE["source"]; res["fixed_conditions"] = LEMKE["fixed_conditions"]
    return res


# ============================================================================
# 6. Main
# ============================================================================
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args(argv)
    print(f"thermofeel {tf.__version__} (expected {THERMOFEEL_EXPECTED}); numpy {np.__version__}; python {platform.python_version()}")
    if tf.__version__ != THERMOFEEL_EXPECTED:
        print("  WARNING: thermofeel version differs from the one the spec was written against")

    cref = CRef(f64, 500)
    print("Property functions ...")
    props = build_property_cases(cref)
    check("property functions thermofeel == C transliteration (rel)", max(p["max_rel_diff_vs_c_transliteration"] for p in props) < 1e-12)

    print("Core solver cases ...")
    core, dmax = build_core_cases(cref)
    check("core: thermofeel == C transliteration", dmax <= ACCEPT["thermofeel_vs_c_transliteration_degC"], f"(max {dmax:.2e} degC)")
    traces = build_traces(CRef(f64, 500))

    print("Wind cases ...")
    wind, wmax = build_wind_cases(cref)
    check("wind: thermofeel wind_speed_2m == C est_wind_speed (urban)", wmax <= ACCEPT["wind_tf_vs_c_ms"], f"(max {wmax:.2e} m/s)")

    print("Solar cases (NOAA vs pvlib SPA) ...")
    solar, sstats = build_solar_cases()
    if sstats:
        check("NOAA vs SPA zenith (sun up, 2025 hourly)", sstats["noaa_vs_spa_max_abs_zenith_deg"] <= ACCEPT["noaa_vs_spa_zenith_deg"],
              f"(max {sstats['noaa_vs_spa_max_abs_zenith_deg']:.4f} deg)")
        check("NOAA vs SPA cos(zenith)", sstats["noaa_vs_spa_max_abs_cos_zenith"] <= ACCEPT["noaa_vs_spa_cos_zenith"],
              f"(max {sstats['noaa_vs_spa_max_abs_cos_zenith']:.2e})")
    else:
        check("pvlib available for solar check", False)

    print("Full pipeline cases ...")
    cref_c50 = CRef(f64, 50)
    full = [run_full_case(c, cref_c50) for c in FULL]
    check("full: public API == 0.1Ta+0.2Tg+0.7Tnwb", max(r["checks"]["api_vs_components_c"] for r in full) <= ACCEPT["api_vs_components_degC"])
    check("full: thermofeel == C transliteration", max(r["checks"]["c_transliteration_max_abs_c"] for r in full) <= ACCEPT["thermofeel_vs_c_transliteration_degC"])
    check("full: thermofeel u2 == reference u2", max(r["checks"]["u2_tf_vs_ref_ms"] for r in full) <= 1e-12)

    print("Grid cross-check (7500 cases) ...")
    grid = grid_cross_check()
    check("grid: thermofeel == C transliteration (float64)", grid["thermofeel_vs_c_f64_max_abs_degC"] <= ACCEPT["thermofeel_vs_c_transliteration_degC"],
          f"(max {grid['thermofeel_vs_c_f64_max_abs_degC']:.2e} degC)")

    print("Published-value sanity checks ...")
    lem = lemke_check()
    check("Lemke 2012 Fig.1 S=0 (geometry-free)", abs(lem["S0_geometry_free"]["diff_c"]) <= ACCEPT["lemke_S0_point_degC"], f"(diff {lem['S0_geometry_free']['diff_c']:+.3f} degC)")
    check("Lemke 2012 Figs 1-4 rms", lem["all_points_u_ge_0p13"]["rms_c"] <= ACCEPT["lemke_rms_degC"], f"(rms {lem['all_points_u_ge_0p13']['rms_c']:.3f} degC, n={lem['all_points_u_ge_0p13']['n']})")
    check("Lemke 2012 Figs 1-4 max", lem["all_points_u_ge_0p13"]["max_abs_c"] <= ACCEPT["lemke_max_degC"], f"(max {lem['all_points_u_ge_0p13']['max_abs_c']:.3f} degC)")
    bom_cases = build_bom_cases()
    bris = bom_cases[0]["wbgt_bom_c"]
    check("BoM worked example (Brisbane 29.4 C / 59 % -> ~30 C)", abs(bris - 30.0) <= ACCEPT["bom_brisbane_degC"], f"({bris:.2f} degC)")

    fixture = dict(
        meta=dict(
            title="Oracle vectors: Liljegren et al. (2008) outdoor WBGT (thermofeel 2.3.0 implementation)",
            generator="scripts/oracles/wbgt_liljegren_oracle.py", spec="docs/research/wbgt_liljegren.md",
            generated_utc=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            versions=dict(python=platform.python_version(), numpy=np.__version__, thermofeel=tf.__version__,
                          pvlib=__import__("pvlib").__version__ if sstats else None),
            units=dict(temperature="degC unless key ends _K", rh="percent", pressure="hPa", wind="m/s", irradiance="W/m2",
                       fdir="fraction of GHI that is direct beam", cos_zenith="dimensionless", time="UTC ISO-8601"),
            conventions=dict(
                wbgt_outdoor="0.7*Tnwb + 0.2*Tg + 0.1*Ta", wbgt_indoor_shade="0.7*Tnwb + 0.3*Tg",
                averaging="radiation is the mean over (t_end-60min, t_end]; solar geometry evaluated at t_end-30min",
                zenith="NOAA apparent (refraction-corrected) zenith, as wbgt.c adds refraction",
                fdir="Liljegren: S*=min(GHI/TOA,0.85); GHI_used=S*TOA; fdir=clamp(exp(3-1.34S*-1.65/S*),0,0.9); TOA=1367*cz/R^2, 0 if cz<0.00873",
                wind="u10'=max(u10,0.62); urban power law u2=max(u10'*(2/10)^p,0.13); p from Pasquill class (LSRDT)",
                rh_from_td="RH=100*esat(Td)/esat(Ta), Liljegren esat, clamped to [1,100]",
                nulls="null = not applicable or not converged"),
            tolerances=dict(exact_port_degC=1e-6, alternative_solver_degC=0.03, cos_zenith_vs_noaa_port=1e-9,
                            cos_zenith_vs_spa=5e-4, wind_ms=1e-9),
            acceptance=ACCEPT, failures=FAILS),
        constants=build_constants(),
        property_functions=props,
        core_cases=core,
        iteration_traces=traces,
        wind_cases=wind,
        fdir_cases=build_fdir_cases(),
        solar_cases=solar,
        full_cases=full,
        formula_cases=build_formula_cases(),
        bom_approximation_cases_NOT_LILJEGREN=bom_cases,
        sanity_checks=dict(c_transliteration_grid=grid, solar_vs_spa=sstats, lemke_kjellstrom_2012=lem),
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fixture, indent=1, allow_nan=False) + "\n", encoding="utf-8")
    print(f"Wrote {out} ({out.stat().st_size / 1024:.1f} KiB): {len(core)} core, {len(full)} full, {len(wind)} wind, "
          f"{len(solar)} solar, {len(props)} property cases")
    print("RESULT:", "PASS" if not FAILS else f"FAIL ({len(FAILS)})")
    return 0 if not FAILS else 1


if __name__ == "__main__":
    sys.exit(main())
