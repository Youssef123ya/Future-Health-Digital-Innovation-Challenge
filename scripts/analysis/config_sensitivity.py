"""Sensitivity of the hours-in-zone preview to radiation pre-processing.
A = backtest_preview.py config: instant SSRD (Open-Meteo factor), instant cos z, fdir = DIR/GHI.
B = docs/research/wbgt_liljegren.md D5/D6 config: hour-mean GHI with cos z at t-30 min, Liljegren fdir from S* = min(GHI/TOA, 0.85),
    GHI_used = S*·TOA, TOA = 1367·cza/R^2 (0 if cza < 0.00873). Same thermofeel Liljegren solver and wind scaling.
Usage: python -I config_sensitivity.py <project_root>"""
import json, sys
from pathlib import Path
import numpy as np, pandas as pd, pvlib, thermofeel as tf
sys.path.insert(0, str(Path(__file__).parent))
from backtest_preview import wbgt_from_cols, arr  # config A
W = Path(sys.argv[1]) / "public/data/weather"

def wbgt_B(cols, epoch, lat, lon):
    T, RH, PS, U, G = (arr(cols[k]) for k in ("temperature_2m", "relative_humidity_2m", "surface_pressure", "wind_speed_10m", "shortwave_radiation"))
    tm = pd.to_datetime(epoch - 1800, unit="s", utc=True)
    sp = pvlib.solarposition.get_solarposition(tm, lat, lon)
    cza = np.cos(np.radians(sp["zenith"].to_numpy()))
    R = pvlib.solarposition.nrel_earthsun_distance(tm).to_numpy()
    toa = np.where(cza >= 0.00873, 1367.0 * np.clip(cza, 0, None) / R**2, 0.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        s = np.where(toa > 0, np.minimum(G / np.where(toa > 0, toa, 1), 0.85), 0.0)
        fdir = np.where(s > 0, np.clip(np.exp(3 - 1.34 * s - 1.65 / np.where(s > 0, s, 1)), 0, 0.9), 0.0)
    g_used = np.where(toa > 0, s * toa, G)
    return tf.calculate_wbgt_liljegren(T + 273.15, RH, PS, U, g_used, fdir, np.clip(cza, 0, None)) - 273.15

def main():
    rows = []
    for site in ("musaffah", "kezad", "ruwais", "alain", "saadiyat"):
        for model in ("ecmwf_ifs", "era5"):
            hA = hB = 0; dif = []
            for year in range(2020, 2026):
                doc = json.loads((W / "archive" / f"{site}_{year}.json").read_text(encoding="utf-8"))
                ep = doc["time"]["t0_unix"] + 3600 * np.arange(doc["time"]["n"])
                b = doc["models"][model]
                a = wbgt_from_cols(b["columns"], ep, b["grid"]["lat"], b["grid"]["lon"])
                bb = wbgt_B(b["columns"], ep, b["grid"]["lat"], b["grid"]["lon"])
                hA += int((a >= 30).sum()); hB += int((bb >= 30).sum()); dif.append(bb - a)
            d = np.concatenate(dif); day = np.abs(d) > 0
            rows.append((site, model, hA / 6, hB / 6, float(np.nanmean(d)), float(np.nanpercentile(np.abs(d), 95)), float(np.nanmax(np.abs(d))), int(np.isnan(d).sum())))
    print("site      model      h>=30 A    h>=30 B   mean(B-A)  p95|B-A|  max|B-A|  nan")
    for r in rows:
        print(f"{r[0]:9s} {r[1]:9s} {r[2]:8.0f} {r[3]:9.0f} {r[4]:+10.3f} {r[5]:9.3f} {r[6]:9.3f} {r[7]:4d}")


if __name__ == "__main__":
    main()
