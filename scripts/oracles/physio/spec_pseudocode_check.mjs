// Verifies that the pseudo-code printed in physio_and_clinical.md section 10 (transcribed here as plain JS)
// reproduces the oracle fixtures. Usage: node spec_pseudocode_check.mjs out/physio_fixtures.json out/clinical_rules_fixtures.json
import { readFileSync } from "node:fs";

const fx = JSON.parse(readFileSync(process.argv[2], "utf8"));
const rules = JSON.parse(readFileSync(process.argv[3], "utf8"));

const ECTEMP = { A: 1.0, GAMMA2: 0.022 ** 2, B0: -7887.1, B1: 384.4286, B2: -4.5714, SIGMA2: 18.88 ** 2 };
const SIG = { A: 41, K: 193, Q: 0.06, B: 0.89, M: 37.84, NU: 0.07 };

function ectempStep(ctPrev, vPrev, hr, rScale = 1, model = "quad") {
  const ctPred = ECTEMP.A * ctPrev;
  const vPred = ECTEMP.A ** 2 * vPrev + ECTEMP.GAMMA2;
  if (hr === null || !Number.isFinite(rScale)) return { ct: ctPred, v: vPred };
  let c, h;
  if (model === "quad") {
    c = 2 * ECTEMP.B2 * ctPred + ECTEMP.B1;
    h = ECTEMP.B2 * ctPred ** 2 + ECTEMP.B1 * ctPred + ECTEMP.B0;
  } else {
    const e = Math.exp(-SIG.B * (ctPred - SIG.M));
    h = SIG.A + (SIG.K - SIG.A) / (1 + SIG.Q * e) ** (1 / SIG.NU);
    c = ((SIG.K - SIG.A) * SIG.Q * SIG.B) / SIG.NU * e * (1 + SIG.Q * e) ** (-(1 / SIG.NU) - 1);
  }
  if (c <= 0) return { ct: ctPred, v: vPred };
  const k = (vPred * c) / (c ** 2 * vPred + ECTEMP.SIGMA2 * rScale);
  return { ct: ctPred + k * (hr - h), v: (1 - k * c) * vPred };
}

let worst = 0, n = 0;
for (const vec of fx.ectemp_vectors) {
  for (const model of ["quad", "sig"]) {
    const key = model === "quad" ? "ct_quadratic" : "ct_sigmoid";
    if (!vec[key]) continue;
    let ct = vec.ct0, v = vec.v0;
    vec.hr.forEach((hr, i) => {
      const rs = vec.r_scale ?? 1;
      ({ ct, v } = ectempStep(ct, v, hr, rs, model));
      worst = Math.max(worst, Math.abs(ct - vec[key][i]));
      n++;
    });
  }
}
console.log(`ECTemp pseudo-code vs fixtures: ${n} minute-steps, worst |dCT| = ${worst.toExponential(3)}`);

// PSI
const band = (p) => { const x = Math.ceil(Math.round(Math.max(0, p) * 1e9) / 1e9);
  return x <= 2 ? "no_little" : x <= 4 ? "low" : x <= 6 ? "moderate" : x <= 8 ? "high" : "very_high"; };
let psiOk = true;
for (const p of fx.psi_vectors) {
  const psi = 5 * (p.ct - p.ct0) / (39.5 - p.ct0) + 5 * (p.hr - p.hr0) / (180 - p.hr0);
  if (Math.abs(psi - p.psi) > 1e-6 || band(psi) !== p.category) psiOk = false;
}
for (const a of fx.apsi_vectors) {
  const hrCrit = 0.9 * (220 - a.age);
  const ctCrit = a.tsk == null ? 39.5 : 39.5 + ((a.ct - a.tsk) - 4) / 4;
  const v = 5 * (a.ct - a.ct_rest) / (ctCrit - a.ct_rest) + 5 * (a.hr - a.hr_rest) / (hrCrit - a.hr_rest);
  if (Math.abs(v - a.apsi) > 1e-6) psiOk = false;
}
console.log(`PSI/aPSI pseudo-code vs fixtures: ${psiOk ? "PASS" : "FAIL"}`);

// SQI
const SQI = { HR_MIN: 40, HR_MAX: 200, SEG_S: 10, RATIO_MAX: 2.2, FLAT_MIN_SAMPLES: 10, PSI_MIN: 0.8 };
function minuteSqi(samples, intervalS) {
  const pts = samples.filter((s) => s[1] !== null);
  const valid = pts.map(([, b, ok]) => ok && b >= SQI.HR_MIN && b <= SQI.HR_MAX);
  for (let s = 0; s < 6; s++) {
    const idx = pts.map((p, j) => [p, j]).filter(([p]) => p[0] >= s * 10 && p[0] < (s + 1) * 10 && p[1] > 0).map(([, j]) => j);
    const seg = idx.map((j) => pts[j][1]);
    if (seg.length >= 2 && Math.max(...seg) / Math.min(...seg) >= SQI.RATIO_MAX) idx.forEach((j) => (valid[j] = false));
  }
  const hs = pts.map((p) => p[1]);
  if (hs.length >= SQI.FLAT_MIN_SAMPLES && Math.max(...hs) === Math.min(...hs)) valid.fill(false);
  const nValid = valid.filter(Boolean).length;
  const psi = Math.min(1, nValid / Math.round(60 / intervalS));
  const ok = psi >= SQI.PSI_MIN && nValid > 0;
  return { psi, ok, rScale: ok ? Math.exp(psi ** -2 - 1) : null };
}
let sqiOk = true;
for (const s of fx.sqi_vectors) {
  const r = minuteSqi(s.samples, s.expected_interval_s);
  if (Math.abs(r.psi - s.psi) > 1e-6 || r.ok !== s.valid ||
      (s.r_scale !== null && Math.abs(r.rScale - s.r_scale) > 1e-6)) { sqiOk = false; console.log("SQI mismatch", s.name, r); }
}
console.log(`SQI pseudo-code vs fixtures: ${sqiOk ? "PASS" : "FAIL"}`);

// Fusion
let fuseOk = rules.fusion_vectors.every((f) => Math.max(f.env, f.physio ?? f.env, f.symptom ?? f.env) === f.expected);
console.log(`Fusion vs fixtures: ${fuseOk ? "PASS" : "FAIL"}`);
const pass = worst < 1e-9 && psiOk && sqiOk && fuseOk;
console.log(pass ? "ALL PASS" : "SOME FAIL");
process.exit(pass ? 0 : 1);
