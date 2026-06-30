import { getUse } from "./uses/index.js";
import { pipelineOf } from "./engine/describe.js";

const currentId = document.body.dataset.use;
const use = getUse(currentId);

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

// Ordered list of pipeline modules with source links and status badges.
function renderModules() {
  const root = document.getElementById("pipelineModules");
  if (!root) return;
  root.replaceChildren();
  pipelineOf(use).forEach((m, i) => {
    const li = document.createElement("li");
    li.className = "module";

    const head = document.createElement("div");
    head.className = "module-head";

    const name = document.createElement("span");
    name.className = "module-name";
    name.textContent = `${i + 1}. ${m.label}`;
    head.appendChild(name);

    const badge = document.createElement("span");
    badge.className = "badge badge-" + m.status;
    badge.textContent = m.status;
    head.appendChild(badge);
    li.appendChild(head);

    const note = document.createElement("p");
    note.className = "module-note";
    note.textContent = m.note;
    li.appendChild(note);

    if (m.src) {
      const link = document.createElement("a");
      link.className = "module-src";
      link.href = m.src;
      link.textContent = m.src;
      link.target = "_blank";
      link.rel = "noopener";
      li.appendChild(link);
    }
    root.appendChild(li);
  });
}

// Configuration key/value list, straight from the use spec.
function renderConfig() {
  const root = document.getElementById("useConfig");
  if (!root || !use.config) return;
  root.replaceChildren();
  for (const [key, value] of Object.entries(use.config)) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    if (key === "Leaves device") dd.className = "config-privacy";
    row.append(dt, dd);
    root.appendChild(row);
  }
}

function renderUse() {
  if (!use) {
    setText("useTitle", "Unknown use");
    setText("useDescription", "No use is registered for this page.");
    return;
  }

  document.title = `lookout · ${use.name}`;
  setText("useTitle", use.name);
  setText("useDescription", use.description);
  setText("modeValue", use.mode);
  setText("locateValue", use.locate);
  setText("measurementsValue", use.measurements.join(", "));
  setText("setupHeading", "Setting it up");
  setText("outputsHeading", "What you get out");

  document.getElementById("setupList").replaceChildren(textList(use.setup));
  document.getElementById("outputsList").replaceChildren(textList(use.outputs));
  renderModules();
  renderConfig();
}

renderUse();
