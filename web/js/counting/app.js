// Counting MVP. Full-screen camera + a line the user draws; count crossings,
// not people. All processing and storage are local. Composed from small pure
// modules (blobs, tracker, crossing) + the shared IndexedDB observation store.
import { toGray } from "../engine/gray.js";
import { extractBlobs } from "./blobs.js";
import { createMultiTracker } from "./tracker.js";
import { crossingDirection, countsForMode } from "./crossing.js";
import { openObservationStore } from "../engine/store.js";
import { createCoverMapper } from "../tools/cover-map.js";
import { createSettingsBinder } from "../tools/settings.js";
import { initWarnings } from "../tools/warnings.js";

const USE = "counting";
const PROC_W = 176; // processing width; keep small for old phones

const RES_WIDTH = { low: 320, medium: 640, high: 1280 };

const settings = {
  facing: "environment", resolution: "medium", targetFps: 10, mirror: false,
  name: "untitled_observation", viewType: "other",
  directionMode: "separate", sensitivity: 24, minSize: 14,
  minDurationMs: 1000, cooldownMs: 3000, maxLost: 5,
};

// ── DOM ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const cam = $("cam"), draw = $("draw"), dctx = draw.getContext("2d");
const statusLine = $("status");
const work = document.createElement("canvas");
const wctx = work.getContext("2d", { willReadFrequently: true });
let procH = 132;

removeFloatingThemePicker();
document.addEventListener("DOMContentLoaded", removeFloatingThemePicker);
function removeFloatingThemePicker() {
  const floatingThemePicker = document.getElementById("themePicker");
  if (floatingThemePicker) floatingThemePicker.remove();
}

// ── State ────────────────────────────────────────────────────────────────
let stream = null, cameraOn = false, observing = false;
let store = null, sessionId = null;
let prevGray = null, tracker = createMultiTracker();
let line = null; // { a:{x,y}, b:{x,y} } in intrinsic-frame normalised coords
let drawMode = false, pendingA = null;
let totals = { aToB: 0, bToA: 0, total: 0, lastEvent: null };
let lastProcT = 0, fpsEMA = 0, rafId = 0;
let flashes = [];

const { screenToFrame, frameToScreen } = createCoverMapper({
  video: cam,
  overlay: draw,
  getMirror: () => settings.mirror,
});

// ── Camera ─────────────────────────────────────────────────────────────────
async function startCamera({ drawLineAfterStart = false } = {}) {
  stopStream();
  statusLine.textContent = "requesting camera…";
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: settings.facing },
        width: { ideal: RES_WIDTH[settings.resolution] },
        frameRate: { ideal: settings.targetFps },
      },
      audio: false,
    });
  } catch (e) {
    statusLine.textContent = "camera failed: " + e.name + " — " + e.message;
    return;
  }
  cam.srcObject = stream;
  cam.classList.toggle("mirror", settings.mirror);
  cam.play().catch(() => {});
  cameraOn = true;
  for (const id of ["btnSwitch", "btnDraw"]) $(id).disabled = false;
  updatePrimaryButton();
  resizeOverlay();
  if (drawLineAfterStart) beginLineDrawing();
  else statusLine.textContent = observing
    ? "Observing. Counting crossings."
    : line
      ? "Ready. Press Start observing."
      : "Camera ready. Use Redraw line to place your counting line.";
  loop();
}

function stopStream() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}
function stopCamera() {
  observing = false; cameraOn = false;
  drawMode = false; pendingA = null;
  document.body.classList.remove("placing-line");
  stopStream();
  cancelAnimationFrame(rafId);
  dctx.clearRect(0, 0, draw.width, draw.height);
  updatePrimaryButton();
  for (const id of ["btnSwitch", "btnDraw"]) $(id).disabled = true;
}

function requestFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement) return Promise.resolve();
  if (el.requestFullscreen) {
    return el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
  } else if (el.webkitRequestFullscreen) {
    el.webkitRequestFullscreen();
  }
  return Promise.resolve();
}

// ── Overlay sizing ──────────────────────────────────────────────────────────
function resizeOverlay() {
  draw.width = draw.clientWidth;
  draw.height = draw.clientHeight;
  if (cam.videoWidth) procH = Math.round(PROC_W * cam.videoHeight / cam.videoWidth);
  if (work.width !== PROC_W) { work.width = PROC_W; work.height = procH; }
}
window.addEventListener("resize", () => { if (cameraOn) resizeOverlay(); });

