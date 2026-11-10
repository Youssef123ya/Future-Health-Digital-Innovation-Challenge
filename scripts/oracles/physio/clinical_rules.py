"""
Zill - clinical safety rules oracle (symptom check-in triage, urine colour, fluid caps,
physiological escalation, fail-safe fusion).  Writes out/clinical_rules_fixtures.json.

Every rule carries a `basis` tag that maps to the citation keys used in
docs/research/physio_and_clinical.md.  Rules tagged ENG are engineering choices
(not taken from a source) and must be reviewed by the occupational physician.
Standard library only.
"""
from __future__ import annotations

import json
import math
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # pragma: no cover
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

# Triage levels (ordered)
T0, T1, T2, T3 = 0, 1, 2, 3
LEVEL_NAME = {T0: "T0_continue_with_precautions", T1: "T1_rest_cool_notify_supervisor",
              T2: "T2_first_aider_now", T3: "T3_emergency_998_now"}

# --------------------------------------------------------------------------------------
# Symptom check-in items.  who: 'self' (worker) or 'buddy' (observer).
# --------------------------------------------------------------------------------------
ITEMS = {
    # id: (who, level_if_yes, basis)
    "B_CONFUSED":     ("buddy", T3, ["NIOSH_ILL", "OSHA_FA", "TBMED_T5-1", "TBMED_4-6"]),
    "B_SPEECH_GAIT":  ("buddy", T3, ["NIOSH_ILL", "TBMED_4-4", "OSHA_FA"]),
    "B_UNRESPONSIVE": ("buddy", T3, ["NIOSH_ILL", "TBMED_T5-1"]),
    "S_CHEST":        ("self",  T3, ["TBMED_T5-3", "IOC2021", "ENG_general_emergency"]),
    "S_VOMIT_REPEAT": ("self",  T3, ["TBMED_T5-1"]),
    "S_FAINTED":      ("self",  T2, ["NIOSH_ILL", "TBMED_4-3c"]),
    "S_DIZZY":        ("self",  T2, ["NIOSH_ILL", "TBMED_T5-1"]),
    "S_HEADACHE":     ("self",  T2, ["NIOSH_ILL", "TBMED_T5-1"]),
    "S_NAUSEA":       ("self",  T2, ["NIOSH_ILL", "TBMED_T5-1"]),
    "S_WEAK":         ("self",  T2, ["NIOSH_ILL", "TBMED_T5-1"]),
    "S_URINE_BROWN":  ("self",  T2, ["NIOSH_ILL_rhabdo", "TBMED_5-4c"]),
    "S_OVERDRINK_SX": ("self",  T2, ["TBMED_5-4b", "TBMED_3-7h"]),
    "S_CRAMPS":       ("self",  T1, ["NIOSH_ILL", "SPSA_CoP33"]),
    "S_RASH":         ("self",  T1, ["NIOSH_ILL", "TBMED_4-3e"]),
    "S_URINE_DARK":   ("self",  T1, ["McKenzie2015", "NIOSH_AppB"]),
    "S_THIRST":       ("self",  T0, ["ENG_advice_only"]),
}


