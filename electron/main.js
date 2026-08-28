"use strict";
/**
 * main.js - Electron entry point for ADSI Inverter Dashboard
 * Starts a Python backend (PyInstaller EXE preferred, python script fallback).
 *
 * v2.8.10 (Phase A — power-loss resilience): the file begins with a tight
 * "survival boot" block of Node core + electron core requires only. Any
 * failure here must be caught and surfaced via the recovery dialog instead
 * of letting Electron's default fatal handler show a cryptic SyntaxError.
 * See audits/2026-04-17/power-loss-resilience-v2.8.10.md for rationale.
 */

// ── A1. Survival boot — core only, zero third-party requires ──────────────────
const { app, BrowserWindow, ipcMain, shell, globalShortcut, dialog, Menu, Tray } = require("electron");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn, execFile, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const net = require("net");
const crypto = require("crypto");
const hikvisionNativePlayer = require("./hikvisionNativePlayer");

// ── A1. Hoisted global fatal handlers ────────────────────────────────────────
// Registered BEFORE any third-party require so a corrupt app.asar (torn
// write from sudden power loss) cannot bypass our recovery path. If a
// fatal error lands here during startup, we route to the recovery dialog.
// If it lands later (after the app is up), we log-and-continue to keep
// the renderer/tray alive (preserves the T6.7 fix behaviour).
const _startupFailures = [];
let _recoveryShown = false;

function writeBootLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    const tmp = path.join(os.tmpdir(), "inverter-boot-debug.log");
    fs.appendFileSync(tmp, line);
  } catch (_) {}
  try {
    const root = process.env.PROGRAMDATA || "C:\\ProgramData";
    const dir = path.join(root, "Inverter-Dashboard", "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "boot-debug.log"), line);
  } catch (_) {}
}
writeBootLog("main.js evaluated, app.isPackaged=" + app.isPackaged);

function _routeStartupFatal(err, phase = "uncaught") {
  const msg = `Fatal ${phase}: ${err?.stack || err?.message || String(err)}`;
  writeBootLog(msg);
  const code = String(err?.code || "");
  if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return;
  try { console.error(`[main] Fatal ${phase}:`, err); } catch (_) { /* ignore */ }
  if (_recoveryShown || app?.isReady?.()) return;
  _recoveryShown = true;
  try {
    const { showRecoveryDialogAndExit } = require("./recoveryDialog");
    const bootWhenReady = () => {
      try {
        showRecoveryDialogAndExit({
          reason: `Startup ${phase}: ${err?.message || String(err)}`,
          startupFailures: _startupFailures,
        });
      } catch (_) {
        app.exit(1);
      }
    };
    if (app.isReady()) bootWhenReady();
    else app.once("ready", bootWhenReady);
  } catch (_) {
    app.exit(1);
  }
}
process.on("uncaughtException", (err) => {
  writeBootLog("uncaughtException: " + (err?.stack || err?.message || String(err)));
  try {
    require("./shutdownReason").recordShutdownReasonSync("uncaught-exception", {
      initiator: "runtime",
      extra: { errorMessage: String(err?.message || err), errorCode: String(err?.code || "") },
    });
  } catch (_) { /* module may not have loaded yet on torn-write boots */ }
  _routeStartupFatal(err, "uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  writeBootLog("unhandledRejection: " + (reason?.stack || reason?.message || String(reason)));
  _routeStartupFatal(reason, "unhandledRejection");
});

// ── A2. Memory & Performance Optimizations ─────────────────────────────────────
// Limit V8 engine's garbage collection heap to prevent memory bloat in long-
// running instances. Default V8 allows 1GB+; we cap it at 256MB per process.
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=256 --expose-gc");

// Hikvision LocalService owns its hardware-decoded native video surface; this
// Chromium memory optimization therefore does not affect that stream.
app.commandLine.appendSwitch("disable-gpu-memory-buffer-video-frames");
app.commandLine.appendSwitch("disable-features", "SharedArrayBuffer");
app.commandLine.appendSwitch("disable-logging");
app.commandLine.appendSwitch("disable-software-rasterizer");
// Disable aggressive background networking features not needed for local dashboards
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-metrics");

// ── A3. safeRequire — wrap every third-party require ─────────────────────────
// Any module loaded from app.asar can throw SyntaxError on torn writes.
// Capture the failure, continue booting, and let the integrity gate decide
// whether to show the recovery dialog.
function safeRequire(modulePath, fallback = null) {
  try {
    return require(modulePath);
  } catch (err) {
    console.error(`[main] require("${modulePath}") failed:`, err?.message || err);
    _startupFailures.push({ module: modulePath, error: String(err?.message || err) });
    return fallback;
  }
}

// ── A3. Integrity gate — verify app.asar before touching third-party code ────
const _integrityGate = safeRequire("./integrityGate", {
  verifyAsarIntegrity: () => ({ ok: true, mode: "skipped", reason: "gate-missing" }),
});
// In dev mode (`npm start`) the app runs from source — there is no
// `resources/app.asar` to verify. `app.isPackaged` is false in that case.
// Skip the gate entirely: dev-mode corruption is the developer's problem,
// not something the recovery dialog should surface.
const _integrityResult = (() => {
  if (!app.isPackaged) {
    return { ok: true, mode: "skipped", reason: "dev-mode (app not packaged)" };
  }
  try { return _integrityGate.verifyAsarIntegrity({ resourcesPath: process.resourcesPath }); }
  catch (err) {
    console.warn("[main] integrity gate threw:", err?.message || err);
    return { ok: true, mode: "skipped", reason: `gate-error:${err?.message || "unknown"}` };
  }
})();
console.log(
  `[main] app.asar integrity: ok=${_integrityResult.ok} mode=${_integrityResult.mode} reason=${_integrityResult.reason || "-"}`,
);
if (!_integrityResult.ok && !_recoveryShown) {
  _recoveryShown = true;
  app.whenReady().then(() => {
    try {
      const { showRecoveryDialogAndExit } = require("./recoveryDialog");
      showRecoveryDialogAndExit({
        reason: "Integrity check failed",
        integrityResult: _integrityResult,
        startupFailures: _startupFailures,
      });
    } catch (err) {
      console.error("[main] recovery dialog failed:", err?.message || err);
      // Doomsday fallback — recovery dialog itself crashed. Mark this so
      // the next boot doesn't double-flag with "unexpected" on top of the
      // (already user-visible) integrity failure.
      try {
        recordEarlyExitMarker(
          SHUTDOWN_REASONS.UNCAUGHT_EXCEPTION,
          SHUTDOWN_INITIATORS.RUNTIME,
          { earlyExitPath: "integrity-recovery-dialog-fail", error: String(err?.message || err) },
        );
      } catch (_) {}
      app.exit(1);
    }
  });
}

// ── Third-party requires (wrapped) ───────────────────────────────────────────
const Database = safeRequire("better-sqlite3");
const _electronUpdaterModule = safeRequire("electron-updater", { autoUpdater: null });
const { autoUpdater } = _electronUpdaterModule || { autoUpdater: null };
const _runtimeEnvPaths = safeRequire("../server/runtimeEnvPaths", {
  getExplicitDataDir: () => "",
  getPortableDataRoot: () => "",
});
const { getExplicitDataDir, getPortableDataRoot } = _runtimeEnvPaths;
const _storagePaths = safeRequire("../server/storagePaths", { resolvedDbDir: () => "" });
const { resolvedDbDir } = _storagePaths;

// v2.8.14 — nightly reboot diagnostics. Shutdown reason markers let us
// distinguish Windows OS-initiated reboots (Windows Update / Automatic
// Maintenance) from BSODs / power loss / clean user quits. The module is
// zero-dep and safe even on partially-corrupt installs, so it stays in the
// survival-boot block above safeRequire of heavier modules would live.
const _shutdownReason = safeRequire("./shutdownReason", {
  PATHS: {},
  REASONS: {
    SESSION_END: "session-end",
    POWER_SHUTDOWN: "power-shutdown",
    POWER_SUSPEND: "power-suspend",
    BEFORE_QUIT: "before-quit",
    INSTALL_UPDATE: "install-update",
    RELAUNCH: "relaunch",
    LICENSE_EXPIRED: "license-expired",
    UNCAUGHT_EXCEPTION: "uncaught-exception",
    PROCESS_EXIT: "process-exit",
  },
  INITIATORS: {
    WINDOWS_OS: "windows-os",
    USER: "user",
    AUTO_UPDATER: "auto-updater",
    RUNTIME: "runtime",
    UNKNOWN: "unknown",
  },
  recordShutdownReasonSync: () => null,
  readLastShutdownSync: () => ({ classification: "first-boot", priorReason: null, sentinelWasPresent: false }),
  readPrevShutdownSync: () => null,
});
const SHUTDOWN_REASONS = _shutdownReason.REASONS;
const SHUTDOWN_INITIATORS = _shutdownReason.INITIATORS;

// Track whether we've already written a marker for this shutdown pass so the
// first recorded reason wins (e.g. if powerMonitor fires before session-end,
// we keep the powerMonitor reason rather than overwriting it with a generic
// before-quit from Electron's cascaded lifecycle events).
let _shutdownReasonRecorded = false;
function recordShutdownReasonOnce(reason, options) {
  if (_shutdownReasonRecorded) return null;
  try {
    const rec = _shutdownReason.recordShutdownReasonSync(reason, options);
    if (rec) {
      _shutdownReasonRecorded = true;
      try { console.log(`[main] Shutdown reason recorded: ${rec.reason} (${rec.initiator})`); } catch (_) {}
    } else {
      // Sync write returned falsy without throwing — likely an fs failure
      // (lifecycle dir not writable, disk full, permission denied). Surface
      // it so operators can correlate "next-boot unexpected" banners with
      // the underlying file-system issue.
      try {
        console.warn(
          `[main] Shutdown marker write returned no record for reason=${reason} ` +
          `— sentinel without matching marker may misclassify next boot as "unexpected".`,
        );
      } catch (_) {}
    }
    return rec;
  } catch (err) {
    try { console.warn("[main] Failed to record shutdown reason:", err?.message || err); } catch (_) {}
    return null;
  }
}

// Record a shutdown marker for "early exit" paths that bypass the normal
// requestAppShutdown chain (singleton lock deny, license-startup-fail,
// login cancel, recovery-dialog failure). Without this, those exits leave
// a sentinel on disk with no matching `shutdown-reason.current.json`, and
// the NEXT boot misclassifies the prior run as "unexpected" — surfacing
// the false-positive amber banner the user sees on every startup.
//
// The marker is written synchronously and tagged with a specific reason so
// the audit trail can still tell apart "real graceful quit" from "user
// closed login dialog before boot completed".
function recordEarlyExitMarker(reason, initiator, extra) {
  if (_shutdownReasonRecorded) return null;
  try {
    const rec = _shutdownReason.recordShutdownReasonSync(reason, { initiator, extra });
    if (rec) {
      _shutdownReasonRecorded = true;
      try { console.log(`[main] Early-exit marker recorded: ${rec.reason} (${rec.initiator})`); } catch (_) {}
    } else {
      try {
        console.warn(
          `[main] Early-exit marker write returned no record for reason=${reason} ` +
          `path=${extra?.earlyExitPath || "unknown"} — next boot may misclassify as "unexpected".`,
        );
      } catch (_) {}
    }
    return rec;
  } catch (err) {
    try { console.warn("[main] Failed to record early-exit marker:", err?.message || err); } catch (_) {}
    return null;
  }
}

// Counterpart to recordEarlyExitMarker for the "tentative" markers we write
// *before* a confirm-exit dialog (mainWin / calibratorWin close handlers).
// The dialog is synchronous and blocks the renderer thread for as long as
// the user takes to decide. If the OS / Task Manager terminates the process
// while the dialog is up, we want a graceful marker already on disk so the
// next boot does not false-flag "Unexpected prior shutdown". But if the
// user clicks Cancel the app keeps running, and a *later* genuine crash
// must still be detectable as unexpected — so we have to rescind the
// tentative marker on cancel, both on disk and via the _shutdownReasonRecorded
// flag, so subsequent shutdown paths can write the authoritative reason.
function rescindEarlyExitMarker() {
  try {
    const cur = _shutdownReason && _shutdownReason.PATHS && _shutdownReason.PATHS.current;
    if (cur && fs.existsSync(cur)) {
      try { fs.unlinkSync(cur); } catch (_) { /* best-effort */ }
    }
  } catch (_) { /* ignore */ }
  _shutdownReasonRecorded = false;
}

// Classify the PRIOR run's shutdown. This writes a fresh boot-sentinel for
// THIS run as a side-effect, so it must happen exactly once at startup AND
// only after we've confirmed this process is the singleton primary —
// otherwise a second-instance launch attempt would overwrite the running
// first-instance's sentinel and synthesize a bogus "unexpected-shutdown"
// into prev. The actual call moves below the singleton lock check.
let _lastShutdownSnapshot = null;
// True only for the FIRST instance (and standalone calibrator), which is the
// sole owner of the lifecycle markers. A losing second instance must never
// touch them (it would write a `current` marker while the real first
// instance is still running, masking a later first-instance crash as
// graceful). _initShutdownSnapshot() runs only on the owning process, so it
// is the precise place to assert ownership for the process-exit fallback.
let _ownsLifecycleMarkers = false;
function _initShutdownSnapshot() {
  try {
    _lastShutdownSnapshot = _shutdownReason.readLastShutdownSync();
    // Defer ownership until AFTER the classifier runs: if another lifecycle-
    // owning process (e.g. the dashboard) is still alive, readLastShutdownSync
    // returns "concurrent-instance" and we explicitly decline ownership so
    // this process's exit fallback won't plant a `current.json` that masks
    // a subsequent first-instance crash. This mainly matters for the
    // standalone calibrator launched in parallel with the dashboard — they
    // share the lifecycle dir under PROGRAMDATA.
    if (_lastShutdownSnapshot && _lastShutdownSnapshot.classification === "concurrent-instance") {
      _ownsLifecycleMarkers = false;
      try {
        console.log(
          `[main] Lifecycle markers owned by live PID ${_lastShutdownSnapshot.concurrentPid || "?"} ` +
          `— this process will not write shutdown markers.`,
        );
      } catch (_) {}
    } else {
      _ownsLifecycleMarkers = true;
    }
    if (_lastShutdownSnapshot) {
      process.env.ADSI_LAST_SHUTDOWN_JSON = JSON.stringify(_lastShutdownSnapshot);
      try {
        console.log(
          `[main] Prior shutdown classification: ${_lastShutdownSnapshot.classification}` +
          (_lastShutdownSnapshot.priorReason?.reason
            ? ` (reason=${_lastShutdownSnapshot.priorReason.reason})`
            : ""),
        );
      } catch (_) {}
    }
  } catch (err) {
    try { console.warn("[main] readLastShutdownSync failed:", err?.message || err); } catch (_) {}
    // On any unexpected failure, claim ownership so a real first-instance
    // dashboard launch still records markers (the err-handler must not
    // accidentally silence the diagnostic).
    _ownsLifecycleMarkers = true;
  }
}

// Allow dashboard alarm audio to start immediately on packaged clients.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Standalone Field Calibrator launch mode. The Desktop shortcut created from
// Settings → "Calibrator Desktop Shortcut" passes `--calibrator`, which makes
// this process boot ONLY the calibrator stack (Python :9200 + Node :3600 +
// the calibrator window) — no dashboard server, no login, no fleet UI. It
// uses its own ports and ~/.calibrator DB, so it can run with or without the
// dashboard already open. Must be evaluated before the single-instance lock.
const CALIBRATOR_STANDALONE =
  process.argv.includes("--calibrator") ||
  process.argv.includes("--calibrator-standalone");

// T6.1 fix: single-instance lock.  Prevents two copies of the packaged app
// from running simultaneously against the same adsi.db + ports 3500/9000,
// which previously risked SQLite "database is locked" and Python FastAPI
// "Address already in use" errors plus correlated data loss.  The second
// instance will quit immediately after signalling the first to focus its
// window.  Must run BEFORE app.whenReady() so the lock is in place before
// any services initialise.
//
// The standalone calibrator deliberately does NOT take this lock: it targets
// a disjoint port/DB set (3600/9200, ~/.calibrator) and is meant to launch
// even while the dashboard owns the lock. Its own stale-port cleanup
// (cleanupStaleCalibratorPorts) guards against two calibrator instances.
const _gotSingleInstanceLock = CALIBRATOR_STANDALONE
  ? true
  : app.requestSingleInstanceLock();
if (!CALIBRATOR_STANDALONE && !_gotSingleInstanceLock) {
  console.warn("[main] Another instance is already running — quitting this one.");
  // Second instance — DO NOT touch lifecycle markers. The running first
  // instance owns the current sentinel; we just exit cleanly so the user
  // is signalled (focus first-instance window) without corrupting state.
  app.exit(0);
} else {
  // First instance — safe to read & rotate prior-shutdown markers and
  // write a fresh boot sentinel for THIS run.
  _initShutdownSnapshot();
  app.on("second-instance", (_event, _argv, _cwd) => {
    try {
      const wins = BrowserWindow.getAllWindows();
      const primary = wins.find((w) => !w.isDestroyed());
      if (primary) {
        if (primary.isMinimized()) primary.restore();
        if (!primary.isVisible()) primary.show();
        primary.focus();
      }
    } catch (err) {
      console.warn("[main] second-instance focus failed:", err?.message || err);
    }
  });
}

// Prevent packaged app crashes when stdout/stderr pipe is unavailable (EPIPE).
function makeSafeConsoleWriter(method) {
  const original = console[method].bind(console);
  return (...args) => {
    try {
      original(...args);
    } catch (err) {
      const code = String(err?.code || "");
      if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return;
      try {
        process.stderr.write(`[console-${method}-fallback] ${args.map((v) => String(v)).join(" ")}\n`);
      } catch (_) {
        // Ignore secondary logging failures.
      }
    }
  };

}

console.log = makeSafeConsoleWriter("log");
console.warn = makeSafeConsoleWriter("warn");
console.error = makeSafeConsoleWriter("error");

if (process.stdout && typeof process.stdout.on === "function") {
  process.stdout.on("error", (err) => {
    const code = String(err?.code || "");
    if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return;
  });
}
if (process.stderr && typeof process.stderr.on === "function") {
  process.stderr.on("error", (err) => {
    const code = String(err?.code || "");
    if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return;
  });
}

// Note: uncaughtException + unhandledRejection handlers are now hoisted to
// the top of the file (v2.8.10 Phase A1). The previous T6.7 log-and-continue
// semantics remain intact — they're implemented inside _routeStartupFatal
// (routes to recovery dialog during startup; swallows once app is ready).

const PORTABLE_EXEC_DIR = String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim();
const PORTABLE_DATA_DIR = PORTABLE_EXEC_DIR
  ? path.join(PORTABLE_EXEC_DIR, "InverterDashboardData")
  : "";

// ─── Config ───────────────────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, "../public");
const SERVER_URL = "http://localhost:3500";
const SERVER_HTTP = new URL(SERVER_URL);
const SERVER_HOST = SERVER_HTTP.hostname || "127.0.0.1";
const SERVER_PORT = Number(SERVER_HTTP.port || 80);
const TELEMETRY_ENGINE_PORT = 9100;
const TOPOLOGY_URL = `${SERVER_URL}/topology.html`;
const GLOBAL_CONFIG_URL = `${SERVER_URL}/global-config.html`;
const POLL_INTERVAL = 600;
const POLL_TIMEOUT = 120000;
const INITIAL_LOAD_RETRY_DELAY = 1200;
const INITIAL_LOAD_RETRY_MAX = 8;
const MAIN_RENDERER_READY_TIMEOUT_MS = 120000;
const FORECAST_RESTART_BASE_MS = 1500;
const FORECAST_RESTART_MAX_MS = 30000;
// T6.9 fix (Phase 3, 2026-04-14): same backoff envelope as forecast
// service, used by scheduleBackendRestart().
const BACKEND_RESTART_BASE_MS = 1500;
const BACKEND_RESTART_MAX_MS = 30000;
// Crash-loop storm guard (2026-06-01): cap consecutive auto-restarts that are
// NOT separated by a stable run. Without this, a deterministic startup crash
// (corrupt DB, port conflict, missing module, bad EXE path) respawns a fresh
// process tree forever — on the gateway PC this exhausts RAM/handles/CPU and
// can take the whole machine down. The backoff alone never stopped because the
// 'spawn' event reset the attempt counter every cycle. We now reset the counter
// only after the process has survived *_STABLE_RESET_MS, so a fast crash-loop
// escalates to the cap and halts; a healthy run that later dies still recovers.
const BACKEND_RESTART_MAX_ATTEMPTS = 10;
const FORECAST_RESTART_MAX_ATTEMPTS = 10;
const BACKEND_STABLE_RESET_MS = 60000;
const FORECAST_STABLE_RESET_MS = 60000;
const FORECAST_MODE_SYNC_MS = 10000;
const APP_SHUTDOWN_WEB_TIMEOUT_MS = 5000;
const APP_SHUTDOWN_FORCE_KILL_WAIT_MS = 2000;
// Hard ceiling for the whole stopRuntimeServices() drain. The sub-phases
// already have bounded, unref'd timers (embedded ~5 s, per-child force-kill
// ~2 s, run concurrently → ~7-9 s real worst case). If a non-resolving
// promise wedges the drain past this ceiling we self-exit via app.exit()
// rather than lingering until the operator / OS / build tooling force-kills
// us with TerminateProcess — which skips process 'exit' and leaves NO
// shutdown marker, the exact cause of the false "Unexpected prior shutdown"
// banner. 20 s is comfortably above any healthy drain so it never preempts
// one; it only bounds a true hang. Disarmed once finalizeAppShutdown() runs
// (so the legitimately-longer install path is unaffected).
const APP_SHUTDOWN_HARD_CEILING_MS = 20000;
const IS_DEV = process.env.NODE_ENV === "development" || !app.isPackaged;
const BACKEND_EXE_NAMES = ["InverterCoreService.exe", "adsi-inverter.exe", "inverter_engine.exe"];
const BACKEND_SCRIPT_NAMES = ["InverterCoreService.py", "inverter_engine.py", "main2.py"];
const FORECAST_EXE_NAMES = ["ForecastCoreService.exe", "adsi-forecast.exe", "forecast_engine.exe"];
const FORECAST_SCRIPT_NAMES = ["ForecastCoreService.py", "forecast_engine.py"];
const CALIBRATOR_EXE_NAMES = ["CalibratorService.exe"];
const CALIBRATOR_SCRIPT_NAMES = ["CalibratorService.py"];
const CALIBRATOR_NODE_ENTRY = "server/calibratorMain.js";
const CALIBRATOR_PY_PORT = 9200;
const CALIBRATOR_NODE_PORT = 3600;
// 30 s (was 15 s): an Electron-as-Node cold start + SQLite open is slow on
// a contended box (e.g. a concurrent electron-builder / native rebuild),
// and a 15 s window false-failed a calibrator that was merely starting
// slowly. Readiness still polls every 250 ms so a fast start is unaffected.
const CALIBRATOR_READINESS_TIMEOUT_MS = 30000;
// Last lines of calibrator Python+Node stdio, for the failure dialog and a
// persisted log (main.js otherwise pipes calibrator stdio to nowhere, so
// "check the logs" was previously impossible to act on).
let _calibratorLogTail = "";
function _calibratorLogPath() {
  try {
    return path.join(app.getPath("userData"), "calibrator.log");
  } catch (_) {
    return path.join(__dirname, "..", "calibrator.log");
  }
}
function _attachCalibratorLogging(proc, tag) {
  if (!proc) return;
  let logFile = null;
  try {
    logFile = fs.createWriteStream(_calibratorLogPath(), { flags: "a" });
    logFile.write(`\n===== ${tag} spawn ${new Date().toISOString()} (pid ${proc.pid}) =====\n`);
  } catch (_) {}
  const sink = (buf) => {
    const s = String(buf || "");
    _calibratorLogTail = (_calibratorLogTail + s).slice(-8000);
    if (logFile) { try { logFile.write(s); } catch (_) {} }
  };
  try { proc.stdout && proc.stdout.on("data", sink); } catch (_) {}
  try { proc.stderr && proc.stderr.on("data", sink); } catch (_) {}
}
const LEGACY_SERVICE_IMAGE_NAMES = ["ADSI_InverterService.exe", "ADSI_ForecastService.exe"];
// Login-page admin auth key is intentionally fixed across devices.
const LOGIN_ADMIN_AUTH_KEY = "ADSI-2026";
const DEFAULT_LOGIN_USERNAME = "admin";
const DEFAULT_LOGIN_PASSWORD = "1234";
const APP_ICON = path.join(__dirname, "../assets/icon.ico");

// Resolve the Field Calibrator icon. In a packaged build the icon must be a
// REAL on-disk file (a Windows .lnk cannot read an icon embedded inside
// app.asar), so package.json ships assets/calib.{ico,png} via extraResources
// to the resources root. In dev, fall back to the repo assets/ copy.
function calibratorIconPath(ext = "ico") {
  try {
    const packaged = path.join(process.resourcesPath || "", `calib.${ext}`);
    if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  } catch (_) {}
  return path.join(__dirname, "..", "assets", `calib.${ext}`);
}
const PROGRAMDATA_ROOT = process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || "C:\\ProgramData";
const PROGRAMDATA_DIR = process.env.INVERTER_STORAGE_DIR ||
  (app.isPackaged
    ? path.join(PROGRAMDATA_ROOT, "Inverter-Dashboard")
    : path.join(__dirname, "..", "storage"));
// Lazy license path resolution — must NOT be evaluated at module load because
// storage migration runs later during the Electron loading screen.  Evaluating
// eagerly would freeze the path to the old namespace for the entire session.
function getLicenseDir() {
  const newDir = path.join(PROGRAMDATA_DIR, "license");
  const oldDir = path.join(PROGRAMDATA_ROOT, "Inverter-Dashboard", "license");
  return (fs.existsSync(newDir) || !fs.existsSync(oldDir)) ? newDir : oldDir;
}
function getLicenseStatePath() { return path.join(getLicenseDir(), "license-state.json"); }
function getLicenseFileMirror() { return path.join(getLicenseDir(), "license.dat"); }
const LICENSE_REG_PATH = "HKCU\\Software\\InverterDashboard\\License";
const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = 7;
const LICENSE_WARN_MS = DAY_MS; // 1 day
const LICENSE_CHECK_INTERVAL_MS = 5 * 1000;
const LICENSE_PUBLIC_KEY_PATH = String(process.env.ADSI_LICENSE_PUBLIC_KEY_PATH || "").trim();
const LICENSE_PUBLIC_KEY_PEM = String(process.env.ADSI_LICENSE_PUBLIC_KEY || "").trim();
const LICENSE_REQUIRE_SIGNATURE =
  String(process.env.ADSI_LICENSE_REQUIRE_SIGNATURE || "0").trim() === "1";
const UPDATE_REPO_OWNER = String(process.env.ADSI_UPDATE_REPO_OWNER || "mclards").trim();
const UPDATE_REPO_NAME = String(process.env.ADSI_UPDATE_REPO_NAME || "Inverter-Dashboard").trim();
// Update channel: "stable" (default) or "beta". Beta channel requires an
// explicit ADSI_UPDATE_FEED_URL override pointing at a beta-tagged release
// asset directory (e.g. https://github.com/owner/repo/releases/download/v2.7.18-beta).
// Without the override, beta falls back to stable to avoid silently broken updates.
const UPDATE_CHANNEL_REQUESTED = String(process.env.ADSI_UPDATE_CHANNEL || "stable").trim().toLowerCase();
let UPDATE_CHANNEL_FALLBACK_NOTE = "";
const UPDATE_CHANNEL = (() => {
  if (UPDATE_CHANNEL_REQUESTED === "beta") {
    if (!String(process.env.ADSI_UPDATE_FEED_URL || "").trim()) {
      UPDATE_CHANNEL_FALLBACK_NOTE = "Beta channel requested but ADSI_UPDATE_FEED_URL is not set; using stable.";
      console.warn(
        "[updater] ADSI_UPDATE_CHANNEL=beta requires ADSI_UPDATE_FEED_URL to be set " +
        "to a beta release asset URL (e.g. .../releases/download/v2.x.y-beta). " +
        "Falling back to stable channel.",
      );
      return "stable";
    }
    return "beta";
  }
  return "stable";
})();
const UPDATE_FEED_URL = String(
  process.env.ADSI_UPDATE_FEED_URL
  || `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/latest/download`,
).trim();
const UPDATE_GITHUB_TOKEN = String(process.env.ADSI_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "").trim();
const UPDATE_CHECK_TIMEOUT_MS = 10000;
const LEGACY_USERDATA_DIR_NAMES = [
  "adsi-dashboard",
  "adsi-inverter-dashboard",
  "inverter dashboard",
  "dashboard v2",
];

// ─── State ────────────────────────────────────────────────────────────────────
let mainWin = null;
let backgroundTray = null;
let loadingWin = null;
let loginWin = null;
let topologyWin = null;
let globalConfigWin = null;
let calibratorWin = null;
let hikvisionNativeViewerWin = null;
let hikvisionNativeViewerRequester = null;
let hikvisionNativeViewerClosing = false;
let allowHikvisionNativeViewerClose = false;
// Pop-out windows: keyed by page name (analytics, alarms, forecast, igbt-health).
// Using a Map prevents duplicate windows and allows focus-on-reclick.
const popoutWindows = new Map();
// Mirrors `allowMainWindowClose` for the standalone Utility Tool window.
// Set true after the operator confirms the exit prompt (or by callers that
// close the window programmatically, e.g. parent-app shutdown chain) so the
// next "close" event proceeds without re-prompting.
let allowCalibratorClose = false;
let _calibratorSpawnInProgress = false; // FIX B: spawn-guard to prevent overlapping invocations
let calibratorPyProc = null;
let calibratorNodeProc = null;
let webProc = null;
let embeddedServerStarted = false;
let embeddedServerModule = null;
let backendProc = null;
let forecastProc = null;
// Serializes manual Start/Stop requests. A double click or a stale renderer
// must never interleave a stop with a new child-process launch.
let serverLifecycleOperation = Promise.resolve();
let serverBootError = "";
let serverReadyFired = false;
let mainPageLoadedOnce = false;
let initialLoadRetries = 0;
let initialLoadRetryTimer = null;
let mainRendererReady = false;
let startupErrorShown = false;
let loadingWinLoadCount = 0;
let mainRendererReadyTimer = null;
let isAppShuttingDown = false;
let forecastRestartTimer = null;
// T6.9 fix (Phase 3): auto-restart state for the backend (Node server).
let backendRestartTimer = null;
let backendRestartAttempts = 0;
let forecastRestartAttempts = 0;
// Timestamps of the last successful spawn — used to decide whether an exit
// followed a *stable* run (reset the attempt counter) or a fast crash-loop
// (let the counter climb toward the *_MAX_ATTEMPTS cap). See restart constants.
let backendSpawnedAt = 0;
let forecastSpawnedAt = 0;
// Latched once the forecast service exhausts its restart budget — gates BOTH
// the restart-timer path and the 10s mode-sync respawn path. Cleared on a
// stable run or a manual/mode stop so recovery is always possible.
let forecastRestartHalted = false;
let forecastModeSyncTimer = null;
let forecastModeSyncInFlight = false;
let forecastStopExpected = false;
let lastForecastLaunch = null;
let hasAuthenticated = false;
let bootStarted = false;
let shortcutsRegistered = false;
let licenseStateCache = null;
let licenseCheckerTimer = null;
let licenseShutdownTriggered = false;
let lastBroadcastLicenseSignature = "";
let allowMainWindowClose = false;
let appShutdownPromise = null;
let appShutdownBypassQuit = false;
let appShutdownFinalAction = { type: "quit", exitCode: 0 };
// Set true the instant finalizeAppShutdown() runs. Disarms the
// stopRuntimeServices() hard-ceiling watchdog so the (legitimately longer)
// install / relaunch finalize paths are never preempted.
let _appShutdownFinalized = false;
let backendStopExpected = false;
let appUpdateAutoCheckTimer = null;
let appUpdateAutoCheckStarted = false;
let appUpdateBridgeBound = false;
// v2.8.10 Phase B1: path of the most recently signature-verified installer
// handed to autoUpdater. Captured in verifyUpdateCodeSignature and copied
// to %PROGRAMDATA%\InverterDashboard\updates\last-good-installer.exe once
// the download is complete so the recovery dialog can relaunch it offline.
let lastVerifiedInstallerPath = "";
let appUpdateState = {
  mode: "disabled",
  appVersion: "0.0.0",
  channel: "stable",
  status: "idle",
  message: "Updater not initialized.",
  checking: false,
  updateAvailable: false,
  latestVersion: "",
  downloadPercent: 0,
  canDownload: false,
  canInstall: false,
  downloadUrl: "",
  releasesUrl: "",
  checkedAt: 0,
  error: "",
};

const SERVICE_SOFT_STOP_FILE_NAMES = Object.freeze({
  backend: "backend.stop",
  forecast: "forecast.stop",
});
const BACKEND_SOFT_STOP_WAIT_MS = 8000;
const FORECAST_SOFT_STOP_WAIT_MS = 25000;

function configurePortableDataPaths() {
  if (!PORTABLE_DATA_DIR) return;
  try {
    fs.mkdirSync(PORTABLE_DATA_DIR, { recursive: true });
    const userDataDir = path.join(PORTABLE_DATA_DIR, "userData");
    const dbDir = path.join(PORTABLE_DATA_DIR, "db");
    const cfgDir = path.join(PORTABLE_DATA_DIR, "config");
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(dbDir, { recursive: true });
    fs.mkdirSync(cfgDir, { recursive: true });
    app.setPath("userData", userDataDir);
    process.env.IM_PORTABLE_DATA_DIR = PORTABLE_DATA_DIR;
    process.env.IM_DATA_DIR = dbDir;
    process.env.ADSI_PORTABLE_DATA_DIR = PORTABLE_DATA_DIR;
    process.env.ADSI_DATA_DIR = dbDir;
    console.log("[main] Portable data root:", PORTABLE_DATA_DIR);
  } catch (err) {
    console.error("[main] Portable path setup failed:", err.message);
  }
}

configurePortableDataPaths();

// The Inverter Dashboard owns this durable Windows data directory. Keep the
// embedded gateway and both Python services on the same directory even in a
// development launch: otherwise the renderer can read a different product's
// configuration while polling continues from `Inverter-Dashboard` or the
// repository `storage` tree.
// An explicit administrator/portable override always wins.
function getRuntimeDataDir() {
  const explicit = String(getExplicitDataDir(process.env) || "").trim();
  if (explicit) return explicit;
  const portableRoot = String(getPortableDataRoot(process.env) || "").trim();
  if (portableRoot) return path.join(portableRoot, "db");
  const inherited = String(process.env.INVERTER_DATA_DIR || "").trim();
  if (inherited) return inherited;
  return path.join(PROGRAMDATA_ROOT, "Inverter-Dashboard", "db");
}

function configureRuntimeDataPath() {
  const dataDir = getRuntimeDataDir();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    console.warn("[main] Could not create runtime data directory:", err.message);
  }
  // Do not overwrite an administrator's IM_/ADSI_ override. INVERTER_DATA_DIR
  // is recognised by the gateway, poller, and Python engine and gives all
  // three the same canonical database/configuration directory.
  if (!String(getExplicitDataDir(process.env) || "").trim()) {
    process.env.INVERTER_DATA_DIR = dataDir;
  }
  return dataDir;
}

