const input = document.getElementById("calibrationImage");
const canvas = document.getElementById("calibrationCanvas");
const ctx = canvas.getContext("2d");
const rows = document.getElementById("calibrationRows");
const output = document.getElementById("calibrationJson");
const status = document.getElementById("calibrationStatus");
const undo = document.getElementById("undoPoint");
const clear = document.getElementById("clearPoints");
const copy = document.getElementById("copyCalibration");
const download = document.getElementById("downloadCalibration");

const image = new Image();
const points = [];
let imageName = "";

function setStatus(message) {
  status.textContent = message;
}

function fitCanvas() {
  if (!image.naturalWidth) {
    canvas.width = 640;
    canvas.height = 360;
    draw();
    return;
  }
  const maxWidth = Math.min(680, canvas.parentElement.clientWidth - 2);
  const scale = maxWidth / image.naturalWidth;
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  draw();
}

function imagePointFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = image.naturalWidth / rect.width;
  const scaleY = image.naturalHeight / rect.height;
  return {
    x: Math.round((event.clientX - rect.left) * scaleX),
    y: Math.round((event.clientY - rect.top) * scaleY),
  };
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#050607";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!image.naturalWidth) return;

  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const scaleX = canvas.width / image.naturalWidth;
  const scaleY = canvas.height / image.naturalHeight;
  points.forEach((point, index) => {
    const x = point.image[0] * scaleX;
    const y = point.image[1] * scaleY;
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd166";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#101214";
    ctx.stroke();
    ctx.fillStyle = "#101214";
    ctx.font = "700 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(index + 1), x, y);
  });
}

function calibrationJson() {
  return JSON.stringify({
    image: {
      name: imageName,
      width: image.naturalWidth || 0,
      height: image.naturalHeight || 0,
    },
    image_points: points.map((point) => point.image),
    world_points: points.map((point) => point.world),
  }, null, 2);
}

function updateJson() {
  output.value = calibrationJson();
  const hasPoints = points.length > 0;
  undo.disabled = !hasPoints;
  clear.disabled = !hasPoints;
  copy.disabled = !hasPoints;
  download.disabled = !hasPoints;
  if (points.length < 4) {
    setStatus(`${points.length} point${points.length === 1 ? "" : "s"} collected. Four or more spread-out points are recommended.`);
  } else {
    setStatus(`${points.length} points collected. Edit world X/Y values, then copy or download JSON.`);
  }
}

function renderRows() {
  rows.replaceChildren();
  points.forEach((point, index) => {
    const row = document.createElement("tr");
    const number = document.createElement("th");
    const imageCell = document.createElement("td");
    const worldXCell = document.createElement("td");
    const worldYCell = document.createElement("td");
    const worldX = document.createElement("input");
    const worldY = document.createElement("input");

    number.scope = "row";
    number.textContent = String(index + 1);
    imageCell.textContent = `${point.image[0]}, ${point.image[1]}`;
    worldX.type = "number";
    worldX.step = "0.001";
    worldX.value = point.world[0];
    worldX.setAttribute("aria-label", `Point ${index + 1} world X metres`);
    worldY.type = "number";
    worldY.step = "0.001";
    worldY.value = point.world[1];
    worldY.setAttribute("aria-label", `Point ${index + 1} world Y metres`);

    worldX.addEventListener("input", () => {
      point.world[0] = Number(worldX.value || 0);
      updateJson();
    });
    worldY.addEventListener("input", () => {
      point.world[1] = Number(worldY.value || 0);
      updateJson();
    });

    worldXCell.appendChild(worldX);
    worldYCell.appendChild(worldY);
    row.append(number, imageCell, worldXCell, worldYCell);
    rows.appendChild(row);
  });
  updateJson();
}

function addPoint(point) {
  points.push({ image: [point.x, point.y], world: [0, 0] });
  draw();
  renderRows();
}

function loadFile(file) {
  if (!file) return;
  imageName = file.name;
  const url = URL.createObjectURL(file);
  image.onload = () => {
    URL.revokeObjectURL(url);
    points.length = 0;
    fitCanvas();
    renderRows();
    setStatus("Image loaded. Click known points on the image.");
  };
  image.src = url;
}

input.addEventListener("change", () => loadFile(input.files[0]));
canvas.addEventListener("click", (event) => {
  if (!image.naturalWidth) {
    setStatus("Load or take a calibration image first.");
    return;
  }
  addPoint(imagePointFromEvent(event));
});
undo.addEventListener("click", () => {
  points.pop();
  draw();
  renderRows();
});
clear.addEventListener("click", () => {
  points.length = 0;
  draw();
  renderRows();
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
  link.download = "lookout-calibration.json";
  link.click();
  URL.revokeObjectURL(link.href);
});
window.addEventListener("resize", fitCanvas);

fitCanvas();
renderRows();