def triage(answers: dict, minutes_since_first_symptom: float = 0.0, cramps_minutes: float = 0.0,
           profile: dict | None = None, improving: bool | None = None, worsening: bool = False,
           strict_recheck_min: float = 30.0):
    """answers: {item_id: True/False}. Unanswered items are treated as 'no' EXCEPT that an
    unanswered prompted check-in is handled by the caller (escalate to buddy).  Returns dict."""
    profile = profile or {}
    level, reasons, actions = T0, [], set()
    for k, yes in answers.items():
        if not yes:
            continue
        who, lv, basis = ITEMS[k]
        if k == "S_CRAMPS" and (profile.get("heart_disease") or profile.get("low_sodium_diet")
                                or cramps_minutes >= 60):
            lv, basis = T2, basis + ["NIOSH_ILL_cramps_escalation"]
        if lv > level:
            level = lv
        reasons.append({"item": k, "level": LEVEL_NAME[lv], "basis": basis})
        if k == "S_OVERDRINK_SX":
            actions.add("STOP_PLAIN_WATER_suspect_hyponatremia")
        if k == "S_URINE_BROWN":
            actions.add("MEDICAL_FACILITY_SAME_SHIFT_check_CK")
    # time-based escalation for an ongoing episode
    if level in (T1, T2) and worsening:
        level = T3
        reasons.append({"item": "WORSENING", "level": LEVEL_NAME[T3], "basis": ["TBMED_5-1b", "OSHA_FA"]})
    if level == T2 and improving is False and minutes_since_first_symptom >= strict_recheck_min:
        level = T3
        reasons.append({"item": f"NOT_IMPROVING_{int(strict_recheck_min)}min", "level": LEVEL_NAME[T3],
                        "basis": ["TBMED_5-1b(<=60min)", "SPSA_CoP33", "ENG_30min_default"]})
    if level == T3:
        actions |= {"CALL_998", "START_COOLING_NOW", "STAY_WITH_WORKER", "ALERT_SUPERVISOR_AND_FIRST_AIDER"}
    elif level == T2:
        actions |= {"STOP_WORK", "FIRST_AIDER_NOW", "COOL_AND_REHYDRATE_IF_ALERT", "STAY_WITH_WORKER",
                    "MEDICAL_EVALUATION_SAME_DAY", "NO_RETURN_TO_HOT_WORK_TODAY", "RECHECK_15_30_MIN"}
    elif level == T1:
        actions |= {"STOP_STRENUOUS_WORK", "REST_SHADE_COOL", "DRINK_WATER_PLUS_SNACK_OR_ELECTROLYTE",
                    "NOTIFY_SUPERVISOR", "RECHECK_15_30_MIN"}
    else:
        actions |= {"CONTINUE_WITH_PRECAUTIONS"}
    return {"level": LEVEL_NAME[level], "level_num": level, "reasons": reasons, "actions": sorted(actions)}


# --------------------------------------------------------------------------------------
# Urine colour (Armstrong 8-shade scale)
# --------------------------------------------------------------------------------------
def urine_advice(shade: int | None, brown_or_red: bool = False):
    if brown_or_red:
        return {"code": "U_BROWN_RED", "triage_floor": LEVEL_NAME[T2],
                "basis": ["NIOSH_ILL_rhabdo", "TBMED_5-4c", "NIOSH_AppB_TableB-1"]}
    if shade is None or not (1 <= shade <= 8):
        return {"code": "U_INVALID", "triage_floor": None, "basis": []}
    if shade <= 3:
        return {"code": "U_OK", "triage_floor": LEVEL_NAME[T0], "basis": ["NIOSH_AppB", "Armstrong1994"]}
    if shade == 4:
        return {"code": "U_DRINK_MORE", "triage_floor": LEVEL_NAME[T0],
                "basis": ["Kavouras2016_threshold_ge4", "Armstrong2010_ref_values"]}
    if shade <= 6:
        return {"code": "U_DEHYDRATED", "triage_floor": LEVEL_NAME[T0],
                "basis": ["McKenzie2015_ge5"], "escalate_if_persists": LEVEL_NAME[T1]}
    return {"code": "U_VERY_DARK", "triage_floor": LEVEL_NAME[T1], "basis": ["McKenzie2015_ge5", "Armstrong1998"]}


# --------------------------------------------------------------------------------------
# Fluid caps (TB MED 507 2022; NIOSH 2016 table adapted from DOD)
# --------------------------------------------------------------------------------------
US_QUART_L = 0.946352946
HOURLY_CAP_L = 1.5 * US_QUART_L          # 1.4195 L/h
DAILY_CAP_L = 12 * US_QUART_L            # 11.356 L/day
CUP_L = 8 * 0.0295735295625              # 8 US fl oz = 0.2366 L
REMINDER_DEFAULT_L = 0.25                # ENG: 250 mL every 20 min = 0.75 L/h
REMINDER_INTERVAL_MIN = 20


