// Capture Use. Full-screen camera + user-drawn line.
// Counts crossings and records stills for each crossing if enabled.
// Provides an interactive stills browser with toggleable metadata overlays.
import { toGray } from "../engine/gray.js";
import { extractBlobs } from "../counting/blobs.js";
import { createMultiTracker } from "../counting/tracker.js";
import { crossingDirection, countsForMode } from "../counting/crossing.js";
import { openObservationStore } from "../engine/store.js";

const USE = "capture";
const PROC_W = 176; // processing width; keep small for old phones

const RES_WIDTH = { low: 320, medium: 640, high: 1280 };

const settings = {
  facing: "environment", resolution: "medium", targetFps: 10, mirror: false,
  name: "untitled_capture", viewType: "other",
  directionMode: "separate", sensitivity: 24, minSize: 14,
  minDurationMs: 1000, cooldownMs: 3000, maxLost: 5,
  captureStills: true,
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

// ── Stills Viewer State ──────────────────────────────────────────────────
let viewerActive = false;
let viewerMediaList = [];
let viewerObsMap = new Map();
let viewerIndex = 0;
let metadataVisible = true;
let currentImageUrl = null;

// ── Cover-fit mapping between screen pixels and the video's intrinsic frame ──
function coverMap() {
  const vw = cam.videoWidth || 16, vh = cam.videoHeight || 9;
  const dw = draw.clientWidth, dh = draw.clientHeight;
  const scale = Math.max(dw / vw, dh / vh);
  const w = vw * scale, h = vh * scale;
  return { ox: (dw - w) / 2, oy: (dh - h) / 2, w, h, mir: settings.mirror };
}
function screenToFrame(sx, sy) {
  const m = coverMap();
  let x = (sx - m.ox) / m.w;
  if (m.mir) x = 1 - x;
  return { x, y: (sy - m.oy) / m.h };
}
function frameToScreen(p) {
  const m = coverMap();
  let fx = m.mir ? 1 - p.x : p.x;
  return { x: m.ox + fx * m.w, y: m.oy + p.y * m.h };
}

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

// Helper to capture a JPEG frame from the live video
function captureStillBlob() {
  if (!cam.videoWidth || !cam.videoHeight) return Promise.resolve(null);
  const cap = document.createElement("canvas");
  cap.width = cam.videoWidth;
  cap.height = cam.videoHeight;
  const cctx = cap.getContext("2d");
  
  if (settings.mirror) {
    cctx.translate(cap.width, 0);
    cctx.scale(-1, 1);
  }
  cctx.drawImage(cam, 0, 0);
  
  return new Promise((resolve) => {
    cap.toBlob((blob) => resolve(blob), "image/jpeg", 0.85);
  });
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
  
  let stillBlob = null;
  let filename = `${USE}_${t}.jpg`;
  if (dir === "A_to_B") {
    filename = `A-to-B_${t}.jpg`;
  } else if (dir === "B_to_A") {
    filename = `B-to-A_${t}.jpg`;
  } else if (settings.name && settings.name !== "untitled_capture") {
    filename = `${settings.name.replace(/[^a-zA-Z0-9_-]/g, "-")}_${t}.jpg`;
  }

  if (settings.captureStills) {
    try {
      stillBlob = await captureStillBlob();
    } catch (e) {
      console.error("Failed to capture still:", e);
    }
  }

  try { 
    if (store) {
      await store.add(obs, stillBlob ? { still: stillBlob, filename } : {});
      if (viewerActive) {
        await refreshViewerData();
      }
    } 
  } catch (e) { 
    statusLine.textContent = "storage failed: " + e.message; 
  }
}

function render(tracks) {
  dctx.clearRect(0, 0, draw.width, draw.height);
  // Always show what is being tracked, so the user can see detection working.
  {
    dctx.strokeStyle = "rgba(110,231,155,.9)";
    dctx.lineWidth = 1.5;
    for (const tr of tracks || []) {
      const s = frameToScreen({ x: tr.cx / PROC_W, y: tr.cy / procH });
      dctx.beginPath(); dctx.arc(s.x, s.y, 6, 0, Math.PI * 2); dctx.stroke();
    }
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
const bind = (id, key, fn = (v) => v) => $(id).addEventListener("change", (e) => {
  const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
  settings[key] = fn(v);
  if ((key === "resolution" || key === "facing" || key === "targetFps") && cameraOn) startCamera();
  if (key === "mirror") cam.classList.toggle("mirror", settings.mirror);
  if (key === "maxLost") tracker = createMultiTracker({ maxLost: settings.maxLost });
});
function bindNumberPair(rangeId, numberId, key, onCommit = () => {}) {
  const range = $(rangeId);
  const number = $(numberId);
  const min = Number(number.min);
  const max = Number(number.max);
  const set = (raw, commit = false) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    const value = Math.min(max, Math.max(min, parsed));
    settings[key] = value;
    range.value = value;
    number.value = value;
    if (commit) onCommit();
  };
  range.addEventListener("input", (e) => set(e.target.value));
  range.addEventListener("change", (e) => set(e.target.value, true));
  number.addEventListener("input", (e) => set(e.target.value));
  number.addEventListener("change", (e) => set(e.target.value, true));
}
bind("setFacing", "facing"); bind("setResolution", "resolution");
bind("setMirror", "mirror");
bind("setName", "name"); bind("setViewType", "viewType");
bind("setDirection", "directionMode");
bind("setCaptureStills", "captureStills"); // Capture toggle binding!
bindNumberPair("setFps", "setFpsNumber", "targetFps", () => { if (cameraOn) startCamera(); });
bindNumberPair("setSensitivity", "setSensitivityNumber", "sensitivity");
bindNumberPair("setMinSize", "setMinSizeNumber", "minSize");
bindNumberPair("setMinDuration", "setMinDurationNumber", "minDurationMs");
bindNumberPair("setCooldown", "setCooldownNumber", "cooldownMs");
bindNumberPair("setMaxLost", "setMaxLostNumber", "maxLost", () => {
  tracker = createMultiTracker({ maxLost: settings.maxLost });
});

// ── Stills Viewer Controller ─────────────────────────────────────────────
async function enterViewer() {
  viewerActive = true;
  
  // Hide only HUD overlays, but NOT the stage (video/canvas).
  // The fullscreen-viewer has a higher z-index (100) and opaque background,
  // so it will completely cover the stage visually without throttling browser video playback.
  $("hudTop").style.display = "none";
  $("hudBottom").style.display = "none";
  $("viewerContainer").hidden = false;
  
  // Load data
  try {
    statusLine.textContent = "Loading stills...";
    viewerMediaList = await store.listMedia({ use: USE, kind: "still", limit: 500 });
    const obsList = await store.list({ use: USE, limit: 500 });
    viewerObsMap = new Map(obsList.map(o => [o.id, o]));
  } catch (e) {
    console.error("Failed to load viewer data:", e);
    viewerMediaList = [];
  }
  
  viewerIndex = 0;
  updateViewer();
}

function exitViewer() {
  viewerActive = false;
  
  // Revoke object URL
  if (currentImageUrl) {
    URL.revokeObjectURL(currentImageUrl);
    currentImageUrl = null;
  }
  
  // Show main interface
  $("hudTop").style.display = "flex";
  $("hudBottom").style.display = "flex";
  $("viewerContainer").hidden = true;
  
  statusLine.textContent = observing ? "Observing. Counting crossings." : "Paused.";
}

async function refreshViewerData() {
  try {
    const currentId = viewerMediaList[viewerIndex]?.id;
    viewerMediaList = await store.listMedia({ use: USE, kind: "still", limit: 500 });
    const obsList = await store.list({ use: USE, limit: 500 });
    viewerObsMap = new Map(obsList.map(o => [o.id, o]));
    
    // Keep user on the same still if it still exists
    if (currentId !== undefined) {
      const newIndex = viewerMediaList.findIndex(m => m.id === currentId);
      if (newIndex !== -1) {
        viewerIndex = newIndex;
      } else {
        viewerIndex = Math.min(viewerIndex, viewerMediaList.length - 1);
      }
    } else {
      viewerIndex = 0;
    }
    updateViewer();
  } catch (e) {
    console.error("Failed to refresh viewer data:", e);
  }
}

function updateViewer() {
  if (currentImageUrl) {
    URL.revokeObjectURL(currentImageUrl);
    currentImageUrl = null;
  }
  
  if (viewerMediaList.length === 0) {
    $("viewerImg").style.display = "none";
    $("viewerMetadata").style.display = "none";
    $("viewerEmpty").hidden = false;
    $("viewerPageNum").textContent = "0 of 0";
    $("btnViewerPrev").disabled = true;
    $("btnViewerNext").disabled = true;
    return;
  }
  
  $("viewerImg").style.display = "block";
  $("viewerMetadata").style.display = metadataVisible ? "block" : "none";
  $("viewerEmpty").hidden = true;
  
  const media = viewerMediaList[viewerIndex];
  const obs = viewerObsMap.get(media.observation_id);
  
  currentImageUrl = URL.createObjectURL(media.blob);
  $("viewerImg").src = currentImageUrl;
  
  $("viewerPageNum").textContent = `${viewerIndex + 1} of ${viewerMediaList.length}`;
  $("btnViewerPrev").disabled = viewerIndex === 0;
  $("btnViewerNext").disabled = viewerIndex === viewerMediaList.length - 1;
  
  if (obs) {
    $("metaTime").textContent = new Date(obs.t).toLocaleString();
    $("metaDirection").textContent = obs.direction === "A_to_B" ? "A → B" : obs.direction === "B_to_A" ? "B → A" : obs.direction;
    $("metaTrackId").textContent = `#${obs.track_id}`;
    $("metaDuration").textContent = `${(obs.duration_ms / 1000).toFixed(1)}s`;
    $("metaConfidence").textContent = `${Math.round(obs.confidence * 100)}%`;
    $("metaSession").textContent = obs.session_id || "N/A";
  } else {
    $("metaTime").textContent = new Date(media.t).toLocaleString();
    $("metaDirection").textContent = "N/A";
    $("metaTrackId").textContent = "N/A";
    $("metaDuration").textContent = "N/A";
    $("metaConfidence").textContent = "N/A";
    $("metaSession").textContent = "N/A";
  }
}

// Viewer Listeners
$("btnViewStills").addEventListener("click", () => enterViewer());
$("btnViewerBack").addEventListener("click", () => exitViewer());
$("btnToggleMetadata").addEventListener("click", () => {
  metadataVisible = !metadataVisible;
  $("viewerMetadata").style.display = metadataVisible ? "block" : "none";
  $("btnToggleMetadata").textContent = metadataVisible ? "Hide Info" : "Show Info";
});
$("btnViewerPrev").addEventListener("click", () => {
  if (viewerIndex > 0) {
    viewerIndex--;
    updateViewer();
  }
});
$("btnViewerNext").addEventListener("click", () => {
  if (viewerIndex < viewerMediaList.length - 1) {
    viewerIndex++;
    updateViewer();
  }
});

// ── Export & data ────────────────────────────────────────────────────────────
async function refreshExportPanel() {
  if (!store) return;
  const count = await store.count({ use: USE });
  $("storedCount").textContent = count;
  $("sessionId").textContent = sessionId || "–";
  $("lastEvent").textContent = totals.lastEvent ? new Date(totals.lastEvent).toLocaleTimeString() : "–";
  
  // Update Share Stills and Share Bundle button states
  const stillsCount = await store.countMedia({ use: USE });
  $("btnShareStills").disabled = stillsCount === 0;
  $("btnShareBundle").disabled = count === 0;

  if (navigator.storage?.estimate) {
    const { usage } = await navigator.storage.estimate();
    $("storageUsed").textContent = usage != null ? (usage / 1e6).toFixed(1) + " MB" : "n/a";
  } else $("storageUsed").textContent = "n/a";
}

function download(text, type, ext) {
  const blob = new Blob([text], { type });
  const name = `lookout-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  URL.revokeObjectURL(a.href);
}

async function shareOrDownloadMedia(records) {
  if (!records.length) return "no stills";
  const canCreateFile = typeof File !== "undefined";
  const files = canCreateFile
    ? records.map((record) => new File([record.blob], record.filename, { type: record.mime }))
    : [];
  if (files.length && navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files, title: "lookout observation stills" });
      return "shared";
    } catch (e) {
      if (e.name === "AbortError") return "cancelled";
      console.warn("Share failed, falling back to download:", e);
    }
  }
  for (const record of records) {
    const url = URL.createObjectURL(record.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = record.filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  return "downloaded";
}

// Pure JS Store-only (no-compression) ZIP generator.
// Fast, memory-efficient, and runs natively on old smartphone browsers without libraries.
function makeZip(files) {
  const parts = [];
  const centralDirectory = [];
  let offset = 0;

  const crcTable = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c;
  }
  
  function getCrc(data) {
    let crc = 0 ^ (-1);
    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 0xff];
    }
    return (crc ^ (-1)) >>> 0;
  }

  const date = new Date();
  const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    const dataBytes = file.data;
    const crc = getCrc(dataBytes);
    const size = dataBytes.length;

    // Local Header (LFH)
    const lfh = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(lfh.buffer);

    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 10, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true); // store method
    view.setUint16(10, dosTime, true);
    view.setUint16(12, dosDate, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    lfh.set(nameBytes, 30);

    parts.push(lfh);
    parts.push(dataBytes);

    // Central Directory Header (CDH)
    const cdh = new Uint8Array(46 + nameBytes.length);
    const cdhView = new DataView(cdh.buffer);

    cdhView.setUint32(0, 0x02014b50, true);
    cdhView.setUint16(4, 20, true);
    cdhView.setUint16(6, 10, true);
    cdhView.setUint16(8, 0, true);
    cdhView.setUint16(10, 0, true);
    cdhView.setUint16(12, dosTime, true);
    cdhView.setUint16(14, dosDate, true);
    cdhView.setUint32(16, crc, true);
    cdhView.setUint32(20, size, true);
    cdhView.setUint32(24, size, true);
    cdhView.setUint16(28, nameBytes.length, true);
    cdhView.setUint16(30, 0, true);
    cdhView.setUint16(32, 0, true);
    cdhView.setUint16(34, 0, true);
    cdhView.setUint16(36, 0, true);
    cdhView.setUint32(38, 0, true);
    cdhView.setUint32(42, offset, true);
    cdh.set(nameBytes, 46);

    centralDirectory.push(cdh);
    offset += lfh.length + size;
  }

  const cdhStart = offset;
  let cdhSize = 0;
  for (const cdh of centralDirectory) {
    parts.push(cdh);
    cdhSize += cdh.length;
  }

  // End of Central Directory (EOCD)
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);

  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, cdhSize, true);
  eocdView.setUint32(16, cdhStart, true);
  eocdView.setUint16(20, 0, true);

  parts.push(eocd);

  return new Blob(parts, { type: "application/zip" });
}

$("btnCsv").addEventListener("click", async () => {
  download(await store.exportCSV({ use: USE }), "text/csv", "csv");
  statusLine.textContent = "CSV exported.";
});

$("btnJson").addEventListener("click", async () => {
  try {
    statusLine.textContent = "Preparing JSON export (including stills)...";
    const observations = await store.list({ use: USE, limit: 100000 });
    const mediaList = await store.listMedia({ use: USE, kind: "still", limit: 500 });
    
    const mediaMap = new Map(mediaList.map(m => [m.observation_id, m]));
    const processedObs = [];
    
    for (const obs of observations) {
      const copy = { ...obs };
      const mediaRecord = mediaMap.get(obs.id);
      if (mediaRecord && mediaRecord.blob) {
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(mediaRecord.blob);
          });
          copy.media = {
            ...copy.media,
            data_url: dataUrl
          };
        } catch (e) {
          console.error("Failed to convert blob to data URL:", e);
        }
      }
      processedObs.push(copy);
    }

    const track = stream?.getVideoTracks?.()[0]?.getSettings?.() || {};
    const session = {
      schema: "lookout.capture.session.v1",
      session_id: sessionId, created_at_utc: new Date().toISOString(),
      site_name: settings.name, view_type: settings.viewType,
      camera: { facing: settings.facing, requested_fps: settings.targetFps, measured_fps: Math.round(fpsEMA * 10) / 10,
        resolution: { width: track.width || null, height: track.height || null } },
      data_policy: "observations + optional event stills, stored on-device; nothing shared unless exported",
      counting: { mode: "line_crossing", direction_mode: settings.directionMode, sensitivity_threshold: settings.sensitivity, minimum_blob_area_px: settings.minSize, cooldown_ms: settings.cooldownMs, minimum_track_duration_ms: settings.minDurationMs },
      geometry: { line: line ? { id: "main", a_norm: line.a, b_norm: line.b } : null, active_area: null, ignore_areas: [] },
    };
    
    download(JSON.stringify({ 
      schema: "lookout.capture.export.v1", 
      exported_utc: new Date().toISOString(), 
      session, 
      observations: processedObs.reverse() 
    }, null, 2), "application/json", "json");
    
    statusLine.textContent = "JSON exported.";
  } catch (e) {
    statusLine.textContent = "JSON export failed: " + e.message;
  }
});

$("btnShareStills").addEventListener("click", async () => {
  try {
    statusLine.textContent = "Preparing stills for sharing...";
    const records = await store.listMedia({ use: USE, kind: "still", limit: 500 });
    if (!records.length) {
      statusLine.textContent = "No stills captured.";
      return;
    }
    const result = await shareOrDownloadMedia(records);
    statusLine.textContent = result === "shared"
      ? "Stills shared."
      : result === "downloaded"
        ? "Stills downloaded."
        : result === "cancelled"
          ? "Cancelled."
          : "Done.";
  } catch (e) {
    statusLine.textContent = "Sharing failed: " + e.message;
  }
});

$("btnShareBundle").addEventListener("click", async () => {
  try {
    statusLine.textContent = "Creating ZIP bundle...";
    const observations = await store.list({ use: USE, limit: 100000 });
    const mediaList = await store.listMedia({ use: USE, kind: "still", limit: 500 });
    const csvText = await store.exportCSV({ use: USE });
    
    const track = stream?.getVideoTracks?.()[0]?.getSettings?.() || {};
    const session = {
      schema: "lookout.capture.session.v1",
      session_id: sessionId, created_at_utc: new Date().toISOString(),
      site_name: settings.name, view_type: settings.viewType,
      camera: { facing: settings.facing, requested_fps: settings.targetFps, measured_fps: Math.round(fpsEMA * 10) / 10,
        resolution: { width: track.width || null, height: track.height || null } },
      data_policy: "observations + optional event stills, stored on-device; nothing shared unless exported",
      counting: { mode: "line_crossing", direction_mode: settings.directionMode, sensitivity_threshold: settings.sensitivity, minimum_blob_area_px: settings.minSize, cooldown_ms: settings.cooldownMs, minimum_track_duration_ms: settings.minDurationMs },
      geometry: { line: line ? { id: "main", a_norm: line.a, b_norm: line.b } : null, active_area: null, ignore_areas: [] },
    };
    const jsonText = JSON.stringify({ 
      schema: "lookout.capture.export.v1", 
      exported_utc: new Date().toISOString(), 
      session, 
      observations: observations.reverse() 
    }, null, 2);

    const files = [
      { name: "observations.csv", data: new TextEncoder().encode(csvText) },
      { name: "observations.json", data: new TextEncoder().encode(jsonText) }
    ];

    for (const media of mediaList) {
      if (media.blob) {
        const buffer = await media.blob.arrayBuffer();
        files.push({ name: media.filename, data: new Uint8Array(buffer) });
      }
    }

    const zipBlob = makeZip(files);
    const zipName = `lookout-bundle-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;

    const canCreateFile = typeof File !== "undefined";
    const fileObj = canCreateFile ? new File([zipBlob], zipName, { type: zipBlob.type }) : null;
    if (fileObj && navigator.canShare?.({ files: [fileObj] })) {
      try {
        await navigator.share({ files: [fileObj], title: zipName });
        statusLine.textContent = "Bundle shared.";
        return;
      } catch (e) {
        if (e.name === "AbortError") {
          statusLine.textContent = "Cancelled.";
          return;
        }
        console.warn("Share failed, downloading instead:", e);
      }
    }

    const a = document.createElement("a");
    a.href = URL.createObjectURL(zipBlob);
    a.download = zipName;
    a.click();
    URL.revokeObjectURL(a.href);
    statusLine.textContent = "Bundle downloaded.";
  } catch (e) {
    statusLine.textContent = "Failed to bundle ZIP: " + e.message;
  }
});