configureRuntimeDataPath();

function copyFileIfMissing(src, dest) {
  try {
    if (!fs.existsSync(src) || fs.existsSync(dest)) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
  } catch (err) {
    console.warn("[migrate] file copy failed:", src, "->", dest, err.message);
    return false;
  }
}

function copyDirIfMissing(srcDir, destDir) {
  try {
    if (!fs.existsSync(srcDir)) return 0;
    fs.mkdirSync(destDir, { recursive: true });
  } catch (err) {
    console.warn("[migrate] dir init failed:", srcDir, "->", destDir, err.message);
    return 0;
  }
  let copied = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch (err) {
    console.warn("[migrate] dir read failed:", srcDir, err.message);
    return 0;
  }
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copied += copyDirIfMissing(src, dest);
    } else if (entry.isFile()) {
      copied += copyFileIfMissing(src, dest) ? 1 : 0;
    }
  }
  return copied;
}

function migrateLegacyUserDataIfNeeded() {
  if (isPortableRuntime()) return { migrated: false, source: "", files: 0 };
  let appDataDir = "";
  let currentUserData = "";
  try {
    appDataDir = app.getPath("appData");
    currentUserData = app.getPath("userData");
  } catch (err) {
    console.warn("[migrate] userData path resolve failed:", err.message);
    return { migrated: false, source: "", files: 0 };
  }
  if (!appDataDir || !currentUserData) return { migrated: false, source: "", files: 0 };
  try {
    fs.mkdirSync(currentUserData, { recursive: true });
  } catch (err) {
    console.warn("[migrate] current userData init failed:", currentUserData, err.message);
    return { migrated: false, source: "", files: 0 };
  }

  const currentNorm = path.resolve(currentUserData).toLowerCase();
  const candidateDirs = [];
  for (const name of LEGACY_USERDATA_DIR_NAMES) {
    const abs = path.join(appDataDir, name);
    const norm = path.resolve(abs).toLowerCase();
    if (norm === currentNorm) continue;
    candidateDirs.push(abs);
  }

  for (const legacyDir of candidateDirs) {
    if (!fs.existsSync(legacyDir)) continue;
    const authCopied = copyDirIfMissing(
      path.join(legacyDir, "auth"),
      path.join(currentUserData, "auth"),
    );
    const configCopied = copyDirIfMissing(
      path.join(legacyDir, "config"),
      path.join(currentUserData, "config"),
    );
    const rootConfigCopied = copyFileIfMissing(
      path.join(legacyDir, "ipconfig.json"),
      path.join(currentUserData, "config", "ipconfig.json"),
    ) ? 1 : 0;
    const totalCopied = authCopied + configCopied + rootConfigCopied;
    if (totalCopied > 0) {
      console.log(
        `[migrate] userData migrated from ${legacyDir} -> ${currentUserData} (${totalCopied} file(s))`,
      );
      return { migrated: true, source: legacyDir, files: totalCopied };
    }
  }
  return { migrated: false, source: "", files: 0 };
}

function parseVersionParts(input) {
  const normalized = String(input || "")
    .trim()
    .replace(/^v/i, "");
  if (!normalized) return [0, 0, 0];
  return normalized.split(".").map((part) => {
    const n = Number.parseInt(String(part).replace(/[^\d].*$/, ""), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
}

function compareVersions(a, b) {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const va = Number(pa[i] || 0);
    const vb = Number(pb[i] || 0);
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function isPortableRuntime() {
  return !!String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim()
    || !!String(process.env.PORTABLE_EXECUTABLE_FILE || "").trim();
}

function getAppUpdateMode() {
  if (!app.isPackaged) return "dev";
  if (isPortableRuntime()) return "portable";
  return "installer";
}

// Update preferences: persisted in a JSON file next to updater.log.
// - autoDownload: fetch new installers as soon as they are detected (bandwidth knob).
// Auto-install (overnight) and timed update polling were removed in v2.10.5 —
// the only auto-update activity is the single startup check; install always
// requires an explicit operator click on "Restart & Install".
function _updatePrefsPath() {
  return path.join(app.getPath("userData"), "update-prefs.json");
}
function _readUpdatePrefs() {
  try {
    return JSON.parse(fs.readFileSync(_updatePrefsPath(), "utf8")) || {};
  } catch (_) { return {}; }
}
function _writeUpdatePrefs(patch) {
  const merged = { ..._readUpdatePrefs(), ...patch };
  try {
    fs.writeFileSync(_updatePrefsPath(), JSON.stringify(merged));
  } catch (err) {
    console.warn("[updater] failed to save update preferences:", err.message);
  }
  return merged;
}
function getAutoDownloadPref() {
  return !!_readUpdatePrefs().autoDownload;
}
function setAutoDownloadPref(value) {
  const enabled = !!value;
  _writeUpdatePrefs({ autoDownload: enabled });
  if (autoUpdater) autoUpdater.autoDownload = enabled;
  return enabled;
}
// Overnight auto-install removed in v2.10.5 — install requires explicit
// operator action. These shims keep the preload IPC contract stable.
function getAutoInstallOvernightPref() {
  return false;
}
function setAutoInstallOvernightPref() {
  return false;
}

function buildPublicAppUpdateState() {
  return {
    ...appUpdateState,
    appVersion: app.getVersion(),
    autoDownload: getAutoDownloadPref(),
    autoInstallOvernight: getAutoInstallOvernightPref(),
    channel: UPDATE_CHANNEL,
    channelRequested: UPDATE_CHANNEL_REQUESTED,
    channelFallbackNote: UPDATE_CHANNEL_FALLBACK_NOTE,
    releasesUrl: appUpdateState.releasesUrl
      || `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases`,
    modeLabel:
      appUpdateState.mode === "installer"
        ? (UPDATE_CHANNEL === "beta" ? "Installer (Beta)" : "Installer (Auto)")
        : appUpdateState.mode === "portable"
          ? "Portable (Manual)"
          : appUpdateState.mode === "dev"
            ? "Development"
            : "Unavailable",
  };
}

function setAppUpdateState(patch, broadcast = true) {
  appUpdateState = {
    ...appUpdateState,
    ...patch,
    appVersion: app.getVersion(),
  };
  if (broadcast) broadcastAppUpdateState();
  return buildPublicAppUpdateState();
}

function broadcastAppUpdateState() {
  const payload = buildPublicAppUpdateState();
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.webContents.send("app-update-status", payload);
    } catch (_) {}
  }
}

function requestJsonHttps(url, timeoutMs = UPDATE_CHECK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent": "InverterDashboard-Updater",
      Accept: "application/vnd.github+json",
    };
    if (UPDATE_GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${UPDATE_GITHUB_TOKEN}`;
    }
    const req = https.request(
      url,
      {
        method: "GET",
        headers,
      },
      (res) => {
        const status = Number(res.statusCode || 0);
        let raw = "";
        res.on("data", (chunk) => {
          raw += String(chunk || "");
        });
        res.on("end", () => {
          if (status < 200 || status >= 300) {
            reject(new Error(`GitHub API HTTP ${status}`));
            return;
          }
          try {
            resolve(JSON.parse(raw || "{}"));
          } catch (err) {
            reject(new Error(`Invalid JSON response: ${err.message}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Update check timed out")));
    req.end();
  });
}

function findPortableAssetUrl(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const scored = assets
    .map((asset) => {
      const name = String(asset?.name || "").toLowerCase();
      const url = String(asset?.browser_download_url || "").trim();
      if (!name || !url) return null;
      if (!name.endsWith(".exe")) return null;
      let score = 0;
      if (name.includes("portable")) score += 100;
      if (name.includes("setup")) score -= 25;
      if (name.includes(app.getVersion().split(".")[0])) score += 1;
      return { score, url };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  if (scored.length) return scored[0].url;
  const pageUrl = String(release?.html_url || "").trim();
  return pageUrl || "";
}

async function checkPortableUpdates() {
  const currentVersion = app.getVersion();
  setAppUpdateState({
    mode: "portable",
    status: "checking",
    checking: true,
    message: "Checking for updates...",
    error: "",
  });

  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(UPDATE_REPO_OWNER)}/${encodeURIComponent(UPDATE_REPO_NAME)}/releases/latest`;
  try {
    const release = await requestJsonHttps(apiUrl, UPDATE_CHECK_TIMEOUT_MS);
    const latestVersion = String(release?.tag_name || release?.name || "")
      .trim()
      .replace(/^v/i, "");
    if (!latestVersion) {
      throw new Error("Latest release version is missing.");
    }
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
    const downloadUrl = hasUpdate ? findPortableAssetUrl(release) : "";
    return setAppUpdateState({
      status: hasUpdate ? "update-available" : "up-to-date",
      checking: false,
      checkedAt: Date.now(),
      updateAvailable: hasUpdate,
      latestVersion,
      canDownload: hasUpdate && !!downloadUrl,
      canInstall: false,
      downloadPercent: 0,
      downloadUrl,
      message: hasUpdate
        ? `Update ${latestVersion} is available. Download the new portable EXE.`
        : `You are up to date (${currentVersion}).`,
      error: "",
    });
  } catch (err) {
    return setAppUpdateState({
      status: "error",
      checking: false,
      checkedAt: Date.now(),
      updateAvailable: false,
      canDownload: false,
      canInstall: false,
      downloadPercent: 0,
      downloadUrl: "",
      message: "Update check failed. Please check your internet connection.",
      error: "Update check failed",
    });
  }
}

function bindAutoUpdaterEventsOnce() {
  if (appUpdateBridgeBound) return;
  // v2.8.10 Phase A2: if electron-updater failed to load (corrupt app.asar),
  // autoUpdater is null. Skip binding — the recovery dialog has already been
  // scheduled; there's nothing to wire up here.
  if (!autoUpdater) {
    console.warn("[updater] autoUpdater is null (electron-updater failed to load) — skipping bind");
    return;
  }
  appUpdateBridgeBound = true;

  // Auto-download can be toggled by user from Settings; default off for
  // bandwidth-conscious gateway deployments.
  const autoDownloadPref = getAutoDownloadPref();
  autoUpdater.autoDownload = autoDownloadPref;
  // SAFETY: This dashboard runs 24/7 on a gateway server. Auto-installing on
  // accidental window close would cause an unexpected monitoring outage.
  // Updates only install when the user explicitly clicks "Restart & Install".
  autoUpdater.autoInstallOnAppQuit = false;

  // v2.9.3+: surface GitHub pre-releases as opt-in update prompts. Pre-release
  // tags (e.g. v2.9.4-beta.1) appear to the field as "update available — install?"
  // prompts alongside Latest releases. autoDownload is OFF by default in
  // production (see autoDownloadPref above), so the operator still chooses
  // when to install — this flag only changes VISIBILITY, not auto-install.
  // Required for the GitHub provider configured below to include pre-release
  // tags when querying the releases API; has no effect on the legacy generic
  // feed (which is server-side filtered by GitHub's /releases/latest alias).
  autoUpdater.allowPrerelease = true;

  // Wire electron-updater's logger to a file under userData so we can diagnose
  // auto-update failures in production without needing a console attached.
  try {
    const updaterLogPath = path.join(app.getPath("userData"), "updater.log");
    const updaterLogStream = fs.createWriteStream(updaterLogPath, { flags: "a" });
    const logLine = (level, msg) => {
      try {
        updaterLogStream.write(`[${new Date().toISOString()}] [${level}] ${msg}\n`);
      } catch (_) { /* ignore */ }
      try { console.log(`[updater:${level}]`, msg); } catch (_) { /* ignore */ }
    };
    autoUpdater.logger = {
      info: (m) => logLine("info", String(m)),
      warn: (m) => logLine("warn", String(m)),
      error: (m) => logLine("error", String(m)),
      debug: (m) => logLine("debug", String(m)),
    };
    logLine("info", `autoUpdater logger initialized → ${updaterLogPath}`);
  } catch (err) {
    console.warn("[updater] failed to initialize file logger:", err.message);
  }

  // Override electron-updater's built-in signature verifier.
  //
  // The default verifier runs Get-AuthenticodeSignature via PowerShell and requires
  // Status=Valid. With our self-signed certificate, machines where the root cert is
  // not installed in Trusted Root Certification Authorities return Status=UnknownError,
  // which the built-in verifier treats as a hard failure and reports as
  // "Download failed: Command failed: ...". This breaks auto-update entirely.
  //
  // T6.3 fix (v2.8.8): add a defence-in-depth Authenticode thumbprint check.
  // Primary integrity defence remains the SHA-512 digest published in
  // latest.yml (validated automatically by electron-updater during download).
  // This override extracts the signer thumbprint of the downloaded installer
  // and compares it to EXPECTED_SIGNER_THUMBPRINT.  If a mismatch is detected,
  // we log at ERROR and REJECT the update — a compromised latest.yml that
  // swaps in a binary signed by a different key will no longer be installed.
  // If the check can't be run (PowerShell missing, unexpected error), we fall
  // back to the prior behaviour of logging and accepting (SHA-512 remains
  // authoritative).
  const EXPECTED_SIGNER_THUMBPRINTS = new Set([
    "7A3DE7F937C44A2A7EE1C0B51745EE2189CC0958",
      const psCmd =
        `Get-AuthenticodeSignature -FilePath '${String(tempUpdateFile).replace(/'/g, "''")}' ` +
        `| Select-Object -ExpandProperty SignerCertificate ` +
        `| Select-Object -ExpandProperty Thumbprint`;
      const stdout = await new Promise((resolve) => {
        try {
          execFile(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-Command", psCmd],
            { windowsHide: true, timeout: 15000 },
            (err, out) => resolve(err ? "" : String(out || "")),
          );
        } catch (_) {
          resolve("");
        }
      });
      const actual = stdout.trim().toUpperCase();
      if (!actual) {
        autoUpdater.logger?.warn?.(
          `verifyUpdateCodeSignature: unable to read signer thumbprint — ` +
          `accepting (SHA-512 remains authoritative). file=${tempUpdateFile}`,
        );
        // v2.8.10 Phase B1: remember the verified file path so update-downloaded
        // can stash it under %PROGRAMDATA%\InverterDashboard\updates\ for
        // offline recovery after a torn-write event.
        lastVerifiedInstallerPath = tempUpdateFile;
        return null;
      }
      if (EXPECTED_SIGNER_THUMBPRINTS.has(actual)) {
        autoUpdater.logger?.info?.(
          `verifyUpdateCodeSignature: thumbprint match (${actual}) file=${tempUpdateFile}`,
        lastVerifiedInstallerPath = tempUpdateFile;
        return null;
      }
      const expectedList = Array.from(EXPECTED_SIGNER_THUMBPRINTS).join(", ");
      const msg =
        `verifyUpdateCodeSignature: THUMBPRINT MISMATCH — refusing update.  ` +
      autoUpdater.logger?.error?.(msg);
      return msg;
    } catch (err) {
        `verifyUpdateCodeSignature: check errored — accepting (SHA-512 remains authoritative): ${err?.message || err}`,
      );
      return null;
    }
  };

  autoUpdater.on("checking-for-update", () => {
    setAppUpdateState({
      mode: "installer",
      status: "checking",
      checking: true,
      message: "Checking for updates...",
      error: "",
      canDownload: false,
      canInstall: false,
      downloadPercent: 0,
      downloadUrl: "",
    });
  });

  autoUpdater.on("update-available", (info) => {
    const latestVersion = String(info?.version || "").trim();
    setAppUpdateState({
      mode: "installer",
      status: "update-available",
      checking: false,
      checkedAt: Date.now(),
      updateAvailable: true,
      latestVersion,
      canDownload: true,
      canInstall: false,
      downloadPercent: 0,
      message: `Update ${latestVersion || "available"} found. Click Download Update.`,
      error: "",
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    const latestVersion = String(info?.version || app.getVersion()).trim();
    setAppUpdateState({
      mode: "installer",
      status: "up-to-date",
      checking: false,
      checkedAt: Date.now(),
      updateAvailable: false,
      latestVersion,
      canDownload: false,
      canInstall: false,
      downloadPercent: 0,
      downloadUrl: "",
      message: `You are up to date (${app.getVersion()}).`,
      error: "",
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.max(0, Math.min(100, Number(progress?.percent || 0)));
    setAppUpdateState({
      mode: "installer",
      status: "downloading",
      checking: false,
      updateAvailable: true,
      canDownload: false,
      canInstall: false,
      downloadPercent: percent,
      message: `Downloading update... ${percent.toFixed(1)}%`,
      error: "",
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    const latestVersion = String(info?.version || appUpdateState.latestVersion || "").trim();
    // v2.8.10 Phase B1: stash the verified installer under ProgramData so
    // the recovery dialog can re-run it offline if a torn-write event
    // damages the live install in Program Files.
    try {
      stashLastGoodInstaller(latestVersion);
    } catch (err) {
      console.warn("[main] stashLastGoodInstaller failed:", err?.message || err);
    }
    setAppUpdateState({
      mode: "installer",
      status: "downloaded",
      checking: false,
      checkedAt: Date.now(),
      updateAvailable: true,
      latestVersion,
      canDownload: false,
      canInstall: true,
      downloadPercent: 100,
      message: `Update ${latestVersion || ""} is ready. Click Restart & Install.`,
      error: "",
    });
    // Push update-ready prompt to renderer so a modal can appear
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && win.webContents) {
        win.webContents.send("app-update-ready", {
          version: latestVersion,
          currentVersion: app.getVersion(),
          autoInstallOvernight: false,
        });
      }
    } catch (_) { /* ignore */ }
  });

  autoUpdater.on("error", (err) => {
    const friendly = getUpdateErrorMessage(err);
    setAppUpdateState({
      mode: "installer",
      status: "error",
      checking: false,
      checkedAt: Date.now(),
      canDownload: false,
      canInstall: false,
      message: `Updater error: ${friendly}`,
      error: String(friendly || "Updater error"),
    });
  });
}

// v2.8.10 Phase B1: copy the most recently signature-verified installer to
// %PROGRAMDATA%\InverterDashboard\updates\last-good-installer.exe so the
// Phase A4 recovery dialog can relaunch it without network access. Writes
// atomically via temp + rename to survive an interrupted copy.
function stashLastGoodInstaller(version = "") {
  const src = String(lastVerifiedInstallerPath || "").trim();
  if (!src || !fs.existsSync(src)) {
    console.warn("[main] stashLastGoodInstaller: no verified installer path recorded");
    return false;
  }
  const updatesDir = path.join(PROGRAMDATA_DIR, "updates");
  try { fs.mkdirSync(updatesDir, { recursive: true }); } catch (_) { /* ignore */ }
  const targetPath = path.join(updatesDir, "last-good-installer.exe");
  const tempPath = path.join(updatesDir, `last-good-installer.exe.tmp-${process.pid}`);
  try {
    fs.copyFileSync(src, tempPath);
    try { fs.unlinkSync(targetPath); } catch (_) { /* ignore missing */ }
    fs.renameSync(tempPath, targetPath);
    const metaPath = targetPath + ".meta.json";
    const meta = {
      version: String(version || "").trim(),
      source: src,
      copiedAt: new Date().toISOString(),
      size: fs.statSync(targetPath).size,
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
    console.log(`[main] Stashed last-good-installer (${meta.size} bytes) at ${targetPath}`);
    return true;
  } catch (err) {
    console.warn("[main] stashLastGoodInstaller copy failed:", err?.message || err);
    try { fs.unlinkSync(tempPath); } catch (_) { /* ignore */ }
    return false;
  }
}

function initAppUpdater() {
  const mode = getAppUpdateMode();
  if (mode === "installer") {
    bindAutoUpdaterEventsOnce();
    // v2.8.10 Phase A2: bindAutoUpdaterEventsOnce silently no-ops when
    // autoUpdater failed to load. Mirror that here so a null autoUpdater
    // after a corrupt electron-updater load can't throw inside setFeedURL.
    if (!autoUpdater) {
      setAppUpdateState({
        mode,
        channel: UPDATE_CHANNEL,
        status: "error",
        message: "Updater unavailable — electron-updater failed to load.",
        error: "updater-unavailable",
      });
      return;
    }
    try {
      // v2.9.3+: prefer the GitHub provider so pre-release tags can surface
      // (autoUpdater.allowPrerelease=true above). The legacy /releases/latest
      // /download URL is server-side filtered by GitHub and would never
      // expose pre-releases regardless of the flag, so the GitHub provider
      // is the only path that honors allowPrerelease for our public repo.
      //
      // Backward-compat: if a deployment explicitly sets ADSI_UPDATE_FEED_URL
      // (e.g. a beta channel pointing at a per-tag asset directory, or an
      // air-gapped mirror), keep the generic provider with that URL.
      const explicitFeed = String(process.env.ADSI_UPDATE_FEED_URL || "").trim();
      if (explicitFeed) {
        autoUpdater.setFeedURL({
          provider: "generic",
          url: UPDATE_FEED_URL,
        });
        console.log(`[updater] Generic feed URL (${UPDATE_CHANNEL} channel):`, UPDATE_FEED_URL);
      } else {
        autoUpdater.setFeedURL({
          provider: "github",
          owner: UPDATE_REPO_OWNER,
          repo: UPDATE_REPO_NAME,
        });
        console.log(
          `[updater] GitHub provider: ${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME} ` +
          `(allowPrerelease=${autoUpdater.allowPrerelease})`,
        );
      }
    } catch (err) {
      console.warn("[updater] setFeedURL failed:", err.message);
    }
    setAppUpdateState({
      mode,
      channel: UPDATE_CHANNEL,
      status: "idle",
      checking: false,
      updateAvailable: false,
      latestVersion: "",
      downloadPercent: 0,
      canDownload: false,
      canInstall: false,
      downloadUrl: "",
      message: UPDATE_CHANNEL === "beta"
        ? "Installer update channel ready (BETA)."
        : "Installer update channel ready (pre-releases visible as opt-in).",
      error: "",
    }, false);
    return;
  }
  if (mode === "portable") {
    setAppUpdateState({
      mode,
      status: "idle",
      checking: false,
      updateAvailable: false,
      latestVersion: "",
      downloadPercent: 0,
      canDownload: false,
      canInstall: false,
      downloadUrl: "",
      message: "Portable mode uses manual download updates.",
      error: "",
    }, false);
    return;
  }
  setAppUpdateState({
    mode,
    status: "disabled",
    checking: false,
    updateAvailable: false,
    latestVersion: "",
    downloadPercent: 0,
    canDownload: false,
    canInstall: false,
    downloadUrl: "",
    message: "Update checks are disabled in development mode.",
    error: "",
  }, false);
}

async function checkForAppUpdates(options = {}) {
  const mode = getAppUpdateMode();
  const manual = !!options?.manual;
  if (mode === "dev") {
    return setAppUpdateState({
      mode,
      status: "disabled",
      checking: false,
      message: "Update checks are disabled in development mode.",
      error: "",
    });
  }
  if (appUpdateState.checking) {
    return buildPublicAppUpdateState();
  }
  if (mode === "portable") {
    return checkPortableUpdates();
  }
  if (mode !== "installer") {
    return setAppUpdateState({
      mode: "disabled",
      status: "disabled",
      checking: false,
      message: "Updater is unavailable for this runtime.",
      error: "",
    });
  }

  bindAutoUpdaterEventsOnce();
  if (!autoUpdater) {
    return setAppUpdateState({
      mode: "installer",
      status: "error",
      checking: false,
      checkedAt: Date.now(),
      message: "Updater unavailable — electron-updater failed to load.",
      error: "updater-unavailable",
      canDownload: false,
      canInstall: false,
    });
  }
  try {
    if (manual) {
      setAppUpdateState({
        mode: "installer",
        status: "checking",
        checking: true,
        message: "Checking for updates...",
        error: "",
      });
    }
    await autoUpdater.checkForUpdates();
    return buildPublicAppUpdateState();
  } catch (err) {
    const friendly = getUpdateErrorMessage(err);
    return setAppUpdateState({
      mode: "installer",
      status: "error",
      checking: false,
      checkedAt: Date.now(),
      message: `Update check failed: ${friendly}`,
      error: String(friendly || "Update check failed"),
      canDownload: false,
      canInstall: false,
    });
  }
}

async function downloadAppUpdate() {
  const mode = getAppUpdateMode();
  if (mode === "portable") {
    let url = String(appUpdateState.downloadUrl || "").trim();
    if (!url) {
      await checkPortableUpdates();
      url = String(appUpdateState.downloadUrl || "").trim();
    }
    if (!url) {
      return { ok: false, error: "No download URL found for latest portable release.", state: buildPublicAppUpdateState() };
    }
    // T6.5 fix: whitelist before handing off to the OS, even though the
    // URL comes from appUpdateState (our own release feed).  Defence in
    // depth against a compromised update feed or stale state entry.
    if (!isSafeExternalUrl(url)) {
      return { ok: false, error: "Refusing to open non-http update URL.", state: buildPublicAppUpdateState() };
    }
    try {
      await shell.openExternal(url);
      setAppUpdateState({
        mode: "portable",
        message: "Opened latest release download page.",
      });
      return { ok: true, state: buildPublicAppUpdateState(), openedUrl: url };
    } catch (err) {
      setAppUpdateState({
        mode: "portable",
        status: "error",
        message: `Unable to open download URL: ${err.message}`,
        error: String(err.message || "Unable to open download URL"),
      });
      return { ok: false, error: err.message, state: buildPublicAppUpdateState() };
    }
  }

  if (mode !== "installer") {
    return { ok: false, error: "Updater is unavailable in this runtime mode.", state: buildPublicAppUpdateState() };
  }
  if (!appUpdateState.updateAvailable) {
    return { ok: false, error: "No update is available to download.", state: buildPublicAppUpdateState() };
  }
  if (appUpdateState.canInstall) {
    return { ok: true, state: buildPublicAppUpdateState() };
  }
  if (!autoUpdater) {
    return { ok: false, error: "Updater unavailable — electron-updater failed to load.", state: buildPublicAppUpdateState() };
  }
  try {
    setAppUpdateState({
      mode: "installer",
      status: "downloading",
      checking: false,
      canDownload: false,
      canInstall: false,
      downloadPercent: 0,
      message: "Downloading update...",
      error: "",
    });
    await autoUpdater.downloadUpdate();
    return { ok: true, state: buildPublicAppUpdateState() };
  } catch (err) {
    setAppUpdateState({
      mode: "installer",
      status: "error",
      checking: false,
      canDownload: false,
      canInstall: false,
      message: `Download failed: ${err.message}`,
      error: String(err.message || "Download failed"),
    });
    return { ok: false, error: err.message, state: buildPublicAppUpdateState() };
  }
}

async function installAppUpdateNow() {
  const mode = getAppUpdateMode();
  if (mode !== "installer") {
    return { ok: false, error: "Install is only available for installer builds.", state: buildPublicAppUpdateState() };
  }
  if (!appUpdateState.canInstall) {
    return { ok: false, error: "No downloaded update is ready to install.", state: buildPublicAppUpdateState() };
  }
  setAppUpdateState({
    mode: "installer",
    status: "installing",
    message: "Restarting app to install update...",
    checking: false,
  });
  requestAppShutdown({
    reason: "install downloaded update",
    action: { type: "install" },
  }).catch((err) => {
    setAppUpdateState({
      mode: "installer",
      status: "error",
      message: `Install failed: ${err.message}`,
      error: String(err.message || "Install failed"),
    });
  });
  return { ok: true, state: buildPublicAppUpdateState() };
}

// v2.10.5 — auto-update polling and overnight auto-install were removed.
// The only auto-update activity is the single startup check below; download
// is gated by the autoDownload pref and install always requires an explicit
// operator click on "Restart & Install". This eliminates the late-evening
// download/install timer as a possible contributor to overnight crashes.
function scheduleAutoUpdateCheck() {
  if (appUpdateAutoCheckStarted) return;
  appUpdateAutoCheckStarted = true;
  const mode = getAppUpdateMode();
  if (mode === "dev") return;
  // One-shot check 8 s after startup. No re-arm.
  appUpdateAutoCheckTimer = setTimeout(() => {
    appUpdateAutoCheckTimer = null;
    checkForAppUpdates({ manual: false }).catch((err) => {
      console.warn("[updater] startup update check failed:", err.message);
    });
  }, 8000);
  if (appUpdateAutoCheckTimer && typeof appUpdateAutoCheckTimer.unref === "function") {
    appUpdateAutoCheckTimer.unref();
  }
}

function getUpdateErrorMessage(err) {
  const raw = String(err?.message || err || "Update check failed");
  const lower = raw.toLowerCase();
  const has404 = lower.includes(" 404") || lower.includes("http 404") || lower.includes("status code 404");
  const feedBlocked = lower.includes("releases.atom") || lower.includes("latest.yml") || lower.includes("/releases/latest/download");
  // Signature / publisher mismatch — usually means the gateway is missing the
  // root cert, or the publisher in the new build doesn't match the installed app's expectation.
  if (lower.includes("err_updater_invalid_signature") || lower.includes("not signed by the application owner")) {
    return "Code signature verification failed. The new build's publisher does not match the installed version. Check that the gateway has the codesign root certificate installed.";
  }
  if (lower.includes("certificate") && (lower.includes("invalid") || lower.includes("untrusted") || lower.includes("not trusted"))) {
    return "Update certificate is not trusted on this machine. Install the codesign root certificate to Trusted Root Certification Authorities and try again.";
  }
  if (has404 && feedBlocked) {
    return "Update feed returned 404. Ensure the release channel is reachable and has published assets.";
  }
  if (has404) {
    return "Update feed returned 404. Verify release assets are published.";
  }
  /* Strip URLs / repo identifiers from raw error to avoid leaking internal paths */
  return raw.replace(/https?:\/\/[^\s)]+/gi, "").replace(/\s{2,}/g, " ").trim() || "Update check failed";
}

function normalizeAppShutdownAction(action) {
  const type = String(action?.type || "quit").trim().toLowerCase();
  if (type === "install") return { type: "install", exitCode: 0 };
  if (type === "relaunch") return { type: "relaunch", exitCode: 0 };
  if (type === "exit") {
    const exitCode = Number.isInteger(action?.exitCode) ? action.exitCode : 0;
    return { type: "exit", exitCode };
  }
  return { type: "quit", exitCode: 0 };
}

function getAppShutdownActionRank(action) {
  const type = String(action?.type || "quit");
  if (type === "install") return 4;
  if (type === "relaunch") return 3;
  if (type === "exit") return 2;
  return 1;
}

function mergeAppShutdownAction(nextAction) {
  const next = normalizeAppShutdownAction(nextAction);
  if (getAppShutdownActionRank(next) >= getAppShutdownActionRank(appShutdownFinalAction)) {
    appShutdownFinalAction = next;
  }
  return appShutdownFinalAction;
}

function normalizeSoftStopServiceName(serviceName) {
  return String(serviceName || "").trim().toLowerCase() === "forecast"
    ? "forecast"
    : "backend";
}

function getRuntimeControlDir() {
  let baseDir = "";
  try {
    baseDir = app.getPath("userData");
  } catch (_) {
    baseDir = "";
  }
  if (!baseDir) {
    baseDir = PORTABLE_DATA_DIR || process.cwd();
  }
  return path.join(baseDir, "runtime-control");
}

function getServiceSoftStopFile(serviceName) {
  const normalized = normalizeSoftStopServiceName(serviceName);
  return path.join(
    getRuntimeControlDir(),
    SERVICE_SOFT_STOP_FILE_NAMES[normalized],
  );
}

function clearServiceSoftStopFile(stopFilePath) {
  const filePath = String(stopFilePath || "").trim();
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch (err) {
    console.warn("[main] Failed to clear service stop file:", filePath, err.message);
  }
}

function writeServiceSoftStopFile(stopFilePath, label, reason = "shutdown requested") {
  const filePath = String(stopFilePath || "").trim();
  if (!filePath) return false;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          label: String(label || "service"),
          reason: String(reason || "shutdown requested"),
          requestedAt: Date.now(),
          pid: process.pid,
        },
        null,
        2,
      ),
      "utf8",
    );
    return true;
  } catch (err) {
    console.warn("[main] Failed to write service stop file:", filePath, err.message);
    return false;
  }
}

