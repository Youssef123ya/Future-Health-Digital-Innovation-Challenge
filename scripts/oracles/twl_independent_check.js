// Independent fact-check implementation of the Thermal Work Limit (TWL).
// Written from Brake & Bates (2002) AEOH 17(3) Appendix 1 (equations read from the PDF page images)
// plus the helper choices the note documents as its own (Tetens psat, A = 0.000644, fr on hr).
// Deliberately NOT a copy of scripts/oracles/twl_oracle.py: different language, finer scan,
// Brent-free bisection on f(t) with a 0.01 K bracket, and its own ISO 7726 helper.
// Usage: node twl_independent.js <path-to-fixtures/twl.json>
'use strict';
const fs = require('fs');

const TCORE = 38.2, SRMAX = 0.67, FR = 0.73, LR = 16.5;
const LSR = 2430e3 / 3600;            // lambda = 2430 kJ/kg -> W m-2 per (kg m-2 h-1) = 675

const PSAT = {
  tetens6105: t => 0.6105 * Math.exp(17.27 * t / (t + 237.3)),
  tetens61078: t => 0.61078 * Math.exp(17.27 * t / (t + 237.3)),
  buck1981: t => 0.61121 * Math.exp((18.678 - t / 234.5) * (t / (257.14 + t))),
  // Hyland & Wexler (1983) over water, T in K, result Pa -> kPa
  hylandWexler: t => {
    const T = t + 273.15;
    return Math.exp(-5.8002206e3 / T + 1.3914993 - 4.8640239e-2 * T + 4.1764768e-5 * T * T
      - 1.4452093e-8 * T * T * T + 6.5459673 * Math.log(T)) / 1000;
  },
};

function makeModel({ psat = PSAT.tetens6105, A = 0.000644, useFr = true } = {}) {
  const paFromTwb = (tdb, twb, P) => Math.max(psat(twb) - A * P * (tdb - twb), 0);
  const paFromRh = (tdb, rh) => Math.max(rh, 0) / 100 * psat(tdb);

  function balance(tsk, c) {
    const tsig = 0.1 * tsk + 0.9 * TCORE;                         // Cabanac
    const Kcs = 84 + 72 * Math.tanh(1.3 * (tsig - 37.9));          // fitted to Fig. 1
    const H = Kcs * (TCORE - tsk);                                 // EESAM 23
    let Sr = 0.42 + 0.44 * Math.tanh(1.16 * (tsig - 37.4));        // fitted to Fig. 2
    Sr = Math.min(Math.max(Sr, 0), SRMAX);
    const lSr = LSR * Sr;
    const hc = 0.608 * Math.pow(c.P, 0.6) * Math.pow(c.v, 0.6);    // EESAM 13
    const hr = 4.61 * Math.pow(1 + (c.tr + tsk) / 546, 3);         // EESAM 9
    const hrE = useFr ? FR * hr : hr;
    const h = hrE + hc;
    const to = (hrE * c.tr + hc * c.ta) / h;
    const fcl = 1 + 0.3 * c.Icl, Rcl = 0.155 * c.Icl;
    const Fcle = fcl / (1 + fcl * h * Rcl);
    const dry = Fcle * h * (tsk - to);
    const he = 1587 * hc * c.P / Math.pow(c.P - c.pa, 2);         // EESAM 17
    const Recl = c.Icl > 0 ? Rcl / (LR * c.icl) : 0;
    const Fpcl = 1 / (1 + fcl * he * Recl);
    const Emax = Fpcl * fcl * he * (psat(tsk) - c.pa);
    let E = 0, x = Infinity;
    if (Emax > 0) {
      x = lSr / Emax;
      if (c.variant === 'physical') {
        E = x < 0.46 ? lSr : (x <= 1.7 ? lSr * Math.exp(-0.4127 * Math.pow(x - 0.46, 1.168)) : Emax);
      } else if (c.variant === 'alt_1p8') {
        const X = 1.8 * x;
        E = X < 0.46 ? 1.8 * lSr : (X <= 1.7 ? 1.8 * lSr * Math.exp(-0.4127 * Math.pow(X - 0.46, 1.168)) : Emax);
      } else if (c.variant === 'literal') {           // equation exactly as printed
        E = x < 0.46 ? lSr : (x <= 1.7 ? lSr * Math.exp(-0.4127 * Math.pow(1.8 * x - 0.46, 1.168)) : Emax);
      } else throw new Error(c.variant);
      E = Math.min(E, Emax);
    }
    return { H, loss: dry + E, Sr, Emax, E, x };
  }

  function twl({ tdb, tr, v, P, twb, rh, pa, Icl = 0.35, icl = 0.45, variant = 'physical' }) {
    if (pa === undefined) pa = twb !== undefined ? paFromTwb(tdb, twb, P) : paFromRh(tdb, rh);
    const vv = Math.min(Math.max(v, 0.2), 4.0);
    const c = { ta: tdb, tr, v: vv, P, pa, Icl, icl, variant };
    const f = t => { const b = balance(t, c); return b.H - b.loss; };
    const den = 1 - 0.0014 * (34 - tdb) - 0.0173 * (5.87 - pa);
    const tHi = TCORE - 1e-6;
    if (f(tHi) >= 0) return { twl: 0, tsk: tHi, pa, flag: 'NO_ROOT' };
    let a = null, b = null;
    for (let t = tHi; t > 20; t -= 0.01) {               // finer scan than the oracle (0.05 K)
      const tn = t - 0.01;
      if (f(tn) >= 0) { a = tn; b = t; break; }
    }
    if (a === null) { const q = balance(20, c); return { twl: q.H / den, tsk: 20, pa, flag: 'NO_ROOT_20' }; }
    for (let i = 0; i < 300 && b - a > 1e-12; i++) { const m = (a + b) / 2; if (f(m) >= 0) a = m; else b = m; }
    const tsk = (a + b) / 2, q = balance(tsk, c);
    return { twl: q.H / den, tsk, pa, x: q.x, Sr: q.Sr, H: q.H };
  }
  return { twl, balance, paFromTwb, paFromRh, psat };
}

