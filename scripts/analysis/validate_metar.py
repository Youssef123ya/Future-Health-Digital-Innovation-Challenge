"""Zill — reanalysis/analysis vs METAR validation, summer 2025 (Jun 1 - Sep 30, Asia/Dubai local).

Usage (run isolated, data paths as arguments):
  python -I validate_metar.py <project_root> [--json out.json]

Reads:
  <root>/public/data/obs/<ICAO>_2025_summer.json          (scripts/data/fetch-obs.mjs)
  <root>/public/data/weather/validation/<point>_2025.json  (scripts/data/fetch-weather.mjs --only=validation)

Matching: routine METARs at HH:00 UTC  <->  model hourly value at the same UTC instant
(model local time minus 4 h). Model T/Td/RH/wind are instantaneous at the timestamp.
Error = model - observation. METAR T/Td are integer degC (quantisation sd = 1/sqrt(12) = 0.289 degC).
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(sys.argv[1])
OUT_JSON = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None

PAIRS = [("omaa", "OMAA"), ("omad", "OMAD"), ("omal", "OMAL")]
KT = 0.514444


def load(p):
    return json.loads(Path(p).read_text(encoding="utf-8"))


def iso_utc_to_epoch(s):
    # "2025-06-01T00:00Z"
    import datetime as dt
    return int(dt.datetime.strptime(s, "%Y-%m-%dT%H:%MZ").replace(tzinfo=dt.timezone.utc).timestamp())


def stats(e, m=None, o=None):
    e = np.asarray(e, float)
    ok = np.isfinite(e)
    e = e[ok]
    if e.size == 0:
        return None
    out = {
        "n": int(e.size),
        "bias": round(float(e.mean()), 3),
        "rmse": round(float(np.sqrt((e ** 2).mean())), 3),
        "mae": round(float(np.abs(e).mean()), 3),
        "sd_err": round(float(e.std(ddof=1)), 3),
    }
    if m is not None and o is not None:
        m = np.asarray(m, float)[ok]
        o = np.asarray(o, float)[ok]
        out["r"] = round(float(np.corrcoef(m, o)[0, 1]), 3)
        out["mean_model"] = round(float(m.mean()), 2)
        out["mean_obs"] = round(float(o.mean()), 2)
    return out


def rh_from_t_td(t, td):
    # Magnus (Alduchov & Eskridge 1996) — same constants Open-Meteo uses (17.625, 243.04)
    return 100 * np.exp(17.625 * td / (243.04 + td)) / np.exp(17.625 * t / (243.04 + t))


def main():
    results = {}
    for pid, icao in PAIRS:
        obs = load(ROOT / "public/data/obs" / f"{icao}_2025_summer.json")
        val = load(ROOT / "public/data/weather/validation" / f"{pid}_2025.json")
        c = obs["columns"]
        o_epoch = np.array([iso_utc_to_epoch(s) for s in c["valid_utc"]])
        on_hour = (o_epoch % 3600) == 0
        o_idx = {int(t): i for i, t in enumerate(o_epoch) if on_hour[i]}
        t0 = val["time"]["t0_unix"]
        n = val["time"]["n"]
        m_epoch = t0 + 3600 * np.arange(n)
        local_hour = ((m_epoch + 4 * 3600) // 3600) % 24
        month = np.array([int(np.datetime64(int(t + 4 * 3600), "s").astype("datetime64[M]").astype(int) % 12 + 1) for t in m_epoch])
        sel_m = np.array([int(t) in o_idx for t in m_epoch])
        oi = np.array([o_idx[int(t)] for t in m_epoch[sel_m]])

        def obs_col(k):
            return np.array([np.nan if v is None else v for v in c[k]], float)[oi]

        oT, oTd, oRH, oW, oQ = obs_col("temp_c"), obs_col("dewpoint_c"), obs_col("rh_pct"), obs_col("wind_speed_ms"), obs_col("qnh_hpa")
        hrs = local_hour[sel_m]
        mons = month[sel_m]
        res_p = {"icao": icao, "station": val["point"]["station"], "n_model_hours": int(n), "n_matched": int(sel_m.sum()), "variants": {}}
        for key, blk in val["models"].items():
            cols = blk["columns"]

            def mcol(k):
                return np.array([np.nan if v is None else v for v in cols[k]], float)[sel_m]

            mT, mTd, mRH, mW, mP = mcol("temperature_2m"), mcol("dew_point_2m"), mcol("relative_humidity_2m"), mcol("wind_speed_10m"), mcol("pressure_msl")
            day = (hrs >= 7) & (hrs <= 18)
            peak = (hrs >= 10) & (hrs <= 16)
            v = {
                "grid": blk["grid"],
                "T": stats(mT - oT, mT, oT),
                "Td": stats(mTd - oTd, mTd, oTd),
                "RH": stats(mRH - oRH, mRH, oRH),
                "wind10": stats(mW - oW, mW, oW),
                "mslp_vs_qnh": stats(mP - oQ, mP, oQ),
                "T_day_07_18": stats((mT - oT)[day]),
                "T_night": stats((mT - oT)[~day]),
                "Td_day_07_18": stats((mTd - oTd)[day]),
                "Td_night": stats((mTd - oTd)[~day]),
                "T_peak_10_16": stats((mT - oT)[peak]),
                "Td_peak_10_16": stats((mTd - oTd)[peak]),
                "T_bias_by_local_hour": [round(float(np.nanmean((mT - oT)[hrs == h])), 2) for h in range(24)],
                "Td_bias_by_local_hour": [round(float(np.nanmean((mTd - oTd)[hrs == h])), 2) for h in range(24)],
                "T_by_month": {int(mo): stats((mT - oT)[mons == mo]) for mo in (6, 7, 8, 9)},
                "Td_by_month": {int(mo): stats((mTd - oTd)[mons == mo]) for mo in (6, 7, 8, 9)},
                "Tmax_obs_vs_model": [float(np.nanmax(oT)), float(np.nanmax(mT))],
                "Td_p95_obs_vs_model": [float(np.nanpercentile(oTd, 95)), float(np.nanpercentile(mTd, 95))],
            }
            if np.isfinite(mT).sum() == 0:
                v = {"grid": blk["grid"], "note": "no data"}
            res_p["variants"][key] = v
        results[pid] = res_p

    # ---- WBGT error propagation at OMAA: model-only vs (obs T, Td, wind + model radiation/pressure)
    try:
        import thermofeel as tf
        import pvlib
        import pandas as pd

        out_w = {}
        for pid, icao in PAIRS:
            obs = load(ROOT / "public/data/obs" / f"{icao}_2025_summer.json")
            val = load(ROOT / "public/data/weather/validation" / f"{pid}_2025.json")
            c = obs["columns"]
            o_epoch = np.array([iso_utc_to_epoch(s) for s in c["valid_utc"]])
            o_idx = {int(t): i for i, t in enumerate(o_epoch) if t % 3600 == 0}
            t0, n = val["time"]["t0_unix"], val["time"]["n"]
            m_epoch = t0 + 3600 * np.arange(n)
            sel = np.array([int(t) in o_idx for t in m_epoch])
            oi = np.array([o_idx[int(t)] for t in m_epoch[sel]])
            lat, lon = val["point"]["lat"], val["point"]["lon"]
            # INSTANT cos(zenith) at the timestamp and Open-Meteo-style backward->instant factor
            # (mean of max(cos z,0) over the preceding hour from 12 x 5-min midpoints), same as backtest_preview.py
            ep = m_epoch[sel]
            sp = pvlib.solarposition.get_solarposition(pd.to_datetime(ep, unit="s", utc=True), lat, lon)
            cosz = np.clip(np.cos(np.radians(sp["zenith"].to_numpy())), 0, None)
            acc = np.zeros(len(ep))
            for k in range(12):
                spk = pvlib.solarposition.get_solarposition(pd.to_datetime(ep - 3600 + 150 + 300 * k, unit="s", utc=True), lat, lon)
                acc += np.clip(np.cos(np.radians(spk["zenith"].to_numpy())), 0, None)
            czm = acc / 12
            inst_factor = np.where((czm > 0) & (cosz > 0), cosz / np.where(czm > 0, czm, 1), 0.0)
            res_w = {}
            for key in ("era5@nearest", "ecmwf_ifs@nearest"):
                cols = val["models"][key]["columns"]

                def mcol(k):
                    return np.array([np.nan if v is None else v for v in cols[k]], float)[sel]

                ghi_b, dirh = mcol("shortwave_radiation"), mcol("direct_radiation")
                fdir = np.where(ghi_b > 0, np.clip(dirh / np.where(ghi_b > 0, ghi_b, 1), 0, 1), 0)
                ghi = ghi_b * inst_factor  # instantaneous SSRD at the timestamp
                ps = mcol("surface_pressure")
                mT, mRH, mW = mcol("temperature_2m"), mcol("relative_humidity_2m"), mcol("wind_speed_10m")
                oT = np.array([np.nan if v is None else v for v in c["temp_c"]], float)[oi]
                oTd = np.array([np.nan if v is None else v for v in c["dewpoint_c"]], float)[oi]
                oW = np.array([np.nan if v is None else v for v in c["wind_speed_ms"]], float)[oi]
                oRH = rh_from_t_td(oT, oTd)
                w_model = tf.calculate_wbgt_liljegren(mT + 273.15, mRH, ps, mW, ghi, fdir, cosz) - 273.15
                w_obsmet = tf.calculate_wbgt_liljegren(oT + 273.15, oRH, ps, oW, ghi, fdir, cosz) - 273.15
                w_obsTTd_modelwind = tf.calculate_wbgt_liljegren(oT + 273.15, oRH, ps, mW, ghi, fdir, cosz) - 273.15
                e = w_model - w_obsmet
                hrs = (((m_epoch[sel] + 4 * 3600) // 3600) % 24)
                day = (hrs >= 7) & (hrs <= 18)
                res_w[key] = {
                    "wbgt_model_minus_obsmet_all": stats(e, w_model, w_obsmet),
                    "wbgt_model_minus_obsmet_day_07_18": stats(e[day]),
                    "wbgt_due_to_T_Td_only_all": stats(w_model - w_obsTTd_modelwind),
                    "wbgt_obsmet_p50_p95_max": [round(float(np.nanpercentile(w_obsmet, 50)), 2), round(float(np.nanpercentile(w_obsmet, 95)), 2), round(float(np.nanmax(w_obsmet)), 2)],
                    "wbgt_model_p50_p95_max": [round(float(np.nanpercentile(w_model, 50)), 2), round(float(np.nanpercentile(w_model, 95)), 2), round(float(np.nanmax(w_model)), 2)],
                    "nan_count_model_obsmet": [int(np.isnan(w_model).sum()), int(np.isnan(w_obsmet).sum())],
                }
            out_w[pid] = res_w
        results["wbgt_propagation"] = {
            "method": "thermofeel 2.3.0 calculate_wbgt_liljegren (wind_scaling='liljegren'); radiation (GHI, fdir=direct/GHI) and surface pressure from the same model for both runs; SSRD converted to instantaneous with the backward->instant factor, cos(zenith) instantaneous at t (pvlib SPA). 'obsmet' = METAR T, Td (->RH via Magnus 17.625/243.04) and 10 m wind.",
            "results": out_w,
        }
    except Exception as ex:  # pragma: no cover
        results["wbgt_propagation"] = {"error": repr(ex)}

    # ---- Instant-radiation conversion test vector (Open-Meteo formula) vs API *_instant values
    results["instant_conversion_check"] = instant_check()

    txt = json.dumps(results, indent=1)
    if OUT_JSON:
        Path(OUT_JSON).write_text(txt, encoding="utf-8")
    print_summary(results)


def instant_factor(epoch_end, lat, lon, dt=3600):
    """Open-Meteo backwardsAveragedToInstantFactor (Zensun.swift), using Spencer (1971) declination/EoT from pvlib."""
    import pvlib
    import pandas as pd
    ts = pd.to_datetime([epoch_end], unit="s", utc=True)
    doy = ts.day_of_year.to_numpy()
    dec = float(np.degrees(pvlib.solarposition.declination_spencer71(doy))[0])
    eot_h = float(pvlib.solarposition.equation_of_time_spencer71(doy)[0]) / 60.0
    ut = (epoch_end % 86400) / 3600.0
    t1 = math.radians(90 - dec)
    p1 = math.radians(-15.0 * (ut - 12.0 + eot_h))
    p10 = math.radians(-15.0 * (ut - dt / 3600 - 12.0 + eot_h))
    t0 = math.radians(90 - lat)
    p0 = math.radians(lon)
    if p0 < p1 - math.pi:
        p0 += 2 * math.pi
    if p0 > p1 + math.pi:
        p0 -= 2 * math.pi
    arg = -(math.cos(t0) * math.cos(t1)) / (math.sin(t0) * math.sin(t1))
    carg = math.pi if (arg > 1 or arg < -1) else math.acos(arg)
    sunrise, sunset = p0 + carg, p0 - carg
    if p10 < sunset or p1 > sunrise:
        return 0.0
    p1l, p10l = min(sunrise, p10), max(sunset, p1)
    left = math.sin(t0) * math.sin(t1) * math.sin(p1l - p0) + p1l * math.cos(t0) * math.cos(t1)
    right = math.sin(t0) * math.sin(t1) * math.sin(p10l - p0) + p10l * math.cos(t0) * math.cos(t1)
    zz_back = abs((left - right) / (p10 - p1))
    zz_inst = math.cos(t0) * math.cos(t1) + math.sin(t0) * math.sin(t1) * math.cos(p1 - p0)
    if zz_back <= 0 or zz_inst <= 0:
        return 0.0
    return zz_inst / zz_back


def instant_check():
    # Values returned by archive-api (models=ecmwf_ifs, 24.35N 54.50E -> grid 24.358522, 54.498936), 2025-07-15, Asia/Dubai.
    # local hour: (shortwave_radiation backward mean, shortwave_radiation_instant)
    api = {6: (2, 18.3), 7: (69, 117.1), 8: (227, 290.4), 9: (423, 490.7), 10: (610, 670.0), 11: (761, 804.1), 12: (858, 878.4), 13: (890, 884.8)}
    lat, lon = 24.358522, 54.498936
    import datetime as dt
    rows = []
    for h, (back, inst_api) in api.items():
        epoch = int(dt.datetime(2025, 7, 15, h, 0, tzinfo=dt.timezone(dt.timedelta(hours=4))).timestamp())
        f = instant_factor(epoch, lat, lon)
        rows.append({"local_hour": h, "backward_mean": back, "api_instant": inst_api, "factor": round(f, 4), "recomputed_instant": round(back * f, 1)})
    return rows


def print_summary(r):
    for pid in ("omaa", "omad", "omal"):
        p = r[pid]
        print(f"\n=== {p['icao']} ({pid}) matched hours {p['n_matched']}/{p['n_model_hours']}")
        for key, v in p["variants"].items():
            if "T" not in v or v["T"] is None:
                print(f"  {key:24s} no data")
                continue
            g = v["grid"]
            line = f"  {key:24s} grid {g['lat']:.3f},{g['lon']:.3f}  T bias {v['T']['bias']:+.2f} RMSE {v['T']['rmse']:.2f} r {v['T']['r']:.3f} | Td bias {v['Td']['bias']:+.2f} RMSE {v['Td']['rmse']:.2f} r {v['Td']['r']:.3f}"
            if v.get("wind10"):
                line += f" | wind bias {v['wind10']['bias']:+.2f} RMSE {v['wind10']['rmse']:.2f}"
            if v.get("RH"):
                line += f" | RH bias {v['RH']['bias']:+.1f} RMSE {v['RH']['rmse']:.1f}"
            print(line)
            print(f"  {'':24s} T day {v['T_day_07_18']['bias']:+.2f}/{v['T_day_07_18']['rmse']:.2f} night {v['T_night']['bias']:+.2f}/{v['T_night']['rmse']:.2f} peak10-16 {v['T_peak_10_16']['bias']:+.2f}/{v['T_peak_10_16']['rmse']:.2f} | Td day {v['Td_day_07_18']['bias']:+.2f}/{v['Td_day_07_18']['rmse']:.2f} night {v['Td_night']['bias']:+.2f}/{v['Td_night']['rmse']:.2f} | Tmax obs/model {v['Tmax_obs_vs_model']}")
    w = r.get("wbgt_propagation", {})
    if "results" in w:
        print("\n=== WBGT (Liljegren, thermofeel) model-only minus obs-met (same model radiation)")
        for pid, d in w["results"].items():
            for key, v in d.items():
                a, dd, tt = v["wbgt_model_minus_obsmet_all"], v["wbgt_model_minus_obsmet_day_07_18"], v["wbgt_due_to_T_Td_only_all"]
                print(f"  {pid} {key:18s} all bias {a['bias']:+.2f} RMSE {a['rmse']:.2f} | day bias {dd['bias']:+.2f} RMSE {dd['rmse']:.2f} | T/Td-only bias {tt['bias']:+.2f} RMSE {tt['rmse']:.2f} | obsmet p50/p95/max {v['wbgt_obsmet_p50_p95_max']} model {v['wbgt_model_p50_p95_max']} nan {v['nan_count_model_obsmet']}")
    else:
        print("WBGT propagation:", w)
    print("\n=== instant conversion check (Open-Meteo formula, Spencer71 solar geometry)")
    for row in r["instant_conversion_check"]:
        print("  ", row)


if __name__ == "__main__":
    main()