function attachServiceSoftStopMeta(proc, serviceName, waitMs) {
  if (!proc) return proc;
  proc._softStopFile = getServiceSoftStopFile(serviceName);
  proc._softStopWaitMs = Math.max(0, Number(waitMs || 0));
  clearServiceSoftStopFile(proc._softStopFile);
  return proc;
}

function waitForChildExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    if (
      !proc ||
      proc.killed ||
      proc.exitCode !== null ||
      proc.signalCode !== null
    ) {
      resolve(true);
      return;
    }
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      try {
        proc.removeListener("exit", onExit);
      } catch (_) {}
      clearTimeout(timer);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    proc.once("exit", onExit);
  });
}

async function stopTrackedProcess(proc, label) {
  if (!proc || proc.killed) return;
  const softStopFile = String(proc._softStopFile || "").trim();
  const softStopWaitMs = Math.max(0, Number(proc._softStopWaitMs || 0));
  if (softStopFile && writeServiceSoftStopFile(softStopFile, label, "app shutdown")) {
    const exitedSoft = await waitForChildExit(proc, softStopWaitMs);
    clearServiceSoftStopFile(softStopFile);
    if (exitedSoft) return;
    console.warn(
      `[main] ${label} did not exit within ${softStopWaitMs}ms after soft-stop; forcing exit`,
    );
  }
  forceKillProc(proc, label);
  const exited = await waitForChildExit(proc, APP_SHUTDOWN_FORCE_KILL_WAIT_MS);
  clearServiceSoftStopFile(softStopFile);
  if (!exited) {
    console.warn(`[main] ${label} did not exit within ${APP_SHUTDOWN_FORCE_KILL_WAIT_MS}ms`);
  }
}

async function shutdownEmbeddedServerGracefully(serverModule) {
  if (!serverModule || typeof serverModule.shutdownEmbedded !== "function") return;
  let shutdownPromise;
  try {
    shutdownPromise = Promise.resolve(serverModule.shutdownEmbedded());
  } catch (err) {
    console.warn("[main] embedded web server shutdown failed:", err.message);
    return;
  }
  let timeoutId = null;
  const outcome = await Promise.race([
    shutdownPromise
      .then(() => "done")
      .catch((err) => {
        console.warn("[main] embedded web server shutdown failed:", err.message);
        return "done";
      }),
    new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), APP_SHUTDOWN_WEB_TIMEOUT_MS);
      if (timeoutId && typeof timeoutId.unref === "function") timeoutId.unref();
    }),
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  if (outcome === "timeout") {
    console.warn(`[main] embedded web server shutdown timed out after ${APP_SHUTDOWN_WEB_TIMEOUT_MS}ms`);
  }
}

async function shutdownChildWebServerGracefully(proc) {
  if (!proc || proc.killed) return;
  try {
    proc.send({ type: "shutdown" });
  } catch (_) {}
  const exited = await waitForChildExit(proc, APP_SHUTDOWN_WEB_TIMEOUT_MS);
  if (exited) return;
  console.warn(`[main] web-server shutdown timed out after ${APP_SHUTDOWN_WEB_TIMEOUT_MS}ms; forcing exit`);
  forceKillProc(proc, "web-server");
  await waitForChildExit(proc, APP_SHUTDOWN_FORCE_KILL_WAIT_MS);
}

async function stopRuntimeServices(reason = "application shutdown") {
  isAppShuttingDown = true;
  allowMainWindowClose = true;
  // A tray icon is only meaningful while this Electron process owns the
  // background lifecycle. Remove it before shutdown so Windows cannot retain
  // a stale recovery entry after the dashboard exits.
  destroyBackgroundTray();
  try { await closeHikvisionNativeViewer({ reason }); } catch (_) {}
  try { await hikvisionNativePlayer.stop(); } catch (_) {}
  // Destroy any open pop-out windows gracefully before tearing down services.
  for (const [, win] of popoutWindows) {
    try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
  }
  popoutWindows.clear();
  stopForecastModeSync();
  clearForecastRestartTimer();
  if (appUpdateAutoCheckTimer) {
    clearTimeout(appUpdateAutoCheckTimer);
    appUpdateAutoCheckTimer = null;
  }
  if (licenseCheckerTimer) {
    clearInterval(licenseCheckerTimer);
    licenseCheckerTimer = null;
  }

  const embeddedModule = embeddedServerStarted ? embeddedServerModule : null;
  const childWebProc = webProc;
  const backend = backendProc;
  const forecast = forecastProc;

  embeddedServerStarted = false;
  embeddedServerModule = null;
  webProc = null;
  backendProc = null;
  forecastProc = null;
  backendStopExpected = true;
  forecastStopExpected = true;

  const tasks = [];
  if (backend && !backend.killed) tasks.push(stopTrackedProcess(backend, "backend"));
  if (forecast && !forecast.killed) tasks.push(stopTrackedProcess(forecast, "forecast"));
  if (embeddedModule && typeof embeddedModule.shutdownEmbedded === "function") {
    tasks.push(shutdownEmbeddedServerGracefully(embeddedModule));
  }
  if (childWebProc && !childWebProc.killed) {
    tasks.push(shutdownChildWebServerGracefully(childWebProc));
  }

  if (!tasks.length) return;
  console.log(`[main] Stopping runtime services (${reason})...`);
  await Promise.allSettled(tasks);
}

// Stop the authenticated operator-controlled local stack without changing the
// Electron application's own shutdown state. This must include the embedded
// gateway: stopping only Python children left :3500 serving stale UI and made
// the lifecycle card contradict the Stop action.
async function stopLocalServerServices() {
  // A manual Stop is authoritative. Leaving this interval active would let it
  // respawn the forecast worker on its next mode check after the operator had
  // explicitly stopped the local stack.
  stopForecastModeSync();
  clearBackendRestartTimer();
  clearForecastRestartTimer();

  const embeddedModule = embeddedServerStarted ? embeddedServerModule : null;
  const childWebProc = webProc;
  const backend = backendProc;
  const forecast = forecastProc;

  embeddedServerStarted = false;
  embeddedServerModule = null;
  webProc = null;
  backendProc = null;
  forecastProc = null;
  backendStopExpected = true;
  forecastStopExpected = true;
  serverReadyFired = false;

  const tasks = [];
  if (backend && !backend.killed) tasks.push(stopTrackedProcess(backend, "backend"));
  if (forecast && !forecast.killed) tasks.push(stopTrackedProcess(forecast, "forecast"));
  if (embeddedModule && typeof embeddedModule.shutdownEmbedded === "function") {
    tasks.push(shutdownEmbeddedServerGracefully(embeddedModule));
  }
  if (childWebProc && !childWebProc.killed) {
    tasks.push(shutdownChildWebServerGracefully(childWebProc));
  }
  // Optional camera workers are part of the local gateway process tree when
  // configured. Stop them here instead of relying on each caller to remember
  // a second shutdown path.
  tasks.push(stopAuxiliaryGatewayServices());
  await Promise.allSettled(tasks);

  // shutdownEmbedded closes the HTTP listener and DB-owned handles. A later
  // Start must require fresh server modules rather than reusing a closed one.
  clearServerModuleCache();
  embeddedServerModule = null;
  serverBootError = "";
  destroyBackgroundTray();
}

function readAuxiliaryGatewayServiceStatus() {
  const status = {
    go2rtc: { running: false, status: "stopped" },
    hikvision: { running: false, status: "stopped" },
  };
  try {
    const manager = require("../server/go2rtcManager");
    const current = manager?.getStatus?.();
    if (current && typeof current === "object") status.go2rtc = current;
  } catch (_) {}
  try {
    const manager = require("../server/hikvisionManager");
    const current = manager?.getStatus?.();
    if (current && typeof current === "object") status.hikvision = current;
  } catch (_) {}
  return status;
}

async function stopAuxiliaryGatewayServices() {
  const tasks = [];
  try {
    const manager = require("../server/go2rtcManager");
    if (manager?.stop) tasks.push(Promise.resolve(manager.stop()));
  } catch (_) {}
  try {
    const manager = require("../server/hikvisionManager");
    if (manager?.stop) tasks.push(Promise.resolve(manager.stop()));
  } catch (_) {}
  await Promise.allSettled(tasks);
}

function finalizeAppShutdown() {
  _appShutdownFinalized = true;   // disarm the hard-ceiling watchdog
  appShutdownBypassQuit = true;
  allowMainWindowClose = true;
  const action = normalizeAppShutdownAction(appShutdownFinalAction);
  if (action.type === "install") {
    // SAFETY GUARD: Confirm Python services are fully stopped before launching
    // the installer. The installer will overwrite dist/ForecastCoreService.exe
    // and dist/InverterCoreService.exe — if either subprocess still holds the
    // file handle, the install will fail and leave the app in a broken state.
    finalizeInstallShutdown().catch((err) => {
      console.error("[main] Install shutdown sequence failed:", err?.message || err);
      app.exit(1);
    });
    return;
  }
  if (action.type === "relaunch") {
    app.relaunch();
    app.quit();
    return;
  }
  if (action.type === "exit") {
    app.exit(action.exitCode || 0);
    return;
  }
  app.quit();
}

// Polls for a process to actually exit. Returns true if the process is gone
// within timeoutMs, false otherwise. Used during install shutdown to ensure
// Python service file handles are released before the installer overwrites
// dist/*.exe.
function waitForProcessGone(proc, label, timeoutMs = 3000, pollMs = 200) {
  return new Promise((resolve) => {
    if (!proc || proc.killed || proc.exitCode !== null) {
      resolve(true);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      if (!proc || proc.killed || proc.exitCode !== null) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        console.warn(`[main] ${label} still running after ${timeoutMs}ms wait`);
        resolve(false);
      }
    }, pollMs);
  });
}

async function finalizeInstallShutdown() {
  const lingering = [];
  if (backendProc && !backendProc.killed) lingering.push("backend");
  if (forecastProc && !forecastProc.killed) lingering.push("forecast");

  if (lingering.length) {
    console.warn(
      "[main] Lingering Python services before install:",
      lingering.join(", "),
      "- forcing kill before quitAndInstall",
    );
    if (backendProc && !backendProc.killed) {
      try { forceKillProc(backendProc, "backend"); } catch (_) {}
    }
    if (forecastProc && !forecastProc.killed) {
      try { forceKillProc(forecastProc, "forecast"); } catch (_) {}
    }

    // Wait until the OS confirms the processes have actually exited.
    // taskkill is async — its callback fires before the kernel finishes
    // releasing handles. We poll until the child reports exitCode/killed.
    const waits = [];
    if (backendProc) waits.push(waitForProcessGone(backendProc, "backend", 4000));
    if (forecastProc) waits.push(waitForProcessGone(forecastProc, "forecast", 4000));
    const results = await Promise.all(waits);
    const allGone = results.every(Boolean);
    if (!allGone) {
      console.warn("[main] Some Python services did not confirm exit; install may fail");
    }
  }

  // Additional grace period for the OS to fully release file handles
  // (NTFS handle release can lag a few hundred ms after process exit).
  await new Promise((resolve) => setTimeout(resolve, 1500));

  if (!autoUpdater) {
    console.error("[main] autoUpdater null at quitAndInstall — aborting");
    app.exit(1);
    return;
  }
  try {
    console.log("[main] Launching quitAndInstall now (silent, forceRunAfter)");
    // isSilent=true → NSIS runs unattended (no wizard), matches oneClick:true config.
    // isForceRunAfter=true → relaunch app automatically after install completes.
    autoUpdater.quitAndInstall(true, true);
  } catch (err) {
    console.error("[main] quitAndInstall failed:", err.message);
    setAppUpdateState({
      status: "error",
      message: `Install failed: ${err.message}`,
      error: String(err.message || "Install failed"),
      canInstall: false,
    });
    app.exit(1);
  }
}

// Best-effort classification of requestAppShutdown input into the shutdown-
// reason taxonomy. Used only if the caller didn't already record a more
// specific reason via recordShutdownReasonOnce().
function _classifyShutdownForMarker(reasonString, action) {
  const r = String(reasonString || "").toLowerCase();
  const actionType = String(action?.type || "").toLowerCase();
  if (actionType === "install") {
    return { reason: SHUTDOWN_REASONS.INSTALL_UPDATE, initiator: SHUTDOWN_INITIATORS.AUTO_UPDATER };
  }
  if (actionType === "relaunch") {
    return { reason: SHUTDOWN_REASONS.RELAUNCH, initiator: SHUTDOWN_INITIATORS.RUNTIME };
  }
  if (r.includes("session-end")) {
    return { reason: SHUTDOWN_REASONS.SESSION_END, initiator: SHUTDOWN_INITIATORS.WINDOWS_OS };
  }
  if (r.includes("power") && r.includes("shutdown")) {
    return { reason: SHUTDOWN_REASONS.POWER_SHUTDOWN, initiator: SHUTDOWN_INITIATORS.WINDOWS_OS };
  }
  if (r.includes("license")) {
    return { reason: SHUTDOWN_REASONS.LICENSE_EXPIRED, initiator: SHUTDOWN_INITIATORS.RUNTIME };
  }
  return { reason: SHUTDOWN_REASONS.BEFORE_QUIT, initiator: SHUTDOWN_INITIATORS.USER };
}

function requestAppShutdown(options = {}) {
  const reason = String(options?.reason || "application shutdown").trim() || "application shutdown";
  mergeAppShutdownAction(options?.action);
  // Record a shutdown-reason marker as early as possible. If Windows
  // force-kills us mid-shutdown, the marker is still on disk for diagnostics.
  // First-write-wins via recordShutdownReasonOnce; specific callers
  // (session-end, powerMonitor) record their own reason before calling in.
  const classified = _classifyShutdownForMarker(reason, options?.action);
  recordShutdownReasonOnce(classified.reason, {
    initiator: classified.initiator,
    extra: { requestReason: reason, actionType: options?.action?.type || "quit" },
  });
  if (appShutdownPromise) return appShutdownPromise;
  console.log(`[main] Shutdown requested (${reason})`);
  // Hard-ceiling watchdog: a non-resolving promise inside the drain must
  // never leave the app hung. A hung app gets force-killed (operator Task
  // Manager, OS shutdown-timeout, or release tooling's taskkill) via
  // TerminateProcess, which skips process 'exit' and leaves no shutdown
  // marker → the next boot false-flags "Unexpected prior shutdown". Self-
  // exiting via app.exit() instead runs the 'exit'/'quit' fallback writer,
  // so the marker is always persisted. unref() so the timer itself never
  // keeps the process alive; finalizeAppShutdown() disarms it for the
  // legitimately-longer install/relaunch paths.
  const _watchdog = setTimeout(() => {
    if (_appShutdownFinalized) return;
    try {
      console.error(
        `[main] Shutdown drain exceeded ${APP_SHUTDOWN_HARD_CEILING_MS}ms ` +
        `(reason=${reason}) — forcing app.exit() so the graceful marker is ` +
        `recorded by the process-exit fallback instead of being lost to a kill.`,
      );
    } catch (_) {}
    _appShutdownFinalized = true;
    appShutdownBypassQuit = true;
    try {
      const action = normalizeAppShutdownAction(appShutdownFinalAction);
      app.exit(action && action.type === "exit" ? action.exitCode || 0 : 0);
    } catch (_) {
      app.exit(0);
    }
  }, APP_SHUTDOWN_HARD_CEILING_MS);
  if (_watchdog && typeof _watchdog.unref === "function") _watchdog.unref();
  appShutdownPromise = stopRuntimeServices(reason)
    .catch((err) => {
      console.error("[main] Shutdown sequence failed:", err?.message || err);
    })
    .finally(() => {
      try { clearTimeout(_watchdog); } catch (_) {}
      finalizeAppShutdown();
    });
  return appShutdownPromise;
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Standalone Field Calibrator: skip the entire dashboard boot (license,
  // login, Express :3500, Python :9000, fleet UI) and bring up ONLY the
  // calibrator stack. Returns early so none of the dashboard lifecycle runs.
  if (CALIBRATOR_STANDALONE) {
    await startCalibratorStandalone();
    return;
  }

  if (process.platform === "win32") {
    app.setAppUserModelId("com.inverter.dashboard");
  }
  app.setName("Inverter Dashboard");

  // v2.8.14 — powerMonitor handlers for OS-level shutdown / suspend / resume.
  // powerMonitor requires app-ready, so it's bound here rather than at top.
  // `shutdown` is the ACPI signal fired when Windows is about to power off
  // or reboot; it is complementary to session-end and fires a bit earlier
  // on some Windows editions.
  try {
    const { powerMonitor } = require("electron");
    if (powerMonitor && typeof powerMonitor.on === "function") {
      powerMonitor.on("shutdown", () => {
        try { console.warn("[main] powerMonitor.shutdown received"); } catch (_) {}
        recordShutdownReasonOnce(SHUTDOWN_REASONS.POWER_SHUTDOWN, {
          initiator: SHUTDOWN_INITIATORS.WINDOWS_OS,
          extra: { source: "powerMonitor" },
        });
        appShutdownBypassQuit = true;
        try {
          requestAppShutdown({
            reason: "powerMonitor-shutdown",
            action: { type: "quit" },
          }).catch(() => { /* already logged */ });
        } catch (_) {}
      });
      // Suspend is NOT a shutdown — but we record it so that if the machine
      // is later power-cycled from sleep without resuming cleanly, the banner
      // can surface "prior shutdown followed a suspend at 22:04" and the
      // operator knows to check the UPS / power rail.
      powerMonitor.on("suspend", () => {
        try { console.log("[main] powerMonitor.suspend — recording advisory marker"); } catch (_) {}
        // Use a lower-severity reason and DO NOT set _shutdownReasonRecorded
        // so a later session-end can still overwrite with the authoritative
        // shutdown reason. We reach around recordShutdownReasonOnce here.
        try {
          _shutdownReason.recordShutdownReasonSync(SHUTDOWN_REASONS.POWER_SUSPEND, {
            initiator: SHUTDOWN_INITIATORS.WINDOWS_OS,
            extra: { advisory: true, source: "powerMonitor" },
          });
        } catch (_) {}
      });
      powerMonitor.on("resume", () => {
        try { console.log("[main] powerMonitor.resume — machine woke from suspend"); } catch (_) {}
      });
      console.log("[main] powerMonitor shutdown/suspend/resume handlers registered");
    } else {
      console.warn("[main] powerMonitor not available — OS shutdown detection disabled");
    }
  } catch (err) {
    console.warn("[main] powerMonitor wiring failed:", err?.message || err);
  }

  writeBootLog("step 1: initAppUpdater");
  initAppUpdater();
  // Remove default app menu (File/Edit/View/Window/Help) while keeping native window chrome.
  Menu.setApplicationMenu(null);
  writeBootLog("step 2: showLoginWindow");
  showLoginWindow();
  writeBootLog("step 3: showLoginWindow called");
});

app.on("window-all-closed", () => {
  // Standalone calibrator: the calibratorWin "closed" handler already called
  // terminateCalibratorProcesses(). Re-assert (idempotent) and exit directly
  // — there is no dashboard server to drain, so the heavy quit() path would
  // only hang on a :3500 that was never started. Short delay lets the
  // child SIGTERMs land before the process goes away.
  if (CALIBRATOR_STANDALONE) {
    try { terminateCalibratorProcesses(); } catch (_) {}
    setTimeout(() => app.exit(0), 600);
    return;
  }
  // Prevent premature exit during login -> loading -> main window transition
  if (hasAuthenticated && !mainWin && !isAppShuttingDown) {
    return;
  }
  const srvCfg = loadServerServiceConfig();
  if (srvCfg.keepInBackground && isLocalServerRunning()) {
    console.log("[main] Window closed but server is configured to keep running in background.");
    return;
  }
  if (process.platform !== "darwin") quit();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length !== 0) return;
  const status = buildLicensePublicStatus();
  if (!status.valid) {
    const ok = await ensureLicenseAtStartup();
    if (!ok) {
      recordEarlyExitMarker(
        SHUTDOWN_REASONS.BEFORE_QUIT,
        SHUTDOWN_INITIATORS.USER,
        { earlyExitPath: "license-activate-cancel" },
      );
      app.exit(0);
      return;
    }
  }
  startLicenseChecker();
  if (!hasAuthenticated) {
    showLoginWindow();
    return;
  }
  if (serverReadyFired) createMainWindow();
  else if (bootStarted) showLoadingWindow();
});

app.on("before-quit", (event) => {
  if (appShutdownBypassQuit) return;
  event.preventDefault();
  requestAppShutdown({
    reason: "before-quit",
    action: { type: "quit" },
  }).catch((err) => {
    console.error("[main] before-quit shutdown failed:", err?.message || err);
    appShutdownBypassQuit = true;
    app.exit(1);
  });
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// ─── Last-resort graceful-shutdown marker ─────────────────────────────────────
//
// Forensic evidence (shutdown-reason.prev.json showing reason="unexpected-
// shutdown" while the boot-sentinel was present) proved the prior process
// ended with NO shutdown-reason.current.json on disk. requestAppShutdown()
// writes that marker synchronously as its FIRST action, so its absence means
// requestAppShutdown() never ran for that process — it exited through a path
// with no Electron/Node lifecycle handler (a hung-then-force-killed quit, a
// build-tool taskkill of the running app, a relaunch chain that skipped the
// normal quit, or an early-exit not covered by recordEarlyExitMarker()).
// Every such path STILL fires Node's `process 'exit'` (and Electron's app
// 'quit') because the JS runtime got to terminate itself. Only genuinely
// uncatchable terminations — TerminateProcess/kill -9, BSOD, power loss,
// native abort — skip these events, and those SHOULD remain classified
// "unexpected". So this is the correct, complete safety net: it converts
// "the app actually exited cleanly but some path forgot to record a reason"
// into a graceful marker, while leaving real crashes correctly flagged.
//
// recordShutdownReasonOnce() is first-write-wins (guarded by
// _shutdownReasonRecorded), so this NEVER clobbers a more specific reason
// already recorded by before-quit / session-end / powerMonitor / install /
// relaunch / uncaught-exception. It only fills the gap when nothing else did.
// The writer is fully synchronous (fs.writeFileSync + renameSync) — the only
// kind of work permitted in a 'process exit' handler — and is internally
// try/caught so it can never throw out of the exit path.
function recordProcessExitFallbackMarker(via) {
  // Only the lifecycle-marker owner may write. A losing second instance
  // (app.exit(0) at the singleton-lock check) must leave the running first
  // instance's sentinel/marker untouched — otherwise its exit here would
  // plant a `current` marker that hides a subsequent first-instance crash.
  if (!_ownsLifecycleMarkers) return;
  if (_shutdownReasonRecorded) return;
  // Strictly additive: never overwrite a reason already on disk. The
  // uncaughtException (line ~62) and powerMonitor.suspend handlers write
  // `current` via the RAW writer WITHOUT flipping _shutdownReasonRecorded,
  // so the flag check alone is not enough — re-check the file so a real
  // main-process crash keeps its "uncaught-exception" forensic record
  // instead of being relabelled "process-exit".
  try {
    const cur = _shutdownReason.PATHS && _shutdownReason.PATHS.current;
    if (cur && fs.existsSync(cur)) return;
  } catch (_) { /* fall through — recording is better than nothing */ }
  recordShutdownReasonOnce(SHUTDOWN_REASONS.PROCESS_EXIT, {
    initiator: SHUTDOWN_INITIATORS.RUNTIME,
    extra: { via: String(via || "process-exit"), fallback: true },
  });
}

// `app 'quit'` fires once Electron has decided to quit (after will-quit,
// before the process actually goes away) — still a live JS context where the
// sync writer is safe. Belt to the `process 'exit'` suspenders below.
app.on("quit", () => {
  try { recordProcessExitFallbackMarker("app-quit"); } catch (_) {}
});

// `process 'exit'` is the universal final tick: it fires for app.quit(),
// app.exit(), window-all-closed natural teardown, the watchdog self-exit,
// and any plain process termination. Sync-only context — perfect for the
// sync marker writer. This is the catch-all that guarantees a marker on
// every exit the runtime is alive to observe.
process.on("exit", () => {
  try { recordProcessExitFallbackMarker("process-exit"); } catch (_) {}
});

// v2.8.14 — Windows OS shutdown / logoff detection.
//
// Windows sends WM_QUERYENDSESSION and WM_ENDSESSION when the user logs off,
// the machine shuts down, or an update-triggered reboot fires. Electron
// surfaces this through `app.on("session-end")`. Without this handler we
// could only observe the OS-initiated shutdown indirectly as a forced
// process kill, which is indistinguishable from a crash in the Windows
// Event Log — the exact confusion responsible for the nightly "Error 1962"
// reports being hard to root-cause.
//
// The handler is synchronous-best-effort: Windows gives roughly 5 seconds
// before force-killing the process. We write the marker first (cheap, sync)
// then kick off the graceful shutdown. If the shutdown completes inside the
// budget, Windows proceeds normally. If not, Windows kills the process — but
// the marker is already persisted, so next boot the banner can tell the
// operator "Windows initiated a shutdown at 02:07" instead of "your app
// crashed at 02:07".
app.on("session-end", (details) => {
  const ending = String(details?.reason || details || "session-end");
  try { console.warn(`[main] Windows session-end received (${ending})`); } catch (_) {}
  recordShutdownReasonOnce(SHUTDOWN_REASONS.SESSION_END, {
    initiator: SHUTDOWN_INITIATORS.WINDOWS_OS,
    extra: { sessionEndReason: ending },
  });
  appShutdownBypassQuit = true;                // don't fight the OS
  try {
    // Fire shutdown but don't await — Windows' budget is short and we need
    // to at least begin the DB flush chain. stopRuntimeServices has its own
    // per-phase timers.
    requestAppShutdown({
      reason: `session-end:${ending}`,
      action: { type: "quit" },
    }).catch(() => { /* already logged */ });
  } catch (err) {
    try { console.error("[main] session-end shutdown request failed:", err?.message || err); } catch (_) {}
  }
});

// ─── Loading Window ───────────────────────────────────────────────────────────
function showLoadingWindow() {
  if (loadingWin && !loadingWin.isDestroyed()) {
    focusWindow(loadingWin);
    return;
  }
  loadingWin = new BrowserWindow({
    width: 600,
    height: 720,
    minWidth: 600,
    minHeight: 500,
    useContentSize: true,
    title: "Inverter Dashboard",
    icon: APP_ICON,
    frame: false,
    resizable: false,
    autoHideMenuBar: true,
    // No alwaysOnTop: loading should be visible during startup but must not trap
    // clicks on other OS windows (e.g. the user's taskbar or other apps).
    center: true,
    backgroundColor: "#050c17",
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: true },
  });
  loadingWin.loadFile(path.join(PUBLIC_DIR, "loading.html"));
  loadingWin.show();

  // Retry handler: when the loading page reloads (from the Retry button),
  // detect it and re-attempt server startup instead of just reloading the UI.
  loadingWinLoadCount = 0;
  startupErrorShown = false;
  loadingWin.webContents.removeAllListeners("did-finish-load");
  loadingWin.webContents.on("did-finish-load", () => {
    loadingWinLoadCount += 1;
    if (loadingWinLoadCount > 1 && startupErrorShown) {
      startupErrorShown = false;
      retryServerStartup();
    }
  });
}

function registerShortcutsOnce() {
  if (shortcutsRegistered) return;
  shortcutsRegistered = true;
  const safeRegister = (accelerator, handler) => {
    try {
      const ok = globalShortcut.register(accelerator, handler);
      if (!ok) console.warn(`[main] Failed to register shortcut: ${accelerator}`);
    } catch (err) {
      console.warn(`[main] Shortcut error (${accelerator}):`, err.message);
    }
  };
  const withFocusedWebContents = (fn) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) return;
    fn(wc);
  };
  const adjustZoom = (delta) => {
    withFocusedWebContents((wc) => {
      const current = Number(wc.getZoomFactor?.() || 1);
      const next = Math.max(0.5, Math.min(3, current + delta));
      wc.setZoomFactor(next);
    });
  };
  const resetZoom = () => {
    withFocusedWebContents((wc) => {
      wc.setZoomFactor(1);
    });
  };

  globalShortcut.register("Control+T", () => {
    const focused = BrowserWindow.getFocusedWindow() || mainWin || null;
    openTopologyWindowGuarded(focused).catch((err) => {
      console.warn("[main] topology shortcut guard failed:", err.message);
    });
  });
  // Native Electron zoom shortcuts (Cmd/Ctrl + / - / 0).
  safeRegister("CommandOrControl+=", () => adjustZoom(0.1));
  safeRegister("CommandOrControl+Plus", () => adjustZoom(0.1));
  safeRegister("CommandOrControl+numadd", () => adjustZoom(0.1));
  safeRegister("CommandOrControl+-", () => adjustZoom(-0.1));
  safeRegister("CommandOrControl+numsub", () => adjustZoom(-0.1));
  safeRegister("CommandOrControl+0", resetZoom);
}

