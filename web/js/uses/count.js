import { defineUse } from "../engine/use.js";
import { flowPerHour } from "../engine/derive.js";

// Counting / footfall: things crossing a line or entering a zone.
// Built from components: BearingOnly locate + a centre-line crossing test +
// flowPerHour aggregation. This use is fully implemented (no stubs).
export default defineUse({
  id: "count",
  name: "Counts & footfall",
  description: "Count people, cyclists or vehicles crossing a line or entering a zone, with direction and flow rate.",
  mode: "motion",
  locate: "BearingOnly",
  measurements: ["crossings", "direction", "bearing_deg"],
  setup: [
    "Choose a crossing line or entry zone in the scene.",
    "Keep the camera fixed while counting.",
    "Optionally split totals by direction.",
  ],
  outputs: [
    "Crossing totals",
    "Direction split",
    "Estimated flow per hour",
  ],

  measureStatus: "implemented",
  config: {
    "Sensing mode": "motion (frame-to-frame difference)",
    "Locate backend": "BearingOnly — no calibration needed",
    "Crossing line": "frame centre (x = width ÷ 2)",
    "Camera field of view": "60° horizontal (BearingOnly assumption)",
    "Motion gate": "0.012 frame energy (pipeline default)",
    "Pixel-change threshold": "25 / 255 (detect default)",
    "Leaves device": "findings only (counts, direction, flow) — never footage",
  },

  // A crossing happens when the track's ground point moves across the line
  // between the previous and current frame (prev = current − velocity).
  measure(track, ctx, { locate }) {
    const lineX = ctx.countLineX ?? ctx.width / 2;
    const curX = track.ground.x;
    const prevX = curX - track.velocity.x;
    const crossed = (prevX - lineX) * (curX - lineX) < 0;
    if (!crossed) return null; // detection, but nothing crossed this frame
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
