"use strict";
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");
const os = require("os");

/* ── Constants ────────────────────────────────────────────────────── */
function resolveRuntimeRoot() {
  if (process.platform === "win32") {
    return path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "Inverter-Dashboard");
  }
  if (String(process.env.INVERTER_STORAGE_DIR || "").trim()) {
    return path.resolve(String(process.env.INVERTER_STORAGE_DIR).trim());
  }
  const explicitDbDir = String(process.env.INVERTER_DATA_DIR || "").trim();
  if (explicitDbDir) {
    const resolved = path.resolve(explicitDbDir);
    return path.basename(resolved) === "db" ? path.dirname(resolved) : resolved;
  }
  return path.resolve(
    String(process.env.ADSI_PORTABLE_DATA_DIR || "").trim() ||
      path.join(os.homedir(), ".inverter-dashboard"),
  );
}
const PROGRAMDATA_ROOT = resolveRuntimeRoot();
const API_PORT = 1984;
const WEBRTC_PORT = 8555;
const HEALTH_INTERVAL_MS = 5000;
const HEALTH_TIMEOUT_MS = 2000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_RESTART_ATTEMPTS = 3;
const SHUTDOWN_TIMEOUT_MS = 3000;

/* ── State ────────────────────────────────────────────────────────── */
let go2rtcProcess = null;
let status = "stopped"; // "running" | "starting" | "stopped" | "error"
let healthCheckTimer = null;
let consecutiveHealthFailures = 0;
let crashCount = 0;
let _autoRestart = false;
let lastHealthTs = 0;
let _stoppingIntentional = false;
let _externalInstance = false;

/* ── Path resolution ──────────────────────────────────────────────── */

function resolveExePath() {
  // On Windows, only look for .exe; on Linux, try native binary names first.
  const binaryNames =
    process.platform === "win32"
      ? ["go2rtc.exe"]
      : ["go2rtc", "go2rtc_linux_amd64", "go2rtc_linux_arm64", "go2rtc.exe"];

  // 1. Packaged Electron (extraResources)
  if (process.resourcesPath) {
    for (const name of binaryNames) {
      const packaged = path.join(
        process.resourcesPath,
        "backend",
        "go2rtc",
        name,
      );
      if (fs.existsSync(packaged)) return packaged;
    }
  }
  // 2. Development / installed — alongside this module
  for (const name of binaryNames) {
    const dev = path.join(__dirname, "go2rtc", name);
    if (fs.existsSync(dev)) return dev;
  }
  // 3. Standard Linux system paths (not reached on Windows)
  if (process.platform !== "win32") {
    const systemPaths = [
      "/usr/local/bin/go2rtc",
      "/usr/bin/go2rtc",
      "/opt/inverter-dashboard/backend/engines/go2rtc/go2rtc",
      "/opt/adsi-dashboard/server/go2rtc/go2rtc",
      "/opt/adsi-dashboard/server/go2rtc/go2rtc_linux_amd64",
    ];
    for (const p of systemPaths) {
      if (fs.existsSync(p)) return p;
    }
  }
  // 4. Not found
  return null;
}

function resolveConfigPath() {
  // 1. User override in ProgramData / Linux data dir
  const userCfg = path.join(PROGRAMDATA_ROOT, "go2rtc", "go2rtc.yaml");
  if (fs.existsSync(userCfg)) return userCfg;
  // 2. Packaged Electron (extraResources)
  if (process.resourcesPath) {
    const packaged = path.join(
      process.resourcesPath,
      "backend",
      "go2rtc",
      "go2rtc.yaml",
    );
    if (fs.existsSync(packaged)) return packaged;
  }
  // 3. Development — alongside this module
  const dev = path.join(__dirname, "go2rtc", "go2rtc.yaml");
  if (fs.existsSync(dev)) return dev;
  // 4. Linux /etc fallback (not reached on Windows)
  if (process.platform !== "win32") {
    const etcCfg = "/etc/adsi-dashboard/go2rtc.yaml";
    if (fs.existsSync(etcCfg)) return etcCfg;
  }
  return null;
}

/* ── Port availability check ──────────────────────────────────────── */

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

