// Security clips use. Keeps a short rolling video buffer, then saves a clip
// when sustained motion is detected. Existing store/media APIs are reused.
import { toGray } from "../engine/gray.js";
import { extractBlobs } from "../counting/blobs.js";
import { createMultiTracker } from "../counting/tracker.js";
import { pickMotionEvent } from "../tools/motion-trigger.js";
import { clipEventAction, shouldFinalizeClip } from "../tools/clip-series.js";
import { makeZip } from "../tools/zip.js";
import { shareOrDownloadMedia } from "../tools/share.js";
import { openObservationStore } from "../engine/store.js";
import { createCoverMapper } from "../tools/cover-map.js";
import { createSettingsBinder } from "../tools/settings.js";
import { initWarnings } from "../tools/warnings.js";

const USE = "security_clips";
const PROC_W = 176;
const RECORDER_SLICE_MS = 1000;
const RES_WIDTH = { low: 320, medium: 640, high: 1280 };

const settings = {
  facing: "environment",
  resolution: "medium",
  targetFps: 10,
  mirror: false,
  name: "security_clips",
  viewType: "doorway",
  sensitivity: 24,
  minSize: 14,
  minDurationMs: 1000,
  triggerCooldownMs: 1000,
  maxLost: 5,
  preRollMs: 5000,
  postRollMs: 5000,
  seriesGapMs: 8000,
  recordClips: true,
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
let totals = { events: 0, clips: 0, lastEvent: null };
let lastTriggerT = 0;
let lastProcT = 0;
let fpsEMA = 0;
let rafId = 0;
let flashT = 0;

let mediaRecorder = null;
let recorderMime = "video/webm";
let rollingChunks = [];
let activeClip = null;
let savedClipRecords = [];

let viewerActive = false;
let viewerMediaList = [];
let viewerObsMap = new Map();
let viewerIndex = 0;
let metadataVisible = true;
let currentVideoUrl = null;

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
  startRecorder();
  startObserving();
  loop();
}

function stopStream() {
  stopRecorder();
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
  if (el.requestFullscreen) return el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
  if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
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

function chooseRecorderMime() {
  if (typeof MediaRecorder === "undefined") return "";
  const options = [
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  for (const type of options) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return "";
}

function startRecorder() {
  rollingChunks = [];
  activeClip = null;
  savedClipRecords = [];
  if (!settings.recordClips) {
    statusLine.textContent = "Watching for motion. Clip recording is off.";
    return;
  }
  if (typeof MediaRecorder === "undefined") {
    statusLine.textContent = "MediaRecorder is not available on this browser.";
    return;
  }
  recorderMime = chooseRecorderMime();
  try {
    mediaRecorder = recorderMime
      ? new MediaRecorder(stream, { mimeType: recorderMime })
      : new MediaRecorder(stream);
  } catch (e) {
    mediaRecorder = null;
    statusLine.textContent = "clip recorder failed: " + e.message;
    return;
  }
  mediaRecorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const chunk = { blob: e.data, t: Date.now() };
    rollingChunks.push(chunk);
    trimRollingChunks();
    if (activeClip) activeClip.chunks.push(chunk);
  };
  mediaRecorder.start(RECORDER_SLICE_MS);
}

function stopRecorder() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch (e) { /* recorder already stopped */ }
  }
  mediaRecorder = null;
  rollingChunks = [];
  activeClip = null;
}

function trimRollingChunks() {
  const keepMs = Math.max(settings.preRollMs, settings.postRollMs, settings.seriesGapMs) + 5000;
  const cutoff = Date.now() - keepMs;
  rollingChunks = rollingChunks.filter((chunk) => chunk.t >= cutoff);
}

function loop() {
  if (!cameraOn) return;
  rafId = requestAnimationFrame(loop);

  const now = performance.now();
  const interval = 1000 / settings.targetFps;
  if (now - lastProcT < interval) {
    maybeFinalizeClip(Date.now());
    render([]);
    return;
  }
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
  maybeFinalizeClip(t);

  render(tracks);
  $("cTracks").textContent = tracks.length;
  $("cFps").textContent = fpsEMA ? fpsEMA.toFixed(1) : "-";
}

function detectMotionEvent(tracks, t) {
  const trigger = pickMotionEvent(tracks, {
    minDurationMs: settings.minDurationMs,
    cooldownMs: settings.triggerCooldownMs,
    lastEventT: lastTriggerT, now: t,
  });
  if (!trigger) return;
  lastTriggerT = t;
  noteClipEvent(trigger, t);
}