// ── Processing + render loop ────────────────────────────────────────────────
function loop() {
  if (!cameraOn) return;
  rafId = requestAnimationFrame(loop);
  const now = performance.now();
  const interval = 1000 / settings.targetFps;
  if (now - lastProcT < interval) { render([]); return; }
  const dt = now - lastProcT;
  lastProcT = now;
  if (dt < 1000) fpsEMA = fpsEMA ? fpsEMA * 0.8 + (1000 / dt) * 0.2 : 1000 / dt;

  if (!cam.videoWidth) return;
  if (work.height !== procH) { work.height = procH; }
  wctx.drawImage(cam, 0, 0, PROC_W, procH);
  const gray = toGray(wctx.getImageData(0, 0, PROC_W, procH));

  let blobs = [];
  if (prevGray && prevGray.length === gray.length) {
    const thresh = settings.sensitivity;
    const mask = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i++) if (Math.abs(gray[i] - prevGray[i]) > thresh) mask[i] = 1;
    blobs = extractBlobs(mask, PROC_W, procH, settings.minSize);
  }
  prevGray = gray;

  const t = Date.now();
  const tracks = tracker.update(blobs, t);
  if (observing && line) countCrossings(tracks, t);

  render(tracks);
  $("cTracks").textContent = tracks.length;
  $("cFps").textContent = fpsEMA ? fpsEMA.toFixed(1) : "–";
}

function countCrossings(tracks, t) {
  for (const tr of tracks) {
    if (!tr.moved) continue;
    const prev = { x: tr.prevCx / PROC_W, y: tr.prevCy / procH };
    const cur = { x: tr.cx / PROC_W, y: tr.cy / procH };
    const dir = crossingDirection(prev, cur, line.a, line.b);
    if (!dir) continue;
    if (tr.lastT - tr.firstT < settings.minDurationMs) continue;
    if (t - tr.lastCountT < settings.cooldownMs) continue;
    if (!countsForMode(dir, settings.directionMode)) continue;
    tr.lastCountT = t; tr.counted = true;
    recordCrossing(tr, dir, t);
  }
}

async function recordCrossing(tr, dir, t) {
  totals.total++;
  if (dir === "A_to_B") totals.aToB++; else if (dir === "B_to_A") totals.bToA++;
  totals.lastEvent = t;
  $("cTotal").textContent = totals.total;
  $("cAB").textContent = totals.aToB;
  $("cBA").textContent = totals.bToA;
  flashes.push({ dir, t: performance.now() });
  const confidence = Math.min(1, tr.framesSeen / 12);
  const obs = {
    use: USE, t,
    session_id: sessionId, site_name: settings.name,
    mode: "line_crossing", line_id: "main", track_id: tr.id,
    direction: dir, duration_ms: tr.lastT - tr.firstT, frames_seen: tr.framesSeen,
    confidence: Math.round(confidence * 100) / 100, class_hint: "unknown",
  };
  try { if (store) await store.add(obs); } catch (e) { statusLine.textContent = "storage failed: " + e.message; }
}

function render(tracks) {
  dctx.clearRect(0, 0, draw.width, draw.height);
  // Always show what is being tracked, so the user can see detection working.
  dctx.strokeStyle = "rgba(110,231,155,.9)";
  dctx.lineWidth = 1.5;
  for (const tr of tracks || []) {
    const s = frameToScreen({ x: tr.cx / PROC_W, y: tr.cy / procH });
    dctx.beginPath(); dctx.arc(s.x, s.y, 6, 0, Math.PI * 2); dctx.stroke();
  }
  const a = drawMode && pendingA ? pendingA : line?.a;
  const b = line?.b;
  if (a && b) {
    const sa = frameToScreen(a), sb = frameToScreen(b);
    dctx.strokeStyle = "#ffd166"; dctx.lineWidth = 3;
    dctx.beginPath(); dctx.moveTo(sa.x, sa.y); dctx.lineTo(sb.x, sb.y); dctx.stroke();
    drawSideLabels(a, b);
    drawCrossingFlashes(a, b, performance.now());
  } else if (a) {
    const sa = frameToScreen(a);
    dctx.fillStyle = "#ffd166"; dctx.beginPath(); dctx.arc(sa.x, sa.y, 6, 0, Math.PI * 2); dctx.fill();
  }
}
function label(text, p) {
  dctx.fillStyle = "#ffd166"; dctx.beginPath(); dctx.arc(p.x, p.y, 10, 0, Math.PI * 2); dctx.fill();
  dctx.fillStyle = "#101214"; dctx.font = "bold 13px system-ui"; dctx.textAlign = "center"; dctx.textBaseline = "middle";
  dctx.fillText(text, p.x, p.y);
  dctx.textAlign = "start"; dctx.textBaseline = "alphabetic";
}
function sideLabelPositions(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const offset = 0.12;
  return {
    a: frameToScreen({ x: mx + (-dy / len) * offset, y: my + (dx / len) * offset }),
    b: frameToScreen({ x: mx - (-dy / len) * offset, y: my - (dx / len) * offset }),
  };
}
function drawSideLabels(a, b) {
  const p = sideLabelPositions(a, b);
  label("A", p.a);
  label("B", p.b);
}
function drawArrow(from, to, alpha) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const head = 18;
  dctx.save();
  dctx.globalAlpha = alpha;
  dctx.strokeStyle = "#8af2b0";
  dctx.fillStyle = "#8af2b0";
  dctx.lineWidth = 7;
  dctx.lineCap = "round";
  dctx.beginPath();
  dctx.moveTo(from.x, from.y);
  dctx.lineTo(to.x, to.y);
  dctx.stroke();
  dctx.beginPath();
  dctx.moveTo(to.x, to.y);
  dctx.lineTo(to.x - ux * head - uy * head * .55, to.y - uy * head + ux * head * .55);
  dctx.lineTo(to.x - ux * head + uy * head * .55, to.y - uy * head - ux * head * .55);
  dctx.closePath();
  dctx.fill();
  dctx.restore();
}
function drawCrossingFlashes(a, b, now) {
  const lifetime = 900;
  flashes = flashes.filter((flash) => now - flash.t < lifetime);
  const p = sideLabelPositions(a, b);
  for (const flash of flashes) {
    const age = now - flash.t;
    const alpha = Math.max(0, 1 - age / lifetime);
    const from = flash.dir === "A_to_B" ? p.a : p.b;
    const to = flash.dir === "A_to_B" ? p.b : p.a;
    drawArrow(from, to, alpha);
  }
}

