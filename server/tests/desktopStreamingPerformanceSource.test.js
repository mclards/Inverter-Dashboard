"use strict";

// Regression guard for the Remote desktop streaming remediation. This stays
// source-level because Electron GPU state and a real remote gateway require an
// affected Windows workstation; the production contract here is that source
// must not force unsafe GPU policy and must not recompute gateway enrichment.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const mainSource = fs.readFileSync(path.join(root, "electron", "main.js"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

assert.doesNotMatch(mainSource, /max-old-space-size=/, "Electron must use Chromium's default V8 heap policy");
assert.doesNotMatch(mainSource, /ignore-gpu-blocklist/, "Electron must not bypass Chromium's GPU safety blocklist");
assert.doesNotMatch(mainSource, /enable-zero-copy/, "Electron must not claim a forced video zero-copy path");
assert.doesNotMatch(mainSource, /enable-gpu-rasterization/, "Electron must not force GPU rasterization globally");
assert.doesNotMatch(mainSource, /disable-software-rasterizer/, "Electron must retain Chromium's software fallback");
assert.deepStrictEqual(
  packageJson?.build?.asarUnpack,
  ["node_modules/better-sqlite3/**"],
  "public assets must not be unpacked based on the disproven ASAR-decompression theory",
);

const remoteLiveStart = serverSource.indexOf("function applyRemoteBridgeLiveFrame(");
const remoteLiveEnd = serverSource.indexOf("function handleRemoteBridgeStreamFailure", remoteLiveStart);
assert(remoteLiveStart >= 0 && remoteLiveEnd > remoteLiveStart, "remote live bridge function must exist");
const remoteLiveSource = serverSource.slice(remoteLiveStart, remoteLiveEnd);

assert.match(remoteLiveSource, /let forwardedTodayEnergy = null;/);
assert.match(remoteLiveSource, /forwardedTodayEnergy = normalizedRows;/);
assert.match(remoteLiveSource, /todayEnergy: forwardedTodayEnergy \|\| getTodayEnergyRowsForWs\(\)/);
assert.match(remoteLiveSource, /forwardedLivePayload\.todaySummary = msg\.todaySummary;/);
assert.match(remoteLiveSource, /forwardedLivePayload\.plantCap = msg\.plantCap;/);
assert.match(remoteLiveSource, /broadcastUpdate\(forwardedLivePayload\);/);

console.log("desktopStreamingPerformanceSource.test.js: PASS");