function noteClipEvent(track, t) {
  totals.events++;
  totals.lastEvent = t;
  flashT = performance.now();
  $("cEvents").textContent = totals.events;
  $("lastEvent").textContent = new Date(t).toLocaleTimeString();

  if (!settings.recordClips || !mediaRecorder) {
    statusLine.textContent = "Motion event detected. Clip recording is off.";
    return;
  }

  const action = clipEventAction(activeClip, t, { seriesGapMs: settings.seriesGapMs });
  if (action === "start") {
    const cutoff = t - settings.preRollMs;
    const initialChunks = rollingChunks.filter((chunk) => chunk.t >= cutoff);
    activeClip = {
      startT: initialChunks[0]?.t || t,
      firstEventT: t,
      lastEventT: t,
      chunks: initialChunks,
      eventCount: 1,
      trackIds: [track.id],
    };
    statusLine.textContent = "Motion event detected. Recording clip.";
  } else if (action === "append") {
    activeClip.lastEventT = t;
    activeClip.eventCount++;
    if (!activeClip.trackIds.includes(track.id)) activeClip.trackIds.push(track.id);
    statusLine.textContent = "Motion event added to current clip.";
  } else {
    finalizeClip(t);
    noteClipEvent(track, t);
  }
}

function maybeFinalizeClip(t) {
  if (shouldFinalizeClip(activeClip, t, { postRollMs: settings.postRollMs, seriesGapMs: settings.seriesGapMs })) {
    finalizeClip(t);
  }
}

async function finalizeClip(t) {
  if (!activeClip) return;
  const clip = activeClip;
  activeClip = null;
  const uniqueChunks = [];
  const seen = new Set();
  for (const chunk of clip.chunks) {
    if (seen.has(chunk.t)) continue;
    seen.add(chunk.t);
    uniqueChunks.push(chunk);
  }
  if (!uniqueChunks.length) {
    statusLine.textContent = "Motion clip had no video data.";
    return;
  }

  const blob = new Blob(uniqueChunks.map((chunk) => chunk.blob), { type: recorderMime || "video/webm" });
  const durationMs = Math.max(0, t - clip.startT);
  const obs = {
    use: USE,
    t: clip.firstEventT,
    session_id: sessionId,
    site_name: settings.name,
    view_type: settings.viewType,
    mode: "motion_clip",
    zone: "whole_frame",
    event_count: clip.eventCount,
    track_ids: clip.trackIds,
    clip_duration_ms: durationMs,
    pre_roll_ms: settings.preRollMs,
    post_roll_ms: settings.postRollMs,
    series_gap_ms: settings.seriesGapMs,
    mime: blob.type || "video/webm",
  };
  const ext = blob.type.includes("mp4") ? "mp4" : "webm";
  const filename = `${settings.name.replace(/[^a-z0-9_-]+/gi, "-") || USE}-${clip.firstEventT}.${ext}`;
  try {
    if (store) {
      await store.add(obs, { still: blob, filename });
      totals.clips++;
      $("cClips").textContent = totals.clips;
      statusLine.textContent = `Clip saved (${clip.eventCount} event${clip.eventCount === 1 ? "" : "s"}).`;
      if (viewerActive) await refreshViewerData();
    }
  } catch (e) {
    statusLine.textContent = "clip storage failed: " + e.message;
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
  statusLine.textContent = settings.recordClips ? "Watching for motion clips." : "Watching for motion events.";
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
  return `security-clips-${day}-${settings.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
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
  },
});

bind("setFacing", "facing");
bind("setResolution", "resolution");
bind("setMirror", "mirror");
bind("setName", "name");
bind("setViewType", "viewType");
bind("setRecordClips", "recordClips");
bind("setShowOverlay", "showOverlay");
bindNumberPair("setFps", "setFpsNumber", "targetFps");
bindNumberPair("setPreRoll", "setPreRollNumber", "preRollMs", { transform: (v) => v * 1000 });
bindNumberPair("setPostRoll", "setPostRollNumber", "postRollMs", { transform: (v) => v * 1000 });
bindNumberPair("setSeriesGap", "setSeriesGapNumber", "seriesGapMs", { transform: (v) => v * 1000 });
bindNumberPair("setSensitivity", "setSensitivityNumber", "sensitivity");
bindNumberPair("setMinSize", "setMinSizeNumber", "minSize");
bindNumberPair("setMinDuration", "setMinDurationNumber", "minDurationMs");
bindNumberPair("setTriggerCooldown", "setTriggerCooldownNumber", "triggerCooldownMs");
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
  if (currentVideoUrl) {
    URL.revokeObjectURL(currentVideoUrl);
    currentVideoUrl = null;
  }
  $("viewerVideo").pause();
  $("hudTop").style.display = "flex";
  $("hudBottom").style.display = "flex";
  $("viewerContainer").hidden = true;
  statusLine.textContent = observing ? "Watching for motion clips." : "Paused.";
}

async function refreshViewerData() {
  try {
    const currentId = viewerMediaList[viewerIndex]?.id;
    viewerMediaList = await store.listMedia({ use: USE, limit: 500 });
    const obsList = await store.list({ use: USE, limit: 500 });
    viewerObsMap = new Map(obsList.map((o) => [o.id, o]));
    if (currentId !== undefined) {
      const nextIndex = viewerMediaList.findIndex((m) => m.id === currentId);
      viewerIndex = nextIndex >= 0 ? nextIndex : Math.min(viewerIndex, viewerMediaList.length - 1);
    }
    if (viewerIndex < 0) viewerIndex = 0;
  } catch (e) {
    statusLine.textContent = "failed to load clips: " + e.message;
    viewerMediaList = [];
    viewerObsMap = new Map();
  }
}

function updateViewer() {
  if (currentVideoUrl) {
    URL.revokeObjectURL(currentVideoUrl);
    currentVideoUrl = null;
  }

  if (!viewerMediaList.length) {
    $("viewerVideo").style.display = "none";
    $("viewerMetadata").style.display = "none";
    $("viewerEmpty").hidden = false;
    $("viewerPageNum").textContent = "0 of 0";
    $("btnViewerPrev").disabled = true;
    $("btnViewerNext").disabled = true;
    return;
  }

  $("viewerVideo").style.display = "block";
  $("viewerMetadata").style.display = metadataVisible ? "block" : "none";
  $("viewerEmpty").hidden = true;
  const media = viewerMediaList[viewerIndex];
  const obs = viewerObsMap.get(media.observation_id);
  currentVideoUrl = URL.createObjectURL(media.blob);
  $("viewerVideo").src = currentVideoUrl;
  $("viewerPageNum").textContent = `${viewerIndex + 1} of ${viewerMediaList.length}`;
  $("btnViewerPrev").disabled = viewerIndex === 0;
  $("btnViewerNext").disabled = viewerIndex === viewerMediaList.length - 1;
  $("metaTime").textContent = new Date(obs?.t || media.t).toLocaleString();
  $("metaEvents").textContent = obs?.event_count ?? "n/a";
  $("metaDuration").textContent = obs?.clip_duration_ms ? `${(obs.clip_duration_ms / 1000).toFixed(1)}s` : "n/a";
  $("metaPrePost").textContent = obs ? `${Math.round(obs.pre_roll_ms / 1000)}s / ${Math.round(obs.post_roll_ms / 1000)}s` : "n/a";
  $("metaSession").textContent = obs?.session_id || "n/a";
}

$("btnViewClips").addEventListener("click", () => enterViewer());
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
  const clipCount = await store.countMedia({ use: USE });
  $("storedCount").textContent = count;
  $("storedClips").textContent = clipCount;
  $("sessionId").textContent = sessionId || "-";
  $("lastEvent").textContent = totals.lastEvent ? new Date(totals.lastEvent).toLocaleTimeString() : "-";
  $("btnShareClips").disabled = clipCount === 0;
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
  const name = `lookout-security-clips-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
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
    schema: "lookout.security_clips.session.v1",
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
    clips: {
      mode: "motion_clip",
      zone: "whole_frame",
      pre_roll_ms: settings.preRollMs,
      post_roll_ms: settings.postRollMs,
      series_gap_ms: settings.seriesGapMs,
      sensitivity_threshold: settings.sensitivity,
      minimum_blob_area_px: settings.minSize,
      minimum_motion_duration_ms: settings.minDurationMs,
    },
    data_policy: "observations and clips stay on-device; nothing shared unless exported",
  };
  download(JSON.stringify({
    schema: "lookout.security_clips.export.v1",
    exported_utc: new Date().toISOString(),
    session,
    observations: observations.reverse(),
  }, null, 2), "application/json", "json");
  statusLine.textContent = "JSON exported.";
});