// ISO 7726:1998 Annex B (independent transcription)
function mrtIso(tg, ta, v, D = 0.15, eps = 0.95) {
  const sigma = 5.67e-8;
  const hcg = Math.max(1.4 * Math.pow(Math.abs(tg - ta) / D, 0.25), 6.3 * Math.pow(Math.max(v, 0), 0.6) / Math.pow(D, 0.4));
  return Math.pow(Math.pow(tg + 273.15, 4) + hcg / (eps * sigma) * (tg - ta), 0.25) - 273.15;
}

// Brake & Bates 2002 Table I, transcribed independently from the PDF page (null = n/p)
const TABLE_I = [
  { blk: 'A', dmrt: 2, v: 0.2, P: 101, Icl: 0.45, icl: 0.45,
    rows: { 34: [175, 157, 136, 114, null], 36: [170, 151, 131, 109, null], 38: [164, 145, 125, 103, null],
            40: [158, 140, 120, null, null], 42: [152, 134, 114, null, null] } },
  { blk: 'B', dmrt: 0, v: 0.5, P: 115, Icl: 0.69, icl: 0.40,
    rows: { 34: [181, 161, 140, 118, null], 36: [176, 156, 136, 113, null], 38: [171, 152, 131, 109, null],
            40: [166, 147, 126, 104, null], 42: [161, 142, 122, null, null] } },
  { blk: 'C', dmrt: 3, v: 1.5, P: 80, Icl: 0.35, icl: 0.45,
    rows: { 34: [288, 260, 229, 193, 154], 36: [282, 254, 222, 187, 148], 38: [276, 248, 216, 181, 141],
            40: [270, 242, 210, 174, 135], 42: [264, 235, 203, 167, 128] } },
];
const WBS = [24, 26, 28, 30, 32];

function tableStats(model, variant) {
  const errs = [], np = [], errsA = [], zc = [], lowx = [];
  for (const b of TABLE_I) for (const [db, vals] of Object.entries(b.rows)) vals.forEach((pub, i) => {
    const r = model.twl({ tdb: +db, twb: WBS[i], tr: +db + b.dmrt, v: b.v, P: b.P, Icl: b.Icl, icl: b.icl, variant });
    if (pub === null) { np.push(r.twl); return; }
    const e = r.twl - pub; errs.push(e); if (b.blk === 'A') errsA.push(e);
    if (variant === 'physical') { if (r.x > 1.7) zc.push(e); else lowx.push([b.blk, +db, WBS[i], pub, +r.twl.toFixed(1), +r.x.toFixed(2)]); }
  });
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const rms = a => Math.sqrt(mean(a.map(x => x * x)));
  return { n: errs.length, n_np: np.length, mean: mean(errs), rms: rms(errs), min: Math.min(...errs), max: Math.max(...errs),
           maxAbs: Math.max(...errs.map(Math.abs)), meanA: mean(errsA), npMax: Math.max(...np),
           nZoneC: zc.length, zoneCmaxAbs: zc.length ? Math.max(...zc.map(Math.abs)) : null, lowx };
}

const out = {};
const M = makeModel();

