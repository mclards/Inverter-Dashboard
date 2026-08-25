"use strict";

// Source-contract regression test for Electron-owned server lifecycle logic.
// Electron is intentionally not booted in the test process: loading main.js
// would create windows and child processes. These assertions protect the IPC,
// persistence, and shutdown wiring that the renderer depends on.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const main = read("electron/main.js");
const preload = read("electron/preload.js");
const server = read("server/index.js");
const publicApp = read("public/js/app.js");
const frontendApp = read("frontend/public/js/app.js");
const publicIndex = read("public/index.html");
const frontendIndex = read("frontend/public/index.html");

assert.match(
  main,
  /return path\.join\(path\.dirname\(getRuntimeDataDir\(\)\), "server-service-config\.json"\);/,
  "lifecycle preferences must use the canonical runtime root",
);
assert.match(main, /fs\.renameSync\(temp, p\);/, "lifecycle preference writes must be atomic");
assert.match(
  main,
  /function normalizeServerServiceConfig[\s\S]*?source\.keepInBackground === true[\s\S]*?source\.autoStart === true/,
  "only literal true values may enable persisted services",
);
assert.match(preload, /setServerAutoStart: \(enabled\) => ipcRenderer\.invoke\("server:set-auto-start", enabled\)/);

const stopBody = main.slice(main.indexOf("async function stopLocalServerServices()"), main.indexOf("function finalizeAppShutdown()"));
assert.match(stopBody, /stopForecastModeSync\(\)/, "manual stop must stop forecast supervision");
assert.match(stopBody, /stopAuxiliaryGatewayServices\(\)/, "manual stop must stop optional gateway workers");

assert.match(main, /function runServerLifecycleOperation\(/, "Start and Stop must be serialized");
assert.match(main, /ipcMain\.handle\("server:start", async \(\) => \{[\s\S]*?runServerLifecycleOperation/);
assert.match(main, /ipcMain\.handle\("server:stop", async \(\) => \{[\s\S]*?runServerLifecycleOperation/);
assert.match(main, /ipcMain\.handle\("server:set-background"[\s\S]*?remoteGatewayUrl/);
assert.match(main, /ipcMain\.handle\("server:set-auto-start"[\s\S]*?remoteGatewayUrl/);
assert.match(main, /new Tray\(APP_ICON\)/, "background mode must provide a recoverable tray entry point");

// The Server Host URL is the single role switch. A Remote client must still
// be able to clear that local value while its old gateway is unavailable, but
// cannot use a forged operationMode value to bypass gateway-authoritative
// plant-setting saves.
assert.match(server, /const remoteClientSave = currentMode === "remote";/);
assert.match(
  server,
  /const remoteClientLocalOnlySave =[\s\S]*?requestKeys\.every\(\(key\) => REMOTE_CLIENT_LOCAL_SETTING_KEYS\.has\(key\)\)/,
  "Remote clients must identify device-local-only saves explicitly",
);
assert.match(server, /if \(remoteClientSave && !remoteClientLocalOnlySave\)/);

for (const appSource of [publicApp, frontendApp]) {
  assert.match(appSource, /setServerAutoStart\(e\.target\.checked\)/);
  assert.match(appSource, /if \(keepChk\) keepChk\.disabled = true;/);
  assert.match(appSource, /if \(autoChk\) autoChk\.disabled = true;/);
  assert.match(appSource, /Could not save the auto-start setting/);
}

const publicVersion = (publicIndex.match(/js\/app\.js\?v=([^"']+)/) || [])[1];
const frontendVersion = (frontendIndex.match(/js\/app\.js\?v=([^"']+)/) || [])[1];
assert.ok(publicVersion && publicVersion === frontendVersion, "paired dashboard assets must share the app cache version");

console.log("serverLifecycleWiring.test.js: passed");
