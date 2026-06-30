import { definePreset } from "../engine/preset.js";

// Wildlife log: trail-cam style record of animal appearances.
export default definePreset({
  id: "wildlife",
  name: "Wildlife log",
  summary: "Log animal appearances trail-cam style: time of day, rough size class, and how long they stayed.",
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
  // TODO measure(track, ctx):  size band + dwell; optional event still
  // TODO summarise(events):    appearances by hour, size distribution
});
