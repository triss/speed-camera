// The engine pipeline, composed from components and parameterised by a use.
//
//   detect → track → (classify) → locate → derive
//
// This is the orchestration that used to live inline in the demo. A use brings
// the locate-backend id plus its measure()/deriveFindings() logic; the pipeline
// wires the shared components around them and owns the observation buffer.

import { createMotionDetector } from "./detect.js";
import { createTracker } from "./track.js";
import { createLocator } from "./locate.js";

const MAX_OBS = 500;

export function createPipeline(use, opts = {}) {
  const gate = opts.gate ?? 0.012;       // motion energy that counts as a detection
  const onObservation = opts.onObservation || null;
  const detector = createMotionDetector(opts.detector);
  const tracker = createTracker();
  // Resolve the named locate backend once. change-mode uses ("none") still get
  // a locator; their measure() decides what to do with it.
  const locator = createLocator(use.locate === "none" ? "none" : use.locate);
  let observations = [];

  return {
    use,
    observations: () => observations,
    count: () => observations.length,

    reset() {
      detector.reset();
      tracker.reset();
      observations = [];
    },

    // Process one grayscale frame. ctx: { width, height, t }.
    // Returns { energy, bbox, measurement, error } for the caller to render.
    process(gray, ctx) {
      const { energy, bbox } = detector.detect(gray, ctx.width); // STAGE 1
      let measurement = null, error = null;
      if (energy > gate && bbox) {
        const track = tracker.update(bbox);                       // STAGE 2
        try {
          // STAGES 3–4: the use locates + measures, given the resolved backend.
          measurement = use.measure(track, ctx, { locate: locator });
          if (measurement) {
            const observation = { use: use.id, t: ctx.t, ...measurement };
            observations.push(observation);
            if (observations.length > MAX_OBS) observations.shift();
            if (onObservation) onObservation(observation);
          }
        } catch (e) {
          error = e.message; // stub / needs-calibration surfaces here
        }
      }
      return { energy, bbox, measurement, error };
    },

    // Turn the observation buffer into findings. { value, error }.
    findings() {
      try {
        return { value: use.deriveFindings(observations), error: null };
      } catch (e) {
        return { value: null, error: e.message };
      }
    },
  };
}