// ── Line drawing ────────────────────────────────────────────────────────────
draw.addEventListener("pointerdown", (e) => {
  if (!drawMode) return;
  const rect = draw.getBoundingClientRect();
  const p = screenToFrame(e.clientX - rect.left, e.clientY - rect.top);
  if (!pendingA) {
    pendingA = p;
    statusLine.textContent = "Now tap point B.";
  } else {
    line = { a: pendingA, b: p };
    pendingA = null; drawMode = false;
    draw.classList.remove("drawing");
    document.body.classList.remove("placing-line");
    startObserving();
  }
});

// ── UI wiring ────────────────────────────────────────────────────────────────
$("btnCamera").addEventListener("click", async () => {
  if (!cameraOn) {
    await requestFullscreen();
    startCamera({ drawLineAfterStart: true });
    return;
  }
  if (!line) return;
  if (observing) stopObserving();
  else startObserving();
});
$("btnSwitch").addEventListener("click", () => {
  settings.facing = settings.facing === "environment" ? "user" : "environment";
  $("setFacing").value = settings.facing;
  if (cameraOn) startCamera();
});
$("btnDraw").addEventListener("click", () => {
  beginLineDrawing();
});

function beginLineDrawing() {
  line = null;
  if (observing) { observing = false; updatePrimaryButton(); }
  drawMode = true; pendingA = null; draw.classList.add("drawing");
  document.body.classList.add("placing-line");
  updatePrimaryButton();
  statusLine.textContent = "Tap point A of the counting line.";
}

function startObserving() {
  observing = true;
  if (!sessionId) sessionId = makeSessionId();
  $("sessionId").textContent = sessionId;
  updatePrimaryButton();
  statusLine.textContent = "Observing. Counting crossings.";
}

function stopObserving() {
  observing = false;
  updatePrimaryButton();
  statusLine.textContent = "Paused.";
  $("sessionId").textContent = sessionId || "–";
}

