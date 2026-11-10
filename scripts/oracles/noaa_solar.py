"""NOAA Solar Calculator algorithm (NOAA GML spreadsheet NOAA_Solar_Calculations,
equations after Meeus, Astronomical Algorithms). Scalar, port-ready.
Input: UTC instant as Julian Day (or unix seconds), latitude (deg, N+), longitude (deg, E+).
"""
import math

D2R = math.pi / 180.0
R2D = 180.0 / math.pi


def julian_day_from_unix(unix_s):
    return unix_s / 86400.0 + 2440587.5


def noaa_solar_position(jd, lat_deg, lon_deg):
    """Returns dict with zenith_deg (geometric), elevation_deg, refraction_deg,
    apparent_elevation_deg, apparent_zenith_deg, declination_deg, eot_min,
    hour_angle_deg, earth_sun_distance_au."""
    T = (jd - 2451545.0) / 36525.0                                    # Julian century
    L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360.0      # geom mean long sun
    M = 357.52911 + T * (35999.05029 - 0.0001537 * T)                 # geom mean anom sun
    e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T)            # eccentricity
    C = (math.sin(D2R * M) * (1.914602 - T * (0.004817 + 0.000014 * T))
         + math.sin(D2R * 2 * M) * (0.019993 - 0.000101 * T)
         + math.sin(D2R * 3 * M) * 0.000289)                          # equation of centre
    true_long = L0 + C
    true_anom = M + C
    R = (1.000001018 * (1 - e * e)) / (1 + e * math.cos(D2R * true_anom))   # AU
    omega = 125.04 - 1934.136 * T
    app_long = true_long - 0.00569 - 0.00478 * math.sin(D2R * omega)
    eps0 = 23.0 + (26.0 + ((21.448 - T * (46.815 + T * (0.00059 - T * 0.001813)))) / 60.0) / 60.0
    eps = eps0 + 0.00256 * math.cos(D2R * omega)                      # obliquity corrected
    decl = R2D * math.asin(math.sin(D2R * eps) * math.sin(D2R * app_long))
    y = math.tan(D2R * eps / 2.0) ** 2
    eot = 4.0 * R2D * (y * math.sin(2 * D2R * L0) - 2 * e * math.sin(D2R * M)
                       + 4 * e * y * math.sin(D2R * M) * math.cos(2 * D2R * L0)
                       - 0.5 * y * y * math.sin(4 * D2R * L0)
                       - 1.25 * e * e * math.sin(2 * D2R * M))        # minutes
    # true solar time [min] from UTC minutes of day
    frac_day = (jd + 0.5) % 1.0
    tst = (frac_day * 1440.0 + eot + 4.0 * lon_deg) % 1440.0
    ha = tst / 4.0 + 180.0 if tst / 4.0 < 0 else tst / 4.0 - 180.0
    cosz = (math.sin(D2R * lat_deg) * math.sin(D2R * decl)
            + math.cos(D2R * lat_deg) * math.cos(D2R * decl) * math.cos(D2R * ha))
    cosz = max(-1.0, min(1.0, cosz))
    zen = R2D * math.acos(cosz)
    elev = 90.0 - zen
    # NOAA approximate atmospheric refraction [deg]
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
    app_elev = elev + refr
    return dict(zenith_deg=zen, elevation_deg=elev, refraction_deg=refr,
                apparent_elevation_deg=app_elev, apparent_zenith_deg=90.0 - app_elev,
                cos_zenith=cosz, cos_apparent_zenith=math.cos(D2R * (90.0 - app_elev)),
                declination_deg=decl, eot_min=eot, hour_angle_deg=ha, earth_sun_distance_au=R)
