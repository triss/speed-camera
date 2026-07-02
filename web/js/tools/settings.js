export function createSettingsBinder({ $, settings, onChange = () => {} }) {
  function bind(id, key, transform = (value) => value) {
    $(id).addEventListener("change", (event) => {
      const raw = event.target.type === "checkbox" ? event.target.checked : event.target.value;
      const value = transform(raw);
      settings[key] = value;
      onChange({ id, key, value, raw, event });
    });
  }

  function bindNumberPair(rangeId, numberId, key, {
    transform = Number,
    onCommit = () => {},
  } = {}) {
    const range = $(rangeId);
    const number = $(numberId);
    const min = Number(number.min);
    const max = Number(number.max);
    const set = (raw, event, commit = false) => {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return;
      const rawValue = Math.min(max, Math.max(min, parsed));
      const value = transform(rawValue);
      settings[key] = value;
      range.value = rawValue;
      number.value = rawValue;
      if (commit) onCommit({ key, value, rawValue, event });
    };
    range.addEventListener("input", (event) => set(event.target.value, event));
    range.addEventListener("change", (event) => set(event.target.value, event, true));
    number.addEventListener("input", (event) => set(event.target.value, event));
    number.addEventListener("change", (event) => set(event.target.value, event, true));
  }

  return { bind, bindNumberPair };
}
