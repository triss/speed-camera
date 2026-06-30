// Importing a preset module registers it (side effect of definePreset).
import speed from "./speed.js";
import count from "./count.js";
import dwell from "./dwell.js";
import wildlife from "./wildlife.js";
import environment from "./environment.js";

export { speed, count, dwell, wildlife, environment };
export { listPresets, getPreset } from "../engine/preset.js";
