// Auditable description of a use: which engine modules it runs, in order, with
// a source link and an implemented/stub status for each. This is what lets a
// mildly-technical community member open a use page and check exactly what runs
// and how it is configured — derived from the live spec + locate registry, so
// it can't drift from the code.

import { createLocator } from "./locate.js";

// Source files are linked relative to a use page (web/*.html), so the links
// work on GitHub Pages and on any self-hosted copy — no external dependency.
const SRC = {
  gray: "js/engine/gray.js",
  detect: "js/engine/detect.js",
  track: "js/engine/track.js",
  locate: "js/engine/locate.js",
};

function locateImplemented(id) {
  try { return createLocator(id).implemented === true; } catch (e) { return false; }
}

// pipelineOf(use) → ordered [{ label, src, status, note }]
export function pipelineOf(use) {
  const useSrc = "js/uses/" + use.id + ".js";

  if (use.mode === "change") {
    return [
      { label: "Reference frame", src: null, status: "stub",
        note: "Capture a stable baseline image. Part of the slow-change pipeline, not wired yet." },
      { label: "Change detection", src: null, status: "stub",
        note: "Compare later frames against the reference at a time-lapse cadence." },
      { label: "Derive findings", src: useSrc, status: "implemented",
        note: "Build the change timeline from logged samples." },
    ];
  }

  const locOk = locateImplemented(use.locate);
  const measureOk = use.measureStatus === "implemented";
  return [
    { label: "Capture & grayscale", src: SRC.gray, status: "implemented",
      note: "Downscale the camera frame and convert it to luma." },
    { label: "Detect motion", src: SRC.detect, status: "implemented",
      note: "Frame differencing → motion energy and a bounding box of the mover." },
    { label: "Track", src: SRC.track, status: "implemented",
      note: "Follow the mover by its ground-contact point (bottom-centre)." },
    { label: "Locate · " + use.locate, src: SRC.locate, status: locOk ? "implemented" : "stub",
      note: locOk ? "Position the mover relative to the camera." : "Backend needs setup before it can position the mover." },
    { label: "Measure", src: useSrc, status: measureOk ? "implemented" : "stub",
      note: measureOk ? "Turn each track into a measurement." : (use.measureStatus || "Not implemented yet.") },
    { label: "Derive findings", src: useSrc, status: "implemented",
      note: "Aggregate observations into shareable, privacy-preserving findings." },
  ];
}
