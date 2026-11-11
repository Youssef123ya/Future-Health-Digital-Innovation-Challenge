// Cross-check: run the OFFICIAL USARIEM estimateTcore.js (Buller) on the scenario HR series
// and write per-minute outputs, so the Python oracle (and later the TS port) can be compared.
// Usage: node crosscheck_js.mjs <path/to/estimateTcore.js> <input.json> <output.json>
// The JS file is a single pure arithmetic function (inspected manually before use).
import { readFileSync, writeFileSync } from "node:fs";

const [, , jsPath, inPath, outPath] = process.argv;
const src = readFileSync(jsPath, "utf8");
if (/require\(|import\s|process\.|fetch\(|XMLHttpRequest|eval\(/.test(src)) {
  throw new Error("Unexpected constructs in estimateTcore.js - refusing to evaluate");
}
// eslint-disable-next-line no-new-func
const estimateTcore = new Function(`${src}\nreturn estimateTcore;`)();

const scenarios = JSON.parse(readFileSync(inPath, "utf8"));
const out = {};
for (const [name, hrs] of Object.entries(scenarios)) {
  let tc = 37.1; // official app default (input#tcstart value="37.1")
  let v = 0;     // official app: var v0 = 0
  const ct = [];
  const vv = [];
  for (const hr of hrs) {
    const r = estimateTcore(tc, v, hr);
    tc = r.tc_current;
    v = r.v_current;
    ct.push(tc);
    vv.push(v);
  }
  out[name] = { ct, v: vv };
}
writeFileSync(outPath, JSON.stringify(out));
console.log(`official JS evaluated on ${Object.keys(out).length} scenarios -> ${outPath}`);
