// electron/shutdownReason.js
//
// Synchronous shutdown-reason marker used to diagnose the nightly
// "Error 1962 — no operating system found" reports. Without this marker,
// the dashboard cannot distinguish between:
//   (a) Windows forcibly terminating the app for an OS-initiated reboot
//       (Windows Update, Automatic Maintenance, user shutdown)
//   (b) A BSOD or unexpected power loss that killed the process mid-flight
//   (c) A normal user quit via the UI
//
// The Windows cases fire `app.on("session-end")` and
// `powerMonitor.on("shutdown")` with a ~5 s budget before the OS kills us,
// so the writer MUST be synchronous. Any async fs write risks being
// truncated if Windows decides to terminate mid-callback.
//
// Files under `<PROGRAMDATA_DIR>/lifecycle/`:
//   shutdown-reason.current.json   Written on every recorded shutdown event.
//                                  Its presence on the next boot means the
//                                  prior shutdown was at least partially
//                                  observed by our handlers (graceful or
//                                  OS-initiated).
//   boot-sentinel.json             Written on every startup. Absence on a
//                                  fresh boot = first install. Presence
//                                  without `shutdown-reason.current.json` =
//                                  the prior run crashed or power-cut
//                                  before it could record a reason.
//   shutdown-reason.prev.json      Archive of the most recent recorded
//                                  shutdown reason. Read by the server so
//                                  /api/health/db-integrity can surface it.
//
// All files are small flat JSON. No dependencies beyond Node built-ins.

const fs = require("fs");
const path = require("path");

const PROGRAMDATA_ROOT = process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || "C:\\ProgramData";
const LIFECYCLE_DIR = path.join(PROGRAMDATA_ROOT, "InverterDashboard", "lifecycle");

const PATHS = {
  lifecycleDir: LIFECYCLE_DIR,
  current: path.join(LIFECYCLE_DIR, "shutdown-reason.current.json"),
  prev: path.join(LIFECYCLE_DIR, "shutdown-reason.prev.json"),
  sentinel: path.join(LIFECYCLE_DIR, "boot-sentinel.json"),
};

function _ensureDirSync() {
  try {
    fs.mkdirSync(LIFECYCLE_DIR, { recursive: true });
  } catch (_) { /* best-effort; parent dir may be readonly in tests */ }
}