$("btnShareClips").addEventListener("click", async () => {
  try {
    statusLine.textContent = "Preparing clips...";
    const records = await store.listMedia({ use: USE, limit: 500 });
    const result = await shareOrDownloadMedia(records, "lookout security clips");
    statusLine.textContent = result === "shared" ? "Clips shared." : result === "downloaded" ? "Clips downloaded." : "Cancelled.";
  } catch (e) {
    statusLine.textContent = "sharing failed: " + e.message;
  }
});

$("btnShareBundle").addEventListener("click", async () => {
  try {
    statusLine.textContent = "Creating ZIP bundle...";
    const observations = await store.list({ use: USE, limit: 100000 });
    const mediaList = await store.listMedia({ use: USE, limit: 500 });
    const csvText = await store.exportCSV({ use: USE });
    const jsonText = JSON.stringify({
      schema: "lookout.security_clips.export.v1",
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
    const zipName = `lookout-security-clips-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
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
  if (!confirm("Delete local clip observations and videos from this device?")) return;
  await store.clear({ use: USE });
  totals = { events: 0, clips: 0, lastEvent: null };
  $("cEvents").textContent = "0";
  $("cClips").textContent = "0";
  $("lastEvent").textContent = "-";
  await refreshExportPanel();
  statusLine.textContent = "Local clip observations cleared.";
});


(async function boot() {
  store = await openObservationStore();
  $("storedCount").textContent = await store.count({ use: USE }).catch(() => 0);
  $("storedClips").textContent = await store.countMedia({ use: USE }).catch(() => 0);
  initWarnings();
})();
