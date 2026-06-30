import { getUse, listUses } from "./uses/index.js";

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

function renderNav() {
  const nav = document.getElementById("useNav");
  if (!nav) return;
  for (const item of listUses()) {
    const link = document.createElement("a");
    link.href = `${item.id}.html`;
    link.textContent = item.name;
    if (item.id === currentId) link.setAttribute("aria-current", "page");
    nav.appendChild(link);
  }
}

function renderUse() {
  renderNav();
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

  document.getElementById("setupList").replaceChildren(textList(use.setup));
  document.getElementById("outputsList").replaceChildren(textList(use.outputs));
}

renderUse();
