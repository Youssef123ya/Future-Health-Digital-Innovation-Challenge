"""Independent line-by-line Python transliteration of Liljegren's wbgt.c (Argonne,
WBGT v1.1, 2008; file wbgt.c.original in github.com/mdljts/wbgt), written for
cross-checking thermofeel. Not a copy of thermofeel.

`rnd` emulates C `float` storage: every assignment to a variable declared
`float` in the C source (and every float parameter/return) passes through rnd.
Use rnd=f64 (identity) for double precision, rnd=f32 for the original's floats.
"""
import math
import numpy as np


def f64(x):
    return float(x)


def f32(x):
    return float(np.float32(x))


PI = 3.1415926535897932
TWOPI = 6.2831853071795864
DEG_RAD = 0.017453292519943295
RAD_DEG = 57.295779513082323
SOLAR_CONST = 1367.0
STEFANB = 5.6696e-8
Cp = 1003.5
M_AIR = 28.97
M_H2O = 18.015
RATIO = Cp * M_AIR / M_H2O
R_GAS = 8314.34
R_AIR = R_GAS / M_AIR
Pr = Cp / (Cp + 1.25 * R_AIR)
EMIS_WICK, ALB_WICK, D_WICK, L_WICK = 0.95, 0.4, 0.007, 0.0254
EMIS_GLOBE, ALB_GLOBE, D_GLOBE = 0.95, 0.05, 0.0508
EMIS_SFC, ALB_SFC = 0.999, 0.45
CZA_MIN = 0.00873
NORMSOLAR_MAX = 0.85
REF_HEIGHT = 2.0
MIN_SPEED = 0.13
CONVERGENCE = 0.02


