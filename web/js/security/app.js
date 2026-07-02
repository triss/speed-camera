// Security camera use. Full-screen camera watching the whole view for motion.
// Logs a timestamped event, and optionally a still, whenever sustained motion
// is seen. Reuses existing engine/CV/store modules only; no backend changes.
import { toGray } from "../engine/gray.js";
import { extractBlobs } from "../counting/blobs.js";
import { createMultiTracker } from "../counting/tracker.js";
import { pickMotionEvent } from "../tools/motion-trigger.js";
import { makeZip } from "../tools/zip.js";
import { shareOrDownloadMedia } from "../tools/share.js";
import { openObservationStore } from "../engine/store.js";
import { createCoverMapper } from "../tools/cover-map.js";
import { createSettingsBinder } from "../tools/settings.js";
import { initWarnings } from "../tools/warnings.js";

const USE = "security";
const PROC_W = 176;
const RES_WIDTH = { low: 320, medium: 640, high: 1280 };

const settings = {
  facing: "environment",
  resolution: "medium",
  targetFps: 10,
  mirror: false,
  name: "security_watch",
  viewType: "doorway",
  sensitivity: 24,
  minSize: 14,
  minDurationMs: 1000,
  cooldownMs: 5000,
  maxLost: 5,
  captureStills: true,
  showOverlay: true,
};

const $ = (id) => document.getElementById(id);
const cam = $("cam");
const draw = $("draw");
const dctx = draw.getContext("2d");
const statusLine = $("status");
const work = document.createElement("canvas");
const wctx = work.getContext("2d", { willReadFrequently: true });

let procH = 132;
let stream = null;
let cameraOn = false;
let observing = false;
let store = null;
let sessionId = null;
let prevGray = null;
let tracker = createMultiTracker({ maxLost: settings.maxLost });
let totals = { events: 0, lastEvent: null };
let lastEventT = 0;
let lastProcT = 0;
let fpsEMA = 0;
let rafId = 0;
let flashT = 0;

let viewerActive = false;
let viewerMediaList = [];
let viewerObsMap = new Map();
let viewerIndex = 0;
let metadataVisible = true;
let currentImageUrl = null;

removeFloatingThemePicker();
document.addEventListener("DOMContentLoaded", removeFloatingThemePicker);
function removeFloatingThemePicker() {
  const floatingThemePicker = document.getElementById("themePicker");
  if (floatingThemePicker) floatingThemePicker.remove();
}

const { frameToScreen } = createCoverMapper({
  video: cam,
  overlay: draw,
  getMirror: () => settings.mirror,
});

async function startCamera() {
  stopStream();
  statusLine.textContent = "requesting camera...";
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
    statusLine.textContent = "camera failed: " + e.name + " - " + e.message;
    return;
  }
  cam.srcObject = stream;
  cam.classList.toggle("mirror", settings.mirror);
  cam.play().catch(() => {});
  cameraOn = true;
  prevGray = null;
  tracker = createMultiTracker({ maxLost: settings.maxLost });
  $("btnSwitch").disabled = false;
  resizeOverlay();
  startObserving();
  loop();
}

function stopStream() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

function stopCamera() {
  observing = false;
  cameraOn = false;
  stopStream();
  cancelAnimationFrame(rafId);
  dctx.clearRect(0, 0, draw.width, draw.height);
  prevGray = null;
  tracker = createMultiTracker({ maxLost: settings.maxLost });
  updatePrimaryButton();
  $("btnSwitch").disabled = true;
  statusLine.textContent = "Stopped.";
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

function resizeOverlay() {
  draw.width = draw.clientWidth;
  draw.height = draw.clientHeight;
  if (cam.videoWidth) procH = Math.round(PROC_W * cam.videoHeight / cam.videoWidth);
  if (work.width !== PROC_W || work.height !== procH) {
    work.width = PROC_W;
    work.height = procH;
  }
}
window.addEventListener("resize", () => { if (cameraOn) resizeOverlay(); });

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
  if (work.height !== procH) work.height = procH;
  wctx.drawImage(cam, 0, 0, PROC_W, procH);
  const gray = toGray(wctx.getImageData(0, 0, PROC_W, procH));

  let blobs = [];
  if (prevGray && prevGray.length === gray.length) {
    const mask = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i++) {
      if (Math.abs(gray[i] - prevGray[i]) > settings.sensitivity) mask[i] = 1;
    }
    blobs = extractBlobs(mask, PROC_W, procH, settings.minSize);
  }
  prevGray = gray;

  const t = Date.now();
  const tracks = tracker.update(blobs, t);
  if (observing) detectMotionEvent(tracks, t);

  render(tracks);
  $("cTracks").textContent = tracks.length;
  $("cFps").textContent = fpsEMA ? fpsEMA.toFixed(1) : "-";
}