function _readJsonSync(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function _writeJsonSync(p, obj) {
  try {
    _ensureDirSync();
    // Atomic-ish: write to .tmp then rename. Windows fs.renameSync replaces
    // on same volume. If rename fails (rare), fall back to direct write.
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    try {
      fs.renameSync(tmp, p);
    } catch (_) {
      try { fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8"); } catch (_) {}
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    return true;
  } catch (_) {
    return false;
  }
}

// Known reasons. Keep the vocabulary tight so the banner and audit trail
// can render them deterministically without free-text parsing.
const REASONS = Object.freeze({
  SESSION_END: "session-end",                     // Windows logoff / shutdown / reboot
  POWER_SHUTDOWN: "power-shutdown",               // ACPI shutdown signal
  POWER_SUSPEND: "power-suspend",                 // Suspend — not a quit, advisory
  BEFORE_QUIT: "before-quit",                     // User quit via UI
  INSTALL_UPDATE: "install-update",               // Auto-updater triggering restart
  RELAUNCH: "relaunch",                           // Programmatic relaunch
  LICENSE_EXPIRED: "license-expired",             // License runtime shutdown
  UNCAUGHT_EXCEPTION: "uncaught-exception",       // Main-process crash handler
  PROCESS_EXIT: "process-exit",                   // Last-resort: only caught at
                                                  // the final process 'exit'/
                                                  // app 'quit' tick. Still a
                                                  // graceful classification —
                                                  // the JS runtime DID get to
                                                  // exit (not a BSOD / power
                                                  // loss / hard kill, which
                                                  // skip 'exit' entirely).
});

// Initiator gives the banner a crisp "who caused this" hint.
const INITIATORS = Object.freeze({
  WINDOWS_OS: "windows-os",
  USER: "user",
  AUTO_UPDATER: "auto-updater",
  RUNTIME: "runtime",
  UNKNOWN: "unknown",
});

function _buildRecord(reason, initiator, extra) {
  const now = Date.now();
  const record = {
    reason: String(reason || REASONS.UNCAUGHT_EXCEPTION),
    initiator: String(initiator || INITIATORS.UNKNOWN),
    timestamp: now,
    isoTime: new Date(now).toISOString(),
    pid: process.pid,
    platform: process.platform,
    nodeVersion: process.versions?.node || "",
    electronVersion: process.versions?.electron || "",
    appVersion: String(process.env.ADSI_APP_VERSION || "") || undefined,
  };
  if (extra && typeof extra === "object") {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) continue;
      if (record[k] !== undefined) continue; // don't clobber primary fields
      record[k] = v;
    }
  }
  return record;
}

// Synchronous + idempotent. Safe to call from session-end/shutdown handlers
// whose budget is measured in seconds. If this function returns false the
// caller should still proceed with shutdown; the marker is a diagnostic aid,
// not a correctness prerequisite.
function recordShutdownReasonSync(reason, options = {}) {
  const record = _buildRecord(reason, options.initiator, options.extra);
  const ok = _writeJsonSync(PATHS.current, record);
  return ok ? record : null;
}

// Called once at app startup. Returns a classification describing the prior
// run's shutdown, then archives + rotates the marker files so the next run
// starts from a clean slate.
//
// classification values:
//   "first-boot"   No prior sentinel — brand-new install or clean state.
//   "graceful"     shutdown-reason.current was present → handlers fired.
//   "unexpected"   Sentinel was present but no shutdown-reason.current →
//                  the prior run crashed, BSOD'd, or lost power with no
//                  chance to record a reason. This is the smoking-gun
//                  signal the banner highlights in red.
// Returns true if the given OS pid is currently alive (any owner). On Windows,
// `process.kill(pid, 0)` with signal 0 is a probe that never delivers a signal
// — it just checks existence. ESRCH means "no such process"; EPERM means the
// process exists but we lack permission to signal it (still alive, treat as
// alive). Best-effort: any other failure is treated as "unknown" → not alive,
// so we don't accidentally suppress the unexpected-shutdown classifier on a
// genuine crash.
function _isPidAliveSync(pid) {
  const p = Number(pid);
  if (!Number.isFinite(p) || p <= 0 || p === process.pid) return false;
  try {
    process.kill(p, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function readLastShutdownSync() {
  _ensureDirSync();
  const sentinel = _readJsonSync(PATHS.sentinel);
  const current = _readJsonSync(PATHS.current);

  // Concurrent-instance guard: if the existing sentinel's PID is still alive,
  // another lifecycle-owning process (typically the dashboard) is still
  // running. A standalone-calibrator launch that shares this lifecycle dir
  // must NOT misclassify the dashboard as "unexpected" — its current.json
  // simply hasn't been written yet because it hasn't shut down. Bail out
  // without mutating sentinel/prev so the live process keeps ownership.
  if (sentinel && !current && _isPidAliveSync(sentinel.pid)) {
    return {
      classification: "concurrent-instance",
      priorReason: null,
      sentinelWasPresent: true,
      concurrentPid: Number(sentinel.pid) || null,
      checkedAt: Date.now(),
    };
  }

  let classification;
  let priorReason = null;
  if (current) {
    classification = "graceful";
    priorReason = current;
  } else if (sentinel) {
    classification = "unexpected";
  } else {
    classification = "first-boot";
  }

  // Archive: keep the last graceful reason under .prev for the server to
  // surface via /api/health/db-integrity. For unexpected shutdowns we
  // synthesize a minimal record so the banner has something coherent to
  // show.
  if (classification === "graceful" && current) {
    _writeJsonSync(PATHS.prev, current);
    try { fs.unlinkSync(PATHS.current); } catch (_) {}
  } else if (classification === "unexpected") {
    const synthetic = _buildRecord(
      "unexpected-shutdown",
      INITIATORS.UNKNOWN,
      {
        priorBootStartedAt: sentinel?.startedAt || null,
        priorBootPid: sentinel?.pid || null,
        note: "No shutdown handler fired before the prior process ended. " +
              "Likely causes: BSOD, forced power loss, hard process kill, " +
              "or Windows shutdown timeout (>5 s) that skipped session-end.",
      },
    );
    _writeJsonSync(PATHS.prev, synthetic);
    priorReason = synthetic;
  }

  // Write a fresh sentinel for THIS boot so the next startup can detect
  // whether our handlers fired.
  const bootStart = Date.now();
  _writeJsonSync(PATHS.sentinel, {
    startedAt: bootStart,
    isoTime: new Date(bootStart).toISOString(),
    pid: process.pid,
    platform: process.platform,
    nodeVersion: process.versions?.node || "",
    electronVersion: process.versions?.electron || "",
  });

  return {
    classification,
    priorReason,
    sentinelWasPresent: !!sentinel,
    checkedAt: bootStart,
  };
}

// Read-only accessor used by the embedded server to populate
// startupIntegrityResult.lastShutdown. Does NOT rotate the files; relies on
// readLastShutdownSync having already archived `current` → `prev`.
function readPrevShutdownSync() {
  return _readJsonSync(PATHS.prev);
}

module.exports = {
  PATHS,
  REASONS,
  INITIATORS,
  recordShutdownReasonSync,
  readLastShutdownSync,
  readPrevShutdownSync,
};
