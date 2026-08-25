#!/usr/bin/env node
/**
 * Electron launcher wrapper - ensures ELECTRON_RUN_AS_NODE is NOT set
 */
const { spawn } = require("child_process");
const path = require("path");

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;  // Explicitly remove the env var

// On Windows, use electron.cmd; on other platforms use electron
const isWindows = process.platform === "win32";
const electronExe = isWindows ? "electron.cmd" : "electron";
const electronPath = path.join(__dirname, "node_modules", ".bin", electronExe);
const appPath = ".";

console.log("[start-electron] Launching Electron...");
console.log("[start-electron] Using:", electronPath);
console.log("[start-electron] ELECTRON_RUN_AS_NODE env var explicitly removed");

const child = spawn(electronPath, [appPath], {
  env,
  stdio: "inherit",
  shell: isWindows,  // Use shell on Windows for .cmd execution
  cwd: __dirname,
});

child.on("error", (err) => {
  console.error("[start-electron] Spawn error:", err.message);
  process.exit(1);
});

child.on("exit", (code) => {
  console.log("[start-electron] Electron exited with code:", code);
  process.exit(code);
});