// 1. Fixture vectors
const fx = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let worstTwl = 0, worstTsk = 0, worstAlt = 0, worstId = '', nVec = 0, tskRange = [99, -99];
const rows = [];
for (const vec of fx.vectors) {
  const I = vec.inputs, E = vec.expected;
  const tr = I.tg_c !== null && I.tg_c !== undefined ? mrtIso(I.tg_c, I.tdb_c, I.wind_m_s, I.globe_diameter_m) : I.mrt_c;
  const hum = I.humidity_input === 'rh' ? { rh: I.rh_pct } : { twb: I.twb_psychrometric_c };
  const base = { tdb: I.tdb_c, tr, v: I.wind_m_s, P: I.pressure_kpa, Icl: I.icl_clo, icl: I.icl_vapour_perm, ...hum };
  const r = M.twl({ ...base, variant: 'physical' });
  const ra = M.twl({ ...base, variant: 'alt_1p8' });
  const dT = Math.abs(r.twl - E.twl_w_m2), dS = Math.abs(r.tsk - E.tsk_c), dA = Math.abs(ra.twl - E.twl_alt_1p8_w_m2);
  if (dT > worstTwl) { worstTwl = dT; worstId = vec.id; }
  worstTsk = Math.max(worstTsk, dS); worstAlt = Math.max(worstAlt, dA); nVec++;
  if (r.twl > 0 && I.tdb_c >= 30) { tskRange[0] = Math.min(tskRange[0], r.tsk); tskRange[1] = Math.max(tskRange[1], r.tsk); }
  rows.push([vec.id, +r.twl.toFixed(3), E.twl_w_m2, +ra.twl.toFixed(3), E.twl_alt_1p8_w_m2, +r.tsk.toFixed(4), E.tsk_c]);
}
out.fixture = { nVec, worstTwlAbs: worstTwl, worstId, worstTskAbs: worstTsk, worstAltAbs: worstAlt, tskRangeHot: tskRange };
out.fixtureRows = rows;

// 2. Table I statistics for the three readings, plus the fr ablation
out.tableI = { physical: tableStats(M, 'physical'), alt_1p8: tableStats(M, 'alt_1p8'), literal: tableStats(M, 'literal') };
out.tableI_noFr_physical = tableStats(makeModel({ useFr: false }), 'physical');
out.tableI_noFr_alt = tableStats(makeModel({ useFr: false }), 'alt_1p8');

// 3. Helper sensitivity: psat formula and psychrometric coefficient (zone-C cells + alt_1p8 rms)
out.helperFit = {};
for (const [name, ps] of Object.entries(PSAT)) for (const A of [0.000644, 0.000662, 0.00066]) {
  const m = makeModel({ psat: ps, A });
  const s1 = tableStats(m, 'alt_1p8'), s2 = tableStats(m, 'physical');
  out.helperFit[`${name}|A=${A}`] = { alt_rms: +s1.rms.toFixed(3), alt_maxAbs: +s1.maxAbs.toFixed(3), phys_zoneC_maxAbs: +s2.zoneCmaxAbs.toFixed(3), phys_rms: +s2.rms.toFixed(3) };
}

// 4. Worked examples and AOH 2002 Table 2 / Table 1
const ex = (o) => +M.twl(o).twl.toFixed(2);
out.examples = {
  p180_110: ex({ tdb: 40, twb: 30, tr: 40, v: 0.2, P: 100 }),
  p181_158: ex({ tdb: 40, twb: 30, tr: 40, v: 0.7, P: 100 }),
  app2_220: ex({ tdb: 35, twb: 26, tr: 35, v: 0.5, P: 100 }),
  aoh_T2A_132: ex({ tdb: 38, twb: 28, tr: 38, v: 0.2, P: 100 }),
  aoh_T2B_243: ex({ tdb: 38, twb: 28, tr: 38, v: 3.0, P: 100 }),
  aoh_T2C_154: ex({ tdb: 31, twb: 28, tr: 31, v: 0.2, P: 100 }),
  aoh_T2D_263: ex({ tdb: 31, twb: 28, tr: 31, v: 3.0, P: 100 }),
};
const wbAt = (dT, v, target = 140) => { let lo = 15, hi = 40; for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (M.twl({ tdb: m + dT, twb: m, tr: m + dT, v, P: 100 }).twl > target) lo = m; else hi = m; } return +((lo + hi) / 2).toFixed(2); };
out.aohTable1 = { hotDry02: wbAt(10, 0.2), hotDry3: wbAt(10, 3.0), hotHumid02: wbAt(3, 0.2), hotHumid3: wbAt(3, 3.0) };