/* ── Health check ─────────────────────────────────────────────────── */

function healthCheck() {
  // T2.12 fix (Phase 2, 2026-04-14): previously treated "any response" as
  // healthy, so a 5xx from a crashing go2rtc still reported alive.  Now a
  // response is only healthy if statusCode < 500.  4xx is still considered
  // alive (the server is responding, auth/path just doesn't match).
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${API_PORT}/api/`,
      { timeout: HEALTH_TIMEOUT_MS },
      (res) => {
        res.resume();
        const code = res.statusCode || 0;
        resolve(code > 0 && code < 500);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startHealthLoop() {
  stopHealthLoop();
  consecutiveHealthFailures = 0;
  healthCheckTimer = setInterval(async () => {
    if (status !== "running" && status !== "starting") return;
    const alive = await healthCheck();
    if (alive) {
      consecutiveHealthFailures = 0;
      lastHealthTs = Date.now();
      if (status === "starting") {
        status = "running";
        console.log("[go2rtc] health check passed — status: running");
      }
    } else {
      consecutiveHealthFailures++;
      if (consecutiveHealthFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(
          `[go2rtc] ${consecutiveHealthFailures} consecutive health failures`,
        );
        if (!go2rtcProcess || go2rtcProcess.exitCode !== null) {
          handleCrash();
        }
      }
    }
  }, HEALTH_INTERVAL_MS);
  if (healthCheckTimer.unref) healthCheckTimer.unref();
}

function stopHealthLoop() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

/* ── Crash / auto-restart ─────────────────────────────────────────── */

function handleCrash() {
  if (_stoppingIntentional) return;
  crashCount++;
  console.warn(`[go2rtc] crash #${crashCount}`);
  go2rtcProcess = null;
  _externalInstance = false;

  if (_autoRestart && crashCount <= MAX_RESTART_ATTEMPTS) {
    console.log(
      `[go2rtc] auto-restart attempt ${crashCount}/${MAX_RESTART_ATTEMPTS}...`,
    );
    const delay = 2000 * crashCount; // back-off: 2s, 4s, 6s
    setTimeout(() => {
      if (_stoppingIntentional) return;
      _spawnProcess().catch((err) => {
        console.error(`[go2rtc] auto-restart failed: ${err.message}`);
        status = "error";
      });
    }, delay);
  } else {
    status = "error";
    stopHealthLoop();
    console.error(`[go2rtc] unavailable after ${crashCount} health/crash event(s)`);
  }
}

/* ── Spawn ────────────────────────────────────────────────────────── */

