"""Compare the Python oracle (out/physio_fixtures.json) with the official JS outputs (out/js_crosscheck_output.json)."""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
fx = json.load(open(os.path.join(HERE, "out", "physio_fixtures.json"), encoding="utf-8"))
js = json.load(open(os.path.join(HERE, "out", "js_crosscheck_output.json"), encoding="utf-8"))
worst_ct = worst_v = 0.0
n = 0
for vec in fx["ectemp_vectors"]:
    name = vec["name"]
    if name not in js:
        continue
    py_ct, py_v = vec["ct_quadratic"], vec["v_quadratic"]
    j_ct, j_v = js[name]["ct"], js[name]["v"]
    assert len(py_ct) == len(j_ct), name
    d_ct = max(abs(a - b) for a, b in zip(py_ct, j_ct))
    d_v = max(abs(a - b) for a, b in zip(py_v, j_v))
    worst_ct, worst_v = max(worst_ct, d_ct), max(worst_v, d_v)
    n += len(py_ct)
    print(f"{name:<32s} minutes={len(py_ct):4d}  max|dCT|={d_ct:.3e}  max|dV|={d_v:.3e}")
print(f"TOTAL minutes compared={n}  worst |dCT|={worst_ct:.3e} degC  worst |dV|={worst_v:.3e}")
ok = worst_ct < 1e-9 and worst_v < 1e-12
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
