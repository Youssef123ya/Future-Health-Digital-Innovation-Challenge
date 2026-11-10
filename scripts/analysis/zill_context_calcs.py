"""Zill - reproducible arithmetic behind docs/research/context_and_commercial.md

Usage:
  python -I zill_context_calcs.py [path/to/undesa_pd_2024_ims_stock_by_sex_destination_and_origin.xlsx]

Every INPUT below is a cited figure (see the markdown for sources) or an explicitly
labelled ASSUMPTION. Nothing here is new data; it is arithmetic on cited inputs.
Standard library only, except the optional UN DESA step (needs pandas + openpyxl).
"""
import math
import sys

# ---------------------------------------------------------------- cited inputs
UAE_CONSTRUCTION_MOHRE_2022 = 1_386_498   # MoHRE LMIS via GLMM, UAE private-sector construction, 2022
UAE_CONSTRUCTION_MOHRE_2019 = 1_641_724   # same series, 2019
AD_CONSTRUCTION_MOHRE_2019 = 420_654      # same series, Abu Dhabi emirate, 2019
AD_PRIVATE_TOTAL_MOHRE_2019 = 1_381_819   # same series, Abu Dhabi emirate, all activities, 2019
UAE_PRIVATE_TOTAL_MOHRE_2022 = 5_477_366  # same series, UAE, all activities, 2022
JOUBERT_BASELINE_PER_1000 = 15.3          # heat-related treatment+emergency cases /1000 workers, company 1, 2008 (Joubert 2011)
JOUBERT_POST_PER_1000 = 1.16              # same company, 2009, after Safety in the Heat
TWILIO_UAE_SMS_USD_PER_SEGMENT = 0.1176   # twilio.com/en-us/sms/pricing/ae (accessed 2026-11-09)

# ---------------------------------------------------------------- assumptions (NOT facts)
PRICE_PWPM_USD = [1.5, 3.0, 6.0]          # ASSUMPTION: price per worker per month, software-only tier
HEAT_SEASON_MONTHS = 6                    # ASSUMPTION: May-Oct billing season
WA_UTILITY_USD_PER_MSG = 0.0157           # UNVERIFIED third-party figure for UAE utility template (Meta rate card not retrieved)
MSGS_PER_WORKER_PER_SHIFT = 3             # ASSUMPTION: e.g. pre-shift brief, rest prescription, end-of-shift check-in
SHIFTS_PER_MONTH = 26                     # ASSUMPTION: 6-day week
SMS_SEGMENTS_GSM7 = 1                     # <=160 GSM-7 chars (English/Latin)
SMS_SEGMENTS_UCS2 = 2                     # ASSUMPTION: 71-134 chars in Arabic/Hindi/Urdu/Bengali (UCS-2: 70 single / 67 per concatenated segment)
PILOT_WORKERS = 200
PILOT_WEEKS = 10


def market_sizing():
    print("== 1. Illustrative revenue pools (software-only, heat-season billing) ==")
    print(f"UAE construction change 2019->2022: {100*(UAE_CONSTRUCTION_MOHRE_2022/UAE_CONSTRUCTION_MOHRE_2019-1):+.1f}%")
    print(f"Abu Dhabi construction share of Abu Dhabi private-sector workforce (2019): {100*AD_CONSTRUCTION_MOHRE_2019/AD_PRIVATE_TOTAL_MOHRE_2019:.1f}%")
    print(f"UAE construction share of UAE private-sector workforce (2022): {100*UAE_CONSTRUCTION_MOHRE_2022/UAE_PRIVATE_TOTAL_MOHRE_2022:.1f}%")
    for label, n in [("Abu Dhabi construction (2019)", AD_CONSTRUCTION_MOHRE_2019),
                     ("UAE construction (2022)", UAE_CONSTRUCTION_MOHRE_2022)]:
        cells = []
        for p in PRICE_PWPM_USD:
            cells.append(f"${p:.1f} -> US${n*p*HEAT_SEASON_MONTHS/1e6:,.1f}M")
        print(f"  {label:32s} n={n:>9,}  " + " | ".join(cells))
    print(f"  (each cell = workers x price x {HEAT_SEASON_MONTHS} months; 100% penetration, i.e. an upper bound)")


