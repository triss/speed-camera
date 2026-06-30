import { getPreset, listPresets } from "./presets/index.js";

const currentId = document.body.dataset.preset;
const preset = getPreset(currentId);

function textList(items) {
  const ul = document.createElement("ul");
  for (const item of items || []) {
    const li = document.createElement("li");
    li.textContent = item;
    ul.appendChild(li);
  }
  return ul;
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function renderNav() {
  const nav = document.getElementById("useNav");
  if (!nav) return;
  for (const item of listPresets()) {
    const link = document.createElement("a");
    link.href = `${item.id}.html`;
    link.textContent = item.name;
    if (item.id === currentId) link.setAttribute("aria-current", "page");
    nav.appendChild(link);
  }
}

function renderPreset() {
  renderNav();
  if (!preset) {
    setText("presetTitle", "Unknown use");
    setText("presetSummary", "No preset is registered for this page.");
    return;
  }

  document.title = `lookout · ${preset.name}`;
  setText("presetTitle", preset.name);
  setText("presetSummary", preset.summary);
  setText("modeValue", preset.mode);
  setText("locateValue", preset.locate);
  setText("measurementsValue", preset.measurements.join(", "));

  document.getElementById("setupList").replaceChildren(textList(preset.setup));
  document.getElementById("outputsList").replaceChildren(textList(preset.outputs));

  const launch = document.getElementById("launchApp");
  if (launch) launch.href = `index.html?preset=${encodeURIComponent(preset.id)}`;
}

renderPreset();
