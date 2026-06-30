"use strict";

const start = document.getElementById("startSpeedCalibration");
const capture = document.getElementById("captureSpeedCalibration");
const undo = document.getElementById("undoSpeedCalibrationPoint");
const clear = document.getElementById("clearSpeedCalibration");
const copy = document.getElementById("copySpeedCalibration");
const download = document.getElementById("downloadSpeedCalibration");
const status = document.getElementById("speedCalibrationStatus");
const sensorStatus = document.getElementById("speedCalibrationSensorStatus");
const video = document.getElementById("speedCalibrationVideo");
const canvas = document.getElementById("speedCalibrationCanvas");
const rows = document.getElementById("speedCalibrationRows");
const output = document.getElementById("speedCalibrationJson");

if (!start || !capture || !undo || !clear || !copy || !download || !status ||
    !sensorStatus || !video || !canvas || !rows || !output) {
  throw new Error("Speed calibration controls are missing from the page.");
}

const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("Speed calibration canvas is unavailable.");

const points = [];
let stream = null;
let image = null;
let capturedAt = null;
let capturedFrame = null;
let monitorStartedAt = 0;
let monitorTimer = 0;
let stableSince = 0;
let lastMotionAt = 0;
let lastOrientationAt = 0;
let latestMotion = null;
let latestOrientation = null;
let baselineOrientation = null;

function setStatus(message) {
  status.textContent = message;
}

function setSensorStatus(message) {
  sensorStatus.textContent = message;
}

function stopStream() {
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
}

function stopMonitoring() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = 0;
  window.removeEventListener("devicemotion", onMotion);
  window.removeEventListener("deviceorientation", onOrientation);
}

async function requestSensorPermission() {
  const motion = window.DeviceMotionEvent;
  const orientation = window.DeviceOrientationEvent;
  if (motion?.requestPermission) {
    try { await motion.requestPermission(); } catch (error) {}
  }
  if (orientation?.requestPermission) {
    try { await orientation.requestPermission(); } catch (error) {}
  }
}

function onMotion(event) {
  latestMotion = event;
  lastMotionAt = performance.now();
}

function onOrientation(event) {
  latestOrientation = event;
  lastOrientationAt = performance.now();
  if (!baselineOrientation && typeof event.beta === "number" && typeof event.gamma === "number") {
    baselineOrientation = { alpha: event.alpha || 0, beta: event.beta || 0, gamma: event.gamma || 0 };
  }
}

function rotationMagnitude(event) {
  const rate = event?.rotationRate;
  if (!rate) return 0;
  return Math.abs(rate.alpha || 0) + Math.abs(rate.beta || 0) + Math.abs(rate.gamma || 0);
}

function orientationDelta(event) {
  if (!event || !baselineOrientation) return 0;
  const alphaDelta = Math.abs((event.alpha || 0) - baselineOrientation.alpha);
  const heading = Math.min(alphaDelta, 360 - alphaDelta);
  return heading +
    Math.abs((event.beta || 0) - baselineOrientation.beta) +
    Math.abs((event.gamma || 0) - baselineOrientation.gamma);
}

function isStill(now) {
  const hasRecentMotion = now - lastMotionAt < 900;
  const hasRecentOrientation = now - lastOrientationAt < 900;
  if (!hasRecentMotion && !hasRecentOrientation) return false;
  const rotation = rotationMagnitude(latestMotion);
  const tilt = orientationDelta(latestOrientation);
  setSensorStatus(`Phone movement: rotation ${rotation.toFixed(1)}, orientation change ${tilt.toFixed(1)} degrees.`);
  return rotation < 2.5 && tilt < 2;
}

function monitorStillness() {
  const now = performance.now();
  if (isStill(now)) {
    if (!stableSince) stableSince = now;
    const stableFor = (now - stableSince) / 1000;
    setStatus(`Leave the phone still. Capturing in ${Math.max(0, 2 - stableFor).toFixed(1)} seconds.`);
    if (stableFor >= 2) captureFrame();
    return;
  }
  stableSince = 0;
  if (!lastMotionAt && !lastOrientationAt && now - monitorStartedAt > 3500) {
    capture.disabled = false;
    setSensorStatus("Motion sensors are unavailable or blocked. Leave the phone still, then use Capture now.");
  }
}