def fluid_check(rolling_60min_L: float, today_L: float, fasting_now: bool = False):
    out = {"hourly_cap_L": round(HOURLY_CAP_L, 4), "daily_cap_L": round(DAILY_CAP_L, 3), "flags": []}
    if rolling_60min_L > HOURLY_CAP_L:
        out["flags"].append("OVER_HOURLY_CAP")
    if today_L > DAILY_CAP_L:
        out["flags"].append("OVER_DAILY_CAP")
    out["send_drink_reminders"] = (not fasting_now) and ("OVER_HOURLY_CAP" not in out["flags"])
    return out


# --------------------------------------------------------------------------------------
# Physiological escalation + fail-safe fusion
# --------------------------------------------------------------------------------------
def physio_escalation(ectemp: float | None, psi: float | None, hr_sustained_5min: float | None, age: float,
                      channel_valid: bool, conservative_mode: bool = False):
    """Returns minimum triage floor implied by the physio channel (never lowers anything)."""
    if not channel_valid:
        return {"floor": None, "reasons": ["PHYSIO_INVALID_ignored"]}
    floor, reasons = None, []

    def bump(lv, why):
        nonlocal floor
        floor = lv if floor is None else max(floor, lv)
        reasons.append(why)
    t_stop = 38.0 if conservative_mode else 38.4
    if ectemp is not None:
        if ectemp >= 39.0:
            bump(T2, "ECTEMP_GE_39.0")
        elif ectemp >= t_stop:
            bump(T1, f"ECTEMP_GE_{t_stop}")
        elif ectemp >= 38.0:
            reasons.append("ECTEMP_GE_38.0_advisory_prompt_checkin")
    if psi is not None:
        if psi > 8.0:
            bump(T2, "PSI_VERY_HIGH")
        elif psi > 6.0:
            bump(T1, "PSI_HIGH")
        elif psi > 4.0:
            reasons.append("PSI_MODERATE_advisory")
    if hr_sustained_5min is not None and hr_sustained_5min > (180 - age):
        bump(T1, "HR_SUSTAINED_GT_180_MINUS_AGE")
    return {"floor": None if floor is None else LEVEL_NAME[floor], "reasons": reasons}


def fuse(env_level: int, physio_floor: int | None, symptom_level: int | None):
    """Final level = max of available channels. Missing/invalid channels contribute nothing."""
    vals = [env_level] + [v for v in (physio_floor, symptom_level) if v is not None]
    return max(vals)