async function _spawnProcess() {
  const exePath = resolveExePath();
  if (!exePath) {
    status = "error";
    return { ok: false, error: "go2rtc binary not found" };
  }

  const configPath = resolveConfigPath();
  const args = configPath ? ["-config", configPath] : [];

  if (configPath) {
    console.log(`[go2rtc] config: ${configPath}`);
  }

  status = "starting";

  // T2.7 fix (Phase 5, 2026-04-14): wrap spawn in try/catch.  When spawn
  // throws synchronously (EACCES on the binary, ENOENT race after
  // resolveExePath checked), the previous code left status="starting" and
  // the next start() call would short-circuit thinking we were already
  // launching.  Now: status reset to "stopped", go2rtcProcess cleared,
  // and the error surfaced to the caller.
  let child;
  try {
    child = spawn(exePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    console.error(`[go2rtc] synchronous spawn failed: ${err.message}`);
    status = "stopped";
    go2rtcProcess = null;
    return { ok: false, error: err.message };
  }

  go2rtcProcess = child;
  _externalInstance = false;

  child.stdout.on("data", (data) => {
    data
      .toString()
      .split("\n")
      .filter((l) => l.trim())
      .forEach((line) => console.log(`[go2rtc] ${line}`));
  });

  child.stderr.on("data", (data) => {
    data
      .toString()
      .split("\n")
      .filter((l) => l.trim())
      .forEach((line) => console.warn(`[go2rtc] ${line}`));
  });

  child.on("error", (err) => {
    console.error(`[go2rtc] spawn error: ${err.message}`);
    status = "error";
    go2rtcProcess = null;
  });

  child.on("exit", (code) => {
    if (_stoppingIntentional) return;
    console.log(`[go2rtc] exited (code ${code})`);
    handleCrash();
  });

  console.log(`[go2rtc] started (PID: ${child.pid})`);
  startHealthLoop();

  return { ok: true, pid: child.pid };
}

/* ── Public API ───────────────────────────────────────────────────── */

/**
 * Start go2rtc background process.
 * @param {boolean} enableAutoRestart - auto-restart on crash (up to 3 times)
 * @returns {Promise<{ok:boolean, pid?:number, already?:boolean, error?:string}>}
 */
async function start(enableAutoRestart = true) {
  // Already running as child process
  if (go2rtcProcess && go2rtcProcess.exitCode === null) {
    return { ok: true, already: true, pid: go2rtcProcess.pid };
  }

  _autoRestart = !!enableAutoRestart;
  _stoppingIntentional = false;
  crashCount = 0;

  // Check if already running via Systemd service or external process
  const alreadyHealthy = await checkHealth();
  if (alreadyHealthy) {
    status = "running";
    _externalInstance = true;
    startHealthLoop();
    return { ok: true, already: true, external: true };
  }

  // Port checks
  const apiPortFree = await isPortFree(API_PORT);
  if (!apiPortFree) {
    // If port is occupied but checkHealth didn't respond, report status
    status = "error";
    return { ok: false, error: `Port ${API_PORT} (go2rtc API) already in use` };
  }
  const webrtcPortFree = await isPortFree(WEBRTC_PORT);
  if (!webrtcPortFree) {
    status = "error";
    return {
      ok: false,
      error: `Port ${WEBRTC_PORT} (go2rtc WebRTC) already in use`,
    };
  }

  return _spawnProcess();
}

/**
 * Stop go2rtc background process gracefully.
 * @returns {Promise<void>}
 */
function stop() {
  return new Promise((resolve) => {
    if (_externalInstance) {
      resolve({
        ok: false,
        error: "go2rtc is managed by systemd on this gateway; use the Linux service controls.",
        managedExternally: true,
      });
      return;
    }
    _stoppingIntentional = true;
    _autoRestart = false;
    stopHealthLoop();

    if (!go2rtcProcess || go2rtcProcess.exitCode !== null) {
      go2rtcProcess = null;
      status = "stopped";
      resolve({ ok: true });
      return;
    }

    const pid = go2rtcProcess.pid;
    let settled = false;

    const forceKill = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        process.kill(pid, "SIGKILL");
      } catch (_) {}
      go2rtcProcess = null;
      status = "stopped";
      console.log("[go2rtc] force-killed after timeout");
      resolve({ ok: true });
    }, SHUTDOWN_TIMEOUT_MS);
    if (forceKill.unref) forceKill.unref();

    go2rtcProcess.once("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKill);
      go2rtcProcess = null;
      status = "stopped";
      console.log("[go2rtc] stopped");
      resolve({ ok: true });
    });

    try {
      process.kill(pid);
    } catch (_) {
      if (!settled) {
        settled = true;
        clearTimeout(forceKill);
        go2rtcProcess = null;
        status = "stopped";
        resolve({ ok: true });
      }
    }
  });
}

/**
 * Get current go2rtc status.
 */
function getStatus() {
  return {
    status,
    running: status === "running" || status === "starting",
    pid: go2rtcProcess ? go2rtcProcess.pid : null,
    crashCount,
    lastHealthTs,
    autoRestart: _autoRestart,
    managedExternally: _externalInstance,
  };
}

/**
 * Check if go2rtc is currently running.
 */
function isRunning() {
  return go2rtcProcess !== null && go2rtcProcess.exitCode === null;
}

// Auto-detect running systemd instance on gateway boot
setTimeout(async () => {
  const alive = await checkHealth();
  if (alive) {
    status = "running";
    _externalInstance = true;
    lastHealthTs = Date.now();
    startHealthLoop();
  }
}, 1500).unref();

module.exports = { start, stop, getStatus, isRunning };
