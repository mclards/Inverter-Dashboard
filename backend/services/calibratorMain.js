#!/usr/bin/env node
// server/calibratorMain.js — standalone Field Calibration server entrypoint
//
// Usage: node server/calibratorMain.js [--port 3600] [--python-base http://127.0.0.1:9200]
//
// Starts the calibrator server on the specified port, logs the listen URL,
// and handles graceful shutdown on SIGTERM.

"use strict";

const { startCalibratorServer } = require("./calibratorServer");

// Parse command-line arguments
const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--port" && i + 1 < args.length) {
    opts.port = Number(args[++i]);
  } else if (arg === "--python-base" && i + 1 < args.length) {
    opts.calibratorPythonBase = args[++i];
  } else if (arg === "--db-path" && i + 1 < args.length) {
    opts.dbPath = args[++i];
  }
}

// Set defaults from environment or use hardcoded
opts.port = opts.port || Number(process.env.CALIBRATOR_PORT) || 3600;
opts.calibratorPythonBase = opts.calibratorPythonBase || process.env.CALIBRATOR_PYTHON_BASE || "http://127.0.0.1:9200";
opts.dbPath = opts.dbPath || process.env.CALIBRATOR_DB_PATH || null;

console.log(`[calibrator] starting with config:`, {
  port: opts.port,
  pythonBase: opts.calibratorPythonBase,
  dbPath: opts.dbPath || "(default)",
});

// Start the server. Keep the FULL handle — its close() runs
// wss.close() + server.close() + calibratorDb.close() (WAL checkpoint +
// handle release). The old code destructured only `server` and called bare
// server.close() on signals, so the calibrator SQLite DB was NEVER
// gracefully closed (WAL left un-checkpointed) on any exit.
const _calibrator = startCalibratorServer(opts);
const { server } = _calibrator;

server.listen(opts.port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${opts.port}`;
  console.log(`[calibrator] listening on ${url}`);
  console.log(`[calibrator] open in Electron window or navigate to ${url}/index.html`);
});

// Graceful shutdown. The Electron parent (terminateCalibratorProcesses)
// sends SIGTERM then SIGKILLs ~2 s later, and server.close() can block
// indefinitely on a held WebSocket / keep-alive. So do the DURABILITY
// work (calibratorDb WAL checkpoint + close, inside _calibrator.close())
// synchronously and FIRST, then exit immediately — never wait on the
// socket drain. Idempotent + guarded so SIGTERM/SIGINT and the 'exit'
// net run the teardown exactly once.
let _calibratorClosed = false;
function shutdownCalibrator(signal) {
  if (_calibratorClosed) return;
  _calibratorClosed = true;
  try { console.log(`[calibrator] ${signal} received, shutting down...`); } catch (_) {}
  try {
    _calibrator.close();   // wss.close() + server.close() + calibratorDb.close()
  } catch (err) {
    try { console.warn("[calibrator] shutdown close error:", err?.message || err); } catch (_) {}
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdownCalibrator("SIGTERM"));
process.on("SIGINT", () => shutdownCalibrator("SIGINT"));

// Last-resort synchronous net: any exit path that still reaches Node's
// 'exit' (plain process.exit, unhandled fatal, parent IPC) flushes the
// SQLite WAL. Does NOT fire on SIGKILL — but the calibrator DB is WAL +
// synchronous=NORMAL, so a hard kill is crash-safe (WAL replays on next
// open); this only guarantees the CLEAN single-file checkpoint when the
// runtime did get to exit. Guarded so it never double-runs the teardown.
process.on("exit", () => {
  if (_calibratorClosed) return;
  _calibratorClosed = true;
  try { _calibrator.close(); } catch (_) {}
});