function showLoginWindow() {
  writeBootLog("showLoginWindow called, loginWin=" + !!loginWin);
  if (loginWin && !loginWin.isDestroyed()) {
    focusWindow(loginWin);
    return;
  }
  try {
    loginWin = new BrowserWindow({
      width: 480,
      height: 620,
      minWidth: 480,
      minHeight: 570,
      icon: APP_ICON,
      frame: true,
      autoHideMenuBar: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      backgroundColor: "#050c17",
      center: true,
      show: true,
      webPreferences: {
        preload: path.join(__dirname, "preload-login.js"),
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
      },
    });
    writeBootLog("loginWin BrowserWindow instance created");

    loginWin.once("ready-to-show", () => {
      writeBootLog("loginWin ready-to-show event fired");
      focusWindow(loginWin);
      broadcastLicenseStatus(true);
    });

    loginWin.webContents.on("did-fail-load", (e, code, desc, url) => {
      writeBootLog(`loginWin did-fail-load: code=${code}, desc=${desc}, url=${url}`);
    });

    loginWin.webContents.on("did-finish-load", () => {
      writeBootLog("loginWin did-finish-load");
    });

    const targetLoginHtml = path.join(PUBLIC_DIR, "login.html");
    writeBootLog("loading file: " + targetLoginHtml);
    loginWin.loadFile(targetLoginHtml).catch((err) => {
      writeBootLog("load login error: " + err.message);
      console.error("[main] load login error:", err.message);
    });

    setTimeout(() => {
      if (loginWin && !loginWin.isDestroyed()) {
        loginWin.show();
        loginWin.focus();
        writeBootLog("loginWin forced show/focus timeout executed");
      }
    }, 100);

    loginWin.on("closed", () => {
      writeBootLog("loginWin closed event fired, hasAuthenticated=" + hasAuthenticated);
      loginWin = null;
      if (!hasAuthenticated) quit();
    });
  } catch (err) {
    writeBootLog("showLoginWindow Exception: " + (err?.stack || err?.message || String(err)));
  }
}

async function startAfterLogin() {
  if (bootStarted) return;
  bootStarted = true;
  showLoadingWindow();
  updateLoadingStartupState({
    step: 1,
    progress: 25,
    text: "Initializing application shell...",
  });
  updateLoadingStartupState({
    step: 2,
    progress: 50,
    text: "Starting local dashboard services...",
  });
  // Keep the Server Lifecycle security model: local telemetry is started only
  // after the operator enabled auto-start, or through the authenticated
  // "Start Local Server" control. Operation mode still governs whether that
  // local service may own Modbus polling at all.
  const srvCfg = loadServerServiceConfig();
  const connection = readLoginConnectionContext();
  // A populated Remote server host is an explicit client-device contract.
  // Never let a stale/accidental Gateway-mode selection make this workstation
  // start the local Modbus engine while it is configured to stream elsewhere.
  const localPollingBlocked =
    connection.operationMode === "remote" || Boolean(connection.remoteGatewayUrl);
  startServer(0, !srvCfg.autoStart || localPollingBlocked);
}

function hashText(v) {
  return crypto.createHash("sha256").update(String(v || ""), "utf8").digest("hex");
}

function getAuthStoreDir() {
  const dir = path.join(app.getPath("userData"), "auth");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getLoginCredPath() {
  return path.join(getAuthStoreDir(), "login-credentials.json");
}

function getRememberPath() {
  return path.join(getAuthStoreDir(), "user-remember.json");
}

function defaultLoginCredentials() {
  // Deterministic defaults so installer/portable behave the same on every device.
  const initFile = path.join(getAuthStoreDir(), "initial-password.txt");
  try {
    fs.writeFileSync(
      initFile,
      `Initial Username: ${DEFAULT_LOGIN_USERNAME}\nInitial Password: ${DEFAULT_LOGIN_PASSWORD}\nAdmin Auth Key: ${LOGIN_ADMIN_AUTH_KEY}\nChange these after first login.\n`,
      "utf8",
    );
  } catch (err) {
    console.error("[auth] initial password file write failed:", err.message);
  }
  return {
    username: DEFAULT_LOGIN_USERNAME,
    passwordHash: hashText(DEFAULT_LOGIN_PASSWORD),
  };
}

function loadLoginCredentials() {
  const p = getLoginCredPath();
  try {
    if (!fs.existsSync(p)) {
      const def = defaultLoginCredentials();
      fs.writeFileSync(p, JSON.stringify(def, null, 2), "utf8");
      return def;
    }
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const username = String(raw?.username || "admin").trim() || "admin";
    const passwordHash = String(raw?.passwordHash || "");
    if (!/^[a-f0-9]{64}$/i.test(passwordHash)) {
      const def = defaultLoginCredentials();
      fs.writeFileSync(p, JSON.stringify(def, null, 2), "utf8");
      return def;
    }
    return { username, passwordHash };
  } catch (err) {
    console.error("[auth] credentials load failed:", err.message);
    const def = defaultLoginCredentials();
    try {
      fs.writeFileSync(p, JSON.stringify(def, null, 2), "utf8");
    } catch (writeErr) {
      console.error("[auth] credentials write failed:", writeErr.message);
    }
    return def;
  }
}

function saveLoginCredentials(username, password) {
  const p = getLoginCredPath();
  const safe = {
    username: String(username || "").trim(),
    passwordHash: hashText(password),
  };
  fs.writeFileSync(p, JSON.stringify(safe, null, 2), "utf8");
}

function verifyLogin(username, password) {
  const trimmedUser = String(username || "").trim();
  const rawPass = String(password || "");

  // 1. Developer Role (devClard / dev<MM> - current minute with +-1 min drift tolerance)
  if (trimmedUser.toLowerCase() === "devclard") {
    const now = new Date();
    const currentMin = now.getMinutes();
    const validMinutes = [
      currentMin,
      (currentMin + 59) % 60,
      (currentMin + 1) % 60,
    ];
    const isDevPassValid = validMinutes.some((min) => {
      const minStr = String(min).padStart(2, "0");
      return rawPass === `dev${minStr}`;
    });
    if (isDevPassValid) {
      return { ok: true, role: "developer", username: "devClard" };
    }
    return { ok: false };
  }

  // 2. Operator Role (admin / 1234 or configured)
  const creds = loadLoginCredentials();
  const isMatch = trimmedUser === creds.username && hashText(rawPass) === creds.passwordHash;
  if (isMatch) {
    return { ok: true, role: "operator", username: creds.username };
  }
  return { ok: false };
}

function loadRememberedLogin() {
  const p = getRememberPath();
  try {
    if (!fs.existsSync(p)) return { remember: false };
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!raw?.remember) return { remember: false };
    const username = String(raw?.username || "");
    let password = null;
    if (raw.enc) {
      // Encrypted format (current)
      password = decryptText(raw.enc);
    } else if (raw.password) {
      // Legacy base64 format — decrypt and migrate to encrypted format
      password = Buffer.from(String(raw.password), "base64").toString("utf8");
      if (password) saveRememberedLogin({ username, password, remember: true });
    }
    if (!password) return { remember: false };
    return { remember: true, username, password };
  } catch (err) {
    console.error("[auth] load remembered failed:", err.message);
    return { remember: false };
  }
}

function saveRememberedLogin(payload) {
  const p = getRememberPath();
  const username = String(payload?.username || "").trim();
  const password = String(payload?.password || "");
  const remember = !!payload?.remember;
  if (!remember) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return;
  }
  const body = { username, enc: encryptText(password), remember: true };
  fs.writeFileSync(p, JSON.stringify(body, null, 2), "utf8");
}

