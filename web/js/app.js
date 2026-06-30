"use strict";

// App scaffold. Live capture → downscale → pixels → overlay loop. The real
// pipeline stages are stubs (see README "How it works").
const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const octx = overlay.getContext("2d");
const status = document.getElementById("status");

// Off-screen buffer we actually read pixels from (downscaled for speed —
// CV does not need full camera resolution, and old phones thank you for it).
const work = document.createElement("canvas");
const wctx = work.getContext("2d", { willReadFrequently: true });
const PROC_W = 320; // processing width; height derived from aspect
let procH = 240;

let stream = null, running = false, prevGray = null;

// ── Pipeline stages (stubs — see README "How it works") ──────────────
// 1. detect movers   — placeholder: frame differencing (motion energy)
// 2. track identity   — TODO: centroid tracker
// 3. locate           — TODO: pluggable backend.
//                       GroundPlaneHomography | KnownSizeRanger |
//                       StereoTriangulator | BearingOnly
// 4. derive           — TODO: speed / count / dwell

function toGray(imageData) {
  const { data, width, height } = imageData;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // luma approx, cheap
    g[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return g;
}

// STAGE 1 placeholder: mean absolute frame difference → 0..1 motion energy
function motionEnergy(gray) {
  if (!prevGray || prevGray.length !== gray.length) { prevGray = gray; return 0; }
  let acc = 0;
  for (let i = 0; i < gray.length; i++) acc += Math.abs(gray[i] - prevGray[i]);
  prevGray = gray;
  return acc / gray.length / 255;
}

function drawOverlay(energy) {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const w = overlay.width, barH = 12;
  octx.fillStyle = "#222";
  octx.fillRect(8, 8, w - 16, barH);
  octx.fillStyle = energy > 0.04 ? "#6ee79b" : "#5a6";
  octx.fillRect(8, 8, (w - 16) * Math.min(1, energy * 8), barH);
  octx.fillStyle = "#eee";
  octx.font = "13px system-ui, sans-serif";
  octx.fillText(`motion ${(energy * 100).toFixed(1)}%`, 10, 36);
}

function frame() {
  if (!running) return;
  if (video.videoWidth) {
    procH = Math.round(PROC_W * video.videoHeight / video.videoWidth);
    if (work.width !== PROC_W) { work.width = PROC_W; work.height = procH; }
    if (overlay.width !== video.clientWidth) {
      overlay.width = video.clientWidth;
      overlay.height = video.clientHeight;
    }
    wctx.drawImage(video, 0, 0, PROC_W, procH);
    const img = wctx.getImageData(0, 0, PROC_W, procH);
    const gray = toGray(img);
    const energy = motionEnergy(gray);   // STAGE 1 (stub)
    // STAGE 2–4: TODO
    drawOverlay(energy);
  }
  schedule();
}

const useRvfc = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
function schedule() {
  if (useRvfc) video.requestVideoFrameCallback(frame);
  else requestAnimationFrame(frame);
}

async function start() {
  status.textContent = "requesting camera…";
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } }, audio: false,
    });
  } catch (e) {
    status.textContent = "camera failed: " + e.name + " — " + e.message +
      " (try the capability check)";
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  running = true;
  prevGray = null;
  document.getElementById("start").disabled = true;
  document.getElementById("stop").disabled = false;
  const s = stream.getVideoTracks()[0].getSettings?.() || {};
  status.textContent = `running · ${video.videoWidth}×${video.videoHeight}` +
    (s.frameRate ? ` · ${s.frameRate.toFixed(0)} fps` : "") +
    ` · processing at ${PROC_W}px`;
  schedule();
}

function stop() {
  running = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; prevGray = null;
  octx.clearRect(0, 0, overlay.width, overlay.height);
  document.getElementById("start").disabled = false;
  document.getElementById("stop").disabled = true;
  status.textContent = "stopped.";
}

document.getElementById("start").addEventListener("click", start);
document.getElementById("stop").addEventListener("click", stop);
