// A Preset configures the lookout engine for one kind of observation.
//
// Engine pipeline:  detect difference → track → (classify) → locate → derive
//
// A preset declares which sensing mode and locate backend it needs, what
// measurements it derives, and how to summarise a batch of events for sharing.
// These are STUBS: measure() and summarise() throw until implemented.

/**
 * @typedef {Object} PresetSpec
 * @property {string}   id
 * @property {string}   name
 * @property {string}   summary
 * @property {"motion"|"change"} mode  fast motion events, or slow change detection
 * @property {string}   locate         locate-backend id (see README "How it works")
 * @property {string[]} measurements   fields this preset derives per event
 * @property {(track:any, ctx:any)=>object} [measure]    track → measurement   [stub]
 * @property {(events:any[])=>object}       [summarise]  events → shareable aggregate [stub]
 */

const registry = new Map();

function stub(label) {
  return function () { throw new Error(label + " not implemented yet (stub)"); };
}

/** Register a preset (filling in stub measure/summarise if absent). */
export function definePreset(spec) {
  const preset = Object.assign({
    measure: stub(spec.id + ".measure()"),
    summarise: stub(spec.id + ".summarise()"),
  }, spec);
  registry.set(preset.id, preset);
  return preset;
}

export function listPresets() { return Array.from(registry.values()); }
export function getPreset(id) { return registry.get(id); }
