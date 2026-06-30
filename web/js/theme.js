/* Theme picker — low-glare default + user choice.
   ES5, no modules, no dependencies, so it runs on the same old browsers the
   capability checker targets. Loaded from <head>: it applies the saved theme
   synchronously (before paint, no flash), then injects the picker on load.

   Themes: "system" (follow prefers-color-scheme; light default is beige),
   "dark", "beige", "blue". Persisted in localStorage. */
(function () {
  "use strict";
  var KEY = "lookout-theme";
  var THEMES = ["system", "dark", "beige", "blue"];
  var LABELS = { system: "System", dark: "Dark", beige: "Beige", blue: "Blue" };

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return THEMES.indexOf(v) >= 0 ? v : "system";
    } catch (e) { return "system"; }
  }

  function apply(t) {
    var el = document.documentElement;
    if (t && t !== "system") el.setAttribute("data-theme", t);
    else el.removeAttribute("data-theme");
  }

  // Apply immediately — documentElement exists while the <head> script runs.
  apply(read());

  function buildPicker() {
    if (document.getElementById("themePicker")) return;
    var current = read();

    var wrap = document.createElement("div");
    wrap.id = "themePicker";

    var label = document.createElement("label");
    label.setAttribute("for", "themeSelect");
    label.textContent = "Theme";

    var select = document.createElement("select");
    select.id = "themeSelect";
    for (var i = 0; i < THEMES.length; i++) {
      var opt = document.createElement("option");
      opt.value = THEMES[i];
      opt.textContent = LABELS[THEMES[i]];
      if (THEMES[i] === current) opt.selected = true;
      select.appendChild(opt);
    }
    select.onchange = function () {
      try { localStorage.setItem(KEY, select.value); } catch (e) {}
      apply(select.value);
    };

    wrap.appendChild(label);
    wrap.appendChild(select);
    document.body.appendChild(wrap);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildPicker);
  } else {
    buildPicker();
  }
})();
