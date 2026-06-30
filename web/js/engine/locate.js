// STAGE 3 — locate. Pluggable backend: map an image-space track to a world-ish
// position. Monocular geometry can't recover depth without an assumption, so
// each backend supplies a different one (see README "How it works").
//
// A locator has shape: { needsCalibration: boolean, locate(track, ctx) -> pos }
// Uses don't call factories directly; they name a backend by id and the
// pipeline resolves it with createLocator().

const backends = new Map();

export function defineLocate(id, factory) { backends.set(id, factory); }
export function locateBackends() { return Array.from(backends.keys()); }

export function createLocator(id, opts = {}) {
  const factory = backends.get(id);
  if (!factory) throw new Error("unknown locate backend: " + id);
  return factory(opts);
}

function stubLocator(id, reason) {
  return () => ({
    implemented: false,
    needsCalibration: id === "GroundPlaneHomography",
    locate() { throw new Error(id + ".locate " + reason); },
  });
}

// none — identity passthrough. Returns the image-space ground point; no world
// units. Used by change-mode uses that don't need positioning.
defineLocate("none", () => ({
  implemented: true,
  needsCalibration: false,
  locate(track) {
    return { x: track.ground.x, y: track.ground.y, units: "px" };
  },
}));

// BearingOnly — REAL. Horizontal bearing of the ground point from frame centre,
// assuming a known horizontal field of view. No calibration, no depth.
defineLocate("BearingOnly", (opts = {}) => {
  const hfov = opts.hfov ?? 60; // degrees across the frame width
  return {
    implemented: true,
    needsCalibration: false,
    locate(track, ctx) {
      const nx = track.ground.x / ctx.width - 0.5; // -0.5 .. 0.5
      return { bearingDeg: nx * hfov, range: null, units: "deg" };
    },
  };
});

// GroundPlaneHomography — needs a 4-point view calibration to map pixels to
// metres on the road plane. Stubbed until the homography solver lands.
defineLocate("GroundPlaneHomography", stubLocator(
  "GroundPlaneHomography", "needs view calibration (4+ ground points) — not implemented yet (stub)"));

// KnownSizeRanger — ranges by assuming a typical object size. Stub.
defineLocate("KnownSizeRanger", stubLocator(
  "KnownSizeRanger", "needs an object size reference — not implemented yet (stub)"));

// StereoTriangulator — two views → depth. Stub.
defineLocate("StereoTriangulator", stubLocator(
  "StereoTriangulator", "needs a second synchronised view — not implemented yet (stub)"));