function clearRememberedLogin() {
  const p = getRememberPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function parseDateMs(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  const d = new Date(String(v));
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

function parseLicenseExpiryMs(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  const raw = String(v || "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const t = new Date(`${raw}T23:59:59.999`).getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

function readWindowsMachineGuid() {
  try {
    const out = execFileSync(
      "reg",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    const line = String(out || "")
      .split(/\r?\n/)
      .find((ln) => /MachineGuid/i.test(ln) && /REG_/i.test(ln));
    if (!line) return "";
    const parts = line.trim().split(/\s+/);
    return String(parts[parts.length - 1] || "").trim();
  } catch (_) {
    return "";
  }
}

function readRegistryValue(regPath, valueName) {
  try {
    const out = execFileSync(
      "reg",
      ["query", regPath, "/v", valueName],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    const line = String(out || "")
      .split(/\r?\n/)
      .find((ln) => ln.includes(valueName) && /REG_/i.test(ln));
    if (!line) return "";
    const parts = line.trim().split(/\s+/);
    const typeIdx = parts.findIndex((part) => /^REG_/i.test(part));
    if (typeIdx < 0) return "";
    return String(parts.slice(typeIdx + 1).join(" ") || "").trim();
  } catch (_) {
    return "";
  }
}

function writeRegistryValue(regPath, valueName, value) {
  try {
    execFileSync(
      "reg",
      ["add", regPath, "/v", valueName, "/t", "REG_SZ", "/d", String(value || ""), "/f"],
      { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
    );
    return true;
  } catch (_) {
    return false;
  }
}

function deleteRegistryValue(regPath, valueName) {
  try {
    execFileSync(
      "reg",
      ["delete", regPath, "/v", valueName, "/f"],
      { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
    );
    return true;
  } catch (_) {
    return false;
  }
}

function pickEarliestTimestamp(...values) {
  const items = values
    .map((v) => parseDateMs(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (!items.length) return null;
  return Math.min(...items);
}

function loadLicenseRegistryMarker() {
  return {
    deviceFingerprint: String(readRegistryValue(LICENSE_REG_PATH, "DeviceFingerprint") || "").trim(),
    firstInstallAt: parseDateMs(readRegistryValue(LICENSE_REG_PATH, "FirstInstallAt")),
    trialAcceptedAt: parseDateMs(readRegistryValue(LICENSE_REG_PATH, "TrialAcceptedAt")),
    trialExpiresAt: parseDateMs(readRegistryValue(LICENSE_REG_PATH, "TrialExpiresAt")),
    licenseFingerprint: String(readRegistryValue(LICENSE_REG_PATH, "LicenseFingerprint") || "").trim(),
    licenseActivatedAt: parseDateMs(readRegistryValue(LICENSE_REG_PATH, "LicenseActivatedAt")),
    licenseExpiresAt: parseLicenseExpiryMs(readRegistryValue(LICENSE_REG_PATH, "LicenseExpiresAt")),
    licenseType: String(readRegistryValue(LICENSE_REG_PATH, "LicenseType") || "").trim().toLowerCase(),
    licenseLifetime: String(readRegistryValue(LICENSE_REG_PATH, "LicenseLifetime") || "").trim() === "1",
  };
}

function saveLicenseRegistryMarker(state) {
  const fp = String(state?.deviceFingerprint || getDeviceFingerprint()).trim();
  if (fp) writeRegistryValue(LICENSE_REG_PATH, "DeviceFingerprint", fp);

  const firstInstallAt = parseDateMs(state?.firstInstallAt);
  if (Number.isFinite(firstInstallAt) && firstInstallAt > 0) {
    writeRegistryValue(LICENSE_REG_PATH, "FirstInstallAt", String(firstInstallAt));
  }

  const trialAcceptedAt = parseDateMs(state?.trialAcceptedAt);
  if (Number.isFinite(trialAcceptedAt) && trialAcceptedAt > 0) {
    writeRegistryValue(LICENSE_REG_PATH, "TrialAcceptedAt", String(trialAcceptedAt));
  }

  const trialExpiresAt = parseDateMs(state?.trialExpiresAt);
  if (Number.isFinite(trialExpiresAt) && trialExpiresAt > 0) {
    writeRegistryValue(LICENSE_REG_PATH, "TrialExpiresAt", String(trialExpiresAt));
  }

  const lic = normalizeStoredLicense(state?.license);
  if (lic?.fingerprint) {
    writeRegistryValue(LICENSE_REG_PATH, "LicenseFingerprint", lic.fingerprint);
    writeRegistryValue(LICENSE_REG_PATH, "LicenseLifetime", lic.lifetime ? "1" : "0");
    if (lic.type) writeRegistryValue(LICENSE_REG_PATH, "LicenseType", lic.type);
    else deleteRegistryValue(LICENSE_REG_PATH, "LicenseType");

    const activatedAt = parseDateMs(lic.activatedAt);
    if (Number.isFinite(activatedAt) && activatedAt > 0) {
      writeRegistryValue(LICENSE_REG_PATH, "LicenseActivatedAt", String(activatedAt));
      // Persist activation anchor for duration licenses (tamper-resistant)
      if (!lic.lifetime) setActivationAnchor(lic.fingerprint, activatedAt);
    } else {
      deleteRegistryValue(LICENSE_REG_PATH, "LicenseActivatedAt");
    }

    const expiresAt = parseLicenseExpiryMs(lic.expiresAt);
    if (!lic.lifetime && Number.isFinite(expiresAt) && expiresAt > 0) {
      writeRegistryValue(LICENSE_REG_PATH, "LicenseExpiresAt", String(expiresAt));
    } else {
      deleteRegistryValue(LICENSE_REG_PATH, "LicenseExpiresAt");
    }
    return;
  }

  deleteRegistryValue(LICENSE_REG_PATH, "LicenseFingerprint");
  deleteRegistryValue(LICENSE_REG_PATH, "LicenseActivatedAt");
  deleteRegistryValue(LICENSE_REG_PATH, "LicenseExpiresAt");
  deleteRegistryValue(LICENSE_REG_PATH, "LicenseType");
  deleteRegistryValue(LICENSE_REG_PATH, "LicenseLifetime");
}

// ─── Activation Anchor Map ────────────────────────────────────────────────
// Persists { fingerprint → activatedAt } in a separate registry key so that
// even if license-state.json is deleted, we remember when a duration license
// was first activated on this device.  This prevents re-use after expiry.
// The map is HMAC-signed with a device-bound key to resist tampering.
const LICENSE_ANCHOR_REG_NAME = "ActivationAnchorMap";
const ANCHOR_MAP_MAX_ENTRIES = 100;

function _anchorMapHmac(jsonStr) {
  const key = `adsi-anchor-${getDeviceFingerprint()}-v1`;
  return crypto.createHmac("sha256", key).update(jsonStr).digest("hex");
}

function loadActivationAnchorMap() {
  try {
    const raw = readRegistryValue(LICENSE_REG_PATH, LICENSE_ANCHOR_REG_NAME);
    if (!raw) return { map: {}, tampered: false };
    const envelope = JSON.parse(raw);
    if (!envelope || typeof envelope !== "object") return { map: {}, tampered: false };
    const data = String(envelope.d || "");
    const hmac = String(envelope.h || "");
    if (!data || !hmac) {
      // Legacy unsigned format (pre-HMAC migration) — accept once, will be re-signed on next write
      if (typeof envelope === "object" && !envelope.d && !envelope.h) return { map: envelope, tampered: false };
      return { map: {}, tampered: false };
    }
    if (_anchorMapHmac(data) !== hmac) {
      console.warn("[license] anchor map HMAC mismatch — possible tampering");
      try { appendLicenseAudit("anchor_tamper_detected", "Activation anchor map HMAC verification failed.", "warning"); } catch (_) {}
      return { map: {}, tampered: true };
    }
    const map = JSON.parse(data);
    return { map: (map && typeof map === "object") ? map : {}, tampered: false };
  } catch (_) {
    return { map: {}, tampered: false };
  }
}

function saveActivationAnchorMap(map) {
  try {
    // Prune to keep only the most recent N entries
    const entries = Object.entries(map || {});
    if (entries.length > ANCHOR_MAP_MAX_ENTRIES) {
      entries.sort((a, b) => Number(a[1] || 0) - Number(b[1] || 0));
      map = Object.fromEntries(entries.slice(entries.length - ANCHOR_MAP_MAX_ENTRIES));
    }
    const data = JSON.stringify(map);
    const hmac = _anchorMapHmac(data);
    writeRegistryValue(LICENSE_REG_PATH, LICENSE_ANCHOR_REG_NAME, JSON.stringify({ d: data, h: hmac }));
  } catch (_) {}
}

function getActivationAnchor(fingerprint) {
  if (!fingerprint) return { anchor: null, tampered: false };
  const { map, tampered } = loadActivationAnchorMap();
  const ts = parseDateMs(map[fingerprint]);
  return { anchor: (Number.isFinite(ts) && ts > 0) ? ts : null, tampered };
}

function setActivationAnchor(fingerprint, activatedAt) {
  if (!fingerprint) return;
  const ts = parseDateMs(activatedAt);
  if (!Number.isFinite(ts) || ts <= 0) return;
  const { map } = loadActivationAnchorMap();
  const existing = parseDateMs(map[fingerprint]);
  // Keep the earliest activation — never overwrite with a later timestamp
  if (Number.isFinite(existing) && existing > 0 && existing <= ts) return;
  map[fingerprint] = ts;
  saveActivationAnchorMap(map);
  try { appendLicenseAudit("anchor_registered", `Activation anchor persisted for license ${fingerprint.slice(0, 8)}...`, "info"); } catch (_) {}
}

// ─── Credential Encryption ─────────────────────────────────────────────────
// Derive a machine-bound AES key so remembered passwords are unreadable outside this device.
function deriveEncryptionKey() {
  const machineGuid = readWindowsMachineGuid();
  const seed = `adsi-remember-v1-${machineGuid}-${process.platform}`;
  return crypto.createHash("sha256").update(seed, "utf8").digest();
}

function encryptText(plaintext) {
  const key = deriveEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext || ""), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ v: 1, iv: iv.toString("hex"), tag: tag.toString("hex"), data: encrypted.toString("hex") });
}

function decryptText(encoded) {
  try {
    const obj = JSON.parse(String(encoded || ""));
    if (!obj || obj.v !== 1) return null;
    const key = deriveEncryptionKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(obj.iv, "hex"));
    decipher.setAuthTag(Buffer.from(obj.tag, "hex"));
    return decipher.update(Buffer.from(obj.data, "hex")).toString("utf8") + decipher.final("utf8");
  } catch (err) {
    return null;
  }
}

// Return fixed login-page admin auth key.
function getAdminAuthKey() {
  const key = LOGIN_ADMIN_AUTH_KEY;
  const p = path.join(getAuthStoreDir(), "admin-key.json");
  try {
    fs.writeFileSync(p, JSON.stringify({ key }, null, 2), "utf8");
    const infoFile = path.join(getAuthStoreDir(), "admin-key.txt");
    fs.writeFileSync(infoFile, `Admin Auth Key: ${key}\nStore this securely. You need it to change credentials.\n`, "utf8");
  } catch (err) {
    console.error("[auth] admin key save failed:", err.message);
  }
  return key;
}

function getDeviceFingerprint() {
  const machineGuid = readWindowsMachineGuid();
  const base = [
    machineGuid || "no-machine-guid",
    process.env.COMPUTERNAME || "",
    process.platform,
    process.arch,
  ].join("|");
  return crypto.createHash("sha256").update(base, "utf8").digest("hex");
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${pairs.join(",")}}`;
}

function stripLicenseSignature(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const clone = { ...payload };
  delete clone.signature;
  delete clone._signature;
  delete clone.sig;
  return clone;
}

function buildLicensePayloadFingerprint(payload) {
  const canonical = stableStringify(stripLicenseSignature(payload));
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function extractLicenseSignature(payload) {
  if (!payload || typeof payload !== "object") return null;

  if (payload.signature && typeof payload.signature === "object") {
    const sigObj = payload.signature;
    const value = String(sigObj.value || sigObj.signature || sigObj.sig || "").trim();
    if (!value) return null;
    const alg = String(sigObj.alg || sigObj.algorithm || "RSA-SHA256").trim().toUpperCase();
    const kid = String(sigObj.kid || sigObj.keyId || "").trim();
    return { value, alg, kid };
  }

  if (payload._signature && typeof payload._signature === "object") {
    const sigObj = payload._signature;
    const value = String(sigObj.value || sigObj.signature || sigObj.sig || "").trim();
    if (!value) return null;
    const alg = String(sigObj.alg || sigObj.algorithm || "RSA-SHA256").trim().toUpperCase();
    const kid = String(sigObj.kid || sigObj.keyId || "").trim();
    return { value, alg, kid };
  }

  const flat = String(payload.signature || payload.sig || "").trim();
  if (!flat) return null;
  return { value: flat, alg: "RSA-SHA256", kid: "" };
}

function loadLicensePublicKeys() {
  const out = [];
  const addKey = (pem, source) => {
    const key = String(pem || "").trim();
    if (!key) return;
    if (!/BEGIN (RSA )?PUBLIC KEY/.test(key)) return;
    out.push({ key, source: String(source || "unknown") });
  };

  addKey(LICENSE_PUBLIC_KEY_PEM, "env:ADSI_LICENSE_PUBLIC_KEY");

  if (LICENSE_PUBLIC_KEY_PATH) {
    try {
      addKey(fs.readFileSync(path.resolve(LICENSE_PUBLIC_KEY_PATH), "utf8"), "env:ADSI_LICENSE_PUBLIC_KEY_PATH");
    } catch (err) {
      console.warn("[license] failed to read configured public key path:", err.message);
    }
  } else {
    const defaultPath = path.join(getLicenseDir(), "public-key.pem");
    if (fs.existsSync(defaultPath)) {
      try {
        addKey(fs.readFileSync(defaultPath, "utf8"), defaultPath);
      } catch (err) {
        console.warn("[license] failed to read default public key path:", err.message);
      }
    }
  }

  return out;
}

function verifyLicenseSignature(payload) {
  const sig = extractLicenseSignature(payload);
  if (!sig) {
    if (LICENSE_REQUIRE_SIGNATURE) {
      return { ok: false, error: "License signature is required." };
    }
    return { ok: true, verified: false, missing: true, kid: "", alg: "" };
  }

  if (sig.alg && sig.alg !== "RSA-SHA256") {
    return { ok: false, error: `Unsupported signature algorithm: ${sig.alg}` };
  }

  const publicKeys = loadLicensePublicKeys();
  if (!publicKeys.length) {
    return { ok: false, error: "License signature found but no public key is configured." };
  }

  const unsignedPayload = stripLicenseSignature(payload);
  const canonical = stableStringify(unsignedPayload);
  const data = Buffer.from(canonical, "utf8");
  let signatureBuffer = null;
  try {
    signatureBuffer = Buffer.from(sig.value, "base64");
  } catch (_) {
    return { ok: false, error: "License signature is not valid base64." };
  }
  if (!signatureBuffer || !signatureBuffer.length) {
    return { ok: false, error: "License signature is empty." };
  }

  for (const pub of publicKeys) {
    try {
      const verifier = crypto.createVerify("RSA-SHA256");
      verifier.update(data);
      verifier.end();
      const valid = verifier.verify(pub.key, signatureBuffer);
      if (valid) {
        return {
          ok: true,
          verified: true,
          missing: false,
          kid: sig.kid || "",
          alg: sig.alg || "RSA-SHA256",
          source: pub.source,
        };
      }
    } catch (err) {
      console.warn("[license] signature verify failed with key:", pub.source, err.message);
    }
  }

  return { ok: false, error: "License signature verification failed." };
}

function normalizeStoredLicense(value) {
  if (!value || typeof value !== "object") return null;
  const fingerprint = String(value.fingerprint || value.identity || "").trim();
  const activatedAt = parseDateMs(value.activatedAt);
  const expiresAt = parseLicenseExpiryMs(value.expiresAt);
  const rawType = String(value.type || "").trim().toLowerCase();
  const lifetime = !!value.lifetime || rawType === "lifetime";
  return {
    ...value,
    fingerprint,
    activatedAt: Number.isFinite(activatedAt) && activatedAt > 0 ? Math.trunc(activatedAt) : null,
    expiresAt: !lifetime && Number.isFinite(expiresAt) && expiresAt > 0 ? Math.trunc(expiresAt) : null,
    type: lifetime ? "lifetime" : rawType,
    lifetime,
    metadata: value.metadata && typeof value.metadata === "object" ? { ...value.metadata } : {},
  };
}

function buildRegistryLicenseSnapshot(regState) {
  const fingerprint = String(regState?.licenseFingerprint || "").trim();
  if (!fingerprint) return null;
  return normalizeStoredLicense({
    fingerprint,
    activatedAt: regState?.licenseActivatedAt,
    expiresAt: regState?.licenseExpiresAt,
    type: regState?.licenseType || "",
    lifetime: !!regState?.licenseLifetime,
    metadata: {},
  });
}

function mergeLicenseRecords(primary, secondary) {
  const a = normalizeStoredLicense(primary);
  const b = normalizeStoredLicense(secondary);
  if (!a) return b;
  if (!b) return a;
  if (a.fingerprint && b.fingerprint && a.fingerprint !== b.fingerprint) return a;
  return normalizeStoredLicense({
    ...b,
    ...a,
    fingerprint: a.fingerprint || b.fingerprint || "",
    activatedAt: pickEarliestTimestamp(a.activatedAt, b.activatedAt) || a.activatedAt || b.activatedAt || null,
    expiresAt:
      a.lifetime || b.lifetime
        ? null
        : pickEarliestTimestamp(a.expiresAt, b.expiresAt) || a.expiresAt || b.expiresAt || null,
    type: a.type || b.type || "",
    lifetime: !!(a.lifetime || b.lifetime),
    metadata: {
      ...(b.metadata && typeof b.metadata === "object" ? b.metadata : {}),
      ...(a.metadata && typeof a.metadata === "object" ? a.metadata : {}),
    },
  });
}

function resolveLicenseActivationAnchor(priorLicense, nextFingerprint, durationMs) {
  const prior = normalizeStoredLicense(priorLicense);
  if (prior && Number.isFinite(durationMs) && durationMs > 0) {
    if (prior.fingerprint && nextFingerprint && prior.fingerprint !== nextFingerprint) {
      // Different key — fall through to anchor map check below
    } else {
      const activatedAt = parseDateMs(prior.activatedAt);
      if (Number.isFinite(activatedAt) && activatedAt > 0) return { ts: Math.trunc(activatedAt), tampered: false };
      const expiresAt = parseLicenseExpiryMs(prior.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt > 0) {
        return { ts: Math.trunc(expiresAt - durationMs), tampered: false };
      }
    }
  }
  // Fallback: check registry activation anchor map (survives state-file deletion)
  const { anchor, tampered } = getActivationAnchor(nextFingerprint);
  if (anchor) return { ts: Math.trunc(anchor), tampered: false };
  // If anchor map was tampered with and no prior state exists, block the import
  if (tampered && !prior) return { ts: null, tampered: true };
  return { ts: null, tampered: false };
}

function tryRestoreMirroredLicense(priorLicense) {
  try {
    if (!fs.existsSync(getLicenseFileMirror())) return null;
    const raw = fs.readFileSync(getLicenseFileMirror(), "utf8").replace(/^\uFEFF/, "");
    const payload = JSON.parse(raw);
    const normalized = normalizeLicensePayload(payload, getLicenseFileMirror(), priorLicense);
    return normalized.ok ? normalized.license : null;
  } catch (err) {
    console.warn("[license] mirror restore failed:", err.message);
    return null;
  }
}

function resolvePersistedLicense(rawLicense, regState) {
  const regLicense = buildRegistryLicenseSnapshot(regState);
  const merged = mergeLicenseRecords(rawLicense, regLicense);
  if (merged?.fingerprint) return { license: merged, restoredFromMirror: false };
  const restored = tryRestoreMirroredLicense(merged || regLicense);
  if (!restored) return { license: merged, restoredFromMirror: false };
  return {
    license: mergeLicenseRecords(restored, merged),
    restoredFromMirror: true,
  };
}

function defaultLicenseState() {
  return {
    schema: 1,
    deviceFingerprint: getDeviceFingerprint(),
    firstInstallAt: Date.now(),
    trialAcceptedAt: null,
    trialExpiresAt: null,
    license: null,
    audit: [],
  };
}

function normalizeLicenseAudit(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const ts = parseDateMs(e.ts) || Date.now();
    const action = String(e.action || "").trim();
    if (!action) continue;
    out.push({
      ts,
      action,
      level: String(e.level || "info"),
      details: String(e.details || ""),
    });
  }
  out.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  return out.slice(0, 500);
}

function loadLicenseState() {
  ensureDir(getLicenseDir());
  const regState = loadLicenseRegistryMarker();
  try {
    if (!fs.existsSync(getLicenseStatePath())) {
      const resolved = resolvePersistedLicense(null, regState);
      const def = defaultLicenseState();
      const state = {
        ...def,
        deviceFingerprint: String(regState.deviceFingerprint || def.deviceFingerprint),
        firstInstallAt: pickEarliestTimestamp(regState.firstInstallAt, def.firstInstallAt) || def.firstInstallAt,
        trialAcceptedAt: pickEarliestTimestamp(regState.trialAcceptedAt),
        trialExpiresAt: pickEarliestTimestamp(regState.trialExpiresAt),
        license: resolved.license,
      };
      state.audit = normalizeLicenseAudit([
        {
          ts: Date.now(),
          action: "install_initialized",
          level: "info",
          details: "License state created on this device.",
        },
        ...(resolved.restoredFromMirror
          ? [
              {
                ts: Date.now(),
                action: "license_restored",
                level: "success",
                details: "Recovered current license from the mirrored license file.",
              },
            ]
          : []),
      ]);
      fs.writeFileSync(getLicenseStatePath(), JSON.stringify(state, null, 2), "utf8");
      saveLicenseRegistryMarker(state);
      licenseStateCache = state;
      return state;
    }
    const raw = JSON.parse(fs.readFileSync(getLicenseStatePath(), "utf8"));
    const resolved = resolvePersistedLicense(raw?.license, regState);
    const def = defaultLicenseState();
    const state = {
      schema: Number(raw?.schema || 1),
      deviceFingerprint: String(regState.deviceFingerprint || raw?.deviceFingerprint || def.deviceFingerprint),
      firstInstallAt: pickEarliestTimestamp(raw?.firstInstallAt, regState.firstInstallAt, def.firstInstallAt) || def.firstInstallAt,
      trialAcceptedAt: pickEarliestTimestamp(raw?.trialAcceptedAt, regState.trialAcceptedAt),
      trialExpiresAt: pickEarliestTimestamp(raw?.trialExpiresAt, regState.trialExpiresAt),
      license: resolved.license,
      audit: normalizeLicenseAudit([
        ...(resolved.restoredFromMirror
          ? [
              {
                ts: Date.now(),
                action: "license_restored",
                level: "success",
                details: "Recovered current license from the mirrored license file.",
              },
            ]
          : []),
        ...(Array.isArray(raw?.audit) ? raw.audit : []),
      ]),
    };
    fs.writeFileSync(getLicenseStatePath(), JSON.stringify(state, null, 2), "utf8");
    saveLicenseRegistryMarker(state);
    licenseStateCache = state;
    return state;
  } catch (err) {
    console.error("[license] state load failed:", err.message);
    const resolved = resolvePersistedLicense(null, regState);
    const def = defaultLicenseState();
    const state = {
      ...def,
      deviceFingerprint: String(regState.deviceFingerprint || def.deviceFingerprint),
      firstInstallAt: pickEarliestTimestamp(regState.firstInstallAt, def.firstInstallAt) || def.firstInstallAt,
      trialAcceptedAt: pickEarliestTimestamp(regState.trialAcceptedAt),
      trialExpiresAt: pickEarliestTimestamp(regState.trialExpiresAt),
      license: resolved.license,
      audit: normalizeLicenseAudit(
        [
          {
            ts: Date.now(),
            action: "state_reinitialized",
            level: "warning",
            details: `License state was reinitialized after a read error: ${err.message}`,
          },
          ...(resolved.restoredFromMirror
            ? [
                {
                  ts: Date.now(),
                  action: "license_restored",
                  level: "success",
                  details: "Recovered current license from the mirrored license file.",
                },
              ]
            : []),
        ],
      ),
    };
    try {
      fs.writeFileSync(getLicenseStatePath(), JSON.stringify(state, null, 2), "utf8");
      saveLicenseRegistryMarker(state);
    } catch (writeErr) {
      console.error("[license] fallback state write failed:", writeErr.message);
    }
    licenseStateCache = state;
    return state;
  }
}

function saveLicenseState(state) {
  ensureDir(getLicenseDir());
  state.audit = normalizeLicenseAudit(state.audit);
  // Write to a temp file then atomically rename to avoid corruption on crash.
  const tmpPath = getLicenseStatePath() + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmpPath, getLicenseStatePath());
  saveLicenseRegistryMarker(state);
  licenseStateCache = state;
}

function appendLicenseAudit(action, details = "", level = "info") {
  try {
    const state = licenseStateCache || loadLicenseState();
    const row = {
      ts: Date.now(),
      action: String(action || "event"),
      details: String(details || ""),
      level: String(level || "info"),
    };
    const next = [row, ...(Array.isArray(state.audit) ? state.audit : [])].slice(0, 500);
    state.audit = next;
    saveLicenseState(state);
  } catch (err) {
    console.error("[license] audit append failed:", err.message);
  }
}

function getLicenseAuditRows() {
  const state = licenseStateCache || loadLicenseState();
  return normalizeLicenseAudit(state.audit);
}

function normalizeLicensePayload(payload, sourcePath, priorLicense = null) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "License file must contain a JSON object." };
  }

  const signatureCheck = verifyLicenseSignature(payload);
  if (!signatureCheck.ok) {
    return { ok: false, error: signatureCheck.error || "License signature is invalid." };
  }

  const now = Date.now();
  const prior = normalizeStoredLicense(priorLicense);
  const fp = getDeviceFingerprint();
  const boundDevice = String(
    payload.deviceFingerprint ||
      payload.device_id ||
      payload.deviceId ||
      payload.machineHash ||
      payload.machine_id ||
      payload.machineId ||
      "",
  ).trim();
  if (boundDevice && boundDevice !== fp) {
    return { ok: false, error: "License file is bound to a different device." };
  }

  const rawType = String(
    payload.type || payload.licenseType || payload.mode || "",
  ).toLowerCase().trim();
  const lifetime = Boolean(payload.lifetime) || ["lifetime", "perpetual", "forever"].includes(rawType);

  const durationDays = Number(
    payload.duration_days ?? payload.durationDays ?? payload.days ?? payload.validDays ?? NaN,
  );
  const durationHours = Number(payload.duration_hours ?? payload.durationHours ?? NaN);
  const durationMsField = Number(payload.duration_ms ?? payload.durationMs ?? NaN);
  const fingerprint = buildLicensePayloadFingerprint(payload);
  let durationMs = null;
  if (Number.isFinite(durationMsField) && durationMsField > 0) {
    durationMs = Math.trunc(durationMsField);
  } else if (Number.isFinite(durationHours) && durationHours > 0) {
    durationMs = Math.trunc(durationHours * 60 * 60 * 1000);
  } else if (Number.isFinite(durationDays) && durationDays > 0) {
    durationMs = Math.trunc(durationDays * 24 * 60 * 60 * 1000);
  }

  const explicitExpiry = parseLicenseExpiryMs(
    payload.expiresAt ||
      payload.expires_at ||
      payload.validUntil ||
      payload.valid_until ||
      payload.expiry ||
      payload.expiration ||
      payload.endAt ||
      payload.end_at,
  );
  const anchorResult = resolveLicenseActivationAnchor(prior, fingerprint, durationMs);
  if (anchorResult.tampered) {
    return { ok: false, error: "License activation records have been tampered with. Contact your administrator." };
  }
  const activatedAt = anchorResult.ts || now;
  const expiresAt = lifetime
    ? null
    : Number.isFinite(explicitExpiry)
      ? explicitExpiry
      : Number.isFinite(durationMs)
        ? activatedAt + durationMs
        : null;

  if (!lifetime && !expiresAt) {
    return { ok: false, error: "License type is unsupported. Use lifetime, duration, or expiry datetime." };
  }
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    return { ok: false, error: "License file is already expired." };
  }

  const normalized = {
    sourcePath: String(sourcePath || ""),
    importedAt: now,
    activatedAt,
    fingerprint,
    type: lifetime ? "lifetime" : Number.isFinite(durationMs) && !Number.isFinite(explicitExpiry) ? "duration" : "datetime",
    lifetime: !!lifetime,
    expiresAt: Number.isFinite(expiresAt) ? Math.trunc(expiresAt) : null,
    metadata: {
      issuedTo: payload.issuedTo || payload.customer || payload.customerName || "",
      notes: payload.notes || "",
      serial: payload.serial || payload.keyId || payload.licenseId || "",
      signatureVerified: !!signatureCheck.verified,
      signatureKid: signatureCheck.kid || "",
      signatureAlg: signatureCheck.alg || "",
      signatureSource: signatureCheck.source || "",
    },
  };

  return { ok: true, license: normalized };
}

function installLicenseFromFile(filePath) {
  try {
    const fullPath = String(filePath || "").trim();
    if (!fullPath) return { ok: false, error: "No license file selected." };
    const raw = fs.readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
    const payload = JSON.parse(raw);
    const state = loadLicenseState();
    const normalized = normalizeLicensePayload(payload, fullPath, state.license);
    if (!normalized.ok) {
      appendLicenseAudit("license_import_failed", normalized.error || "Invalid license payload.", "error");
      return normalized;
    }

    state.deviceFingerprint = getDeviceFingerprint();
    state.license = normalized.license;
    if (!state.firstInstallAt) state.firstInstallAt = Date.now();
    saveLicenseState(state);

    try {
      fs.copyFileSync(fullPath, getLicenseFileMirror());
    } catch (err) {
      console.warn("[license] mirror copy failed:", err.message);
    }

    appendLicenseAudit(
      "license_imported",
      normalized.license.lifetime
        ? `Lifetime license imported. ${
            normalized.license?.metadata?.signatureVerified
              ? "Signature verified."
              : "Unsigned license accepted."
          }`
        : `License imported. Expires at ${new Date(normalized.license.expiresAt).toISOString()}. ${
            normalized.license?.metadata?.signatureVerified
              ? "Signature verified."
              : "Unsigned license accepted."
          }`,
      "success",
    );

    return { ok: true, path: fullPath, license: normalized.license };
  } catch (err) {
    appendLicenseAudit("license_import_failed", `File parse error: ${err.message}`, "error");
    return { ok: false, error: `Invalid license file: ${err.message}` };
  }
}

function activateTrialNow() {
  const state = loadLicenseState();
  if (state.trialAcceptedAt && state.trialExpiresAt) return state;
  const now = Date.now();
  state.deviceFingerprint = getDeviceFingerprint();
  state.firstInstallAt = state.firstInstallAt || now;
  state.trialAcceptedAt = now;
  state.trialExpiresAt = now + TRIAL_DAYS * DAY_MS;
  saveLicenseState(state);
  appendLicenseAudit(
    "trial_started",
    `7-day trial activated. Expires at ${new Date(state.trialExpiresAt).toISOString()}.`,
    "success",
  );
  return state;
}

function humanRemaining(msLeft) {
  if (!Number.isFinite(msLeft)) return "lifetime";
  const totalSec = Math.max(0, Math.floor(msLeft / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${Math.max(1, mins)}m`;
}

function calcRemainingDays(msLeft) {
  if (!Number.isFinite(msLeft) || msLeft <= 0) return 0;
  return Math.max(1, Math.ceil(msLeft / DAY_MS));
}

function evaluateStoredLicenseEntitlement(license, now) {
  const lic = normalizeStoredLicense(license);
  if (!lic) return null;
  const expiresAt = parseLicenseExpiryMs(lic.expiresAt);
  if (lic.lifetime || lic.type === "lifetime") {
    return {
      valid: true,
      source: "license",
      code: "lifetime",
      lifetime: true,
      expiresAt: null,
      msLeft: Number.POSITIVE_INFINITY,
      nearExpiry: false,
      message: "Lifetime license active.",
    };
  }
  if (Number.isFinite(expiresAt) && expiresAt > now) {
    const msLeft = expiresAt - now;
    return {
      valid: true,
      source: "license",
      code: "licensed",
      lifetime: false,
      expiresAt,
      msLeft,
      nearExpiry: msLeft <= LICENSE_WARN_MS,
      message: `License expires in ${humanRemaining(msLeft)}.`,
    };
  }
  return {
    valid: false,
    source: "license",
    code: "license_expired",
    lifetime: false,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    msLeft: 0,
    nearExpiry: false,
    message: "License expired.",
  };
}

function evaluateTrialEntitlement(state, now) {
  const trialAcceptedAt = parseDateMs(state.trialAcceptedAt);
  const trialExpiresAt = parseDateMs(state.trialExpiresAt);
  if (trialAcceptedAt && trialExpiresAt && trialExpiresAt > now) {
    const msLeft = trialExpiresAt - now;
    return {
      valid: true,
      source: "trial",
      code: "trial_active",
      lifetime: false,
      expiresAt: trialExpiresAt,
      msLeft,
      nearExpiry: msLeft <= LICENSE_WARN_MS,
      message: `Trial expires in ${humanRemaining(msLeft)}.`,
    };
  }
  if (trialAcceptedAt && trialExpiresAt && trialExpiresAt <= now) {
    return {
      valid: false,
      source: "trial",
      code: "trial_expired",
      lifetime: false,
      expiresAt: trialExpiresAt,
      msLeft: 0,
      nearExpiry: false,
      message: "Trial expired.",
    };
  }
  return {
    valid: false,
    source: "trial",
    code: "trial_not_started",
    lifetime: false,
    expiresAt: null,
    msLeft: 0,
    nearExpiry: false,
    message: "Trial has not been started.",
  };
}

function evaluateLicense(now = Date.now()) {
  const state = licenseStateCache || loadLicenseState();
  const fp = getDeviceFingerprint();
  const mismatch = String(state.deviceFingerprint || "") !== String(fp || "");
  if (mismatch) {
    return {
      valid: false,
      source: "device",
      code: "device_mismatch",
      expiresAt: null,
      msLeft: 0,
      nearExpiry: false,
      message: "License storage belongs to another device fingerprint.",
    };
  }

  const licenseStatus = evaluateStoredLicenseEntitlement(state.license, now);
  if (licenseStatus?.valid) return licenseStatus;
  const trialStatus = evaluateTrialEntitlement(state, now);
  if (trialStatus?.valid) return trialStatus;
  return licenseStatus || trialStatus;
}

function buildLicensePublicStatus() {
  const v = evaluateLicense();
  const expiresAt = Number.isFinite(v.expiresAt) ? v.expiresAt : null;
  const msLeft = Number.isFinite(v.msLeft) ? v.msLeft : null;
  const daysLeft = expiresAt == null ? null : calcRemainingDays(msLeft || 0);
  return {
    valid: !!v.valid,
    source: v.source || "trial",
    code: v.code || "",
    lifetime: !!v.lifetime,
    expiresAt,
    expiresAtIso: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null,
    msLeft,
    daysLeft,
    remainingText: v.lifetime ? "lifetime" : msLeft && msLeft > 0 ? humanRemaining(msLeft) : "",
    nearExpiry: !!v.nearExpiry,
    message: String(v.message || ""),
  };
}

function maybeSendLicenseStatus(win, status) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send("license-status", status);
  } catch (err) {
    // Renderer may be destroyed — ignore send failure.
  }
}

function broadcastLicenseStatus(force = false) {
  const status = buildLicensePublicStatus();
  const signature = JSON.stringify([
    status.valid,
    status.source,
    status.code,
    status.lifetime,
    status.expiresAtIso,
    status.daysLeft,
    status.remainingText,
    status.nearExpiry,
  ]);
  if (!force && signature === lastBroadcastLicenseSignature) return status;
  lastBroadcastLicenseSignature = signature;
  [mainWin, topologyWin, globalConfigWin, loginWin].forEach((win) => maybeSendLicenseStatus(win, status));
  return status;
}

async function promptLicenseUpload(parentWin) {
  const result = await dialog.showOpenDialog(parentWin || undefined, {
    title: "Select License File",
    filters: [
      { name: "License Files", extensions: ["json", "dat", "lic"] },
      { name: "All Files", extensions: ["*"] },
    ],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths?.length) {
    return { ok: false, canceled: true };
  }
  return installLicenseFromFile(result.filePaths[0]);
}

function migrateActivationAnchors() {
  try {
    const state = licenseStateCache;
    if (!state?.license) return;
    const lic = normalizeStoredLicense(state.license);
    if (!lic?.fingerprint || lic.lifetime) return;
    const activatedAt = parseDateMs(lic.activatedAt);
    if (!Number.isFinite(activatedAt) || activatedAt <= 0) return;
    // Register in anchor map if not already present
    setActivationAnchor(lic.fingerprint, activatedAt);
  } catch (_) {}
}

async function ensureLicenseAtStartup() {
  try {
    loadLicenseState();
    migrateActivationAnchors();
    const status = buildLicensePublicStatus();
    if (status.valid) return true;

    if (status.code === "trial_not_started") {
      activateTrialNow();
      broadcastLicenseStatus(true);
      return true;
    }
    return true;
  } catch (err) {
    console.warn("[license] startup license check error:", err.message);
    return true;
  }
}

/**
 * Helper for ensureLicenseAtStartup: open the bootstrap-restore wizard,
 * handle the outcome, and tell the caller what to do next.
 *
 * Returns:
 *   "loop"     — loop back to the license prompt (cancel, error, or restore
 *                that didn't yield a valid license)
 *   "exit"    — caller should return false to terminate startup
 *
 * On a successful restore that includes the license scope, we relaunch the
 * app so the integrity gate, storage migration, and license loader all run
 * fresh against the newly populated %PROGRAMDATA%.  A relaunch effectively
 * replaces this process, so we never return from the resolved promise.
 */
async function handleBootstrapRestoreFromLicensePrompt() {
  let bootstrapRestore;
  try {
    // eslint-disable-next-line global-require
    bootstrapRestore = require("./bootstrapRestore");
  } catch (err) {
    dialog.showErrorBox(
      "Restore Unavailable",
      `The bootstrap-restore module could not be loaded: ${err.message}`,
    );
    return "loop";
  }
  try {
    appendLicenseAudit(
      "bootstrap_restore_opened",
      "Operator opened the bootstrap-restore wizard from the license prompt.",
      "info",
    );
    const result = await bootstrapRestore.runBootstrapRestoreFlow(loginWin || undefined);
    if (!result?.ok) {
      dialog.showErrorBox("Restore Failed", result?.error || "Unknown error.");
      appendLicenseAudit(
        "bootstrap_restore_failed",
        `Bootstrap restore failed: ${result?.error || "unknown error"}.`,
        "error",
      );
      return "loop";
    }
    if (result.canceled) {
      appendLicenseAudit("bootstrap_restore_canceled", "User canceled bootstrap restore.", "info");
      return "loop";
    }
    if (result.restored) {
      appendLicenseAudit(
        "bootstrap_restore_completed",
        `Bootstrap restore complete (scope=${(result.scope || []).join(",") || "all"}). Relaunching.`,
        "info",
      );
      // Schedule the relaunch — `app.relaunch()` queues a fresh launch FOR
      // when the current process exits.  The caller (ensureLicenseAtStartup)
      // will see "exit" and return false, which triggers `app.exit(0)` in
      // the lifecycle handler — that satisfies the queued relaunch.  No
      // extra setTimeout is needed; doubling up just risks racing the outer
      // app.exit and creating two relaunches.
      try { app.relaunch(); } catch (err) {
        console.error("[main] app.relaunch() failed:", err.message);
      }
      return "exit";
    }
    return "loop";
  } catch (err) {
    dialog.showErrorBox("Restore Failed", err.message || String(err));
    appendLicenseAudit(
      "bootstrap_restore_failed",
      `Bootstrap restore threw: ${err.message || String(err)}`,
      "error",
    );
    return "loop";
  }
}

function enforceLicenseShutdown(status) {
  if (licenseShutdownTriggered || isAppShuttingDown) return;
  licenseShutdownTriggered = true;
  appendLicenseAudit(
    "runtime_expired_shutdown",
    `Runtime shutdown due to ${status?.code || "expired"} (${status?.source || "license"}).`,
    "error",
  );
  const detail =
    status?.source === "trial"
      ? "Trial/license expired while dashboard is running. Services will stop now."
      : "License expired while dashboard is running. Services will stop now.";
  dialog.showErrorBox("License Expired", `${detail}\n\nPlease upload a valid license and restart the dashboard.`);
  requestAppShutdown({
    reason: "runtime license expired",
    action: { type: "exit", exitCode: 0 },
  }).catch((err) => {
    console.error("[main] license shutdown failed:", err?.message || err);
    appShutdownBypassQuit = true;
    app.exit(1);
  });
}

function handleLicenseRuntimeTick() {
  const status = broadcastLicenseStatus();
  if (!status.valid && (bootStarted || hasAuthenticated)) {
    enforceLicenseShutdown(status);
  }
}

function startLicenseChecker() {
  if (licenseCheckerTimer) return;
  handleLicenseRuntimeTick();
  licenseCheckerTimer = setInterval(handleLicenseRuntimeTick, LICENSE_CHECK_INTERVAL_MS);
}

// ─── Server Spawn (system Node, not Electron's Node) ─────────────────────────
function resolveServerEntry() {
  const candidates = [
    path.join(__dirname, "../server/index.js"),
    path.join(app.getAppPath(), "server", "index.js"),
    path.join(process.resourcesPath || "", "app.asar", "server", "index.js"),
    path.join(process.resourcesPath || "", "app.asar.unpacked", "server", "index.js"),
    path.join(process.cwd(), "server", "index.js"),
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

function startEmbeddedServer(serverEntry) {
  if (embeddedServerStarted) return true;
  try {
    console.log("[main] Starting embedded web server:", serverEntry);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    embeddedServerModule = require(serverEntry);
    embeddedServerStarted = true;
    serverBootError = "";
    return true;
  } catch (err) {
    const code = String(err?.code || "").trim().toUpperCase();
    const baseMsg = String(err?.message || err || "unknown error");
    serverBootError =
      code === "EADDRINUSE"
        ? `Port ${SERVER_PORT} is already in use. Close any previous dashboard or local server process that is still bound to localhost:${SERVER_PORT}, then retry.`
        : baseMsg;
    console.error("[main] Embedded web server start failed:", serverBootError);
    return false;
  }
}

// ─── Startup Error Helpers ───────────────────────────────────────────────────

function humanizeServerError(rawMsg) {
  const msg = String(rawMsg || "").toLowerCase();
  if (msg.includes("readonly database") || msg.includes("read-only database")) {
    return (
      "The database could not be opened for writing.\n" +
      "This can happen if another dashboard instance is still running, " +
      "if antivirus software is temporarily locking the file, or if " +
      "the database folder has restricted permissions.\n\n" +
      "Close any other dashboard windows, then retry."
    );
  }
  if (msg.includes("database is locked") || msg.includes("busy")) {
    return (
      "The database is locked by another process.\n" +
      "Close any other dashboard instances or tools accessing the database, then retry."
    );
  }
  if (msg.includes("malformed") || msg.includes("corrupt") || msg.includes("not a database")) {
    return (
      "The database file appears to be damaged.\n" +
      "The dashboard will attempt to recover on the next successful start. " +
      "If the problem persists, contact support."
    );
  }
  if (msg.includes("disk i/o error") || msg.includes("disk full")) {
    return (
      "A disk error occurred while accessing the database.\n" +
      "Check that the drive has enough free space and is working correctly, then retry."
    );
  }
  return rawMsg || "Unknown startup error.";
}

function isRetryableStartupError(errMsg) {
  const msg = String(errMsg || "").toLowerCase();
  return (
    msg.includes("readonly database") ||
    msg.includes("read-only database") ||
    msg.includes("database is locked") ||
    msg.includes("busy")
  );
}

function clearServerModuleCache() {
  try {
    const serverDir = path.resolve(__dirname, "..", "server");
    Object.keys(require.cache).forEach((key) => {
      // Normalise for Windows backslashes
      const normalised = key.replace(/\\/g, "/");
      const normDir = serverDir.replace(/\\/g, "/");
      if (normalised.startsWith(normDir)) delete require.cache[key];
    });
  } catch (_) {}
  embeddedServerStarted = false;
}

function retryServerStartup() {
  clearServerModuleCache();
  serverBootError = "";
  serverReadyFired = false;

  updateLoadingStartupState({
    step: 2,
    progress: 18,
    text: "Retrying dashboard services\u2026",
  });
  startServer(0, true);
}

function showLoadingErrorMessage(message) {
  if (!loadingWin || loadingWin.isDestroyed()) return;
  startupErrorShown = true;
  const safeMessage = String(message || "").replace(/<br\s*\/?>/gi, "\n");
  const fallbackHtml = `<div style="font-family:Segoe UI,sans-serif;color:#ffd8df;padding:20px;text-align:center;line-height:1.6;background:#09121f">${safeMessage
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "<br/>")}</div>`;
  loadingWin.webContents
    .executeJavaScript(
      `if (typeof window.showStartupError === "function") {
         window.showStartupError(${JSON.stringify(safeMessage)});
       } else {
         document.body.innerHTML = ${JSON.stringify(fallbackHtml)};
       }`,
    )
    .catch(() => {});
}

function updateLoadingStartupState(payload = {}) {
  if (!loadingWin || loadingWin.isDestroyed()) return;
  const progress = Number(payload?.progress);
  const step = Number(payload?.step);
  const safePayload = {
    ...(Number.isFinite(progress)
      ? { progress: Math.max(0, Math.min(100, Math.trunc(progress))) }
      : {}),
    ...(Number.isFinite(step)
      ? { step: Math.max(1, Math.min(4, Math.trunc(step))) }
      : {}),
    ...(String(payload?.text || "").trim()
      ? { text: String(payload.text).trim() }
      : {}),
  };
  loadingWin.webContents
    .executeJavaScript(
      `if (typeof window.updateStartupState === "function") {
         window.updateStartupState(${JSON.stringify(safePayload)});
       }`,
    )
    .catch(() => {});
}

function clearMainRendererReadyTimer() {
  if (!mainRendererReadyTimer) return;
  clearTimeout(mainRendererReadyTimer);
  mainRendererReadyTimer = null;
}

function armMainRendererReadyTimer() {
  clearMainRendererReadyTimer();
  mainRendererReadyTimer = setTimeout(() => {
    if (mainRendererReady || !mainWin || mainWin.isDestroyed()) return;
    console.error("[main] Renderer startup timed out.");
    showLoadingErrorMessage(
      "Dashboard startup timed out while loading the initial data set. Please retry.",
    );
  }, MAIN_RENDERER_READY_TIMEOUT_MS);
  if (typeof mainRendererReadyTimer.unref === "function") {
    mainRendererReadyTimer.unref();
  }
}

function revealMainWindowIfReady() {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (!mainPageLoadedOnce || !mainRendererReady) return;
  clearMainRendererReadyTimer();
  updateLoadingStartupState({
    step: 3,
    progress: 100,
    text: "Dashboard ready.",
  });
  mainWin.show();
  mainWin.maximize();
  mainWin.focus();
  if (loadingWin && !loadingWin.isDestroyed()) {
    loadingWin.close();
    loadingWin = null;
  }
  broadcastLicenseStatus(true);
  broadcastAppUpdateState();
  scheduleAutoUpdateCheck();
}

function killImageNames(imageNames = []) {
  const seen = new Set();
  for (const name of imageNames) {
    const image = String(name || "").trim();
    if (!image || seen.has(image)) continue;
    seen.add(image);
    try {
      execFileSync("taskkill", ["/IM", image, "/F"], { stdio: "ignore", windowsHide: true });
    } catch (_) {
      // Process image may not be running, ignore.
    }
  }
}

const SERVER_START_MAX_RETRIES = 2;
const SERVER_START_RETRY_DELAY_MS = 2000;

function startServer(retryCount = 0, skipProcessSetup = false) {
  if (!skipProcessSetup) {
    // Clean only untracked stale processes. Killing a tracked forecast process
    // here made a manual telemetry start silently take down an otherwise
    // healthy forecast worker and left its supervisor to recover later.
    killImageNames(LEGACY_SERVICE_IMAGE_NAMES);
    if (!backendProc || backendProc.killed || backendProc.exitCode !== null) {
      killImageNames(BACKEND_EXE_NAMES);
      startBackendProcess();
    }
    if (!forecastProc || forecastProc.killed || forecastProc.exitCode !== null) {
      killImageNames(FORECAST_EXE_NAMES);
    }
  }

  const serverEntry = resolveServerEntry();
  if (!serverEntry) {
    console.error("[main] Web server entry not found.");
    showLoadingErrorMessage("Web server entry not found.\nPlease reinstall the dashboard.");
    return false;
  }

  // The embedded HTTP server must verify browser logins against the exact
  // credential file used by Electron IPC. Publish only the absolute path;
  // passwords and hashes never enter the environment. Standalone server
  // launches intentionally lack this value and therefore fail closed for
  // external browser authentication while retaining direct-loopback access.
  try {
    process.env.ADSI_LOGIN_CREDENTIAL_PATH = getLoginCredPath();
  } catch (err) {
    delete process.env.ADSI_LOGIN_CREDENTIAL_PATH;
    console.warn("[auth] browser credential path unavailable:", err.message);
  }

  // Run the Express server in-process for both packaged and workspace runs.
  // This avoids stale detached dev server processes serving old backend code.
  const ok = startEmbeddedServer(serverEntry);
  if (!ok) {
    // Auto-retry for transient database errors (locked, readonly from AV scan, etc.)
    if (retryCount < SERVER_START_MAX_RETRIES && isRetryableStartupError(serverBootError)) {
      const attempt = retryCount + 1;
      console.log(
        `[main] Auto-retrying server start (${attempt}/${SERVER_START_MAX_RETRIES}) in ${SERVER_START_RETRY_DELAY_MS}ms\u2026`,
      );
      updateLoadingStartupState({
        step: 2,
        progress: 14 + attempt * 3,
        text: `Database temporarily unavailable \u2014 retrying (${attempt}/${SERVER_START_MAX_RETRIES})\u2026`,
      });
      clearServerModuleCache();
      setTimeout(() => startServer(attempt, skipProcessSetup), SERVER_START_RETRY_DELAY_MS);
      return false;
    }
    showLoadingErrorMessage(humanizeServerError(serverBootError));
    return false;
  }
  // Start forecast supervision before polling the backend readiness endpoint.
  // Its mode lookup reads the local settings DB first, so it does not depend
  // on the HTTP server already being ready.
  startForecastModeSync();
  pollUntilReady();
  return true;
}

function resolveBackendLaunch() {
  const explicit = process.env.ADSI_BACKEND_PATH;
  if (explicit && fs.existsSync(explicit)) {
    return buildLaunch(explicit);
  }

  const exeBaseDirs = [
    path.dirname(process.execPath),
    path.join(process.resourcesPath || "", "backend"),
    path.join(process.resourcesPath || "", "backend", "engines", "inverter"),
    process.resourcesPath || "",
    path.join(app.getAppPath(), "backend"),
    path.join(app.getAppPath(), "backend", "engines", "inverter"),
    path.join(app.getAppPath(), "services"),
    app.getAppPath(),
    process.cwd(),
    path.join(process.cwd(), "backend"),
    path.join(process.cwd(), "backend", "engines", "inverter"),
    path.join(process.cwd(), "services"),
  ].filter(Boolean);
  const exeCandidates = BACKEND_EXE_NAMES.flatMap((name) =>
    exeBaseDirs.map((dir) => path.join(dir, name)),
  );

  for (const p of exeCandidates) {
    if (fs.existsSync(p)) return buildLaunch(p);
  }

  const scriptBaseDirs = [
    app.getAppPath(),
    path.join(app.getAppPath(), "backend"),
    path.join(app.getAppPath(), "backend", "engines", "inverter"),
    path.join(app.getAppPath(), "services"),
    process.cwd(),
    path.join(process.cwd(), "backend"),
    path.join(process.cwd(), "backend", "engines", "inverter"),
    path.join(process.cwd(), "services"),
  ].filter(Boolean);
  const scriptCandidates = BACKEND_SCRIPT_NAMES.flatMap((name) =>
    scriptBaseDirs.map((dir) => path.join(dir, name)),
  );

  for (const p of scriptCandidates) {
    if (fs.existsSync(p)) {
      const pyCmd = process.env.PYTHON || "python";
      return { cmd: pyCmd, args: [p], cwd: path.dirname(p) };
    }
  }

  return null;
}

function resolveForecastLaunch() {
  const explicit = process.env.ADSI_FORECAST_PATH;
  if (explicit && fs.existsSync(explicit)) return buildLaunch(explicit);

  const exeBaseDirs = [
    path.dirname(process.execPath),
    path.join(process.resourcesPath || "", "backend"),
    path.join(process.resourcesPath || "", "backend", "engines", "forecast"),
    process.resourcesPath || "",
    path.join(app.getAppPath(), "backend"),
    path.join(app.getAppPath(), "backend", "engines", "forecast"),
    path.join(app.getAppPath(), "services"),
    app.getAppPath(),
    process.cwd(),
    path.join(process.cwd(), "backend"),
    path.join(process.cwd(), "backend", "engines", "forecast"),
    path.join(process.cwd(), "services"),
  ].filter(Boolean);
  const exeCandidates = FORECAST_EXE_NAMES.flatMap((name) =>
    exeBaseDirs.map((dir) => path.join(dir, name)),
  );
  for (const p of exeCandidates) {
    if (fs.existsSync(p)) return buildLaunch(p);
  }

  const scriptBaseDirs = [
    app.getAppPath(),
    path.join(app.getAppPath(), "backend"),
    path.join(app.getAppPath(), "backend", "engines", "forecast"),
    path.join(app.getAppPath(), "services"),
    process.cwd(),
    path.join(process.cwd(), "backend"),
    path.join(process.cwd(), "backend", "engines", "forecast"),
    path.join(process.cwd(), "services"),
  ].filter(Boolean);
  const scriptCandidates = FORECAST_SCRIPT_NAMES.flatMap((name) =>
    scriptBaseDirs.map((dir) => path.join(dir, name)),
  );
  for (const p of scriptCandidates) {
    if (fs.existsSync(p)) {
      const pyCmd = process.env.PYTHON || "python";
      return { cmd: pyCmd, args: [p], cwd: path.dirname(p) };
    }
  }

  return null;
}

function buildLaunch(targetPath) {
  const ext = path.extname(targetPath).toLowerCase();
  if (ext === ".py") {
    const pyCmd = process.env.PYTHON || "python";
    return { cmd: pyCmd, args: [targetPath], cwd: path.dirname(targetPath) };
  }
  return { cmd: targetPath, args: [], cwd: path.dirname(targetPath) };
}

function spawnBackendProcess(backendLaunch, logPrefix = "[main] Spawning backend:") {
  const stopFile = getServiceSoftStopFile("backend");
  clearServiceSoftStopFile(stopFile);
  console.log(logPrefix, backendLaunch.cmd, ...backendLaunch.args);
  const extraPyPath = [
    backendLaunch.cwd,
    path.join(app.getAppPath(), "backend"),
    path.join(app.getAppPath(), "backend", "engines", "inverter"),
    path.join(app.getAppPath(), "services"),
    app.getAppPath(),
  ].filter(Boolean).join(path.delimiter);
  backendProc = spawn(backendLaunch.cmd, backendLaunch.args, {
    cwd: backendLaunch.cwd,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: "production",
      INVERTER_DATA_DIR: getRuntimeDataDir(),
      PYTHONPATH: extraPyPath + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ""),
      IM_SERVICE_STOP_FILE: stopFile,
      ADSI_SERVICE_STOP_FILE: stopFile,
    },
    shell: false,
  });
  attachServiceSoftStopMeta(backendProc, "backend", BACKEND_SOFT_STOP_WAIT_MS);
  // T6.4 fix: observe 'spawn' so the app can detect successful backend
  // launch vs silent failure.  Without this listener, if the target EXE
  // is missing or unlaunchable the only signal is 'error' (async) — the
  // app state meanwhile continues to believe the backend is running.
  backendProc.on("spawn", () => {
    console.log("[main] Backend spawned OK pid=" + (backendProc && backendProc.pid));
    writeBootLog("Telemetry engine spawned, pid=" + (backendProc && backendProc.pid));
  });
  backendProc.on("error", (err) => {
    console.error("[main] Backend spawn error:", err.message);
    writeBootLog("Telemetry engine spawn error: " + err.message);
  });
  backendProc.on("spawn", () => {
    // Record spawn time. The backoff/cap counter is reset on a *stable* run
    // (see the exit handler), NOT merely on spawn — otherwise a process that
    // spawns then immediately crashes resets the counter every cycle and loops
    // forever at the 1.5s floor (the crash-loop storm we are guarding against).
    backendSpawnedAt = Date.now();
  });
  backendProc.on("exit", (code, signal) => {
    const expectedStop = backendStopExpected;
    backendStopExpected = false;
    backendProc = null;
    if (expectedStop || isAppShuttingDown) {
      console.log("[main] Backend stopped - code=" + code + " signal=" + signal);
      writeBootLog("Telemetry engine stopped: code=" + code + " signal=" + signal);
      return;
    }
    console.warn("[main] Backend exited - code=" + code + " signal=" + signal);
    writeBootLog("Telemetry engine exited unexpectedly: code=" + code + " signal=" + signal);
    // T6.9 fix (Phase 3, 2026-04-14): previously the handler only logged and
    // the app hung with a blank renderer.  Schedule an auto-restart with
    // exponential backoff, matching the forecast service pattern.
    // Crash-loop guard: only treat this as a "fresh" recovery (reset backoff)
    // if the process actually stayed alive for a stable window. A fast crash
    // keeps the counter so scheduleBackendRestart can trip the max-attempt cap.
    const backendAliveMs = backendSpawnedAt ? Date.now() - backendSpawnedAt : 0;
    if (backendAliveMs >= BACKEND_STABLE_RESET_MS) backendRestartAttempts = 0;
    scheduleBackendRestart(`unexpected exit code=${code} signal=${signal}`);
  });
}

function clearBackendRestartTimer() {
  if (!backendRestartTimer) return;
  clearTimeout(backendRestartTimer);
  backendRestartTimer = null;
}

function scheduleBackendRestart(reason) {
  if (isAppShuttingDown) return;
  if (backendRestartTimer) return;
  if (backendProc && !backendProc.killed) return;
  if (backendRestartAttempts >= BACKEND_RESTART_MAX_ATTEMPTS) {
    console.error(
      `[main] Backend exceeded ${BACKEND_RESTART_MAX_ATTEMPTS} restart attempts without a stable run — halting auto-restart to avoid a crash-loop storm. Restart manually from the tray/menu once the underlying fault is resolved.`,
    );
    return;
  }

  const delay = Math.min(
    BACKEND_RESTART_MAX_MS,
    BACKEND_RESTART_BASE_MS * Math.pow(2, Math.min(backendRestartAttempts, 5)),
  );
  backendRestartAttempts += 1;
  console.warn(`[main] Backend restart scheduled in ${delay}ms (${reason})`);

  backendRestartTimer = setTimeout(() => {
    backendRestartTimer = null;
    if (isAppShuttingDown) return;
    const backendLaunch = resolveBackendLaunch();
    if (!backendLaunch) {
      console.error("[main] Backend auto-restart failed: launch target not found.");
      return;
    }
    spawnBackendProcess(backendLaunch, "[main] Auto-restarting backend:");
  }, delay);
}

function spawnForecastProcess(forecastLaunch, logPrefix = "[main] Spawning forecast:") {
  lastForecastLaunch = {
    cmd: forecastLaunch.cmd,
    args: Array.isArray(forecastLaunch.args) ? [...forecastLaunch.args] : [],
    cwd: forecastLaunch.cwd,
  };
  clearForecastRestartTimer();
  forecastStopExpected = false;
  const stopFile = getServiceSoftStopFile("forecast");
  clearServiceSoftStopFile(stopFile);
  console.log(logPrefix, forecastLaunch.cmd, ...forecastLaunch.args);
  const extraPyPath = [
    forecastLaunch.cwd,
    path.join(app.getAppPath(), "backend"),
    path.join(app.getAppPath(), "backend", "engines", "forecast"),
    path.join(app.getAppPath(), "services"),
    app.getAppPath(),
  ].filter(Boolean).join(path.delimiter);
  forecastProc = spawn(forecastLaunch.cmd, forecastLaunch.args, {
    cwd: forecastLaunch.cwd,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PYTHONPATH: extraPyPath + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ""),
      IM_SERVICE_STOP_FILE: stopFile,
      ADSI_SERVICE_STOP_FILE: stopFile,
    },
    shell: false,
  });
  attachServiceSoftStopMeta(forecastProc, "forecast", FORECAST_SOFT_STOP_WAIT_MS);
  forecastProc.on("error", (err) => {
    console.error("[main] Forecast spawn error:", err.message);
    scheduleForecastRestart("spawn error");
  });
  forecastProc.on("spawn", () => {
    // Record spawn time; counter reset happens on a stable run (exit handler),
    // not on spawn — same crash-loop-storm guard as the backend.
    forecastSpawnedAt = Date.now();
  });
  forecastProc.on("exit", (code, signal) => {
    const expectedStop = forecastStopExpected;
    forecastStopExpected = false;
    forecastProc = null;
    if (expectedStop || isAppShuttingDown) {
      console.log("[main] Forecast stopped - code=" + code + " signal=" + signal);
      return;
    }
    console.warn("[main] Forecast exited - code=" + code + " signal=" + signal);
    const forecastAliveMs = forecastSpawnedAt ? Date.now() - forecastSpawnedAt : 0;
    if (forecastAliveMs >= FORECAST_STABLE_RESET_MS) forecastRestartAttempts = 0;
    scheduleForecastRestart(`exit code=${code} signal=${signal}`);
  });
}

/**
 * Purge stale PyInstaller _MEI* temp directories left by force-killed processes.
 * Each --onefile EXE extracts to %TEMP%\_MEI<pid>; if the process is killed
 * before cleanup the directory persists indefinitely. We attempt removal of
 * every _MEI* entry — directories still locked by a running process will
 * simply fail with EBUSY/EPERM and be skipped.
 */
function cleanStalePyInstallerTempDirs() {
  try {
    const tmpDir = os.tmpdir();
    const entries = fs.readdirSync(tmpDir).filter((n) => /^_MEI\d+$/i.test(n));
    if (entries.length === 0) return;
    let removed = 0;
    for (const name of entries) {
      try {
        fs.rmSync(path.join(tmpDir, name), { recursive: true, force: true });
        removed++;
      } catch (_) {
        // locked by running process — skip
      }
    }
    if (removed > 0) {
      console.log(`[main] Cleaned ${removed}/${entries.length} stale _MEI temp dirs`);
    }
  } catch (err) {
    console.warn("[main] _MEI cleanup skipped:", err.message);
  }
}

function startBackendProcess() {
  if (backendProc && !backendProc.killed && backendProc.exitCode === null) {
    return true;
  }
  cleanStalePyInstallerTempDirs();
  const backendLaunch = resolveBackendLaunch();
  if (!backendLaunch) {
    console.error("[main] Backend not found. Set ADSI_BACKEND_PATH or place backend executable.");
    return false;
  }
  spawnBackendProcess(backendLaunch);
  return true;
}

function startForecastProcess() {
  if (forecastProc && !forecastProc.killed) return true;
  // Crash-loop storm guard: once the restart budget is exhausted, refuse to
  // respawn — this is the single spawn choke-point shared by the restart timer
  // AND the 10s forecast mode-sync interval, so latching here stops both.
  if (forecastRestartAttempts >= FORECAST_RESTART_MAX_ATTEMPTS) {
    if (!forecastRestartHalted) {
      forecastRestartHalted = true;
      console.error(
        `[main] Forecast service halted after ${FORECAST_RESTART_MAX_ATTEMPTS} crash-restarts without a stable run. It will stay down (core dashboard unaffected) until a mode change or manual restart.`,
      );
    }
    return false;
  }
  const launch = resolveForecastLaunch();
  if (!launch) {
    console.warn("[main] Forecast service not found. Skipping day-ahead background process.");
    return false;
  }
  spawnForecastProcess(launch);
  return true;
}

function stopForecastProcess(reason = "") {
  clearForecastRestartTimer();
  forecastRestartAttempts = 0;
  forecastRestartHalted = false; // clear crash-loop latch on an intentional stop
  if (!forecastProc || forecastProc.killed) {
    forecastProc = null;
    return;
  }
  forecastStopExpected = true;
  if (reason) {
    console.log(`[main] Stopping forecast service (${reason})`);
  }
  forceKillProc(forecastProc, "forecast");
  forecastProc = null;
}

function clearForecastRestartTimer() {
  if (!forecastRestartTimer) return;
  clearTimeout(forecastRestartTimer);
  forecastRestartTimer = null;
}

function scheduleForecastRestart(reason) {
  if (isAppShuttingDown) return;
  if (forecastRestartTimer) return;
  if (forecastProc && !forecastProc.killed) return;
  // Budget exhausted — don't schedule. startForecastProcess() owns the single
  // halt log so we stay quiet here to avoid per-crash spam.
  if (forecastRestartAttempts >= FORECAST_RESTART_MAX_ATTEMPTS) return;

  const delay = Math.min(
    FORECAST_RESTART_MAX_MS,
    FORECAST_RESTART_BASE_MS * Math.pow(2, Math.min(forecastRestartAttempts, 5)),
  );
  forecastRestartAttempts += 1;
  console.warn(`[main] Forecast restart scheduled in ${delay}ms (${reason})`);

  forecastRestartTimer = setTimeout(() => {
    forecastRestartTimer = null;
    if (isAppShuttingDown) return;
    syncForecastProcessForCurrentMode().catch((err) => {
      console.warn("[main] Forecast restart sync failed:", err?.message || err);
    });
  }, delay);
}

function restartBackendProcess() {
  // T6.9 fix: cancel any pending auto-restart timer before manual restart,
  // otherwise the auto-restart could fire mid-flight and spawn a second.
  clearBackendRestartTimer();
  backendRestartAttempts = 0;
  // Kill by image name first so updated ipconfig is reloaded by a clean process.
  killImageNames(BACKEND_EXE_NAMES);

  // Best effort for currently tracked process tree.
  if (backendProc && !backendProc.killed) {
    execFile("taskkill", ["/pid", String(backendProc.pid), "/f", "/t"], { stdio: "ignore", windowsHide: true }, (err) => {
      if (err) console.warn("[main] taskkill backend pid failed:", err.message);
    });
  }
  backendProc = null;

  const backendLaunch = resolveBackendLaunch();
  if (!backendLaunch) {
    console.error("[main] Backend restart failed: launch target not found.");
    return false;
  }
  spawnBackendProcess(backendLaunch, "[main] Restarting backend:");
  return true;
}

// ─── Poll HTTP until server responds ─────────────────────────────────────────
function pollUntilReady() {
  if (serverReadyFired) return;
  const deadline = Date.now() + POLL_TIMEOUT;

  function attempt() {
    if (serverReadyFired) return;

    const req = http.get(SERVER_URL, (res) => {
      res.resume();
      onServerReady();
    });

    req.on("error", () => {
      if (Date.now() < deadline) setTimeout(attempt, POLL_INTERVAL);
      else {
        console.error("[main] Poll timed out - backend did not become ready.");
        showLoadingErrorMessage(
          "Backend startup timed out. If this is the first run after an update, database maintenance may still be finishing. Please retry.",
        );
      }
    });

    req.setTimeout(1200, () => {
      req.destroy();
      if (Date.now() < deadline) setTimeout(attempt, POLL_INTERVAL);
    });
  }

  setTimeout(attempt, 1000); // give server a 1s head-start
}

// ─── Open Main Window ─────────────────────────────────────────────────────────
function onServerReady() {
  if (serverReadyFired) return;
  serverReadyFired = true;
  registerShortcutsOnce();
  console.log("[main] Server ready - opening hidden main window");
  updateLoadingStartupState({
    step: 3,
    progress: 68,
    text: "Server ready. Loading dashboard shell...",
  });
  createMainWindow();
}

function createMainWindow() {
  mainPageLoadedOnce = false;
  mainRendererReady = false;
  initialLoadRetries = 0;
  if (initialLoadRetryTimer) {
    clearTimeout(initialLoadRetryTimer);
    initialLoadRetryTimer = null;
  }
  clearMainRendererReadyTimer();

  mainWin = new BrowserWindow({
    width: 1600,
    height: 960,
    icon: APP_ICON,
    minWidth: 1100,
    minHeight: 680,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: "#080c14",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });

  if (IS_DEV && process.env.OPEN_DEVTOOLS === "true") {
    mainWin.webContents.openDevTools({ mode: "detach" });
  }

  loadMainUrlWithRetry();

  mainWin.webContents.on("did-finish-load", () => {
    const loadedUrl = String(mainWin?.webContents.getURL() || "");
    const isAppPage = loadedUrl.startsWith(`${SERVER_URL}/`) || loadedUrl === SERVER_URL || loadedUrl.startsWith("file://");
    if (!isAppPage) {
      console.warn("[main] Ignoring non-app load:", loadedUrl || "(empty)");
      return;
    }
    if (!mainPageLoadedOnce) console.log("[main] Page loaded OK - waiting for renderer startup");
    mainPageLoadedOnce = true;
    initialLoadRetries = 0;
    if (initialLoadRetryTimer) {
      clearTimeout(initialLoadRetryTimer);
      initialLoadRetryTimer = null;
    }
    if (loadedUrl.includes("login.html") || loadedUrl.endsWith("/login")) {
      mainRendererReady = true;
    }
    updateLoadingStartupState({
      step: 4,
      progress: 78,
      text: "Loading dashboard data...",
    });
    armMainRendererReadyTimer();
    revealMainWindowIfReady();
  });
  mainWin.webContents.on("did-fail-load", (e, code, desc) => {
    if (code === -3) return; // ERR_ABORTED during navigation is expected
    console.error("[main] did-fail-load:", code, desc);
    if (mainPageLoadedOnce) return;
    if (initialLoadRetries >= INITIAL_LOAD_RETRY_MAX) {
      console.error("[main] Initial load retries exhausted.");
      showLoadingErrorMessage(
        "Unable to connect to the local dashboard backend on localhost:3500.\nPlease verify InverterCoreService.exe and retry.",
      );
      return;
    }
    initialLoadRetries += 1;
    if (initialLoadRetryTimer) clearTimeout(initialLoadRetryTimer);
    initialLoadRetryTimer = setTimeout(() => {
      loadMainUrlWithRetry();
    }, INITIAL_LOAD_RETRY_DELAY);
  });

  mainWin.on("closed", () => {
    hikvisionNativePlayer.stop().catch(() => {});
    clearMainRendererReadyTimer();
    if (initialLoadRetryTimer) {
      clearTimeout(initialLoadRetryTimer);
      initialLoadRetryTimer = null;
    }
    mainWin = null;
    allowMainWindowClose = false;
    quit();
  });

  mainWin.on("close", (e) => {
    if (isAppShuttingDown || allowMainWindowClose) return;
    const serviceCfg = loadServerServiceConfig();
    const connection = readLoginConnectionContext();
    const localServerEligible =
      connection.operationMode !== "remote" && !connection.remoteGatewayUrl;
    if (serviceCfg.keepInBackground && localServerEligible && isLocalServerRunning()) {
      e.preventDefault();
      ensureBackgroundTray();
      mainWin.hide();
      return;
    }
    // Tentative graceful marker, written BEFORE the synchronous confirm
    // dialog blocks the close handler. If Task Manager / Windows ends the
    // process while the dialog is up (user gives up and clicks "End Task"
    // because the prompt looks stuck, or release-tooling taskkills the
    // running app), the marker is already on disk and the next boot will
    // classify the prior run as graceful instead of false-flagging
    // "Unexpected prior shutdown". Rescinded below on Cancel so a real
    // later crash is still detectable.
    const _tentativeMarker = recordEarlyExitMarker(
      SHUTDOWN_REASONS.BEFORE_QUIT,
      SHUTDOWN_INITIATORS.USER,
      { earlyExitPath: "mainwin-close-prompt", tentative: true },
    );
    const choice = dialog.showMessageBoxSync(mainWin, {
      type: "question",
      buttons: ["Cancel", "Exit"],
      defaultId: 0,
      cancelId: 0,
      title: "Confirm Exit",
      message: "Exit Inverter Dashboard?",
      detail: "This will stop local services and close the dashboard.",
    });
    if (choice !== 1) {
      e.preventDefault();
      if (_tentativeMarker) rescindEarlyExitMarker();
      return;
    }
    allowMainWindowClose = true;
  });

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    // T6.5 fix: only allow http/https/mailto through shell.openExternal.
    // Without this whitelist, a compromised renderer could request
    // file:///c:/windows/system32, javascript:, or custom-protocol URLs
    // that the OS hands off to potentially dangerous handlers.
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch((err) => {
        console.warn("[main] openExternal error:", err?.message || err);
      });
    } else {
      console.warn("[main] blocked openExternal for non-whitelisted URL:", String(url || "").slice(0, 200));
    }
    return { action: "deny" };
  });
}

