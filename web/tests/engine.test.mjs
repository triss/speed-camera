// Headless engine tests. No DOM, no camera — proves the components compose
// into the uses. Run:  node web/tests/engine.test.mjs
import { getUse } from "../js/uses/index.js";
import { createPipeline } from "../js/engine/pipeline.js";
import { percentile, mean, sessionize } from "../js/engine/derive.js";
import { createLocator } from "../js/engine/locate.js";
import { pipelineOf } from "../js/engine/describe.js";
import { observationsToCSV } from "../js/engine/store.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "PASS " : "FAIL ") + name + "  got=" + JSON.stringify(got) + (ok ? "" : " want=" + JSON.stringify(want)));
  ok ? pass++ : fail++;
};
const truthy = (name, cond, info) => { console.log((cond ? "PASS " : "FAIL ") + name + (info ? "  " + info : "")); cond ? pass++ : fail++; };

// derive helpers
eq("percentile p50 of 1..4", percentile([1, 2, 3, 4], 50), 2.5);
eq("percentile p85", percentile([10, 20, 30, 40, 50], 85), 44);
eq("mean", mean([2, 4, 6]), 4);
truthy("sessionize splits on gap", sessionize([{ t: 0 }, { t: 1000 }, { t: 9000 }]).length === 2);

// BearingOnly locate (real)
const bo = createLocator("BearingOnly", { hfov: 60 });
eq("BearingOnly centre", Math.round(bo.locate({ ground: { x: 160 } }, { width: 320 }).bearingDeg), 0);
eq("BearingOnly right edge", Math.round(bo.locate({ ground: { x: 320 } }, { width: 320 }).bearingDeg), 30);

// COUNT end-to-end through the real pipeline (synthetic moving block)
const W = 320, H = 240;
function frame(blockX) {
  const g = new Uint8ClampedArray(W * H);
  for (let y = 80; y < 160; y++) for (let x = blockX; x < blockX + 80 && x < W; x++) g[y * W + x] = 255;
  return g;
}
const cp = createPipeline(getUse("count"));
let t = 0;
for (let bx = 80; bx <= 240; bx += 8) cp.process(frame(bx), { width: W, height: H, t: (t += 50) });
const cf = cp.findings().value;
truthy("count: exactly 1 crossing", cf.crossings === 1, JSON.stringify(cf));
truthy("count: direction = right", cf.byDirection.right === 1 && cf.byDirection.left === 0, JSON.stringify(cf.byDirection));

const persisted = [];
const cpStored = createPipeline(getUse("count"), { onObservation: (o) => persisted.push(o) });
t = 0;
for (let bx = 80; bx <= 240; bx += 8) cpStored.process(frame(bx), { width: W, height: H, t: (t += 50) });
truthy("pipeline emits persistable observations", persisted.length === 1 && persisted[0].use === "count" && persisted[0].t, JSON.stringify(persisted));
eq("observationsToCSV escapes cells", observationsToCSV([
  { id: 1, use: "count", t: 1000, direction: "left, then right", note: 'said "go"' },
]), 'id,use,t,direction,note\n1,count,1000,"left, then right","said ""go"""\n');
eq("observationsToCSV stringifies media references", observationsToCSV([
  { id: 2, use: "count", t: 1000, media: { still_id: 7, still_file: "obs.jpg" } },
]), 'id,use,t,media\n2,count,1000,"{""still_id"":7,""still_file"":""obs.jpg""}"\n');

// SPEED: measure stubs (needs calibration), deriveFindings real
const speed = getUse("speed");
let speedThrew = false;
try { speed.measure({ ground: { x: 1 }, velocity: { x: 1 } }, { width: W }, { locate: createLocator("GroundPlaneHomography") }); }
catch (e) { speedThrew = /calibration/.test(e.message); }
truthy("speed.measure throws needs-calibration", speedThrew);
eq("speed.deriveFindings p85", speed.deriveFindings([{ speed_mph: 20 }, { speed_mph: 30 }, { speed_mph: 40 }]).p85_mph, 37);

// DWELL: real findings from presence samples
const df = getUse("dwell").deriveFindings([{ t: 0 }, { t: 500 }, { t: 1000 }, { t: 9000 }, { t: 9500 }]);
truthy("dwell: 2 visits", df.visits === 2, JSON.stringify(df));

// WILDLIFE: measure stubs via KnownSizeRanger
let wlThrew = false;
try { getUse("wildlife").measure({ ground: { x: 1 } }, { width: W }, { locate: createLocator("KnownSizeRanger") }); }
catch (e) { wlThrew = /size reference/.test(e.message); }
truthy("wildlife.measure throws needs-size-reference", wlThrew);

// ENVIRONMENT: change-mode measure stubs, findings timeline real
let envThrew = false;
try { getUse("environment").measure(); } catch (e) { envThrew = /change-mode/.test(e.message); }
truthy("environment.measure throws change-mode", envThrew);
eq("environment.deriveFindings timeline len", getUse("environment").deriveFindings([{ t: 1, change_pct: 5 }]).timeline.length, 1);

// DESCRIBE: the auditable pipeline listing matches reality
const countMods = pipelineOf(getUse("count"));
truthy("describe: count is fully implemented", countMods.every((m) => m.status === "implemented"), JSON.stringify(countMods.map((m) => m.status)));
const speedMods = pipelineOf(getUse("speed"));
truthy("describe: speed locate+measure are stubs",
  speedMods.find((m) => m.label.startsWith("Locate")).status === "stub" &&
  speedMods.find((m) => m.label === "Measure").status === "stub");
truthy("describe: every motion module has a source link",
  countMods.every((m) => typeof m.src === "string" && m.src.endsWith(".js")));
truthy("describe: every use carries a config block",
  ["count", "speed", "dwell", "wildlife", "environment"].every((id) => Object.keys(getUse(id).config || {}).length > 0));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
