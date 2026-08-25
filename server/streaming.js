"use strict";
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

/* ── State ─────────────────────────────────────────────────────────── */
let ffmpegProcess = null;
let status = "stopped"; // "streaming" | "connecting" | "stopped" | "error"
let clients = new Set();
let reconnectAttempt = 0;
let reconnectTimer = null;
let ffmpegBinPath = null; // resolved lazily
let currentRtspUrl = "";

/* ── FFmpeg path resolution ────────────────────────────────────────── */
function resolveFfmpegPath() {
  if (ffmpegBinPath) return ffmpegBinPath;
  // 1. Packaged Electron (extraResources)
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, "backend", "ffmpeg", "ffmpeg.exe");
    if (fs.existsSync(packaged)) { ffmpegBinPath = packaged; return packaged; }
  }
  // 2. Development — alongside this module
  const dev = path.join(__dirname, "ffmpeg", "ffmpeg.exe");
  if (fs.existsSync(dev)) { ffmpegBinPath = dev; return dev; }
  // 3. System PATH
  ffmpegBinPath = "ffmpeg";
  return "ffmpeg";
}

/* ── Broadcast to WS clients ──────────────────────────────────────── */
function broadcastToClients(chunk) {
  for (const ws of clients) {
    if (ws.readyState === 1 && ws.bufferedAmount < 512 * 1024) {
      ws.send(chunk, { binary: true });
    }
  }
}

/* ── Process exit handler ─────────────────────────────────────────── */
function handleProcessExit(code) {
  ffmpegProcess = null;
  if (code !== 0 && reconnectAttempt < 3 && clients.size > 0) {
    status = "error";
    // T2.9 fix (Phase 5, 2026-04-14): explicit 30 s upper bound on the
    // exponential delay.  At reconnectAttempt < 3 the unclamped value is
    // 3/6/12 s — already small — but the clamp is defence-in-depth so a
    // future bump to the retry-count cap can't accidentally produce
    // minute-long backoffs that look like "stream stuck offline".
    const delay = Math.min(30000, 3000 * Math.pow(2, reconnectAttempt));
    reconnectAttempt++;
    console.log(`[camera] ffmpeg exited (code ${code}), reconnect #${reconnectAttempt} in ${delay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      startCameraStream(currentRtspUrl);
    }, delay);
  } else {
    if (code !== 0) console.log(`[camera] ffmpeg exited (code ${code}), giving up after ${reconnectAttempt} retries`);
    status = "stopped";
  }
}

/* ── Public API ────────────────────────────────────────────────────── */

function startCameraStream(rtspUrl) {
  if (ffmpegProcess) return true; // already running
  if (!rtspUrl) { status = "stopped"; return false; }

  status = "connecting";
  currentRtspUrl = rtspUrl;
  let gotData = false;

  const bin = resolveFfmpegPath();
  const args = [
    "-rtsp_transport", "tcp",
    "-stimeout", "5000000",
    "-i", rtspUrl,
    "-f", "mpegts",
    "-codec:v", "mpeg1video",
    "-b:v", "800k",
    "-r", "24",
    "-s", "640x480",
    "-bf", "0",
    "-an",
    "-q:v", "5",
    "pipe:1",
  ];

  try {
    ffmpegProcess = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    console.error("[camera] failed to spawn ffmpeg:", err.message);
    status = "error";
    return false;
  }

  ffmpegProcess.stdout.on("data", (chunk) => {
    if (!gotData) {
      gotData = true;
      status = "streaming";
      reconnectAttempt = 0;
      console.log("[camera] stream started");
    }
    broadcastToClients(chunk);
  });

  ffmpegProcess.stderr.on("data", (buf) => {
    const line = buf.toString().trim();
    if (line && /error|refused|timeout|unreachable/i.test(line)) {
      console.warn("[camera] ffmpeg:", line);
    }
  });

  ffmpegProcess.on("error", (err) => {
    console.error("[camera] ffmpeg process error:", err.message);
    ffmpegProcess = null;
    status = "error";
  });

  ffmpegProcess.on("close", handleProcessExit);
  return true;
}

function stopCameraStream() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ffmpegProcess) {
    const proc = ffmpegProcess;
    ffmpegProcess = null;
    try { proc.kill("SIGTERM"); } catch (_) {}
    setTimeout(() => {
      try { if (!proc.killed) proc.kill("SIGKILL"); } catch (_) {}
    }, 3000);
  }
  status = "stopped";
  reconnectAttempt = 0;
}

function getCameraStatus() { return status; }
function getClientCount() { return clients.size; }

function registerStreamClient(ws) {
  clients.add(ws);
}

function unregisterStreamClient(ws) {
  clients.delete(ws);
  if (clients.size === 0) {
    stopCameraStream();
  }
}

function setFfmpegPath(p) { ffmpegBinPath = p; }

// T2.18 fix (Phase 8, 2026-04-14): on process SIGTERM (Electron parent
// issues this during app shutdown), kill any running ffmpeg child so
// it doesn't become a zombie holding the RTSP socket.  Idempotent —
// stopCameraStream() already handles the null case.
let _sigtermHandlerInstalled = false;
function installShutdownHandler() {
  if (_sigtermHandlerInstalled) return;
  _sigtermHandlerInstalled = true;
  process.on("SIGTERM", () => {
    try { stopCameraStream(); } catch (_) { /* ignore */ }
  });
}
installShutdownHandler();

module.exports = {
  startCameraStream,
  stopCameraStream,
  getCameraStatus,
  registerStreamClient,
  unregisterStreamClient,
  getClientCount,
  setFfmpegPath,
};