// T6.5 fix: scheme whitelist used anywhere we hand a URL off to the OS
// via shell.openExternal.  Accepts http://, https://, mailto: only.
function isSafeExternalUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:";
  } catch (_) {
    return false;
  }
}

function loadMainUrlWithRetry() {
  if (!mainWin || mainWin.isDestroyed()) return;
  const doLoad = () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    if (isLocalServerRunning()) {
      mainWin.loadURL(SERVER_URL).catch((err) => {
        console.warn("[main] loadURL error, falling back to local HTML:", err.message);
        mainWin.loadFile(path.join(PUBLIC_DIR, "index.html")).catch(console.error);
      });
    } else {
      mainWin.loadFile(path.join(PUBLIC_DIR, "index.html")).catch(console.error);
    }
  };
  if (mainWin.__cacheClearedOnce) {
    doLoad();
    return;
  }
  mainWin.__cacheClearedOnce = true;
  const ses = mainWin.webContents?.session || null;
  if (!ses) {
    doLoad();
    return;
  }
  Promise.resolve()
    .then(() => ses.clearCache())
    .then(() => ses.clearStorageData({ storages: ["cache"] }))
    .catch((err) => {
      console.warn("[main] cache clear before load failed:", err.message);
    })
    .finally(doLoad);
}

function focusWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openTopologyWindow() {
  if (topologyWin && !topologyWin.isDestroyed()) {
    focusWindow(topologyWin);
    return;
  }
  topologyWin = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    icon: APP_ICON,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: "#080c14",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });
  topologyWin.loadURL(TOPOLOGY_URL).catch((err) => {
    console.error("[main] load topology error:", err.message);
  });
  topologyWin.once("ready-to-show", () => {
    focusWindow(topologyWin);
    broadcastLicenseStatus(true);
  });
  topologyWin.on("closed", () => {
    topologyWin = null;
  });
}

function openGlobalConfigWindow() {
  if (globalConfigWin && !globalConfigWin.isDestroyed()) {
    focusWindow(globalConfigWin);
    return;
  }
  globalConfigWin = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    icon: APP_ICON,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: "#080c14",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });
  globalConfigWin.loadURL(GLOBAL_CONFIG_URL).catch((err) => {
    console.error("[main] load ip-config error:", err.message);
  });
  globalConfigWin.once("ready-to-show", () => {
    focusWindow(globalConfigWin);
    broadcastLicenseStatus(true);
  });
  globalConfigWin.on("closed", () => {
    globalConfigWin = null;
  });
}

// ── Pop-out window factory ───────────────────────────────────────────────────
// Opens a secondary BrowserWindow showing a single dashboard page in popout
// mode (?popout=<page>). Reuses the same SPA + Express server (port 3500),
// same preload.js, and the same WebSocket feed — no extra polling or DB impact.
// Pattern mirrors openGlobalConfigWindow() / calibrator window exactly.
const POPOUT_ALLOWED = ["analytics", "alarms", "forecast", "igbt-health", "camera"];
const POPOUT_TITLES = {
  analytics:     "ADSI \u2013 Analytics",
  alarms:        "ADSI \u2013 Alarms",
  forecast:      "ADSI \u2013 Forecast",
  "igbt-health": "ADSI \u2013 Asset Health",
  camera:        "ADSI \u2013 Tapo Camera Viewer",
};

function openPopoutWindow(page, theme) {
  if (!POPOUT_ALLOWED.includes(page)) {
    console.warn("[main] openPopoutWindow: rejected page:", page);
    return;
  }
  const existing = popoutWindows.get(page);
  if (existing && !existing.isDestroyed()) {
    focusWindow(existing);
    return;
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: page === "camera" ? 480 : 900,
    minHeight: page === "camera" ? 300 : 600,
    icon: APP_ICON,
    title: POPOUT_TITLES[page] || "Inverter Dashboard",
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: "#080c14",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });

  let popoutUrl = `${SERVER_URL}/?popout=${encodeURIComponent(page)}`;
  const themeStr = String(theme || "").trim();
  if (/^[a-z]+$/.test(themeStr)) {
    popoutUrl += `&theme=${encodeURIComponent(themeStr)}`;
  }
  win.loadURL(popoutUrl).catch((err) =>
    console.error(`[main] popout load error (${page}):`, err.message)
  );
  win.once("ready-to-show", () => {
    focusWindow(win);
  });
  win.on("closed", () => {
    popoutWindows.delete(page);
    // If a camera popout just closed, tell the main window to resume its camera.
    if (page === "camera" && mainWin && !mainWin.isDestroyed()) {
      try { mainWin.webContents.send("camera-popout-closed"); } catch (_) {}
    }
  });
  popoutWindows.set(page, win);
  // If this is a camera popout, tell the main window to pause its camera player
  // so go2rtc can accept the popout's connection (only one client per stream).
  if (page === "camera" && mainWin && !mainWin.isDestroyed()) {
    try { mainWin.webContents.send("camera-popout-opened"); } catch (_) {}
  }
}

function terminateCalibratorProcesses() {
  try {
    if (calibratorPyProc && !calibratorPyProc.killed) {
      calibratorPyProc.kill("SIGTERM");
      setTimeout(() => {
        if (calibratorPyProc && !calibratorPyProc.killed) {
          calibratorPyProc.kill("SIGKILL");
        }
      }, 2000);
    }
  } catch (err) {
    console.warn("[main] Failed to kill calibratorPyProc:", err?.message);
  }
  try {
    if (calibratorNodeProc && !calibratorNodeProc.killed) {
      calibratorNodeProc.kill("SIGTERM");
      setTimeout(() => {
        if (calibratorNodeProc && !calibratorNodeProc.killed) {
          calibratorNodeProc.kill("SIGKILL");
        }
      }, 2000);
    }
  } catch (err) {
    console.warn("[main] Failed to kill calibratorNodeProc:", err?.message);
  }
  // Also try to kill by exe name
  try {
    execFileSync("taskkill", ["/F", "/IM", "CalibratorService.exe"], {
      timeout: 5000,
      windowsHide: true,
    });
  } catch (_) {}
}

function spawnCalibratorPython() {
  if (calibratorPyProc && !calibratorPyProc.killed) {
    return calibratorPyProc;
  }

  const resourcesPath = process.resourcesPath || path.join(__dirname, "..", "resources");
  const exePath = path.join(resourcesPath, "backend", "CalibratorService.exe");
  // Root-level shim (mirrors root InverterCoreService.py) so `python CalibratorService.py`
  // runs with repo root on sys.path and `services.calibrator_app` resolves.
  const scriptPath = path.join(__dirname, "..", "CalibratorService.py");

  // Try packaged EXE first, fall back to script
  const usePy = !app.isPackaged || !fs.existsSync(exePath);
  const command = usePy ? "python" : exePath;
  const args = usePy ? [scriptPath] : [];

  try {
    calibratorPyProc = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    _attachCalibratorLogging(calibratorPyProc, "python");

    calibratorPyProc.on("error", (err) => {
      console.error("[main] calibrator python spawn error:", err?.message);
    });

    calibratorPyProc.on("exit", (code, signal) => {
      console.log(`[main] calibrator python exited: code=${code} signal=${signal}`);
      calibratorPyProc = null;
    });

    console.log(`[main] spawned calibrator python (PID ${calibratorPyProc.pid})`);
    return calibratorPyProc;
  } catch (err) {
    console.error("[main] Failed to spawn calibrator python:", err?.message);
    return null;
  }
}

function spawnCalibratorNode() {
  if (calibratorNodeProc && !calibratorNodeProc.killed) {
    return calibratorNodeProc;
  }

  const resourcesPath = process.resourcesPath || path.join(__dirname, "..", "resources");
  // In packaged app, Node and bundled modules are in resources/app.asar
  const nodeEntry = app.isPackaged
    ? path.join(resourcesPath, "app.asar", CALIBRATOR_NODE_ENTRY)
    : path.join(__dirname, "..", CALIBRATOR_NODE_ENTRY);

  // ALWAYS run the calibrator Node via Electron's own runtime
  // (process.execPath + ELECTRON_RUN_AS_NODE=1), in BOTH dev and packaged.
  // Rationale: better-sqlite3 is built for the Electron ABI (the dashboard
  // needs it). Spawning with a system `node` (different NODE_MODULE_VERSION)
  // makes calibratorDb's require('better-sqlite3') throw immediately, the
  // Node server never binds :3600, and the readiness wait times out
  // ("Calibrator Startup Failed"). Electron-as-Node is ABI-matched and
  // asar-aware, so this is correct for dev and packaged alike.
  const command = process.execPath;
  const args = [nodeEntry, "--port", String(CALIBRATOR_NODE_PORT)];
  const spawnOpts = {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  };

  try {
    calibratorNodeProc = spawn(command, args, spawnOpts);

    _attachCalibratorLogging(calibratorNodeProc, "node");

    calibratorNodeProc.on("error", (err) => {
      console.error("[main] calibrator node spawn error:", err?.message);
    });

    calibratorNodeProc.on("exit", (code, signal) => {
      console.log(`[main] calibrator node exited: code=${code} signal=${signal}`);
      calibratorNodeProc = null;
    });

    console.log(`[main] spawned calibrator node (PID ${calibratorNodeProc.pid})`);
    return calibratorNodeProc;
  } catch (err) {
    console.error("[main] Failed to spawn calibrator node:", err?.message);
    return null;
  }
}

async function waitForCalibratorReady(timeoutMs = CALIBRATOR_READINESS_TIMEOUT_MS) {
  const startTime = Date.now();
  const pollInterval = 250;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const res = await new Promise((resolve) => {
        const req = http.get(
          `http://127.0.0.1:${CALIBRATOR_NODE_PORT}/health`,
          { timeout: 1500 },
          (response) => {
            let body = "";
            response.on("data", (chunk) => { body += chunk; });
            response.on("end", () => {
              try {
                const json = JSON.parse(body);
                resolve(json?.ok === true);
              } catch (_) {
                resolve(response.statusCode === 200);
              }
            });
          }
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });
      });

      if (res) return true;
    } catch (_) {}

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return false;
}

function openCalibratorWindow(theme = "") {
  if (calibratorWin && !calibratorWin.isDestroyed()) {
    focusWindow(calibratorWin);
    return;
  }

  calibratorWin = new BrowserWindow({
    width: 1400,
    height: 850,
    minWidth: 1000,
    minHeight: 700,
    icon: calibratorIconPath("ico"),
    title: "ADSI Utility Tool",
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: "#080c14",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });

  // Load the dashboard SPA in calibrator-only mode: the ?calibrator=1 query
  // param triggers a boot hook in app.js that routes straight to the Field
  // Calibration page and hides the fleet dashboard chrome (sidebar/header).
  // An optional &theme= carries the dashboard's current theme across the
  // origin boundary (calibrator window is :3600, separate localStorage).
  let calibratorUrl = `http://127.0.0.1:${CALIBRATOR_NODE_PORT}/?calibrator=1`;
  const themeStr = String(theme || "").trim();
  if (/^[a-z]+$/.test(themeStr)) {
    calibratorUrl += `&theme=${encodeURIComponent(themeStr)}`;
  }
  calibratorWin.loadURL(calibratorUrl).catch((err) => {
    console.error("[main] load calibrator error:", err.message);
  });

  calibratorWin.once("ready-to-show", () => {
    focusWindow(calibratorWin);
  });

  // Mirror the dashboard's graceful-exit prompt (see mainWin "close"
  // handler) so the operator doesn't accidentally close the Utility Tool
  // mid-calibration / mid-fleet-scan. Bypassed when the parent app is
  // already shutting down (isAppShuttingDown) or when a caller has set
  // allowCalibratorClose=true (e.g. shutdown chain calling close()).
  calibratorWin.on("close", (e) => {
    if (isAppShuttingDown || allowCalibratorClose) return;
    // Same tentative-graceful-marker trick as the dashboard's mainWin close
    // handler — the synchronous dialog blocks the close path, so write the
    // marker first and rescind it on Cancel. Matters most for standalone
    // calibrator launches, which share the lifecycle dir with the dashboard.
    const _tentativeMarker = recordEarlyExitMarker(
      SHUTDOWN_REASONS.BEFORE_QUIT,
      SHUTDOWN_INITIATORS.USER,
      { earlyExitPath: "calibratorwin-close-prompt", tentative: true },
    );
    const choice = dialog.showMessageBoxSync(calibratorWin, {
      type: "question",
      buttons: ["Cancel", "Exit"],
      defaultId: 0,
      cancelId: 0,
      title: "Confirm Exit",
      message: "Exit ADSI Utility Tool?",
      detail: "This will stop the calibrator service and close the tool.",
    });
    if (choice !== 1) {
      e.preventDefault();
      if (_tentativeMarker) rescindEarlyExitMarker();
      return;
    }
    allowCalibratorClose = true;
  });

  calibratorWin.on("closed", () => {
    calibratorWin = null;
    allowCalibratorClose = false;
    // Tear down child procs when window closes
    terminateCalibratorProcesses();
  });
}

// FIX C: Helper to check if a port is in use (best-effort port probe)
async function isPortInUse(port, host = "127.0.0.1", timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

// FIX C: Cleanup stale calibrator procs before spawn
async function cleanupStaleCalibratorPorts() {
  try {
    const ports = [9200, 3600]; // Python service + Node service ports
    for (const port of ports) {
      if (await isPortInUse(port)) {
        console.log(`[main] Port ${port} still in use; killing stale CalibratorService processes`);
        try {
          execFileSync("taskkill", ["/F", "/IM", "CalibratorService.exe"], {
            timeout: 3000,
            windowsHide: true,
          });
        } catch (_) {
          // May not be running
        }
        // Also try to kill any stale Node processes listening on calibrator ports
        // (best-effort, using tasklist to find by command-line pattern)
        try {
          const { execSync } = require("child_process");
          const tasks = execSync("tasklist /V /FO CSV", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] });
          const lines = tasks.split("\n").slice(1); // skip header
          for (const line of lines) {
            const parts = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/); // CSV-aware split
            if (parts.length > 8) {
              const cmdLine = parts[8]?.toLowerCase() || "";
              if (cmdLine.includes("calibrator") || cmdLine.includes("3600")) {
                const pid = parseInt(parts[1]?.replace(/"/g, ""), 10);
                if (pid > 0) {
                  try {
                    execFileSync("taskkill", ["/pid", String(pid), "/f"], {
                      timeout: 2000,
                      windowsHide: true,
                    });
                    console.log(`[main] Killed stale calibrator process PID ${pid}`);
                  } catch (_) {
                    // already dead
                  }
                }
              }
            }
          }
        } catch (_) {
          // tasklist may not be available or fail; best-effort only
        }
      }
    }
  } catch (err) {
    console.warn("[main] cleanupStaleCalibratorPorts warning:", err.message);
    // Non-fatal; allow spawn to proceed
  }
}

