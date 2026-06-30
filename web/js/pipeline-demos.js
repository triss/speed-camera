const WIDTH = 640;
const HEIGHT = 360;
const PROC_W = 160;
const PROC_H = 90;

function installDownsampleDemo(root) {
  const canvas = root.querySelector("canvas");
  const output = root.querySelector("[data-demo-output]");
  const log = root.querySelector("[data-demo-log]");
  const start = root.querySelector("[data-camera-start]");
  const stop = root.querySelector("[data-camera-stop]");
  const range = root.querySelector("[data-downsample-range]");
  if (!canvas || !output || !start || !stop || !range) return;

  const ctx = canvas.getContext("2d");
  const video = document.createElement("video");
  const work = document.createElement("canvas");
  const workCtx = work.getContext("2d");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;

  let stream = null;
  let rafId = 0;
  let lastLogAt = 0;

  function clearCanvas() {
    ctx.fillStyle = "#050607";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }

  function currentSize() {
    const width = Number(range.value);
    const height = Math.max(1, Math.round(width * HEIGHT / WIDTH));
    return { width, height };
  }

  function setOutput(now = performance.now()) {
    const { width, height } = currentSize();
    const sourcePixels = WIDTH * HEIGHT;
    const processingPixels = width * height;
    const ratio = Math.round(sourcePixels / processingPixels);
    const message = `Processing at ${width} x ${height}: about 1 processing pixel per ${ratio} display pixels.`;
    output.textContent = message;
    if (now - lastLogAt > 1400) {
      appendLog(log, message);
      lastLogAt = now;
    }
  }

  function frame(now) {
    if (!stream) return;
    if (video.videoWidth) {
      const { width, height } = currentSize();
      work.width = width;
      work.height = height;
      workCtx.drawImage(video, 0, 0, width, height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(work, 0, 0, WIDTH, HEIGHT);
      ctx.imageSmoothingEnabled = true;
      setOutput(now);
    }
    rafId = requestAnimationFrame(frame);
  }

  async function begin() {
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      output.textContent = "Webcam demo unavailable: this browser does not expose getUserMedia.";
      appendLog(log, "webcam unavailable");
      return;
    }
    output.textContent = "Requesting webcam permission...";
    appendLog(log, "requesting webcam permission");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (error) {
      output.textContent = `Webcam failed: ${error.name}.`;
      appendLog(log, `webcam failed: ${error.name}`);
      return;
    }
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => {});
    start.disabled = true;
    stop.disabled = false;
    appendLog(log, "webcam started");
    rafId = requestAnimationFrame(frame);
  }

  function end() {
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    start.disabled = false;
    stop.disabled = true;
    clearCanvas();
    output.textContent = "Webcam stopped.";
    appendLog(log, "webcam stopped");
  }

  range.addEventListener("input", () => setOutput());
  start.addEventListener("click", begin);
  stop.addEventListener("click", end);
  clearCanvas();
  setOutput();
  appendLog(log, "ready");
}

function toGray(imageData) {
  const gray = new Uint8ClampedArray(imageData.width * imageData.height);
  for (let i = 0, j = 0; i < imageData.data.length; i += 4, j++) {
    gray[j] = (imageData.data[i] * 77 + imageData.data[i + 1] * 150 + imageData.data[i + 2] * 29) >> 8;
  }
  return gray;
}