// 5. Miller & Bates 2007 Table 2 (0.12 clo; MRT = DB, P = 101.3, icl 0.45 assumed)
const MB = [[38.7, 28.6, 0.23, 154], [38.4, 28.7, 0.24, 156], [39.0, 28.1, 0.23, 160], [38.9, 27.6, 0.21, 160], [38.7, 25.0, 0.22, 198],
  [38.1, 27.9, 0.21, 159], [39.1, 27.3, 0.24, 172], [38.6, 27.3, 0.22, 168], [38.3, 27.2, 0.20, 164], [38.3, 27.6, 0.21, 162], [38.2, 28.4, 0.22, 156]];
const mbd = MB.map(([db, wb, v, pub]) => M.twl({ tdb: db, twb: wb, tr: db, v, P: 101.3, Icl: 0.12, icl: 0.45 }).twl - pub);
out.mb2007 = { mean: +(mbd.reduce((s, x) => s + x, 0) / mbd.length).toFixed(2), min: +Math.min(...mbd).toFixed(2), max: +Math.max(...mbd).toFixed(2) };

// 6. H(tsk) peak with tcore = 38.2
let hp = { H: -1, t: 0 };
for (let t = 20; t <= 38.2; t += 0.001) { const s = 0.1 * t + 0.9 * TCORE; const H = (84 + 72 * Math.tanh(1.3 * (s - 37.9))) * (TCORE - t); if (H > hp.H) hp = { H, t }; }
out.Hpeak = { H: +hp.H.toFixed(2), tsk: +hp.t.toFixed(2) };

// 7. Sweat-efficiency arithmetic claims
out.efficiency = {
  physical_at_1p7: Math.exp(-0.4127 * Math.pow(1.24, 1.168)), one_over_1p7: 1 / 1.7,
  literal_eff_at_0p46: Math.exp(-0.4127 * Math.pow(1.8 * 0.46 - 0.46, 1.168)),
  literal_E_over_Emax_at_1p7: 1.7 * Math.exp(-0.4127 * Math.pow(1.8 * 1.7 - 0.46, 1.168)),
};

// 8. Sensitivity block (DB 40, RH 40 %, MRT 65, 1 m/s, P 100)
const S = o => +M.twl({ tdb: 40, rh: 40, tr: 65, v: 1, P: 100, ...o }).twl.toFixed(1);
out.sensitivity = { base: S({}), db41: S({ tdb: 41 }), db41_sameVapourPressure: +M.twl({ tdb: 41, pa: M.paFromRh(40, 40), tr: 65, v: 1, P: 100 }).twl.toFixed(1),
  mrt70: S({ tr: 70 }), wind2: S({ v: 2 }), rh50: S({ rh: 50 }) };

// 9. Globe examples
const m150 = mrtIso(50, 40, 1, 0.15), m25 = mrtIso(50, 40, 1, 0.025);
out.globe = { mrt150: +m150.toFixed(2), twl150: +M.twl({ tdb: 40, rh: 40, tr: m150, v: 1, P: 100 }).twl.toFixed(1),
  mrt25: +m25.toFixed(2), twl25: +M.twl({ tdb: 40, rh: 40, tr: m25, v: 1, P: 100 }).twl.toFixed(1),
  isoForcedConst_D015: 6.3 / (Math.pow(0.15, 0.4) * 0.95 * 5.67e-8) };

// 10. UAE field check (Bates & Schneider 2008 Table 3 means; 150 mm globe; P unknown -> 100 and 101.3)
const BS = [['08:00', 37.9, 21.3, 44.8, 1.4, 237.7], ['12:00', 42.5, 21.8, 52.1, 1.7, 194.8], ['14:00', 44.7, 20.6, 51.8, 2.0, 189.3], ['16:00', 41.0, 19.0, 44.3, 2.4, 230.6]];
out.field = {};
for (const P of [100, 101.3]) out.field[`P=${P}`] = BS.map(([t, db, wb, gt, ws, pub]) => {
  const tr = mrtIso(gt, db, ws, 0.15);
  return [t, pub, +tr.toFixed(1), +M.twl({ tdb: db, twb: wb, tr, v: ws, P }).twl.toFixed(1), +M.twl({ tdb: db, twb: wb, tr, v: ws, P, variant: 'alt_1p8' }).twl.toFixed(1)];
});

// 11. Psychrometric WB check for the Miller & Bates chamber (38-40 DB, 28 WB -> RH?)
out.chamberRH = [38, 39, 40].map(db => +(100 * M.paFromTwb(db, 28, 101.3) / M.psat(db)).toFixed(1));

console.log(JSON.stringify(out, (k, v) => (typeof v === 'number' && !Number.isInteger(v)) ? +v.toPrecision(8) : v, 1));