class Lilj:
    def __init__(self, rnd=f64, max_iter=50):
        self.r = rnd
        self.max_iter = max_iter
        r = rnd
        # `static float` constants inside functions are stored as float in C
        self.s_sigma, self.s_epsk = r(3.617), r(97.0)
        self.s_a, self.s_b, self.s_c = r(0.56), r(0.281), r(0.4)
        self.s_pca, self.s_pcw, self.s_tca, self.s_tcw = r(36.4), r(218.0), r(132.0), r(647.3)
        self.s_da, self.s_db = r(3.640e-4), r(2.334)
        self.last_iter = {}

    # ---- thermophysical properties -------------------------------------
    def esat(self, tk, phase=0):
        r = self.r; tk = r(tk)
        if phase == 0:
            y = r((tk - 273.15) / (tk - 32.18))
            es = r(6.1121 * math.exp(17.502 * y))
        else:
            y = r((tk - 273.15) / (tk - 0.6))
            es = r(6.1115 * math.exp(22.452 * y))
        es = r(1.004 * es)
        return es

    def dew_point(self, e, phase=0):
        r = self.r; e = r(e)
        if phase == 0:
            z = r(math.log(e / (6.1121 * 1.004)))
            tdk = r(273.15 + 240.97 * z / (17.502 - z))
        else:
            z = r(math.log(e / (6.1115 * 1.004)))
            tdk = r(273.15 + 272.55 * z / (22.452 - z))
        return tdk

    def viscosity(self, T):
        r = self.r; T = r(T)
        Tr = r(T / self.s_epsk)
        omega = r((Tr - 2.9) / 0.4 * (-0.034) + 1.048)
        return r(2.6693e-6 * math.sqrt(M_AIR * T) / (self.s_sigma * self.s_sigma * omega))

    def thermal_cond(self, T):
        return self.r((Cp + 1.25 * R_AIR) * self.viscosity(T))

    def diffusivity(self, T, P):
        r = self.r; T = r(T); P = r(P)
        Pcrit13 = r(math.pow(self.s_pca * self.s_pcw, 1.0 / 3.0))
        Tcrit512 = r(math.pow(self.s_tca * self.s_tcw, 5.0 / 12.0))
        Tcrit12 = r(math.sqrt(self.s_tca * self.s_tcw))
        Mmix = r(math.sqrt(1.0 / M_AIR + 1.0 / M_H2O))
        Patm = r(P / 1013.25)
        return r(self.s_da * math.pow(T / Tcrit12, self.s_db) * Pcrit13 * Tcrit512 * Mmix / Patm * 1e-4)

    def evap(self, T):
        T = self.r(T)
        return self.r((313.15 - T) / 30.0 * (-71100.0) + 2.4073e6)

    def emis_atm(self, T, rh):
        r = self.r; T = r(T); rh = r(rh)
        e = r(rh * self.esat(T, 0))
        return r(0.575 * math.pow(e, 0.143))

    # ---- convective coefficients -----------------------------------------
    def h_sphere_in_air(self, D, T, P, speed):
        r = self.r; D, T, P, speed = r(D), r(T), r(P), r(speed)
        density = r(P * 100.0 / (R_AIR * T))
        Re = r(max(speed, MIN_SPEED) * density * D / self.viscosity(T))
        Nu = r(2.0 + 0.6 * math.sqrt(Re) * math.pow(Pr, 0.3333))
        return r(Nu * self.thermal_cond(T) / D)

    def h_cylinder_in_air(self, D, L, T, P, speed):
        r = self.r; D, L, T, P, speed = r(D), r(L), r(T), r(P), r(speed)
        density = r(P * 100.0 / (R_AIR * T))
        Re = r(max(speed, MIN_SPEED) * density * D / self.viscosity(T))
        Nu = r(self.s_b * math.pow(Re, 1.0 - self.s_c) * math.pow(Pr, 1.0 - self.s_a))
        return r(Nu * self.thermal_cond(T) / D)

    # ---- sensor energy balances ------------------------------------------
    def Tglobe(self, Tair, rh, Pair, speed, solar, fdir, cza):
        """Tair in K; returns degC or -9999 (no convergence)."""
        r = self.r
        Tair, rh, Pair, speed, solar, fdir, cza = map(r, (Tair, rh, Pair, speed, solar, fdir, cza))
        Tsfc = Tair
        Tglobe_prev = Tair
        converged = False
        it = 0
        Tglobe_new = float("nan")
        while True:
            it += 1
            Tref = r(0.5 * (Tglobe_prev + Tair))
            h = self.h_sphere_in_air(D_GLOBE, Tref, Pair, speed)
            beam = fdir * (1.0 / (2.0 * cza) - 1.0) if fdir != 0.0 else 0.0  # guard 0*inf (not in C)
            arg = (0.5 * (self.emis_atm(Tair, rh) * Tair ** 4 + EMIS_SFC * Tsfc ** 4)
                   - h / (STEFANB * EMIS_GLOBE) * (Tglobe_prev - Tair)
                   + solar / (2.0 * STEFANB * EMIS_GLOBE) * (1.0 - ALB_GLOBE) * (beam + 1.0 + ALB_SFC))
            Tglobe_new = r(arg ** 0.25) if arg >= 0 else float("nan")
            if abs(Tglobe_new - Tglobe_prev) < CONVERGENCE:
                converged = True
            Tglobe_prev = r(0.9 * Tglobe_prev + 0.1 * Tglobe_new)
            if converged or it >= self.max_iter:
                break
        self.last_iter["Tg"] = it
        return r(Tglobe_new - 273.15) if converged else -9999.0

    def Twb(self, Tair, rh, Pair, speed, solar, fdir, cza, rad):
        r = self.r
        Tair, rh, Pair, speed, solar, fdir, cza = map(r, (Tair, rh, Pair, speed, solar, fdir, cza))
        a = self.s_a
        Tsfc = Tair
        sza = r(math.acos(max(-1.0, min(1.0, cza))))
        eair = r(rh * self.esat(Tair, 0))
        Tdew = self.dew_point(eair, 0)
        Twb_prev = Tdew
        converged = False
        it = 0
        Twb_new = float("nan")
        while True:
            it += 1
            Tref = r(0.5 * (Twb_prev + Tair))
            h = self.h_cylinder_in_air(D_WICK, L_WICK, Tref, Pair, speed)
            dterm = fdir * ((math.tan(sza) / PI) + 0.25 * D_WICK / L_WICK) if fdir != 0.0 else 0.0
            Fatm = r(STEFANB * EMIS_WICK * (0.5 * (self.emis_atm(Tair, rh) * Tair ** 4 + EMIS_SFC * Tsfc ** 4) - Twb_prev ** 4)
                     + (1.0 - ALB_WICK) * solar * ((1.0 - fdir) * (1.0 + 0.25 * D_WICK / L_WICK) + dterm + ALB_SFC))
            ewick = self.esat(Twb_prev, 0)
            density = r(Pair * 100.0 / (R_AIR * Tref))
            Sc = r(self.viscosity(Tref) / (density * self.diffusivity(Tref, Pair)))
            Twb_new = r(Tair - self.evap(Tref) / RATIO * (ewick - eair) / (Pair - ewick) * math.pow(Pr / Sc, a)
                        + (Fatm / h * rad))
            if abs(Twb_new - Twb_prev) < CONVERGENCE:
                converged = True
            Twb_prev = r(0.9 * Twb_prev + 0.1 * Twb_new)
            if converged or it >= self.max_iter:
                break
        self.last_iter["Tnwb" if rad else "Tpsy"] = it
        return r(Twb_new - 273.15) if converged else -9999.0

    # ---- wind ------------------------------------------------------------
    @staticmethod
    def stab_srdt(daytime, speed, solar, dT):
        lsrdt = [[1, 1, 2, 4, 0, 5, 6, 0], [1, 2, 3, 4, 0, 5, 6, 0], [2, 2, 3, 4, 0, 4, 4, 0],
                 [3, 3, 4, 4, 0, 0, 0, 0], [3, 4, 4, 4, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]]
        if daytime:
            j = 0 if solar >= 925.0 else 1 if solar >= 675.0 else 2 if solar >= 175.0 else 3
            i = 4 if speed >= 6.0 else 3 if speed >= 5.0 else 2 if speed >= 3.0 else 1 if speed >= 2.0 else 0
        else:
            j = 6 if dT >= 0.0 else 5
            i = 2 if speed >= 2.5 else 1 if speed >= 2.0 else 0
        return lsrdt[i][j]

    def est_wind_speed(self, speed, zspeed, stability_class, urban):
        r = self.r
        urban_exp = [0.15, 0.15, 0.20, 0.25, 0.30, 0.30]
        rural_exp = [0.07, 0.07, 0.10, 0.15, 0.35, 0.55]
        exponent = r(urban_exp[stability_class - 1] if urban else rural_exp[stability_class - 1])
        est = r(r(speed) * math.pow(REF_HEIGHT / r(zspeed), exponent))
        return r(max(est, MIN_SPEED))

    # ---- solar -----------------------------------------------------------
    def calc_solar_parameters(self, year, month, day, lat, lon, solar):
        r = self.r
        ra, dec, elev, refr, azim, soldist = solarposition(year, month, day, 0.0, float(r(lat)), float(r(lon)))
        cza = r(math.cos((90.0 - elev) * DEG_RAD))
        toasolar = r(SOLAR_CONST * max(0.0, cza) / (soldist * soldist))
        if cza < CZA_MIN:
            toasolar = 0.0
        fdir = 0.0
        if toasolar > 0.0:
            normsolar = r(min(solar / toasolar, NORMSOLAR_MAX))
            solar = r(normsolar * toasolar)
            if normsolar > 0.0:
                fdir = r(math.exp(3.0 - 1.34 * normsolar - 1.65 / normsolar))
                fdir = r(max(min(fdir, 0.9), 0.0))
            else:
                fdir = 0.0
        return r(solar), cza, fdir, elev

    def calc_wbgt(self, year, month, day, hour, minute, gmt, avg, lat, lon,
                  solar, pres, Tair, relhum, speed, zspeed, dT, urban):
        r = self.r
        hour_gmt = hour - gmt + (minute - 0.5 * avg) / 60.0
        dday = day + hour_gmt / 24.0
        solar, cza, fdir, elev = self.calc_solar_parameters(year, month, dday, lat, lon, solar)
        est_speed = None
        if zspeed != REF_HEIGHT:
            daytime = cza > 0.0
            sc = self.stab_srdt(daytime, speed, solar, dT)
            est_speed = self.est_wind_speed(speed, zspeed, sc, urban)
            speed = est_speed
        tk = r(Tair + 273.15)
        rh = r(0.01 * relhum)
        Tg = self.Tglobe(tk, rh, pres, speed, solar, fdir, cza)
        Tnwb = self.Twb(tk, rh, pres, speed, solar, fdir, cza, 1)
        Tpsy = self.Twb(tk, rh, pres, speed, solar, fdir, cza, 0)
        Twbg = r(0.1 * Tair + 0.2 * Tg + 0.7 * Tnwb)
        status = 0
        if Tg == -9999 or Tnwb == -9999:
            Twbg, status = -9999.0, -1
        return dict(status=status, cza=cza, fdir=fdir, solar_adj=solar, est_speed=est_speed,
                    Tg=Tg, Tnwb=Tnwb, Tpsy=Tpsy, Twbg=Twbg, elev_refr=elev)