function detectMotionEvent(tracks, t) {
  const trigger = pickMotionEvent(tracks, {
    minDurationMs: settings.minDurationMs,
    cooldownMs: settings.cooldownMs,
    lastEventT, now: t,
  });
  if (!trigger) return;
  lastEventT = t;
  recordEvent(trigger, t);
}

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

async function recordEvent(track, t) {
  totals.events++;
  totals.lastEvent = t;
  flashT = performance.now();
  $("cEvents").textContent = totals.events;
  $("lastEvent").textContent = new Date(t).toLocaleTimeString();
  statusLine.textContent = settings.captureStills ? "Motion event saved with still." : "Motion event saved.";

  const confidence = Math.min(1, track.framesSeen / 12);
  const obs = {
    use: USE,
    t,
    session_id: sessionId,
    site_name: settings.name,
    view_type: settings.viewType,
    mode: "motion_in_view",
    zone: "whole_frame",
    track_id: track.id,
    duration_ms: track.lastT - track.firstT,
    frames_seen: track.framesSeen,
    confidence: Math.round(confidence * 100) / 100,
    class_hint: "unknown",
  };

  let stillBlob = null;
  const filename = `${settings.name.replace(/[^a-z0-9_-]+/gi, "-") || USE}-${t}.jpg`;
  if (settings.captureStills) {
    try { stillBlob = await captureStillBlob(); }
    catch (e) { statusLine.textContent = "still capture failed: " + e.message; }
  }

  try {
    if (store) {
      await store.add(obs, stillBlob ? { still: stillBlob, filename } : {});
      if (viewerActive) await refreshViewerData();
    }
  } catch (e) {
    statusLine.textContent = "storage failed: " + e.message;
  }
}

function render(tracks) {
  dctx.clearRect(0, 0, draw.width, draw.height);
  if (settings.showOverlay) {
    dctx.strokeStyle = "rgba(110,231,155,.9)";
    dctx.lineWidth = 1.5;
    for (const tr of tracks || []) {
      const s = frameToScreen({ x: tr.cx / PROC_W, y: tr.cy / procH });
      dctx.beginPath();
      dctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      dctx.stroke();
    }
  }

  const age = performance.now() - flashT;
  if (age < 900) {
    const alpha = Math.max(0, 1 - age / 900);
    dctx.save();
    dctx.globalAlpha = alpha;
    dctx.strokeStyle = "#ffd166";
    dctx.lineWidth = 8;
    dctx.strokeRect(10, 10, draw.width - 20, draw.height - 20);
    dctx.restore();
  }
}

$("btnCamera").addEventListener("click", async () => {
  if (!cameraOn) {
    await requestFullscreen();
    startCamera();
    return;
  }
  if (observing) stopObserving();
  else startObserving();
});

$("btnSwitch").addEventListener("click", () => {
  settings.facing = settings.facing === "environment" ? "user" : "environment";
  $("setFacing").value = settings.facing;
  if (cameraOn) startCamera();
});

function startObserving() {
  observing = true;
  if (!sessionId) sessionId = makeSessionId();
  $("sessionId").textContent = sessionId;
  updatePrimaryButton();
  statusLine.textContent = "Watching for motion.";
}

function stopObserving() {
  observing = false;
  updatePrimaryButton();
  statusLine.textContent = "Paused.";
  $("sessionId").textContent = sessionId || "-";
}

function updatePrimaryButton() {
  const b = $("btnCamera");
  b.classList.toggle("observing", observing);
  b.classList.toggle("primary", !cameraOn);
  b.classList.toggle("go", cameraOn && !observing);
  b.disabled = false;
  b.textContent = !cameraOn ? "Start camera" : observing ? "Pause" : "Resume";
}

