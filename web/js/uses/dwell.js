import { defineUse } from "../engine/use.js";
import { sessionize, mean, median, round1 } from "../engine/derive.js";

// Dwell & occupancy: how long things linger, how many are present.
// Built from components: each detection is a presence sample; sessionize()
// reconstructs visits from the timestamp gaps and dwell is the visit span.
// Real today (single-identity tracker → peak occupancy is approximate).
export default defineUse({
  id: "dwell",
  name: "Dwell & occupancy",
  description: "Measure how long objects linger in a zone and how many are present — queues, loitering, parking turnover.",
  mode: "motion",
  locate: "GroundPlaneHomography",
  measurements: ["dwell_s", "occupancy"],
  setup: [
    "Draw one or more zones where presence matters.",
    "Use calibration when zone size or position matters.",
    "Expire tracks after they leave the zone.",
  ],
  outputs: [
    "Dwell time per track",
    "Mean and median dwell",
    "Peak occupancy",
  ],

  measureStatus: "implemented",
  config: {
    "Sensing mode": "motion (frame-to-frame difference)",
    "Locate backend": "GroundPlaneHomography — only needed for real-world zone sizing",
    "Visit gap": "3 s without detection ends a visit (sessionize default)",
    "Dwell": "first-to-last detection within a visit",
    "Occupancy": "approximate — single-identity tracker",
    "Leaves device": "dwell / occupancy findings only — never footage",
  },

  // One presence sample per detection; visits (and therefore dwell) are
  // reconstructed in deriveFindings by clustering the sample timestamps.
  measure(track) {
    return { occupancy: 1, x: Math.round(track.ground.x) };
  },

  deriveFindings(observations) {
    const visits = sessionize(observations);
    const durations = visits.map((v) => v.durationS);
    return {
      visits: visits.length,
      meanDwellS: round1(mean(durations)),
      medianDwellS: round1(median(durations)),
      peakOccupancy: observations.length ? 1 : 0, // single-identity tracker
    };
  },
});