# ---- Larson (PNNL, 1992) solar position as embedded in wbgt.c -------------
def daynum(year, month, day):
    begmonth = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
    leapyr = 1 if ((year % 4 == 0 and year % 100 != 0) or year % 400 == 0) else 0
    dnum = begmonth[month] + day
    if leapyr and month > 2:
        dnum += 1
    return dnum


def _c_int_div(a, b):
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


def solarposition(year, month, day, days_1900, latitude, longitude):
    """Returns (ap_ra [h], ap_dec [deg], altitude incl. refraction [deg], refraction [deg],
    azimuth [deg], distance [AU]). Date given by (year, month, day.frac) with
    month=0 meaning day = day-of-year.frac (UT)."""
    if month != 0:
        daynumber = daynum(year, month, int(day))
    else:
        daynumber = int(day)
    delta_years = year - 2000
    delta_days = delta_years * 365 + _c_int_div(delta_years, 4) + daynumber
    if year > 2000:
        delta_days += 1
    days_J2000 = delta_days - 1.5
    cent_J2000 = days_J2000 / 36525.0
    ut = math.modf(day)[0]
    days_J2000 += ut
    ut *= 24.0

    mean_anomaly = 357.528 + 0.9856003 * days_J2000
    mean_longitude = 280.460 + 0.9856474 * days_J2000
    mean_anomaly = math.modf(mean_anomaly / 360.0)[0] * TWOPI
    mean_longitude = math.modf(mean_longitude / 360.0)[0] * TWOPI
    mean_obliquity = (23.439 - 4.0e-7 * days_J2000) * DEG_RAD
    ecliptic_long = ((1.915 * math.sin(mean_anomaly)) + (0.020 * math.sin(2.0 * mean_anomaly))) * DEG_RAD + mean_longitude
    distance = 1.00014 - 0.01671 * math.cos(mean_anomaly) - 0.00014 * math.cos(2.0 * mean_anomaly)
    ap_ra = math.atan2(math.cos(mean_obliquity) * math.sin(ecliptic_long), math.cos(ecliptic_long))
    if ap_ra < 0.0:
        ap_ra += TWOPI
    ap_ra = math.modf(ap_ra / TWOPI)[0] * 24.0
    ap_dec = math.asin(math.sin(mean_obliquity) * math.sin(ecliptic_long))
    gmst0h = 24110.54841 + cent_J2000 * (8640184.812866 + cent_J2000 * (0.093104 - cent_J2000 * 6.2e-6))
    gmst0h = math.modf(gmst0h / 3600.0 / 24.0)[0] * 24.0
    if gmst0h < 0.0:
        gmst0h += 24.0
    lmst = gmst0h + (ut * 1.00273790934) + longitude / 15.0
    lmst = math.modf(lmst / 24.0)[0] * 24.0
    if lmst < 0.0:
        lmst += 24.0
    local_ha = lmst - ap_ra
    if local_ha < -12.0:
        local_ha += 24.0
    elif local_ha > 12.0:
        local_ha -= 24.0
    lat = latitude * DEG_RAD
    local_ha = local_ha / 24.0 * TWOPI
    cos_apdec, sin_apdec = math.cos(ap_dec), math.sin(ap_dec)
    cos_lat, sin_lat = math.cos(lat), math.sin(lat)
    cos_lha = math.cos(local_ha)
    altitude = math.asin(sin_apdec * sin_lat + cos_apdec * cos_lha * cos_lat)
    cos_alt = math.cos(altitude)
    tan_alt = math.tan(altitude) if abs(altitude) < 1.57079615 else 6.0e6
    cos_az = (sin_apdec * cos_lat - cos_apdec * cos_lha * sin_lat) / cos_alt
    sin_az = -(cos_apdec * math.sin(local_ha) / cos_alt)
    azimuth = math.acos(max(-1.0, min(1.0, cos_az)))
    if math.atan2(sin_az, cos_az) < 0.0:
        azimuth = TWOPI - azimuth
    ap_dec *= RAD_DEG
    altitude *= RAD_DEG
    azimuth *= RAD_DEG
    pressure, temp = 1013.25, 15.0
    if altitude < -1.0 or tan_alt == 6.0e6:
        refraction = 0.0
    elif altitude < 19.225:
        refraction = (0.1594 + altitude * (0.0196 + 0.00002 * altitude)) * pressure
        refraction /= (1.0 + altitude * (0.505 + 0.0845 * altitude)) * (273.0 + temp)
    else:
        refraction = 0.00452 * (pressure / (273.0 + temp)) / tan_alt
    altitude = altitude + refraction
    return ap_ra, ap_dec, altitude, refraction, azimuth, distance
