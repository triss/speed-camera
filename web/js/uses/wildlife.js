import { defineUse } from "../engine/use.js";
import { tally, byHour } from "../engine/derive.js";

// Wildlife log: trail-cam style record of animal appearances.
// Built from components: KnownSizeRanger locate (size band needs an object-size
// reference, so measure surfaces a stub until that lands) + byHour / tally
// aggregation, which is implemented over whatever appearances are logged.
export default defineUse({
  id: "wildlife",
  name: "Wildlife log",
  description: "Log animal appearances trail-cam style: time of day, rough size class, and how long they stayed.",
  mode: "motion",
  locate: "KnownSizeRanger",
  measurements: ["size_class", "time_of_day", "dwell_s"],
  setup: [
    "Aim at a fixed path, feeding station, burrow, or garden edge.",
    "Use low thresholds so small slow movement is not discarded.",
    "Keep identifying images local unless explicitly exported.",
  ],
  outputs: [
    "Appearance timestamps",
    "Rough size class",
    "Dwell time by visit",
  ],

  measureStatus: "Needs a KnownSizeRanger size reference before it can size animals.",
  config: {
    "Sensing mode": "motion (frame-to-frame difference)",
    "Locate backend": "KnownSizeRanger — requires an object-size reference",
    "Size reference": "not yet provided",
    "Sensitivity": "low thresholds, to catch small / slow movement",
    "Logged": "appearances by hour, rough size class",
    "Leaves device": "findings only; identifying stills stay local unless exported",
  },

  // Size band needs the ranger backend; it throws until a size reference is
  // configured. Once it returns a size, this records one appearance.
  measure(track, ctx, { locate }) {
    const ranged = locate.locate(track, ctx); // KnownSizeRanger: throws (stub)
    return { size_class: ranged.size_class };
  },

  deriveFindings(observations) {
    return {
      appearances: observations.length,
      byHour: byHour(observations),
      sizeClasses: tally(observations, "size_class"),
    };
  },
});