async function openCalibratorWindowGuarded(theme = "") {
  // FIX C: Cleanup orphan processes and check port availability
  await cleanupStaleCalibratorPorts();

  // Kill any stale procs from a prior session (additional safety)
  try {
    execFileSync("taskkill", ["/F", "/IM", "CalibratorService.exe"], {
      timeout: 3000,
      windowsHide: true,
    });
  } catch (_) {}

  // Spawn the Python and Node calibrator services
  spawnCalibratorPython();
  spawnCalibratorNode();

  // Wait for Node to be ready
  const ready = await waitForCalibratorReady();
  if (!ready) {
    terminateCalibratorProcesses();
    const tail = _calibratorLogTail.trim().slice(-1200);
    await dialog.showErrorBox(
      "Calibrator Startup Failed",
      "The calibrator service did not become ready in time.\n\n" +
        `Full log: ${_calibratorLogPath()}\n` +
        (tail ? `\nLast output:\n${tail}` : "\n(No output was captured.)")
    );
    return false;
  }

  openCalibratorWindow(theme);
  return true;
}

// Entry point for `--calibrator` (Desktop shortcut). Brings up only the
// calibrator stack as a focused field tool. On failure or window close the
// process exits cleanly (handled in window-all-closed) instead of running
// the dashboard's heavy requestAppShutdown path.
async function startCalibratorStandalone() {
  try {
    if (process.platform === "win32") {
      app.setAppUserModelId("com.engr-m.inverter-dashboard.calibrator");
    }
    app.setName("ADSI Utility Tool");
    Menu.setApplicationMenu(null);
  } catch (_) {}

  const ok = await openCalibratorWindowGuarded();
  if (!ok) {
    // openCalibratorWindowGuarded already surfaced an error dialog.
    app.exit(1);
  }
}

function requestServerJson(method, routePath, payload, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    let body = "";
    if (payload !== undefined) {
      try {
        body = JSON.stringify(payload);
      } catch (e) {
        reject(new Error("Invalid JSON payload"));
        return;
      }
    }

    const req = http.request(
      {
        hostname: SERVER_HOST,
        port: SERVER_PORT,
        path: routePath,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          const status = Number(res.statusCode || 0);
          const ok = status >= 200 && status < 300;
          if (!raw) {
            if (ok) resolve({});
            else reject(new Error(`HTTP ${status}`));
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            if (ok) resolve(parsed);
            else reject(new Error(parsed?.error || `HTTP ${status}`));
          } catch (_) {
            if (ok) resolve({});
            else reject(new Error(`HTTP ${status}`));
          }
        });
      },
    );

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Request timeout")));
    if (body) req.write(body);
    req.end();
  });
}

async function tryGetCurrentOperationMode(timeoutMs = 1500) {
  const localMode = readOperationModeFromLocalDb();
  if (localMode) return localMode;
  try {
    const settings = await requestServerJson(
      "GET",
      "/api/settings",
      undefined,
      timeoutMs,
    );
    return sanitizeOperationModeValue(settings?.operationMode, "gateway");
  } catch {
    return null;
  }
}

async function getCurrentOperationMode(timeoutMs = 1500) {
  return (await tryGetCurrentOperationMode(timeoutMs)) || "gateway";
}

async function syncForecastProcessForCurrentMode(timeoutMs = 1500) {
  if (isAppShuttingDown || forecastModeSyncInFlight) {
    return false;
  }
  forecastModeSyncInFlight = true;
  try {
    const mode = (await tryGetCurrentOperationMode(timeoutMs)) || "gateway";
    if (mode === "remote") {
      stopForecastProcess("remote mode active");
      return false;
    }
    return startForecastProcess();
  } finally {
    forecastModeSyncInFlight = false;
  }
}

function startForecastModeSync() {
  if (forecastModeSyncTimer) return;
  syncForecastProcessForCurrentMode().catch((err) => {
    console.warn("[main] Initial forecast mode sync failed:", err?.message || err);
  });
  forecastModeSyncTimer = setInterval(() => {
    syncForecastProcessForCurrentMode().catch((err) => {
      console.warn("[main] Forecast mode sync failed:", err?.message || err);
    });
  }, FORECAST_MODE_SYNC_MS);
}

function stopForecastModeSync() {
  if (!forecastModeSyncTimer) return;
  clearInterval(forecastModeSyncTimer);
  forecastModeSyncTimer = null;
  forecastModeSyncInFlight = false;
}

async function ensureGatewayModeForWindow(featureLabel, ownerWin) {
  const mode = await getCurrentOperationMode();
  if (mode !== "remote") return true;
  const target = ownerWin && !ownerWin.isDestroyed() ? ownerWin : mainWin || undefined;
  const detail =
    "This feature is disabled in Client mode.\nSwitch Operation Mode to Gateway in Settings to access it.";
  try {
    await dialog.showMessageBox(target, {
      type: "info",
      title: `${featureLabel} Unavailable`,
      message: `${featureLabel} is not available while running in Client mode.`,
      detail,
      buttons: ["OK"],
      defaultId: 0,
      noLink: true,
    });
  } catch (_) {}
  return false;
}

async function openTopologyWindowGuarded(ownerWin) {
  const allowed = await ensureGatewayModeForWindow("Topology", ownerWin);
  if (!allowed) return false;
  openTopologyWindow();
  return true;
}

async function openGlobalConfigWindowGuarded(_ownerWin) {
  // IP Configuration is editable in BOTH gateway and remote (client) mode.
  // In remote mode the save proxies to the gateway (authoritative) and is then
  // mirrored back into the local store — see _applyIpConfigPostRemote in
  // server/index.js. The page itself shows a remote-mode banner and skips the
  // local LAN reachability scan, so the operator always knows the change lands
  // on the gateway. (Topology / Calibrator remain gateway-only.)
  openGlobalConfigWindow();
  return true;
}

function getConfigPath() {
  const portableRoot = String(getPortableDataRoot(process.env) || "").trim();
  if (portableRoot) {
    const cfgDir = path.join(portableRoot, "config");
    try {
      fs.mkdirSync(cfgDir, { recursive: true });
    } catch (_) {}
    return path.join(cfgDir, "ipconfig.json");
  }
  // This must be the same file used by the gateway/poller. AppData is a
  // renderer-local fallback and was the reason the topology grid could show
  // blank/default addresses while the real ProgramData configuration existed.
  const cfgDir = getRuntimeDataDir();
  try {
    fs.mkdirSync(cfgDir, { recursive: true });
  } catch (_) {}
  return path.join(cfgDir, "ipconfig.json");
}

function getLocalSettingsDbPath() {
  const runtimeDataDir = getRuntimeDataDir();
  if (runtimeDataDir) return path.join(runtimeDataDir, "adsi.db");

  const explicitDataDir = String(getExplicitDataDir(process.env) || "").trim();
  if (explicitDataDir) {
    return path.join(explicitDataDir, "adsi.db");
  }

  const portableRoot = String(getPortableDataRoot(process.env) || "").trim();
  if (portableRoot) {
    return path.join(portableRoot, "db", "adsi.db");
  }

  // Canonical Inverter Dashboard layout:
  // %PROGRAMDATA%\Inverter-Dashboard\db\adsi.db
  // resolvedDbDir() returns the new dir once migration is complete (or the DB
  // file already exists there). Without this check the old APPDATA DB (never
  // deleted by the zero-deletion migration) would be found first and could
  // return a stale operationMode — causing ip-config / topology to appear
  // locked even after the user switched back to gateway mode.
  try {
    const dir = resolvedDbDir();
    if (dir) return path.join(dir, "adsi.db");
  } catch (_) {}

  if (process.env.APPDATA) {
    const preferred = path.join(process.env.APPDATA, "Inverter-Dashboard", "adsi.db");
    const legacy = path.join(process.env.APPDATA, "ADSI-Dashboard", "adsi.db");
    if (fs.existsSync(preferred)) return preferred;
    if (fs.existsSync(legacy)) return legacy;
    return preferred;
  }

  try {
    return path.join(app.getPath("userData"), "..", "adsi.db");
  } catch (_) {
    return path.join(process.cwd(), "adsi.db");
  }
}

function sanitizeOperationModeValue(value, fallback = null) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "remote") return "remote";
  if (mode === "gateway") return "gateway";
  return fallback;
}

function readOperationModeFromLocalDb() {
  const dbPath = getLocalSettingsDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  let db = null;
  try {
    db = new Database(dbPath, {
      readonly: true,
      fileMustExist: true,
      timeout: 500,
    });
    db.pragma("query_only = ON");
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ? LIMIT 1")
      .get("operationMode");
    return sanitizeOperationModeValue(row?.value, null);
  } catch (_) {
    return null;
  } finally {
    try {
      db?.close();
    } catch (_) {}
  }
}

function writeOperationModeToLocalDb(mode) {
  const normalized = String(mode || "").toLowerCase() === "remote" ? "remote" : "gateway";
  const dbPath = getLocalSettingsDbPath();
  if (!dbPath) throw new Error("No settings DB path resolved");
  let db = null;
  try {
    db = new Database(dbPath, { timeout: 2000 });
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run("operationMode", normalized);
  } finally {
    try {
      db?.close();
    } catch (_) {}
  }
}

function normalizeRemoteLoginGatewayUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const candidate = /^[a-z][a-z0-9+\-.]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) return "";
    if (parsed.username || parsed.password) return "";
    if (!parsed.port) parsed.port = "3500";
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.origin.replace(/\/$/, "");
  } catch (_) {
    return "";
  }
}

function readLoginConnectionContext() {
  const context = {
    // The server host is the single source of truth for this device's role.
    // Retain the stored mode only until the host value has been read below so
    // older settings databases can be repaired without an extra user choice.
    operationMode: readOperationModeFromLocalDb() || "gateway",
    remoteGatewayUrl: "",
    remoteApiTokenConfigured: false,
  };

  const dbPath = getLocalSettingsDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) return context;
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 500 });
    db.pragma("query_only = ON");
    const rows = db
      .prepare("SELECT key, value FROM settings WHERE key IN ('remoteGatewayUrl', 'remoteApiToken')")
      .all();
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    context.remoteGatewayUrl = normalizeRemoteLoginGatewayUrl(values.remoteGatewayUrl);
    context.remoteApiTokenConfigured = Boolean(String(values.remoteApiToken || "").trim());
  } catch (_) {
    // The login screen remains usable. The gateway will surface a precise
    // remote-bridge error after sign-in if the local settings database is bad.
  } finally {
    try { db?.close(); } catch (_) {}
  }
  // A populated host always means Remote client. An empty host always means
  // Gateway/server. Do not make an operator choose a second mode switch.
  context.operationMode = context.remoteGatewayUrl ? "remote" : "gateway";
  return context;
}

function saveLoginRemoteGatewayUrl(value, tokenValue = "") {
  const context = readLoginConnectionContext();
  const rawServerHost = String(value || "").trim();
  const remoteGatewayUrl = normalizeRemoteLoginGatewayUrl(rawServerHost);
  if (rawServerHost && !remoteGatewayUrl) {
    return { ok: false, error: "Enter a valid server host URL, for example http://gateway-host:3500." };
  }
  const operationMode = remoteGatewayUrl ? "remote" : "gateway";
  const remoteApiToken = String(tokenValue || "").trim();
  if (remoteApiToken.length > 256) {
    return { ok: false, error: "Remote API token must be 256 characters or fewer." };
  }
  if (remoteGatewayUrl && !context.remoteApiTokenConfigured && !remoteApiToken) {
    return {
      ok: false,
      error: "Enter the Remote API token configured on the server before signing in as a Remote client.",
    };
  }

  const dbPath = getLocalSettingsDbPath();
  if (!dbPath) return { ok: false, error: "Local dashboard settings are unavailable." };
  let db = null;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath, { timeout: 2000 });
    db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const saveConnection = db.transaction(() => {
      db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run("remoteGatewayUrl", remoteGatewayUrl);
      db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run("operationMode", operationMode);
      // A blank login field means "keep the existing secret". Never read the
      // secret into the renderer merely to prefill a password input.
      if (remoteGatewayUrl && remoteApiToken) {
        db.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run("remoteApiToken", remoteApiToken);
      }
    });
    saveConnection();
    return {
      ok: true,
      operationMode,
      remoteGatewayUrl,
      remoteApiTokenConfigured: Boolean(
        (remoteGatewayUrl && remoteApiToken) || context.remoteApiTokenConfigured,
      ),
    };
  } catch (err) {
    return { ok: false, error: `Could not save the server host URL: ${err.message}` };
  } finally {
    try { db?.close(); } catch (_) {}
  }
}

function defaultConfig() {
  const cfg = { inverters: {}, poll_interval: {}, units: {}, losses: {} };
  for (let i = 1; i <= 27; i++) {
    cfg.inverters[i] = `192.168.1.${100 + i}`;
    cfg.poll_interval[i] = 0.05;
    cfg.units[i] = [1, 2, 3, 4];
    cfg.losses[i] = 0;
  }
  return cfg;
}

function sanitizeConfig(input) {
  const out = defaultConfig();
  const src = input && typeof input === "object" ? input : {};
  for (let i = 1; i <= 27; i++) {
    const ip = String(src?.inverters?.[i] ?? src?.inverters?.[String(i)] ?? out.inverters[i]).trim();
    const poll = Number(src?.poll_interval?.[i] ?? src?.poll_interval?.[String(i)] ?? out.poll_interval[i]);
    const unitsRaw = src?.units?.[i] ?? src?.units?.[String(i)] ?? out.units[i];
    const units = Array.isArray(unitsRaw)
      ? unitsRaw.map((n) => Number(n)).filter((n) => n >= 1 && n <= 4)
      : [1, 2, 3, 4];
    const lossRaw = Number(src?.losses?.[i] ?? src?.losses?.[String(i)] ?? 0);
    out.inverters[i] = ip;
    out.poll_interval[i] = Number.isFinite(poll) && poll >= 0.01 ? poll : 0.05;
    // Preserve explicit "all nodes disabled" as an empty array.
    out.units[i] = units.length ? [...new Set(units)] : [];
    out.losses[i] = Number.isFinite(lossRaw) && lossRaw >= 0 && lossRaw <= 100 ? lossRaw : 0;
  }
  return out;
}

function loadIpConfigFile() {
  const p = getConfigPath();
  try {
    if (!fs.existsSync(p)) {
      const cfg = defaultConfig();
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
      return cfg;
    }
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    const cfg = sanitizeConfig(parsed);
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
    return cfg;
  } catch (err) {
    console.error("[config] load failed:", err.message);
    return defaultConfig();
  }
}

function saveIpConfigFile(cfg) {
  const p = getConfigPath();
  const safe = sanitizeConfig(cfg);
  fs.writeFileSync(p, JSON.stringify(safe, null, 2), "utf8");
  return safe;
}

function checkReachable(ip, port = 80, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch (_) {}
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, ip);
  });
}

let currentAuthSession = { username: "OPERATOR", role: "operator" };