def messaging_costs():
    print("\n== 2. Messaging cost per worker per heat season ==")
    msgs = MSGS_PER_WORKER_PER_SHIFT * SHIFTS_PER_MONTH * HEAT_SEASON_MONTHS
    wa = msgs * WA_UTILITY_USD_PER_MSG
    sms_lat = msgs * SMS_SEGMENTS_GSM7 * TWILIO_UAE_SMS_USD_PER_SEGMENT
    sms_uni = msgs * SMS_SEGMENTS_UCS2 * TWILIO_UAE_SMS_USD_PER_SEGMENT
    print(f"  messages/worker/season = {MSGS_PER_WORKER_PER_SHIFT} x {SHIFTS_PER_MONTH} x {HEAT_SEASON_MONTHS} = {msgs}")
    print(f"  WhatsApp utility @ ${WA_UTILITY_USD_PER_MSG}/msg (UNVERIFIED rate): US${wa:,.2f}")
    print(f"  SMS, Latin script, {SMS_SEGMENTS_GSM7} segment @ ${TWILIO_UAE_SMS_USD_PER_SEGMENT}: US${sms_lat:,.2f}")
    print(f"  SMS, non-Latin script, {SMS_SEGMENTS_UCS2} segments: US${sms_uni:,.2f}")
    print(f"  SMS/WhatsApp cost ratio (Latin): {sms_lat/wa:.1f}x ; (non-Latin): {sms_uni/wa:.1f}x")


def pilot_event_counts():
    print("\n== 3. Expected heat-illness clinic cases in a 200-worker pilot ==")
    # Joubert 2011 rates are per 1000 workers per YEAR; heat cases concentrate in summer,
    # so we bound the pilot window between a pro-rata share and the full annual rate.
    for label, rate in [("baseline (2008)", JOUBERT_BASELINE_PER_1000), ("post-programme (2009)", JOUBERT_POST_PER_1000)]:
        full = PILOT_WORKERS * rate / 1000.0
        prorata = full * PILOT_WEEKS / 52.0
        p_zero_full = math.exp(-full)
        print(f"  {label:24s}: expected cases {prorata:.2f} (pro-rata {PILOT_WEEKS} wk) to {full:.2f} (all annual cases in window);"
              f" P(0 cases | upper) = {p_zero_full:.2f}")
    print("  -> clinic-confirmed heat illness is too rare in n=200 to be a powered endpoint; use process/feasibility outcomes.")


def pilot_precision():
    print("\n== 4. Precision of feasibility proportions (e.g., rest-prescription adherence) ==")
    shifts = PILOT_WORKERS * PILOT_WEEKS * 6  # ASSUMPTION: 6 shifts/week
    print(f"  worker-shifts in a {PILOT_WEEKS}-week, {PILOT_WORKERS}-worker pilot (6 shifts/wk): {shifts:,}")
    for n in (100, 300, 1000):
        for deff in (1.0, 2.0):  # ASSUMPTION: design effect for clustering by crew
            hw = 1.96 * math.sqrt(0.25 * deff / n)  # worst case p = 0.5
            print(f"  n={n:>5} prescriptions, DEFF={deff:.0f}: 95% CI half-width <= +/-{100*hw:.1f} percentage points")


def undesa(path):
    import pandas as pd  # optional dependency
    print("\n== 5. UN DESA International Migrant Stock 2024: destination UAE, top origins ==")
    df = pd.read_excel(path, sheet_name="Table 1", header=None, skiprows=11)
    uae = df[df[1].astype(str).str.strip() == "United Arab Emirates"]
    total = float(uae[uae[5].astype(str).str.strip() == "World"][14].iloc[0])
    c = uae[pd.to_numeric(uae[6], errors="coerce") < 900].copy()
    c[14] = pd.to_numeric(c[14], errors="coerce")
    c = c.sort_values(14, ascending=False).head(10)
    print(f"  total mid-2024 = {total:,.0f}")
    for i, (_, r) in enumerate(c.iterrows(), 1):
        print(f"  {i:>2}. {str(r[5]).strip():<22s}{r[14]:>12,.0f}  {100*r[14]/total:5.1f}%")
    nep = uae[uae[5].astype(str).str.strip() == "Nepal"][14]
    if len(nep):
        print(f"  (Nepal: {float(nep.iloc[0]):,.0f} - likely undercount vs Nepal DoFE permit flows; see markdown)")


if __name__ == "__main__":
    market_sizing()
    messaging_costs()
    pilot_event_counts()
    pilot_precision()
    if len(sys.argv) > 1:
        undesa(sys.argv[1])
