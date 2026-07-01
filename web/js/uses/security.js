import { defineUse } from "../engine/use.js";
import { byHour } from "../engine/derive.js";

// Security camera: a lightweight, on-device motion log for a doorway, yard, or
// shed — not a cloud camera. Built from existing components: no positioning
// ("none" locate), whole-frame motion events, optional stills, and byHour
// aggregation.
export default defineUse({
  id: "security",
  name: "Security camera",
  description: "Watch a doorway, yard, or shed and log when something moves in the view — a lightweight, on-device motion log with optional stills, not a cloud camera.",
  mode: "motion",
  locate: "none",
  measurements: ["event", "zone", "time_of_day"],
  setup: [
    "Point the camera at the entrance or area to watch.",
    "Keep the phone fixed while it is watching.",
    "Review the on-device event log and optional stills later.",
  ],
  outputs: [
    "Motion-event timestamps",
    "Which zone triggered",
    "Optional still per event",
  ],

  measureStatus: "implemented",
  config: {
    "Sensing mode": "motion (frame-to-frame difference)",
    "Locate backend": "none (position not needed)",
    "Monitored zone": "whole frame",
    "Arming": "manual start/pause only",
    "Logged": "motion events by time, optional still per event",
    "Leaves device": "event log stays local; stills shared only on explicit action",
  },

  measure(track) {
    return {
      event: 1,
      zone: "whole_frame",
      duration_ms: track.duration_ms ?? track.durationMs ?? null,
      frames_seen: track.frames_seen ?? track.framesSeen ?? null,
    };
  },

  deriveFindings(observations) {
    return {
      events: observations.length,
      byHour: byHour(observations),
    };
  },
});