// ─── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.handle("check-login", async (_, username, password) => {
  try {
    const res = verifyLogin(username, password);
    const ok = typeof res === "object" ? !!res?.ok : !!res;
    if (ok) {
      currentAuthSession = {
        username: (typeof res === "object" && res?.username) ? res.username : (String(username).toLowerCase() === "devclard" ? "devClard" : username),
        role: (typeof res === "object" && res?.role) ? res.role : (String(username).toLowerCase() === "devclard" ? "developer" : "operator"),
      };
    }
    return res;
  } catch (err) {
    console.error("[ipc] check-login failed:", err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("login-get-connection-context", async () => readLoginConnectionContext());
ipcMain.handle("login-prepare-connection", async (_, connection) => {
  const source = connection && typeof connection === "object" ? connection : {};
  return saveLoginRemoteGatewayUrl(
    source.serverHost ?? connection,
    source.remoteApiToken,
  );
});

ipcMain.handle("get-auth-session", () => currentAuthSession);

ipcMain.handle("change-username-password", async (_, authKey, newUsername, newPassword) => {
  try {
    const keyOk = String(authKey || "") === getAdminAuthKey();
    const user = String(newUsername || "").trim();
    const pass = String(newPassword || "").trim();
    if (!keyOk || !user || !pass) return false;
    saveLoginCredentials(user, pass);
    clearRememberedLogin();
    return true;
  } catch (err) {
    console.error("[ipc] change-username-password failed:", err.message);
    return false;
  }
});

ipcMain.handle("reset-password", async (_, authKey) => {
  try {
    const keyOk = String(authKey || "") === getAdminAuthKey();
    if (!keyOk) return false;
    const def = defaultLoginCredentials();
    fs.writeFileSync(getLoginCredPath(), JSON.stringify(def, null, 2), "utf8");
    clearRememberedLogin();
    return true;
  } catch (err) {
    console.error("[ipc] reset-password failed:", err.message);
    return false;
  }
});

ipcMain.handle("login-get-remembered", async () => {
  try {
    return loadRememberedLogin();
  } catch (err) {
    console.error("[ipc] login-get-remembered failed:", err.message);
    return { remember: false };
  }
});

ipcMain.handle("login-save-remembered", async (_, payload) => {
  try {
    saveRememberedLogin(payload || {});
    return true;
  } catch (err) {
    console.error("[ipc] login-save-remembered failed:", err.message);
    return false;
  }
});

ipcMain.handle("login-clear-remembered", async () => {
  try {
    clearRememberedLogin();
    return true;
  } catch (err) {
    console.error("[ipc] login-clear-remembered failed:", err.message);
    return false;
  }
});

ipcMain.handle("get-auth-key", async () => {
  try {
    return getAdminAuthKey();
  } catch (err) {
    console.error("[ipc] get-auth-key failed:", err.message);
    return null;
  }
});

ipcMain.handle("license-get-status", async () => {
  try {
    return buildLicensePublicStatus();
  } catch (err) {
    console.error("[ipc] license-get-status failed:", err.message);
    return {
      valid: false,
      source: "trial",
      code: "license_error",
      lifetime: false,
      expiresAt: null,
      expiresAtIso: null,
      msLeft: null,
      daysLeft: null,
      remainingText: "",
      nearExpiry: false,
      message: "Unable to read license status.",
    };
  }
});

ipcMain.handle("license-upload", async () => {
  try {
    const uploaded = await promptLicenseUpload(mainWin || loginWin || undefined);
    if (!uploaded.ok) {
      if (uploaded.canceled) {
        appendLicenseAudit("license_upload_cancelled", "User cancelled license upload dialog.", "warning");
      } else {
        appendLicenseAudit("license_upload_failed", uploaded.error || "License upload failed.", "error");
      }
      return uploaded;
    }
    broadcastLicenseStatus(true);
    return {
      ok: true,
      path: uploaded.path || "",
      status: buildLicensePublicStatus(),
    };
  } catch (err) {
    appendLicenseAudit("license_upload_failed", err.message || "License upload failed.", "error");
    return { ok: false, error: err.message || "License upload failed." };
  }
});

ipcMain.handle("license-get-audit", async () => {
  try {
    return { ok: true, rows: getLicenseAuditRows() };
  } catch (err) {
    return { ok: false, error: err.message || "Failed to load license audit.", rows: [] };
  }
});

ipcMain.handle("license-get-fingerprint", () => {
  try {
    return { ok: true, fingerprint: getDeviceFingerprint() };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("app-update-get-state", async () => {
  try {
    return buildPublicAppUpdateState();
  } catch (err) {
    return {
      ...buildPublicAppUpdateState(),
      status: "error",
      message: `Unable to read updater state: ${err.message}`,
      error: String(err.message || "Unable to read updater state"),
    };
  }
});

ipcMain.handle("app-update-check", async () => {
  const state = await checkForAppUpdates({ manual: true });
  return { ok: state.status !== "error", state };
});

ipcMain.handle("app-update-download", async () => {
  return downloadAppUpdate();
});

ipcMain.handle("app-update-install", async () => {
  return installAppUpdateNow();
});

ipcMain.handle("app-update-set-auto-download", async (_, enabled) => {
  const value = setAutoDownloadPref(enabled);
  broadcastAppUpdateState();
  return { ok: true, autoDownload: value };
});

ipcMain.handle("app-update-set-auto-install-overnight", async (_, enabled) => {
  const value = setAutoInstallOvernightPref(enabled);
  broadcastAppUpdateState();
  return { ok: true, autoInstallOvernight: value };
});

ipcMain.handle("app-restart", async () => {
  try {
    requestAppShutdown({
      reason: "manual app restart",
      action: { type: "relaunch" },
    }).catch((err) => {
      console.error("[main] restart shutdown failed:", err?.message || err);
      appShutdownBypassQuit = true;
      app.exit(1);
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.on("login-success", async () => {
  if (hasAuthenticated) return;
  const status = buildLicensePublicStatus();
  if (!status.valid) {
    const ok = await ensureLicenseAtStartup();
    if (!ok) {
      // Same false-positive avoidance as the startup license-cancel path.
      recordEarlyExitMarker(
        SHUTDOWN_REASONS.BEFORE_QUIT,
        SHUTDOWN_INITIATORS.USER,
        { earlyExitPath: "license-login-recheck-cancel" },
      );
      app.exit(0);
      return;
    }
  }
  hasAuthenticated = true;
  showLoadingWindow();
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.close();
    loginWin = null;
  }
  broadcastLicenseStatus(true);
  await startAfterLogin();
});

ipcMain.on("window-minimize", () => mainWin?.minimize());
ipcMain.on("window-maximize", () => {
  if (!mainWin) return;
  mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize();
});
ipcMain.on("window-close", () => {
  const serviceCfg = loadServerServiceConfig();
  const connection = readLoginConnectionContext();
  const localServerEligible =
    connection.operationMode !== "remote" && !connection.remoteGatewayUrl;
  if (serviceCfg.keepInBackground && localServerEligible && isLocalServerRunning() && mainWin) {
    ensureBackgroundTray();
    mainWin.hide();
    return;
  }
  quit();
});
ipcMain.on("open-logs-folder", (_, folder) => {
  if (folder) shell.openPath(folder).catch(console.error);
});

// ─── Server Lifecycle Management ───────────────────────────────────────────
function getServerServiceConfigPath() {
  // Keep machine-level service behavior with the rest of the dashboard's
  // canonical runtime state, not in a per-Windows-user Electron profile.
  // The parent of getRuntimeDataDir() is ProgramData\\Inverter-Dashboard for
  // normal installs and follows explicit/portable data-root overrides.
  return path.join(path.dirname(getRuntimeDataDir()), "server-service-config.json");
}

function getLegacyServerServiceConfigPath() {
  try {
    return path.join(app.getPath("userData"), "server-service-config.json");
  } catch (_) {
    return "";
  }
}

function normalizeServerServiceConfig(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    keepInBackground: source.keepInBackground === true,
    autoStart: source.autoStart === true,
  };
}

function readServerServiceConfigFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return normalizeServerServiceConfig(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (err) {
    console.warn("[server-service] config read failed:", err.message);
    return null;
  }
}

function loadServerServiceConfig() {
  const canonical = readServerServiceConfigFile(getServerServiceConfigPath());
  if (canonical) return canonical;
  // Read the previous per-user location once for a seamless upgrade. A later
  // explicit save migrates it atomically into the canonical runtime root.
  const legacy = readServerServiceConfigFile(getLegacyServerServiceConfigPath());
  if (legacy) return legacy;
  return { keepInBackground: false, autoStart: false };
}

function saveServerServiceConfig(cfg) {
  try {
    const p = getServerServiceConfigPath();
    const current = loadServerServiceConfig();
    const updated = normalizeServerServiceConfig({ ...current, ...cfg });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const temp = `${p}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, JSON.stringify(updated, null, 2), "utf8");
    fs.renameSync(temp, p);
    return { ok: true, config: updated, path: p };
  } catch (err) {
    console.warn("[server-service] config save failed:", err.message);
    return { ok: false, error: err.message };
  }
}

function isLocalServerRunning() {
  const auxiliary = readAuxiliaryGatewayServiceStatus();
  return Boolean(
    serverReadyFired ||
    embeddedServerStarted ||
    (backendProc && !backendProc.killed) ||
    (webProc && !webProc.killed) ||
    (forecastProc && !forecastProc.killed) ||
    auxiliary.go2rtc?.running ||
    auxiliary.hikvision?.running
  );
}

function runServerLifecycleOperation(operation) {
  const run = serverLifecycleOperation.then(operation, operation);
  // Preserve serialization after a failure while returning the original
  // result to the caller.
  serverLifecycleOperation = run.catch(() => {});
  return run;
}

function destroyBackgroundTray() {
  if (!backgroundTray) return;
  try { backgroundTray.destroy(); } catch (_) {}
  backgroundTray = null;
}

function restoreBackgroundDashboard() {
  if (!mainWin || mainWin.isDestroyed()) {
    if (hasAuthenticated && serverReadyFired) createMainWindow();
    return;
  }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function ensureBackgroundTray() {
  if (backgroundTray || !app.isReady()) return;
  try {
    backgroundTray = new Tray(APP_ICON);
    backgroundTray.setToolTip("Inverter Dashboard local services are running");
    backgroundTray.setContextMenu(Menu.buildFromTemplate([
      { label: "Show Dashboard", click: restoreBackgroundDashboard },
      {
        label: "Stop Local Services",
        click: async () => {
          await runServerLifecycleOperation(() => stopLocalServerServices());
          restoreBackgroundDashboard();
        },
      },
      { type: "separator" },
      {
        label: "Exit Dashboard",
        click: () => {
          destroyBackgroundTray();
          requestAppShutdown({ reason: "background tray exit", action: { type: "quit" } }).catch((err) => {
            console.error("[main] tray exit failed:", err?.message || err);
          });
        },
      },
    ]));
    backgroundTray.on("double-click", restoreBackgroundDashboard);
  } catch (err) {
    console.warn("[main] Could not create background-service tray:", err.message);
  }
}

function probeLoopbackService(port, requestPath) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: requestPath, timeout: 900 },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      },
    );
    req.once("error", () => resolve(false));
    req.once("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function probeTelemetryEngine() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: TELEMETRY_ENGINE_PORT, path: "/health", timeout: 900 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          let payload = null;
          try { payload = JSON.parse(body); } catch (_) {}
          const reachable = res.statusCode >= 200 && res.statusCode < 300;
          resolve({
            reachable,
            healthy: reachable && payload?.status === "ok" && payload?.stale !== true,
            stale: payload?.stale === true,
            connectedInverters: Number(payload?.connected_inverter_count || 0),
            configuredInverters: Number(payload?.configured_inverter_count || 0),
            newestFrameAgeMs: Number(payload?.newest_frame_age_ms || 0),
          });
        });
      },
    );
    req.once("error", () => resolve({ reachable: false, healthy: false, stale: true }));
    req.once("timeout", () => {
      req.destroy();
      resolve({ reachable: false, healthy: false, stale: true });
    });
  });
}

async function readLocalServiceHealth() {
  const [web, telemetry] = await Promise.all([
    probeLoopbackService(SERVER_PORT, "/api/health"),
    probeTelemetryEngine(),
  ]);
  return { web, telemetry };
}

async function waitForLocalServiceHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let health = await readLocalServiceHealth();
  while (Date.now() < deadline && !(health.web && health.telemetry.healthy)) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    health = await readLocalServiceHealth();
  }
  return health;
}

ipcMain.handle("server:get-status", async () => {
  const cfg = loadServerServiceConfig();
  const connection = readLoginConnectionContext();
  const operationMode = connection.operationMode;
  const serverStartBlocked =
    operationMode === "remote" || Boolean(connection.remoteGatewayUrl);
  // A ChildProcess object can remain non-null after a rapid service failure.
  // Report real loopback availability to the operator rather than claiming a
  // service is active merely because Electron attempted to launch it.
  const health = await readLocalServiceHealth();
  const auxiliary = readAuxiliaryGatewayServiceStatus();
  const fullyHealthy = health.web && health.telemetry.healthy;
  return {
    ok: true,
    // "RUNNING" means the complete local data path is healthy. A web-only
    // process is degraded, not a successfully running local server.
    running: !serverStartBlocked && fullyHealthy,
    state: serverStartBlocked
      ? "remote"
      : fullyHealthy ? "running" : health.web ? "degraded" : "stopped",
    port: 3500,
    operationMode,
    serverStartBlocked,
    remoteGatewayUrl: connection.remoteGatewayUrl,
    serverStartBlockReason: serverStartBlocked
      ? "A Server Host URL is configured. This device is a Remote client and local polling is locked. Clear the Server Host URL, then restart the dashboard."
      : "",
    keepInBackground: cfg.keepInBackground,
    autoStart: cfg.autoStart,
    services: {
      web: health.web,
      telemetry: health.telemetry.healthy,
      // The forecast worker is a scheduled background process, not an HTTP
      // service. Its state is therefore process-supervision state only.
      forecast: Boolean(forecastProc && !forecastProc.killed),
      go2rtc: Boolean(auxiliary.go2rtc?.running),
      hikvision: Boolean(auxiliary.hikvision?.running),
    },
    telemetry: health.telemetry,
    auxiliary,
  };
});

ipcMain.handle("server:start", async () => {
  return runServerLifecycleOperation(async () => {
    console.log("[main] Manual server start requested from UI");
    try {
    const connection = readLoginConnectionContext();
    const operationMode = connection.operationMode;
    if (operationMode === "remote" || connection.remoteGatewayUrl) {
      return {
        ok: false,
        operationMode,
        serverStartBlocked: true,
        error: "Local polling is locked because a Server Host URL is configured. Clear the Server Host URL, then restart the dashboard before starting local services.",
      };
    }
    const existing = await readLocalServiceHealth();
    if (existing.web && existing.telemetry.healthy) {
      return {
        ok: true,
        running: true,
        port: 3500,
        operationMode,
        telemetryStarted: true,
        telemetry: existing.telemetry,
        alreadyRunning: true,
      };
    }
    // A child can remain alive while its /health report is stale. Stop the
    // tracked process first so Start performs a real recovery instead of
    // merely waiting beside a wedged telemetry engine.
    if (backendProc && !backendProc.killed && backendProc.exitCode === null) {
      clearBackendRestartTimer();
      backendStopExpected = true;
      const trackedBackend = backendProc;
      backendProc = null;
      await stopTrackedProcess(trackedBackend, "backend");
    }
    // startServer owns the complete launch sequence. Starting children here
    // as well used to create duplicate backend launches and a false success
    // message before either port had been verified.
    const launched = startServer(0, false);
    if (!launched) {
      return { ok: false, operationMode, error: serverBootError || "Local web service could not be started." };
    }
    const health = await waitForLocalServiceHealth();
    const ready = health.web && health.telemetry.healthy;
    return {
      ok: ready,
      running: health.web,
      port: 3500,
      operationMode,
      telemetryStarted: health.telemetry.healthy,
      telemetry: health.telemetry,
      error: ready
        ? ""
        : "Services were launched but did not become healthy within 15 seconds. Check the lifecycle status and boot log.",
    };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
});

ipcMain.handle("server:stop", async () => {
  return runServerLifecycleOperation(async () => {
    console.log("[main] Manual server stop requested from UI");
    try {
    await stopLocalServerServices();
    const health = await readLocalServiceHealth();
    const auxiliary = readAuxiliaryGatewayServiceStatus();
    return {
      ok: !health.web && !health.telemetry.reachable && !auxiliary.go2rtc?.running && !auxiliary.hikvision?.running,
      running: false,
      auxiliary,
    };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
});

ipcMain.handle("server:set-background", async (_, enabled) => {
  const connection = readLoginConnectionContext();
  if (connection.operationMode === "remote" || connection.remoteGatewayUrl) {
    return { ok: false, error: "Background local-server mode is unavailable while a Server Host URL is configured." };
  }
  return saveServerServiceConfig({ keepInBackground: Boolean(enabled) });
});

ipcMain.handle("server:set-auto-start", async (_, enabled) => {
  const connection = readLoginConnectionContext();
  if (connection.operationMode === "remote" || connection.remoteGatewayUrl) {
    return { ok: false, error: "Auto-start local services is unavailable while a Server Host URL is configured." };
  }
  return saveServerServiceConfig({ autoStart: Boolean(enabled) });
});

ipcMain.on("open-topology-window", async (event) => {
  const ownerWin = BrowserWindow.fromWebContents(event.sender) || null;
  await openTopologyWindowGuarded(ownerWin);
});
ipcMain.on("open-ip-config-window", async (event) => {
  const ownerWin = BrowserWindow.fromWebContents(event.sender) || null;
  await openGlobalConfigWindowGuarded(ownerWin);
});
ipcMain.on("open-calibrator", async (event, theme) => {
  if (_calibratorSpawnInProgress) return;
  if (calibratorWin && !calibratorWin.isDestroyed()) {
    focusWindow(calibratorWin);
    return;
  }
  _calibratorSpawnInProgress = true;
  try {
    await openCalibratorWindowGuarded(theme);
  } finally {
    _calibratorSpawnInProgress = false;
  }
});
ipcMain.on("open-popout-window", (event, { page, theme } = {}) => {
  openPopoutWindow(page, theme);
});
ipcMain.on("camera-popout-ready", () => {
  // Popout renderer signals it has successfully started the camera stream.
  // Nothing extra needed in main — just an acknowledgement hook for future use.
});

function getHikvisionNativeConfig() {
  if (
    embeddedServerStarted &&
    embeddedServerModule &&
    typeof embeddedServerModule.getHikvisionNativeConfig === "function"
  ) {
    return embeddedServerModule.getHikvisionNativeConfig();
  }
  const manager = require("../server/hikvisionManager");
  return manager.loadLocalConfigFallback() || manager.defaults();
}

function getTrustedHikvisionOwner(event) {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const frameUrl = String(event.senderFrame?.url || event.sender.getURL() || "");
  const isTrusted = frameUrl.startsWith(`${SERVER_URL}/`) || frameUrl === SERVER_URL || frameUrl.startsWith("file://");
  if (!owner || owner.isDestroyed() || !isTrusted) {
    throw new Error("Untrusted Hikvision native player request");
  }
  return owner;
}

function notifyHikvisionNativeViewerRequester(channel) {
  const requester = hikvisionNativeViewerRequester;
  if (!requester || requester.isDestroyed()) return;
  try { requester.send(channel); } catch (_) {}
}

async function closeHikvisionNativeViewer(options = {}) {
  const win = hikvisionNativeViewerWin;
  if (!win || win.isDestroyed()) return { ok: true, already: true };
  if (hikvisionNativeViewerClosing) return { ok: true, closing: true };
  hikvisionNativeViewerClosing = true;
  try {
    await hikvisionNativePlayer.stop(win).catch(() => {});
  } finally {
    allowHikvisionNativeViewerClose = true;
    try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
    allowHikvisionNativeViewerClose = false;
  }
  return { ok: true, reason: String(options.reason || "closed") };
}

function openHikvisionNativeViewer(requester, theme = "dark") {
  if (hikvisionNativeViewerWin && !hikvisionNativeViewerWin.isDestroyed()) {
    focusWindow(hikvisionNativeViewerWin);
    return { ok: true, already: true };
  }

  const safeTheme = ["dark", "light", "classic", "midnight"].includes(String(theme || "").trim())
    ? String(theme).trim()
    : "dark";
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 480,
    minHeight: 300,
    icon: APP_ICON,
    title: "ADSI \u2013 Hikvision Native Viewer",
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });
  hikvisionNativeViewerWin = win;
  hikvisionNativeViewerRequester = requester.webContents;
  hikvisionNativeViewerClosing = false;
  allowHikvisionNativeViewerClose = false;

  const onRequesterClosed = () => {
    closeHikvisionNativeViewer({ reason: "requester-closed" }).catch(() => {});
  };
  requester.once("closed", onRequesterClosed);

  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = `${SERVER_URL}/hikvision-native-viewer.html`;
    if (!String(url || "").startsWith(allowed)) event.preventDefault();
  });
  win.on("close", (event) => {
    if (allowHikvisionNativeViewerClose || isAppShuttingDown) return;
    event.preventDefault();
    closeHikvisionNativeViewer({ reason: "window-close" }).catch(() => {});
  });
  win.on("closed", () => {
    try { requester.removeListener("closed", onRequesterClosed); } catch (_) {}
    if (hikvisionNativeViewerWin === win) hikvisionNativeViewerWin = null;
    hikvisionNativeViewerClosing = false;
    allowHikvisionNativeViewerClose = false;
    if (!isAppShuttingDown) notifyHikvisionNativeViewerRequester("hikvision-native-viewer-closed");
    hikvisionNativeViewerRequester = null;
  });
  win.webContents.on("render-process-gone", () => {
    closeHikvisionNativeViewer({ reason: "renderer-gone" }).catch(() => {});
  });
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) {
      focusWindow(win);
    }
  });

  notifyHikvisionNativeViewerRequester("hikvision-native-viewer-opened");
  const url = `${SERVER_URL}/hikvision-native-viewer.html?theme=${encodeURIComponent(safeTheme)}`;
  win.loadURL(url).catch((err) => {
    console.error("[hikvision] native viewer load failed:", err.message);
    closeHikvisionNativeViewer({ reason: "load-failed" }).catch(() => {});
  });
  return { ok: true };
}

ipcMain.handle("hikvision-native-viewer-open", (event, { theme } = {}) => {
  const requester = getTrustedHikvisionOwner(event);
  return openHikvisionNativeViewer(requester, theme);
});
ipcMain.handle("hikvision-native-viewer-status", (event) => {
  const requester = getTrustedHikvisionOwner(event);
  return {
    open: Boolean(hikvisionNativeViewerWin && !hikvisionNativeViewerWin.isDestroyed()),
    requester: Boolean(hikvisionNativeViewerRequester && hikvisionNativeViewerRequester.id === requester.webContents.id),
  };
});

ipcMain.handle("hikvision-native-start", async (event, rect) => {
  const owner = getTrustedHikvisionOwner(event);
  return hikvisionNativePlayer.start(owner, getHikvisionNativeConfig(), rect);
});
ipcMain.handle("hikvision-native-update", async (event, rect) => {
  const owner = getTrustedHikvisionOwner(event);
  return hikvisionNativePlayer.update(owner, rect);
});
ipcMain.handle("hikvision-native-stop", (event) => hikvisionNativePlayer.stop(getTrustedHikvisionOwner(event)));
ipcMain.handle("hikvision-native-hide", (event) => hikvisionNativePlayer.hide(getTrustedHikvisionOwner(event)));
ipcMain.handle("hikvision-native-show", (event) => hikvisionNativePlayer.show(getTrustedHikvisionOwner(event)));
ipcMain.handle("hikvision-native-status", () => hikvisionNativePlayer.status());

ipcMain.on("show-nav-context-menu", (event, { page, theme }) => {
  const template = [
    {
      label: "Open in New Window",
      click: () => openPopoutWindow(page, theme)
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  menu.popup(BrowserWindow.fromWebContents(event.sender));
});
ipcMain.handle("create-calibrator-shortcut", async () => {
  try {
    if (process.platform !== "win32") {
      return { ok: false, error: "Desktop shortcuts are only supported on Windows." };
    }
    const desktop = app.getPath("desktop");
    const shortcutPath = path.join(desktop, "ADSI Utility Tool.lnk");
    // Sweep legacy shortcut names from previous releases. Operators who
    // installed before the "ADSI Utility Tool" rename still have the old
    // `Inverter Calibration Tool.lnk` (or earlier "Field Calibrator.lnk")
    // sitting on the desktop because Windows does NOT auto-rename existing
    // .lnk files when the source code changes its label. Without this
    // sweep, clicking "Create Utility Tool Desktop Shortcut" leaves BOTH
    // icons on the desktop — one with the old truncated text. Sweep runs
    // best-effort: file-in-use / ACL failures are silently ignored so the
    // new shortcut still gets written.
    const LEGACY_NAMES = [
      "Inverter Calibration Tool.lnk",
      "Inverter Calibration.lnk",
      "Inverter Calibrator.lnk",
      "Field Calibrator.lnk",
      "Calibrator.lnk",
    ];
    // Also clean up legacy Public Desktop copies — the dashboard installer
    // historically placed the icon there for multi-user machines.
    const publicDesktop = process.env.PUBLIC
      ? path.join(process.env.PUBLIC, "Desktop")
      : null;
    const sweepDirs = publicDesktop ? [desktop, publicDesktop] : [desktop];
    for (const dir of sweepDirs) {
      for (const legacy of LEGACY_NAMES) {
        const legacyPath = path.join(dir, legacy);
        try {
          if (fs.existsSync(legacyPath)) {
            fs.unlinkSync(legacyPath);
            console.log(`[main] swept legacy calibrator shortcut: ${legacyPath}`);
          }
        } catch (err) {
          console.warn(`[main] could not sweep ${legacyPath}: ${err.message}`);
        }
      }
    }
    const target = process.execPath;
    const iconPath = calibratorIconPath("ico");
    // Packaged: process.execPath IS the installed app .exe (Electron renamed
    // by electron-builder), so `--calibrator` alone re-launches this app
    // straight into standalone calibrator mode.
    //
    // Dev: process.execPath is the bare electron.exe, which needs the app
    // path as its first argument or it just shows Electron's default splash
    // (the "run a local app" screen). Quote it — the path may contain spaces.
    let args;
    let workingDir;
    if (app.isPackaged) {
      args = "--calibrator";
      workingDir = path.dirname(process.execPath);
    } else {
      const appPath = app.getAppPath(); // project root in dev
      args = `"${appPath}" --calibrator`;
      workingDir = appPath;
    }
    const ok = shell.writeShortcutLink(shortcutPath, "create", {
      target,
      args,
      cwd: workingDir,
      icon: iconPath,
      iconIndex: 0,
      description: "ADSI Utility Tool — isolated inverter calibration & settings viewer (no dashboard required)",
      appUserModelId: "com.engr-m.inverter-dashboard.calibrator",
    });
    if (!ok) {
      return { ok: false, error: "Windows declined to write the shortcut file." };
    }
    return { ok: true, path: shortcutPath };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
ipcMain.on("close-current-window", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  win.close();
});
ipcMain.handle("pick-folder", async (_, startPath) => {
  try {
    // T6.11 fix (Phase 3, 2026-04-14): if no caller-supplied start path is
    // given, anchor the dialog at the user's Documents folder so the user
    // doesn't land in a random cwd (e.g. system32 when launched from a
    // shortcut).  The renderer cannot sandbox the dialog to a subtree — the
    // OS dialog always allows navigation — but this prevents user confusion
    // and accidental writes into unexpected system locations.
    const trimmed = startPath && String(startPath).trim() ? String(startPath).trim() : "";
    let defaultPath = trimmed;
    if (!defaultPath) {
      try { defaultPath = app.getPath("documents"); } catch { defaultPath = undefined; }
    }
    const result = await dialog.showOpenDialog(mainWin || undefined, {
      title: "Select Export Folder",
      defaultPath: defaultPath || undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths?.length) return null;
    return result.filePaths[0];
  } catch (err) {
    console.error("[main] pick-folder failed:", err.message);
    return null;
  }
});
ipcMain.handle("save-text-file", async (_, options = {}) => {
  try {
    const targetWin = BrowserWindow.getFocusedWindow() || mainWin || undefined;
    const result = await dialog.showSaveDialog(targetWin, {
      title: String(options.title || "Save File"),
      defaultPath:
        options.defaultPath && String(options.defaultPath).trim()
          ? String(options.defaultPath).trim()
          : undefined,
      filters:
        Array.isArray(options.filters) && options.filters.length
          ? options.filters
          : [{ name: "JSON Files", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, String(options.content ?? ""), "utf8");
    return result.filePath;
  } catch (err) {
    console.error("[main] save-text-file failed:", err.message);
    return null;
  }
});
ipcMain.handle("open-text-file", async (_, options = {}) => {
  try {
    const targetWin = BrowserWindow.getFocusedWindow() || mainWin || undefined;
    const result = await dialog.showOpenDialog(targetWin, {
      title: String(options.title || "Open File"),
      properties: ["openFile"],
      filters:
        Array.isArray(options.filters) && options.filters.length
          ? options.filters
          : [{ name: "JSON Files", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePaths?.length) return null;
    const filePath = result.filePaths[0];
    return {
      path: filePath,
      content: fs.readFileSync(filePath, "utf8"),
    };
  } catch (err) {
    console.error("[main] open-text-file failed:", err.message);
    return null;
  }
});
ipcMain.handle("download-user-guide-pdf", async (event) => {
  try {
    const ownerWin = BrowserWindow.fromWebContents(event.sender) || mainWin || undefined;
    const result = await dialog.showSaveDialog(ownerWin, {
      title: "Save User Guide as PDF",
      defaultPath: path.join(
        app.getPath("documents"),
        "ADSI-Inverter-Dashboard-User-Guide.pdf"
      ),
      filters: [{ name: "PDF Document", extensions: ["pdf"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    const hidden = new BrowserWindow({
      width: 1200,
      height: 900,
      show: false,
      webPreferences: { offscreen: true },
    });
    await hidden.loadURL(`${SERVER_URL}/docs/ADSI-Dashboard-User-Guide.html`);
    // inject light-mode overrides so PDF renders with readable contrast
    await hidden.webContents.insertCSS(`
      :root {
        --bg: #ffffff !important; --surface: #f8f9fa !important; --card: #f4f5f6 !important;
        --border: #d0d5dd !important; --accent: #1a6ad4 !important; --accent2: #6f42c1 !important;
        --green: #1a7f37 !important; --yellow: #8a6914 !important; --orange: #9a4e00 !important;
        --red: #cf222e !important; --text: #1a1a1a !important; --text2: #4a4a4a !important;
        --text3: #666 !important; --link: #1a6ad4 !important;
        --tbl-head: #eaecef !important; --tbl-alt: #f6f8fa !important;
      }
      body { background: #fff !important; color: #1a1a1a !important; }
      .cover { background: linear-gradient(160deg, #f0f4ff 0%, #fff 100%) !important; min-height: auto !important; padding: 60px 24px !important; }
      .cover::before { display: none !important; }
      .cover h1 { background: none !important; -webkit-text-fill-color: #1a1a1a !important; }
      .cover-badge { background: #e8f0fe !important; border-color: #1a6ad4 !important; color: #1a6ad4 !important; }
      .cover-sub { color: #444 !important; }
      .cover-meta { color: #555 !important; }
      .cover-meta b { color: #222 !important; }
      .section-head { border-bottom-color: #d0d5dd !important; }
      .section-num { background: #e8f0fe !important; color: #1a6ad4 !important; }
      .section-head h2 { color: #1a1a1a !important; }
      h3 { color: #6f42c1 !important; }
      h4 { color: #1a1a1a !important; }
      p, li { color: #2a2a2a !important; }
      table { border: 1px solid #ccc !important; }
      thead th { background: #eaecef !important; color: #333 !important; border: 1px solid #ccc !important; }
      tbody td { border: 1px solid #ddd !important; color: #2a2a2a !important; }
      tbody tr:nth-child(even) { background: #f6f8fa !important; }
      tbody tr:hover { background: transparent !important; }
      td code, th code { background: #e8f0fe !important; color: #1a6ad4 !important; }
      .info-card { background: #f8f9fa !important; border: 1px solid #d0d5dd !important; color: #2a2a2a !important; }
      .info-card.warn { background: #fef9e7 !important; border-color: #d29922 !important; }
      .info-card.tip { background: #eafbf0 !important; border-color: #1a7f37 !important; }
      .info-card.warn .info-card-label { color: #8a6914 !important; }
      .info-card.tip .info-card-label { color: #1a7f37 !important; }
      .info-card-label { color: #333 !important; }
      .feat-item { background: #f8f9fa !important; border: 1px solid #d0d5dd !important; }
      .feat-item h4 { color: #1a1a1a !important; }
      .feat-item p { color: #4a4a4a !important; }
      .feat-item-icon { filter: grayscale(0) !important; }
      .wf-card { background: #f8f9fa !important; border: 1px solid #d0d5dd !important; }
      .wf-card h4 { color: #1a6ad4 !important; }
      .legend-chip { color: #2a2a2a !important; }
      .steps li::before { background: #e8f0fe !important; color: #1a6ad4 !important; }
      .steps li { color: #2a2a2a !important; }
      kbd { background: #eee !important; border-color: #bbb !important; color: #1a1a1a !important; }
      a { color: #1a6ad4 !important; }
      .back-top { display: none !important; }
      .guide-footer { background: #fff !important; border-top-color: #d0d5dd !important; color: #666 !important; }
      .guide-footer b { color: #333 !important; }
      .ml-highlight { background: #f0f4ff !important; border-color: #1a6ad4 !important; }
      .ml-highlight h4 { color: #1a6ad4 !important; }
      .toc h2 { color: #1a6ad4 !important; border-bottom-color: #d0d5dd !important; }
      .toc-grid a { color: #1a1a1a !important; }
      .toc-grid a .toc-num { color: #1a6ad4 !important; }
      .toc-grid a:hover { background: transparent !important; }
      h3 { font-weight: 800 !important; }
      h4 { font-weight: 700 !important; }
      .info-card-label { font-weight: 800 !important; }
      .wf-card h4 { font-weight: 800 !important; }
      table { page-break-inside: avoid !important; }
      thead { display: table-header-group !important; }
      tr { page-break-inside: avoid !important; }
      .info-card { page-break-inside: avoid !important; }
      .ml-highlight { page-break-inside: avoid !important; }
      .feat-grid { page-break-inside: avoid !important; }
      .wf-card { page-break-inside: avoid !important; }
      section { page-break-inside: avoid !important; }
      .section-head { page-break-after: avoid !important; }
      h3, h4 { page-break-after: avoid !important; }
    `);
    // allow styles and layout to settle
    await new Promise((r) => setTimeout(r, 1200));
    const pdfBuf = await hidden.webContents.printToPDF({
      printBackground: true,
      landscape: false,
      margins: { top: 0.25, bottom: 0.25, left: 0.3, right: 0.3 },
      pageSize: { width: 8.5, height: 13 },
      preferCSSPageSize: false,
    });
    hidden.close();
    fs.writeFileSync(result.filePath, pdfBuf);
    shell.showItemInFolder(result.filePath);
    return { ok: true, path: result.filePath };
  } catch (err) {
    console.error("[main] download-user-guide-pdf failed:", err.message);
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("download-credentials-pdf", async (event) => {
  try {
    const ownerWin = BrowserWindow.fromWebContents(event.sender) || mainWin || undefined;
    const result = await dialog.showSaveDialog(ownerWin, {
      title: "Save Credentials Reference as PDF",
      defaultPath: path.join(
        app.getPath("documents"),
        "ADSI-Credentials-Reference.pdf"
      ),
      filters: [{ name: "PDF Document", extensions: ["pdf"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    const hidden = new BrowserWindow({
      width: 800,
      height: 900,
      show: false,
      webPreferences: { offscreen: true },
    });
    await hidden.loadURL(`${SERVER_URL}/api/credentials-reference?authKey=admin`);
    await new Promise((r) => setTimeout(r, 800));
    const pdfBuf = await hidden.webContents.printToPDF({
      printBackground: true,
      landscape: false,
      margins: { top: 0.4, bottom: 0.4, left: 0.5, right: 0.5 },
      pageSize: "Letter",
      preferCSSPageSize: false,
    });
    hidden.close();
    fs.writeFileSync(result.filePath, pdfBuf);
    shell.showItemInFolder(result.filePath);
    return { ok: true, path: result.filePath };
  } catch (err) {
    console.error("[main] download-credentials-pdf failed:", err.message);
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("save-adsibak", async () => {
  try {
    const targetWin = BrowserWindow.getFocusedWindow() || mainWin || undefined;
    const ts = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(targetWin, {
      title: "Save Portable Backup",
      defaultPath: path.join(app.getPath("documents"), `InverterDashboard-${ts}.adsibak`),
      filters: [{ name: "ADSI Backup", extensions: ["adsibak"] }],
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  } catch (err) {
    console.error("[main] save-adsibak failed:", err.message);
    return null;
  }
});
ipcMain.handle("open-adsibak", async () => {
  try {
    const targetWin = BrowserWindow.getFocusedWindow() || mainWin || undefined;
    const result = await dialog.showOpenDialog(targetWin, {
      title: "Open Portable Backup",
      properties: ["openFile"],
      filters: [{ name: "ADSI Backup", extensions: ["adsibak"] }],
    });
    if (result.canceled || !result.filePaths?.length) return null;
    return result.filePaths[0];
  } catch (err) {
    console.error("[main] open-adsibak failed:", err.message);
    return null;
  }
});
ipcMain.handle("open-folder", async (_, folder) => {
  try {
    const target = String(folder || "").trim();
    if (!target) return false;
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }
    const err = await shell.openPath(target);
    return !err;
  } catch (e) {
    console.error("[main] open-folder failed:", e.message);
    return false;
  }
});
ipcMain.handle("config-get", async () => {
  try {
    // 22 s timeout: in remote mode this GET is proxied to the gateway, whose
    // proxy ceiling for /api/ip-config is 20 s (PROXY_TIMEOUT_RULES). Keep the
    // IPC timeout strictly larger so a slow/loaded gateway surfaces as the
    // gateway's own response rather than an IPC abort over a slow link.
    const cfg = await requestServerJson("GET", "/api/ip-config", undefined, 22000);
    // Keep legacy file in sync for backend compatibility.
    try {
      saveIpConfigFile(cfg);
    } catch (err) {
      console.warn("[config] file sync failed:", err.message);
    }
    return sanitizeConfig(cfg);
  } catch (err) {
    console.warn("[config] DB load failed, fallback to file:", err.message);
    return loadIpConfigFile();
  }
});
ipcMain.handle("config-save", async (_, newConfig) => {
  try {
    const safe = sanitizeConfig(newConfig);
    let saved = safe;
    let dbSynced = false;
    let syncError = "";
    try {
      // 25 s (was 5 s): in remote mode the local server forwards this save to
      // the gateway and waits on the round-trip (gateway proxy ceiling 20 s)
      // before responding. The IPC timeout must out-live that proxy hop so a
      // slow/loaded gateway cannot abort here and report a false "DB sync
      // unavailable" while the gateway save actually succeeded.
      saved = sanitizeConfig(await requestServerJson("POST", "/api/ip-config", safe, 25000));
      dbSynced = true;
    } catch (err) {
      syncError = String(err?.message || err || "").trim();
      console.warn("[config] DB save failed, keeping legacy file:", syncError);
    }

    // In REMOTE mode the gateway is the only authoritative store — the local
    // file is never used for polling. A failed forward therefore means the edit
    // did NOT take effect, so it must be reported as a hard failure instead of a
    // soft "saved locally" (which would mislead the operator into believing the
    // gateway adopted the change). In gateway mode the legacy degraded path is
    // preserved: the local file IS the backend's config fallback.
    if (!dbSynced) {
      let mode = "gateway";
      try {
        mode = (await tryGetCurrentOperationMode()) || "gateway";
      } catch (_) {}
      if (mode === "remote") {
        return {
          success: false,
          error: syncError
            ? `Gateway did not accept the change: ${syncError}`
            : "Gateway did not accept the change. Verify the gateway is online.",
        };
      }
    }

    // Always mirror to legacy file for backend compatibility.
    // Hot-reload: server already pushes the snapshot to its poller and
    // broadcasts {type:"configChanged"} over WS; the Python service's
    // ipconfig_watcher (1 s tick) reconciles clients via rebuild_global_maps.
    // No backend kill needed — the synchronous taskkill in restartBackendProcess
    // was the source of dashboard freezes during save.
    saveIpConfigFile(saved);

    return {
      success: true,
      config: saved,
      ...(dbSynced ? {} : { warning: "Saved locally, DB sync unavailable." }),
    };
  } catch (err) {
    console.error("[config] save failed:", err.message);
    return { success: false, error: err.message };
  }
});
// T6.2 fix: validate that an `open-ip` IPC input is a plain IPv4 address
// (optionally with :port).  Rejects file://, javascript:, data:, and other
// schemes that loadURL would otherwise honour, plus CR/LF/path/query
// injection attempts.  Returns the sanitised "host[:port]" on success, or
// null on rejection.
function sanitizeInverterIpHost(raw) {
  if (!raw || typeof raw !== "string") return null;
  const stripped = raw.replace(/^https?:\/\//i, "").trim();
  if (!stripped) return null;
  // Reject any URL-ish characters — we expect pure IPv4 [:port].
  if (/[^0-9a-fA-F.:]/.test(stripped)) return null;
  const m = stripped.match(/^([0-9.]+)(?::(\d{1,5}))?$/);
  if (!m) return null;
  const octets = m[1].split(".");
  if (octets.length !== 4) return null;
  for (const o of octets) {
    const n = Number(o);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  }
  if (m[2] !== undefined) {
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  }
  return m[2] !== undefined ? `${m[1]}:${m[2]}` : m[1];
}

ipcMain.on("open-ip", async (event, ip) => {
  // T6.2 fix: reject non-IPv4 or scheme-injected inputs BEFORE using them
  // in loadURL / reachable checks.  Previously, arbitrary strings were
  // passed through, allowing file://, javascript:, or data: URLs to load.
  const cleanIp = sanitizeInverterIpHost(ip);
  if (!cleanIp) {
    console.warn("[main] open-ip rejected invalid input:", typeof ip === "string" ? ip.slice(0, 80) : typeof ip);
    return;
  }
  const url = `http://${cleanIp}`;
  const hostOnly = cleanIp.split(":")[0];
  const portOnly = cleanIp.includes(":") ? Number(cleanIp.split(":")[1]) : 80;
  const reachable = await checkReachable(hostOnly, portOnly, 2000);
  if (!event.sender.isDestroyed()) {
    event.sender.send("ip-status", { ip: cleanIp, ok: reachable });
  }
  if (!reachable) return;
  const parentWin = BrowserWindow.fromWebContents(event.sender);
  const invWin = new BrowserWindow({
    width: 920,
    height: 680,
    icon: APP_ICON,
    parent: parentWin || null,
    modal: false,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: true },
  });
  invWin.loadURL(url).catch((err) => {
    console.error("[main] open-ip load error:", err.message);
  });
});
ipcMain.on("open-ip-check", async (event, ip) => {
  // T6.2 fix: same sanitiser as open-ip.
  const cleanIp = sanitizeInverterIpHost(ip);
  if (!cleanIp) return;
  const hostOnly = cleanIp.split(":")[0];
  const portOnly = cleanIp.includes(":") ? Number(cleanIp.split(":")[1]) : 80;
  const ok = await checkReachable(hostOnly, portOnly, 1500);
  if (!event.sender.isDestroyed()) {
    event.sender.send("ip-status", { ip: cleanIp, ok });
  }
});

// ─── Cloud Backup OAuth Window ────────────────────────────────────────────────
// Opens a temporary BrowserWindow for OAuth, intercepts the localhost:3500
// callback URL before it loads, and returns the code to the renderer.
ipcMain.handle("oauth-start", async (_, { authUrl }) => {
  return new Promise((resolve) => {
    // T6.10 fix (Phase 3, 2026-04-14): whitelist http/https only.  Before
    // this guard any scheme passed by a compromised renderer (file:,
    // javascript:, data:, ms-word:, etc.) was loaded into a BrowserWindow
    // with devtools/node disabled but still in the same session partition
    // as the main app — a credential-harvesting foothold.  Reject early.
    try {
      const parsed = new URL(String(authUrl || ""));
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        resolve({ ok: false, error: `OAuth refused: unsupported scheme "${parsed.protocol}"` });
        return;
      }
    } catch (err) {
      resolve({ ok: false, error: `OAuth refused: invalid authUrl (${err.message})` });
      return;
    }
    const CALLBACK_ORIGIN = "http://localhost:3500/oauth/callback";

    const oauthWin = new BrowserWindow({
      width: 900,
      height: 720,
      title: "Cloud Backup — Connect Account",
      autoHideMenuBar: true,
      webPreferences: {
        // SEC-M-003: ephemeral partition (no `persist:` prefix) so OAuth
        // tokens are NOT cached on disk under %APPDATA%\Electron\…\oauth-temp.
        // The OAuth flow only needs the session for the popup's lifetime;
        // making it persistent gave a future-XSS attacker a free token-
        // disclosure surface.
        partition: "oauth-temp",
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
      },
    });

    let settled = false;
    let timeout = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        oauthWin.webContents.session.webRequest.onBeforeRequest({ urls: [] }, null);
      } catch (_) {}
      if (timeout) clearTimeout(timeout);
      if (!oauthWin.isDestroyed()) oauthWin.destroy();
      resolve(result);
    };

    timeout = setTimeout(() => {
      finish({ ok: false, error: "OAuth timed out (5 minutes)" });
    }, 5 * 60 * 1000);

    // Intercept the redirect to localhost before it hits the server.
    oauthWin.webContents.session.webRequest.onBeforeRequest(
      { urls: [`${CALLBACK_ORIGIN}/*`] },
      (details, callback) => {
        callback({ cancel: true });
        finish({ ok: true, callbackUrl: details.url });
      },
    );

    oauthWin.on("closed", () => {
      finish({ ok: false, error: "OAuth window closed by user" });
    });

    oauthWin.loadURL(String(authUrl)).catch((err) => {
      finish({ ok: false, error: err.message });
    });
  });
});

ipcMain.on("dashboard-startup-progress", (event, payload) => {
  if (!mainWin || event.sender !== mainWin.webContents) return;
  updateLoadingStartupState(payload);
});

ipcMain.on("dashboard-startup-ready", (event, payload) => {
  if (!mainWin || event.sender !== mainWin.webContents) return;
  mainRendererReady = true;
  updateLoadingStartupState({
    step: 3,
    progress: 100,
    text: String(payload?.text || "Dashboard ready."),
  });
  revealMainWindowIfReady();
});

ipcMain.on("dashboard-startup-failed", (event, message) => {
  if (!mainWin || event.sender !== mainWin.webContents) return;
  clearMainRendererReadyTimer();
  const safeMessage = String(message || "").trim() || "Dashboard startup failed.";
  console.error("[main] Renderer startup failed:", safeMessage);
  showLoadingErrorMessage(safeMessage);
});

// Remote connectivity failure — show mode picker instead of generic error
ipcMain.on("dashboard-remote-connectivity-failed", (event, message) => {
  if (!mainWin || event.sender !== mainWin.webContents) return;
  clearMainRendererReadyTimer();
  const safeMessage = String(message || "").trim() || "The remote gateway did not respond.";
  console.warn("[main] Remote connectivity failed:", safeMessage);
  startupErrorShown = true;
  if (!loadingWin || loadingWin.isDestroyed()) return;
  loadingWin.webContents
    .executeJavaScript(
      `if (typeof window.showModePicker === "function") {
         window.showModePicker(${JSON.stringify(safeMessage)});
       } else {
         window.showStartupError?.(${JSON.stringify(safeMessage)});
       }`,
    )
    .catch(() => {});
});

// Mode switch from loading screen — save settings and retry startup
ipcMain.on("switch-operation-mode", async (event, mode) => {
  if (!loadingWin || event.sender !== loadingWin.webContents) return;
  const targetMode = String(mode || "").toLowerCase() === "remote" ? "remote" : "gateway";
  console.log(`[main] User requested mode switch to: ${targetMode}`);
  try {
    const http = require("http");
    const postData = JSON.stringify({ operationMode: targetMode });
    await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: SERVER_PORT, path: "/api/settings", method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
          timeout: 3000,
        },
        (res) => {
          res.resume();
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`HTTP ${res.statusCode}`));
        },
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.end(postData);
    });
    console.log(`[main] Settings saved: operationMode=${targetMode}`);
  } catch (err) {
    console.warn("[main] Failed to save operation mode via API, attempting direct DB write:", err.message);
    try {
      writeOperationModeToLocalDb(targetMode);
    } catch (dbErr) {
      console.error("[main] Direct DB write also failed:", dbErr.message);
    }
  }
  retryServerStartup();
});

// ─── Cleanup ──────────────────────────────────────────────────────────────────
function forceKillProc(proc, label) {
  if (!proc || proc.killed) return;
  execFile("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { stdio: "ignore", windowsHide: true }, (err) => {
    if (err) console.warn(`[main] taskkill ${label} failed:`, err.message);
  });
}

function killServer(reason = "application shutdown") {
  return stopRuntimeServices(reason);
}

function quit() {
  requestAppShutdown({
    reason: "quit requested",
    action: { type: "quit" },
  }).catch((err) => {
    console.error("[main] quit shutdown failed:", err?.message || err);
    appShutdownBypassQuit = true;
    app.exit(1);
  });
}