def main():
    cases = []

    def add(name, **kw):
        r = triage(**kw)
        cases.append({"name": name, "input": kw, "expected": {"level": r["level"], "actions": r["actions"]}})
    add("no_symptoms", answers={k: False for k in ITEMS})
    add("thirst_only", answers={"S_THIRST": True})
    add("rash_only", answers={"S_RASH": True})
    add("cramps_only", answers={"S_CRAMPS": True})
    add("cramps_60min", answers={"S_CRAMPS": True}, cramps_minutes=60)
    add("cramps_heart_disease", answers={"S_CRAMPS": True}, profile={"heart_disease": True})
    add("headache_dizzy", answers={"S_HEADACHE": True, "S_DIZZY": True})
    add("fainted_now_alert", answers={"S_FAINTED": True})
    add("fainted_and_confused", answers={"S_FAINTED": True, "B_CONFUSED": True})
    add("buddy_slurred_speech", answers={"B_SPEECH_GAIT": True})
    add("repeated_vomiting", answers={"S_VOMIT_REPEAT": True})
    add("brown_urine", answers={"S_URINE_BROWN": True})
    add("overdrink_symptoms", answers={"S_OVERDRINK_SX": True})
    add("overdrink_plus_confusion", answers={"S_OVERDRINK_SX": True, "B_CONFUSED": True})
    add("chest_pain", answers={"S_CHEST": True})
    add("heat_exhaustion_not_improving_30", answers={"S_HEADACHE": True, "S_WEAK": True},
        minutes_since_first_symptom=30, improving=False)
    add("heat_exhaustion_improving_30", answers={"S_HEADACHE": True, "S_WEAK": True},
        minutes_since_first_symptom=30, improving=True)
    add("cramps_worsening", answers={"S_CRAMPS": True}, worsening=True)

    urine = [{"shade": s, "brown_or_red": False, "expected": urine_advice(s)} for s in range(1, 9)]
    urine.append({"shade": None, "brown_or_red": True, "expected": urine_advice(None, True)})
    fluids = [
        {"rolling_60min_L": 0.75, "today_L": 5.0, "fasting_now": False, "expected": fluid_check(0.75, 5.0)},
        {"rolling_60min_L": 1.5, "today_L": 6.0, "fasting_now": False, "expected": fluid_check(1.5, 6.0)},
        {"rolling_60min_L": 0.5, "today_L": 11.5, "fasting_now": False, "expected": fluid_check(0.5, 11.5)},
        {"rolling_60min_L": 0.0, "today_L": 1.0, "fasting_now": True, "expected": fluid_check(0.0, 1.0, True)},
    ]
    phys = []
    for (ect, psi, hr5, age, valid, cons) in [
            (37.6, 3.0, 120, 35, True, False), (38.1, 4.5, 130, 35, True, False),
            (38.45, 6.4, 150, 35, True, False), (38.1, 5.0, 130, 35, True, True),
            (39.05, 8.6, 165, 35, True, False), (39.5, 9.5, 170, 35, False, False),
            (37.9, 5.5, 150, 40, True, False)]:
        phys.append({"input": {"ectemp": ect, "psi": psi, "hr_sustained_5min": hr5, "age": age,
                               "channel_valid": valid, "conservative_mode": cons},
                     "expected": physio_escalation(ect, psi, hr5, age, valid, cons)})
    fusion = [{"env": e, "physio": p, "symptom": s, "expected": fuse(e, p, s)}
              for (e, p, s) in [(2, None, None), (0, 1, None), (1, None, 3), (2, 0, 0), (0, None, 0)]]
    fx = {"_meta": {"generated_by": "clinical_rules.py", "levels": LEVEL_NAME,
                    "constants": {"HOURLY_CAP_L": HOURLY_CAP_L, "DAILY_CAP_L": DAILY_CAP_L, "CUP_L": CUP_L,
                                  "REMINDER_DEFAULT_L": REMINDER_DEFAULT_L,
                                  "REMINDER_INTERVAL_MIN": REMINDER_INTERVAL_MIN}},
          "items": {k: {"who": v[0], "level_if_yes": LEVEL_NAME[v[1]], "basis": v[2]} for k, v in ITEMS.items()},
          "triage_vectors": cases, "urine_vectors": urine, "fluid_vectors": fluids,
          "physio_escalation_vectors": phys, "fusion_vectors": fusion}
    with open(os.path.join(OUT, "clinical_rules_fixtures.json"), "w", encoding="utf-8") as f:
        json.dump(fx, f, indent=1)
    for c in cases:
        print(f"{c['name']:<36s} -> {c['expected']['level']}")
    print("urine:", [(u["shade"], u["expected"]["code"]) for u in urine])
    print("caps: hourly %.4f L  daily %.3f L  cup %.4f L" % (HOURLY_CAP_L, DAILY_CAP_L, CUP_L))
    for p in phys:
        print("physio", p["input"], "->", p["expected"])
    print("fusion", [(f["env"], f["physio"], f["symptom"], f["expected"]) for f in fusion])


if __name__ == "__main__":
    main()
