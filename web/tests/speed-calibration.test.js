"use strict";

window.__LOOKOUT_TEST__ = true;

const results = document.getElementById("testResults");
const summary = document.getElementById("testSummary");
const rows = document.getElementById("speedCalibrationRows");
const output = document.getElementById("speedCalibrationJson");

let passed = 0;
let failed = 0;

function log(message) {
  results.textContent += `${message}\n`;
}

function assert(name, condition, details = "") {
  if (condition) {
    passed += 1;
    log(`PASS ${name}`);
    return;
  }
  failed += 1;
  log(`FAIL ${name}${details ? `: ${details}` : ""}`);
}

function input(value) {
  return new InputEvent("input", { bubbles: true, data: value });
}

try {
  await import("../js/speed-calibration.js");

  const api = window.__lookoutSpeedCalibrationTestApi;
  assert("test API installed", !!api);

  api.seedCapturedFrame(1280, 720);
  api.addPoint(100, 200);
  api.addPoint(700, 200);

  const distance = rows.querySelector("input");
  assert("distance input is rendered", !!distance);
  assert("distance input asks for decimal keyboard", distance.inputMode === "decimal", `got ${distance.inputMode}`);

  distance.value = "6";
  distance.dispatchEvent(input("6"));

  const beforeResize = rows.querySelector("input");
  window.dispatchEvent(new Event("resize"));
  assert("resize preserves focused distance input", rows.querySelector("input") === beforeResize);

  const calibration = JSON.parse(output.value);
  assert("JSON contains one distance pair", calibration.distance_pairs.length === 1);
  assert("JSON stores entered distance", calibration.distance_pairs[0].distance_m === 6, `got ${calibration.distance_pairs[0].distance_m}`);
  assert("JSON stores x/y image points", calibration.distance_pairs[0].image_points[0].x === 100 &&
    calibration.distance_pairs[0].image_points[1].y === 200);
} catch (error) {
  failed += 1;
  log(`FAIL unhandled error: ${error.stack || error.message}`);
}

summary.textContent = `${passed} passed, ${failed} failed`;
summary.className = failed ? "lead fail" : "lead pass";
if (failed) {
  throw new Error(summary.textContent);
}
