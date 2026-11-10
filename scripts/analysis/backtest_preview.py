"""Zill — preview of the validation design on the cached data (oracle numbers for the TS engine team).

Usage:  python -I backtest_preview.py <project_root> [--json out.json]

1. Hours-in-zone preview 2020-2025 (5 sites x 2 archive models) with thermofeel 2.3.0 Liljegren WBGT.
2. Demo-day check: rank of the demo 'peak' day under full Liljegren WBGT.
3. Forecast skill preview: Previous Runs d1..d3 vs d0 (WBGT), 2024-2025, 5 sites; and T/Td/WBGT vs METAR at OMAA/OMAD/OMAL.

WBGT inputs (identical for every dataset):
  t2_k = T+273.15, rh, pressure = surface_pressure (hPa), va = wind_speed_10m (m/s),
  ssrd = shortwave_radiation converted to INSTANT at the timestamp with Open-Meteo's backward->instant factor,
  fdir = direct_radiation / shortwave_radiation (both backward means; the factor cancels), cossza = instant cos(zenith)
  (pvlib NREL SPA, geometric zenith). Cutpoints 28/30/32/33 degC are ILLUSTRATIVE ONLY (not Zill zone thresholds).
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pvlib
import thermofeel as tf

ROOT = Path(sys.argv[1])
OUT_JSON = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None
W = ROOT / "public/data/weather"
SITES = ["musaffah", "kezad", "ruwais", "alain", "saadiyat"]
CUTS = [28.0, 30.0, 32.0, 33.0]


def arr(a):
    return np.array([np.nan if v is None else v for v in a], float)


_SOLAR = {}


def solar_terms(epoch, lat, lon):
    """Return (cos_zenith_instant, backward->instant factor) for hourly timestamps (preceding-hour averages)."""
    key = (int(epoch[0]), len(epoch), round(lat, 5), round(lon, 5))
    if key in _SOLAR:
        return _SOLAR[key]
    t = pd.to_datetime(epoch, unit="s", utc=True)
    sp = pvlib.solarposition.get_solarposition(t, lat, lon)
    cz_inst = np.clip(np.cos(np.radians(sp["zenith"].to_numpy())), 0, None)
    # mean of max(cos z, 0) over the preceding hour, 12 sub-steps (5-min midpoints)
    acc = np.zeros(len(epoch))
    for k in range(12):
        tk = pd.to_datetime(epoch - 3600 + 150 + 300 * k, unit="s", utc=True)
        spk = pvlib.solarposition.get_solarposition(tk, lat, lon)
        acc += np.clip(np.cos(np.radians(spk["zenith"].to_numpy())), 0, None)
    cz_mean = acc / 12
    factor = np.where((cz_mean > 0) & (cz_inst > 0), cz_inst / np.where(cz_mean > 0, cz_mean, 1), 0.0)
    _SOLAR[key] = (cz_inst, factor)
    return cz_inst, factor


def wbgt_from_cols(cols, epoch, lat, lon, get=lambda c, k: arr(c[k])):
    T, RH, PS, U = get(cols, "temperature_2m"), get(cols, "relative_humidity_2m"), get(cols, "surface_pressure"), get(cols, "wind_speed_10m")
    G, D = get(cols, "shortwave_radiation"), get(cols, "direct_radiation")
    cz, f = solar_terms(epoch, lat, lon)
    ssrd = G * f
    fdir = np.where(G > 0, np.clip(D / np.where(G > 0, G, 1), 0, 1), 0)
    return tf.calculate_wbgt_liljegren(T + 273.15, RH, PS, U, ssrd, fdir, cz) - 273.15


def stats(e):
    e = np.asarray(e, float)
    e = e[np.isfinite(e)]
    if e.size == 0:
        return None
    return {"n": int(e.size), "bias": round(float(e.mean()), 3), "mae": round(float(np.abs(e).mean()), 3), "rmse": round(float(np.sqrt((e ** 2).mean())), 3)}


def main():
    out = {"config": __doc__}
    # ---------------- 1. hours-in-zone preview
    hz = {}
    wbgt_cache = {}
    for site in SITES:
        for year in range(2020, 2026):
            doc = json.loads((W / "archive" / f"{site}_{year}.json").read_text(encoding="utf-8"))
            t0, n = doc["time"]["t0_unix"], doc["time"]["n"]
            epoch = t0 + 3600 * np.arange(n)
            for model, blk in doc["models"].items():
                lat, lon = blk["grid"]["lat"], blk["grid"]["lon"]
                w = wbgt_from_cols(blk["columns"], epoch, lat, lon)
                wbgt_cache[(site, year, model)] = (epoch, w)
                local = pd.to_datetime(epoch + 4 * 3600, unit="s")
                hh = local.hour.to_numpy()
                md = local.month.to_numpy() * 100 + local.day.to_numpy()
                in_break = (md >= 615) & (md <= 915) & ((hh == 13) | (hh == 14))  # instants inside 12:30-15:00
                rec = {"n": int(n), "nan": int(np.isnan(w).sum()), "p50": round(float(np.nanpercentile(w, 50)), 2), "p95": round(float(np.nanpercentile(w, 95)), 2), "max": round(float(np.nanmax(w)), 2)}
                for c in CUTS:
                    sel = w >= c
                    rec[f"h_ge_{c:g}"] = int(sel.sum())
                    rec[f"h_ge_{c:g}_outside_midday_break"] = int((sel & ~in_break).sum())
                hz.setdefault(site, {}).setdefault(model, {})[year] = rec
    out["hours_in_zone_preview"] = hz

    # ---------------- 2. demo-day rank under full Liljegren
    demo = json.loads((W / "demo-days.json").read_text(encoding="utf-8"))
    ranks = []
    for d in demo["days"]:
        if "peak_wbgt_proxy" not in d["tags"] and "most_humid" not in d["tags"] and "hottest_dry_bulb" not in d["tags"]:
            continue
        epoch, w = wbgt_cache[(d["site"]["id"], 2025, "ecmwf_ifs")]
        local = pd.to_datetime(epoch + 4 * 3600, unit="s")
        daily = pd.Series(w, index=local).resample("D").max()
        order = daily.sort_values(ascending=False)
        rank = int(list(order.index.strftime("%Y-%m-%d")).index(d["date"]) + 1)
        ranks.append({"id": d["id"], "tags": d["tags"], "liljegren_daily_max_c": round(float(daily.loc[d["date"]]), 2), "rank_of_122": rank, "top_liljegren_day": order.index[0].strftime("%Y-%m-%d"), "top_liljegren_value_c": round(float(order.iloc[0]), 2)})
    out["demo_day_liljegren_rank"] = ranks

    # ---------------- 3a. forecast skill vs d0 at the 5 sites (WBGT)
    fs = {}
    for site in SITES:
        for year in (2024, 2025):
            doc = json.loads((W / "previous-runs" / f"{site}_{year}.json").read_text(encoding="utf-8"))
            t0, n = doc["time"]["t0_unix"], doc["time"]["n"]
            epoch = t0 + 3600 * np.arange(n)
            for model, blk in doc["models"].items():
                lat, lon = blk["grid"]["lat"], blk["grid"]["lon"]
                ws = {}
                for d in (0, 1, 2, 3):
                    ws[d] = wbgt_from_cols(blk["columns"], epoch, lat, lon, get=lambda c, k, d=d: arr(c[k][f"d{d}"]))
                local = pd.to_datetime(epoch + 4 * 3600, unit="s")
                for d in (1, 2, 3):
                    e = ws[d] - ws[0]
                    dm = pd.Series(ws[d], index=local).resample("D").max() - pd.Series(ws[0], index=local).resample("D").max()
                    rec = fs.setdefault(model, {}).setdefault(f"d{d}", {"hourly": [], "dailymax": [], "exceed": []})
                    rec["hourly"].append(e)
                    rec["dailymax"].append(dm.to_numpy())
                    for c in (30.0, 32.0):
                        o, f_ = ws[0] >= c, ws[d] >= c
                        rec["exceed"].append((c, int((f_ & o).sum()), int((f_ & ~o).sum()), int((~f_ & o).sum()), int((~f_ & ~o).sum())))
                # persistence baseline: d0 of 24 h earlier
                pers = np.full(n, np.nan)
                pers[24:] = ws[0][:-24]
                fs.setdefault(model, {}).setdefault("persistence_24h", {"hourly": [], "dailymax": [], "exceed": []})["hourly"].append(pers - ws[0])
    fs_out = {}
    for model, leads in fs.items():
        fs_out[model] = {}
        for lead, rec in leads.items():
            r = {"hourly_wbgt_vs_d0": stats(np.concatenate(rec["hourly"]))}
            if rec["dailymax"]:
                r["daily_max_wbgt_vs_d0"] = stats(np.concatenate(rec["dailymax"]))
            for c in (30.0, 32.0):
                rows = [x for x in rec["exceed"] if x[0] == c]
                if rows:
                    hit, fa, miss, cn = (sum(x[i] for x in rows) for i in (1, 2, 3, 4))
                    r[f"exceed_{c:g}"] = {"hits": hit, "false_alarms": fa, "misses": miss, "correct_neg": cn, "POD": round(hit / max(hit + miss, 1), 3), "FAR": round(fa / max(hit + fa, 1), 3), "CSI": round(hit / max(hit + fa + miss, 1), 3)}
            fs_out[model][lead] = r
    out["forecast_skill_vs_d0_5sites_2024_2025"] = fs_out

    # ---------------- 3b. forecast skill vs METAR at airports (2025)
    import datetime as dt
    vm = {}
    for pid, icao in (("omaa", "OMAA"), ("omad", "OMAD"), ("omal", "OMAL")):
        obs = json.loads((ROOT / "public/data/obs" / f"{icao}_2025_summer.json").read_text(encoding="utf-8"))
        prev = json.loads((W / "validation" / f"{pid}_2025_previous.json").read_text(encoding="utf-8"))
        ana = json.loads((W / "validation" / f"{pid}_2025.json").read_text(encoding="utf-8"))
        oe = {int(dt.datetime.strptime(s, "%Y-%m-%dT%H:%MZ").replace(tzinfo=dt.timezone.utc).timestamp()): i for i, s in enumerate(obs["columns"]["valid_utc"])}
        t0, n = prev["time"]["t0_unix"], prev["time"]["n"]
        epoch = t0 + 3600 * np.arange(n)
        sel = np.array([int(t) in oe for t in epoch])
        oi = np.array([oe[int(t)] for t in epoch[sel]])
        oT = arr(obs["columns"]["temp_c"])[oi]
        oTd = arr(obs["columns"]["dewpoint_c"])[oi]
        oU = arr(obs["columns"]["wind_speed_ms"])[oi]
        oRH = 100 * np.exp(17.625 * oTd / (243.04 + oTd)) / np.exp(17.625 * oT / (243.04 + oT))
        # obs-met WBGT: METAR T/Td/wind + IFS-9km archive radiation & pressure at the airport
        ac = ana["models"]["ecmwf_ifs@nearest"]["columns"]
        lat, lon = ana["point"]["lat"], ana["point"]["lon"]
        obs_cols = {"temperature_2m": oT, "relative_humidity_2m": oRH, "surface_pressure": arr(ac["surface_pressure"])[sel], "wind_speed_10m": oU, "shortwave_radiation": arr(ac["shortwave_radiation"])[sel], "direct_radiation": arr(ac["direct_radiation"])[sel]}
        w_obs = wbgt_from_cols(obs_cols, epoch[sel], lat, lon, get=lambda c, k: c[k])
        res = {}
        for model, blk in prev["models"].items():
            res[model] = {"grid": blk["grid"]}
            for d in (0, 1, 2, 3):
                mT = arr(blk["columns"]["temperature_2m"][f"d{d}"])[sel]
                mTd = arr(blk["columns"]["dew_point_2m"][f"d{d}"])[sel]
                w_m = wbgt_from_cols(blk["columns"], epoch, blk["grid"]["lat"], blk["grid"]["lon"], get=lambda c, k, d=d: arr(c[k][f"d{d}"]))[sel]
                res[model][f"d{d}"] = {"T": stats(mT - oT), "Td": stats(mTd - oTd), "WBGT_vs_obsmet": stats(w_m - w_obs)}
        vm[pid] = res
    out["forecast_skill_vs_metar_2025"] = vm

    if OUT_JSON:
        Path(OUT_JSON).write_text(json.dumps(out, indent=1, default=str), encoding="utf-8")

    # ---------------- print
    print("=== 1. Hours-in-zone preview (Liljegren WBGT, thermofeel 2.3.0), mean over 2020-2025 per Jun-Sep season")
    for site in SITES:
        for model in ("era5", "ecmwf_ifs"):
            yrs = hz[site][model]
            m = lambda k: np.mean([yrs[y][k] for y in yrs])
            print(f"  {site:9s} {model:9s} p50 {m('p50'):5.1f} p95 {m('p95'):5.1f} max {max(yrs[y]['max'] for y in yrs):5.1f} | h>=28 {m('h_ge_28'):6.0f} h>=30 {m('h_ge_30'):6.0f} h>=32 {m('h_ge_32'):5.0f} h>=33 {m('h_ge_33'):5.0f} | h>=30 outside midday break {m('h_ge_30_outside_midday_break'):6.0f}  nan {sum(yrs[y]['nan'] for y in yrs)}")
    print("  per-year h>=30 (ecmwf_ifs | era5):")
    for site in SITES:
        print(f"   {site:9s}", " ".join(f"{y}:{hz[site]['ecmwf_ifs'][y]['h_ge_30']}|{hz[site]['era5'][y]['h_ge_30']}" for y in range(2020, 2026)))
    print("\n=== 2. Demo-day rank under full Liljegren WBGT (ecmwf_ifs 2025)")
    for r in ranks:
        print("  ", r)
    print("\n=== 3a. WBGT forecast error vs same-model d0 (5 sites, Jun-Sep 2024+2025)")
    for model, leads in fs_out.items():
        for lead, r in leads.items():
            h = r["hourly_wbgt_vs_d0"]
            line = f"  {model:18s} {lead:16s} hourly bias {h['bias']:+.2f} MAE {h['mae']:.2f} RMSE {h['rmse']:.2f}"
            if "daily_max_wbgt_vs_d0" in r:
                dmx = r["daily_max_wbgt_vs_d0"]
                line += f" | daily-max bias {dmx['bias']:+.2f} RMSE {dmx['rmse']:.2f}"
            for c in (30, 32):
                k = f"exceed_{c}"
                if k in r:
                    line += f" | >={c}: POD {r[k]['POD']:.2f} FAR {r[k]['FAR']:.2f} CSI {r[k]['CSI']:.2f}"
            print(line)
    print("\n=== 3b. Forecast error vs METAR (2025): T | Td | WBGT vs obs-met WBGT (bias/RMSE)")
    for pid, res in vm.items():
        for model, r in res.items():
            print(f"  {pid} {model:18s} grid {r['grid']['lat']:.3f},{r['grid']['lon']:.3f} " + " ".join(f"d{d}: T {r[f'd{d}']['T']['bias']:+.2f}/{r[f'd{d}']['T']['rmse']:.2f} Td {r[f'd{d}']['Td']['bias']:+.2f}/{r[f'd{d}']['Td']['rmse']:.2f} W {r[f'd{d}']['WBGT_vs_obsmet']['bias']:+.2f}/{r[f'd{d}']['WBGT_vs_obsmet']['rmse']:.2f} |" for d in (0, 1, 2, 3)))


if __name__ == "__main__":
    main()
