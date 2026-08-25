"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, "..", "..", relPath), "utf8");
}

try {
  const controllerSrc = read("server/plantCapController.js");
  const serverSrc = read("server/index.js");

  assert(
    controllerSrc.includes("getManualWriteGuard(event = {})") &&
      controllerSrc.includes("plant_cap_manual_control_blocked") &&
      controllerSrc.includes("Manual START") === false,
    "Plant cap controller should expose a manual-write guard for non-exempt inverter authority.",
  );
  assert(
    controllerSrc.includes("Manual ${action} cannot override the current plant cap session"),
    "Manual-write guard should explain that plant cap authority blocks non-exempt manual control.",
  );
  assert(
    serverSrc.includes('typeof plantCapController.getManualWriteGuard === "function"') &&
      serverSrc.includes("blocked:${String(guard.reasonCode || \"plant_cap_active\")}") &&
      serverSrc.includes("Plant Output Cap is active; manual control is blocked for this inverter."),
    "Server control writes should consult the plant-cap manual-write guard before executing local writes.",
  );

  console.log("plantCapManualAuthoritySource.test.js: PASS");
} catch (err) {
  console.error(
    "plantCapManualAuthoritySource.test.js: FAIL",
    err?.stack || err,
  );
  process.exit(1);
}
