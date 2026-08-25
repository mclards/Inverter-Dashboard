"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, "..", "..", relPath), "utf8");
}

try {
  const mainSrc = read("electron/main.js");

  // v2.8.10 Phase A2: better-sqlite3 is now loaded through safeRequire so a
  // torn app.asar cannot crash the boot. Both the direct and wrapped forms
  // are accepted — this assertion only cares that the module is loaded and
  // used for the local settings DB read.
  assert(
    (mainSrc.includes('const Database = require("better-sqlite3");') ||
      mainSrc.includes('const Database = safeRequire("better-sqlite3")')) &&
      mainSrc.includes("readOperationModeFromLocalDb") &&
      mainSrc.includes('SELECT value FROM settings WHERE key = ? LIMIT 1'),
    "Electron main should read operationMode directly from the local settings DB for forecast supervision.",
  );
  assert(
    mainSrc.includes("startForecastModeSync();\n  pollUntilReady();"),
    "Forecast mode sync should start during server boot, before the backend HTTP ready signal.",
  );
  assert(
    mainSrc.includes('const mode = (await tryGetCurrentOperationMode(timeoutMs)) || "gateway";') &&
      !mainSrc.includes("!serverReadyFired || forecastModeSyncInFlight"),
    "Forecast watchdog should default to gateway mode when needed and must not be blocked on serverReadyFired.",
  );

  console.log("forecastWatchdogSource.test.js: PASS");
} catch (err) {
  console.error("forecastWatchdogSource.test.js: FAIL", err?.stack || err);
  process.exit(1);
}
