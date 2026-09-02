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
const wsSource = fs.readFileSync(path.join(root, "server", "ws.js"), "utf8");
const authSource = fs.readFileSync(path.join(root, "server", "browserAuth.js"), "utf8");
const cameraWsSource = fs.readFileSync(path.join(root, "server", "streaming.js"), "utf8");
const appSource = fs.readFileSync(path.join(root, "public", "js", "app.js"), "utf8");
const viewerSource = fs.readFileSync(path.join(root, "public", "js", "hikvision-native-viewer.js"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

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
assert.strictEqual(packageLock.lockfileVersion, 3, "the release lockfile must remain valid npm lockfile v3 JSON");
assert.strictEqual(packageLock.version, packageJson.version, "package and lockfile versions must match");

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
assert.match(remoteLiveSource, /msg\.gatewayWsSentTs \|\| msg\.wsSentTs/);
assert.doesNotMatch(
  remoteLiveSource,
  /successTs - Number\(context\.startedAt/,
  "a long-lived WebSocket connection age must not be reported as per-frame latency",
);

assert.match(authSource, /isWebSocketUpgrade/);
assert.match(authSource, /requestPath === "\/ws" \|\| requestPath\.startsWith\("\/ws\/"\)/);
assert.match(serverSource, /perMessageDeflate/);
assert.match(cameraWsSource, /\{ binary: true, compress: false \}/);
assert.match(wsSource, /LIVE_BROADCAST_MIN_INTERVAL_MS = 500/);
assert.match(wsSource, /LIVE_BACKPRESSURE_LIMIT_BYTES = 256 \* 1024/);
assert.match(wsSource, /finalPayload = \{ \.\.\.finalPayload, wsSentTs: Date\.now\(\) \}/);
assert.match(appSource, /function scheduleLatestLiveWs\(/);
assert.match(appSource, /pendingLiveWsMessage = msg;/);

assert.match(appSource, /this\.forcedHlsMode \|\| configuredMode/);
assert.match(appSource, /this\.mediaReadyAbortController = new AbortController\(\)/);
assert.match(appSource, /video\.readyState < 2 \|\| video\.videoWidth <= 0 \|\| video\.videoHeight <= 0/);
assert.doesNotMatch(
  appSource,
  /Hls\.Events\.FRAG_LOADED[\s\S]{0,180}markPlaying\(\)/,
  "downloading an HLS fragment must not be treated as rendered playback",
);
assert.match(viewerSource, /mediaReadyAbortController = new AbortController\(\)/);
assert.doesNotMatch(
  viewerSource,
  /Hls\.Events\.FRAG_LOADED[\s\S]{0,140}onPlaying\(\)/,
  "the native-viewer fallback must wait for decoded video",
);

console.log("desktopStreamingPerformanceSource.test.js: PASS");