$("btnClear").addEventListener("click", async () => {
  if (!confirm("Delete all local observations and stills from this device?")) return;
  await store.clear({ use: USE });
  await store.clearMedia?.({ use: USE });
  totals = { aToB: 0, bToA: 0, total: 0, lastEvent: null };
  for (const [id, v] of [["cTotal", 0], ["cAB", 0], ["cBA", 0]]) $(id).textContent = v;
  await refreshExportPanel();
  statusLine.textContent = "Local observations cleared.";
});

// ── Battery / disk warnings ──────────────────────────────────────────────────
async function initWarnings() {
  try {
    const bat = await navigator.getBattery?.();
    if (bat) {
      const upd = () => {
        const low = bat.level < 0.15 && !bat.charging;
        $("warnBattery").hidden = !low;
        $("warnBattery").textContent = `🔋 ${Math.round(bat.level * 100)}%`;
      };
      bat.addEventListener("levelchange", upd); bat.addEventListener("chargingchange", upd); upd();
    }
  } catch (e) { /* no battery API */ }
  if (navigator.storage?.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    if (quota && usage / quota > 0.9) { $("warnDisk").hidden = false; $("warnDisk").textContent = "💾 storage low"; }
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────
(async function boot() {
  store = await openObservationStore();
  $("storedCount").textContent = await store.count({ use: USE }).catch(() => 0);
  initWarnings();
})();