function makeSessionId() {
  const day = new Date().toISOString().slice(0, 10);
  return `security-${day}-${settings.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}

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

const { bind, bindNumberPair } = createSettingsBinder({
  $,
  settings,
  onChange: ({ key }) => {
    if ((key === "resolution" || key === "facing") && cameraOn) startCamera();
    if (key === "mirror") cam.classList.toggle("mirror", settings.mirror);
    if (key === "showOverlay") render([]);
  },
});

bind("setFacing", "facing");
bind("setResolution", "resolution");
bind("setMirror", "mirror");
bind("setName", "name");
bind("setViewType", "viewType");
bind("setCaptureStills", "captureStills");
bind("setShowOverlay", "showOverlay");
bindNumberPair("setFps", "setFpsNumber", "targetFps");
bindNumberPair("setSensitivity", "setSensitivityNumber", "sensitivity");
bindNumberPair("setMinSize", "setMinSizeNumber", "minSize");
bindNumberPair("setMinDuration", "setMinDurationNumber", "minDurationMs");
bindNumberPair("setCooldown", "setCooldownNumber", "cooldownMs");
bindNumberPair("setMaxLost", "setMaxLostNumber", "maxLost", {
  onCommit: () => {
    tracker = createMultiTracker({ maxLost: settings.maxLost });
  },
});

async function enterViewer() {
  viewerActive = true;
  $("hudTop").style.display = "none";
  $("hudBottom").style.display = "none";
  $("viewerContainer").hidden = false;
  await refreshViewerData();
  viewerIndex = 0;
  updateViewer();
}

function exitViewer() {
  viewerActive = false;
  if (currentImageUrl) {
    URL.revokeObjectURL(currentImageUrl);
    currentImageUrl = null;
  }
  $("hudTop").style.display = "flex";
  $("hudBottom").style.display = "flex";
  $("viewerContainer").hidden = true;
  statusLine.textContent = observing ? "Watching for motion." : "Paused.";
}

async function refreshViewerData() {
  try {
    const currentId = viewerMediaList[viewerIndex]?.id;
    viewerMediaList = await store.listMedia({ use: USE, kind: "still", limit: 500 });
    const obsList = await store.list({ use: USE, limit: 500 });
    viewerObsMap = new Map(obsList.map((o) => [o.id, o]));
    if (currentId !== undefined) {
      const nextIndex = viewerMediaList.findIndex((m) => m.id === currentId);
      viewerIndex = nextIndex >= 0 ? nextIndex : Math.min(viewerIndex, viewerMediaList.length - 1);
    }
    if (viewerIndex < 0) viewerIndex = 0;
  } catch (e) {
    statusLine.textContent = "failed to load stills: " + e.message;
    viewerMediaList = [];
    viewerObsMap = new Map();
  }
}

function updateViewer() {
  if (currentImageUrl) {
    URL.revokeObjectURL(currentImageUrl);
    currentImageUrl = null;
  }

  if (!viewerMediaList.length) {
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

  $("metaTime").textContent = new Date(obs?.t || media.t).toLocaleString();
  $("metaMode").textContent = obs?.mode || "motion_in_view";
  $("metaTrackId").textContent = obs?.track_id != null ? `#${obs.track_id}` : "n/a";
  $("metaDuration").textContent = obs?.duration_ms ? `${(obs.duration_ms / 1000).toFixed(1)}s` : "n/a";
  $("metaConfidence").textContent = obs?.confidence != null ? `${Math.round(obs.confidence * 100)}%` : "n/a";
  $("metaSession").textContent = obs?.session_id || "n/a";
}