function changedRegion(gray, prevGray, threshold) {
  if (!prevGray) return { count: 0, prevGray: gray, energy: 0, mask: new Uint8ClampedArray(PROC_W * PROC_H) };
  const mask = new Uint8ClampedArray(PROC_W * PROC_H);
  let minX = PROC_W, minY = PROC_H, maxX = 0, maxY = 0, count = 0, sumX = 0, sumY = 0;
  for (let y = 0; y < PROC_H; y++) {
    for (let x = 0; x < PROC_W; x++) {
      const i = y * PROC_W + x;
      const delta = Math.abs(gray[i] - prevGray[i]);
      if (delta < threshold) continue;
      mask[i] = Math.min(255, delta * 3);
      count++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return {
    count,
    prevGray: gray,
    box: count ? {
      x: minX / PROC_W * WIDTH,
      y: minY / PROC_H * HEIGHT,
      w: (maxX - minX + 1) / PROC_W * WIDTH,
      h: (maxY - minY + 1) / PROC_H * HEIGHT,
    } : null,
    centroid: count ? {
      x: sumX / count / PROC_W * WIDTH,
      y: sumY / count / PROC_H * HEIGHT,
    } : null,
    energy: count / (PROC_W * PROC_H),
    mask,
  };
}

function drawCameraFrame(ctx, video, workCtx) {
  workCtx.drawImage(video, 0, 0, PROC_W, PROC_H);
  ctx.drawImage(video, 0, 0, WIDTH, HEIGHT);
  return workCtx.getImageData(0, 0, PROC_W, PROC_H);
}

function lerp(a, b, amount) {
  return a + (b - a) * amount;
}

function smoothBox(previous, next, amount) {
  if (!next) return previous ? { ...previous, alpha: previous.alpha * 0.88 } : null;
  if (!previous || previous.alpha < 0.05) return { ...next, alpha: 1 };
  return {
    x: lerp(previous.x, next.x, amount),
    y: lerp(previous.y, next.y, amount),
    w: lerp(previous.w, next.w, amount),
    h: lerp(previous.h, next.h, amount),
    alpha: Math.min(1, previous.alpha + 0.2),
  };
}

function smoothPoint(previous, next, amount) {
  if (!next) return previous ? { ...previous, alpha: previous.alpha * 0.9 } : null;
  if (!previous || previous.alpha < 0.05) return { ...next, alpha: 1 };
  return {
    x: lerp(previous.x, next.x, amount),
    y: lerp(previous.y, next.y, amount),
    alpha: Math.min(1, previous.alpha + 0.25),
  };
}

function drawRegion(ctx, state, mode, now) {
  const box = state.box;
  const point = state.point;
  if (box && box.alpha > 0.03) {
    ctx.save();
    ctx.globalAlpha = box.alpha;
    ctx.strokeStyle = "#ffd166";
    ctx.lineWidth = 4;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.restore();
  }
  if (point && point.alpha > 0.03 && mode !== "difference") {
    state.trail.push({ x: point.x, y: point.y, t: now, alpha: point.alpha });
    while (state.trail.length > 36) state.trail.shift();
    for (let i = 1; i < state.trail.length; i++) {
      const prev = state.trail[i - 1];
      const next = state.trail[i];
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, next.alpha));
      ctx.strokeStyle = "#8af2b0";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(next.x, next.y);
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = point.alpha;
    ctx.fillStyle = "#8af2b0";
    ctx.beginPath();
    ctx.arc(point.x, point.y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  state.trail = state.trail
    .map((p) => ({ ...p, alpha: p.alpha * 0.94 }))
    .filter((p) => p.alpha > 0.04);
}

function drawMask(ctx, mask, maskCanvas) {
  const image = ctx.createImageData(PROC_W, PROC_H);
  for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
    const value = mask[i];
    image.data[j] = value;
    image.data[j + 1] = value;
    image.data[j + 2] = value;
    image.data[j + 3] = 255;
  }
  maskCanvas.width = PROC_W;
  maskCanvas.height = PROC_H;
  const maskCtx = maskCanvas.getContext("2d");
  maskCtx.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(maskCanvas, 0, 0, WIDTH, HEIGHT);
  ctx.imageSmoothingEnabled = true;
}

function measurement(region, state, mode, now) {
  if (mode === "difference" || mode === "mask") {
    return `Webcam difference: ${(region.energy * 100).toFixed(1)}% of sampled pixels changed. Move a hand in view.`;
  }
  if (!state.point || state.point.alpha < 0.05) return "No clear movement yet. Move a hand or object in view.";
  if (mode === "track") {
    return `Webcam tracking: motion centre at x ${state.point.x.toFixed(0)}, y ${state.point.y.toFixed(0)}.`;
  }
  if (state.trail.length < 2) return "Move something across the frame to estimate pixel speed.";
  const first = state.trail[0];
  const last = state.trail[state.trail.length - 1];
  const dt = Math.max(0.001, (now - first.t) / 1000);
  const dist = Math.hypot(last.x - first.x, last.y - first.y);
  return `Webcam measurement: ${dist.toFixed(0)} pixels over ${dt.toFixed(1)} seconds, about ${(dist / dt).toFixed(0)} px/s.`;
}

function formatTime(date) {
  return date.toTimeString().slice(0, 8);
}

function appendLog(log, message) {
  if (!log) return;
  log.textContent += `${formatTime(new Date())}  ${message}\n`;
  const lines = log.textContent.split("\n");
  if (lines.length > 9) log.textContent = lines.slice(lines.length - 9).join("\n");
  log.scrollTop = log.scrollHeight;
}

function installWebcamDemo(root) {
  const mode = root.dataset.webcam;
  const canvas = root.querySelector("canvas");
  const output = root.querySelector("[data-demo-output]");
  const log = root.querySelector("[data-demo-log]");
  const start = root.querySelector("[data-camera-start]");
  const stop = root.querySelector("[data-camera-stop]");
  if (!mode || !canvas || !output || !start || !stop) return;

  const ctx = canvas.getContext("2d");
  const video = document.createElement("video");
  const work = document.createElement("canvas");
  const maskCanvas = document.createElement("canvas");
  const workCtx = work.getContext("2d", { willReadFrequently: true });
  work.width = PROC_W;
  work.height = PROC_H;
  canvas.width = WIDTH;
  canvas.height = HEIGHT;

  let stream = null;
  let rafId = 0;
  let prevGray = null;
  let lastTextAt = 0;
  let lastLogAt = 0;
  const state = { box: null, point: null, trail: [] };

  function clearCanvas() {
    ctx.fillStyle = "#050607";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }

  function frame(now) {
    if (!stream) return;
    if (video.videoWidth) {
      const image = drawCameraFrame(ctx, video, workCtx);
      const gray = toGray(image);
      const region = changedRegion(gray, prevGray, 28);
      prevGray = region.prevGray;
      state.box = smoothBox(state.box, region.box, 0.22);
      state.point = smoothPoint(state.point, region.centroid, 0.28);
      if (mode === "mask") drawMask(ctx, region.mask, maskCanvas);
      else drawRegion(ctx, state, mode, now);
      const text = measurement(region, state, mode, now);
      if (now - lastTextAt > 350) {
        output.textContent = text;
        lastTextAt = now;
      }
      if (now - lastLogAt > 1400) {
        appendLog(log, text);
        lastLogAt = now;
      }
    }
    rafId = requestAnimationFrame(frame);
  }

  async function begin() {
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      output.textContent = "Webcam demo unavailable: this browser does not expose getUserMedia.";
      appendLog(log, "webcam unavailable");
      return;
    }
    output.textContent = "Requesting webcam permission...";
    appendLog(log, "requesting webcam permission");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (error) {
      output.textContent = `Webcam failed: ${error.name}.`;
      appendLog(log, `webcam failed: ${error.name}`);
      return;
    }
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => {});
    prevGray = null;
    state.box = null;
    state.point = null;
    state.trail.length = 0;
    lastTextAt = 0;
    lastLogAt = 0;
    start.disabled = true;
    stop.disabled = false;
    appendLog(log, "webcam started");
    rafId = requestAnimationFrame(frame);
  }

  function end() {
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    prevGray = null;
    state.box = null;
    state.point = null;
    state.trail.length = 0;
    start.disabled = false;
    stop.disabled = true;
    clearCanvas();
    output.textContent = "Webcam stopped.";
    appendLog(log, "webcam stopped");
  }

  clearCanvas();
  appendLog(log, "ready");
  start.addEventListener("click", begin);
  stop.addEventListener("click", end);
}

document.querySelectorAll("[data-webcam]").forEach(installWebcamDemo);
document.querySelectorAll("[data-downsample-camera]").forEach(installDownsampleDemo);