function updatePrimaryButton() {
  const b = $("btnCamera");
  b.classList.toggle("observing", observing);
  b.classList.toggle("primary", !cameraOn);
  b.classList.toggle("go", cameraOn && !!line && !observing);
  if (!cameraOn) {
    b.disabled = false;
    b.textContent = "Start camera";
  } else if (!line) {
    b.disabled = true;
    b.textContent = "Place line first";
  } else {
    b.disabled = false;
    b.textContent = observing ? "Stop observing" : "Start observing";
  }
}
function makeSessionId() {
  const day = new Date().toISOString().slice(0, 10);
  return `session-${day}-${settings.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}

// Sheets
function openSheet(id) {
  for (const s of document.querySelectorAll(".sheet")) s.hidden = s.id !== id;
  $("scrim").hidden = false;
}
function closeSheets() {
  for (const s of document.querySelectorAll(".sheet")) s.hidden = true;
  $("scrim").hidden = true;
}
$("btnHelp").addEventListener("click", () => openSheet("panelHelp"));
$("btnSettings").addEventListener("click", () => openSheet("panelSettings"));
$("btnExport").addEventListener("click", async () => { await refreshExportPanel(); openSheet("panelExport"); });
$("scrim").addEventListener("click", closeSheets);
for (const btn of document.querySelectorAll("[data-close]")) btn.addEventListener("click", closeSheets);

// Settings bindings
const { bind, bindNumberPair } = createSettingsBinder({
  $,
  settings,
  onChange: ({ key }) => {
    if ((key === "resolution" || key === "facing" || key === "targetFps") && cameraOn) startCamera();
    if (key === "mirror") cam.classList.toggle("mirror", settings.mirror);
    if (key === "maxLost") tracker = createMultiTracker({ maxLost: settings.maxLost });
  },
});
bind("setFacing", "facing"); bind("setResolution", "resolution");
bind("setMirror", "mirror");
bind("setName", "name"); bind("setViewType", "viewType");
bind("setDirection", "directionMode");
bindNumberPair("setFps", "setFpsNumber", "targetFps", {
  onCommit: () => { if (cameraOn) startCamera(); },
});
bindNumberPair("setSensitivity", "setSensitivityNumber", "sensitivity");
bindNumberPair("setMinSize", "setMinSizeNumber", "minSize");
bindNumberPair("setMinDuration", "setMinDurationNumber", "minDurationMs");
bindNumberPair("setCooldown", "setCooldownNumber", "cooldownMs");
bindNumberPair("setMaxLost", "setMaxLostNumber", "maxLost", {
  onCommit: () => {
    tracker = createMultiTracker({ maxLost: settings.maxLost });
  },
});

// ── Export & data ────────────────────────────────────────────────────────────
async function refreshExportPanel() {
  if (!store) return;
  $("storedCount").textContent = await store.count({ use: USE });
  $("sessionId").textContent = sessionId || "–";
  $("lastEvent").textContent = totals.lastEvent ? new Date(totals.lastEvent).toLocaleTimeString() : "–";
  if (navigator.storage?.estimate) {
    const { usage } = await navigator.storage.estimate();
    $("storageUsed").textContent = usage != null ? (usage / 1e6).toFixed(1) + " MB" : "n/a";
  } else $("storageUsed").textContent = "n/a";
}

function download(text, type, ext) {
  const blob = new Blob([text], { type });
  const name = `lookout-counting-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  URL.revokeObjectURL(a.href);
}

$("btnCsv").addEventListener("click", async () => {
  download(await store.exportCSV({ use: USE }), "text/csv", "csv");
  statusLine.textContent = "CSV exported.";
});
$("btnJson").addEventListener("click", async () => {
  const observations = await store.list({ use: USE, limit: 100000 });
  const track = stream?.getVideoTracks?.()[0]?.getSettings?.() || {};
  const session = {
    schema: "lookout.count.session.v1",
    session_id: sessionId, created_at_utc: new Date().toISOString(),
    site_name: settings.name, view_type: settings.viewType,
    camera: { facing: settings.facing, requested_fps: settings.targetFps, measured_fps: Math.round(fpsEMA * 10) / 10,
      resolution: { width: track.width || null, height: track.height || null } },
    data_policy: "observations-only (no images, no footage)",
    counting: { mode: "line_crossing", direction_mode: settings.directionMode, sensitivity_threshold: settings.sensitivity, minimum_blob_area_px: settings.minSize, cooldown_ms: settings.cooldownMs, minimum_track_duration_ms: settings.minDurationMs },
    geometry: { line: line ? { id: "main", a_norm: line.a, b_norm: line.b } : null, active_area: null, ignore_areas: [] },
  };
  download(JSON.stringify({ schema: "lookout.count.export.v1", exported_utc: new Date().toISOString(), session, observations: observations.reverse() }, null, 2), "application/json", "json");
  statusLine.textContent = "JSON exported.";
});
$("btnClear").addEventListener("click", async () => {
  if (!confirm("Delete all local counting observations from this device?")) return;
  await store.clear({ use: USE });
  await store.clearMedia?.({ use: USE });
  totals = { aToB: 0, bToA: 0, total: 0, lastEvent: null };
  for (const [id, v] of [["cTotal", 0], ["cAB", 0], ["cBA", 0]]) $(id).textContent = v;
  await refreshExportPanel();
  statusLine.textContent = "Local observations cleared.";
});

// ── Battery / disk warnings ──────────────────────────────────────────────────

// ── Boot ─────────────────────────────────────────────────────────────────────
(async function boot() {
  store = await openObservationStore();
  $("storedCount").textContent = await store.count({ use: USE }).catch(() => 0);
  initWarnings();
})();
