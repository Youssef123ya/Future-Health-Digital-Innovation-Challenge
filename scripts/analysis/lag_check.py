"""Lag sanity check: RMSE(model(t+lag) - obs(t)) for lag in -3..+3 h at the three airports."""
import json, sys, datetime as dt
from pathlib import Path
import numpy as np
root = Path(sys.argv[1])
for pid, icao in (("omaa","OMAA"),("omad","OMAD"),("omal","OMAL")):
    obs = json.loads((root/"public/data/obs"/f"{icao}_2025_summer.json").read_text(encoding="utf-8"))
    val = json.loads((root/"public/data/weather/validation"/f"{pid}_2025.json").read_text(encoding="utf-8"))
    oe = {int(dt.datetime.strptime(s,"%Y-%m-%dT%H:%MZ").replace(tzinfo=dt.timezone.utc).timestamp()): i for i,s in enumerate(obs["columns"]["valid_utc"])}
    oT = obs["columns"]["temp_c"]; oTd = obs["columns"]["dewpoint_c"]
    t0, n = val["time"]["t0_unix"], val["time"]["n"]
    for key in ("era5@nearest","ecmwf_ifs@nearest"):
        mT = val["models"][key]["columns"]["temperature_2m"]
        out=[]
        for lag in range(-3,4):
            e=[]
            for i in range(n):
                j=i+lag
                if j<0 or j>=n: continue
                k=oe.get(t0+3600*i)
                if k is None or mT[j] is None or oT[k] is None: continue
                e.append(mT[j]-oT[k])
            e=np.array(e); out.append(f"{lag:+d}h:{np.sqrt((e**2).mean()):.2f}")
        print(pid, key.ljust(18), " T RMSE by lag:", " ".join(out))
