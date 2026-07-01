import { defineUse } from "../engine/use.js";
import { flowPerHour } from "../engine/derive.js";

// Capture & count: things crossing a line, capturing stills on crossing.
export default defineUse({
  id: "capture",
  name: "Count Line Crossings and Capture Stills",
  description: "Count crossings and capture still images of each event locally on the device.",
  mode: "motion",
  locate: "BearingOnly",
  measurements: ["crossings", "direction", "bearing_deg", "media"],
  setup: [
    "Choose a crossing line in the scene.",
    "Enable still captures in Settings if desired.",
    "Navigate captured stills directly within the app.",
  ],
  outputs: [
    "Crossing totals with stills",
    "Direction split",
    "Interactive still viewer",
  ],

  measureStatus: "implemented",
  config: {
    "Sensing mode": "motion (frame-to-frame difference)",
    "Locate backend": "BearingOnly — no calibration needed",
    "Crossing line": "user-drawn line",
    "Still captures": "on crossing (toggleable)",
  },

  measure(track, ctx, { locate }) {
    const lineX = ctx.countLineX ?? ctx.width / 2;
    const curX = track.ground.x;
    const prevX = curX - track.velocity.x;
    const crossed = (prevX - lineX) * (curX - lineX) < 0;
    if (!crossed) return null;
    const direction = track.velocity.x >= 0 ? "right" : "left";
    const { bearingDeg } = locate.locate(track, ctx);
    return { crossings: 1, direction, bearing_deg: Math.round(bearingDeg * 10) / 10 };
  },

  deriveFindings(observations) {
    let left = 0, right = 0;
    for (const o of observations) o.direction === "left" ? left++ : right++;
    return {
      crossings: observations.length,
      byDirection: { left, right },
      flowPerHour: Math.round(flowPerHour(observations)),
    };
  },
});