async function startCalibration() {
  start.disabled = true;
  capture.disabled = true;
  setStatus("Put the phone in the exact place it will watch, then leave it to settle.");
  setSensorStatus("Requesting camera and motion sensors...");
  points.length = 0;
  image = null;
  capturedFrame = null;
  capturedAt = null;
  latestMotion = null;
  latestOrientation = null;
  baselineOrientation = null;
  lastMotionAt = 0;
  lastOrientationAt = 0;
  render();
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Calibration camera failed: this browser does not support camera capture.");
    start.disabled = false;
    return;
  }
  try {
    await requestSensorPermission();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch (error) {
    setStatus(`Calibration camera failed: ${error.name}.`);
    stopStream();
    start.disabled = false;
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  window.addEventListener("devicemotion", onMotion);
  window.addEventListener("deviceorientation", onOrientation);
  monitorStartedAt = performance.now();
  stableSince = 0;
  capture.disabled = false;
  setSensorStatus("Watching phone movement. Keep it still until the photo is captured.");
  monitorTimer = setInterval(monitorStillness, 250);
}

function fitCanvasToImage() {
  const parentWidth = canvas.parentElement ? canvas.parentElement.clientWidth : 680;
  const maxWidth = Math.max(1, Math.min(680, parentWidth - 2));
  const scale = image ? maxWidth / image.width : 1;
  canvas.width = image ? Math.max(1, Math.round(image.width * scale)) : 640;
  canvas.height = image ? Math.max(1, Math.round(image.height * scale)) : 360;
}

function captureFrame() {
  if (!stream || !video.videoWidth) return;
  stopMonitoring();
  image = { width: video.videoWidth, height: video.videoHeight };
  capturedAt = new Date();
  capturedFrame = document.createElement("canvas");
  capturedFrame.width = image.width;
  capturedFrame.height = image.height;
  capturedFrame.getContext("2d").drawImage(video, 0, 0, image.width, image.height);
  fitCanvasToImage();
  stopStream();
  start.disabled = false;
  capture.disabled = true;
  setStatus("Calibration photo captured. Click two points for each known distance, then enter the real distance in metres.");
  render();
}

function imagePointFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = image.width / rect.width;
  const scaleY = image.height / rect.height;
  return {
    x: Math.round((event.clientX - rect.left) * scaleX),
    y: Math.round((event.clientY - rect.top) * scaleY),
  };
}

function calibrationJson() {
  const pairs = [];
  for (let i = 0; i < points.length - 1; i += 2) {
    pairs.push({
      image_points: [
        { x: points[i].x, y: points[i].y },
        { x: points[i + 1].x, y: points[i + 1].y },
      ],
      distance_m: points[i].distance_m || 0,
    });
  }
  return JSON.stringify({
    use: "speed",
    captured_at: capturedAt ? capturedAt.toISOString() : null,
    image: image || { width: 0, height: 0 },
    distance_pairs: pairs,
  }, null, 2);
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#050607";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!image) return;
  if (capturedFrame) ctx.drawImage(capturedFrame, 0, 0, canvas.width, canvas.height);
  const scaleX = canvas.width / image.width;
  const scaleY = canvas.height / image.height;
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const x = point.x * scaleX;
    const y = point.y * scaleY;
    if (i % 2 === 1) {
      const previous = points[i - 1];
      ctx.strokeStyle = "#8af2b0";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(previous.x * scaleX, previous.y * scaleY);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd166";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#101214";
    ctx.stroke();
    ctx.fillStyle = "#101214";
    ctx.font = "700 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), x, y);
  }
}

function renderRows() {
  rows.replaceChildren();
  for (let i = 0; i < points.length - 1; i += 2) {
    const pair = Math.floor(i / 2) + 1;
    const row = document.createElement("tr");
    const number = document.createElement("th");
    const pointCell = document.createElement("td");
    const distanceCell = document.createElement("td");
    const distance = document.createElement("input");
    number.scope = "row";
    number.textContent = String(pair);
    pointCell.textContent = `${points[i].x},${points[i].y} to ${points[i + 1].x},${points[i + 1].y}`;
    distance.type = "number";
    distance.step = "0.001";
    distance.min = "0";
    distance.value = points[i].distance_m || "";
    distance.setAttribute("aria-label", `Pair ${pair} distance in metres`);
    distance.addEventListener("input", () => {
      points[i].distance_m = Number(distance.value || 0);
      updateControls();
    });
    distanceCell.appendChild(distance);
    row.append(number, pointCell, distanceCell);
    rows.appendChild(row);
  }
}

function updateControls() {
  const hasImage = !!image;
  const hasPoints = points.length > 0;
  const hasPairs = points.length > 1;
  undo.disabled = !hasPoints;
  clear.disabled = !hasPoints;
  copy.disabled = !hasPairs;
  download.disabled = !hasPairs;
  output.value = calibrationJson();
  if (hasImage && points.length % 2 === 1) {
    setStatus("Click the second point for this distance pair.");
  }
}

function render() {
  draw();
  renderRows();
  updateControls();
}

canvas.addEventListener("click", (event) => {
  if (!image) {
    setStatus("Start calibration and wait for the still photo first.");
    return;
  }
  points.push(imagePointFromEvent(event));
  render();
  if (points.length % 2 === 0) setStatus("Enter the real distance between the last two points.");
  else setStatus("Click the second point for this distance pair.");
});

start.addEventListener("click", startCalibration);
capture.addEventListener("click", captureFrame);
undo.addEventListener("click", () => {
  points.pop();
  render();
});
clear.addEventListener("click", () => {
  points.length = 0;
  render();
  setStatus("Points cleared. Click two points for each known distance.");
});
copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(output.value);
    setStatus("Calibration JSON copied.");
  } catch (error) {
    output.select();
    setStatus("Clipboard unavailable. Select and copy the JSON manually.");
  }
});
download.addEventListener("click", () => {
  const blob = new Blob([output.value], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "lookout-speed-calibration.json";
  link.click();
  URL.revokeObjectURL(link.href);
});
window.addEventListener("resize", () => {
  if (!image) return;
  fitCanvasToImage();
  render();
});

fitCanvasToImage();
render();
