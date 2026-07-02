// Headless tests for the shared tool decision logic (security camera + clips).
// Run:  node web/tests/tools.test.mjs
import { pickMotionEvent } from "../js/tools/motion-trigger.js";
import { clipEventAction, shouldFinalizeClip } from "../js/tools/clip-series.js";
import { coverMap, frameToScreenPoint, screenToFramePoint } from "../js/tools/cover-map.js";
import { createSettingsBinder } from "../js/tools/settings.js";
import { makeZip } from "../js/tools/zip.js";

let pass = 0, fail = 0;
const ok = (name, cond, info) => { console.log((cond ? "PASS " : "FAIL ") + name + (info ? "  " + info : "")); cond ? pass++ : fail++; };

// track helper: existed [firstT..lastT], seen `frames` times
const trk = (id, firstT, lastT, frames) => ({ id, firstT, lastT, framesSeen: frames });
const OPTS = { minDurationMs: 1000, cooldownMs: 5000, lastEventT: 0, now: 10000 };

// pickMotionEvent
ok("pick: none when no tracks", pickMotionEvent([], OPTS) === null);
ok("pick: skips too-short tracks",
  pickMotionEvent([trk(1, 9500, 10000, 5)], OPTS) === null, "dur 500 < 1000");
ok("pick: qualifies at exact min duration",
  pickMotionEvent([trk(1, 9000, 10000, 5)], OPTS)?.id === 1, "dur 1000 == min");
ok("pick: chooses most frames among qualifying",
  pickMotionEvent([trk(1, 8000, 10000, 4), trk(2, 8000, 10000, 9)], OPTS)?.id === 2);
ok("pick: null inside cooldown",
  pickMotionEvent([trk(1, 0, 10000, 20)], { ...OPTS, lastEventT: 6000 }) === null, "now-last=4000<5000");
ok("pick: fires at exact cooldown boundary",
  pickMotionEvent([trk(1, 0, 10000, 20)], { ...OPTS, lastEventT: 5000 })?.id === 1, "now-last=5000");

// clipEventAction
ok("clip: start when no active clip", clipEventAction(null, 1000, { seriesGapMs: 8000 }) === "start");
ok("clip: append within gap",
  clipEventAction({ lastEventT: 1000 }, 5000, { seriesGapMs: 8000 }) === "append");
ok("clip: append at exact gap boundary",
  clipEventAction({ lastEventT: 1000 }, 9000, { seriesGapMs: 8000 }) === "append", "diff 8000 == gap");
ok("clip: rotate beyond gap",
  clipEventAction({ lastEventT: 1000 }, 9001, { seriesGapMs: 8000 }) === "rotate");

// shouldFinalizeClip
ok("finalize: false when no clip", shouldFinalizeClip(null, 9999, { postRollMs: 3000, seriesGapMs: 8000 }) === false);
ok("finalize: true once quiet >= max(post, gap)",
  shouldFinalizeClip({ lastEventT: 1000 }, 9000, { postRollMs: 3000, seriesGapMs: 8000 }) === true, "quiet 8000 == max");
ok("finalize: false while still within window",
  shouldFinalizeClip({ lastEventT: 1000 }, 8999, { postRollMs: 3000, seriesGapMs: 8000 }) === false);
ok("finalize: uses postRoll when it is larger",
  shouldFinalizeClip({ lastEventT: 0 }, 10000, { postRollMs: 10000, seriesGapMs: 3000 }) === true);

// makeZip — valid store-only archive structure
const zipBytes = new Uint8Array(await makeZip([
  { name: "a.txt", data: new TextEncoder().encode("hello") },
]).arrayBuffer());
const zipText = new TextDecoder("latin1").decode(zipBytes);
ok("zip: local file header signature (PK\\x03\\x04)",
  zipBytes[0] === 0x50 && zipBytes[1] === 0x4b && zipBytes[2] === 0x03 && zipBytes[3] === 0x04);
ok("zip: contains the entry name", zipText.includes("a.txt"));
ok("zip: stores the file data uncompressed", zipText.includes("hello"));
ok("zip: has end-of-central-directory record", zipText.includes("PK\x05\x06"));

// cover-map
const map = coverMap({ videoWidth: 640, videoHeight: 480, drawWidth: 320, drawHeight: 320 });
ok("cover: fills square by height", map.w === 426.66666666666663 && map.h === 320);
ok("cover: centers cropped width", Math.round(map.ox) === -53 && map.oy === 0);
const screen = frameToScreenPoint({ x: 0.5, y: 0.5 }, map);
ok("cover: frame center maps to screen center", Math.round(screen.x) === 160 && Math.round(screen.y) === 160);
const frame = screenToFramePoint(screen.x, screen.y, map);
ok("cover: screen center maps back to frame center", frame.x === 0.5 && frame.y === 0.5);
const mirrored = coverMap({ videoWidth: 100, videoHeight: 100, drawWidth: 100, drawHeight: 100, mirror: true });
ok("cover: mirror flips x from frame to screen", frameToScreenPoint({ x: 0.25, y: 0.5 }, mirrored).x === 75);
ok("cover: mirror flips x from screen to frame", screenToFramePoint(75, 50, mirrored).x === 0.25);

// settings binder
function fakeInput({ value = "", type = "text", min = "", max = "" } = {}) {
  const listeners = {};
  return {
    value,
    type,
    min,
    max,
    checked: false,
    addEventListener(name, fn) {
      listeners[name] = listeners[name] || [];
      listeners[name].push(fn);
    },
    dispatch(name) {
      for (const fn of listeners[name] || []) fn({ target: this });
    },
  };
}
const controls = {
  checkbox: fakeInput({ type: "checkbox" }),
  range: fakeInput({ value: "5", min: "1", max: "10" }),
  number: fakeInput({ value: "5", min: "1", max: "10" }),
};
const boundSettings = {};
const changes = [];
const binder = createSettingsBinder({
  $: (id) => controls[id],
  settings: boundSettings,
  onChange: (change) => changes.push(change),
});
binder.bind("checkbox", "enabled");
controls.checkbox.checked = true;
controls.checkbox.dispatch("change");
ok("settings: bind writes checkbox boolean", boundSettings.enabled === true);
ok("settings: bind calls onChange", changes[0]?.key === "enabled" && changes[0]?.value === true);
let committed = null;
binder.bindNumberPair("range", "number", "delayMs", {
  transform: (value) => value * 1000,
  onCommit: (change) => { committed = change; },
});
controls.range.value = "12";
controls.range.dispatch("input");
ok("settings: number pair clamps and transforms", boundSettings.delayMs === 10000);
ok("settings: number pair syncs controls", controls.range.value === 10 && controls.number.value === 10);
controls.number.value = "2";
controls.number.dispatch("change");
ok("settings: number pair commits on change", committed?.key === "delayMs" && committed?.value === 2000);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
