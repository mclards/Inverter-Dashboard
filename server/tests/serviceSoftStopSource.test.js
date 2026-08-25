"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, "..", "..", relPath), "utf8");
}

try {
  const mainSrc = read("electron/main.js");
  const inverterSrc = read("services/inverter_engine.py");
  const forecastSrc = read("services/forecast_engine.py");

  assert(
    mainSrc.includes("ADSI_SERVICE_STOP_FILE") &&
      mainSrc.includes("IM_SERVICE_STOP_FILE"),
    "Electron main should pass stop-file env vars to child services.",
  );
  assert(
    mainSrc.includes("writeServiceSoftStopFile") &&
      mainSrc.includes("did not exit within ${softStopWaitMs}ms after soft-stop; forcing exit"),
    "Electron shutdown path should request soft-stop before force-kill fallback.",
  );
  assert(
    mainSrc.includes("BACKEND_SOFT_STOP_WAIT_MS") &&
      mainSrc.includes("FORECAST_SOFT_STOP_WAIT_MS"),
    "Electron main should use bounded grace windows for backend and forecast soft-stop.",
  );
  assert(
    inverterSrc.includes("ADSI_SERVICE_STOP_FILE") &&
      inverterSrc.includes("server.should_exit = True") &&
      inverterSrc.includes("Soft stop requested - shutting down"),
    "Inverter engine should honor the service stop file and exit uvicorn cleanly.",
  );
  assert(
    forecastSrc.includes("ADSI_SERVICE_STOP_FILE") &&
      forecastSrc.includes("_sleep_with_service_stop") &&
      forecastSrc.includes("_service_stop_requested"),
    "Forecast engine should honor the service stop file during loop sleeps and run boundaries.",
  );

  console.log("serviceSoftStopSource.test.js: PASS");
} catch (err) {
  console.error("serviceSoftStopSource.test.js: FAIL", err?.stack || err);
  process.exit(1);
}