$("btnViewStills").addEventListener("click", () => enterViewer());
$("btnViewerBack").addEventListener("click", () => exitViewer());
$("btnToggleMetadata").addEventListener("click", () => {
  metadataVisible = !metadataVisible;
  $("viewerMetadata").style.display = metadataVisible ? "block" : "none";
  $("btnToggleMetadata").textContent = metadataVisible ? "Hide info" : "Show info";
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

async function refreshExportPanel() {
  if (!store) return;
  const count = await store.count({ use: USE });
  const stillsCount = await store.countMedia({ use: USE });
  $("storedCount").textContent = count;
  $("storedStills").textContent = stillsCount;
  $("sessionId").textContent = sessionId || "-";
  $("lastEvent").textContent = totals.lastEvent ? new Date(totals.lastEvent).toLocaleTimeString() : "-";
  $("btnShareStills").disabled = stillsCount === 0;
  $("btnShareBundle").disabled = count === 0;

  if (navigator.storage?.estimate) {
    const { usage } = await navigator.storage.estimate();
    $("storageUsed").textContent = usage != null ? (usage / 1e6).toFixed(1) + " MB" : "n/a";
  } else {
    $("storageUsed").textContent = "n/a";
  }
}

function download(text, type, ext) {
  const blob = new Blob([text], { type });
  const name = `lookout-security-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
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
    schema: "lookout.security.session.v1",
    session_id: sessionId,
    created_at_utc: new Date().toISOString(),
    site_name: settings.name,
    view_type: settings.viewType,
    camera: {
      facing: settings.facing,
      requested_fps: settings.targetFps,
      measured_fps: Math.round(fpsEMA * 10) / 10,
      resolution: { width: track.width || null, height: track.height || null },
    },
    security: {
      mode: "motion_in_view",
      zone: "whole_frame",
      sensitivity_threshold: settings.sensitivity,
      minimum_blob_area_px: settings.minSize,
      cooldown_ms: settings.cooldownMs,
      minimum_motion_duration_ms: settings.minDurationMs,
      capture_stills: settings.captureStills,
    },
    data_policy: "observations and optional event stills stay on-device; nothing shared unless exported",
  };
  download(JSON.stringify({
    schema: "lookout.security.export.v1",
    exported_utc: new Date().toISOString(),
    session,
    observations: observations.reverse(),
  }, null, 2), "application/json", "json");
  statusLine.textContent = "JSON exported.";
});

$("btnShareStills").addEventListener("click", async () => {
  try {
    statusLine.textContent = "Preparing stills...";
    const records = await store.listMedia({ use: USE, kind: "still", limit: 500 });
    const result = await shareOrDownloadMedia(records, "lookout security stills");
    statusLine.textContent = result === "shared" ? "Stills shared." : result === "downloaded" ? "Stills downloaded." : "Cancelled.";
  } catch (e) {
    statusLine.textContent = "sharing failed: " + e.message;
  }
});

$("btnShareBundle").addEventListener("click", async () => {
  try {
    statusLine.textContent = "Creating ZIP bundle...";
    const observations = await store.list({ use: USE, limit: 100000 });
    const mediaList = await store.listMedia({ use: USE, kind: "still", limit: 500 });
    const csvText = await store.exportCSV({ use: USE });
    const jsonText = JSON.stringify({
      schema: "lookout.security.export.v1",
      exported_utc: new Date().toISOString(),
      observations: observations.reverse(),
    }, null, 2);
    const files = [
      { name: "observations.csv", data: new TextEncoder().encode(csvText) },
      { name: "observations.json", data: new TextEncoder().encode(jsonText) },
    ];
    for (const media of mediaList) {
      if (media.blob) {
        const buffer = await media.blob.arrayBuffer();
        files.push({ name: media.filename, data: new Uint8Array(buffer) });
      }
    }
    const zipBlob = makeZip(files);
    const zipName = `lookout-security-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
    const fileObj = typeof File !== "undefined" ? new File([zipBlob], zipName, { type: zipBlob.type }) : null;
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
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(zipBlob);
    a.download = zipName;
    a.click();
    URL.revokeObjectURL(a.href);
    statusLine.textContent = "Bundle downloaded.";
  } catch (e) {
    statusLine.textContent = "bundle failed: " + e.message;
  }
});

$("btnClear").addEventListener("click", async () => {
  if (!confirm("Delete local security observations and stills from this device?")) return;
  await store.clear({ use: USE });
  totals = { events: 0, lastEvent: null };
  $("cEvents").textContent = "0";
  $("lastEvent").textContent = "-";
  await refreshExportPanel();
  statusLine.textContent = "Local security observations cleared.";
});


(async function boot() {
  store = await openObservationStore();
  $("storedCount").textContent = await store.count({ use: USE }).catch(() => 0);
  $("storedStills").textContent = await store.countMedia({ use: USE }).catch(() => 0);
  initWarnings();
})();
